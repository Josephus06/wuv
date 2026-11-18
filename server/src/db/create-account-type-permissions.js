// One-off migration: creates account_type_permissions -- the default permission matrix per
// Account Type (Sales, Production, Artist, ...). The Add/Update User wizard reads these as a
// starting point ("Apply template" on the Permissions step) so a new Sales user doesn't have to
// be ticked page by page. Templates are a starting point only: applying one fills the wizard's
// checkboxes, which the admin can still hand-tweak before saving. Nothing here changes any
// existing user's actual permissions.
//
// Seeding: rather than inventing what "Sales" should see, each template is derived from what
// that account type's active users ALREADY have -- a page+action is granted when more than half
// of them have it. That washes out drift (your 27 Sales users have 25 distinct permission sets,
// but a clear 26/27 majority core) while keeping the real shape of the role. System Admin is
// special-cased to full access on every page.
//
//   node src/db/create-account-type-permissions.js --dry-run
//   node src/db/create-account-type-permissions.js
//   node src/db/create-account-type-permissions.js --reseed   (rebuild templates that already exist)
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const RESEED = process.argv.includes('--reseed');
const ACTIONS = ['can_view', 'can_add', 'can_edit', 'can_delete', 'can_approve', 'can_print'];

// Kept in step with ACCOUNT_TYPE_OPTIONS in client/src/utils/accountTypes.js.
const ACCOUNT_TYPES = [
  'Sales', 'Production', 'Costing Supervisor', 'Logistics', 'Purchasing', 'Inventory',
  'Accounts Receivable', 'Accounting', 'Treasury', 'HR', 'IT', 'Security',
  'Accounting Manager', 'Artist', 'General Manager', 'System Admin', 'Audit Staff', 'Audit Supervisor',
  'Production Manager', 'Sales Manager', 'SBU', 'Design Supervisor', 'HR Manager', 'Accounting Supervisor',
  'Costing Staff', 'Account Payable', 'CSA', 'Branch Supervisor',
];

const DDL = `
CREATE TABLE account_type_permissions (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    account_type VARCHAR(60) NOT NULL,
    page_id BIGINT NOT NULL,
    can_view TINYINT NOT NULL DEFAULT 0,
    can_add TINYINT NOT NULL DEFAULT 0,
    can_edit TINYINT NOT NULL DEFAULT 0,
    can_delete TINYINT NOT NULL DEFAULT 0,
    can_approve TINYINT NOT NULL DEFAULT 0,
    can_print TINYINT NOT NULL DEFAULT 0,
    updated_at DATETIME NULL,
    updated_by_user_id BIGINT NULL,
    UNIQUE KEY uq_atp (account_type, page_id),
    INDEX idx_atp_type (account_type)
)`;

async function tableExists(name) {
  const [rows] = await pool.query('SHOW TABLES LIKE ?', [name]);
  return rows.length > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING changes.\n');

  const exists = await tableExists('account_type_permissions');
  if (exists) console.log('Table account_type_permissions already exists.');
  else if (DRY_RUN) console.log('Would create table account_type_permissions.');
  else { await pool.query(DDL); console.log('Created table account_type_permissions.'); }

  const [pages] = await pool.query('SELECT id, name FROM pages');
  const [users] = await pool.query(
    "SELECT id, account_type FROM users WHERE is_active = 1 AND account_type IS NOT NULL AND account_type <> ''"
  );
  const [perms] = await pool.query('SELECT * FROM user_page_permissions');

  const permsByUser = new Map();
  perms.forEach((p) => {
    if (!permsByUser.has(p.user_id)) permsByUser.set(p.user_id, []);
    permsByUser.get(p.user_id).push(p);
  });

  const usersByType = new Map();
  users.forEach((u) => {
    if (!usersByType.has(u.account_type)) usersByType.set(u.account_type, []);
    usersByType.get(u.account_type).push(u.id);
  });

  for (const type of ACCOUNT_TYPES) {
    const [[{ n: already }]] = exists
      ? await pool.query('SELECT COUNT(*) AS n FROM account_type_permissions WHERE account_type = ?', [type])
      : [[{ n: 0 }]];
    if (already && !RESEED) {
      console.log(`\n${type}: template already has ${already} row(s) -- left alone (use --reseed to rebuild).`);
      continue;
    }

    // Build the matrix: System Admin gets everything; everyone else gets the majority position
    // of their existing users. A type with no users yet seeds empty for an admin to fill in.
    const rows = [];
    if (type === 'System Admin') {
      pages.forEach((pg) => rows.push({ page_id: pg.id, can_view: 1, can_add: 1, can_edit: 1, can_delete: 1, can_approve: 1, can_print: 1 }));
    } else {
      const ids = usersByType.get(type) || [];
      if (ids.length) {
        const threshold = ids.length / 2;
        const tally = new Map(); // `${page_id}|${action}` -> count
        ids.forEach((uid) => {
          (permsByUser.get(uid) || []).forEach((p) => {
            ACTIONS.forEach((a) => {
              if (p[a]) {
                const k = `${p.page_id}|${a}`;
                tally.set(k, (tally.get(k) || 0) + 1);
              }
            });
          });
        });
        const byPage = new Map();
        for (const [k, count] of tally) {
          if (count <= threshold) continue;
          const [pid, a] = k.split('|');
          if (!byPage.has(pid)) byPage.set(pid, { page_id: Number(pid), can_view: 0, can_add: 0, can_edit: 0, can_delete: 0, can_approve: 0, can_print: 0 });
          byPage.get(pid)[a] = 1;
        }
        rows.push(...byPage.values());
      }
    }

    const grants = rows.reduce((s, r) => s + ACTIONS.filter((a) => r[a]).length, 0);
    const from = type === 'System Admin' ? 'full access' : `majority of ${(usersByType.get(type) || []).length} user(s)`;
    if (DRY_RUN) {
      console.log(`\n${type}: would seed ${rows.length} page(s) / ${grants} grant(s) (${from}).`);
      continue;
    }
    if (already) await pool.query('DELETE FROM account_type_permissions WHERE account_type = ?', [type]);
    for (const r of rows) {
      await pool.query(
        `INSERT INTO account_type_permissions (account_type, page_id, can_view, can_add, can_edit, can_delete, can_approve, can_print, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [type, r.page_id, r.can_view, r.can_add, r.can_edit, r.can_delete, r.can_approve, r.can_print]
      );
    }
    console.log(`\n${type}: seeded ${rows.length} page(s) / ${grants} grant(s) (${from}).`);
  }

  console.log('\nNo existing user permissions were changed.');
  await pool.end();
}

main().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
