// The branch time clock's API. No login: the caller proves two things instead --
//   1. it is a registered device: the secret link token HR opened on it (kiosk_devices), and
//   2. who is stamping: that employee's private 6-digit PIN, or their QR badge held up to the
//      device's camera.
// Everything is refused without a live device token, so the PIN pad cannot be reached from
// an arbitrary browser, and wrong PINs are throttled per device (lib/kiosk.js).
//
// Never answers 401: the web client treats 401 as "your session ended" and sends the page
// to /login, which a kiosk has no use for.
const express = require('express');
const pool = require('../db');
const { BUSINESS_TZ, HttpError, toLocalDisplay, toDbUtc, fromDbUtc } = require('../lib/attendance');
const { clockStatus, stampIn, stampOut } = require('../lib/timeClock');
const {
  PIN_RE, pinHash, tokenHash, lockedFor, recordFailure, clearFailures, parseQr,
} = require('../lib/kiosk');

const router = express.Router();

async function deviceFor(token) {
  const [[device]] = await pool.query(
    `SELECT d.id, d.name, d.branch_id, d.is_active, l.location_name AS branch_name
     FROM kiosk_devices d LEFT JOIN locations l ON l.id = d.branch_id
     WHERE d.token_hash = ?`,
    [tokenHash(token)]
  );
  if (!device || !device.is_active) throw new HttpError(404, 'This time clock is not active. Ask HR for a new time clock link.');
  return device;
}

// The employee behind a PIN, after the throttle; throws a message the kiosk can show.
// Throttled per DEVICE, not per network address: a branch's tablets usually share one
// internet connection, and one tablet's typos must not lock the one beside it. A device
// link is needed to get here at all, so the device is the thing to slow down.
async function employeeForPin(req, device) {
  const keys = [`device:${device.id}`];
  const wait = Math.max(...keys.map((k) => lockedFor(k)));
  if (wait > 0) throw new HttpError(429, `Too many wrong PINs. Try again in ${Math.ceil(wait / 1000)} seconds.`);

  const pin = String(req.body?.pin || '');
  if (!PIN_RE.test(pin)) throw new HttpError(400, 'Enter your 6-digit PIN.');
  const [[emp]] = await pool.query(
    `SELECT e.id, e.employee_code, e.first_name, e.last_name, e.is_active, c.name AS company_name
     FROM employees e LEFT JOIN companies c ON c.id = e.company_id WHERE e.kiosk_pin_hash = ?`,
    [pinHash(pin)]
  );
  if (!emp || !emp.is_active) {
    keys.forEach((k) => recordFailure(k));
    throw new HttpError(404, 'PIN not recognised. Check it and try again, or ask HR.');
  }
  keys.forEach((k) => clearFailures(k));
  return emp;
}

const EMPLOYEE_SELECT = `SELECT e.id, e.employee_code, e.first_name, e.last_name, e.is_active, c.name AS company_name
  FROM employees e LEFT JOIN companies c ON c.id = e.company_id`;

// The employee behind a scanned QR badge. Not throttled like PINs: a badge's signature cannot
// be guessed, and a wrong QR held up by mistake must not lock the device for everyone.
async function employeeForQr(req) {
  const badge = parseQr(req.body?.qr);
  let emp = null;
  if (badge) {
    [[emp]] = await pool.query(
      `${EMPLOYEE_SELECT} WHERE e.id = ? AND e.kiosk_qr_version = ? AND e.kiosk_qr_set_at IS NOT NULL`,
      [badge.employeeId, badge.version]
    );
  }
  if (!emp || !emp.is_active) {
    throw new HttpError(404, badge
      ? 'This QR badge is no longer valid. Ask HR for your current badge.'
      : 'Not a time clock QR badge. Hold up your employee badge.');
  }
  return emp;
}

const who = (emp) => ({ first_name: emp.first_name, name: `${emp.first_name} ${emp.last_name}`, employee_code: emp.employee_code, company_name: emp.company_name });

router.get('/:token', async (req, res, next) => {
  try {
    const device = await deviceFor(req.params.token);
    res.json({ name: device.name, branch_name: device.branch_name, timezone: BUSINESS_TZ, now_local: toLocalDisplay(toDbUtc(new Date())) });
  } catch (err) { next(err); }
});

// PIN -> who it is and whether the next press is Time In or Time Out.
router.post('/:token/lookup', async (req, res, next) => {
  try {
    const device = await deviceFor(req.params.token);
    const emp = await employeeForPin(req, device);
    const status = await clockStatus(emp.id);
    const done = !status.open_log && status.today.log?.time_out;
    res.json({ employee: who(emp), action: status.open_log ? 'out' : done ? 'done' : 'in', ...status });
  } catch (err) { next(err); }
});

// The PIN is sent again with the press (nothing is held between the two requests), and
// the action must match the employee's state -- a stale screen cannot time someone in twice.
router.post('/:token/punch', async (req, res, next) => {
  try {
    const device = await deviceFor(req.params.token);
    const emp = await employeeForPin(req, device);
    const action = req.body?.action;
    if (!['in', 'out'].includes(action)) throw new HttpError(400, 'Choose Time In or Time Out');
    const log = action === 'in'
      ? await stampIn(emp.id, { source: 'kiosk', deviceId: device.id })
      : await stampOut(emp.id, { deviceId: device.id });
    await pool.query('UPDATE kiosk_devices SET last_used_at = NOW() WHERE id = ?', [device.id]);
    res.status(action === 'in' ? 201 : 200).json({ employee: who(emp), action, log });
  } catch (err) { next(err); }
});

// QR: one scan is the whole stamp -- the badge says who, and the employee's state says Time In
// or Time Out. A badge scanned again within a few minutes of its Time In (held up twice, or
// left in front of the camera) is not taken as a Time Out.
const RESCAN_GUARD_MS = 3 * 60 * 1000;

router.post('/:token/scan', async (req, res, next) => {
  try {
    const device = await deviceFor(req.params.token);
    const emp = await employeeForQr(req);
    const status = await clockStatus(emp.id);
    if (!status.open_log && status.today.log?.time_out) {
      return res.json({ employee: who(emp), action: 'done', log: status.today.log, ...status });
    }
    if (status.open_log && Date.now() - fromDbUtc(status.open_log.time_in).getTime() < RESCAN_GUARD_MS) {
      return res.json({ employee: who(emp), action: 'recent', log: status.open_log, ...status });
    }
    const action = status.open_log ? 'out' : 'in';
    const log = action === 'in'
      ? await stampIn(emp.id, { source: 'kiosk', deviceId: device.id })
      : await stampOut(emp.id, { deviceId: device.id });
    await pool.query('UPDATE kiosk_devices SET last_used_at = NOW() WHERE id = ?', [device.id]);
    return res.status(action === 'in' ? 201 : 200).json({ employee: who(emp), action, log });
  } catch (err) { return next(err); }
});

module.exports = router;
