// Employee profile: the fields of the old payroll system's Employee Form -- Personal Info,
// Employment Info, Other Info -- on the employee master (Master Lists > Employees). Ported from
// the GSUITE_CLONE v1 build of the same form, with the same column names, so the two systems'
// employee records line up field for field.
//
// Two of that build's columns are left out: rest_day_group and shift_group. Here working days
// and shifts are dated rows in employee_shift_assignments (create-attendance.js), and a free-text
// group next to them would be a second answer to "when does this person work" that nothing reads.
//
// PAY RATE / PAY TYPE are NOT columns here. They are rows in employee_compensation, effective-dated:
// a raise adds a row and never edits one, so what an old payslip says it paid stays true.
//
// Additive only; every column nullable. No AFTER clause: appending is instant, positioning rebuilds.
//   node src/db/add-employee-profile.js
require('dotenv').config();
const pool = require('../db');

const COLUMNS = [
  // Personal Info
  ['new_employee_no', 'VARCHAR(30) NULL'],
  ['bank_account_no', 'VARCHAR(40) NULL'],
  ['nickname', 'VARCHAR(60) NULL'],
  ['middle_initial', 'VARCHAR(10) NULL'],
  ['address', 'VARCHAR(255) NULL'],
  ['birth_date', 'DATE NULL'],
  ['birth_place', 'VARCHAR(150) NULL'],
  ['sex', 'VARCHAR(10) NULL'],
  ['no_lunch_policy', 'TINYINT(1) NULL'],
  ['nationality', 'VARCHAR(60) NULL'],
  ['religion', 'VARCHAR(60) NULL'],
  ['civil_status', 'VARCHAR(20) NULL'],
  ['height', 'VARCHAR(20) NULL'],
  ['weight', 'VARCHAR(20) NULL'],
  ['blood_type', 'VARCHAR(5) NULL'],
  ['educational_attainment', 'VARCHAR(60) NULL'],
  ['course', 'VARCHAR(255) NULL'],
  // Government numbers: formatted strings, never arithmetic, leading zeros kept.
  ['sss_no', 'VARCHAR(20) NULL'],
  ['tin', 'VARCHAR(20) NULL'],
  ['hdmf_no', 'VARCHAR(20) NULL'],
  ['philhealth_no', 'VARCHAR(20) NULL'],
  ['photo_data', 'MEDIUMTEXT NULL'],
  // Employment Info
  ['employment_status', 'VARCHAR(30) NULL'],
  ['position_code', 'VARCHAR(30) NULL'],
  ['biometric_user_id', 'VARCHAR(40) NULL'], // "Machine No"
  ['months_probation', 'INT NULL'],
  ['date_probationary', 'DATE NULL'],
  ['months_regular', 'INT NULL'],
  ['date_regularized', 'DATE NULL'],
  ['date_separated', 'DATE NULL'],
  ['prof_license_no', 'VARCHAR(60) NULL'],
  ['license_expiry', 'DATE NULL'],
  ['supervisor_employee_id', 'BIGINT NULL'],
  ['labor_type', 'VARCHAR(30) NULL'],
  ['compute_ot_pay', 'TINYINT(1) NULL'],
  ['compute_absences', 'TINYINT(1) NULL'],
  ['is_confidential', 'TINYINT(1) NULL'],
  ['uniform_size', 'VARCHAR(10) NULL'],
  ['shoe_size', 'VARCHAR(10) NULL'],
  ['tax_status', 'VARCHAR(20) NULL'],
  ['employment_type', 'VARCHAR(30) NULL'],
  ['doc_ok_probationary', 'TINYINT(1) NULL'],
  ['doc_ok_regular', 'TINYINT(1) NULL'],
  ['months_before_eoc', 'INT NULL'],
  ['eoc_date', 'DATE NULL'],
  ['is_special', 'TINYINT(1) NULL'],
  // Other Info
  ['emergency_contact_name', 'VARCHAR(150) NULL'],
  ['emergency_contact_address', 'VARCHAR(255) NULL'],
  ['emergency_contact_phone', 'VARCHAR(50) NULL'],
  ['emergency_contact_relationship', 'VARCHAR(60) NULL'],
  ['spouse_name', 'VARCHAR(150) NULL'],
  ['spouse_occupation', 'VARCHAR(100) NULL'],
  ['bank_group', 'VARCHAR(60) NULL'],
  ['compensation_group', 'VARCHAR(60) NULL'],
  ['classification', 'VARCHAR(60) NULL'],
  ['employee_level', 'VARCHAR(60) NULL'],
  ['tams_id', 'VARCHAR(40) NULL'],
  ['pay_threshold', 'DECIMAL(14,2) NULL'],
  ['updated_by_user_id', 'BIGINT NULL'],
];

// Same definition as the GSUITE_CLONE v1 build, so a later payroll module can use it as-is.
const COMPENSATION_DDL = `
  CREATE TABLE employee_compensation (
    id BIGINT NOT NULL AUTO_INCREMENT,
    employee_id BIGINT NOT NULL,
    effective_date DATE NOT NULL,
    pay_type VARCHAR(10) NOT NULL,
    base_rate DECIMAL(14,4) NOT NULL,
    working_day_divisor DECIMAL(6,2) NULL,
    is_minimum_wage BOOLEAN NOT NULL DEFAULT FALSE,
    sss_covered BOOLEAN NOT NULL DEFAULT TRUE,
    philhealth_covered BOOLEAN NOT NULL DEFAULT TRUE,
    hdmf_covered BOOLEAN NOT NULL DEFAULT TRUE,
    remarks VARCHAR(255) NULL,
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_emp_comp_effective (employee_id, effective_date),
    KEY idx_emp_comp_lookup (employee_id, effective_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

async function addColumn(name, ddl) {
  const sql = `ALTER TABLE employees ADD COLUMN ${name} ${ddl}`;
  try {
    await pool.query(`${sql}, ALGORITHM=INSTANT`);
  } catch (err) {
    if (err.code !== 'ER_PARSE_ERROR' && err.errno !== 1845 && err.errno !== 1846) throw err;
    await pool.query(sql);
  }
}

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  const [have] = await pool.query(
    "SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees'");
  const existing = new Set(have.map((r) => r.c));
  let added = 0;
  for (const [name, ddl] of COLUMNS) {
    if (existing.has(name)) continue;
    await addColumn(name, ddl);
    added += 1;
  }
  console.log(`employees: ${added} column(s) added, ${COLUMNS.length - added} already there.`);
  const [[t]] = await pool.query(
    "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_compensation'");
  if (Number(t.n)) console.log('employee_compensation already there.');
  else { await pool.query(COMPENSATION_DDL); console.log('employee_compensation created.'); }
  await pool.end();
})().catch(async (e) => { console.error('Failed:', e.message); await pool.end(); process.exit(1); });
