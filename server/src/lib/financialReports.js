// Accounting reports in the shape and flow of Odoo's (Accounting > Reporting), all on one engine.
//
//   Statement Reports  Balance Sheet, Profit and Loss, Cash Flow Statement, Executive Summary
//   Audit Reports      General Ledger, Trial Balance, Journal Audit, Check Register
//   Partner Reports    Partner Ledger, Aged Receivable, Aged Payable
//   Management         Invoice Analysis, Audit Trail
//
// Every report takes the same options, as Odoo's do:
//   date_from / date_to      the period (a single date for Balance Sheet and the aged reports)
//   comparison               previous_period | same_last_year, comparison_count 1-12 -- extra
//                            columns, plus a growth % column when there is exactly one
//   journals                 sales,purchase,bank,inventory,misc -- which kinds of entries count
//   location_id              one branch (the topbar company switcher already scopes the company)
//   unfold_all, hide_zero, hierarchy, search, partner_type, account (drill from another report)
//   expand                   the id of a folded line whose children are fetched on demand
//                            (an account in the General Ledger, a partner in the Partner Ledger)
//
// and returns one payload the one client page (pages/reports/FinancialReport.jsx) draws:
//   { key, title, columns: [{ label, type }], lines: [{ id, parent, level, name, values[], style,
//     unfoldable, folded, lazy, link, action }], filters, ... }
// lines are flat and in display order; a line's children follow it and name it as `parent`.
const ExcelJS = require('exceljs');
const pool = require('../db');
const { getPostedGlLines } = require('./glImpact');
const { filterLines, resolveScope } = require('./companyScope');
const { currentScope } = require('./requestScope');
const { linkFor, DOCS } = require('./docLinks');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
const todayIso = () => {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // Philippine date
  return d.toISOString().slice(0, 10);
};
const d10 = (v) => (v instanceof Date ? new Date(v.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10) : String(v || '').slice(0, 10));

/* ------------------------------------------------------------------ dates and periods */

function parts(s) { return [Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10))]; }
function fmt(y, m, d) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
function lastDay(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function addDays(s, n) { const [y, m, d] = parts(s); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); }
function isMonthEnd(s) { const [y, m, d] = parts(s); return d === lastDay(y, m); }
// Moves a date n months, keeping "end of month" as end of month.
function addMonths(s, n) {
  const [y, m, d] = parts(s);
  const t = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(t / 12); const nm = (t % 12) + 1;
  const end = lastDay(ny, nm);
  return fmt(ny, nm, isMonthEnd(s) ? end : Math.min(d, end));
}
function monthsSpanned(from, to) {
  // Whole months when the period runs from a 1st to a month end, else null.
  if (!from || from.slice(8) !== '01' || !isMonthEnd(to)) return null;
  const [fy, fm] = parts(from); const [ty, tm] = parts(to);
  return (ty * 12 + tm) - (fy * 12 + fm) + 1;
}
const yearStart = (s) => `${s.slice(0, 4)}-01-01`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function niceDate(s) { const [y, m, d] = parts(s); return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`; }
function periodLabel(p, single) {
  if (single || !p.from) return `As of ${niceDate(p.to)}`;
  const [fy, fm, fd] = parts(p.from); const [ty, tm] = parts(p.to);
  if (fd === 1 && isMonthEnd(p.to)) {
    if (fy === ty && fm === 1 && tm === 12) return String(fy);
    if (fy === ty && fm === tm) return `${MONTHS[fm - 1]} ${fy}`;
    if (fy === ty && (fm - 1) % 3 === 0 && tm === fm + 2) return `Q${(fm + 2) / 3} ${fy}`;
  }
  return `${niceDate(p.from)} - ${niceDate(p.to)}`;
}
// The report's own period plus its comparison periods, newest first (Odoo's column order).
function buildPeriods(o, single) {
  const base = { from: single ? null : o.date_from, to: o.date_to };
  const out = [base];
  if (o.comparison) {
    for (let k = 1; k <= o.comparison_count; k += 1) {
      if (o.comparison === 'same_last_year') {
        out.push({ from: base.from ? addMonths(base.from, -12 * k) : null, to: addMonths(base.to, -12 * k) });
      } else if (single) {
        out.push({ from: null, to: isMonthEnd(base.to) ? addMonths(base.to, -k) : addDays(base.to, -30 * k) });
      } else {
        const months = monthsSpanned(base.from, base.to);
        if (months) out.push({ from: addMonths(base.from, -months * k), to: addMonths(base.to, -months * k) });
        else {
          const len = Math.round((Date.parse(base.to) - Date.parse(base.from)) / 86400000) + 1;
          out.push({ from: addDays(base.from, -len * k), to: addDays(base.to, -len * k) });
        }
      }
    }
  }
  return out.map((p) => ({ ...p, label: periodLabel(p, single) }));
}

/* ------------------------------------------------------------------ options */

const JOURNALS = [
  { key: 'sales', label: 'Sales', types: ['sales_invoice', 'credit_memo', 'delivery_ticket', 'sales_order'] },
  { key: 'purchase', label: 'Purchases', types: ['vendor_bill', 'bill_credit', 'receiving_report'] },
  { key: 'bank', label: 'Bank and Cash', types: ['customer_payment', 'customer_refund', 'bill_payment', 'cheque', 'bank_deposit', 'fund_transfer', 'commission_voucher'] },
  { key: 'inventory', label: 'Inventory Valuation', types: ['assembly_build', 'item_delivery', 'item_fulfillment', 'item_receipt', 'inventory_adjustment', 'osr_fulfillment'] },
  { key: 'misc', label: 'Miscellaneous Operations', types: [] },
];
const JOURNAL_OF = new Map(JOURNALS.flatMap((j) => j.types.map((t) => [t, j.key])));
const journalOf = (type) => JOURNAL_OF.get(type) || 'misc';
const JOURNAL_LABEL = new Map(JOURNALS.map((j) => [j.key, j.label]));
const DOC_LABEL = {
  sales_invoice: 'Invoice', credit_memo: 'Credit Memo', delivery_ticket: 'Delivery Ticket', sales_order: 'Sales Order',
  vendor_bill: 'Vendor Bill', bill_credit: 'Bill Credit', receiving_report: 'Receiving Report', customer_payment: 'Customer Payment',
  customer_refund: 'Customer Refund', bill_payment: 'Bill Payment', cheque: 'Cheque', bank_deposit: 'Deposit', fund_transfer: 'Fund Transfer',
  commission_voucher: 'Commission Voucher', commission_payable: 'Commission Payable', journal: 'Journal', inventory_adjustment: 'Inventory Adjustment',
};

function parseOptions(q = {}, single = false) {
  const date_to = day(q.date_to) || todayIso();
  const date_from = single ? null : (day(q.date_from) || yearStart(date_to));
  const comparison = ['previous_period', 'same_last_year'].includes(q.comparison) ? q.comparison : null;
  const journals = String(q.journals || '').split(',').map((s) => s.trim()).filter((s) => JOURNAL_LABEL.has(s));
  return {
    date_from, date_to, comparison,
    comparison_count: comparison ? Math.min(12, Math.max(1, Number(q.comparison_count) || 1)) : 0,
    journals,
    location_id: Number(q.location_id) > 0 ? Number(q.location_id) : null,
    unfold_all: q.unfold_all === '1' || q.unfold_all === 'true',
    hide_zero: q.hide_zero === '1' || q.hide_zero === 'true',
    hierarchy: q.hierarchy === '1' || q.hierarchy === 'true',
    search: String(q.search || '').trim().toLowerCase(),
    partner_type: ['receivable', 'payable'].includes(q.partner_type) ? q.partner_type : 'both',
    account: q.account ? String(q.account) : null,
    expand: q.expand ? String(q.expand) : null,
    group_by: String(q.group_by || ''),
    group_by2: String(q.group_by2 || ''),
    move_type: q.move_type === 'vendor' ? 'vendor' : 'customer',
  };
}

// The company (topbar switcher) or, when asked, one branch.
async function scopeFor(o) {
  if (o.location_id) return resolveScope({ locationId: o.location_id });
  return currentScope();
}

/* ------------------------------------------------------------------ accounts */

// Every account with its type and its Odoo-style role (which line of the statements it lands on).
async function loadAccounts() {
  const [rows] = await pool.query(
    `SELECT coa.id, coa.account_code, coa.account_name, coa.parent_account_id, coa.is_summary,
            t.account_type, t.account_sub_type, t.normal_balance
       FROM chart_of_accounts coa LEFT JOIN chart_of_account_types t ON t.id = coa.coa_type_id
      WHERE coa.exclude_from_reports = 0 ORDER BY coa.account_code`);
  return rows.map((a) => ({ ...a, role: roleOf(a) }));
}
function roleOf(a) {
  const type = String(a.account_type || '').toUpperCase();
  const sub = String(a.account_sub_type || '').toUpperCase();
  const name = String(a.account_name || '');
  if (type === 'ASSET') {
    if (/BANK|CASH/.test(sub) || /^(cash|petty cash|change fund|cash on hand|cash in bank)\b/i.test(name)) return 'cash';
    if (/receivable/i.test(name) && !/other receivable|advances/i.test(name)) return 'receivable';
    if (/FIXED|PROPERTY|PPE/.test(sub)) return 'fixed_asset';
    if (/NON.?CURRENT/.test(sub)) return 'non_current_asset';
    if (/prepaid|prepayment|advances? to/i.test(name)) return 'prepayment';
    return 'current_asset';
  }
  if (type === 'LIABILITY') {
    if (/(accounts|trade)\s*payable/i.test(name)) return 'payable';
    if (/NON.?CURRENT|LONG/.test(sub)) return 'non_current_liability';
    return 'current_liability';
  }
  if (type === 'EQUITY') return 'equity';
  if (type === 'INCOME' || type === 'REVENUE') return /OTHER/.test(sub) ? 'other_income' : 'income';
  if (type === 'EXPENSE') {
    if (/COST|DIRECT/.test(sub) || /^cost of/i.test(name)) return 'direct_cost';
    if (/NON.?OPERATING|OTHER/.test(sub)) return 'other_expense';
    if (/depreciation/i.test(name)) return 'depreciation';
    return 'expense';
  }
  return 'other';
}
const PL_ROLES = new Set(['income', 'other_income', 'direct_cost', 'expense', 'depreciation', 'other_expense']);
const CREDIT_ROLES = new Set(['payable', 'current_liability', 'non_current_liability', 'equity', 'income', 'other_income']);

/* ------------------------------------------------------------------ the ledger */

// Posted GL lines up to `to` (from the start of the books), in the scope and the journals asked.
async function ledger(o, to, from = null) {
  const scope = await scopeFor(o);
  const { lines } = filterLines(await getPostedGlLines({ toDate: to, fromDate: from || undefined }), scope);
  const wanted = o.journals.length ? new Set(o.journals) : null;
  return lines
    .filter((l) => (Number(l.debit) || 0) || (Number(l.credit) || 0))
    .filter((l) => !wanted || wanted.has(journalOf(l.source_type)))
    .map((l) => ({ ...l, date: d10(l.entry_date), debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 }));
}
const within = (l, from, to) => (!from || l.date >= from) && l.date <= to;
// account_code -> raw (debit - credit) over the lines.
function netBy(lines) {
  const m = new Map();
  for (const l of lines) m.set(l.account_code, (m.get(l.account_code) || 0) + l.debit - l.credit);
  return m;
}
const moveKey = (l) => `${l.source_type}|${l.source_id ?? l.source_no}|${l.date}`;

/* ------------------------------------------------------------------ building lines */

function lineMaker() {
  let seq = 0;
  const lines = [];
  const add = (o) => {
    const line = {
      id: o.id || `l${seq += 1}`, parent: o.parent || null, level: o.level || 0, name: o.name,
      values: o.values || [], style: o.style || '', unfoldable: !!o.unfoldable, folded: !!o.folded,
      lazy: !!o.lazy, link: o.link || null, action: o.action || null, code: o.code || null,
      ...(o.fmt ? { fmt: o.fmt } : {}),
    };
    lines.push(line);
    return line;
  };
  return { lines, add };
}

// Leaf accounts of a set of roles, one line per account, each value one period (sign = display side).
// With `hierarchy` the accounts nest under their parent (summary) accounts.
function accountLines(add, accounts, roles, maps, { parent, level, sign, o, action }) {
  const own = accounts.filter((a) => roles.has(a.role) && !a.is_summary);
  const vals = (codes) => maps.map((m) => r2(codes.reduce((s, c) => s + (m.get(c) || 0), 0) * sign));
  const totals = maps.map(() => 0);
  const rows = [];
  for (const a of own) {
    const v = vals([a.account_code]);
    if (v.every((x) => Math.abs(x) < 0.005) && !maps.some((m) => m.has(a.account_code))) continue;
    v.forEach((x, i) => { totals[i] += x; });
    rows.push({ a, v });
  }
  if (o.hierarchy) {
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const groups = new Map();
    for (const r of rows) {
      const p = r.a.parent_account_id && byId.get(r.a.parent_account_id);
      const k = p ? p.id : 0;
      if (!groups.has(k)) groups.set(k, { p, rows: [] });
      groups.get(k).rows.push(r);
    }
    for (const { p, rows: rs } of groups.values()) {
      let par = parent; let lv = level;
      if (p) {
        const gv = maps.map((_, i) => r2(rs.reduce((s, r) => s + r.v[i], 0)));
        const g = add({ parent, level, name: `${p.account_code} ${p.account_name}`, values: gv, style: 'group', unfoldable: true, folded: !o.unfold_all });
        par = g.id; lv = level + 1;
      }
      for (const r of rs) add({ parent: par, level: lv, name: `${r.a.account_code} ${r.a.account_name}`, code: r.a.account_code, values: r.v, style: 'account', action: action && action(r.a) });
    }
  } else {
    for (const r of rows) add({ parent, level, name: `${r.a.account_code} ${r.a.account_name}`, code: r.a.account_code, values: r.v, style: 'account', action: action && action(r.a) });
  }
  return totals.map(r2);
}

// A drill from a statement line to the General Ledger for that account and period.
const glAction = (p) => (a) => ({ report: 'general_ledger', params: { account: a.account_code, date_from: p.from || yearStart(p.to), date_to: p.to } });

// Drops lines whose numbers are all zero (sections and totals stay), as Odoo's "Hide lines at 0".
function hideZero(lines) {
  const STRUCTURAL = new Set(['title', 'section', 'total', 'grand']);
  return lines.filter((l) => {
    if (STRUCTURAL.has(l.style)) return true;
    const nums = l.values.filter((v) => typeof v === 'number');
    return !nums.length || nums.some((v) => Math.abs(v) >= 0.005);
  });
}

// Adds the growth % column when there is exactly one comparison.
function withGrowth(report) {
  if (report.periodCount !== 2) return report;
  report.columns.push({ label: '%', type: 'percent' });
  for (const l of report.lines) {
    const [a, b] = l.values;
    if (typeof a !== 'number' || typeof b !== 'number' || l.style === 'title') { l.values.push(null); continue; }
    l.values.push(Math.abs(b) < 0.005 ? null : r2(((a - b) / Math.abs(b)) * 100));
  }
  return report;
}

/* ================================================================== the reports */

// ---- Balance Sheet -------------------------------------------------------------
async function balanceSheet(o) {
  const periods = buildPeriods(o, true);
  const [accounts, all] = await Promise.all([loadAccounts(), ledger(o, periods[0].to)]);
  const roleOfCode = new Map(accounts.map((a) => [a.account_code, a.role]));
  const maps = periods.map((p) => netBy(all.filter((l) => l.date <= p.to)));
  // Earnings that sit on no account until closed: this year's, and every earlier year's.
  const plNet = (lines) => lines.reduce((s, l) => s + (PL_ROLES.has(roleOfCode.get(l.account_code)) ? l.credit - l.debit : 0), 0);
  const curEarn = periods.map((p) => r2(plNet(all.filter((l) => l.date >= yearStart(p.to) && l.date <= p.to))));
  const prevEarn = periods.map((p) => r2(plNet(all.filter((l) => l.date < yearStart(p.to)))));
  const { lines, add } = lineMaker();
  const fold = !o.unfold_all;
  const opts = (parent, level, sign) => ({ parent, level, sign, o, action: glAction(periods[0]) });
  const sum = (...arrs) => periods.map((_, i) => r2(arrs.reduce((s, a) => s + a[i], 0)));

  const assets = add({ name: 'ASSETS', style: 'title', values: periods.map(() => null) });
  const cur = add({ parent: assets.id, level: 1, name: 'Current Assets', style: 'section', unfoldable: true });
  const sec = (parent, level, name, roles, sign) => {
    const s = add({ parent, level, name, style: 'subsection', unfoldable: true, folded: fold });
    s.values = accountLines(add, accounts, new Set(roles), maps, opts(s.id, level + 1, sign));
    return s.values;
  };
  const cash = sec(cur.id, 2, 'Bank and Cash Accounts', ['cash'], 1);
  const recv = sec(cur.id, 2, 'Receivables', ['receivable'], 1);
  const curA = sec(cur.id, 2, 'Current Assets', ['current_asset', 'other'], 1);
  const prep = sec(cur.id, 2, 'Prepayments', ['prepayment'], 1);
  cur.values = sum(cash, recv, curA, prep);
  const fixed = sec(assets.id, 1, 'Plus Fixed Assets', ['fixed_asset'], 1);
  const ncA = sec(assets.id, 1, 'Plus Non-current Assets', ['non_current_asset'], 1);
  const totalAssets = sum(cur.values, fixed, ncA);
  add({ name: 'Total ASSETS', style: 'grand', values: totalAssets });

  const liab = add({ name: 'LIABILITIES', style: 'title', values: periods.map(() => null) });
  const curL = add({ parent: liab.id, level: 1, name: 'Current Liabilities', style: 'section', unfoldable: true });
  const cl = sec(curL.id, 2, 'Current Liabilities', ['current_liability'], -1);
  const pay = sec(curL.id, 2, 'Payables', ['payable'], -1);
  curL.values = sum(cl, pay);
  const ncL = sec(liab.id, 1, 'Plus Non-current Liabilities', ['non_current_liability'], -1);
  const totalLiab = sum(curL.values, ncL);
  add({ name: 'Total LIABILITIES', style: 'total', values: totalLiab });

  const eq = add({ name: 'EQUITY', style: 'title', values: periods.map(() => null) });
  const un = add({ parent: eq.id, level: 1, name: 'Unallocated Earnings', style: 'section', unfoldable: true, values: sum(curEarn, prevEarn) });
  add({ parent: un.id, level: 2, name: 'Current Year Unallocated Earnings', style: 'subsection', values: curEarn,
    action: { report: 'profit_loss', params: { date_from: yearStart(periods[0].to), date_to: periods[0].to } } });
  add({ parent: un.id, level: 2, name: 'Previous Years Unallocated Earnings', style: 'subsection', values: prevEarn });
  const ret = sec(eq.id, 1, 'Retained Earnings', ['equity'], -1);
  const totalEq = sum(un.values, ret);
  add({ name: 'Total EQUITY', style: 'total', values: totalEq });
  add({ name: 'LIABILITIES + EQUITY', style: 'grand', values: sum(totalLiab, totalEq) });

  const diff = r2(totalAssets[0] - sum(totalLiab, totalEq)[0]);
  return withGrowth({
    title: 'Balance Sheet', single: true, periodCount: periods.length,
    columns: periods.map((p) => ({ label: p.label, type: 'money' })), lines,
    warning: Math.abs(diff) >= 0.01 ? `Assets and Liabilities + Equity differ by ${diff.toLocaleString('en-US', { minimumFractionDigits: 2 })}.` : null,
  });
}

// ---- Profit and Loss -----------------------------------------------------------
async function profitLoss(o) {
  const periods = buildPeriods(o, false);
  const oldest = periods.reduce((m, p) => (p.from < m ? p.from : m), periods[0].from);
  const [accounts, all] = await Promise.all([loadAccounts(), ledger(o, periods[0].to, oldest)]);
  const maps = periods.map((p) => netBy(all.filter((l) => within(l, p.from, p.to))));
  const { lines, add } = lineMaker();
  const fold = !o.unfold_all;
  const sec = (name, roles, sign) => {
    const s = add({ name, style: 'section', unfoldable: true, folded: fold });
    s.values = accountLines(add, accounts, new Set(roles), maps, { parent: s.id, level: 1, sign, o, action: glAction(periods[0]) });
    return s.values;
  };
  const z = (f) => periods.map((_, i) => r2(f(i)));
  const rev = sec('Revenue', ['income'], -1);
  const cogs = sec('Less Costs of Revenue', ['direct_cost'], 1);
  const gp = z((i) => rev[i] - cogs[i]);
  add({ name: 'Gross Profit', style: 'total', values: gp });
  const opex = sec('Less Operating Expenses', ['expense', 'depreciation'], 1);
  const oi = z((i) => gp[i] - opex[i]);
  add({ name: 'Operating Income (or Loss)', style: 'total', values: oi });
  const other = sec('Plus Other Income', ['other_income'], -1);
  const otherExp = sec('Less Other Expenses', ['other_expense'], 1);
  add({ name: 'Net Profit', style: 'grand', values: z((i) => oi[i] + other[i] - otherExp[i]) });
  return withGrowth({ title: 'Profit and Loss', periodCount: periods.length, columns: periods.map((p) => ({ label: p.label, type: 'money' })), lines });
}

// ---- Cash Flow Statement -----------------------------------------------------------
// Direct method, as Odoo's: every entry that moves a bank or cash account, its other lines sorted
// by what they are -- customers, suppliers and the P&L are operating; fixed and non-current assets
// investing; equity and non-current liabilities financing.
const CF_CLASS = {
  receivable: 'operating', payable: 'operating', income: 'operating', other_income: 'operating', direct_cost: 'operating',
  expense: 'operating', depreciation: 'operating', other_expense: 'operating', current_asset: 'operating',
  prepayment: 'operating', current_liability: 'operating', fixed_asset: 'investing', non_current_asset: 'investing',
  equity: 'financing', non_current_liability: 'financing',
};
async function cashFlow(o) {
  const periods = buildPeriods(o, false);
  const [accounts, all] = await Promise.all([loadAccounts(), ledger(o, periods[0].to)]);
  const acct = new Map(accounts.map((a) => [a.account_code, a]));
  const isCash = (code) => acct.get(code)?.role === 'cash';
  const perPeriod = periods.map((p) => {
    const opening = all.filter((l) => l.date < p.from && isCash(l.account_code)).reduce((s, l) => s + l.debit - l.credit, 0);
    const closing = all.filter((l) => l.date <= p.to && isCash(l.account_code)).reduce((s, l) => s + l.debit - l.credit, 0);
    const moves = new Map();
    for (const l of all) {
      if (!within(l, p.from, p.to)) continue;
      const k = moveKey(l);
      if (!moves.has(k)) moves.set(k, []);
      moves.get(k).push(l);
    }
    // bucket -> account_code -> amount (cash in positive)
    const b = new Map();
    const put = (bucket, code, amt) => {
      if (!b.has(bucket)) b.set(bucket, new Map());
      const m = b.get(bucket); m.set(code, (m.get(code) || 0) + amt);
    };
    for (const ls of moves.values()) {
      const cashNet = ls.filter((l) => isCash(l.account_code)).reduce((s, l) => s + l.debit - l.credit, 0);
      if (Math.abs(cashNet) < 0.005) continue;
      const others = ls.filter((l) => !isCash(l.account_code));
      const otherNet = others.reduce((s, l) => s + l.credit - l.debit, 0);
      if (Math.abs(otherNet) < 0.005) continue;
      const scale = cashNet / otherNet; // the cash share of each counterpart line
      for (const l of others) {
        const amt = (l.credit - l.debit) * scale;
        const cls = CF_CLASS[acct.get(l.account_code)?.role] || 'unclassified';
        put(`${cls}:${amt >= 0 ? 'in' : 'out'}`, l.account_code, amt);
      }
    }
    return { opening, closing, b };
  });
  const { lines, add } = lineMaker();
  const fold = !o.unfold_all;
  const vals = (f) => perPeriod.map((x) => r2(f(x)));
  const bucketTotal = (x, key) => [...(x.b.get(key)?.values() || [])].reduce((s, v) => s + v, 0);
  add({ name: 'Cash and cash equivalents, beginning of period', style: 'total', values: vals((x) => x.opening) });
  const net = add({ name: 'Net increase in cash and cash equivalents', style: 'section', values: vals((x) => x.closing - x.opening) });
  const sections = [
    ['operating', 'Cash flows from operating activities', [['in', 'Cash received from operating activities'], ['out', 'Cash paid for operating activities']]],
    ['investing', 'Cash flows from investing & extraordinary activities', [['in', 'Cash in'], ['out', 'Cash out']]],
    ['financing', 'Cash flows from financing activities', [['in', 'Cash in'], ['out', 'Cash out']]],
    ['unclassified', 'Cash flows from unclassified activities', [['in', 'Cash in'], ['out', 'Cash out']]],
  ];
  for (const [cls, title, subs] of sections) {
    const s = add({ parent: net.id, level: 1, name: title, style: 'subsection', values: vals((x) => bucketTotal(x, `${cls}:in`) + bucketTotal(x, `${cls}:out`)) });
    for (const [dir, label] of subs) {
      const key = `${cls}:${dir}`;
      const codes = [...new Set(perPeriod.flatMap((x) => [...(x.b.get(key)?.keys() || [])]))].sort();
      const sub = add({ parent: s.id, level: 2, name: label, values: vals((x) => bucketTotal(x, key)), unfoldable: codes.length > 0, folded: fold });
      for (const c of codes) {
        const a = acct.get(c);
        add({ parent: sub.id, level: 3, name: `${c} ${a ? a.account_name : ''}`, code: c, style: 'account',
          values: vals((x) => x.b.get(key)?.get(c) || 0), action: glAction(periods[0])({ account_code: c }) });
      }
    }
  }
  add({ name: 'Cash and cash equivalents, closing balance', style: 'grand', values: vals((x) => x.closing) });
  return withGrowth({ title: 'Cash Flow Statement', periodCount: periods.length, columns: periods.map((p) => ({ label: p.label, type: 'money' })), lines });
}

// ---- Executive Summary -----------------------------------------------------------
async function executiveSummary(o) {
  const periods = buildPeriods(o, false);
  const [accounts, all] = await Promise.all([loadAccounts(), ledger(o, periods[0].to)]);
  const role = new Map(accounts.map((a) => [a.account_code, a.role]));
  const figures = periods.map((p) => {
    const inP = all.filter((l) => within(l, p.from, p.to));
    const upTo = all.filter((l) => l.date <= p.to);
    const flow = (roles, credit) => inP.reduce((s, l) => s + (roles.includes(role.get(l.account_code)) ? (credit ? l.credit - l.debit : l.debit - l.credit) : 0), 0);
    const bal = (roles, credit) => upTo.reduce((s, l) => s + (roles.includes(role.get(l.account_code)) ? (credit ? l.credit - l.debit : l.debit - l.credit) : 0), 0);
    const cashIn = inP.reduce((s, l) => s + (role.get(l.account_code) === 'cash' ? l.debit : 0), 0);
    const cashOut = inP.reduce((s, l) => s + (role.get(l.account_code) === 'cash' ? l.credit : 0), 0);
    const revenue = flow(['income'], true);
    const cost = flow(['direct_cost'], false);
    const expenses = flow(['expense', 'depreciation', 'other_expense'], false);
    const otherIncome = flow(['other_income'], true);
    const gross = revenue - cost;
    const netProfit = gross + otherIncome - expenses;
    const receivables = bal(['receivable'], false);
    const payables = bal(['payable'], true);
    const assets = bal(['cash', 'receivable', 'current_asset', 'prepayment', 'fixed_asset', 'non_current_asset', 'other'], false);
    const liabilities = bal(['payable', 'current_liability', 'non_current_liability'], true);
    const curAssets = bal(['cash', 'receivable', 'current_asset', 'prepayment'], false);
    const curLiab = bal(['payable', 'current_liability'], true);
    const days = Math.round((Date.parse(p.to) - Date.parse(p.from)) / 86400000) + 1;
    return {
      cashIn, cashOut, surplus: cashIn - cashOut, closingCash: bal(['cash'], false),
      revenue, cost, gross, expenses, netProfit, receivables, payables, netAssets: assets - liabilities,
      gpMargin: revenue ? (gross / revenue) * 100 : 0, npMargin: revenue ? (netProfit / revenue) * 100 : 0,
      roi: assets ? (netProfit / assets) * 100 : 0,
      debtorDays: revenue ? Math.round((receivables / revenue) * days) : 0,
      creditorDays: (cost + expenses) ? Math.round((payables / (cost + expenses)) * days) : 0,
      forecast: bal(['cash'], false) + receivables - payables,
      ratio: curLiab ? curAssets / curLiab : 0,
    };
  });
  const { lines, add } = lineMaker();
  const sec = (name, rows) => {
    const s = add({ name, style: 'section', values: periods.map(() => null) });
    for (const [label, key, type, action] of rows) {
      add({ parent: s.id, level: 1, name: label, values: figures.map((f) => r2(f[key])), fmt: type, action });
    }
  };
  const p0 = periods[0];
  sec('Cash', [['Cash received', 'cashIn'], ['Cash spent', 'cashOut'], ['Cash surplus', 'surplus'],
    ['Closing bank balance', 'closingCash', null, { report: 'check_register', params: { date_from: p0.from, date_to: p0.to } }]]);
  sec('Profitability', [['Revenue', 'revenue', null, { report: 'profit_loss', params: { date_from: p0.from, date_to: p0.to } }],
    ['Cost of Revenue', 'cost'], ['Gross profit', 'gross'], ['Expenses', 'expenses'], ['Net Profit', 'netProfit']]);
  sec('Balance Sheet', [['Receivables', 'receivables', null, { report: 'aged_receivable', params: { date_to: p0.to } }],
    ['Payables', 'payables', null, { report: 'aged_payable', params: { date_to: p0.to } }], ['Net assets', 'netAssets']]);
  sec('Performance', [['Gross profit margin (gross profit / operating income)', 'gpMargin', 'percent'],
    ['Net profit margin (net profit / income)', 'npMargin', 'percent'], ['Return on investments (net profit / assets)', 'roi', 'percent']]);
  sec('Position', [['Average debtors days', 'debtorDays', 'number'], ['Average creditors days', 'creditorDays', 'number'],
    ['Short term cash forecast', 'forecast'], ['Current assets to liabilities', 'ratio', 'ratio']]);
  return withGrowth({ title: 'Executive Summary', periodCount: periods.length, columns: periods.map((p) => ({ label: p.label, type: 'money' })), lines });
}

// ---- Trial Balance -----------------------------------------------------------
async function trialBalance(o) {
  const periods = buildPeriods(o, false).reverse(); // oldest first, as Odoo lays them out
  const first = periods[0].from;
  const last = periods[periods.length - 1].to;
  const [accounts, all] = await Promise.all([loadAccounts(), ledger(o, last)]);
  const acct = new Map(accounts.map((a) => [a.account_code, a]));
  const fyStart = yearStart(first);
  // Income and expense accounts start each year at zero; earlier years' profit is carried as one line.
  const initial = new Map();
  let undistributed = 0;
  for (const l of all) {
    if (l.date >= first) continue;
    const pl = PL_ROLES.has(acct.get(l.account_code)?.role);
    if (pl && l.date < fyStart) { undistributed += l.debit - l.credit; continue; }
    initial.set(l.account_code, (initial.get(l.account_code) || 0) + l.debit - l.credit);
  }
  const per = periods.map((p) => {
    const m = new Map();
    for (const l of all) {
      if (!within(l, p.from, p.to)) continue;
      const x = m.get(l.account_code) || { d: 0, c: 0 };
      x.d += l.debit; x.c += l.credit; m.set(l.account_code, x);
    }
    return m;
  });
  const columns = [{ label: 'Initial Balance', type: 'money', group: 'Debit' }, { label: 'Initial Balance', type: 'money', group: 'Credit' }];
  periods.forEach((p) => { columns.push({ label: p.label, type: 'money', group: 'Debit' }, { label: p.label, type: 'money', group: 'Credit' }); });
  columns.push({ label: 'End Balance', type: 'money', group: 'Debit' }, { label: 'End Balance', type: 'money', group: 'Credit' });
  const dc = (n) => [n > 0 ? r2(n) : 0, n < 0 ? r2(-n) : 0];
  const { lines, add } = lineMaker();
  const totals = columns.map(() => 0);
  const codes = new Set([...initial.keys(), ...per.flatMap((m) => [...m.keys()])]);
  const rows = [];
  for (const a of accounts) {
    if (!codes.has(a.account_code)) continue;
    if (o.search && !`${a.account_code} ${a.account_name}`.toLowerCase().includes(o.search)) continue;
    const init = initial.get(a.account_code) || 0;
    let end = init;
    const v = [...dc(init)];
    per.forEach((m) => { const x = m.get(a.account_code) || { d: 0, c: 0 }; v.push(r2(x.d), r2(x.c)); end += x.d - x.c; });
    v.push(...dc(end));
    rows.push({ a, v });
  }
  if (Math.abs(undistributed) >= 0.005 && !o.search) {
    const v = [...dc(undistributed), ...per.flatMap(() => [0, 0]), ...dc(undistributed)];
    rows.push({ a: { account_code: '', account_name: 'Undistributed Profits/Losses (previous years)' }, v });
  }
  for (const { a, v } of rows) {
    v.forEach((x, i) => { totals[i] += x; });
    add({ name: `${a.account_code} ${a.account_name}`.trim(), code: a.account_code || null, values: v, style: 'account',
      action: a.account_code ? { report: 'general_ledger', params: { account: a.account_code, date_from: first, date_to: last } } : null });
  }
  add({ name: 'Total', style: 'grand', values: totals.map(r2) });
  return { title: 'Trial Balance', columns, lines, grouped: true };
}

// ---- partners behind GL lines -----------------------------------------------------------
// Each GL line's customer / supplier / employee, read from its document (and, for journals and
// deposits, from the matching line of the document).
async function partnersFor(lines) {
  const ids = new Map();
  for (const l of lines) {
    if (!l.source_id) continue;
    if (!ids.has(l.source_type)) ids.set(l.source_type, new Set());
    ids.get(l.source_type).add(l.source_id);
  }
  const head = new Map(); // `${type}:${id}` -> { key, name }
  const SQL = {
    sales_invoice: `SELECT si.id, c.id pid, c.name FROM sales_invoices si LEFT JOIN sales_orders so ON so.id = si.sales_order_id
      LEFT JOIN estimates e ON e.id = si.estimate_id LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id
      LEFT JOIN customers c ON c.id = COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id) WHERE si.id IN (?)`,
    customer_payment: 'SELECT cp.id, c.id pid, c.name FROM customer_payments cp LEFT JOIN customers c ON c.id = cp.customer_id WHERE cp.id IN (?)',
    customer_refund: 'SELECT x.id, c.id pid, c.name FROM customer_refunds x LEFT JOIN customers c ON c.id = x.customer_id WHERE x.id IN (?)',
    credit_memo: `SELECT cm.id, c.id pid, c.name FROM credit_memos cm LEFT JOIN sales_orders so ON so.id = cm.sales_order_id
      LEFT JOIN customers c ON c.id = COALESCE(cm.customer_id, so.customer_id) WHERE cm.id IN (?)`,
    delivery_ticket: 'SELECT dt.id, c.id pid, c.name FROM delivery_tickets dt LEFT JOIN sales_orders so ON so.id = dt.sales_order_id LEFT JOIN customers c ON c.id = so.customer_id WHERE dt.id IN (?)',
    vendor_bill: 'SELECT vb.id, s.id pid, s.name FROM vendor_bills vb LEFT JOIN suppliers s ON s.id = vb.supplier_id WHERE vb.id IN (?)',
    bill_credit: 'SELECT bc.id, s.id pid, s.name FROM bill_credits bc LEFT JOIN suppliers s ON s.id = bc.supplier_id WHERE bc.id IN (?)',
    bill_payment: 'SELECT bp.id, s.id pid, COALESCE(s.name, bp.payee_name) name FROM bill_payments bp LEFT JOIN suppliers s ON s.id = bp.supplier_id WHERE bp.id IN (?)',
  };
  const KIND = { sales_invoice: 'customer', customer_payment: 'customer', customer_refund: 'customer', credit_memo: 'customer', delivery_ticket: 'customer', vendor_bill: 'supplier', bill_credit: 'supplier', bill_payment: 'supplier' };
  for (const [type, set] of ids) {
    if (!SQL[type]) continue;
    try {
      const [rows] = await pool.query(SQL[type], [[...set]]);
      for (const r of rows) if (r.name) head.set(`${type}:${r.id}`, { key: r.pid ? `${KIND[type]}:${r.pid}` : `name:${r.name}`, name: r.name });
    } catch { /* a missing table on an older database: no partner */ }
  }
  // Cheques: one payee.
  if (ids.has('cheque')) {
    try {
      const [rows] = await pool.query('SELECT id, payee_type, payee_id, payee_name FROM cheques WHERE id IN (?)', [[...ids.get('cheque')]]);
      for (const r of rows) if (r.payee_name) head.set(`cheque:${r.id}`, { key: r.payee_id ? `${String(r.payee_type).toLowerCase()}:${r.payee_id}` : `name:${r.payee_name}`, name: r.payee_name });
    } catch { /* */ }
  }
  // Journals and deposits: each line names its own party; match the GL line by account and amount.
  const perLine = new Map(); // `${type}:${id}` -> [{ account_code, debit, credit, key, name, used }]
  const LINE_SQL = {
    journal: `SELECT jl.journal_id doc, coa.account_code, jl.debit, jl.credit, jl.party_type, jl.party_id, jl.party_name
      FROM journal_lines jl LEFT JOIN chart_of_accounts coa ON coa.id = jl.account_id WHERE jl.journal_id IN (?) AND jl.party_name IS NOT NULL`,
    bank_deposit: `SELECT l.deposit_id doc, coa.account_code, 0 debit, l.amount credit, l.party_type, l.party_id, l.party_name
      FROM bank_deposit_lines l LEFT JOIN chart_of_accounts coa ON coa.id = l.account_id WHERE l.deposit_id IN (?) AND l.party_name IS NOT NULL`,
  };
  for (const [type, sql] of Object.entries(LINE_SQL)) {
    if (!ids.has(type)) continue;
    try {
      const [rows] = await pool.query(sql, [[...ids.get(type)]]);
      for (const r of rows) {
        const k = `${type}:${r.doc}`;
        if (!perLine.has(k)) perLine.set(k, []);
        perLine.get(k).push({ account_code: r.account_code, debit: Number(r.debit) || 0, credit: Number(r.credit) || 0,
          key: r.party_id ? `${String(r.party_type || 'party').toLowerCase()}:${r.party_id}` : `name:${r.party_name}`, name: r.party_name, used: false });
      }
    } catch { /* columns differ on an older database */ }
  }
  return (l) => {
    const k = `${l.source_type}:${l.source_id}`;
    if (head.has(k)) return head.get(k);
    const cands = perLine.get(k);
    if (!cands) return null;
    const exact = cands.find((c) => !c.used && c.account_code === l.account_code && Math.abs(c.debit - l.debit) < 0.005 && Math.abs(c.credit - l.credit) < 0.005)
      || cands.find((c) => c.account_code === l.account_code) || (new Set(cands.map((c) => c.key)).size === 1 ? cands[0] : null);
    if (exact) exact.used = true;
    return exact ? { key: exact.key, name: exact.name } : null;
  };
}

const docName = (l) => [l.source_no, l.memo && l.memo !== l.source_no ? l.memo : null].filter(Boolean).join(' - ') || DOC_LABEL[l.source_type] || l.source_type;

// ---- General Ledger (and Check Register) -----------------------------------------------------
async function generalLedger(o, { cashOnly = false, title = 'General Ledger' } = {}) {
  const [accounts, all] = await Promise.all([loadAccounts(), ledger(o, o.date_to)]);
  const acct = new Map(accounts.map((a) => [a.account_code, a]));
  const fyStart = yearStart(o.date_from);
  const keep = (a) => (!cashOnly || a.role === 'cash') && (!o.account || a.account_code === o.account)
    && (!o.search || `${a.account_code} ${a.account_name}`.toLowerCase().includes(o.search));
  const byCode = new Map();
  for (const l of all) {
    const a = acct.get(l.account_code);
    if (!a || !keep(a)) continue;
    // A P&L account's initial balance is only this fiscal year's.
    if (PL_ROLES.has(a.role) && l.date < fyStart) continue;
    if (!byCode.has(l.account_code)) byCode.set(l.account_code, []);
    byCode.get(l.account_code).push(l);
  }
  const columns = [{ label: 'Date', type: 'date' }, { label: 'Communication', type: 'text' }, { label: 'Partner', type: 'text' },
    { label: 'Debit', type: 'money' }, { label: 'Credit', type: 'money' }, { label: 'Balance', type: 'money' }];
  const { lines, add } = lineMaker();
  const expandOne = async (code, parentId) => {
    const ls = (byCode.get(code) || []).slice().sort((a, b) => a.date.localeCompare(b.date) || String(a.source_no).localeCompare(String(b.source_no)));
    const before = ls.filter((l) => l.date < o.date_from);
    const inP = ls.filter((l) => l.date >= o.date_from);
    const partner = await partnersFor(inP);
    let bal = before.reduce((s, l) => s + l.debit - l.credit, 0);
    const out = [];
    const { add: addChild } = { add: (x) => { const line = { id: x.id, parent: parentId, level: 1, name: x.name, values: x.values, style: x.style || 'line', unfoldable: false, folded: false, lazy: false, link: x.link || null, action: null, code: null }; out.push(line); return line; } };
    if (before.length) addChild({ id: `${parentId}-init`, name: 'Initial Balance', values: ['', '', '', r2(before.reduce((s, l) => s + l.debit, 0)), r2(before.reduce((s, l) => s + l.credit, 0)), r2(bal)], style: 'initial' });
    inP.forEach((l, i) => {
      bal += l.debit - l.credit;
      addChild({ id: `${parentId}-${i}`, name: docName(l), values: [l.date, l.memo || '', partner(l)?.name || '', r2(l.debit), r2(l.credit), r2(bal)], link: linkFor(l.source_type, l.source_id) });
    });
    return out;
  };
  if (o.expand) return { lines: await expandOne(o.expand.replace(/^acct:/, ''), o.expand) };
  const totals = [0, 0];
  for (const a of accounts) {
    const ls = byCode.get(a.account_code);
    if (!ls) continue;
    const d = ls.reduce((s, l) => s + l.debit, 0);
    const c = ls.reduce((s, l) => s + l.credit, 0);
    totals[0] += d; totals[1] += c;
    const id = `acct:${a.account_code}`;
    const folded = !(o.unfold_all || o.account);
    add({ id, name: `${a.account_code} ${a.account_name}`, code: a.account_code, values: ['', '', '', r2(d), r2(c), r2(d - c)], style: 'account', unfoldable: true, folded, lazy: folded });
    if (!folded) lines.push(...await expandOne(a.account_code, id));
  }
  add({ name: 'Total', style: 'grand', values: ['', '', '', r2(totals[0]), r2(totals[1]), r2(totals[0] - totals[1])] });
  return { title, columns, lines };
}

// ---- Partner Ledger -----------------------------------------------------------
async function partnerLedger(o) {
  const [accounts, all] = await Promise.all([loadAccounts(), ledger(o, o.date_to)]);
  const roles = o.partner_type === 'receivable' ? ['receivable'] : o.partner_type === 'payable' ? ['payable'] : ['receivable', 'payable'];
  const acct = new Map(accounts.map((a) => [a.account_code, a]));
  const mine = all.filter((l) => roles.includes(acct.get(l.account_code)?.role));
  const partner = await partnersFor(mine);
  const byP = new Map();
  for (const l of mine) {
    const p = partner(l) || { key: 'none', name: 'Unknown Partner' };
    if (o.search && !p.name.toLowerCase().includes(o.search)) continue;
    if (!byP.has(p.key)) byP.set(p.key, { name: p.name, lines: [] });
    byP.get(p.key).lines.push(l);
  }
  const columns = [{ label: 'Journal', type: 'text' }, { label: 'Account', type: 'text' }, { label: 'Date', type: 'date' },
    { label: 'Debit', type: 'money' }, { label: 'Credit', type: 'money' }, { label: 'Balance', type: 'money' }];
  const childLines = (key, parentId) => {
    const g = byP.get(key);
    if (!g) return [];
    const ls = g.lines.slice().sort((a, b) => a.date.localeCompare(b.date) || String(a.source_no).localeCompare(String(b.source_no)));
    const before = ls.filter((l) => l.date < o.date_from);
    let bal = before.reduce((s, l) => s + l.debit - l.credit, 0);
    const out = [];
    const mk = (id, name, values, style, link) => out.push({ id, parent: parentId, level: 1, name, values, style, unfoldable: false, folded: false, lazy: false, link: link || null, action: null, code: null });
    if (before.length) mk(`${parentId}-init`, 'Initial Balance', ['', '', '', r2(before.reduce((s, l) => s + l.debit, 0)), r2(before.reduce((s, l) => s + l.credit, 0)), r2(bal)], 'initial');
    ls.filter((l) => l.date >= o.date_from).forEach((l, i) => {
      bal += l.debit - l.credit;
      mk(`${parentId}-${i}`, docName(l), [JOURNAL_LABEL.get(journalOf(l.source_type)), l.account_code, l.date, r2(l.debit), r2(l.credit), r2(bal)], 'line', linkFor(l.source_type, l.source_id));
    });
    return out;
  };
  if (o.expand) return { lines: childLines(o.expand.replace(/^p:/, ''), o.expand) };
  const { lines, add } = lineMaker();
  const totals = [0, 0];
  const sorted = [...byP.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  for (const [key, g] of sorted) {
    const d = g.lines.reduce((s, l) => s + l.debit, 0);
    const c = g.lines.reduce((s, l) => s + l.credit, 0);
    if (o.hide_zero && Math.abs(d - c) < 0.005) continue;
    totals[0] += d; totals[1] += c;
    const id = `p:${key}`;
    add({ id, name: g.name, values: ['', '', '', r2(d), r2(c), r2(d - c)], style: 'account', unfoldable: true, folded: !o.unfold_all, lazy: !o.unfold_all });
    if (o.unfold_all) lines.push(...childLines(key, id));
  }
  add({ name: 'Total', style: 'grand', values: ['', '', '', r2(totals[0]), r2(totals[1]), r2(totals[0] - totals[1])] });
  return { title: 'Partner Ledger', columns, lines };
}

// ---- Aged Receivable / Aged Payable -----------------------------------------------------------
async function aged(o, payable) {
  const scope = await scopeFor(o);
  const filters = scope ? (scope.locationId ? { locationId: scope.locationId } : { companyId: scope.companyId }) : {};
  // AP's collector returns { items, ... }; AR's the items themselves.
  const got = payable
    ? await require('./apAging').collectOpenApItems(o.date_to, filters)
    : await require('./arAging').collectOpenItems(o.date_to, filters);
  const items = Array.isArray(got) ? got : (got.items || []);
  const asOf = o.date_to;
  const bucket = (agingDate) => {
    const od = Math.round((Date.parse(asOf) - Date.parse(d10(agingDate) || asOf)) / 86400000);
    if (od <= 0) return 0; if (od <= 30) return 1; if (od <= 60) return 2; if (od <= 90) return 3; if (od <= 120) return 4; return 5;
  };
  const columns = [{ label: 'Invoice Date', type: 'date' }, { label: 'Due Date', type: 'date' }, { label: `At ${niceDate(asOf)}`, type: 'money' },
    { label: '1-30', type: 'money' }, { label: '31-60', type: 'money' }, { label: '61-90', type: 'money' }, { label: '91-120', type: 'money' },
    { label: 'Older', type: 'money' }, { label: 'Total', type: 'money' }];
  const byP = new Map();
  for (const it of items) {
    if (Math.abs(Number(it.balance) || 0) < 0.005) continue;
    const name = payable ? it.supplier_name : it.customer_name;
    if (o.search && !String(name || '').toLowerCase().includes(o.search)) continue;
    const key = payable ? (it.supplier_id || name) : (it.customer_id || name);
    if (!byP.has(key)) byP.set(key, { name: name || 'Unknown', items: [] });
    byP.get(key).items.push(it);
  }
  const { lines, add } = lineMaker();
  const total = [0, 0, 0, 0, 0, 0, 0];
  const typeKey = { 'Invoice': 'sales_invoice', 'Credit Memo': 'credit_memo', 'Unapplied Payment': payable ? 'bill_payment' : 'customer_payment', 'Vendor Bill': 'vendor_bill', 'Bill Credit': 'bill_credit' };
  for (const [key, g] of [...byP.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    const v = [0, 0, 0, 0, 0, 0, 0];
    for (const it of g.items) { v[bucket(it.aging_date || it.date)] += Number(it.balance); v[6] += Number(it.balance); }
    v.forEach((x, i) => { total[i] += x; });
    const p = add({ id: `p:${key}`, name: g.name, values: ['', '', ...v.map(r2)], style: 'account', unfoldable: true, folded: !o.unfold_all });
    for (const it of g.items.sort((a, b) => d10(a.date).localeCompare(d10(b.date)))) {
      const iv = [0, 0, 0, 0, 0, 0, 0];
      iv[bucket(it.aging_date || it.date)] = r2(it.balance); iv[6] = r2(it.balance);
      add({ parent: p.id, level: 1, name: `${it.reference || ''}${it.type && it.type !== 'Invoice' && it.type !== 'Vendor Bill' ? ` (${it.type})` : ''}`,
        values: [d10(it.date), it.due_date ? d10(it.due_date) : '', ...iv], link: linkFor(typeKey[it.type], it.id) });
    }
  }
  add({ name: 'Total', style: 'grand', values: ['', '', ...total.map(r2)] });
  return { title: payable ? 'Aged Payable' : 'Aged Receivable', single: true, columns, lines };
}

// ---- Journal Audit -----------------------------------------------------------
async function journalAudit(o) {
  const [accounts, all] = await Promise.all([loadAccounts(), ledger(o, o.date_to, o.date_from)]);
  const acct = new Map(accounts.map((a) => [a.account_code, a]));
  const inP = all.filter((l) => within(l, o.date_from, o.date_to));
  const byJ = new Map();
  for (const l of inP) {
    const j = journalOf(l.source_type);
    if (!byJ.has(j)) byJ.set(j, new Map());
    const m = byJ.get(j); const k = moveKey(l);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(l);
  }
  const columns = [{ label: 'Account', type: 'text' }, { label: 'Label', type: 'text' }, { label: 'Debit', type: 'money' }, { label: 'Credit', type: 'money' }];
  const children = (j, parentId) => {
    const out = [];
    const moves = [...(byJ.get(j)?.values() || [])].sort((a, b) => a[0].date.localeCompare(b[0].date) || String(a[0].source_no).localeCompare(String(b[0].source_no)));
    moves.forEach((ls, mi) => {
      const f = ls[0];
      out.push({ id: `${parentId}-m${mi}`, parent: parentId, level: 1, name: `${f.date}  ${f.source_no || DOC_LABEL[f.source_type] || ''}`, values: ['', f.memo || '', r2(ls.reduce((s, l) => s + l.debit, 0)), r2(ls.reduce((s, l) => s + l.credit, 0))], style: 'move', unfoldable: false, folded: false, lazy: false, link: linkFor(f.source_type, f.source_id), action: null, code: null });
      ls.forEach((l, li) => out.push({ id: `${parentId}-m${mi}-${li}`, parent: parentId, level: 2, name: '', values: [`${l.account_code} ${acct.get(l.account_code)?.account_name || l.account_name || ''}`, '', r2(l.debit), r2(l.credit)], style: 'line', unfoldable: false, folded: false, lazy: false, link: null, action: null, code: null }));
    });
    return out;
  };
  if (o.expand) return { lines: children(o.expand.replace(/^j:/, ''), o.expand) };
  const { lines, add } = lineMaker();
  for (const j of JOURNALS) {
    const m = byJ.get(j.key);
    if (!m) continue;
    const ls = [...m.values()].flat();
    const id = `j:${j.key}`;
    add({ id, name: `${j.label} (${m.size} entries)`, values: ['', '', r2(ls.reduce((s, l) => s + l.debit, 0)), r2(ls.reduce((s, l) => s + l.credit, 0))], style: 'section', unfoldable: true, folded: !o.unfold_all, lazy: !o.unfold_all });
    if (o.unfold_all) lines.push(...children(j.key, id));
  }
  // Odoo closes the Journal Audit with the tax summary: the tax accounts' movements in the period.
  const taxCodes = accounts.filter((a) => /\b(vat|tax)\b/i.test(a.account_name) && !a.is_summary).map((a) => a.account_code);
  if (taxCodes.length) {
    const t = add({ name: 'Tax summary', style: 'section', values: ['', '', null, null], unfoldable: true, folded: false });
    for (const c of taxCodes) {
      const ls = inP.filter((l) => l.account_code === c);
      if (!ls.length) continue;
      add({ parent: t.id, level: 1, name: '', values: [`${c} ${acct.get(c).account_name}`, '', r2(ls.reduce((s, l) => s + l.debit, 0)), r2(ls.reduce((s, l) => s + l.credit, 0))], style: 'account' });
    }
  }
  return { title: 'Journal Audit', columns, lines };
}

// ---- Invoice Analysis -----------------------------------------------------------
const GROUPS = {
  customer: { label: 'Customer', sql: 'COALESCE(c.name, \'(no customer)\')' },
  supplier: { label: 'Vendor', sql: 'COALESCE(s.name, \'(no vendor)\')' },
  product: { label: 'Product', sql: 'COALESCE(i.display_name, NULLIF(l.description, \'\'), \'(no product)\')' },
  category: { label: 'Product Category', sql: 'COALESCE(NULLIF(l.pos_category, \'\'), \'(none)\')' },
  branch: { label: 'Branch', sql: 'COALESCE(loc.location_name, \'(no branch)\')' },
  month: { label: 'Month', sql: 'DATE_FORMAT(h.date_created, \'%Y-%m\')' },
  salesperson: { label: 'Salesperson', sql: 'COALESCE(rep.name, \'(none)\')' },
  status: { label: 'Status', sql: 'h.status' },
};
async function invoiceAnalysis(o) {
  const vendor = o.move_type === 'vendor';
  const scope = await scopeFor(o);
  const allowed = vendor ? ['supplier', 'product', 'branch', 'month', 'status'] : ['customer', 'product', 'category', 'branch', 'month', 'salesperson', 'status'];
  const g1 = allowed.includes(o.group_by) ? o.group_by : (vendor ? 'supplier' : 'customer');
  const g2 = allowed.includes(o.group_by2) && o.group_by2 !== g1 ? o.group_by2 : null;
  const where = ['h.date_created >= ?', 'h.date_created <= ?', "h.status NOT IN ('void', 'voided', 'cancelled')"];
  const params = [o.date_from, `${o.date_to} 23:59:59`];
  if (scope) { where.push(`h.office_location_id IN (${[...scope.locationIds].map(Number).join(',') || 'NULL'})`); }
  const g2sql = g2 ? GROUPS[g2].sql : "''";
  const sql = vendor
    ? `SELECT ${GROUPS[g1].sql} g1, ${g2sql} g2, COUNT(DISTINCT h.id) docs, SUM(l.qty) qty, SUM(l.net_of_tax) untaxed, SUM(l.tax_amount) tax, SUM(l.ext_price) total
         FROM vendor_bills h JOIN vendor_bill_lines l ON l.vendor_bill_id = h.id LEFT JOIN suppliers s ON s.id = h.supplier_id
         LEFT JOIN inventories i ON i.id = l.item_id LEFT JOIN locations loc ON loc.id = h.office_location_id
        WHERE ${where.join(' AND ')} GROUP BY g1, g2 ORDER BY g1, g2`
    : `SELECT ${GROUPS[g1].sql} g1, ${g2sql} g2, COUNT(DISTINCT h.id) docs, SUM(l.quantity) qty, SUM(l.net_of_tax) untaxed, SUM(l.tax_amount) tax, SUM(l.gross_amount) total
         FROM sales_invoices h JOIN sales_invoice_lines l ON l.sales_invoice_id = h.id
         LEFT JOIN customers c ON c.id = h.customer_id LEFT JOIN inventories i ON i.id = l.item_id
         LEFT JOIN locations loc ON loc.id = h.office_location_id LEFT JOIN employees rep ON rep.id = h.sales_rep_id
        WHERE ${where.join(' AND ')} GROUP BY g1, g2 ORDER BY g1, g2`;
  const [rows] = await pool.query(sql.replace('rep.name', "TRIM(CONCAT(COALESCE(rep.first_name,''),' ',COALESCE(rep.last_name,'')))"), params);
  const columns = [{ label: vendor ? '# Bills' : '# Invoices', type: 'number' }, { label: 'Quantity', type: 'number' },
    { label: 'Untaxed Total', type: 'money' }, { label: 'Tax', type: 'money' }, { label: 'Total', type: 'money' }];
  const { lines, add } = lineMaker();
  const groups = new Map();
  for (const r of rows) {
    if (o.search && !`${r.g1} ${r.g2}`.toLowerCase().includes(o.search)) continue;
    if (!groups.has(r.g1)) groups.set(r.g1, []);
    groups.get(r.g1).push(r);
  }
  const t = [0, 0, 0, 0, 0];
  const v = (rs) => [rs.reduce((s, r) => s + Number(r.docs), 0), r2(rs.reduce((s, r) => s + Number(r.qty || 0), 0)),
    r2(rs.reduce((s, r) => s + Number(r.untaxed || 0), 0)), r2(rs.reduce((s, r) => s + Number(r.tax || 0), 0)), r2(rs.reduce((s, r) => s + Number(r.total || 0), 0))];
  for (const [name, rs] of groups) {
    const gv = v(rs);
    gv.forEach((x, i) => { t[i] += x; });
    const g = add({ name: String(name), values: gv, style: 'account', unfoldable: !!g2, folded: !o.unfold_all });
    if (g2) for (const r of rs) add({ parent: g.id, level: 1, name: String(r.g2), values: v([r]) });
  }
  add({ name: 'Total', style: 'grand', values: t.map(r2) });
  return { title: vendor ? 'Vendor Bill Analysis' : 'Invoice Analysis', columns, lines, groupOptions: allowed.map((k) => ({ key: k, label: GROUPS[k].label })), group_by: g1, group_by2: g2 || '' };
}

// ---- Audit Trail -----------------------------------------------------------
async function auditTrail(o) {
  const [rows] = await pool.query(
    `SELECT a.auditable_type, a.auditable_id, a.event_type, a.field_name, a.old_value, a.new_value, a.set_at,
            COALESCE(u.display_name, u.username) user_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
      WHERE a.set_at >= ? AND a.set_at <= ? ORDER BY a.set_at DESC, a.id DESC LIMIT 5000`, [o.date_from, `${o.date_to} 23:59:59`]);
  // CamelCase model -> document type (VendorBill -> vendor_bill), and its number.
  const snake = (s) => String(s).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  const wanted = new Map();
  for (const r of rows) {
    const t = snake(r.auditable_type);
    if (!DOCS[t]) continue;
    if (!wanted.has(t)) wanted.set(t, new Set());
    wanted.get(t).add(r.auditable_id);
  }
  const numbers = new Map();
  for (const [t, ids] of wanted) {
    try {
      const [docs] = await pool.query(`SELECT id, ${DOCS[t].no} no FROM ${DOCS[t].table} WHERE id IN (?)`, [[...ids]]);
      for (const d of docs) numbers.set(`${t}:${d.id}`, d.no);
    } catch { /* */ }
  }
  const columns = [{ label: 'Date', type: 'text' }, { label: 'Event', type: 'text' }, { label: 'Changes', type: 'text' }, { label: 'User', type: 'text' }];
  const { lines, add } = lineMaker();
  for (const r of rows) {
    const t = snake(r.auditable_type);
    const label = `${DOC_LABEL[t] || r.auditable_type} ${numbers.get(`${t}:${r.auditable_id}`) || `#${r.auditable_id}`}`;
    if (o.search && !`${label} ${r.user_name} ${r.field_name || ''}`.toLowerCase().includes(o.search)) continue;
    const ch = r.field_name ? `${r.field_name}: ${r.old_value ?? ''} → ${r.new_value ?? ''}` : (r.new_value || '');
    const when = r.set_at instanceof Date ? new Date(r.set_at.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ') : String(r.set_at).slice(0, 16);
    add({ name: label, values: [when, r.event_type, String(ch).slice(0, 300), r.user_name || ''], link: linkFor(t, r.auditable_id) });
  }
  return { title: 'Audit Trail', columns, lines };
}

/* ================================================================== registry */

const REPORTS = {
  balance_sheet: { single: true, run: balanceSheet, comparison: true, hierarchy: true },
  profit_loss: { run: profitLoss, comparison: true, hierarchy: true },
  cash_flow: { run: cashFlow, comparison: true },
  executive_summary: { run: executiveSummary, comparison: true, journals: false },
  general_ledger: { run: (o) => generalLedger(o), search: true },
  trial_balance: { run: trialBalance, comparison: true, search: true },
  journal_audit: { run: journalAudit },
  check_register: { run: (o) => generalLedger(o, { cashOnly: true, title: 'Check Register' }), search: true },
  partner_ledger: { run: partnerLedger, search: true, partnerType: true },
  aged_receivable: { single: true, run: (o) => aged(o, false), search: true, journals: false },
  aged_payable: { single: true, run: (o) => aged(o, true), search: true, journals: false },
  invoice_analysis: { run: invoiceAnalysis, search: true, journals: false, groupBy: true },
  audit_trail: { run: auditTrail, search: true, journals: false, branch: false },
};

async function runReport(key, query) {
  const def = REPORTS[key];
  if (!def) { const e = new Error(`Unknown report ${key}`); e.status = 404; throw e; }
  const o = parseOptions(query, !!def.single);
  const out = await def.run(o);
  if (o.expand) return out; // just the children of one folded line
  if (o.hide_zero) out.lines = hideZero(out.lines);
  const scope = await scopeFor(o);
  return {
    key, ...out,
    options: { ...o, expand: undefined },
    features: {
      single: !!def.single, comparison: !!def.comparison, hierarchy: !!def.hierarchy, search: !!def.search,
      journals: def.journals !== false, branch: def.branch !== false, partnerType: !!def.partnerType, groupBy: !!def.groupBy,
    },
    journals: JOURNALS.map(({ key: k, label }) => ({ key: k, label })),
    scope_label: scope ? scope.label : null,
  };
}

// The report as an .xlsx, every line unfolded (folded-on-demand lines fetched too).
async function reportXlsx(key, query) {
  const report = await runReport(key, { ...query, unfold_all: '1' });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(report.title.slice(0, 31));
  const o = report.options;
  ws.addRow([report.title]).font = { bold: true, size: 14 };
  ws.addRow([`${report.scope_label || 'Wu Venture (all companies)'} — ${o.date_from ? `${o.date_from} to ` : 'As of '}${o.date_to}`]);
  ws.addRow([]);
  if (report.grouped) ws.addRow(['', ...report.columns.map((c) => c.label)]).font = { bold: true };
  ws.addRow(['', ...report.columns.map((c) => (report.grouped ? c.group : c.label))]).font = { bold: true };
  for (const l of report.lines) {
    const row = ws.addRow([`${'    '.repeat(l.level)}${l.name}`, ...l.values.map((v) => (v === null ? '' : v))]);
    if (['title', 'section', 'total', 'grand'].includes(l.style)) row.font = { bold: true };
    report.columns.forEach((c, i) => { if (c.type === 'money') row.getCell(i + 2).numFmt = '#,##0.00;(#,##0.00)'; });
  }
  ws.getColumn(1).width = 50;
  report.columns.forEach((_, i) => { ws.getColumn(i + 2).width = 16; });
  return { buffer: await wb.xlsx.writeBuffer(), filename: `${report.title.replace(/[^\w]+/g, '_')}_${o.date_to}.xlsx` };
}

module.exports = { runReport, reportXlsx, REPORTS, roleOf, buildPeriods, parseOptions };
