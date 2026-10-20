// Companies under the group, and which company each branch and employee belongs to.
//
// Wu Venture runs more than one business (Cuts for Tots, Fresh and Tidy), each with its own
// branches. Branches already exist as `locations`, so rather than a second branch list a
// location gains a company_id -- a branch belongs to exactly one company. An employee gets
// both a company and a branch: the company is what they are employed by, the branch is
// where they work, and the API refuses a branch that belongs to a different company.
//
// Everything is nullable, so existing locations and employees are untouched until someone
// assigns them; the two companies are seeded so there is something to assign to.
//
// Idempotent -- safe to re-run:
//   node src/db/create-companies.js --dry-run
//   node src/db/create-companies.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

const COMPANIES = [
  { code: 'CFT', name: 'Cuts for Tots' },
  { code: 'FAT', name: 'Fresh and Tidy' },
];

async function tableExists(name) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ?`,
    [name]
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

  const hasCompanies = await tableExists('companies');
  await step('create companies', hasCompanies, () => pool.query(`CREATE TABLE companies (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    code VARCHAR(20) NOT NULL,
    name VARCHAR(150) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    UNIQUE KEY uniq_company_code (code),
    UNIQUE KEY uniq_company_name (name)
  )`));

  await step('locations.company_id', await columnExists('locations', 'company_id'), () => pool.query(
    `ALTER TABLE locations ADD COLUMN company_id BIGINT NULL AFTER location_type,
     ADD CONSTRAINT fk_locations_company FOREIGN KEY (company_id) REFERENCES companies(id)`
  ));

  await step('employees.company_id', await columnExists('employees', 'company_id'), () => pool.query(
    `ALTER TABLE employees ADD COLUMN company_id BIGINT NULL AFTER department_id,
     ADD CONSTRAINT fk_employees_company FOREIGN KEY (company_id) REFERENCES companies(id)`
  ));

  await step('employees.branch_id', await columnExists('employees', 'branch_id'), () => pool.query(
    `ALTER TABLE employees ADD COLUMN branch_id BIGINT NULL AFTER company_id,
     ADD CONSTRAINT fk_employees_branch FOREIGN KEY (branch_id) REFERENCES locations(id)`
  ));

  for (const c of COMPANIES) {
    const [[existing]] = hasCompanies || !DRY_RUN
      ? await pool.query('SELECT id FROM companies WHERE code = ? OR name = ?', [c.code, c.name])
      : [[null]];
    await step(`company ${c.name}`, !!existing, () => pool.query('INSERT INTO companies (code, name) VALUES (?, ?)', [c.code, c.name]));
  }

  await pool.end();
  console.log('Done.');
}

main().catch((err) => { console.error('Companies migration failed:', err); process.exit(1); });
