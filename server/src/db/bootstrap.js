// One-shot bootstrap for a BRAND NEW company database.
//
// The schema is not in a single file: db/schema.sql defines the original 116 tables, and
// every module added since (journals, cheques, deposits, commission, NSSO, OSR, warranty,
// accounting periods, permission templates...) creates its own tables in its own script.
// Running them by hand in the right order is error-prone, so this does it for you:
//
//   1. migrate.js        -- create the database and apply schema.sql
//   2. seed.js           -- pages, lookups, and the initial admin login
//   3. schema scripts    -- every create-*/alter-*/register-* migration, in dependency order
//   4. reporting tables  -- anything the UI reads but no migration owns
//
// Every step is idempotent, so re-running is safe and is the intended way to bring an
// existing database up to date after pulling new modules.
//
//   node src/db/bootstrap.js --dry-run    list the steps without touching the database
//   node src/db/bootstrap.js              run them
//
// After this, log in with the seeded admin (see seed.js) and change its password.
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const DB_DIR = __dirname;

// Order matters where a later script expects a table or a `pages` row from an earlier one.
// Anything not listed here is a data fix-up or backfill for records this fresh database does
// not have yet, so it is deliberately excluded -- see SKIPPED below.
const STEPS = [
  ['migrate.js', 'create the database and apply schema.sql'],
  ['seed.js', 'seed pages, lookups and the admin user'],

  // Sales / production modules
  ['register-nstdjo-page.js', 'register the NSTDJO page'],
  ['add-nstdjo-sub-status.js', 'NSTDJO sub-status'],
  ['add-nstdjo-approval.js', 'NSTDJO approval'],
  ['add-nstdjo-job-type-id.js', 'NSTDJO job type'],
  ['add-nstdjo-layout-assignment.js', 'NSTDJO layout assignment'],
  ['add-nstdjo-layout-sessions.js', 'NSTDJO layout sessions'],
  ['alter-nstdjo-materials.js', 'NSTDJO materials'],
  ['grant-nstdjo-design-supervisor-access.js', 'NSTDJO design supervisor access'],
  ['create-non-standard-sales-orders.js', 'NSSO tables and page'],
  ['alter-nsso-create-jo.js', 'NSSO job-order link'],
  ['alter-nsso-sample-fields.js', 'NSSO sample fields'],
  ['alter-nsjo-rma-approval.js', 'NSJO RMA approval'],
  ['alter-job-rwip.js', 'RWIP columns on job orders'],
  ['alter-jo-nullable-so.js', 'job orders without a sales order'],
  ['create-rwip-page.js', 'RWIP page'],
  ['create-rfqc-page.js', 'RFQC page'],
  ['alter-estimate-lowgp.js', 'low-GP approval flag on estimates'],
  ['create-warranty-certificates.js', 'warranty certificates'],

  // Inventory
  ['create-osr.js', 'office supply requisitions'],
  ['create-osr-fulfillment.js', 'OSR fulfillment'],

  // Accounting
  ['create-delivery-tickets.js', 'delivery tickets'],
  ['create-customer-payments-credit-memos.js', 'customer payments and credit memos'],
  ['create-customer-refunds.js', 'customer refunds'],
  ['create-journals.js', 'journals'],
  ['create-deposits.js', 'bank deposits'],
  ['create-cheques.js', 'cheques'],
  ['create-fund-transfers.js', 'fund transfers'],
  ['alter-vendor-bills-standalone.js', 'standalone (expense) vendor bills'],
  ['alter-sales-orders-pos-import.js', 'POS category-sales PDF import into sales orders'],
  ['alter-sales-orders-daily-collections.js', 'daily cash & collections sales order layout'],
  ['create-pos-category-accounts.js', 'POS category to revenue account mapping'],
  ['alter-sales-orders-deposit.js', 'undeposited/deposited counter sales'],
  ['alter-sales-orders-department.js', 'department assignment on counter sales'],
  ['alter-sales-orders-shift-attendants.js', 'Z-Reading opened/closed cashiers and times'],
  ['alter-sales-orders-tender-variance.js', 'unbalanced Z-Reading days marked with their variance'],
  ['create-accounting-periods.js', 'accounting periods'],
  ['register-ar-aging-page.js', 'A/R aging report page'],

  // Commission
  ['create-commission-module.js', 'commission schemes and quotas'],
  ['create-user-sales-divisions.js', 'user sales divisions'],
  ['register-commission-report-page.js', 'commission report page'],
  ['create-commission-payables.js', 'commission payables'],
  ['create-commission-vouchers.js', 'commission vouchers'],

  // Cross-cutting
  ['create-transaction-settings.js', 'transaction settings'],
  ['add-artist-incentive-report-page.js', 'artist incentive report page'],
  ['create-process-flow-page.js', 'process flow page'],
  ['create-newsfeed.js', 'dashboard newsfeed (posts, photos, comments, reactions)'],
  ['create-account-type-permissions.js', 'account-type permission templates'],

  // HR
  ['create-attendance.js', 'shifts, shift assignments and attendance'],
  ['create-companies.js', 'companies, and the company of each branch and employee'],
  ['add-schedules.js', 'plotted weekly schedules, paid breaks and branch shifts'],
  ['add-kiosk.js', 'branch time clock devices and employee PINs'],
  ['add-attendance-import.js', 'imported attendance and approved overtime'],
  ['add-employee-profile.js', 'employee profile (personal, employment, other info) and dated pay rates'],
  ['create-payroll.js', 'payroll: rule sets, holidays, allowances, loans and semi-monthly runs'],

  // Last: registers any page the migrations above did not, and gives the seeded admin an
  // account_type plus full access to everything.
  ['register-all-pages.js', 'register all pages and finish admin setup'],
];

// Data fix-ups and backfills that only make sense against migrated historical records.
// A new company has none, so running them would be a no-op at best.
const SKIPPED = [
  // Expects the originating company's own job types ("FILE PREPARATION LAYOUT",
  // "SITE INSPECTION") to already exist; a new company defines its own, so this cannot run
  // against a fresh database.
  'align-nstdjo-master-data.js',
  'backfill-ab-lines.js', 'backfill-jo-quantities.js', 'fix-department-mapping.js',
  'fix-division-duplicates.js', 'fix-invoice-department.js', 'generate-invoice-payments.js',
  'recompute-line-gp.js', 'recompute-transfer-order-statuses.js', 'reconstruct-estimate-lines.js',
  'rollup-jo-production-qty.js',
];

function run(script) {
  execFileSync(process.execPath, [path.join(DB_DIR, script)], {
    stdio: 'inherit',
    cwd: path.join(DB_DIR, '..', '..'),
  });
}

async function extraTables() {
  const pool = require('../db');
  // The Stock Ledger screen reads this table. In the originating system it was populated by
  // an importer that pulled from a legacy site; that tooling is not part of this build, so
  // create it empty -- the page then renders "no rows" instead of failing on a missing table.
  // Replace with a real implementation (computed from inventory transactions) when needed.
  await pool.query(`CREATE TABLE IF NOT EXISTS live_stock_ledger (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    item_pk VARCHAR(64), item_code VARCHAR(191), inventory_id BIGINT NULL, unit_title VARCHAR(60),
    location_pk VARCHAR(64), location VARCHAR(191), location_id BIGINT NULL,
    transaction_date DATE NULL, transaction_type VARCHAR(80), reference VARCHAR(191),
    qty_in DECIMAL(18,4) NOT NULL DEFAULT 0, qty_out DECIMAL(18,4) NOT NULL DEFAULT 0,
    balance DECIMAL(18,4) NOT NULL DEFAULT 0, unit_cost DECIMAL(18,4) NULL,
    INDEX idx_lsl_item (inventory_id), INDEX idx_lsl_date (transaction_date)
  )`);
  await pool.end();
  console.log('Ensured live_stock_ledger (empty -- Stock Ledger has no data source in this build).');
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- listing steps only.\n' : 'BOOTSTRAPPING.\n');

  const missing = STEPS.filter(([s]) => !fs.existsSync(path.join(DB_DIR, s))).map(([s]) => s);
  if (missing.length) {
    console.error('Missing migration script(s):', missing.join(', '));
    process.exit(1);
  }

  STEPS.forEach(([script, what], i) => {
    const label = `[${String(i + 1).padStart(2)}/${STEPS.length}] ${script} -- ${what}`;
    if (DRY_RUN) { console.log(label); return; }
    console.log(`\n===== ${label}`);
    run(script);
  });

  if (DRY_RUN) {
    console.log(`\nThen: create live_stock_ledger (empty).`);
    console.log(`\n${STEPS.length} step(s). Skipped ${SKIPPED.length} data-fixup script(s): ${SKIPPED.join(', ')}`);
    return;
  }

  console.log('\n===== extra tables');
  await extraTables();
  console.log('\nBootstrap complete. Log in with the seeded admin and change its password.');
}

main().catch((err) => { console.error('\nBootstrap failed:', err.message); process.exit(1); });
