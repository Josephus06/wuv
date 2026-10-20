// Loads the shifts from the "WVI Workshift" sheet (Oct 2026), replacing every saved shift.
//
// Each WVI shift pays 8 hours: Shift In to Shift Out less the lunch break, plus 30 minutes of
// paid breaks taken just outside it (two 15-minute breaks; the closing/end shifts' single
// 30-minute one before Shift In). Lateness counts from Shift In.
//
// Corrections to the sheet, confirmed with the user 2026-10-20:
//   - ASTRA Opening ends 19:15, not 17:15 (17:15 left a 6-hour day; every shift is 8).
//   - Seaside / Gatewalk Middle starts 11:15 (the sheet cell held 0.46875, Excel's 11:15).
//   - Main Office Saturday ends 16:00 (the sheet wrote "16:00 NN").
//
// --replace deletes ALL saved shifts first, together with the shift assignments and plotted
// days that use them -- re-assign people afterwards. Time records keep their own copy of the
// schedule they were measured against, so none of them change.
//
//   node src/db/load-wvi-workshifts.js --dry-run
//   node src/db/load-wvi-workshifts.js --replace
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const REPLACE = process.argv.includes('--replace');

// [branch keyword, display branch, shift, start, end, lunch minutes, description]
const SHIFTS = [
  ['main office', 'Main Office', 'Mon-Fri', '08:15', '16:45', 60, 'Mon-Fri, rest Sunday. Paid breaks 08:00-08:15 and 16:45-17:00.'],
  ['main office', 'Main Office', 'Saturday', '08:00', '16:00', 30, 'Saturday, rest Sunday. Lunch 12:00-12:30. 30 min paid break.'],

  ['guadalupe', 'CMT Guadalupe', 'Opening', '07:15', '15:45', 60, 'Lunch 11:00-12:00. Paid breaks 07:00-07:15 and 15:45-16:00.'],
  ['guadalupe', 'CMT Guadalupe', 'Middle', '10:15', '18:45', 60, 'Lunch 14:00-15:00. Paid breaks 10:00-10:15 and 18:45-19:00.'],
  ['guadalupe', 'CMT Guadalupe', 'Closing', '11:30', '20:00', 60, 'Lunch 15:00-16:00. Paid break 11:00-11:30.'],

  ['mandaue', 'CMT Mandaue', 'Opening', '07:15', '15:45', 60, 'Lunch 11:00-12:00. Paid breaks 07:00-07:15 and 15:45-16:00.'],
  ['mandaue', 'CMT Mandaue', 'Middle', '09:15', '17:45', 60, 'Lunch 13:00-14:00. Paid breaks 09:00-09:15 and 17:45-18:00.'],
  ['mandaue', 'CMT Mandaue', 'Closing', '11:30', '20:00', 60, 'Lunch 15:00-16:00. Paid break 11:00-11:30.'],

  ['seaside', 'Seaside', 'Opening', '09:45', '18:15', 60, 'Lunch 13:30-14:30. Paid breaks 09:30-09:45 and 18:15-18:30.'],
  ['seaside', 'Seaside', 'Middle', '11:15', '19:45', 60, 'Lunch 15:00-16:00. Paid breaks 11:00-11:15 and 19:45-20:00.'],
  ['seaside', 'Seaside', 'Closing', '12:30', '21:00', 60, 'Lunch 16:00-17:00. Paid break 12:00-12:30.'],
  ['seaside', 'Seaside', 'End Shift', '13:30', '22:00', 60, 'Lunch 17:00-18:00. Paid break 13:00-13:30.'],

  ['astra', 'Astra', 'Opening', '10:45', '19:15', 60, 'Lunch 14:30-15:30. Paid breaks 10:30-10:45 and 19:15-19:30.'],
  ['astra', 'Astra', 'Closing', '12:30', '21:00', 60, 'Lunch 16:00-17:00. Paid break 12:00-12:30.'],

  ['gatewalk', 'Gatewalk', 'Opening', '09:45', '18:15', 60, 'Lunch 13:30-14:30. Paid breaks 09:30-09:45 and 18:15-18:30.'],
  ['gatewalk', 'Gatewalk', 'Middle', '11:15', '19:45', 60, 'Lunch 15:00-16:00. Paid breaks 11:00-11:15 and 19:45-20:00.'],
  ['gatewalk', 'Gatewalk', 'Closing', '12:30', '21:00', 60, 'Lunch 16:00-17:00. Paid break 12:00-12:30.'],
  ['gatewalk', 'Gatewalk', 'End Shift', '13:30', '22:00', 60, 'Lunch 17:00-18:00. Paid break 13:00-13:30.'],
];
const PAID_BREAK = 30;

const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  if (!DRY_RUN && !REPLACE) {
    console.log('Nothing done. Run with --dry-run to preview, or --replace to delete the saved shifts and load these.');
    await pool.end();
    return;
  }
  console.log(DRY_RUN ? 'DRY RUN -- reporting only, nothing will be written.\n' : 'REPLACING the saved shifts.\n');

  // Every shift must come to 8 paid hours; a typo in the table would show up here, not in pay.
  for (const [, branch, name, start, end, lunch] of SHIFTS) {
    const paid = toMin(end) - toMin(start) - lunch + PAID_BREAK;
    if (paid !== 480) throw new Error(`${branch} ${name} comes to ${paid / 60} paid hours, not 8 -- check the table.`);
  }

  const [locations] = await pool.query('SELECT id, location_name FROM locations WHERE is_active = TRUE');
  const branchIds = new Map();
  for (const keyword of new Set(SHIFTS.map((s) => s[0]))) {
    const matches = locations.filter((l) => l.location_name.toLowerCase().includes(keyword));
    branchIds.set(keyword, matches.length === 1 ? matches[0].id : null);
    const label = SHIFTS.find((s) => s[0] === keyword)[1];
    if (matches.length === 1) console.log(`Branch ${label} -> location "${matches[0].location_name}"`);
    else console.log(`Branch ${label} -> ${matches.length ? `${matches.length} locations match "${keyword}"` : 'no matching location'}: shifts left without a branch; set it in HR -> Shifts`);
  }

  const [[counts]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM shifts) AS shifts, (SELECT COUNT(*) FROM employee_shift_assignments) AS assignments,
            (SELECT COUNT(*) FROM employee_schedules) AS plotted`
  );
  console.log(`\nCurrently saved: ${counts.shifts} shift(s), ${counts.assignments} shift assignment(s), ${counts.plotted} plotted day(s).`);

  if (DRY_RUN) {
    console.log(`Would delete all of those, then add ${SHIFTS.length} shifts:`);
    for (const [kw, branch, name, start, end, lunch] of SHIFTS) {
      console.log(`  ${branch} - ${name}: ${start}-${end}, lunch ${lunch} min, paid break ${PAID_BREAK} min${branchIds.get(kw) ? '' : ' (no branch)'}`);
    }
    await pool.end();
    return;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM employee_schedules');
    await conn.query('DELETE FROM employee_shift_assignments');
    await conn.query('DELETE FROM shifts');
    for (const [kw, branch, name, start, end, lunch, description] of SHIFTS) {
      await conn.query('INSERT INTO shifts SET ?', [{
        name: `${branch} - ${name}`, start_time: start, end_time: end, grace_minutes: 0,
        break_minutes: lunch, paid_break_minutes: PAID_BREAK, description, branch_id: branchIds.get(kw), is_active: true,
      }]);
    }
    await conn.commit();
    console.log(`Deleted ${counts.shifts} shift(s), ${counts.assignments} assignment(s), ${counts.plotted} plotted day(s). Added ${SHIFTS.length} shifts.`);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  await pool.end();
}

main().catch((err) => { console.error('Loading the workshifts failed:', err.message); process.exit(1); });
