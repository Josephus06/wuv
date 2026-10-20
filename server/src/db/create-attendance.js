// HR: shifts, shift assignments and attendance (employee time in / time out).
//
//   shifts                      -- named schedules: 08:00-17:00, 22:00-06:00 (overnight), ...
//   employee_shift_assignments  -- which shift an employee works, from when, on which weekdays
//   attendance_logs             -- one row per employee per work date: the time in / time out
//
// attendance_logs SNAPSHOTS the schedule it was measured against (scheduled_start/end,
// grace, break) instead of joining back to the shift: editing a shift's hours next month
// must not quietly rewrite who was late last month.
//
// One row per (employee, work_date) is enforced by a unique key, which is also what stops a
// double-tapped Time In from creating two records.
//
// Also registers the three HR pages and gives System Admins full access, so the module is
// reachable the moment this has run. Idempotent -- safe to re-run:
//   node src/db/create-attendance.js --dry-run
//   node src/db/create-attendance.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

async function tableExists(name) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ?`,
    [name]
  );
  return row.n > 0;
}

const TABLES = [
  // end_time <= start_time means the shift runs past midnight.
  ['shifts', `CREATE TABLE shifts (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    grace_minutes INT NOT NULL DEFAULT 0,
    break_minutes INT NOT NULL DEFAULT 60,
    description VARCHAR(255) NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    UNIQUE KEY uniq_shift_name (name)
  )`],

  // effective_to NULL = open-ended. days_of_week is "1,2,3,4,5" with 0 = Sunday.
  ['employee_shift_assignments', `CREATE TABLE employee_shift_assignments (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    employee_id BIGINT NOT NULL,
    shift_id BIGINT NOT NULL,
    effective_from DATE NOT NULL,
    effective_to DATE NULL,
    days_of_week VARCHAR(20) NOT NULL DEFAULT '1,2,3,4,5',
    notes VARCHAR(255) NULL,
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    KEY idx_esa_employee (employee_id, effective_from),
    KEY idx_esa_shift (shift_id),
    CONSTRAINT fk_esa_employee FOREIGN KEY (employee_id) REFERENCES employees(id),
    CONSTRAINT fk_esa_shift FOREIGN KEY (shift_id) REFERENCES shifts(id)
  )`],

  // time_in/time_out are UTC. original_time_in/out keep the employee's own stamps the first
  // time HR corrects a self-recorded row, so a correction never erases what was punched.
  ['attendance_logs', `CREATE TABLE attendance_logs (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    employee_id BIGINT NOT NULL,
    work_date DATE NOT NULL,
    shift_id BIGINT NULL,
    scheduled_start DATETIME NULL,
    scheduled_end DATETIME NULL,
    grace_minutes INT NOT NULL DEFAULT 0,
    break_minutes INT NOT NULL DEFAULT 0,
    time_in DATETIME NOT NULL,
    time_out DATETIME NULL,
    late_minutes INT NOT NULL DEFAULT 0,
    undertime_minutes INT NOT NULL DEFAULT 0,
    overtime_minutes INT NOT NULL DEFAULT 0,
    worked_minutes INT NOT NULL DEFAULT 0,
    source ENUM('self', 'manual') NOT NULL DEFAULT 'self',
    remarks VARCHAR(255) NULL,
    original_time_in DATETIME NULL,
    original_time_out DATETIME NULL,
    recorded_by_user_id BIGINT NULL,
    edited_by_user_id BIGINT NULL,
    edited_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_attendance_day (employee_id, work_date),
    KEY idx_attendance_date (work_date),
    KEY idx_attendance_open (employee_id, time_out),
    CONSTRAINT fk_attendance_employee FOREIGN KEY (employee_id) REFERENCES employees(id)
  )`],
];

const PAGES = [
  { route: '/shifts', name: 'Shifts' },
  { route: '/shift-assignments', name: 'Shift Assignments' },
  { route: '/attendance', name: 'Attendance' },
];

async function registerPage({ route, name }, hasModule) {
  const [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [route]);
  if (page) { console.log(`Page ${route} already registered (id ${page.id}).`); return page; }
  if (DRY_RUN) { console.log(`Would register ${route} as "${name}".`); return null; }
  const fields = ['route', 'name'];
  const values = [route, name];
  if (hasModule) { fields.push('module'); values.push('HR'); }
  const [result] = await pool.query(
    `INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
    values
  );
  console.log(`Registered ${route} as "${name}" (id ${result.insertId}).`);
  return { id: result.insertId };
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only, nothing will be written.\n' : 'APPLYING changes.\n');

  for (const [name, ddl] of TABLES) {
    if (await tableExists(name)) {
      console.log(`${name} already present -- skipped`);
    } else if (DRY_RUN) {
      console.log(`Would create ${name}.`);
    } else {
      await pool.query(ddl);
      console.log(`${name} created`);
    }
  }

  const [cols] = await pool.query('SHOW COLUMNS FROM pages');
  const hasModule = new Set(cols.map((c) => c.Field)).has('module');
  const [admins] = await pool.query(
    "SELECT id, display_name FROM users WHERE account_type = 'System Admin' AND is_active = TRUE"
  );

  for (const p of PAGES) {
    const page = await registerPage(p, hasModule);
    if (!page || DRY_RUN) continue;
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

main().catch((err) => { console.error('Attendance migration failed:', err); process.exit(1); });
