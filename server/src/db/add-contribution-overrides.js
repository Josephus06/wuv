// Contribution amounts set by hand, instead of the ones computed from the rate tables.
//
//   employees.sss_ee_monthly / philhealth_ee_monthly / pagibig_ee_monthly
//       A fixed MONTHLY employee share for the employee, used by every payroll while set (e.g.
//       a higher voluntary Pag-IBIG). NULL = compute it. It is split over the cutoffs the same
//       way the computed one is (Payroll Settings → Deducted in). The employer share is still
//       computed.
//   payroll_contribution_overrides
//       One cutoff's employee share for one employee in one draft run, typed on the payslip to
//       correct that cutoff only. Kept across recomputes; it goes with the run.
//
// Idempotent:
//   node src/db/add-contribution-overrides.js --dry-run
//   node src/db/add-contribution-overrides.js
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

async function tableExists(name) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ?`,
    [name]
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

  for (const col of ['sss_ee_monthly', 'philhealth_ee_monthly', 'pagibig_ee_monthly']) {
    await step(`employees.${col}`, await columnExists('employees', col), () => pool.query(
      `ALTER TABLE employees ADD COLUMN ${col} DECIMAL(12,2) NULL`
    ));
  }

  await step('payroll_contribution_overrides', await tableExists('payroll_contribution_overrides'), () => pool.query(
    `CREATE TABLE payroll_contribution_overrides (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      run_id BIGINT NOT NULL,
      employee_id BIGINT NOT NULL,
      code ENUM('SSS', 'PHILHEALTH', 'PAGIBIG') NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      created_by_user_id BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_run_employee_code (run_id, employee_id, code),
      CONSTRAINT fk_pco_run FOREIGN KEY (run_id) REFERENCES payroll_runs(id) ON DELETE CASCADE,
      CONSTRAINT fk_pco_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
    )`
  ));

  await pool.end();
  console.log('Done.');
}

main().catch((err) => { console.error('Contribution overrides migration failed:', err.message); process.exit(1); });
