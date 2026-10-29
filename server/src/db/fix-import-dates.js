// Undoes an attendance import whose dates were read wrong -- a sheet typed "Oct-12" that Excel
// stored as October 2012, imported before the importer knew to read it as the 12th -- so the
// sheet can be imported again.
//
// Deletes every time record imported from the file, and the schedule days that import plotted
// on dates outside the sheet's real period (years back, or the 1st of the month). Days inside
// the period are plotted again by the re-import. A record that was there before the import
// and kept is left, and re-measured against what its day's schedule is now.
//
//   node src/db/fix-import-dates.js --file "F&T Attendance Oct 12-26, 2026.xlsx" --from 2026-10-12 --to 2026-10-26 --dry-run
//   node src/db/fix-import-dates.js --file "F&T Attendance Oct 12-26, 2026.xlsx" --from 2026-10-12 --to 2026-10-26
const pool = require('../db');
require('dotenv').config();
const { remeasureDay } = require('../lib/attendance');

const DRY_RUN = process.argv.includes('--dry-run');
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : null;
};

async function main() {
  const file = arg('file');
  const from = arg('from');
  const to = arg('to');
  if (!file || !/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
    console.error('Usage: node src/db/fix-import-dates.js --file "<file name>" --from YYYY-MM-DD --to YYYY-MM-DD [--dry-run]');
    process.exit(1);
  }
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only, nothing will be written.\n' : 'APPLYING changes.\n');

  const [logs] = await pool.query(
    `SELECT l.id, l.employee_id, DATE_FORMAT(l.work_date, '%Y-%m-%d') AS d, CONCAT(e.first_name, ' ', e.last_name) AS name
     FROM attendance_logs l JOIN employees e ON e.id = l.employee_id
     WHERE l.source = 'import' AND l.remarks = ? ORDER BY name, l.work_date`,
    [`Imported from ${file}`.slice(0, 255)]
  );
  if (!logs.length) {
    console.log(`No records imported from "${file}". Check the file name (exactly as it was uploaded).`);
    await pool.end();
    return;
  }
  const employees = [...new Set(logs.map((l) => l.employee_id))];
  const byName = {};
  for (const l of logs) (byName[l.name] = byName[l.name] || []).push(l.d);
  console.log(`${logs.length} time record(s) imported from "${file}":`);
  for (const [name, dates] of Object.entries(byName)) console.log(`  ${name}: ${dates.length} -- ${dates[0]} .. ${dates[dates.length - 1]}`);

  // Wrong dates: the import's records outside the period, and any plotted day for these
  // employees in an earlier year (nothing was plotted years back before this import).
  const badDates = [...new Set(logs.map((l) => l.d).filter((d) => d < from || d > to))];
  const yearStart = `${from.slice(0, 4)}-01-01`;
  const [plots] = await pool.query(
    `SELECT employee_id, DATE_FORMAT(work_date, '%Y-%m-%d') AS d FROM employee_schedules
     WHERE employee_id IN (?) AND (work_date < ? ${badDates.length ? 'OR work_date IN (?)' : ''})`,
    badDates.length ? [employees, yearStart, badDates] : [employees, yearStart]
  );
  console.log(`\n${plots.length} plotted schedule day(s) on wrong dates for these employees.`);

  if (!DRY_RUN) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('DELETE FROM attendance_logs WHERE id IN (?)', [logs.map((l) => l.id)]);
      for (const p of plots) {
        await conn.query('DELETE FROM employee_schedules WHERE employee_id = ? AND work_date = ?', [p.employee_id, p.d]);
      }
      // Records kept from before the import, on a day whose plot was just removed.
      for (const p of plots) {
        const [[kept]] = await conn.query('SELECT id FROM attendance_logs WHERE employee_id = ? AND work_date = ?', [p.employee_id, p.d]);
        if (kept) await remeasureDay(p.employee_id, p.d, conn);
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    console.log(`\nDeleted ${logs.length} record(s) and ${plots.length} plotted day(s).`);
    console.log('Now import the sheet again: HR -> Attendance -> Import.');
  }
  await pool.end();
  console.log('Done.');
}

main().catch((err) => { console.error('Fix failed:', err.message); process.exit(1); });
