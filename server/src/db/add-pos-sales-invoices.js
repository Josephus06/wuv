// POS shift sales recorded as Sales Invoices (Sales Invoices > Import POS Sales), the way the
// company records them in Odoo: one invoice per shift from the POS "CATEGORY SALES" report, one
// line per item, revenue to each item's own income account, the branch on the invoice -- paid from
// the same shift's Z-Reading (cash and GCash), and taking the products sold out of the branch's
// stock at cost.
//
//   sales_invoices.pos_import_key   the shift ("880/FIRSTSHIFT|2026-10-01 19:55"); unique, so a shift
//                                   can only ever be invoiced once
//   sales_invoice_lines.unit_cost / cost_amount
//                                   the item's average cost when it was sold, frozen on the line, and
//                                   the cost of goods sold it posts (Dr COGS / Cr inventory)
//   sales_invoice_lines.pos_category the POS category the line came under (FULL-SERVICE, DETERGENT ...)
//   pos_category_accounts.item_type / item_income_account_id / asset_account_id / cogs_account_id
//                                   how an item first seen under that category is created: its type
//                                   and accounts. Its own income account, not the category's account_id
//                                   (which the Z-Reading counter sales split revenue by): products under
//                                   DETERGENT / FABCON are Product Sales (30130), as in Odoo.
//
// Idempotent:
//   node src/db/add-pos-sales-invoices.js --dry-run
//   node src/db/add-pos-sales-invoices.js
require('dotenv').config();
const pool = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');

// Category -> how a new item under it is set up. Codes from the company chart; a code this chart does
// not have is left blank (the item then posts to the defaults and can be fixed in Master Lists).
//   [category, item type, income, inventory asset, cost of sales]
const CATEGORY_DEFAULTS = [
  ['ALA CARTE', 'Service', '30110', null, null],
  ['DRY', 'Service', '30110', null, null],
  ['FULL-SERVICE', 'Service', '30110', '15221', '30404'],
  ['SELF-SERVICE', 'Service', '30110', '15221', '30404'],
  ['DETERGENT', 'Inventory', '30130', '15221', '30404'],
  ['FABCON', 'Inventory', '30130', '15221', '30404'],
  ['WATER REFILLING', 'Service', '30120', '15222', '30405'],
];

async function hasColumn(table, column) {
  const [[r]] = await pool.query(
    'SELECT COUNT(*) n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return r.n > 0;
}
async function hasIndex(table, name) {
  const [[r]] = await pool.query(
    'SELECT COUNT(*) n FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?', [table, name]);
  return r.n > 0;
}
async function step(label, done, sql) {
  if (done) { console.log(`${label} -- already present, skipped`); return; }
  if (DRY_RUN) { console.log(`Would apply: ${label}`); return; }
  await pool.query(sql);
  console.log(`${label} -- done`);
}
async function accountId(code) {
  if (!code) return null;
  const [[a]] = await pool.query('SELECT id FROM chart_of_accounts WHERE account_code = ?', [code]);
  return a ? a.id : null;
}

(async () => {
  try {
    console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${DRY_RUN ? ' -- DRY RUN' : ''}`);
    await step('sales_invoices.pos_import_key', await hasColumn('sales_invoices', 'pos_import_key'),
      'ALTER TABLE sales_invoices ADD COLUMN pos_import_key VARCHAR(120) NULL');
    await step('sales_invoices unique pos_import_key', await hasIndex('sales_invoices', 'uq_sales_invoices_pos_import_key'),
      'ALTER TABLE sales_invoices ADD UNIQUE INDEX uq_sales_invoices_pos_import_key (pos_import_key)');
    await step('sales_invoice_lines.unit_cost', await hasColumn('sales_invoice_lines', 'unit_cost'),
      'ALTER TABLE sales_invoice_lines ADD COLUMN unit_cost DECIMAL(18,6) NULL');
    await step('sales_invoice_lines.cost_amount', await hasColumn('sales_invoice_lines', 'cost_amount'),
      'ALTER TABLE sales_invoice_lines ADD COLUMN cost_amount DECIMAL(14,2) NULL');
    await step('sales_invoice_lines.pos_category', await hasColumn('sales_invoice_lines', 'pos_category'),
      'ALTER TABLE sales_invoice_lines ADD COLUMN pos_category VARCHAR(80) NULL');
    await step('pos_category_accounts.item_type', await hasColumn('pos_category_accounts', 'item_type'),
      'ALTER TABLE pos_category_accounts ADD COLUMN item_type VARCHAR(30) NULL');
    await step('pos_category_accounts.item_income_account_id', await hasColumn('pos_category_accounts', 'item_income_account_id'),
      'ALTER TABLE pos_category_accounts ADD COLUMN item_income_account_id BIGINT NULL');
    await step('pos_category_accounts.asset_account_id', await hasColumn('pos_category_accounts', 'asset_account_id'),
      'ALTER TABLE pos_category_accounts ADD COLUMN asset_account_id BIGINT NULL');
    await step('pos_category_accounts.cogs_account_id', await hasColumn('pos_category_accounts', 'cogs_account_id'),
      'ALTER TABLE pos_category_accounts ADD COLUMN cogs_account_id BIGINT NULL');

    // Category defaults: only fills what is blank, so a mapping someone has already set is kept.
    if (!DRY_RUN) {
      for (const [name, type, income, asset, cogs] of CATEGORY_DEFAULTS) {
        const [incomeId, assetId, cogsId] = [await accountId(income), await accountId(asset), await accountId(cogs)];
        await pool.query(
          `INSERT INTO pos_category_accounts (category_name, account_id, item_income_account_id, item_type, asset_account_id, cogs_account_id)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE account_id = COALESCE(account_id, VALUES(account_id)),
             item_income_account_id = COALESCE(item_income_account_id, VALUES(item_income_account_id)),
             item_type = COALESCE(item_type, VALUES(item_type)),
             asset_account_id = COALESCE(asset_account_id, VALUES(asset_account_id)),
             cogs_account_id = COALESCE(cogs_account_id, VALUES(cogs_account_id))`,
          [name, incomeId, incomeId, type, assetId, cogsId]);
        console.log(`category ${name}: ${type}, income ${income}${incomeId ? '' : ' (not in chart)'}`);
      }
    } else {
      console.log(`Would set defaults for ${CATEGORY_DEFAULTS.length} POS categories`);
    }
    await pool.end();
  } catch (err) {
    console.error(err);
    await pool.end();
    process.exit(1);
  }
})();
