const express = require('express');
const { scopeFromQuery, resolveScope } = require('../lib/companyScope');
// The company / branch a report is asked for (?companyId= / ?locationId=), resolved to its branches;
// null for the consolidated Wu Ventures view (lib/companyScope.js).
// With neither, the company picked in the topbar switcher (X-Company-Id, lib/requestScope.js) stands.
const { currentScope } = require('../lib/requestScope');
const scopeOf = (req) => {
  const q = scopeFromQuery(req.query);
  return (q.companyId || q.locationId) ? resolveScope(q) : Promise.resolve(currentScope());
};
const headerCompanyId = () => { const sc = currentScope(); return sc && sc.companyId ? sc.companyId : null; };
const ExcelJS = require('exceljs');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { buildTrialBalance, buildBalanceSheet, buildIncomeStatement, buildGeneralLedger, buildGlTransactions, buildBalanceSheetTransactions } = require('../lib/reportsEngine');
const {
  buildArAging, buildArAgingCustomerInvoiceDetails, buildArAgingCustomerLedger,
  buildArAgingDetails, buildArAgingDetailsCsv, searchArCustomers,
  buildArAgingDetailsGroups,
} = require('../lib/arAging');
const {
  buildApAging, buildApAgingSupplierDetails, buildApAgingUnmatchedDetails, collectOpenApItems,
  buildApAgingDetails, buildApAgingDetailsCsv, searchApSuppliers, withoutCreditVendors,
} = require('../lib/apAging');
const {
  arAgingWorkbook, apAgingWorkbook, arAgingDetailsWorkbook, apAgingDetailsWorkbook, sendWorkbook,
} = require('../lib/agingWorkbook');
const { parkedReport } = require('../lib/parkedBankItems');
const { buildCommissionReport, buildCommissionJoDetail, getTeamEmployeeIds, getSbuDivisionIds, withholdConfirmedWithoutPayable } = require('../lib/commissionReport');
const { buildCommissionSummary, commissionSummaryWorkbook } = require('../lib/commissionSummaryWorkbook');
const {
  buildProfitabilityReport, buildProfitabilityCsv, buildProfitabilityLineDetail,
  getProfitabilityScope, searchProfitabilityCustomers,
} = require('../lib/profitabilityReport');
const { resolveDefaultLocation } = require('../lib/userLocation');
const pool = require('../db');
const { getSbuGroups } = require('../lib/sbuGroups');

const router = express.Router();

function today() { return new Date().toISOString().slice(0, 10); }

// Which sales reps the logged-in user may pull a commission report for:
//   - System Admin / back-office (no sales-scoping role) -> everyone ({ all: true }).
//   - Supervisor / Sales Manager / SBU -> their reporting team (own + downline), plus, for an
//     SBU, every rep who sold in a division it owns.
//   - Account Officer / plain Sales -> only themselves.
async function getCommissionScope(userId) {
  const [[u]] = await pool.query(
    `SELECT id, employee_id, account_type, is_account_officer, is_supervisor, is_sales_manager, is_sales_business_unit
       FROM users WHERE id = ? AND is_active = TRUE`,
    [userId]
  );
  if (!u) return { all: false, allowedIds: new Set(), selfOnly: false, selfId: null };
  const selfId = u.employee_id != null ? Number(u.employee_id) : null;
  const isSalesScoped = u.account_type === 'Sales' || u.is_account_officer || u.is_supervisor
    || u.is_sales_manager || u.is_sales_business_unit;
  if (u.account_type === 'System Admin' || !isSalesScoped) return { all: true, allowedIds: null, selfOnly: false, selfId };

  if (u.is_supervisor || u.is_sales_manager || u.is_sales_business_unit) {
    const allowed = new Set(await getTeamEmployeeIds(u.employee_id, u.id));
    if (u.is_sales_business_unit) {
      const divs = await getSbuDivisionIds(u.id);
      if (divs.length) {
        const [reps] = await pool.query(
          'SELECT DISTINCT sales_rep_id FROM sales_orders WHERE sales_division_id IN (?) AND sales_rep_id IS NOT NULL',
          [divs]
        );
        reps.forEach((r) => allowed.add(Number(r.sales_rep_id)));
      }
    }
    return { all: false, allowedIds: allowed, selfOnly: false, selfId };
  }
  // Account officer / plain sales user: only their own report -- no rep picker, just their own.
  return { all: false, allowedIds: new Set(selfId != null ? [selfId] : []), selfOnly: true, selfId };
}

// The commissioned sales reps a given scope may report on (feeds the picker).
async function scopedReps(scope) {
  if (!scope.all && scope.allowedIds.size === 0) return [];
  const scopeClause = scope.all ? '' : 'AND e.id IN (?)';
  const params = scope.all ? [] : [[...scope.allowedIds]];
  const [rows] = await pool.query(
    `SELECT e.id, CONCAT(e.first_name, ' ', e.last_name) AS name
       FROM employees e
       WHERE e.is_active = TRUE AND EXISTS (
         SELECT 1 FROM users u WHERE u.employee_id = e.id AND u.is_active = TRUE
           AND (u.account_type = 'Sales' OR u.is_account_officer OR u.is_supervisor
                OR u.is_sales_manager OR u.is_sales_business_unit))
       ${scopeClause}
       ORDER BY name`,
    params
  );
  return rows;
}

router.get('/trial-balance', requireAuth, requirePermission('/reports/trial-balance', 'can_view'), async (req, res, next) => {
  try {
    res.json(await buildTrialBalance(req.query.asOf || today(), await scopeOf(req)));
  } catch (err) {
    next(err);
  }
});

const VALID_BREAKDOWNS = ['total', 'months', 'location', 'department', 'company'];
router.get('/income-statement', requireAuth, requirePermission('/reports/income-statement', 'can_view'), async (req, res, next) => {
  try {
    const breakdown = VALID_BREAKDOWNS.includes(req.query.breakdown) ? req.query.breakdown : 'total';
    res.json(await buildIncomeStatement(req.query.asOf || today(), req.query.from || null, breakdown, await scopeOf(req)));
  } catch (err) {
    next(err);
  }
});

// Extract: the Income Statement exactly as the screen shows it (same builder, same filters and
// breakdown), as a workbook -- sections, accounts with their child accounts indented, subtotals,
// totals and Net Income; one amount column per breakdown column, kept as numbers.
router.get('/income-statement/export', requireAuth, requirePermission('/reports/income-statement', 'can_view'), async (req, res, next) => {
  try {
    const breakdown = VALID_BREAKDOWNS.includes(req.query.breakdown) ? req.query.breakdown : 'total';
    const r = await buildIncomeStatement(req.query.asOf || today(), req.query.from || null, breakdown, await scopeOf(req));
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Income Statement', { views: [{ state: 'frozen', ySplit: 4 }] });
    const n = r.columns.length;
    // Each breakdown column is an amount and its % -- the percent of that column's total revenue,
    // as the screen shows beside every account (asked 2026-10-26); subtotals, totals and Net Income
    // carry theirs too. Kept as numbers (a fraction shown as %), so they total and sort.
    ws.columns = [{ width: 12 }, { width: 46 }, ...r.columns.flatMap(() => [{ width: 18 }, { width: 10 }])];
    ws.addRow([`Income Statement${r.scope ? ` — ${r.scope.label}` : ''}`]).font = { bold: true, size: 14 };
    ws.addRow([`${r.from_date} to ${r.as_of}`]);
    ws.addRow([]);
    const head = ws.addRow(['Account', '', ...r.columns.flatMap((c) => [c.label, '%'])]);
    head.font = { bold: true };
    for (let i = 0; i < n; i += 1) head.getCell(4 + i * 2).alignment = { horizontal: 'right' };
    const moneyFmt = '#,##0.00;(#,##0.00);-';
    const pctFmt = '0.00%;(0.00%);-';
    const pctOf = (v, i) => (Number(r.revenue_totals[i]) ? (Number(v) || 0) / Number(r.revenue_totals[i]) : 0);
    const amountRow = (values, label, code = '', opts = {}) => {
      const row = ws.addRow([code, label, ...values.flatMap((v, i) => [Number(v) || 0, pctOf(v, i)])]);
      for (let i = 0; i < n; i += 1) {
        row.getCell(3 + i * 2).numFmt = moneyFmt;
        row.getCell(4 + i * 2).numFmt = pctFmt;
      }
      if (opts.bold) row.font = { bold: true };
      if (opts.indent) row.getCell(2).alignment = { indent: opts.indent };
      return row;
    };
    const section = (title) => { const row = ws.addRow([title]); row.font = { bold: true }; row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } }; };
    const writeSections = (sections) => {
      for (const s of sections) {
        const sub = ws.addRow([s.sub_type]); sub.font = { italic: true };
        const account = (a, depth) => {
          amountRow(a.amounts, a.account_name, a.account_code, { indent: depth + 1, bold: depth === 0 && (a.children || []).length > 0 });
          for (const c of (a.children || [])) account(c, depth + 1);
        };
        for (const a of s.accounts) account(a, 0);
        amountRow(s.subtotals, `Total ${s.sub_type}`, '', { bold: true });
      }
    };
    section('REVENUES');
    writeSections(r.revenue_sections);
    amountRow(r.revenue_totals, 'TOTAL REVENUES', '', { bold: true });
    ws.addRow([]);
    section('COST OF GOODS SOLD & EXPENSES');
    writeSections(r.expense_sections);
    amountRow(r.expense_totals, 'TOTAL EXPENSES', '', { bold: true });
    ws.addRow([]);
    amountRow(r.net_income, 'NET INCOME', '', { bold: true });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="income-statement-${r.from_date}-to-${r.as_of}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    if (res.headersSent) { res.destroy(err); return; }
    next(err);
  }
});

// Drill-down behind a Balance Sheet amount: every transaction making up the account's balance as of
// the date (lib/reportsEngine.js buildBalanceSheetTransactions).
router.get('/balance-sheet/transactions', requireAuth, requirePermission('/reports/balance-sheet', 'can_view'), async (req, res, next) => {
  try {
    if (!req.query.accountCode) return res.status(400).json({ error: 'accountCode is required.' });
    res.json(await buildBalanceSheetTransactions({ accountCode: String(req.query.accountCode), asOfDate: req.query.asOf || today(), limit: req.query.all === '1' ? 0 : 1000, scope: await scopeOf(req) }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.get('/balance-sheet', requireAuth, requirePermission('/reports/balance-sheet', 'can_view'), async (req, res, next) => {
  try {
    res.json(await buildBalanceSheet(req.query.asOf || today(), await scopeOf(req)));
  } catch (err) {
    next(err);
  }
});

// The same balance sheet as an Excel file, laid out like the screen: type, sub-type, then each
// account indented under its parent, Debit/Credit by the account's normal side. Amounts are
// numbers with a display format, not text, so the accountant can re-total and tick them.
router.get('/balance-sheet/export', requireAuth, requirePermission('/reports/balance-sheet', 'can_view'), async (req, res, next) => {
  try {
    const asOf = req.query.asOf || today();
    const bs = await buildBalanceSheet(asOf, await scopeOf(req));
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Balance Sheet');
    ws.columns = [
      { header: 'Account Code', key: 'code', width: 16 },
      { header: 'Account Title', key: 'name', width: 52 },
      { header: 'Debit', key: 'debit', width: 18 },
      { header: 'Credit', key: 'credit', width: 18 },
    ];
    ws.spliceRows(1, 0, [`Balance Sheet as of ${asOf}`], []);
    ws.getRow(1).font = { bold: true, size: 14 };
    ws.getRow(3).font = { bold: true };

    const addNode = (node, depth, normal) => {
      const amount = Number(node.amount || 0);
      const row = ws.addRow({
        code: node.account_code,
        name: node.account_name,
        debit: normal === 'DEBIT' && amount ? amount : null,
        credit: normal !== 'DEBIT' && amount ? amount : null,
      });
      row.getCell('code').alignment = { indent: depth * 2 };
      if (node.is_summary) row.font = { bold: true };
      for (const child of node.children || []) addNode(child, depth + 1, normal);
    };
    for (const g of bs.data) {
      const head = ws.addRow({ code: g.type });
      head.font = { bold: true };
      head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
      for (const sub of g.accounts || []) {
        ws.addRow({ code: sub.sub_type }).font = { italic: true };
        for (const node of sub.account_ledgers || []) addNode(node, 1, g.normal);
      }
    }
    ws.addRow({});
    const totals = [
      ['Total Assets', bs.asset_total, null],
      ['Total Liabilities & Equity', null, bs.liability_equity_total],
      ['Current Year Earnings (included above)', null, bs.current_earnings],
    ];
    for (const [label, debit, credit] of totals) ws.addRow({ name: label, debit, credit }).font = { bold: true };
    ws.addRow({ name: bs.balanced ? 'Balanced' : 'OUT OF BALANCE' }).font = { bold: true, color: { argb: bs.balanced ? 'FF15803D' : 'FFB91C1C' } };
    ws.getColumn('debit').numFmt = '#,##0.00;(#,##0.00)';
    ws.getColumn('credit').numFmt = '#,##0.00;(#,##0.00)';
    ws.views = [{ state: 'frozen', ySplit: 3 }];

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="balance-sheet-${asOf}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

// What is still parked in the Deposit / Disbursement accounts waiting to be identified.
//
// Those two carry exclude_from_reports, so no other report totals them -- which is exactly why
// this one has to exist. See lib/parkedBankItems.js. The nightly reminder reads the same
// function, so the report and the notification can never disagree about whether there is
// anything to chase.
router.get('/parked-bank-items', requireAuth, requirePermission('/reports/parked-bank-items', 'can_view'), async (req, res, next) => {
  try {
    res.json(await parkedReport({ accountCode: req.query.account_code || null }));
  } catch (err) {
    next(err);
  }
});

router.get('/general-ledger', requireAuth, requirePermission('/reports/general-ledger', 'can_view'), async (req, res, next) => {
  try {
    res.json(await buildGeneralLedger(req.query.asOf || today(), req.query.from || null, await scopeOf(req)));
  } catch (err) {
    next(err);
  }
});

// Extract (asked 2026-10-26): the General Ledger as on screen with every account expanded -- each
// account's row (code, title, balance), its opening balance in period mode, then its transactions
// (date, transaction #, memo, debit, credit, running balance). Amounts kept as numbers.
const GL_SOURCE_LABELS = {
  sales_invoice: 'Invoice', assembly_build: 'Assembly Build', item_delivery: 'Item Delivery',
  item_fulfillment: 'Item Fulfillment', item_receipt: 'Item Receipt', vendor_bill: 'Vendor Bill',
  inventory_adjustment: 'Inventory Adjustment', bill_credit: 'Bill Credit', receiving_report: 'Receiving Report',
};
router.get('/general-ledger/export', requireAuth, requirePermission('/reports/general-ledger', 'can_view'), async (req, res, next) => {
  try {
    const r = await buildGeneralLedger(req.query.asOf || today(), req.query.from || null, await scopeOf(req));
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('General Ledger', { views: [{ state: 'frozen', ySplit: 4 }] });
    ws.columns = [{ width: 13 }, { width: 14 }, { width: 30 }, { width: 50 }, { width: 16 }, { width: 16 }, { width: 18 }];
    ws.addRow([`General Ledger${r.scope ? ` — ${r.scope.label}` : ''}`]).font = { bold: true, size: 14 };
    ws.addRow([r.from_date ? `${r.from_date} to ${r.as_of}` : `As of ${r.as_of}`]);
    ws.addRow([]);
    const head = ws.addRow(['Account #', 'Date', 'Transaction #', 'Account Title / Memo', 'Debit', 'Credit', 'Balance']);
    head.font = { bold: true };
    const moneyFmt = '#,##0.00;(#,##0.00);-';
    const fmt = (row) => { for (const c of [5, 6, 7]) row.getCell(c).numFmt = moneyFmt; return row; };
    for (const a of r.rows) {
      const acct = fmt(ws.addRow([a.account_code, '', '', a.account_name, null, null, Number(a.balance) || 0]));
      acct.font = { bold: true };
      acct.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
      if (r.from_date) {
        const ob = fmt(ws.addRow(['', '', '', 'Opening balance', null, null, Number(a.opening_balance) || 0]));
        ob.font = { italic: true };
      }
      for (const l of a.ledgers || []) {
        fmt(ws.addRow([
          '', l.entry_date ? String(l.entry_date).slice(0, 10) : '',
          `${GL_SOURCE_LABELS[l.source_type] || l.source_type || ''} ${l.source_no || ''}`.trim(),
          l.memo || '', Number(l.debit) || null, Number(l.credit) || null, Number(l.balance) || 0,
        ]));
      }
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="general-ledger-${r.from_date ? `${r.from_date}-to-` : 'as-of-'}${r.as_of}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    if (res.headersSent) { res.destroy(err); return; }
    next(err);
  }
});

// Drill-down behind an income-statement amount: the transactions for one account, scoped to
// the clicked column (department/location/month) over the report period.
router.get('/income-statement/transactions', requireAuth, requirePermission('/reports/income-statement', 'can_view'), async (req, res, next) => {
  try {
    if (!req.query.accountCode) return res.status(400).json({ error: 'accountCode is required.' });
    res.json(await buildGlTransactions({
      accountCode: req.query.accountCode,
      breakdown: req.query.breakdown || 'total',
      columnKey: req.query.columnKey || 'total',
      asOfDate: req.query.asOf || today(),
      fromDate: req.query.from || null,
      scope: await scopeOf(req),
    }));
  } catch (err) {
    next(err);
  }
});

const AR_AGING_ROUTE = '/reports/ar-aging';

router.get('/ar-aging', requireAuth, requirePermission(AR_AGING_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const filters = {
      locationId: req.query.locationId ? Number(req.query.locationId) : null,
      companyId: Number(req.query.companyId) > 0 ? Number(req.query.companyId) : headerCompanyId(),
      noLocation: req.query.noLocation === 'true' || req.query.noLocation === '1',
      nameStarts: req.query.nameStarts || null,
      // Per Term, per Account Officer, per Customer (2026-10-13; lib/arAging.js).
      term: req.query.term ? String(req.query.term) : null,
      officerId: req.query.officerId ? Number(req.query.officerId) : null,
      customerId: req.query.customerId ? Number(req.query.customerId) : null,
      // Per Sales Group / SBU (2026-10-14; lib/arAging.js). A group wins over an SBU if both come.
      salesGroupId: Number(req.query.salesGroupId) > 0 ? Number(req.query.salesGroupId) : null,
      sbu: req.query.sbu ? String(req.query.sbu) : null,
      // credit=exclude leaves out the customers whose balance is a credit (2026-11-13; lib/arAging.js).
      excludeCredit: req.query.credit === 'exclude',
    };
    const data = await buildArAging(req.query.asOf || today(), filters);
    // ?format=xlsx -- the Extract button: the same rows and totals as a workbook.
    if (req.query.format === 'xlsx') return sendWorkbook(res, arAgingWorkbook(data), `ar-aging-${data.as_of}.xlsx`);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// The filter lists (2026-10-13): the terms and the sales reps (Account Officers) that invoices
// actually carry -- what the report filters on -- and a customer search. Under AR Aging's own
// permission, not Customers' or Employees'.
router.get('/ar-aging/filter-options', requireAuth, requirePermission(AR_AGING_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [terms] = await pool.query(
      `SELECT term AS id, term AS term_name FROM sales_invoices
        WHERE COALESCE(TRIM(term), '') <> '' AND status <> 'cancelled' GROUP BY term ORDER BY term`);
    const [officers] = await pool.query(
      `SELECT e.id, TRIM(CONCAT(COALESCE(e.first_name, ''), ' ', COALESCE(e.last_name, ''))) AS name
         FROM employees e WHERE e.id IN (SELECT DISTINCT sales_rep_id FROM sales_invoices WHERE sales_rep_id IS NOT NULL)
        ORDER BY name`);
    // The sales groups invoices carry, and the SBUs that own them (lib/sbuGroups.js).
    const [salesGroups] = await pool.query(
      `SELECT d.id, d.name FROM departments d
        WHERE d.id IN (SELECT DISTINCT department_id FROM sales_invoices WHERE department_id IS NOT NULL)
        ORDER BY d.name`);
    const sbus = (await getSbuGroups()).map((g) => ({
      id: String(g.index), name: `${g.label} -- ${g.displayName} (${g.departmentNames.join(', ')})`, departmentIds: g.departmentIds,
    }));
    res.json({ terms, officers, salesGroups, sbus });
  } catch (err) { next(err); }
});
router.get('/ar-aging/customers', requireAuth, requirePermission(AR_AGING_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    return res.json(await searchArCustomers(req.query.q));
  } catch (err) { return next(err); }
});

router.get('/ar-aging/customer/:customerId/details', requireAuth, requirePermission(AR_AGING_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const data = await buildArAgingCustomerInvoiceDetails(Number(req.params.customerId), req.query.asOf || today());
    if (!data) return res.status(404).json({ error: 'Customer not found' });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/ar-aging/customer/:customerId/ledger', requireAuth, requirePermission(AR_AGING_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const data = await buildArAgingCustomerLedger(Number(req.params.customerId), req.query.asOf || today());
    if (!data) return res.status(404).json({ error: 'Customer not found' });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ---- Accounting > Reports > AP Aging ----
//
// The payables mirror of AR Aging, on its own permission. `includeUnevidenced` is off unless
// asked for -- see the note at the top of lib/apAging.js for why this report defaults the other
// way to the AR one.
const AP_AGING_ROUTE = '/reports/ap-aging';

function apAgingFilters(query) {
  return {
    locationId: query.locationId && Number(query.locationId) > 0 ? Number(query.locationId) : null,
    companyId: Number(query.companyId) > 0 ? Number(query.companyId) : headerCompanyId(),
    noLocation: query.noLocation === 'true' || query.noLocation === '1',
    nameStarts: query.nameStarts ? String(query.nameStarts).slice(0, 100) : null,
    includeUnevidenced: query.includeUnevidenced === 'true' || query.includeUnevidenced === '1',
    // credit=exclude leaves out the vendors whose balance is a credit (2026-11-13, as on AR Aging).
    excludeCredit: query.credit === 'exclude',
  };
}

router.get('/ap-aging', requireAuth, requirePermission(AP_AGING_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const data = await buildApAging(req.query.asOf || today(), apAgingFilters(req.query));
    if (req.query.format === 'xlsx') return sendWorkbook(res, apAgingWorkbook(data), `ap-aging-${data.as_of}.xlsx`);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// AP Aging Details extract: every open payables item behind AP Aging under the same filters,
// grouped by vendor -- the vendors' Details drill-downs in one workbook.
router.get('/ap-aging/details', requireAuth, requirePermission(AP_AGING_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const asOf = String(req.query.asOf || today()).slice(0, 10);
    const filters = apAgingFilters(req.query);
    const { items: all } = await collectOpenApItems(asOf, filters);
    const items = filters.excludeCredit ? withoutCreditVendors(all) : all;
    const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
    const daysOverdue = (i) => Math.max(Math.floor((asOfMs - Date.parse(`${String(i.aging_date || i.due_date || i.date).slice(0, 10)}T00:00:00Z`)) / 86400000), 0) || 0;
    return sendWorkbook(res, apAgingDetailsWorkbook(items, asOf, daysOverdue), `ap-aging-details-${asOf}.xlsx`);
  } catch (err) {
    return next(err);
  }
});

// A row whose source vendor matched no T1S supplier has no id to open by; it is found by its name.
router.get('/ap-aging/unmatched/details', requireAuth, requirePermission(AP_AGING_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    return res.json(await buildApAgingUnmatchedDetails(String(req.query.name || ''), req.query.asOf || today(), apAgingFilters(req.query)));
  } catch (err) {
    return next(err);
  }
});

router.get('/ap-aging/supplier/:supplierId/details', requireAuth, requirePermission(AP_AGING_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const data = await buildApAgingSupplierDetails(
      Number(req.params.supplierId), req.query.asOf || today(), apAgingFilters(req.query),
    );
    if (!data) return res.status(404).json({ error: 'Vendor not found' });
    return res.json(data);
  } catch (err) {
    return next(err);
  }
});

// ---- Accounting > Reports > AR Aging Details ----
//
// Its own pages row rather than borrowing AR Aging's: a borrowed scope is what produces a 500
// instead of a 403 on an install where the row is missing, and it takes the ability to grant one
// report without the other away from whoever maintains permissions.
const AR_AGING_DETAILS_ROUTE = '/reports/ar-aging-details';

function arAgingDetailsFilters(query) {
  return {
    customerId: query.customerId && Number(query.customerId) > 0 ? Number(query.customerId) : null,
    locationId: query.locationId && Number(query.locationId) > 0 ? Number(query.locationId) : null,
    companyId: Number(query.companyId) > 0 ? Number(query.companyId) : headerCompanyId(),
    noLocation: query.noLocation === 'true' || query.noLocation === '1',
    nameStarts: query.nameStarts ? String(query.nameStarts).slice(0, 100) : null,
    // Per Sales Rep (2026-10-14): each invoice's / credit memo's own rep, as AR Aging's Account Officer.
    officerId: query.salesRepId && Number(query.salesRepId) > 0 ? Number(query.salesRepId) : null,
    salesGroupId: Number(query.salesGroupId) > 0 ? Number(query.salesGroupId) : null,
    sbu: query.sbu ? String(query.sbu) : null,
    page: query.page,
    limit: query.limit,
  };
}

router.get('/ar-aging-details', requireAuth, requirePermission(AR_AGING_DETAILS_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const asOf = req.query.asOf || today();
    const filters = arAgingDetailsFilters(req.query);
    if (req.query.format === 'xlsx') {
      return sendWorkbook(res, arAgingDetailsWorkbook(await buildArAgingDetailsGroups(asOf, filters), asOf), `ar-aging-details-${asOf}.xlsx`);
    }
    if (req.query.format === 'csv') {
      const { csv } = await buildArAgingDetailsCsv(asOf, filters);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="ar-aging-details-${asOf}.csv"`);
      return res.send(csv);
    }
    return res.json(await buildArAgingDetails(asOf, filters));
  } catch (err) {
    return next(err);
  }
});

// The Sales Rep filter's list: the reps invoices actually carry (2026-10-14), under this report's permission.
router.get('/ar-aging-details/sales-reps', requireAuth, requirePermission(AR_AGING_DETAILS_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT e.id, TRIM(CONCAT(COALESCE(e.first_name, ''), ' ', COALESCE(e.last_name, ''))) AS name
         FROM employees e WHERE e.id IN (SELECT DISTINCT sales_rep_id FROM sales_invoices WHERE sales_rep_id IS NOT NULL)
        ORDER BY name`);
    return res.json(rows);
  } catch (err) { return next(err); }
});

router.get('/ar-aging-details/customers', requireAuth, requirePermission(AR_AGING_DETAILS_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    return res.json(await searchArCustomers(req.query.q));
  } catch (err) {
    return next(err);
  }
});

// ---- Accounting > Reports > AP Aging Details (2026-10-09) ----
//
// AR Aging Details' twin for payables: every vendor's open documents, grouped as AP Aging groups
// them and counted by AP Aging's own rules (apAgingFilters), so a vendor's rows add up to its AP
// Aging balance. Its own pages row, for the same reason AR Aging Details has one.
const AP_AGING_DETAILS_ROUTE = '/reports/ap-aging-details';

router.get('/ap-aging-details', requireAuth, requirePermission(AP_AGING_DETAILS_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const asOf = String(req.query.asOf || today()).slice(0, 10);
    const filters = {
      ...apAgingFilters(req.query),
      supplierId: req.query.supplierId && Number(req.query.supplierId) > 0 ? Number(req.query.supplierId) : null,
      page: req.query.page, limit: req.query.limit,
    };
    if (req.query.format === 'xlsx') {
      const { items } = await collectOpenApItems(asOf, filters);
      const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
      const daysOverdue = (i) => Math.max(Math.floor((asOfMs - Date.parse(`${String(i.aging_date || i.due_date || i.date).slice(0, 10)}T00:00:00Z`)) / 86400000), 0) || 0;
      return sendWorkbook(res, apAgingDetailsWorkbook(items, asOf, daysOverdue), `ap-aging-details-${asOf}.xlsx`);
    }
    if (req.query.format === 'csv') {
      const { csv } = await buildApAgingDetailsCsv(asOf, filters);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="ap-aging-details-${asOf}.csv"`);
      return res.send(csv);
    }
    return res.json(await buildApAgingDetails(asOf, filters));
  } catch (err) {
    return next(err);
  }
});

router.get('/ap-aging-details/suppliers', requireAuth, requirePermission(AP_AGING_DETAILS_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    return res.json(await searchApSuppliers(req.query.q));
  } catch (err) {
    return next(err);
  }
});

const COMMISSION_ROUTE = '/commission-report';

// Feeds the report's Sales Rep picker: only employees who are commissioned sales users
// (a Sales account with a role flag that maps to a scheme), so the picker isn't the whole
// 100+ employee list.
router.get('/commission/sales-reps', requireAuth, requirePermission(COMMISSION_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    res.json(await scopedReps(await getCommissionScope(req.user.id)));
  } catch (err) {
    next(err);
  }
});

// Tells the report page how to present itself for the logged-in user: an Account Officer /
// plain sales user reports only on themselves (self_only -> no rep picker, auto-target self);
// everyone else picks from their allowed reps.
router.get('/commission/scope', requireAuth, requirePermission(COMMISSION_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const scope = await getCommissionScope(req.user.id);
    const reps = await scopedReps(scope);
    const self = scope.selfId != null ? reps.find((r) => r.id === scope.selfId) || null : null;
    res.json({ self_only: scope.selfOnly, self, reps });
  } catch (err) {
    next(err);
  }
});

// Commission Summary (2026-10-14; lib/commissionSummaryWorkbook.js): every rep the user may see on
// the Commission report, for a year, grouped into the team's sheets. ?format=xlsx is the Extract.
router.get('/commission/summary', requireAuth, requirePermission(COMMISSION_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const summary = await buildCommissionSummary(year, await getCommissionScope(req.user.id));
    if (req.query.format === 'xlsx') return sendWorkbook(res, commissionSummaryWorkbook(summary, year), `commission-${year}.xlsx`);
    res.json({ year, sheets: summary });
  } catch (err) {
    next(err);
  }
});

router.get('/commission', requireAuth, requirePermission(COMMISSION_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const employeeId = Number(req.query.employeeId);
    if (!employeeId) return res.status(400).json({ error: 'A Sales Rep is required.' });
    const scope = await getCommissionScope(req.user.id);
    if (!scope.all && !scope.allowedIds.has(employeeId)) {
      return res.status(403).json({ error: 'You can only generate commission reports for yourself or your team.' });
    }
    const year = Number(req.query.year) || new Date().getFullYear();
    const filters = { salesDivisionId: req.query.salesDivisionId ? Number(req.query.salesDivisionId) : null };
    const data = await buildCommissionReport(employeeId, year, filters);
    if (!data) return res.status(404).json({ error: 'Sales Rep not found' });
    // No CP for the month -> no Confirmed / Unpaid shown (2026-11-18).
    res.json(withholdConfirmedWithoutPayable(data));
  } catch (err) {
    next(err);
  }
});

// The vouchers behind one month's Released Commission (asked 2026-10-03: click the amount, see the
// vouchers). Released is what the vouchers paid against that month's payable(s), before deductions
// (lib/commissionRelease.js grossReleasedByMonth), so this lists exactly those voucher lines, with
// each voucher's own deductions alongside for information. Same scope rule as the report.
router.get('/commission/released-detail', requireAuth, requirePermission(COMMISSION_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const employeeId = Number(req.query.employeeId);
    if (!employeeId) return res.status(400).json({ error: 'A Sales Rep is required.' });
    const scope = await getCommissionScope(req.user.id);
    if (!scope.all && !scope.allowedIds.has(employeeId)) {
      return res.status(403).json({ error: 'You can only generate commission reports for yourself or your team.' });
    }
    const year = Number(req.query.year) || new Date().getFullYear();
    const month = Number(req.query.month);
    if (!(month >= 1 && month <= 12)) return res.status(400).json({ error: 'Month must be 1-12.' });
    const [lines] = await pool.query(
      `SELECT cv.id AS voucher_id, cv.voucher_no, cv.date_created, cv.total_payments, cv.status,
              cp.id AS payable_id, cp.commission_payable_no, cvl.released_amount,
              (SELECT COALESCE(SUM(-x.amount), 0) FROM commission_voucher_expenses x
                WHERE x.commission_voucher_id = cv.id AND x.amount < 0) AS voucher_deductions
         FROM commission_voucher_lines cvl
         JOIN commission_vouchers cv ON cv.id = cvl.commission_voucher_id
         JOIN commission_payables cp ON cp.id = cvl.commission_payable_id
        WHERE cp.employee_id = ? AND YEAR(cp.period_from) = ? AND MONTH(cp.period_from) = ? AND cv.status <> 'void'
        ORDER BY cv.date_created, cv.id`,
      [employeeId, year, month]);
    const rows = lines.map((l) => ({ ...l, released_amount: Number(l.released_amount), total_payments: Number(l.total_payments), voucher_deductions: Number(l.voucher_deductions) }));
    res.json({ month, year, total: Number(rows.reduce((t, l) => t + l.released_amount, 0).toFixed(2)), rows });
  } catch (err) { next(err); }
});

// Per-JO detail for one rep + month: JO#, GP rate, net of tax, paid invoice, split into
// passing-GP and below-GP.
// Who sees the Unpaid Commission derivation on Commission > JO Detail: System Admin and the
// Accounting account types. Read fresh, like every other account-type rule.
const COMMISSION_WORKING_TYPES = ['System Admin', 'Accounting', 'Accounting Manager', 'Accounting Supervisor'];
async function mayViewCommissionWorking(userId) {
  const [[u]] = await pool.query('SELECT account_type FROM users WHERE id = ?', [userId]);
  return COMMISSION_WORKING_TYPES.includes(u?.account_type);
}

router.get('/commission/jo-detail', requireAuth, requirePermission(COMMISSION_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const employeeId = Number(req.query.employeeId);
    if (!employeeId) return res.status(400).json({ error: 'A Sales Rep is required.' });
    const scope = await getCommissionScope(req.user.id);
    if (!scope.all && !scope.allowedIds.has(employeeId)) {
      return res.status(403).json({ error: 'You can only generate commission reports for yourself or your team.' });
    }
    const year = Number(req.query.year) || new Date().getFullYear();
    const month = Number(req.query.month) || (new Date().getMonth() + 1);
    if (month < 1 || month > 12) return res.status(400).json({ error: 'Month must be 1-12.' });
    const filters = { salesDivisionId: req.query.salesDivisionId ? Number(req.query.salesDivisionId) : null };
    const data = await buildCommissionJoDetail(employeeId, year, month, filters);
    if (!data) return res.status(404).json({ error: 'Sales Rep not found' });
    // The month's row of the Commission report itself, so the detail can show how its Unpaid
    // Commission is derived (Expected -> Confirmed -> Unpaid) with the very figures the report
    // shows, rather than re-adding them here and risking a different answer.
    //
    // ADMINS AND ACCOUNTING ONLY (asked 2026-10-09). The derivation spells out Expected, Confirmed,
    // Released and Unpaid commission; reps and their supervisors see the job orders, not the
    // working. Left out of the response rather than hidden on the page, so it is not merely a
    // view-source away.
    data.month_summary = null;
    if (await mayViewCommissionWorking(req.user.id)) {
      const report = await buildCommissionReport(employeeId, year, filters);
      const row = report?.rows?.find((r) => r.month === month);
      data.month_summary = row ? { ...row, scheme_name: report.scheme_name } : null;
    }
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// Extract on the JO Detail screen: the job orders only, as listed (asked 2026-10-07) -- not the
// Unpaid Commission derivation shown above them. Same scope check as the screen.
router.get('/commission/jo-detail/export', requireAuth, requirePermission(COMMISSION_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const employeeId = Number(req.query.employeeId);
    if (!employeeId) return res.status(400).json({ error: 'A Sales Rep is required.' });
    const scope = await getCommissionScope(req.user.id);
    if (!scope.all && !scope.allowedIds.has(employeeId)) {
      return res.status(403).json({ error: 'You can only generate commission reports for yourself or your team.' });
    }
    const year = Number(req.query.year) || new Date().getFullYear();
    const month = Number(req.query.month) || (new Date().getMonth() + 1);
    if (month < 1 || month > 12) return res.status(400).json({ error: 'Month must be 1-12.' });
    const filters = { salesDivisionId: req.query.salesDivisionId ? Number(req.query.salesDivisionId) : null };
    const data = await buildCommissionJoDetail(employeeId, year, month, filters);
    if (!data) return res.status(404).json({ error: 'Sales Rep not found' });

    const monthName = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('JO Detail', { views: [{ state: 'frozen', ySplit: 3 }] });
    ws.addRow([`Commission — JO Detail: ${data.employee_name}, ${monthName} ${year}`]).font = { bold: true, size: 13 };
    ws.addRow([]);
    const header = ws.addRow(['JO #', 'SO #', 'DT #', 'Invoice #', 'Customer', 'Sales Rep', 'Job Type',
      'GP Rate %', 'Passing GP %', 'Net of Tax', 'Paid Invoice', 'GP Status']);
    header.font = { bold: true };
    header.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } }; });
    for (const r of data.rows) {
      ws.addRow([
        r.job_order_no, r.sales_order_no, r.dt_no || '', r.invoice_no || '', r.customer_name || '', r.rep_name || '', r.job_type || '',
        r.gp_rate, r.passing_gp_rate, r.net_of_tax, r.paid_invoice,
        r.is_passing ? (r.is_approved_low_gp && !r.meets_gp ? 'Passing (added to commission)' : 'Passing') : 'Below GP',
      ]);
    }
    [14, 14, 12, 14, 36, 24, 28, 11, 13, 16, 16, 28].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    [8, 9].forEach((c) => { ws.getColumn(c).numFmt = '0.00'; });
    [10, 11].forEach((c) => { ws.getColumn(c).numFmt = '#,##0.00'; });
    const safe = String(data.employee_name || 'rep').replace(/[^\w.-]+/g, '-');
    return sendWorkbook(res, wb, `commission-jo-detail-${safe}-${year}-${String(month).padStart(2, '0')}.xlsx`);
  } catch (err) {
    next(err);
  }
});

// "Add to Commission" on the JO Detail screen: count this job order toward the rep's
// passing-GP total even though its GP rate is below the job type's threshold.
//
// It sets the same sales_order_lines.is_approved_low_gp flag the estimate-approval path already
// writes, which both the monthly Commission report and the JO Detail read, so an added JO is
// treated as passing everywhere rather than only on the screen it was added from.
//
// Gated on can_approve, not can_edit: this is the low-GP concession that used to require an
// Admin/GM decision, and it moves real money into a rep's commission.
router.post('/commission/jo-detail/add-to-commission', requireAuth, requirePermission(COMMISSION_ROUTE, 'can_approve'), async (req, res, next) => {
  try {
    const lineId = Number(req.body?.sales_order_line_id);
    const include = req.body?.include !== false; // default: add. false takes it back out.
    if (!lineId) return res.status(400).json({ error: 'sales_order_line_id is required.' });

    const [[line]] = await pool.query(
      `SELECT sol.id, sol.is_approved_low_gp, so.status AS so_status,
              jo.id AS jo_id, jo.job_order_no
         FROM sales_order_lines sol
         JOIN sales_orders so ON so.id = sol.sales_order_id
         LEFT JOIN job_orders jo ON jo.sales_order_line_id = sol.id
        WHERE sol.id = ?`, [lineId]
    );
    if (!line) return res.status(404).json({ error: 'Sales order line not found.' });
    // The commission report only ever counts a line that reached a job order, so adding one
    // that has none would look like it worked and change nothing.
    if (!line.jo_id) return res.status(409).json({ error: 'This line has no job order yet, so it cannot be added to commission.' });
    if (line.so_status === 'cancelled') return res.status(409).json({ error: 'A cancelled sales order cannot be added to commission.' });

    await pool.query('UPDATE sales_order_lines SET is_approved_low_gp = ? WHERE id = ?', [include ? 1 : 0, lineId]);
    return res.json({ sales_order_line_id: lineId, job_order_no: line.job_order_no, is_approved_low_gp: include });
  } catch (err) {
    return next(err);
  }
});

// ---- Accounting > Reports > Profitability Report ----
//
// Four endpoints behind one permission: the report itself (with ?format=csv for Download), the
// pickers' contents, the Customer typeahead, and one child row's Details. All on can_view --
// nothing here writes, and the numbers are already visible on the documents they come from.
const PROFITABILITY_ROUTE = '/reports/profitability';

// Parsed once, here, so the lib is handed clean values and the query string cannot reach the SQL
// builder as, say, a page number of "1; DROP".
function profitabilityFilters(query) {
  const id = (v) => (v && Number(v) > 0 ? Number(v) : null);
  return {
    search: query.search ? String(query.search).slice(0, 100) : '',
    salesRepId: id(query.sales_rep_id),
    customerId: id(query.customer_id),
    officeLocationId: id(query.office_location_id),
    salesDivisionId: id(query.sales_division_id),
    dateMode: query.date_mode ? String(query.date_mode) : 'as_of',
    dateFrom: query.date_from ? String(query.date_from).slice(0, 10) : '',
    dateTo: query.date_to ? String(query.date_to).slice(0, 10) : '',
    includeCancelled: query.include_cancelled === 'true' || query.include_cancelled === '1',
    page: query.page,
    limit: query.limit,
  };
}

router.get('/profitability', requireAuth, requirePermission(PROFITABILITY_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const filters = profitabilityFilters(req.query);
    if (req.query.format === 'csv') {
      const { csv, truncated, sales_orders: exported, total } = await buildProfitabilityCsv(req.user.id, filters);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="profitability-report-${today()}.csv"`);
      // Read by the client to warn that the file is not the whole filtered set. A header rather
      // than a row in the CSV, which would corrupt the data for whatever opens it.
      if (truncated) res.setHeader('X-Report-Truncated', `${exported} of ${total}`);
      return res.send(csv);
    }
    return res.json(await buildProfitabilityReport(req.user.id, filters));
  } catch (err) {
    return next(err);
  }
});

router.get('/profitability/scope', requireAuth, requirePermission(PROFITABILITY_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const scope = await getProfitabilityScope(req.user.id);
    // The user's own office, for the location chip in the header and the Office Location filter's
    // opening value -- the real report opens on where you work, not on every branch at once.
    const defaultLocation = await resolveDefaultLocation(req.user.id);
    return res.json({ ...scope, default_location: defaultLocation });
  } catch (err) {
    return next(err);
  }
});

router.get('/profitability/customers', requireAuth, requirePermission(PROFITABILITY_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    return res.json(await searchProfitabilityCustomers(req.query.q));
  } catch (err) {
    return next(err);
  }
});

router.get('/profitability/line/:lineId', requireAuth, requirePermission(PROFITABILITY_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const detail = await buildProfitabilityLineDetail(req.user.id, Number(req.params.lineId));
    // 404 covers both "no such line" and "not yours to see" on purpose: telling an out-of-scope
    // caller that the line exists is itself the leak the sales scope exists to prevent.
    if (!detail) return res.status(404).json({ error: 'That line is not available.' });
    return res.json(detail);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
