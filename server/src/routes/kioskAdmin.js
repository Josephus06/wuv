// HR's side of the branch time clock: registering devices (each gets a secret link) and
// giving employees their PINs. A link or a PIN is shown ONCE, when made -- only hashes are
// kept -- so losing one means making a new one, which also retires the old.
const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const {
  newPin, pinHash, newDeviceToken, tokenHash, qrCode,
} = require('../lib/kiosk');

const router = express.Router();
const ROUTE = '/kiosk-devices';

const pinTaken = async (hash) => {
  const [[row]] = await pool.query('SELECT id FROM employees WHERE kiosk_pin_hash = ?', [hash]);
  return !!row;
};

router.get('/devices', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT d.id, d.name, d.branch_id, d.is_active, d.last_used_at, d.created_at, l.location_name AS branch_name,
              u.display_name AS created_by,
              (SELECT COUNT(*) FROM attendance_logs a WHERE a.in_device_id = d.id OR a.out_device_id = d.id) AS stamp_count
       FROM kiosk_devices d
       LEFT JOIN locations l ON l.id = d.branch_id
       LEFT JOIN users u ON u.id = d.created_by_user_id
       ORDER BY d.is_active DESC, l.location_name, d.name`
    );
    res.json(rows.map((r) => ({ ...r, is_active: !!r.is_active })));
  } catch (err) { next(err); }
});

function readDevice(body) {
  const name = String(body.name || '').trim();
  if (!name) return { error: 'Name the device, e.g. "Seaside tablet"' };
  return { values: { name: name.slice(0, 100), branch_id: body.branch_id ? Number(body.branch_id) : null } };
}

// Returns the token once -- the client turns it into the link to open on the device.
router.post('/devices', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const { values, error } = readDevice(req.body);
    if (error) return res.status(400).json({ error });
    const token = newDeviceToken();
    const [result] = await pool.query('INSERT INTO kiosk_devices SET ?', [{ ...values, token_hash: tokenHash(token), created_by_user_id: req.user.id }]);
    res.status(201).json({ id: result.insertId, token });
  } catch (err) { next(err); }
});

router.put('/devices/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { values, error } = readDevice(req.body);
    if (error) return res.status(400).json({ error });
    await pool.query('UPDATE kiosk_devices SET ?, is_active = ?, updated_at = NOW() WHERE id = ?',
      [values, req.body.is_active === false ? 0 : 1, req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// A new link for the device; the old one stops working immediately.
router.post('/devices/:id/new-link', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const token = newDeviceToken();
    const [result] = await pool.query('UPDATE kiosk_devices SET token_hash = ?, is_active = TRUE, updated_at = NOW() WHERE id = ?', [tokenHash(token), req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.json({ id: Number(req.params.id), token });
  } catch (err) { next(err); }
});

router.delete('/devices/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    const [[used]] = await pool.query('SELECT COUNT(*) AS n FROM attendance_logs WHERE in_device_id = ? OR out_device_id = ?', [req.params.id, req.params.id]);
    if (used.n) return res.status(409).json({ error: `${used.n} time record(s) came from this device. Turn it off instead, so they keep saying where they came from.` });
    await pool.query('DELETE FROM kiosk_devices WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (err) { next(err); }
});

// --- PINs (part of the employee record: Edit on Employees) ----------------------------

router.post('/pins/:employeeId', requireAuth, requirePermission('/employees', 'can_edit'), async (req, res, next) => {
  try {
    const [[emp]] = await pool.query('SELECT id FROM employees WHERE id = ?', [req.params.employeeId]);
    if (!emp) return res.status(404).json({ error: 'Not found' });
    const pin = await newPin(pinTaken);
    await pool.query('UPDATE employees SET kiosk_pin_hash = ?, kiosk_pin_set_at = NOW() WHERE id = ?', [pinHash(pin), emp.id]);
    res.json({ pin });
  } catch (err) { next(err); }
});

router.delete('/pins/:employeeId', requireAuth, requirePermission('/employees', 'can_edit'), async (req, res, next) => {
  try {
    await pool.query('UPDATE employees SET kiosk_pin_hash = NULL, kiosk_pin_set_at = NULL WHERE id = ?', [req.params.employeeId]);
    res.status(204).send();
  } catch (err) { next(err); }
});

// Rollout: a PIN for every active employee (optionally one company) who has none yet, as a
// list to print and hand out. Employees who already have one are left alone.
router.post('/pins', requireAuth, requirePermission('/employees', 'can_edit'), async (req, res, next) => {
  try {
    const where = ['e.is_active = TRUE', 'e.kiosk_pin_hash IS NULL'];
    const params = [];
    if (req.body.company_id) { where.push('e.company_id = ?'); params.push(req.body.company_id); }
    const [emps] = await pool.query(
      `SELECT e.id, e.employee_code, CONCAT(e.first_name, ' ', e.last_name) AS name, c.name AS company_name, l.location_name AS branch_name
       FROM employees e LEFT JOIN companies c ON c.id = e.company_id LEFT JOIN locations l ON l.id = e.branch_id
       WHERE ${where.join(' AND ')} ORDER BY c.name, l.location_name, e.last_name, e.first_name`,
      params
    );
    const out = [];
    for (const e of emps) {
      const pin = await newPin(pinTaken);
      await pool.query('UPDATE employees SET kiosk_pin_hash = ?, kiosk_pin_set_at = NOW() WHERE id = ?', [pinHash(pin), e.id]);
      out.push({ ...e, pin });
    }
    res.json({ generated: out });
  } catch (err) { next(err); }
});

// --- QR badges (part of the employee record: Edit on Employees) ------------------------
// Unlike a PIN, a badge's code can be shown again (it is worked out, not stored), so badges
// can be reprinted. "New badge" retires the old one, e.g. a lost badge.

const BADGE_SELECT = `SELECT e.id, e.employee_code, e.first_name, e.last_name, e.position_title, e.kiosk_qr_version,
         c.name AS company_name, c.code AS company_code, l.location_name AS branch_name
  FROM employees e LEFT JOIN companies c ON c.id = e.company_id LEFT JOIN locations l ON l.id = e.branch_id`;
const badge = (e) => ({
  id: e.id, employee_code: e.employee_code, name: `${e.first_name} ${e.last_name}`, position_title: e.position_title,
  company_name: e.company_name, company_code: e.company_code, branch_name: e.branch_name,
  code: qrCode(e.id, e.kiosk_qr_version),
});

router.post('/qr/:employeeId', requireAuth, requirePermission('/employees', 'can_edit'), async (req, res, next) => {
  try {
    const [result] = await pool.query(
      'UPDATE employees SET kiosk_qr_version = kiosk_qr_version + 1, kiosk_qr_set_at = NOW() WHERE id = ?', [req.params.employeeId]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Not found' });
    const [[e]] = await pool.query(`${BADGE_SELECT} WHERE e.id = ?`, [req.params.employeeId]);
    res.json(badge(e));
  } catch (err) { next(err); }
});

router.delete('/qr/:employeeId', requireAuth, requirePermission('/employees', 'can_edit'), async (req, res, next) => {
  try {
    await pool.query('UPDATE employees SET kiosk_qr_set_at = NULL WHERE id = ?', [req.params.employeeId]);
    res.status(204).send();
  } catch (err) { next(err); }
});

// Badges to print: one employee (?employee_id=), or every active employee of a company /
// branch. `issue=1` first gives a badge to those without one, so a first rollout is one click.
router.get('/qr-badges', requireAuth, requirePermission('/employees', 'can_edit'), async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    if (req.query.employee_id) { where.push('e.id = ?'); params.push(req.query.employee_id); } else {
      where.push('e.is_active = TRUE');
      if (req.query.company_id) { where.push('e.company_id = ?'); params.push(req.query.company_id); }
      if (req.query.branch_id) { where.push('e.branch_id = ?'); params.push(req.query.branch_id); }
    }
    if (req.query.issue === '1') {
      await pool.query(
        `UPDATE employees e SET e.kiosk_qr_version = e.kiosk_qr_version + 1, e.kiosk_qr_set_at = NOW()
         WHERE ${[...where, 'e.kiosk_qr_set_at IS NULL'].join(' AND ')}`,
        params
      );
    }
    const [rows] = await pool.query(
      `${BADGE_SELECT} WHERE ${[...where, 'e.kiosk_qr_set_at IS NOT NULL'].join(' AND ')}
       ORDER BY c.name, l.location_name, e.last_name, e.first_name`,
      params
    );
    res.json(rows.map(badge));
  } catch (err) { next(err); }
});

module.exports = router;
