// QR badges for the branch time clock: an employee scans their badge at the kiosk's camera
// instead of typing a PIN.
//
//   employees.kiosk_qr_version   Which badge is current. The code on a badge is worked out from
//                                the employee id, this number and the server secret
//                                (lib/kiosk.js), so nothing secret is stored and a badge can be
//                                printed again. A new badge adds 1, retiring the old one.
//   employees.kiosk_qr_set_at    When the current badge was made; NULL = no badge (removed).
//
// Idempotent:
//   node src/db/add-kiosk-qr.js --dry-run
//   node src/db/add-kiosk-qr.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

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

  await step('employees.kiosk_qr_version', await columnExists('employees', 'kiosk_qr_version'), () => pool.query(
    'ALTER TABLE employees ADD COLUMN kiosk_qr_version INT NOT NULL DEFAULT 0'
  ));
  await step('employees.kiosk_qr_set_at', await columnExists('employees', 'kiosk_qr_set_at'), () => pool.query(
    'ALTER TABLE employees ADD COLUMN kiosk_qr_set_at DATETIME NULL'
  ));

  await pool.end();
  console.log('Done.');
}

main().catch((err) => { console.error('Kiosk QR migration failed:', err.message); process.exit(1); });
