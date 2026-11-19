// Brings the Odoo books of Fresh & Tidy and Cuts 4 Tots over into this system -- every posted document,
// with its own ledger lines -- and can be run again and again while Odoo is still in use: each run adds
// only what is new since the last (odoo_links remembers what came over).
//
// READ-ONLY ON ODOO. Only search_read / read / search_count are ever called; nothing is written there.
//
// WHAT COMES OVER, per Odoo company (Fresh & Tidy, Cuts 4 Tots -- never Graphic Star):
//   chart of accounts   every Odoo account code this chart lacks is created, same code / name / type
//   customer invoices   Sales Invoices, one line per product line (items created as needed)
//   vendor bills        standalone Vendor Bills, one expense line per bill line
//   payments            Customer Payments / Bill Payments, applied to the invoices / bills they paid
//   other entries       Journals: bank statement matching, miscellaneous operations, stock valuation
//
// THE LEDGER IS ODOO'S OWN. Each document's Odoo journal items are stored in live_gl_entries, and the
// ledger posts those exact lines for it (lib/glImpact.js glFor), so each company's trial balance here is
// Odoo's -- no re-derivation, no rounding drift. Every line carries a branch: its analytic account's
// (--branch), else the document's, else the company's default (--default), so company and branch
// reports add up.
//
// FRESH & TIDY'S SALES, ONCE. A customer invoice for a branch and day replaces the Z-Reading counter-sales
// Sales Order for the same branch and day (cancelled here, if it is not yet deposited), and is skipped
// when that day was already invoiced here through Import POS Sales.
//
// SETUP. Odoo's address and login come from the environment, never from a file in the repo:
//   ODOO_URL=https://graphicstar.odoo.com  ODOO_DB=nioses-graphicstar-production-22645204
//   ODOO_LOGIN=...  ODOO_PASSWORD=...   (an API key works in place of the password)
//
//   node src/db/import-odoo.js --dry-run                                      what it would do
//   node src/db/import-odoo.js --branch "Casa Mira=Fresh and Tidy Casamira Guadalupe" \
//        --default "Fresh & Tidy=Fresh and Tidy Casamira Guadalupe" ...     do it
// --branch / --default may repeat; --since=YYYY-MM-DD limits a run to documents dated from then on.
require('dotenv').config();
const pool = require('../db');
const { assignDocNo } = require('../lib/docNumber');

const DRY_RUN = process.argv.includes('--dry-run');
const argList = (name) => process.argv.flatMap((a, i, all) => {
  if (a === `--${name}`) return [all[i + 1]];
  if (a.startsWith(`--${name}=`)) return [a.slice(name.length + 3)];
  return [];
}).filter(Boolean);
const SINCE = (argList('since')[0] || '').trim() || null;
const ODOO_COMPANIES = [2, 4]; // Fresh & Tidy, Cuts 4 Tots (1 WU Ventures is empty, 3 is Graphic Star)

const round2 = (n) => Number((Number(n) || 0).toFixed(2));
const norm = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/\b4\b/g, 'for').replace(/[^a-z0-9]/g, '');
const matchKey = (s) => String(s || '').toUpperCase().replace(/\s+/g, '');
const m2o = (v) => (Array.isArray(v) ? v[0] : v || null);

/* ---------------------------------------------- Odoo, read-only ---------------------------------------------- */
const ODOO = { url: process.env.ODOO_URL, db: process.env.ODOO_DB, login: process.env.ODOO_LOGIN, password: process.env.ODOO_PASSWORD };
const READ_ONLY = new Set(['search_count', 'search_read', 'read', 'read_group']);
let odooUid = null;
async function odooRpc(service, method, args) {
  const r = await (await fetch(`${ODOO.url.replace(/\/+$/, '')}/jsonrpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args } }),
  })).json();
  if (r.error) throw new Error(`Odoo: ${r.error.data?.message || r.error.message}`);
  return r.result;
}
async function odoo(model, method, args = [], kwargs = {}) {
  if (!READ_ONLY.has(method)) throw new Error(`refusing to call ${method} on Odoo`);
  if (!odooUid) {
    odooUid = await odooRpc('common', 'authenticate', [ODOO.db, ODOO.login, ODOO.password, {}]);
    if (!odooUid) throw new Error('Odoo login failed -- check ODOO_DB / ODOO_LOGIN / ODOO_PASSWORD.');
  }
  return odooRpc('object', 'execute_kw', [ODOO.db, odooUid, ODOO.password, model, method, args,
    { ...kwargs, context: { allowed_company_ids: [1, 2, 3, 4], ...(kwargs.context || {}) } }]);
}
// search_read in pages, so a large result never comes back as one huge response.
async function odooAll(model, domain, fields, order = 'id asc', companies = null) {
  const out = [];
  for (let offset = 0; ; offset += 500) {
    const page = await odoo(model, 'search_read', [domain], {
      fields, order, limit: 500, offset, ...(companies ? { context: { allowed_company_ids: companies } } : {}),
    });
    out.push(...page);
    if (page.length < 500) return out;
  }
}
async function odooRead(model, ids, fields) {
  const out = [];
  for (let i = 0; i < ids.length; i += 500) out.push(...await odoo(model, 'read', [ids.slice(i, i + 500)], { fields }));
  return out;
}

/* ---------------------------------------------- this database ---------------------------------------------- */
async function ensureLinkTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS odoo_links (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    odoo_model VARCHAR(60) NOT NULL,
    odoo_id BIGINT NOT NULL,
    odoo_name VARCHAR(120) NULL,
    local_type VARCHAR(40) NOT NULL,
    local_id BIGINT NOT NULL,
    odoo_write_date VARCHAR(30) NULL,
    imported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_odoo_links (odoo_model, odoo_id),
    KEY idx_odoo_links_local (local_type, local_id)
  )`);
}
async function linked(model) {
  const [rows] = await pool.query('SELECT odoo_id, local_id, odoo_write_date FROM odoo_links WHERE odoo_model = ?', [model]);
  return new Map(rows.map((r) => [Number(r.odoo_id), r]));
}
async function link(conn, model, odooId, name, localType, localId, writeDate) {
  await conn.query(
    'INSERT INTO odoo_links (odoo_model, odoo_id, odoo_name, local_type, local_id, odoo_write_date) VALUES (?, ?, ?, ?, ?, ?)',
    [model, odooId, name ? String(name).slice(0, 120) : null, localType, localId, writeDate || null]);
}

const ACCOUNT_TYPES = {
  asset_receivable: ['Asset', 'Current Asset'], asset_cash: ['Asset', 'Bank'], asset_current: ['Asset', 'Current Asset'],
  asset_non_current: ['Asset', 'Non-current Asset'], asset_prepayments: ['Asset', 'Current Asset'], asset_fixed: ['Asset', 'Fixed Asset'],
  liability_payable: ['Liability', 'Current Liability'], liability_credit_card: ['Liability', 'Current Liability'],
  liability_current: ['Liability', 'Current Liability'], liability_non_current: ['Liability', 'Non-current Liability'],
  equity: ['Equity', 'Equity'], equity_unaffected: ['Equity', 'Equity'],
  income: ['Revenue', 'Income'], income_other: ['Revenue', 'Other Income'],
  expense: ['Expense', 'Operating Expense'], expense_depreciation: ['Expense', 'Operating Expense'],
  expense_direct_cost: ['Expense', 'Direct Cost'], off_balance: ['Asset', 'Current Asset'],
};

(async () => {
  const report = { created: {}, skipped: [], warnings: [] };
  const bump = (k, n = 1) => { report.created[k] = (report.created[k] || 0) + n; };
  try {
    for (const k of ['url', 'db', 'login', 'password']) if (!ODOO[k]) throw new Error(`Set ODOO_${k.toUpperCase()} in the environment.`);
    console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}  <-  Odoo ${ODOO.url} (${ODOO.db})${DRY_RUN ? '  -- DRY RUN, nothing is written' : ''}${SINCE ? `  since ${SINCE}` : ''}`);
    await ensureLinkTable();
    const [[admin]] = await pool.query("SELECT id FROM users WHERE account_type = 'System Admin' ORDER BY id LIMIT 1");
    const userId = admin ? admin.id : null;

    /* ---- companies and branches ---- */
    const oCompanies = await odoo('res.company', 'search_read', [[['id', 'in', ODOO_COMPANIES]]], { fields: ['name'] });
    const [locCompanies] = await pool.query('SELECT id, name FROM companies');
    const [locations] = await pool.query('SELECT id, location_name, company_id FROM locations');
    const companyOf = new Map(); // odoo company id -> local company
    for (const oc of oCompanies) {
      const lc = locCompanies.find((c) => norm(c.name) === norm(oc.name) || norm(c.name).includes(norm(oc.name)) || norm(oc.name).includes(norm(c.name)));
      if (!lc) throw new Error(`No company here matches Odoo's "${oc.name}" -- add it under Lookups > Companies.`);
      companyOf.set(oc.id, { ...lc, odoo_name: oc.name });
    }
    const branchArgs = new Map(argList('branch').map((s) => s.split('=').map((x) => x.trim())));
    const defaultArgs = new Map(argList('default').map((s) => s.split('=').map((x) => x.trim())));
    const findLocation = (name) => locations.find((l) => norm(l.location_name) === norm(name));
    const analytics = await odoo('account.analytic.account', 'search_read', [[['company_id', 'in', ODOO_COMPANIES]]], { fields: ['name', 'company_id'] });
    const branchOf = new Map(); // analytic id -> location id
    console.log('\nBranches (Odoo analytic account -> location here):');
    for (const a of analytics) {
      const co = companyOf.get(m2o(a.company_id));
      let loc = null;
      if (branchArgs.has(a.name)) {
        loc = findLocation(branchArgs.get(a.name));
        if (!loc) report.warnings.push(`--branch "${a.name}=${branchArgs.get(a.name)}": no location is named that.`);
      } else {
        const cands = locations.filter((l) => (!co || !l.company_id || Number(l.company_id) === Number(co.id)) && norm(l.location_name).includes(norm(a.name)));
        if (cands.length === 1) [loc] = cands;
      }
      if (loc && co && loc.company_id && Number(loc.company_id) !== Number(co.id)) report.warnings.push(`${loc.location_name} belongs to another company than ${co.name}.`);
      if (loc) branchOf.set(a.id, loc.id);
      console.log(`  ${a.name} [${a.company_id && a.company_id[1]}] -> ${loc ? loc.location_name : 'NOT MAPPED -- give --branch "' + a.name + '=<location>"'}`);
    }
    const defaultBranch = new Map(); // odoo company id -> location id
    for (const [oid, co] of companyOf) {
      const arg = defaultArgs.get(co.odoo_name) || defaultArgs.get(co.name);
      const loc = arg ? findLocation(arg) : null;
      if (arg && !loc) report.warnings.push(`--default "${co.odoo_name}=${arg}": no location is named that.`);
      if (loc) defaultBranch.set(oid, loc.id);
      console.log(`  default for ${co.odoo_name} (lines with no analytic: bank, receivable, payable) -> ${loc ? loc.location_name : 'NOT SET -- give --default "' + co.odoo_name + '=<location>"'}`);
    }
    const unmapped = analytics.filter((a) => !branchOf.has(a.id)).length + [...companyOf.keys()].filter((k) => !defaultBranch.has(k)).length;
    if (unmapped && !DRY_RUN) throw new Error('Every analytic account and every company default needs a branch here -- see the list above.');

    /* ---- chart of accounts ---- */
    // An Odoo 18 account's code is per company -- read as another company it comes back blank -- so the
    // chart is read once per company, in that company's own context, and accounts are matched by
    // (company, account).
    const oAccounts = [];
    for (const c of ODOO_COMPANIES) {
      const rows = await odooAll('account.account', [['company_ids', 'in', [c]]], ['code', 'name', 'account_type'], 'id asc', [c]);
      oAccounts.push(...rows.filter((a) => a.code).map((a) => ({ ...a, company: c })));
    }
    // A new account must name its Chart of Account Type, or the Trial Balance and the statements leave
    // it out (lib/reportsEngine.js loadCoa) -- 'Revenue' / 'Expense' here are INCOME / EXPENSE there.
    const [coaTypes] = await pool.query('SELECT id, account_type, account_sub_type FROM chart_of_account_types');
    const TYPE_NAME = { asset: 'ASSET', liability: 'LIABILITY', equity: 'EQUITY', revenue: 'INCOME', expense: 'EXPENSE' };
    const coaTypeId = (type, detail) => {
      const t = TYPE_NAME[String(type).toLowerCase()];
      const hit = coaTypes.find((x) => x.account_type === t && String(x.account_sub_type).toLowerCase() === String(detail).toLowerCase())
        || coaTypes.find((x) => x.account_type === t);
      return hit ? hit.id : null;
    };
    const [coa] = await pool.query('SELECT id, account_code, account_name FROM chart_of_accounts');
    const acctByCode = new Map(coa.map((a) => [String(a.account_code), a]));
    const accountOfCo = new Map(); // `${odoo company}:${odoo account id}` -> local account
    const newAccounts = [];
    for (const a of oAccounts) {
      let local = acctByCode.get(String(a.code));
      if (!local) {
        const [type, detail] = ACCOUNT_TYPES[a.account_type] || ['Asset', null];
        newAccounts.push(`${a.code} ${a.name} (${type})`);
        if (!DRY_RUN) {
          const [r] = await pool.query(
            'INSERT INTO chart_of_accounts (account_code, account_name, account_type, detail_type, coa_type_id, is_active, is_summary, description) VALUES (?, ?, ?, ?, ?, 1, 0, ?)',
            [a.code, a.name, type, detail, coaTypeId(type, detail), `From Odoo (${a.account_type})`]);
          local = { id: r.insertId, account_code: a.code, account_name: a.name };
        } else local = { id: null, account_code: a.code, account_name: a.name };
        acctByCode.set(String(a.code), local);
      }
      accountOfCo.set(`${a.company}:${a.id}`, local);
    }
    // The local account for an Odoo journal item, in its own company.
    const acctFor = (l, move) => accountOfCo.get(`${m2o(move.company_id)}:${m2o(l.account_id)}`);
    console.log(`\nChart: ${oAccounts.length} Odoo accounts, ${newAccounts.length} ${DRY_RUN ? 'would be' : ''} created here${newAccounts.length ? ':' : '.'}`);
    if (newAccounts.length) console.log(`  ${newAccounts.slice(0, 40).join(' | ')}${newAccounts.length > 40 ? ` | ... ${newAccounts.length - 40} more` : ''}`);
    bump('accounts', DRY_RUN ? 0 : newAccounts.length);

    /* ---- the documents ---- */
    const dateDom = SINCE ? [['date', '>=', SINCE]] : [];
    const moves = await odooAll('account.move',
      [['company_id', 'in', ODOO_COMPANIES], ['state', '=', 'posted'], ...dateDom],
      ['name', 'date', 'invoice_date', 'invoice_date_due', 'ref', 'move_type', 'company_id', 'partner_id', 'journal_id',
        'amount_untaxed', 'amount_tax', 'amount_total', 'amount_residual', 'origin_payment_id', 'statement_line_id', 'write_date', 'line_ids'],
      'date asc, id asc');
    const allLineIds = moves.flatMap((m) => m.line_ids);
    const lines = await odooRead('account.move.line', allLineIds,
      ['move_id', 'display_type', 'product_id', 'name', 'account_id', 'partner_id', 'quantity', 'price_unit', 'discount',
        'price_subtotal', 'price_total', 'debit', 'credit', 'analytic_distribution', 'product_uom_id', 'tax_line_id']);
    const linesOf = new Map();
    for (const l of lines) { const k = m2o(l.move_id); if (!linesOf.has(k)) linesOf.set(k, []); linesOf.get(k).push(l); }
    const payments = await odooAll('account.payment',
      [['company_id', 'in', ODOO_COMPANIES], ['state', 'not in', ['draft', 'canceled', 'cancel']], ...dateDom],
      ['name', 'date', 'amount', 'payment_type', 'partner_type', 'partner_id', 'journal_id', 'move_id', 'memo', 'payment_method_line_id',
        'reconciled_invoice_ids', 'reconciled_bill_ids', 'company_id', 'write_date']);
    const paymentByMove = new Map(payments.filter((p) => p.move_id).map((p) => [m2o(p.move_id), p]));
    console.log(`\nOdoo: ${moves.length} posted entries (${payments.length} payments), ${lines.length} journal items.`);

    const done = {
      move: await linked('account.move'), payment: await linked('account.payment'),
    };
    const changed = [...moves.filter((m) => done.move.has(m.id) && done.move.get(m.id).odoo_write_date && done.move.get(m.id).odoo_write_date !== m.write_date),
      ...payments.filter((p) => done.payment.has(p.id) && done.payment.get(p.id).odoo_write_date && done.payment.get(p.id).odoo_write_date !== p.write_date)];
    if (changed.length) report.warnings.push(`${changed.length} document(s) already brought over were changed in Odoo since (not re-imported): ${changed.slice(0, 10).map((c) => c.name).join(', ')}${changed.length > 10 ? ' ...' : ''}`);

    // Branch of a journal item / a document.
    const analyticBranch = (dist) => {
      if (!dist) return null;
      const ids = Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k]) => Number(String(k).split(',')[0]));
      for (const id of ids) if (branchOf.has(id)) return branchOf.get(id);
      return null;
    };
    const docBranch = (move) => {
      for (const l of linesOf.get(move.id) || []) { const b = analyticBranch(l.analytic_distribution); if (b) return b; }
      return defaultBranch.get(m2o(move.company_id)) || null;
    };
    const lineBranch = (l, move) => analyticBranch(l.analytic_distribution) || docBranch(move);

    // Partners -> customers / suppliers, matched by name, created when missing.
    const [custs] = await pool.query('SELECT id, name FROM customers');
    const [supps] = await pool.query('SELECT id, name FROM suppliers');
    const custByName = new Map(custs.map((c) => [norm(c.name), c.id]));
    const suppByName = new Map(supps.map((s) => [norm(s.name), s.id]));
    async function party(conn, kind, partner) {
      const name = Array.isArray(partner) ? partner[1] : 'Unknown (from Odoo)';
      const map = kind === 'customer' ? custByName : suppByName;
      if (map.has(norm(name))) return map.get(norm(name));
      bump(kind === 'customer' ? 'customers' : 'suppliers');
      if (DRY_RUN) { map.set(norm(name), null); return null; }
      const [r] = kind === 'customer'
        ? await conn.query('INSERT INTO customers (name, is_active, source) VALUES (?, 1, ?)', [name, 'Odoo'])
        : await conn.query('INSERT INTO suppliers (name, is_active) VALUES (?, 1)', [name]);
      map.set(norm(name), r.insertId);
      return r.insertId;
    }
    // Products -> items, matched by name (spaces ignored), created when missing.
    const [items] = await pool.query('SELECT id, display_name, item_code FROM inventories');
    const itemByKey = new Map();
    for (const i of items) for (const k of [matchKey(i.display_name), matchKey(i.item_code)]) if (k && !itemByKey.has(k)) itemByKey.set(k, i.id);
    const [[pcUnit]] = await pool.query("SELECT id FROM units_of_measure WHERE code IN ('PC', 'PCS') ORDER BY code LIMIT 1");
    const productInfo = new Map();
    const productIds = [...new Set(lines.map((l) => m2o(l.product_id)).filter(Boolean))];
    for (const p of await odooRead('product.product', productIds, ['name', 'default_code', 'type', 'is_storable'])) productInfo.set(p.id, p);
    async function item(conn, productId, incomeAccountId) {
      const p = productInfo.get(productId);
      if (!p) return null;
      const key = matchKey(p.name);
      if (itemByKey.has(key)) return itemByKey.get(key);
      bump('items');
      if (DRY_RUN || !pcUnit) { itemByKey.set(key, null); return null; }
      const type = p.is_storable ? 'Inventory' : 'Service';
      const code = `ODOO-${(p.default_code || p.name).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`.slice(0, 90);
      const [[dup]] = await conn.query('SELECT id FROM inventories WHERE item_code = ?', [code]);
      const [r] = await conn.query(
        `INSERT INTO inventories (item_code, display_name, sales_description, base_unit_id, item_type, is_active, income_account_id, is_costing_approved, is_accounting_approved)
         VALUES (?, ?, 'From Odoo', ?, ?, 1, ?, FALSE, FALSE)`, [dup ? `${code}-${productId}` : code, p.name, pcUnit.id, type, incomeAccountId || null]);
      itemByKey.set(key, r.insertId);
      return r.insertId;
    }
    // A document's journal items -> live_gl_entries, so the ledger posts Odoo's own lines.
    async function storeGl(conn, move, sourceType, sourceId, sourceNo) {
      for (const l of linesOf.get(move.id) || []) {
        if (!Number(l.debit) && !Number(l.credit)) continue;
        const acct = acctFor(l, move);
        await conn.query(
          `INSERT INTO live_gl_entries (live_pk, live_trans_pk, source_type, source_no, source_id, entry_module, account_id, account_code, account_name,
                                        debit, credit, entry_date, location_id, memo)
           VALUES (?, ?, ?, ?, ?, 'odoo', ?, ?, ?, ?, ?, ?, ?, ?)`,
          [`odoo:aml:${l.id}`, `odoo:move:${move.id}`, sourceType, sourceNo, sourceId, acct ? acct.id : null,
            acct ? acct.account_code : null, acct ? acct.account_name : null, round2(l.debit), round2(l.credit), move.date,
            lineBranch(l, move), String(l.name || move.name || '').slice(0, 500)]);
      }
    }
    const localOfMove = new Map([...done.move].map(([k, v]) => [k, v.local_id]));

    // One document per transaction, so a failure leaves nothing half-written; the run carries on.
    async function inTx(label, fn) {
      if (DRY_RUN) return fn(pool);
      const conn = await pool.getConnection();
      try { await conn.beginTransaction(); const r = await fn(conn); await conn.commit(); return r; } catch (e) {
        await conn.rollback().catch(() => {});
        report.skipped.push(`${label}: ${e.message}`);
        return null;
      } finally { conn.release(); }
    }

    /* customer invoices */
    for (const m of moves.filter((x) => x.move_type === 'out_invoice' && !done.move.has(x.id))) {
      const branch = docBranch(m);
      const [[pos]] = await pool.query("SELECT invoice_no FROM sales_invoices WHERE pos_import_key IS NOT NULL AND office_location_id = ? AND date_created = ? AND status <> 'cancelled' LIMIT 1", [branch, m.invoice_date || m.date]);
      if (pos) { report.skipped.push(`${m.name}: ${m.invoice_date} already invoiced here as ${pos.invoice_no} (Import POS Sales)`); continue; }
      const [sos] = await pool.query(
        "SELECT id, sales_order_no, status, deposit_id FROM sales_orders WHERE sales_layout = 'daily_collections' AND office_location_id = ? AND date_created = ? AND status <> 'cancelled'",
        [branch, m.invoice_date || m.date]);
      await inTx(m.name, async (conn) => {
        const customerId = await party(conn, 'customer', m.partner_id);
        const prodLines = (linesOf.get(m.id) || []).filter((l) => l.display_type === 'product');
        for (const so of sos) {
          if (so.deposit_id || so.status === 'deposited') { report.warnings.push(`${m.name}: counter-sales ${so.sales_order_no} for the same day is already deposited -- cancel it by hand if it double-counts.`); continue; }
          bump('sales orders cancelled (replaced by Odoo invoices)');
          if (!DRY_RUN) await conn.query("UPDATE sales_orders SET status = 'cancelled' WHERE id = ?", [so.id]);
        }
        bump('sales invoices');
        if (DRY_RUN) return;
        const residual = round2(m.amount_residual);
        const [r] = await conn.query(
          `INSERT INTO sales_invoices (invoice_no, invoice_type, customer_id, date_created, date_due, office_location_id, bs_si_no, memo,
                                       withholding_tax_pct, subtotal, discount_amount, net_of_tax, ewt_amount, tax_amount, gross_amount, amount_due, status, created_by_user_id)
           VALUES ('', 'SI', ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, 0, ?, ?, ?, ?, ?)`,
          [customerId, m.invoice_date || m.date, m.invoice_date_due || m.date, branch, m.name, `Odoo ${m.name}${m.ref ? ` -- ${m.ref}` : ''}`,
            round2(m.amount_untaxed), round2(m.amount_untaxed), round2(m.amount_tax), round2(m.amount_total), residual,
            residual <= 0.005 ? 'paid_in_full' : 'saved', userId]);
        const no = await assignDocNo(conn, { table: 'sales_invoices', column: 'invoice_no', prefix: 'INV-', id: r.insertId });
        for (const l of prodLines) {
          const itemId = await item(conn, m2o(l.product_id), acctFor(l, m)?.id);
          const net = round2(l.price_subtotal);
          await conn.query(
            `INSERT INTO sales_invoice_lines (sales_invoice_id, item_id, description, quantity, units, price_per_unit, subtotal, disc_percent, disc_amount,
                                              disc_price_per_unit, net_of_tax, tax_code, tax_amount, gross_amount)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?)`,
            [r.insertId, itemId, String(l.name || '').slice(0, 500), l.quantity, l.product_uom_id ? String(l.product_uom_id[1]).slice(0, 40) : null,
              l.price_unit, net, l.discount || 0, l.quantity ? Number((net / l.quantity).toFixed(4)) : null, net, round2(l.price_total - l.price_subtotal), round2(l.price_total)]);
        }
        await storeGl(conn, m, 'sales_invoice', r.insertId, no);
        await link(conn, 'account.move', m.id, m.name, 'sales_invoice', r.insertId, m.write_date);
        localOfMove.set(m.id, r.insertId);
      });
    }
    for (const m of moves.filter((x) => ['out_refund', 'in_refund'].includes(x.move_type) && !done.move.has(x.id))) {
      report.skipped.push(`${m.name}: ${m.move_type === 'out_refund' ? 'credit note' : 'vendor refund'} -- not brought over; enter it by hand.`);
    }

    /* vendor bills */
    for (const m of moves.filter((x) => x.move_type === 'in_invoice' && !done.move.has(x.id))) {
      await inTx(m.name, async (conn) => {
        const supplierId = await party(conn, 'supplier', m.partner_id);
        bump('vendor bills');
        if (DRY_RUN) return;
        const all = linesOf.get(m.id) || [];
        const payable = all.find((l) => l.display_type === 'payment_term');
        const wtax = round2(all.filter((l) => l.display_type === 'tax' && Number(l.credit) > 0).reduce((t, l) => t + Number(l.credit), 0));
        const vat = round2(all.filter((l) => l.display_type === 'tax' && Number(l.debit) > 0).reduce((t, l) => t + Number(l.debit), 0));
        const residual = round2(m.amount_residual);
        const branch = docBranch(m);
        const [r] = await conn.query(
          `INSERT INTO vendor_bills (bill_no, supplier_id, date_created, date_due, reference_no, account_id, office_location_id, memo,
                                     subtotal, discount_amount, net_of_tax, tax_amount, gross_amount, wtax_amount, amount_due, status, created_by_user_id)
           VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
          [supplierId, m.invoice_date || m.date, m.invoice_date_due || m.date, m.ref ? String(m.ref).slice(0, 100) : null,
            payable ? acctFor(payable, m)?.id : null, branch, `Odoo ${m.name}`,
            round2(m.amount_untaxed), round2(m.amount_untaxed), vat, round2(Number(m.amount_untaxed) + vat), wtax, residual,
            residual <= 0.005 ? 'paid_in_full' : 'open', userId]);
        const no = await assignDocNo(conn, { table: 'vendor_bills', column: 'bill_no', prefix: 'VB-', id: r.insertId });
        for (const l of all.filter((x) => x.display_type === 'product')) {
          const net = round2(l.price_subtotal);
          await conn.query(
            `INSERT INTO vendor_bill_lines (vendor_bill_id, account_id, description, location_id, qty, rate, unit_price, net_of_tax, tax_amount, ext_price)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [r.insertId, acctFor(l, m)?.id || null, String(l.name || '').slice(0, 500), lineBranch(l, m),
              l.quantity || 1, l.price_unit, l.price_unit, net, round2(l.price_total - l.price_subtotal), round2(l.price_total)]);
        }
        await storeGl(conn, m, 'vendor_bill', r.insertId, no);
        await link(conn, 'account.move', m.id, m.name, 'vendor_bill', r.insertId, m.write_date);
        localOfMove.set(m.id, r.insertId);
      });
    }

    /* payments */
    const [methods] = await pool.query('SELECT id, name FROM payment_methods');
    const methodId = (label) => {
      const t = String(label || '').toUpperCase();
      const pick = /CHECK|CHEQUE/.test(t) ? 'CHECK' : /GCASH/.test(t) ? 'GCASH' : /CASH/.test(t) ? 'CASH' : 'BANK TRANSFER';
      return (methods.find((x) => x.name === pick) || methods[0] || {}).id || null;
    };
    for (const p of payments.filter((x) => !done.payment.has(x.id))) {
      const move = moves.find((m) => m.id === m2o(p.move_id));
      if (!move) { report.skipped.push(`${p.name}: its journal entry is not posted / not in range`); continue; }
      const pl = linesOf.get(move.id) || [];
      const inbound = p.payment_type === 'inbound';
      await inTx(p.name, async (conn) => {
        const partyId = await party(conn, inbound ? 'customer' : 'supplier', p.partner_id);
        bump(inbound ? 'customer payments' : 'bill payments');
        if (DRY_RUN) return;
        const amount = round2(p.amount);
        const branch = docBranch(move);
        // The cash side (Outstanding Receipts / Payments) and the party side (receivable / payable).
        const cashLine = pl.find((l) => (inbound ? Number(l.debit) : Number(l.credit)) > 0 && !/receivable|payable/i.test(l.account_id[1]))
          || pl.find((l) => (inbound ? Number(l.debit) : Number(l.credit)) > 0);
        const partyLine = pl.find((l) => l !== cashLine && (inbound ? Number(l.credit) : Number(l.debit)) > 0);
        const docs = (inbound ? p.reconciled_invoice_ids : p.reconciled_bill_ids).map((id) => localOfMove.get(id)).filter(Boolean);
        let left = amount;
        const applied = [];
        for (const docId of docs) {
          if (left <= 0) break;
          const [[d]] = inbound
            ? await conn.query('SELECT gross_amount total FROM sales_invoices WHERE id = ?', [docId])
            : await conn.query('SELECT gross_amount - COALESCE(wtax_amount, 0) total FROM vendor_bills WHERE id = ?', [docId]);
          const [[already]] = inbound
            ? await conn.query('SELECT COALESCE(SUM(applied_amount), 0) s FROM customer_payment_lines WHERE sales_invoice_id = ?', [docId])
            : await conn.query('SELECT COALESCE(SUM(applied_amount), 0) s FROM bill_payment_lines WHERE vendor_bill_id = ?', [docId]);
          const a = round2(Math.min(left, Number(d.total) - Number(already.s)));
          if (a > 0) { applied.push([docId, a]); left = round2(left - a); }
        }
        let localId; let no;
        if (inbound) {
          const [r] = await conn.query(
            `INSERT INTO customer_payments (customer_payment_no, date_created, customer_id, office_location_id, receipt_type, or_no, payment_type,
                                            issued_by_user_id, payment_method_id, payment_amount, applied_amount, unapplied_amount, memo,
                                            created_by_user_id, reference_no, deposit_account_id, status)
             VALUES ('', ?, ?, ?, 'Official Receipt', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'deposited')`,
            [p.date, partyId, branch, p.name.slice(0, 60), left > 0 ? 'Partial Payment' : 'Full Payment', userId,
              methodId(p.payment_method_line_id && p.payment_method_line_id[1]), amount, round2(amount - left), left,
              `Odoo ${p.name}${p.memo ? ` -- ${p.memo}` : ''}`.slice(0, 1000), userId, p.memo ? String(p.memo).slice(0, 100) : null,
              cashLine ? acctFor(cashLine, move)?.id : null]);
          localId = r.insertId;
          no = await assignDocNo(conn, { table: 'customer_payments', column: 'customer_payment_no', prefix: 'CPAY-', id: localId });
          for (const [docId, a] of applied) await conn.query('INSERT INTO customer_payment_lines (customer_payment_id, sales_invoice_id, applied_amount) VALUES (?, ?, ?)', [localId, docId, a]);
        } else {
          const [r] = await conn.query(
            `INSERT INTO bill_payments (bill_payment_no, date_created, supplier_id, payee_name, office_location_id, ap_account_id, bank_account_id,
                                        payment_method_id, reference_no, memo, total_amount, status, created_by_user_id)
             VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
            [p.date, partyId, Array.isArray(p.partner_id) ? p.partner_id[1] : null, branch,
              partyLine ? acctFor(partyLine, move)?.id : null, cashLine ? acctFor(cashLine, move)?.id : null,
              methodId(p.payment_method_line_id && p.payment_method_line_id[1]), p.memo ? String(p.memo).slice(0, 100) : null,
              `Odoo ${p.name}`, amount, userId]);
          localId = r.insertId;
          no = await assignDocNo(conn, { table: 'bill_payments', column: 'bill_payment_no', prefix: 'BPAY-', id: localId });
          for (const [docId, a] of applied) await conn.query('INSERT INTO bill_payment_lines (bill_payment_id, vendor_bill_id, applied_amount) VALUES (?, ?, ?)', [localId, docId, a]);
        }
        await storeGl(conn, move, inbound ? 'customer_payment' : 'bill_payment', localId, no);
        await link(conn, 'account.payment', p.id, p.name, inbound ? 'customer_payment' : 'bill_payment', localId, p.write_date);
        await link(conn, 'account.move', move.id, move.name, inbound ? 'customer_payment' : 'bill_payment', localId, move.write_date);
      });
    }

    /* every other entry: bank statement matching, miscellaneous, stock valuation */
    const paymentMoves = new Set(payments.map((p) => m2o(p.move_id)));
    for (const m of moves.filter((x) => x.move_type === 'entry' && !paymentMoves.has(x.id) && !done.move.has(x.id))) {
      await inTx(m.name, async (conn) => {
        bump('journals');
        if (DRY_RUN) return;
        const all = (linesOf.get(m.id) || []).filter((l) => Number(l.debit) || Number(l.credit));
        const dr = round2(all.reduce((t, l) => t + Number(l.debit), 0));
        const cr = round2(all.reduce((t, l) => t + Number(l.credit), 0));
        const [r] = await conn.query(
          `INSERT INTO journals (journal_no, date_created, location_id, memo, status, total_debit, total_credit, created_by_user_id)
           VALUES ('', ?, ?, ?, 'SAVED', ?, ?, ?)`,
          [m.date, docBranch(m), `Odoo ${m.name} (${m.journal_id ? m.journal_id[1] : ''})${m.ref ? ` -- ${m.ref}` : ''}`.slice(0, 1000), dr, cr, userId]);
        const no = await assignDocNo(conn, { table: 'journals', column: 'journal_no', prefix: 'JRNL-', id: r.insertId });
        let n = 0;
        for (const l of all) {
          n += 1;
          await conn.query(
            `INSERT INTO journal_lines (journal_id, line_no, account_id, party_name, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [r.insertId, n, acctFor(l, m)?.id || null, Array.isArray(l.partner_id) ? l.partner_id[1].slice(0, 150) : null,
              round2(l.debit), round2(l.credit), String(l.name || '').slice(0, 500)]);
        }
        await storeGl(conn, m, 'journal', r.insertId, no);
        await link(conn, 'account.move', m.id, m.name, 'journal', r.insertId, m.write_date);
      });
    }

    /* check: what came over adds up to Odoo, account by account, per company */
    if (!DRY_RUN) {
      for (const oc of ODOO_COMPANIES) {
        const odooTb = await odoo('account.move.line', 'read_group',
          [[['company_id', '=', oc], ['parent_state', '=', 'posted'], ...dateDom], ['account_id', 'balance:sum'], ['account_id']], { lazy: false });
        const [here] = await pool.query(
          `SELECT g.account_code, ROUND(SUM(g.debit - g.credit), 2) bal FROM live_gl_entries g
            JOIN odoo_links k ON k.local_type = g.source_type AND k.local_id = g.source_id AND k.odoo_model = 'account.move'
           WHERE g.entry_module = 'odoo' AND g.live_trans_pk = CONCAT('odoo:move:', k.odoo_id)
             AND k.odoo_id IN (?) GROUP BY g.account_code`, [moves.filter((m) => m2o(m.company_id) === oc).map((m) => m.id).concat([0])]);
        const hereBy = new Map(here.map((r) => [String(r.account_code), Number(r.bal)]));
        const diffs = odooTb.map((g) => {
          const code = accountOfCo.get(`${oc}:${m2o(g.account_id)}`)?.account_code;
          return [code, round2(g.balance), round2(hereBy.get(String(code)) || 0)];
        }).filter(([, a, b]) => Math.abs(a - b) > 0.01);
        console.log(`\nCheck ${companyOf.get(oc)?.odoo_name}: ${odooTb.length} accounts compared, ${diffs.length} differ${diffs.length ? ':' : ' -- the books match Odoo.'}`);
        diffs.slice(0, 20).forEach(([c, a, b]) => console.log(`  ${c}: Odoo ${a}  here ${b}`));
      }
    }

    console.log(`\n${DRY_RUN ? 'Would bring over' : 'Brought over'}:`, JSON.stringify(report.created));
    if (report.skipped.length) { console.log(`Skipped (${report.skipped.length}):`); report.skipped.slice(0, 50).forEach((s) => console.log(`  ${s}`)); }
    if (report.warnings.length) { console.log('Warnings:'); report.warnings.forEach((w) => console.log(`  ${w}`)); }
    await pool.end();
  } catch (err) {
    console.error(err.message || err);
    await pool.end();
    process.exit(1);
  }
})();
