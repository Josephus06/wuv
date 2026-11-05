// Face check at the branch time clock (db/add-kiosk-face.js).
//
// The kiosk's browser finds the face in the camera and turns it into a 128-number descriptor
// (face-api); the server compares it with the descriptors HR registered for the employee the
// badge or PIN names. The comparison is here, not in the browser, so a kiosk page cannot just
// claim "matched".
//
// A mismatch is refused, up to MAX_ATTEMPTS within a few minutes; the last try is let through
// with the record flagged face_unverified and its photo kept, so nobody is stuck at the door
// and HR sees every doubtful stamp. An employee with no registered face yet stamps as before
// (the photo is still kept).
const crypto = require('crypto');
const pool = require('../db');
const { toDbUtc } = require('./attendance');

// Euclidean distance between descriptors: the same person is usually under 0.45, different
// people over 0.6. 0.5 leans towards refusing look-alikes; FACE_MATCH_DISTANCE overrides.
const MATCH_DISTANCE = Number(process.env.FACE_MATCH_DISTANCE) || 0.5;
const MAX_ATTEMPTS = 3;
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const PHOTO_DAYS = 60;
const MAX_PHOTO_BYTES = 200 * 1024;
const MAX_SAMPLES = 5;
const CODE_MINUTES = 15;

function readDescriptor(value) {
  if (!Array.isArray(value) || value.length !== 128) return null;
  return value.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 10) ? value : null;
}

// A JPEG from the kiosk as a data URL -> Buffer, or null.
function readPhoto(value) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(value || ''));
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  return buf.length && buf.length <= MAX_PHOTO_BYTES ? buf : null;
}

const toDataUrl = (buf) => (buf ? `data:image/jpeg;base64,${Buffer.from(buf).toString('base64')}` : null);

function distance(a, b) {
  let sum = 0;
  for (let i = 0; i < 128; i += 1) { const d = a[i] - b[i]; sum += d * d; }
  return Math.sqrt(sum);
}

async function registeredDescriptors(employeeId) {
  const [rows] = await pool.query('SELECT descriptor FROM employee_faces WHERE employee_id = ?', [employeeId]);
  return rows.map((r) => (typeof r.descriptor === 'string' ? JSON.parse(r.descriptor) : r.descriptor)).filter(readDescriptor);
}

const attempts = new Map(); // `${deviceId}:${employeeId}` -> { count, first }

// The check before a kiosk stamp. `face`: { descriptor, photo } from the kiosk (either may be
// missing: no face found, camera off). Returns
//   { retry: true, attemptsLeft, message }      refuse this try
//   { verified: true | false | null, distance, photo }   go ahead and stamp
// verified null = the employee has no registered face; false = let through after the tries.
async function checkFace({ deviceId, employeeId, face }) {
  const photo = readPhoto(face?.photo);
  const descriptor = readDescriptor(face?.descriptor);
  const registered = await registeredDescriptors(employeeId);
  if (!registered.length) return { verified: null, distance: null, photo };

  const key = `${deviceId}:${employeeId}`;
  const dist = descriptor ? Math.min(...registered.map((r) => distance(r, descriptor))) : null;
  if (dist !== null && dist <= MATCH_DISTANCE) {
    attempts.delete(key);
    return { verified: true, distance: dist, photo };
  }

  const now = Date.now();
  let a = attempts.get(key);
  if (!a || now - a.first > ATTEMPT_WINDOW_MS) a = { count: 0, first: now };
  a.count += 1;
  attempts.set(key, a);
  if (a.count < MAX_ATTEMPTS) {
    return {
      retry: true,
      attemptsLeft: MAX_ATTEMPTS - a.count,
      message: descriptor
        ? 'Face does not match. Look straight at the camera and try again.'
        : 'No face seen. Look straight at the camera and try again.',
    };
  }
  attempts.delete(key);
  return { verified: false, distance: dist, photo };
}

// After the stamp: keep its photo, and flag the record when the face was not verified.
// Photos older than PHOTO_DAYS are cleared here too, a few at a time.
async function recordStampFace({ log, employeeId, action, deviceId, check }) {
  if (check.verified === false) await pool.query('UPDATE attendance_logs SET face_unverified = TRUE WHERE id = ?', [log.id]);
  if (check.photo) {
    await pool.query('INSERT INTO attendance_stamp_photos SET ?', [{
      log_id: log.id,
      employee_id: employeeId,
      action,
      photo: check.photo,
      face_distance: check.distance === null || check.distance === undefined ? null : Math.round(check.distance * 1000) / 1000,
      verified: check.verified,
      device_id: deviceId || null,
      taken_at: toDbUtc(new Date()),
    }]);
  }
  await pool.query('DELETE FROM attendance_stamp_photos WHERE taken_at < ? LIMIT 200',
    [toDbUtc(new Date(Date.now() - PHOTO_DAYS * 86400000))]);
}

// Registration: replaces the employee's samples with new ones. `samples`: [{ descriptor, photo }].
async function registerFace({ employeeId, samples, userId = null, deviceId = null }) {
  const good = (Array.isArray(samples) ? samples : [])
    .map((s) => ({ descriptor: readDescriptor(s?.descriptor), photo: readPhoto(s?.photo) }))
    .filter((s) => s.descriptor)
    .slice(0, MAX_SAMPLES);
  if (good.length < 2) return { error: 'Take at least 2 clear photos of the face.' };
  // Samples of one face should agree with each other; a mix of two people is refused.
  for (let i = 0; i < good.length; i += 1) {
    for (let j = i + 1; j < good.length; j += 1) {
      if (distance(good[i].descriptor, good[j].descriptor) > MATCH_DISTANCE + 0.1) {
        return { error: 'The photos do not look like the same person. Take them again, one person in front of the camera.' };
      }
    }
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM employee_faces WHERE employee_id = ?', [employeeId]);
    for (const s of good) {
      await conn.query('INSERT INTO employee_faces SET ?', [{
        employee_id: employeeId,
        descriptor: JSON.stringify(s.descriptor),
        photo: s.photo,
        consent_at: toDbUtc(new Date()),
        registered_by_user_id: userId,
        registered_device_id: deviceId,
      }]);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return { samples: good.length };
}

async function faceStatus(employeeId) {
  const [rows] = await pool.query(
    `SELECT f.id, f.photo, f.consent_at, f.created_at, u.display_name AS registered_by
     FROM employee_faces f LEFT JOIN users u ON u.id = f.registered_by_user_id
     WHERE f.employee_id = ? ORDER BY f.id`,
    [employeeId]
  );
  return {
    registered: rows.length > 0,
    samples: rows.length,
    registered_at: rows[0]?.created_at || null,
    registered_by: rows[0]?.registered_by || null,
    photos: rows.map((r) => toDataUrl(r.photo)).filter(Boolean),
  };
}

// Codes for registering at the time clock: 6 digits, valid CODE_MINUTES, used once.
const codeHash = (code) => crypto.createHash('sha256').update(`face-code:${code}`).digest('hex');

async function newFaceCode(employeeId, userId) {
  await pool.query('DELETE FROM face_codes WHERE employee_id = ? OR expires_at < ?', [employeeId, toDbUtc(new Date())]);
  for (let i = 0; i < 20; i += 1) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    try {
      await pool.query('INSERT INTO face_codes SET ?', [{
        employee_id: employeeId,
        code_hash: codeHash(code),
        expires_at: toDbUtc(new Date(Date.now() + CODE_MINUTES * 60000)),
        created_by_user_id: userId,
      }]);
      return { code, minutes: CODE_MINUTES };
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
    }
  }
  throw new Error('Could not make a code -- try again');
}

// The employee a code is for (and the HR user who made it), or null. Does not use it up.
async function faceCodeOwner(code) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  const [[row]] = await pool.query(
    'SELECT id, employee_id, created_by_user_id FROM face_codes WHERE code_hash = ? AND expires_at >= ?',
    [codeHash(code), toDbUtc(new Date())]
  );
  return row || null;
}

module.exports = {
  MATCH_DISTANCE, checkFace, recordStampFace, registerFace, faceStatus, newFaceCode, faceCodeOwner, toDataUrl, distance,
};
