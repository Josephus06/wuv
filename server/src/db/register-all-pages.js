// Registers EVERY page the app has a permission-checked route for, and finishes setting up
// the seeded admin.
//
// Why this exists: in the system this was cloned from, most `pages` rows arrived with the
// legacy-site import tooling rather than from a migration, so a database built purely from
// migrations ends up with only ~35 of the 64 pages -- and a page with no row is invisible in
// the nav and refused by requirePermission, i.e. most of the ERP is unreachable.
//
// It also fixes two things seed.js leaves undone: the admin's account_type is null (so checks
// like requireSystemAdmin and the low-GP approval gate fail), and it only holds permissions on
// the handful of pages seed.js knew about.
//
// Idempotent -- safe to re-run after adding a module, which is the intended way to pick up new
// pages. Keep PAGES in step with NAV_STRUCTURE in client/src/components/Layout.jsx.
//
//   node src/db/register-all-pages.js --dry-run
//   node src/db/register-all-pages.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

const PAGES = [
  // General
  { route: '/dashboard',                      name: 'Dashboard',                   module: 'General' },
  { route: '/tickets',                        name: 'Tickets',                     module: 'General' },
  { route: '/process-flow',                   name: 'Manual',                      module: 'General' },
  // CRM
  { route: '/crm-dashboard',                  name: 'CRM Dashboard',               module: 'CRM' },
  { route: '/leads',                          name: 'Leads',                       module: 'CRM' },
  { route: '/pipeline',                       name: 'Pipeline',                    module: 'CRM' },
  // Commission
  { route: '/commission-schemes',             name: 'Commission Table',            module: 'Commission' },
  { route: '/employee-quotas',                name: 'Employee Quota',              module: 'Commission' },
  { route: '/commission-report',              name: 'Commission',                  module: 'Commission' },
  // Master Lists
  { route: '/employees',                      name: 'Employees',                   module: 'Master Lists' },
  { route: '/users',                          name: 'Users & Permissions',         module: 'Master Lists' },
  { route: '/customers',                      name: 'Customers',                   module: 'Master Lists' },
  { route: '/suppliers',                      name: 'Suppliers',                   module: 'Master Lists' },
  { route: '/job-types',                      name: 'Job Types',                   module: 'Master Lists' },
  { route: '/pms-job-types',                  name: 'PMS Job Types',               module: 'Master Lists' },
  { route: '/inventory',                      name: 'Inventory Items',             module: 'Master Lists' },
  { route: '/service-items',                  name: 'Service Items',               module: 'Master Lists' },
  { route: '/lookups',                        name: 'Lookups',                     module: 'Master Lists' },
  { route: '/transaction-settings',           name: 'Transaction Settings',        module: 'Master Lists' },
  // HR
  { route: '/shifts',                         name: 'Shifts',                      module: 'HR' },
  { route: '/shift-assignments',              name: 'Shift Assignments',           module: 'HR' },
  { route: '/attendance',                     name: 'Attendance',                  module: 'HR' },
  { route: '/payroll',                        name: 'Payroll',                     module: 'HR' },
  { route: '/payroll-settings',               name: 'Payroll Settings',            module: 'HR' },
  { route: '/payroll-holidays',               name: 'Holidays',                    module: 'HR' },
  { route: '/payroll-pay-items',              name: 'Allowances & Deductions',     module: 'HR' },
  { route: '/payroll-loans',                  name: 'Loans',                       module: 'HR' },
  // Inventory
  { route: '/inventory-adjustments',          name: 'Inventory Adjustments',       module: 'Inventory' },
  { route: '/transfer-orders',                name: 'Transfer Orders',             module: 'Inventory' },
  { route: '/office-supply-requisitions',     name: 'Office Supply Requisition',   module: 'Inventory' },
  { route: '/stock-ledger-reports',           name: 'Stock Ledger',                module: 'Inventory' },
  { route: '/bin-card-reports',               name: 'Bin Card',                    module: 'Inventory' },
  // Sales
  { route: '/estimates',                      name: 'Estimates',                   module: 'Sales' },
  { route: '/sales-orders',                   name: 'Sales Orders',                module: 'Sales' },
  { route: '/non-standard-job-orders',        name: 'NSTDJO',                      module: 'Sales' },
  { route: '/non-standard-sales-orders',      name: 'NSSO',                        module: 'Sales' },
  { route: '/warranty-certificates',          name: 'Warranty Certificate',        module: 'Sales' },
  { route: '/job-orders',                     name: 'Job Orders',                  module: 'Sales' },
  // Costing
  { route: '/process-costing',                name: 'Process Costing',             module: 'Costing' },
  { route: '/material-costing',               name: 'Material Costing',            module: 'Costing' },
  // Design
  { route: '/assigned-jo',                    name: 'Assigned JO',                 module: 'Design' },
  { route: '/reports/artist-incentive',       name: 'Artist Incentive Report',     module: 'Design' },
  // Purchasing
  { route: '/purchase-requisitions',          name: 'Purchase Requisitions',       module: 'Purchasing' },
  { route: '/place-order-form',               name: 'Place Order Form',            module: 'Purchasing' },
  { route: '/purchase-orders',                name: 'Purchase Orders',             module: 'Purchasing' },
  // Production
  { route: '/production',                     name: 'Production',                  module: 'Production' },
  { route: '/rwip-job-orders',                name: 'RWIP',                        module: 'Production' },
  { route: '/rfqc-job-orders',                name: 'RFQC',                        module: 'Production' },
  { route: '/scheduled-jo',                   name: 'Scheduled JO',                module: 'Production' },
  { route: '/assembly-builds',                name: 'Assembly Build',              module: 'Production' },
  // Accounting
  { route: '/sales-invoices',                 name: 'Invoice',                     module: 'Accounting' },
  { route: '/delivery-tickets',               name: 'Delivery Ticket',             module: 'Accounting' },
  { route: '/customer-payments',              name: 'Customer Payments',           module: 'Accounting' },
  { route: '/customer-refunds',               name: 'Customer Refunds',            module: 'Accounting' },
  { route: '/credit-memos',                   name: 'Credit Memo',                 module: 'Accounting' },
  { route: '/vendor-bills',                   name: 'Vendor Bill',                 module: 'Accounting' },
  { route: '/bill-payments',                  name: 'Bill Payment',                module: 'Accounting' },
  { route: '/bill-credits',                   name: 'Bill Credit',                 module: 'Accounting' },
  { route: '/cheques',                        name: 'Cheque',                      module: 'Accounting' },
  { route: '/journals',                       name: 'Journal',                     module: 'Accounting' },
  { route: '/deposits',                       name: 'Deposit',                     module: 'Accounting' },
  { route: '/fund-transfers',                 name: 'Fund Transfer',               module: 'Accounting' },
  { route: '/commission-payables',            name: 'Commission Payable',          module: 'Accounting' },
  { route: '/commission-vouchers',            name: 'Commission Voucher',          module: 'Accounting' },
  { route: '/chart-of-account-types',         name: 'Chart Of Account Types',      module: 'Accounting' },
  { route: '/chart-of-accounts',              name: 'Chart Of Accounts',           module: 'Accounting' },
  { route: '/manage-accounting-period',       name: 'Manage Accounting Period',    module: 'Accounting' },
  { route: '/reports/trial-balance',          name: 'Trial Balance',               module: 'Accounting' },
  { route: '/reports/income-statement',       name: 'Income Statement',            module: 'Accounting' },
  { route: '/reports/balance-sheet',          name: 'Balance Sheet',               module: 'Accounting' },
  { route: '/reports/ar-aging',               name: 'AR Aging',                    module: 'Accounting' },
  { route: '/reports/general-ledger',         name: 'General Ledger',              module: 'Accounting' },
];

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only.\n' : 'APPLYING changes.\n');

  const [cols] = await pool.query('SHOW COLUMNS FROM pages');
  const hasModule = new Set(cols.map((c) => c.Field)).has('module');

  let created = 0;
  let existing = 0;
  for (const p of PAGES) {
    const [[row]] = await pool.query('SELECT id FROM pages WHERE route = ?', [p.route]);
    if (row) { existing += 1; continue; }
    created += 1;
    if (DRY_RUN) { console.log(`  + would register ${p.route} (${p.name})`); continue; }
    const fields = ['route', 'name'];
    const values = [p.route, p.name];
    if (hasModule) { fields.push('module'); values.push(p.module); }
    await pool.query(
      `INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
      values
    );
    console.log(`  + registered ${p.route} (${p.name})`);
  }
  console.log(`
${created} page(s) ${DRY_RUN ? 'would be ' : ''}registered, ${existing} already present.`);

  // Every active System Admin -- plus the seeded 'admin' account, which has no account_type
  // yet on a fresh database and would otherwise be missed.
  const [admins] = await pool.query(
    "SELECT id, username, display_name, account_type FROM users WHERE is_active = TRUE AND (account_type = 'System Admin' OR username = 'admin')"
  );
  const [allPages] = await pool.query('SELECT id FROM pages');
  console.log(`
Admin setup (${admins.length} account(s), ${allPages.length} pages):`);

  for (const u of admins) {
    if (u.account_type !== 'System Admin') {
      if (DRY_RUN) console.log(`  ~ ${u.username}: would set account_type = 'System Admin'`);
      else {
        await pool.query("UPDATE users SET account_type = 'System Admin' WHERE id = ?", [u.id]);
        console.log(`  ~ ${u.username}: account_type set to 'System Admin'`);
      }
    }
    let granted = 0;
    for (const pg of allPages) {
      const [[have]] = await pool.query(
        'SELECT id, can_view, can_add, can_edit, can_delete, can_approve FROM user_page_permissions WHERE user_id = ? AND page_id = ?',
        [u.id, pg.id]
      );
      const full = have && have.can_view && have.can_add && have.can_edit && have.can_delete && have.can_approve;
      if (full) continue;
      granted += 1;
      if (DRY_RUN) continue;
      if (have) {
        await pool.query(
          'UPDATE user_page_permissions SET can_view=TRUE, can_add=TRUE, can_edit=TRUE, can_delete=TRUE, can_approve=TRUE WHERE id = ?',
          [have.id]
        );
      } else {
        await pool.query(
          'INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve) VALUES (?, ?, TRUE, TRUE, TRUE, TRUE, TRUE)',
          [u.id, pg.id]
        );
      }
    }
    console.log(`  + ${u.username}: full access on ${granted} more page(s)`);
  }

  await pool.end();
}

main().catch((err) => { console.error('Failed:', err); process.exit(1); });
