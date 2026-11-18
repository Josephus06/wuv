// Wu Ventures keeps ONE set of books for its companies (Fresh n Tidy, Cuts For Tots), each with
// its own branches: every transaction names the branch it belongs to (office_location_id), the
// branch names its company (locations.company_id), and the reports filter or split by either.
//
// Two money documents had nowhere to say which branch they belong to, so their GL lines could
// never be counted toward a company: Bank Deposits and Fund Transfers. This gives both an
// office_location_id. Nullable, so existing rows are untouched and keep showing as "No branch"
// until someone edits them.
//
// Idempotent:
//   node src/db/add-company-branch-tagging.js --dry-run
//   node src/db/add-company-branch-tagging.js
require('dotenv').config();
const pool = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');

async function hasColumn(table, column) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column]);
  return row.n > 0;
}

async function addBranch(table) {
  if (await hasColumn(table, 'office_location_id')) { console.log(`${table}.office_location_id -- already present, skipped`); return; }
  if (DRY_RUN) { console.log(`Would add ${table}.office_location_id`); return; }
  await pool.query(
    `ALTER TABLE ${table} ADD COLUMN office_location_id BIGINT NULL,
       ADD INDEX idx_${table}_office_location (office_location_id),
       ADD CONSTRAINT fk_${table}_office_location FOREIGN KEY (office_location_id) REFERENCES locations(id)`
  );
  console.log(`${table}.office_location_id -- added`);
}

(async () => {
  try {
    console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${DRY_RUN ? ' -- DRY RUN' : ''}`);
    await addBranch('bank_deposits');
    await addBranch('fund_transfers');

    // What still has to be set up by hand, so the reports can split by company.
    const [[c]] = await pool.query('SELECT COUNT(*) AS n FROM companies WHERE is_active = TRUE');
    const [[l]] = await pool.query('SELECT COUNT(*) AS n FROM locations WHERE is_active = TRUE AND company_id IS NULL');
    console.log(`\n${c.n} active compan${c.n === 1 ? 'y' : 'ies'}; ${l.n} active branch(es) not yet assigned to a company`
      + (l.n ? ' -- set Company on each under Lookups > Locations.' : '.'));
    await pool.end();
  } catch (err) {
    console.error(err);
    await pool.end();
    process.exit(1);
  }
})();
