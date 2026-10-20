// Payroll: semi-monthly runs per company, computed from attendance, with government
// contributions, withholding tax, allowances, loans and one-off adjustments.
//
//   payroll_rule_sets      -- contribution / tax / premium rates, each effective from a date
//   holidays               -- the holiday calendar (regular / special), all companies or one
//   employee_pay_items     -- recurring allowances and deductions, per employee, dated
//   employee_loans         -- SSS / Pag-IBIG / company loans repaid by a fixed amount per payroll
//   payroll_runs           -- one per company per cutoff (enforced: nobody is paid twice)
//   payroll_run_employees  -- one per employee in a run: the payslip's totals
//   payroll_run_lines      -- the payslip's lines (basic, overtime, SSS, loan ...)
//   payroll_adjustments    -- one-off additions/deductions HR adds to a draft run
//
// A run stores the rule set it was computed with (payroll_runs.rules), and the payslip lines
// are stored rather than recomputed on view, so an approved payroll keeps saying what was
// paid no matter what changes afterwards. A loan's balance is its amount less the loan lines
// of APPROVED runs -- a draft that is recomputed or deleted never touches it.
//
// Pay rates are not here: they are the dated entries in employee_compensation
// (add-employee-profile.js), which this module reads.
//
// Also registers the payroll pages and gives System Admins full access. Idempotent:
//   node src/db/create-payroll.js --dry-run
//   node src/db/create-payroll.js
const pool = require('../db');
require('dotenv').config();
const { DEFAULT_RULES } = require('../lib/payrollRules');

const DRY_RUN = process.argv.includes('--dry-run');

async function tableExists(name) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ?`,
    [name]
  );
  return row.n > 0;
}

const MONEY = 'DECIMAL(14,2)';

const TABLES = [
  ['payroll_rule_sets', `CREATE TABLE payroll_rule_sets (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    effective_from DATE NOT NULL,
    rules MEDIUMTEXT NOT NULL,
    notes VARCHAR(255) NULL,
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    UNIQUE KEY uniq_rule_set_date (effective_from)
  )`],

  // company_id NULL = a holiday for every company.
  ['holidays', `CREATE TABLE holidays (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    holiday_date DATE NOT NULL,
    name VARCHAR(150) NOT NULL,
    holiday_type ENUM('regular', 'special') NOT NULL,
    company_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    KEY idx_holidays_date (holiday_date),
    CONSTRAINT fk_holidays_company FOREIGN KEY (company_id) REFERENCES companies(id)
  )`],

  // `amount` is per payroll (per cutoff). is_taxable only matters for allowances.
  ['employee_pay_items', `CREATE TABLE employee_pay_items (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    employee_id BIGINT NOT NULL,
    item_type ENUM('allowance', 'deduction') NOT NULL,
    name VARCHAR(100) NOT NULL,
    amount ${MONEY} NOT NULL,
    is_taxable BOOLEAN NOT NULL DEFAULT FALSE,
    effective_from DATE NOT NULL,
    effective_to DATE NULL,
    remarks VARCHAR(255) NULL,
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    KEY idx_pay_items_employee (employee_id),
    CONSTRAINT fk_pay_items_employee FOREIGN KEY (employee_id) REFERENCES employees(id)
  )`],

  // loan_amount is the total to be repaid; amortization is taken each payroll until it is.
  ['employee_loans', `CREATE TABLE employee_loans (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    employee_id BIGINT NOT NULL,
    loan_type VARCHAR(60) NOT NULL,
    reference_no VARCHAR(60) NULL,
    loan_amount ${MONEY} NOT NULL,
    amortization ${MONEY} NOT NULL,
    start_date DATE NOT NULL,
    status ENUM('active', 'paused', 'cancelled') NOT NULL DEFAULT 'active',
    remarks VARCHAR(255) NULL,
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    KEY idx_loans_employee (employee_id),
    CONSTRAINT fk_loans_employee FOREIGN KEY (employee_id) REFERENCES employees(id)
  )`],

  ['payroll_runs', `CREATE TABLE payroll_runs (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    company_id BIGINT NOT NULL,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    cutoff TINYINT NOT NULL,
    pay_date DATE NOT NULL,
    status ENUM('draft', 'approved') NOT NULL DEFAULT 'draft',
    rules MEDIUMTEXT NULL,
    rule_set_id BIGINT NULL,
    warnings TEXT NULL,
    employee_count INT NOT NULL DEFAULT 0,
    total_gross ${MONEY} NOT NULL DEFAULT 0,
    total_deductions ${MONEY} NOT NULL DEFAULT 0,
    total_net ${MONEY} NOT NULL DEFAULT 0,
    total_employer ${MONEY} NOT NULL DEFAULT 0,
    notes VARCHAR(255) NULL,
    computed_at DATETIME NULL,
    created_by_user_id BIGINT NULL,
    approved_by_user_id BIGINT NULL,
    approved_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    UNIQUE KEY uniq_payroll_cutoff (company_id, period_start),
    CONSTRAINT fk_payroll_runs_company FOREIGN KEY (company_id) REFERENCES companies(id)
  )`],

  ['payroll_run_employees', `CREATE TABLE payroll_run_employees (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    run_id BIGINT NOT NULL,
    employee_id BIGINT NOT NULL,
    pay_type VARCHAR(10) NOT NULL,
    base_rate DECIMAL(14,4) NOT NULL,
    daily_rate DECIMAL(14,4) NOT NULL,
    hourly_rate DECIMAL(14,4) NOT NULL,
    days_scheduled INT NOT NULL DEFAULT 0,
    days_worked DECIMAL(6,2) NOT NULL DEFAULT 0,
    days_absent INT NOT NULL DEFAULT 0,
    late_minutes INT NOT NULL DEFAULT 0,
    undertime_minutes INT NOT NULL DEFAULT 0,
    overtime_minutes INT NOT NULL DEFAULT 0,
    night_minutes INT NOT NULL DEFAULT 0,
    gross_pay ${MONEY} NOT NULL DEFAULT 0,
    taxable_income ${MONEY} NOT NULL DEFAULT 0,
    sss_ee ${MONEY} NOT NULL DEFAULT 0,
    philhealth_ee ${MONEY} NOT NULL DEFAULT 0,
    pagibig_ee ${MONEY} NOT NULL DEFAULT 0,
    withholding_tax ${MONEY} NOT NULL DEFAULT 0,
    total_deductions ${MONEY} NOT NULL DEFAULT 0,
    net_pay ${MONEY} NOT NULL DEFAULT 0,
    employer_cost ${MONEY} NOT NULL DEFAULT 0,
    warnings TEXT NULL,
    UNIQUE KEY uniq_run_employee (run_id, employee_id),
    CONSTRAINT fk_pre_run FOREIGN KEY (run_id) REFERENCES payroll_runs(id) ON DELETE CASCADE,
    CONSTRAINT fk_pre_employee FOREIGN KEY (employee_id) REFERENCES employees(id)
  )`],

  // line_type: earning (added to gross; absences/late are negative earnings), deduction
  // (taken from gross to reach net), employer (the company's own share -- not on net pay).
  ['payroll_run_lines', `CREATE TABLE payroll_run_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    run_id BIGINT NOT NULL,
    run_employee_id BIGINT NOT NULL,
    line_type ENUM('earning', 'deduction', 'employer') NOT NULL,
    code VARCHAR(30) NOT NULL,
    label VARCHAR(150) NOT NULL,
    quantity DECIMAL(10,2) NULL,
    unit VARCHAR(10) NULL,
    rate DECIMAL(14,4) NULL,
    amount ${MONEY} NOT NULL,
    is_taxable BOOLEAN NOT NULL DEFAULT TRUE,
    loan_id BIGINT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    KEY idx_lines_employee (run_employee_id, sort_order),
    KEY idx_lines_loan (loan_id),
    CONSTRAINT fk_lines_run FOREIGN KEY (run_id) REFERENCES payroll_runs(id) ON DELETE CASCADE,
    CONSTRAINT fk_lines_run_employee FOREIGN KEY (run_employee_id) REFERENCES payroll_run_employees(id) ON DELETE CASCADE
  )`],

  ['payroll_adjustments', `CREATE TABLE payroll_adjustments (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    run_id BIGINT NOT NULL,
    employee_id BIGINT NOT NULL,
    adj_type ENUM('earning', 'deduction') NOT NULL,
    label VARCHAR(150) NOT NULL,
    amount ${MONEY} NOT NULL,
    is_taxable BOOLEAN NOT NULL DEFAULT TRUE,
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_adjustments_run (run_id, employee_id),
    CONSTRAINT fk_adjustments_run FOREIGN KEY (run_id) REFERENCES payroll_runs(id) ON DELETE CASCADE
  )`],
];

const PAGES = [
  { route: '/payroll', name: 'Payroll' },
  { route: '/payroll-settings', name: 'Payroll Settings' },
  { route: '/payroll-holidays', name: 'Holidays' },
  { route: '/payroll-pay-items', name: 'Allowances & Deductions' },
  { route: '/payroll-loans', name: 'Loans' },
];

// The first rule set: the 2026 rates, effective from the start of 2026.
const FIRST_RULE_SET_DATE = '2026-01-01';

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only, nothing will be written.\n' : 'APPLYING changes.\n');

  for (const [name, script] of [['companies', 'create-companies.js'], ['employee_compensation', 'add-employee-profile.js'], ['attendance_logs', 'create-attendance.js']]) {
    if (!(await tableExists(name))) throw new Error(`${name} is missing -- run ${script} first.`);
  }

  for (const [name, ddl] of TABLES) {
    if (await tableExists(name)) console.log(`${name} already present -- skipped`);
    else if (DRY_RUN) console.log(`Would create ${name}.`);
    else { await pool.query(ddl); console.log(`${name} created`); }
  }

  const hasRuleSets = !DRY_RUN || (await tableExists('payroll_rule_sets'));
  const [[ruleCount]] = hasRuleSets
    ? await pool.query('SELECT COUNT(*) AS n FROM payroll_rule_sets')
    : [[{ n: 0 }]];
  if (ruleCount.n > 0) console.log('payroll rule sets already present -- default not seeded');
  else if (DRY_RUN) console.log(`Would seed the 2026 rates, effective ${FIRST_RULE_SET_DATE}.`);
  else {
    await pool.query(
      'INSERT INTO payroll_rule_sets (effective_from, rules, notes) VALUES (?, ?, ?)',
      [FIRST_RULE_SET_DATE, JSON.stringify(DEFAULT_RULES), '2026 SSS, PhilHealth, Pag-IBIG and TRAIN withholding rates']
    );
    console.log(`Seeded the 2026 rates, effective ${FIRST_RULE_SET_DATE}.`);
  }

  const [cols] = await pool.query('SHOW COLUMNS FROM pages');
  const hasModule = new Set(cols.map((c) => c.Field)).has('module');
  const [admins] = await pool.query(
    "SELECT id FROM users WHERE account_type = 'System Admin' AND is_active = TRUE"
  );
  for (const p of PAGES) {
    let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [p.route]);
    if (page) { console.log(`Page ${p.route} already registered (id ${page.id}).`); }
    else if (DRY_RUN) { console.log(`Would register ${p.route} as "${p.name}".`); continue; }
    else {
      const fields = ['route', 'name'];
      const values = [p.route, p.name];
      if (hasModule) { fields.push('module'); values.push('HR'); }
      const [result] = await pool.query(
        `INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`, values
      );
      page = { id: result.insertId };
      console.log(`Registered ${p.route} as "${p.name}" (id ${page.id}).`);
    }
    if (DRY_RUN) continue;
    for (const user of admins) {
      await pool.query(
        `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve)
         VALUES (?, ?, TRUE, TRUE, TRUE, TRUE, TRUE)
         ON DUPLICATE KEY UPDATE can_view=TRUE, can_add=TRUE, can_edit=TRUE, can_delete=TRUE, can_approve=TRUE`,
        [user.id, page.id]
      );
    }
    console.log(`  + full access on ${p.route} for ${admins.length} admin(s).`);
  }

  await pool.end();
  console.log('Done.');
}

main().catch((err) => { console.error('Payroll migration failed:', err.message); process.exit(1); });
