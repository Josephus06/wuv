// Plotted schedules, paid breaks and branch shifts -- what the WVI Workshift sheet needs.
//
//   shifts.paid_break_minutes   Every WVI shift pays 8 hours for 7.5 hours of work: two
//                               15-minute paid breaks sit just outside Shift In / Shift Out
//                               (Main Office 08:00-08:15 and 16:45-17:00). They are credited
//                               as worked time; lateness still counts from Shift In.
//   shifts.branch_id            Which branch a shift belongs to (Seaside Opening, Astra
//                               Closing ...), so the Schedule page offers each branch its own.
//   employee_schedules          A supervisor's plotted schedule: one row per employee per day,
//                               naming the shift, or NULL for a rest day. A plotted day wins
//                               over the employee's Shift Assignment; a day not plotted falls
//                               back to it. Fixed staff (Main Office) need no plotting at all.
//   attendance_logs.paid_break_minutes / shift_name
//                               Snapshotted with the rest of the schedule, so a record keeps
//                               saying what it was measured against even after its shift is
//                               edited or deleted.
//
// Idempotent:
//   node src/db/add-schedules.js --dry-run
//   node src/db/add-schedules.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

async function tableExists(name) {
  const [[row]] = await pool.query(
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [name]
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
  if (!(await tableExists('shifts'))) throw new Error('shifts is missing -- run create-attendance.js first.');

  await step('shifts.paid_break_minutes', await columnExists('shifts', 'paid_break_minutes'), () => pool.query(
    'ALTER TABLE shifts ADD COLUMN paid_break_minutes INT NOT NULL DEFAULT 0 AFTER break_minutes'
  ));
  await step('shifts.branch_id', await columnExists('shifts', 'branch_id'), () => pool.query(
    `ALTER TABLE shifts ADD COLUMN branch_id BIGINT NULL AFTER description,
     ADD CONSTRAINT fk_shifts_branch FOREIGN KEY (branch_id) REFERENCES locations(id)`
  ));
  await step('attendance_logs.paid_break_minutes', await columnExists('attendance_logs', 'paid_break_minutes'), () => pool.query(
    'ALTER TABLE attendance_logs ADD COLUMN paid_break_minutes INT NOT NULL DEFAULT 0 AFTER break_minutes'
  ));
  const hadShiftName = await columnExists('attendance_logs', 'shift_name');
  await step('attendance_logs.shift_name (filled from existing shifts)', hadShiftName, async () => {
    await pool.query('ALTER TABLE attendance_logs ADD COLUMN shift_name VARCHAR(100) NULL AFTER shift_id');
    await pool.query('UPDATE attendance_logs l JOIN shifts s ON s.id = l.shift_id SET l.shift_name = s.name');
  });
  await step('employee_schedules', await tableExists('employee_schedules'), () => pool.query(`CREATE TABLE employee_schedules (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    employee_id BIGINT NOT NULL,
    work_date DATE NOT NULL,
    shift_id BIGINT NULL,
    updated_by_user_id BIGINT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_schedule_day (employee_id, work_date),
    KEY idx_schedule_date (work_date),
    CONSTRAINT fk_schedule_employee FOREIGN KEY (employee_id) REFERENCES employees(id),
    CONSTRAINT fk_schedule_shift FOREIGN KEY (shift_id) REFERENCES shifts(id)
  )`));

  // The Schedule page, with full access for System Admins.
  let [[page]] = await pool.query("SELECT id FROM pages WHERE route = '/schedule'");
  if (page) console.log(`Page /schedule already registered (id ${page.id}).`);
  else if (DRY_RUN) console.log('Would register /schedule as "Schedule".');
  else {
    const [cols] = await pool.query('SHOW COLUMNS FROM pages');
    const hasModule = new Set(cols.map((c) => c.Field)).has('module');
    const [res] = await pool.query(
      `INSERT INTO pages (route, name${hasModule ? ', module' : ''}) VALUES ('/schedule', 'Schedule'${hasModule ? ", 'HR'" : ''})`
    );
    page = { id: res.insertId };
    console.log(`Registered /schedule as "Schedule" (id ${page.id}).`);
  }
  if (page && !DRY_RUN) {
    const [admins] = await pool.query("SELECT id FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");
    for (const u of admins) {
      await pool.query(
        `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve)
         VALUES (?, ?, TRUE, TRUE, TRUE, TRUE, TRUE)
         ON DUPLICATE KEY UPDATE can_view=TRUE, can_add=TRUE, can_edit=TRUE, can_delete=TRUE, can_approve=TRUE`,
        [u.id, page.id]
      );
    }
    console.log(`  + full access on /schedule for ${admins.length} admin(s).`);
  }

  await pool.end();
  console.log('Done.');
}

main().catch((err) => { console.error('Schedules migration failed:', err.message); process.exit(1); });
