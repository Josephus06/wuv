// Payroll review before approval: Prepared -> Noted (checked) -> Approved.
//
//   payroll_runs.status gains 'for_checking' and 'for_approval'
//       draft         HR computes and adjusts it
//       for_checking  HR submitted it (Prepared By); locked
//       for_approval  a checker marked it checked (Noted By); locked
//       approved      approved (Approved By); its loan lines count against loan balances
//   payroll_runs.prepared_by_user_id / prepared_at, noted_by_user_id / noted_at
//       Who did each step; printed on the payslips and the payroll register.
//   Page /payroll-checking ("Payroll Checking")
//       Not a screen: a permission. Approve on it lets a user check (note) a payroll; approving
//       stays with Approve on Payroll.
//
// Idempotent:
//   node src/db/add-payroll-review.js --dry-run
//   node src/db/add-payroll-review.js
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

async function step(label, done, apply) {
  if (done) { console.log(`${label} -- already present, skipped`); return; }
  if (DRY_RUN) { console.log(`Would apply: ${label}`); return; }
  await apply();
  console.log(`${label} -- done`);
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only, nothing will be written.\n' : 'APPLYING changes.\n');

  const [[st]] = await pool.query(
    `SELECT COLUMN_TYPE AS t FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'payroll_runs' AND column_name = 'status'`
  );
  await step("payroll_runs.status gains 'for_checking', 'for_approval'", String(st.t).includes("'for_checking'"), () => pool.query(
    "ALTER TABLE payroll_runs MODIFY status ENUM('draft', 'for_checking', 'for_approval', 'approved') NOT NULL DEFAULT 'draft'"
  ));
  for (const [col, ddl] of [
    ['prepared_by_user_id', 'BIGINT NULL'],
    ['prepared_at', 'DATETIME NULL'],
    ['noted_by_user_id', 'BIGINT NULL'],
    ['noted_at', 'DATETIME NULL'],
  ]) {
    await step(`payroll_runs.${col}`, await columnExists('payroll_runs', col), () => pool.query(
      `ALTER TABLE payroll_runs ADD COLUMN ${col} ${ddl}`
    ));
  }

  let [[page]] = await pool.query("SELECT id FROM pages WHERE route = '/payroll-checking'");
  if (page) console.log(`Page /payroll-checking already registered (id ${page.id}).`);
  else if (DRY_RUN) console.log('Would register /payroll-checking as "Payroll Checking".');
  else {
    const [cols] = await pool.query('SHOW COLUMNS FROM pages');
    const hasModule = new Set(cols.map((c) => c.Field)).has('module');
    const [res] = await pool.query(
      `INSERT INTO pages (route, name${hasModule ? ', module' : ''}) VALUES ('/payroll-checking', 'Payroll Checking'${hasModule ? ", 'HR'" : ''})`
    );
    page = { id: res.insertId };
    console.log(`Registered /payroll-checking as "Payroll Checking" (id ${page.id}).`);
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
    console.log(`  + full access on /payroll-checking for ${admins.length} admin(s).`);
  }

  await pool.end();
  console.log('Done.');
}

main().catch((err) => { console.error('Payroll review migration failed:', err.message); process.exit(1); });
