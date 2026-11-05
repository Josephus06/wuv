// Face check at the branch time clock: the employee's face is matched against the face HR
// registered for them, on every kiosk stamp (QR badge or PIN).
//
//   employee_faces               The registered face: a few samples per employee, each a
//                                128-number face descriptor (computed in the browser by
//                                face-api) and a small photo for HR to see who was registered.
//                                consent_at: HR confirmed the employee's signed consent (Data
//                                Privacy Act -- a face is sensitive personal information).
//   face_codes                   A short-lived code HR makes in the employee profile, typed at
//                                the time clock to register that employee's face there.
//   attendance_stamp_photos      A small photo of every kiosk stamp, with how close the face
//                                was to the registered one. Deleted after 60 days
//                                (lib/kioskFace.js).
//   attendance_logs.face_unverified
//                                A stamp was let through after 3 failed face checks; HR
//                                reviews it from the photo.
//
// Idempotent:
//   node src/db/add-kiosk-face.js --dry-run
//   node src/db/add-kiosk-face.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

async function tableExists(name) {
  const [[row]] = await pool.query(
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [name]
  );
  return row.n > 0;
}

async function columnExists(table, column) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return row.n > 0;
}

async function step(label, done, apply) {
  if (done) { console.log(`${label} -- already present, skipped`); return; }
  if (DRY_RUN) { console.log(`Would apply: ${label}`); return; }
  await apply();
  console.log(`${label} -- done`);
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only, nothing will be written.\n' : 'APPLYING changes.\n');

  await step('employee_faces', await tableExists('employee_faces'), () => pool.query(`CREATE TABLE employee_faces (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    employee_id BIGINT NOT NULL,
    descriptor JSON NOT NULL,
    photo MEDIUMBLOB NULL,
    consent_at DATETIME NOT NULL,
    registered_by_user_id BIGINT NULL,
    registered_device_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_face_employee (employee_id)
  )`));

  await step('face_codes', await tableExists('face_codes'), () => pool.query(`CREATE TABLE face_codes (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    employee_id BIGINT NOT NULL,
    code_hash CHAR(64) NOT NULL,
    expires_at DATETIME NOT NULL,
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_face_code (code_hash)
  )`));

  await step('attendance_stamp_photos', await tableExists('attendance_stamp_photos'), () => pool.query(`CREATE TABLE attendance_stamp_photos (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    log_id BIGINT NOT NULL,
    employee_id BIGINT NOT NULL,
    action VARCHAR(10) NOT NULL,
    photo MEDIUMBLOB NOT NULL,
    face_distance DECIMAL(5,3) NULL,
    verified BOOLEAN NULL,
    device_id BIGINT NULL,
    taken_at DATETIME NOT NULL,
    KEY idx_stamp_photo_log (log_id),
    KEY idx_stamp_photo_taken (taken_at)
  )`));

  await step('attendance_logs.face_unverified', await columnExists('attendance_logs', 'face_unverified'), () => pool.query(
    'ALTER TABLE attendance_logs ADD COLUMN face_unverified BOOLEAN NOT NULL DEFAULT FALSE'
  ));

  await pool.end();
  console.log('Done.');
}

main().catch((err) => { console.error('Kiosk face migration failed:', err.message); process.exit(1); });
