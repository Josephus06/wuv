// The branch time clock: a page with no login, open on a registered branch device, where an
// employee types a private PIN and presses Time In / Time Out.
//
//   kiosk_devices                 One row per registered device ("Seaside tablet"). The device
//                                 holds a secret link; only its SHA-256 is stored, so a leaked
//                                 database cannot be used to stamp. Deactivating a row turns
//                                 that device's link off at once.
//   employees.kiosk_pin_hash      The employee's 6-digit PIN as an HMAC (lib/kiosk.js) -- never
//                                 the PIN itself. HR sees a PIN once, when it is generated.
//                                 Unique, because the PIN alone identifies the employee.
//   attendance_logs.in_device_id / out_device_id
//                                 Which device a stamp came from. source gains 'kiosk'.
//
// Idempotent:
//   node src/db/add-kiosk.js --dry-run
//   node src/db/add-kiosk.js
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
  if (!(await tableExists('attendance_logs'))) throw new Error('attendance_logs is missing -- run create-attendance.js first.');

  await step('kiosk_devices', await tableExists('kiosk_devices'), () => pool.query(`CREATE TABLE kiosk_devices (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    branch_id BIGINT NULL,
    token_hash CHAR(64) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_used_at DATETIME NULL,
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    UNIQUE KEY uniq_kiosk_token (token_hash),
    CONSTRAINT fk_kiosk_branch FOREIGN KEY (branch_id) REFERENCES locations(id)
  )`));

  await step('employees.kiosk_pin_hash', await columnExists('employees', 'kiosk_pin_hash'), () => pool.query(
    `ALTER TABLE employees ADD COLUMN kiosk_pin_hash CHAR(64) NULL, ADD COLUMN kiosk_pin_set_at DATETIME NULL,
     ADD UNIQUE KEY uniq_employee_kiosk_pin (kiosk_pin_hash)`
  ));

  await step('attendance_logs.in_device_id / out_device_id', await columnExists('attendance_logs', 'in_device_id'), () => pool.query(
    'ALTER TABLE attendance_logs ADD COLUMN in_device_id BIGINT NULL, ADD COLUMN out_device_id BIGINT NULL'
  ));

  const [[src]] = await pool.query(
    `SELECT COLUMN_TYPE AS t FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'attendance_logs' AND column_name = 'source'`
  );
  await step("attendance_logs.source gains 'kiosk'", String(src.t).includes("'kiosk'"), () => pool.query(
    "ALTER TABLE attendance_logs MODIFY source ENUM('self', 'manual', 'kiosk') NOT NULL DEFAULT 'self'"
  ));

  let [[page]] = await pool.query("SELECT id FROM pages WHERE route = '/kiosk-devices'");
  if (page) console.log(`Page /kiosk-devices already registered (id ${page.id}).`);
  else if (DRY_RUN) console.log('Would register /kiosk-devices as "Time Clock Devices".');
  else {
    const [cols] = await pool.query('SHOW COLUMNS FROM pages');
    const hasModule = new Set(cols.map((c) => c.Field)).has('module');
    const [res] = await pool.query(
      `INSERT INTO pages (route, name${hasModule ? ', module' : ''}) VALUES ('/kiosk-devices', 'Time Clock Devices'${hasModule ? ", 'HR'" : ''})`
    );
    page = { id: res.insertId };
    console.log(`Registered /kiosk-devices as "Time Clock Devices" (id ${page.id}).`);
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
    console.log(`  + full access on /kiosk-devices for ${admins.length} admin(s).`);
  }

  await pool.end();
  console.log('Done.');
}

main().catch((err) => { console.error('Kiosk migration failed:', err.message); process.exit(1); });
