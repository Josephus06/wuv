// Lunch stamps and stricter lateness, set per shift (e.g. Wu Ventures' 8-5 / Saturday 8-4).
//
//   shifts.lunch_start / lunch_end      A lunch the employee stamps out and back in for: four
//                                       stamps a day (In, Lunch Out, Lunch In, Out). Back after
//                                       lunch_end is late, with no grace. NULL = no lunch stamps.
//   shifts.late_block_minutes           Lateness counted in blocks: 30 = 1 to 30 minutes late
//                                       is 30, 31 to 60 is 60. Late is then counted from the end
//                                       of the grace period (8:20 on a 15-minute grace is 5
//                                       minutes late -> 30). NULL = the actual minutes.
//   shifts.halfday_late_minutes         Late this much or more (morning or after lunch) is half
//                                       a day absent instead. NULL = never.
//   shifts.undertime_grace_minutes      Leaving this close to the end is not undertime (4:45 on
//                                       a 5:00 end with 15); earlier counts from that point.
//   attendance_logs                     The same, copied onto each record (the schedule
//                                       snapshot), plus lunch_out / lunch_in and halfday_absent.
//   payroll_run_employees.days_absent   DECIMAL, for half days.
//
// Idempotent:
//   node src/db/add-shift-lunch.js --dry-run
//   node src/db/add-shift-lunch.js
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

const COLUMNS = [
  ['shifts', 'lunch_start', 'TIME NULL'],
  ['shifts', 'lunch_end', 'TIME NULL'],
  ['shifts', 'late_block_minutes', 'INT NULL'],
  ['shifts', 'halfday_late_minutes', 'INT NULL'],
  ['shifts', 'undertime_grace_minutes', 'INT NOT NULL DEFAULT 0'],
  ['attendance_logs', 'scheduled_lunch_start', 'DATETIME NULL'],
  ['attendance_logs', 'scheduled_lunch_end', 'DATETIME NULL'],
  ['attendance_logs', 'late_block_minutes', 'INT NULL'],
  ['attendance_logs', 'halfday_late_minutes', 'INT NULL'],
  ['attendance_logs', 'undertime_grace_minutes', 'INT NOT NULL DEFAULT 0'],
  ['attendance_logs', 'lunch_out', 'DATETIME NULL'],
  ['attendance_logs', 'lunch_in', 'DATETIME NULL'],
  ['attendance_logs', 'halfday_absent', 'BOOLEAN NOT NULL DEFAULT FALSE'],
];

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only, nothing will be written.\n' : 'APPLYING changes.\n');

  for (const [table, col, ddl] of COLUMNS) {
    await step(`${table}.${col}`, await columnExists(table, col), () => pool.query(
      `ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`
    ));
  }

  // A half day absent makes absences fractional on the payroll.
  const [[absent]] = await pool.query(
    `SELECT DATA_TYPE AS t FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'payroll_run_employees' AND column_name = 'days_absent'`
  );
  await step('payroll_run_employees.days_absent holds half days', !absent || absent.t === 'decimal', () => pool.query(
    'ALTER TABLE payroll_run_employees MODIFY days_absent DECIMAL(6,2) NOT NULL DEFAULT 0'
  ));

  await pool.end();
  console.log('Done.');
}

main().catch((err) => { console.error('Shift lunch migration failed:', err.message); process.exit(1); });
