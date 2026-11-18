// Database side of the Accounting reports, BIR Reports and Treasury brought over from GSUITE
// (2026-11-18), on top of sync-gsuite-existing-modules.js, which must have run first.
//
// GENERATED from a schema diff of GSUITE's database against this one -- re-running the generator
// rather than hand-editing is the intended way to change it. Every step is idempotent: tables are
// CREATE IF NOT EXISTS, columns / indexes are added only when absent, and the permission seeds run
// only in the run that adds their column, so a later admin change is never overwritten.
//
//   1. 8 tables these pages keep their own records in: budgets, BIR 2307 receipts and
//      issuances, collection incentive settings, delivery methods.
//   2. 0 columns GSUITE added to tables both systems share. A column GSUITE declares
//      NOT NULL with no default is added NULL here, so this system's own insert paths keep working.
//   3. 1 column changes -- widenings and NOT NULL -> NULL relaxations only. wu's own HR,
//      payroll and feed tables are not touched at all.
//   4. 0 indexes.
//   5. A page for each report, granted to whoever already holds the page it sits beside (below).
//
//   node src/db/sync-gsuite-accounting-reports.js --dry-run    list what would change
//   node src/db/sync-gsuite-accounting-reports.js              apply it
require('dotenv').config();
const pool = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');

const TABLES = [
  [
    "budget_lines",
    "CREATE TABLE IF NOT EXISTS `budget_lines` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `budget_id` bigint NOT NULL,\n  `account_id` bigint NOT NULL,\n  `month` tinyint NOT NULL,\n  `amount` decimal(16,2) NOT NULL DEFAULT '0.00',\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq_budget_line` (`budget_id`,`account_id`,`month`)\n) ENGINE=InnoDB"
  ],
  [
    "budget_row_amounts",
    "CREATE TABLE IF NOT EXISTS `budget_row_amounts` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `row_id` bigint NOT NULL,\n  `month` tinyint NOT NULL,\n  `amount` decimal(16,2) NOT NULL DEFAULT '0.00',\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq_budget_row_month` (`row_id`,`month`)\n) ENGINE=InnoDB"
  ],
  [
    "budget_rows",
    "CREATE TABLE IF NOT EXISTS `budget_rows` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `budget_id` bigint NOT NULL,\n  `grp` enum('admin','selling','cogs') NOT NULL,\n  `label` varchar(100) NOT NULL,\n  `source_department` varchar(100) DEFAULT NULL,\n  `department_id` bigint DEFAULT NULL,\n  `sort` int NOT NULL DEFAULT '0',\n  `pct` decimal(9,4) DEFAULT NULL,\n  `remarks` varchar(500) DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `idx_budget_rows_budget` (`budget_id`)\n) ENGINE=InnoDB"
  ],
  [
    "collection_incentive_settings",
    "CREATE TABLE IF NOT EXISTS `collection_incentive_settings` (\n  `year` smallint unsigned NOT NULL,\n  `target_current` decimal(9,6) NOT NULL,\n  `target_1_30` decimal(9,6) NOT NULL,\n  `target_31_60` decimal(9,6) NOT NULL,\n  `target_61_90` decimal(9,6) NOT NULL,\n  `target_over_90` decimal(9,6) NOT NULL,\n  `monthly_target` decimal(15,2) NOT NULL,\n  `incentive_rate` decimal(9,6) NOT NULL DEFAULT '0.001000',\n  `qualifier_pct` decimal(9,6) NOT NULL DEFAULT '0.900000',\n  `updated_by_user_id` int DEFAULT NULL,\n  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n  PRIMARY KEY (`year`)\n) ENGINE=InnoDB"
  ],
  [
    "customer_2307_receipts",
    "CREATE TABLE IF NOT EXISTS `customer_2307_receipts` (\n  `sales_invoice_id` bigint NOT NULL,\n  `received_date` date NOT NULL,\n  `certificate_no` varchar(100) DEFAULT NULL,\n  `remarks` varchar(500) DEFAULT NULL,\n  `received_by_user_id` int DEFAULT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n  PRIMARY KEY (`sales_invoice_id`),\n  KEY `idx_2307_received` (`received_date`)\n) ENGINE=InnoDB"
  ],
  [
    "delivery_methods",
    "CREATE TABLE IF NOT EXISTS `delivery_methods` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `code` varchar(30) NOT NULL,\n  `name` varchar(60) NOT NULL,\n  `is_third_party` tinyint(1) NOT NULL DEFAULT '0',\n  `is_active` tinyint(1) NOT NULL DEFAULT '1',\n  `sort_order` int NOT NULL DEFAULT '0',\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq_delivery_methods_code` (`code`)\n) ENGINE=InnoDB"
  ],
  [
    "source_dept_actuals",
    "CREATE TABLE IF NOT EXISTS `source_dept_actuals` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `year` smallint NOT NULL,\n  `month` tinyint NOT NULL,\n  `source_department` varchar(100) NOT NULL,\n  `section` enum('opex','other_expense','cogs','revenue','other_income') NOT NULL,\n  `amount` decimal(16,2) NOT NULL,\n  `loaded_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq_source_dept_actual` (`year`,`month`,`source_department`,`section`)\n) ENGINE=InnoDB"
  ],
  [
    "supplier_2307_issuances",
    "CREATE TABLE IF NOT EXISTS `supplier_2307_issuances` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `payee_key` varchar(220) NOT NULL,\n  `supplier_id` bigint DEFAULT NULL,\n  `payee_name` varchar(200) DEFAULT NULL,\n  `quarter` char(7) NOT NULL,\n  `period_from` date DEFAULT NULL,\n  `period_to` date DEFAULT NULL,\n  `doc_refs` varchar(1000) DEFAULT NULL,\n  `income_total` decimal(15,2) NOT NULL DEFAULT '0.00',\n  `tax_total` decimal(15,2) NOT NULL DEFAULT '0.00',\n  `issued_by_user_id` int DEFAULT NULL,\n  `issued_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (`id`),\n  KEY `idx_2307_issue_quarter` (`quarter`,`payee_key`)\n) ENGINE=InnoDB"
  ]
];

const ADD_COLUMNS = [];

const MODIFY_COLUMNS = [
  [
    "sales_orders",
    "status",
    "enum('pending_for_jo','jo_in_process','pending_delivery','partially_delivered','pending_billing','pending_billing_partially_delivered','partially_billed','billed','cancelled','recorded','undeposited','deposited') NULL DEFAULT 'pending_for_jo'"
  ]
];

const INDEXES = [];

// The pages whose Void rights used to ride on another flag (GSUITE's add-can-void-permission.js).
const VOIDED_BY = {
  '/sales-invoices': 'can_edit', '/delivery-tickets': 'can_edit', '/customer-payments': 'can_edit',
  '/credit-memos': 'can_edit', '/customer-refunds': 'can_edit', '/cheques': 'can_edit', '/deposits': 'can_edit',
  '/fund-transfers': 'can_edit', '/journals': 'can_edit', '/vendor-bills': 'can_edit', '/bill-payments': 'can_edit',
  '/bill-credits': 'can_edit', '/commission-vouchers': 'can_edit', '/commission-payables': 'can_edit',
  '/inventory-adjustments': 'can_edit', '/assembly-builds': 'can_edit', '/warranty-certificates': 'can_edit',
  '/item-deliveries': 'can_delete',
};

const PAGES = [
  // [route, name, existing page whose users get it, copy all of their rights (else View only)]
  // Reports read off the books: whoever can open the General Ledger.
  ['/reports/budget-vs-actual', 'Budget vs Actual', '/reports/general-ledger', false],
  ['/reports/ar-aging-details', 'AR Aging Details', '/reports/ar-aging', false],
  ['/reports/ap-aging', 'AP Aging', '/reports/general-ledger', false],
  ['/reports/ap-aging-details', 'AP Aging Details', '/reports/general-ledger', false],
  ['/statement-of-accounts', 'Statement of Account', '/reports/ar-aging', false],
  ['/reports/profitability', 'Profitability Report', '/reports/income-statement', false],
  ['/reports/delivery-summary', 'Delivery Summary', '/reports/general-ledger', false],
  ['/reports/commission-sales-orders', 'Sales Orders (Commission)', '/commission-report', false],
  ['/reports/commission-invoices', 'Invoices (Commission)', '/commission-report', false],
  ['/reports/invoiced-job-orders', 'Invoiced Job Orders', '/reports/general-ledger', false],
  ['/reports/disbursement', 'Disbursement Report', '/reports/general-ledger', false],
  // Bank Reconciliation and Budgets are worked, not just read: whoever keeps the Journals.
  ['/accounting/bank-reconciliation', 'Bank Reconciliation', '/journals', true],
  ['/budgets', 'Budgets', '/journals', true],
  // BIR Reports: prepared from the same books.
  ['/reports/bir-sales', 'BIR Sales Report', '/reports/general-ledger', false],
  ['/reports/bir-purchase', 'BIR Purchase Report', '/reports/general-ledger', false],
  ['/reports/bir-ewt', 'Expanded Withholding Tax', '/reports/general-ledger', false],
  ['/reports/bir-cwt', 'Creditable Withholding Tax (2307)', '/reports/general-ledger', false],
  ['/reports/bir-2307', 'BIR 2307 to Suppliers', '/reports/general-ledger', false],
  ['/reports/bir-vat', 'VAT Computation', '/reports/general-ledger', false],
  ['/reports/bir-itr', 'Income Tax Return (1702Q)', '/reports/general-ledger', false],
  ['/reports/bir-tax-return', 'Tax Return', '/reports/general-ledger', false],
  // Treasury: whoever records Customer Payments.
  ['/treasury/collection-forecast', 'Collection Forecast', '/customer-payments', false],
  ['/treasury/collection-aging', 'Collection Report with Aging', '/customer-payments', false],
  ['/treasury/collection-incentive', 'Collection Incentive', '/customer-payments', false],
];

let changes = 0;
async function run(label, sql, params) {
  changes += 1;
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}${label}`);
  if (!DRY_RUN) await pool.query(sql, params);
}
async function tableExists(t) {
  const [[r]] = await pool.query('SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [t]);
  return r.n > 0;
}
async function colInfo(t, col) {
  const [[r]] = await pool.query(
    'SELECT COLUMN_TYPE ty, IS_NULLABLE n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [t, col]);
  return r || null;
}
async function indexExists(t, name) {
  const [[r]] = await pool.query('SELECT COUNT(*) n FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?', [t, name]);
  return r.n > 0;
}

async function seedPermissions(added) {
  const tablesFor = (col) => ['user_page_permissions', 'account_type_permissions'].filter((t) => added.has(`${t}.${col}`));
  const adminJoin = (t) => (t === 'user_page_permissions' ? 'JOIN users u ON u.id = t.user_id' : '');
  const adminWhere = (t) => (t === 'user_page_permissions' ? "u.account_type = 'System Admin'" : "t.account_type = 'System Admin'");
  // can_update: split out of can_edit -- everyone who can edit today can still update.
  for (const t of tablesFor('can_update')) {
    await run(`seed ${t}.can_update from can_edit`, `UPDATE ${t} SET can_update = TRUE WHERE can_edit = TRUE`);
  }
  // can_print: GSUITE grants it to System Admin only. Here every page anyone can VIEW stays printable
  // for them, because this system printed for every viewer until now.
  for (const t of tablesFor('can_print')) {
    await run(`seed ${t}.can_print from can_view`, `UPDATE ${t} SET can_print = TRUE WHERE can_view = TRUE`);
  }
  // can_void: carried over from the flag that used to allow it, page by page.
  for (const t of tablesFor('can_void')) {
    for (const [route, from] of Object.entries(VOIDED_BY)) {
      await run(`seed ${t}.can_void on ${route} from ${from}`,
        `UPDATE ${t} t JOIN pages p ON p.id = t.page_id SET t.can_void = TRUE WHERE p.route = ? AND t.${from} = TRUE`, [route]);
    }
  }
  // can_view_all: System Admin everywhere; and on Commission Payables, which now lists only a
  // person's own payables without it, whoever already edits or approves them keeps seeing all.
  for (const t of tablesFor('can_view_all')) {
    await run(`seed ${t}.can_view_all for System Admin`, `UPDATE ${t} t ${adminJoin(t)} SET t.can_view_all = TRUE WHERE ${adminWhere(t)}`);
    await run(`seed ${t}.can_view_all on /commission-payables for editors / approvers`,
      `UPDATE ${t} t JOIN pages p ON p.id = t.page_id SET t.can_view_all = TRUE
        WHERE p.route = '/commission-payables' AND (t.can_edit = TRUE OR t.can_approve = TRUE)`);
  }
  // System Admin holds every new flag.
  for (const col of ['can_update', 'can_print', 'can_void']) {
    for (const t of tablesFor(col)) {
      await run(`grant ${t}.${col} to System Admin`, `UPDATE ${t} t ${adminJoin(t)} SET t.${col} = TRUE WHERE ${adminWhere(t)}`);
    }
  }
}

const FLAGS = ['can_view', 'can_add', 'can_edit', 'can_update', 'can_view_all', 'can_delete', 'can_approve', 'can_print', 'can_void'];
async function registerPages() {
  for (const [route, name, source, copyAll] of PAGES) {
    let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [route]);
    if (!page) {
      const [[near]] = await pool.query('SELECT sort_order FROM pages WHERE route = ?', [source]);
      if (DRY_RUN) { console.log(`[dry-run] register page ${route}`); changes += 1; continue; }
      const [r] = await pool.query('INSERT INTO pages (name, route, sort_order, is_active) VALUES (?, ?, ?, TRUE)', [name, route, near?.sort_order ?? 0]);
      page = { id: r.insertId };
      changes += 1;
      console.log(`register page ${route} (id ${page.id})`);
    }
    if (DRY_RUN) continue;
    const [admins] = await pool.query(
      `INSERT INTO user_page_permissions (user_id, page_id, ${FLAGS.join(', ')})
       SELECT u.id, ?, ${FLAGS.map(() => 'TRUE').join(', ')} FROM users u
        WHERE u.account_type = 'System Admin'
          AND NOT EXISTS (SELECT 1 FROM user_page_permissions x WHERE x.user_id = u.id AND x.page_id = ?)`, [page.id, page.id]);
    const cols = copyAll ? FLAGS : ['can_view'];
    const [viewers] = await pool.query(
      `INSERT INTO user_page_permissions (user_id, page_id, ${cols.join(', ')})
       SELECT upp.user_id, ?, ${cols.map((c) => `upp.${c}`).join(', ')} FROM user_page_permissions upp JOIN pages p ON p.id = upp.page_id
        WHERE p.route = ? AND upp.can_view = TRUE
          AND NOT EXISTS (SELECT 1 FROM user_page_permissions x WHERE x.user_id = upp.user_id AND x.page_id = ?)`,
      [page.id, source, page.id]);
    if (admins.affectedRows || viewers.affectedRows) {
      console.log(`  ${route}: ${admins.affectedRows} admin + ${viewers.affectedRows} viewer grant(s) (from ${source})`);
    }
  }
}

(async () => {
  try {
    console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${DRY_RUN ? ' -- DRY RUN, nothing is written' : ''}`);
    // The DDL below names its own foreign keys in dependency order, but an empty CREATE can still
    // reference a table created later in the same list; checks are off only around the CREATEs.
    // One connection for all of it: SET FOREIGN_KEY_CHECKS is per connection, and a pool would run
    // the CREATE on whichever connection is free.
    const conn = await pool.getConnection();
    try {
      if (!DRY_RUN) await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const [t, ddl] of TABLES) {
        if (await tableExists(t)) continue;
        changes += 1;
        console.log(`${DRY_RUN ? '[dry-run] ' : ''}create table ${t}`);
        if (!DRY_RUN) await conn.query(ddl);
      }
    } finally {
      if (!DRY_RUN) await conn.query('SET FOREIGN_KEY_CHECKS = 1');
      conn.release();
    }

    // The tables above take the database's own default collation. One created with another (an
    // earlier run of this script copied GSUITE's utf8mb4_unicode_ci) cannot be joined on a string
    // column to this database's tables -- "Illegal mix of collations" -- so it is converted.
    const [[dbc]] = await pool.query('SELECT DEFAULT_COLLATION_NAME c FROM information_schema.schemata WHERE schema_name = DATABASE()');
    for (const [t] of TABLES) {
      const [[tc]] = await pool.query('SELECT TABLE_COLLATION c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [t]);
      if (!tc || tc.c === dbc.c) continue;
      await run(`convert ${t} from ${tc.c} to ${dbc.c}`, `ALTER TABLE \`${t}\` CONVERT TO CHARACTER SET utf8mb4 COLLATE ${dbc.c}`);
    }

    const added = new Set();
    for (const [t, col, def] of ADD_COLUMNS) {
      if (!(await tableExists(t))) continue;
      if (await colInfo(t, col)) continue;
      await run(`add column ${t}.${col}`, `ALTER TABLE \`${t}\` ADD COLUMN \`${col}\` ${def}`);
      added.add(`${t}.${col}`);
    }

    for (const [t, col, def] of MODIFY_COLUMNS) {
      const cur = await colInfo(t, col);
      if (!cur) continue;
      const wantType = def.split(/ (?:NOT )?NULL/)[0];
      const wantNull = !/ NOT NULL/.test(def);
      if (cur.ty === wantType && (cur.n === 'YES') === wantNull) continue;
      await run(`modify ${t}.${col}: ${cur.ty} ${cur.n === 'YES' ? 'NULL' : 'NOT NULL'} -> ${def}`, `ALTER TABLE \`${t}\` MODIFY \`${col}\` ${def}`);
    }

    for (const [t, name, kind, cols] of INDEXES) {
      if (!(await tableExists(t))) continue;
      if (await indexExists(t, name)) continue;
      await run(`add ${kind.toLowerCase()} ${t}.${name}`, `ALTER TABLE \`${t}\` ADD ${kind} \`${name}\` (${cols})`);
    }

    await seedPermissions(added);

    if (await tableExists('user_supervisors') || DRY_RUN) {
      if (DRY_RUN) console.log('[dry-run] backfill user_supervisors from users.supervisor_id');
      else {
        const [r] = await pool.query(
          `INSERT IGNORE INTO user_supervisors (user_id, supervisor_id)
           SELECT u.id, u.supervisor_id FROM users u JOIN users s ON s.id = u.supervisor_id
            WHERE u.supervisor_id IS NOT NULL AND u.supervisor_id <> u.id`);
        if (r.affectedRows) { changes += 1; console.log(`backfill user_supervisors: ${r.affectedRows} relationship(s)`); }
      }
    }

    await registerPages();

    console.log(`\n${changes} change(s)${DRY_RUN ? ' would be made' : ' made'}.`);
    await pool.end();
  } catch (err) {
    console.error(err);
    await pool.end();
    process.exit(1);
  }
})();
