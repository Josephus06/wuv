// Approved overtime, and imported time records.
//
//   attendance_logs.approved_ot_minutes
//       Overtime a supervisor approved for the day. NULL = none decided, and payroll pays the
//       overtime measured from the shift end as before. When set -- by an import of the
//       branches' manual attendance sheet, or by HR on the Attendance page -- payroll pays
//       exactly this instead: it covers approved early starts (08:00-10:30 before a 10:45
//       shift) and leaves out staying late nobody approved.
//   attendance_logs.source gains 'import'
//       Records brought in from a spreadsheet (HR -> Attendance -> Import), told apart from
//       ones HR typed in one by one.
//
// Idempotent:
//   node src/db/add-attendance-import.js --dry-run
//   node src/db/add-attendance-import.js
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

  await step('attendance_logs.approved_ot_minutes', await columnExists('attendance_logs', 'approved_ot_minutes'), () => pool.query(
    'ALTER TABLE attendance_logs ADD COLUMN approved_ot_minutes INT NULL AFTER overtime_minutes'
  ));

  const [[src]] = await pool.query(
    `SELECT COLUMN_TYPE AS t FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'attendance_logs' AND column_name = 'source'`
  );
  await step("attendance_logs.source gains 'import'", String(src.t).includes("'import'"), () => pool.query(
    // 'kiosk' is listed too, so this works whether or not add-kiosk.js ran first.
    "ALTER TABLE attendance_logs MODIFY source ENUM('self', 'manual', 'kiosk', 'import') NOT NULL DEFAULT 'self'"
  ));

  await pool.end();
  console.log('Done.');
}

main().catch((err) => { console.error('Attendance import migration failed:', err.message); process.exit(1); });
