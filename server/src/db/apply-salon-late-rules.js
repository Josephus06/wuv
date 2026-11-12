// One-off: puts the salons' attendance rules on every shift of Cuts for Tots and Fresh and
// Tidy (a shift belongs to a company through its branch). Wu Ventures' shifts are left alone.
//
//   Late       no grace; 1-30 minutes late = 30 minutes, 31-60 = 1 hour,
//              more than 1 hour = half day absent.
//   Undertime  in whole hours: 1-60 minutes early = 1 hour, 61-120 = 2 hours, ...
//
// Records already stamped keep the rules they were measured with; re-measure them from the
// Attendance page (Re-measure) for the dates that should follow the new rules.
//
// Needs add-shift-lunch.js and add-undertime-blocks.js first. Lists every shift it changes:
//   node src/db/apply-salon-late-rules.js --dry-run
//   node src/db/apply-salon-late-rules.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const COMPANIES = ['CFT', 'FAT'];
const RULES = { grace_minutes: 0, late_block_minutes: 30, halfday_late_minutes: 61, undertime_block_minutes: 60 };

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only, nothing will be written.\n' : 'APPLYING changes.\n');

  const [shifts] = await pool.query(
    `SELECT s.id, s.name, s.grace_minutes, s.late_block_minutes, s.halfday_late_minutes, s.undertime_block_minutes,
            l.location_name AS branch_name, c.code AS company_code
     FROM shifts s
     JOIN locations l ON l.id = s.branch_id
     JOIN companies c ON c.id = l.company_id
     WHERE c.code IN (?)
     ORDER BY c.code, l.location_name, s.name`,
    [COMPANIES]
  );
  let changed = 0;
  for (const s of shifts) {
    const same = Object.entries(RULES).every(([k, v]) => s[k] === v);
    console.log(`${same ? '  ok     ' : DRY_RUN ? '  would  ' : '  set    '} ${s.company_code} · ${s.branch_name} · ${s.name}`
      + (same ? '' : `  (grace ${s.grace_minutes} -> 0, late blocks ${s.late_block_minutes ?? '-'} -> 30, half day ${s.halfday_late_minutes ?? '-'} -> 61, undertime blocks ${s.undertime_block_minutes ?? '-'} -> 60)`));
    if (same) continue;
    changed += 1;
    if (!DRY_RUN) await pool.query('UPDATE shifts SET ?, updated_at = NOW() WHERE id = ?', [RULES, s.id]);
  }
  console.log(`\n${shifts.length} shift(s) of ${COMPANIES.join(' / ')}; ${changed} ${DRY_RUN ? 'would change' : 'changed'}.`);
  const [[unbranched]] = await pool.query('SELECT COUNT(*) AS n FROM shifts WHERE branch_id IS NULL AND is_active = TRUE');
  if (unbranched.n) console.log(`${unbranched.n} active shift(s) have no branch and were not touched -- set their rules on the Shifts page if they are salon shifts.`);

  await pool.end();
  console.log('Done.');
}

main().catch((err) => { console.error('Applying the salon rules failed:', err.message); process.exit(1); });
