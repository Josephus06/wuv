const pool = require('../db');
const { getPostedGlLines } = require('./glImpact');
const { filterLines, scopeInfo, companyByLocation } = require('./companyScope');

// The posted GL lines, cut down to a company / branch scope (lib/companyScope.js resolveScope;
// null = the consolidated Wu Ventures view). The count of lines dropped for having no branch rides
// along as .unassigned, for the report to say so.
async function scopedPosted(range, scope) {
  const { lines, unassigned } = filterLines(await getPostedGlLines(range), scope);
  lines.unassigned = unassigned;
  return lines;
}
const { splitSourceLinesByDepartment, splitSourceLinesByLocation, booksStart } = require('./openingBalances');
const { departmentLedger, accountLedger, pool4 } = require('./sourceLedger');
const { linkFor, linksForNumbers } = require('./docLinks');
const { displayMonth } = require('./dates');

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Account the balance sheet folds prior-years unclosed earnings into (see buildBalanceSheet).
const RETAINED_EARNINGS_CODE = '29000';

// The Total column a department / location / month breakdown ends with (buildIncomeStatement), and
// the drill-down's key for it (buildGlTransactions). Not a department or location id, nor a month.
const TOTAL_COLUMN_KEY = '__total';

function yearStart(dateStr) {
  return `${String(dateStr).slice(0, 4)}-01-01`;
}

// Loads the full Chart of Accounts once, joined to chart_of_account_types for the
// account_type / account_sub_type / normal_balance grouping the real system's reports
// use (matches ASSET/LIABILITY/EQUITY/INCOME/EXPENSE + their sub_types exactly).
// Deliberately NOT filtered by is_active: this build's migrated COA data has that flag
// set to 0 on core, actively-posted accounts (Accounts Receivable Trade, Sales,
// Accounts Payable - Trade, VAT on Sales, Inventory In Transit all check in as
// is_active=0) -- it doesn't reliably mean "unusable" here, and excluding those
// accounts would silently drop real GL lines out of every report's totals.
//
// exclude_from_reports keeps an account out of EVERY report at once. Only the bank suspense
// account carries it: statement items with no document are parked there, and they were not to
// appear in the financial statements. Filtering here rather than in each report is deliberate --
// this is the one door Trial Balance, Balance Sheet, Income Statement, General Ledger and the GL
// drill-down all come through, so the next report anyone writes inherits the rule instead of
// having to remember it.
//
// THE COST, so it is not a surprise later: the excluded account's other half is still posted to
// the bank, so the Balance Sheet no longer foots and the Trial Balance no longer ties -- both are
// out by whatever is parked in suspense. See src/db/add-account-exclude-from-reports.js.
async function loadCoa() {
  const [rows] = await pool.query(
    `SELECT coa.id, coa.account_code, coa.account_name, coa.parent_account_id, coa.is_summary, coa.coa_type_id,
            t.account_type, t.account_sub_type, t.normal_balance
     FROM chart_of_accounts coa
     LEFT JOIN chart_of_account_types t ON t.id = coa.coa_type_id
     WHERE coa.exclude_from_reports = 0
     ORDER BY coa.account_code`
  );
  return rows;
}

// Nets every posted GL line (debit - credit, raw signed) per account_code. This raw
// figure is additive regardless of an account's normal side, which is what makes the
// parent/child rollup below correct: a subtree's total is just the sum of its raw
// signed balances, and the normal-side sign flip (for display only) is applied once,
// after rollup, using the root's own normal_balance.
function netBalancesByCode(glLines) {
  const balances = new Map();
  for (const l of glLines) {
    const prev = balances.get(l.account_code) || 0;
    balances.set(l.account_code, prev + (Number(l.debit) || 0) - (Number(l.credit) || 0));
  }
  return balances;
}

// Builds the parent/child COA tree (mirrors chart_of_accounts.parent_account_id),
// attaching each node's own net raw balance and recursively rolling children's
// balances into their parents -- the same "summary account = sum of its children"
// rule confirmed against the real system's Trial Balance/Balance Sheet payloads.
function buildTree(coaRows, balances) {
  const byId = new Map(coaRows.map((c) => [c.id, {
    ...c, children: [], rawAmount: balances.get(c.account_code) || 0,
  }]));
  const roots = [];
  for (const node of byId.values()) {
    if (node.parent_account_id && byId.has(node.parent_account_id)) {
      byId.get(node.parent_account_id).children.push(node);
    } else if (!node.parent_account_id) {
      roots.push(node);
    }
  }
  function rollup(node) {
    let sum = node.rawAmount;
    for (const c of node.children) sum += rollup(c);
    node.rawAmount = sum;
    return sum;
  }
  roots.forEach(rollup);
  return roots;
}

function serializeNode(node, sign) {
  return {
    account_code: node.account_code,
    account_name: node.account_name,
    is_summary: !!node.is_summary,
    amount: round2(node.rawAmount * sign),
    children: node.children.map((c) => serializeNode(c, sign)),
  };
}

// Groups root (top-level, no parent) accounts into normal_balance -> account_type ->
// account_sub_type buckets -- the same 3-level grouping the real Trial Balance/Balance
// Sheet responses use. `typeFilter`, when given, keeps only those account_types
// (Balance Sheet excludes INCOME/EXPENSE; Trial Balance keeps everything).
function groupRoots(roots, { typeFilter } = {}) {
  const byNormal = new Map();
  for (const root of roots) {
    if (!root.account_type || !root.normal_balance) continue;
    if (typeFilter && !typeFilter.includes(root.account_type)) continue;
    const sign = root.normal_balance === 'CREDIT' ? -1 : 1;
    if (!byNormal.has(root.normal_balance)) byNormal.set(root.normal_balance, new Map());
    const byType = byNormal.get(root.normal_balance);
    if (!byType.has(root.account_type)) byType.set(root.account_type, new Map());
    const bySub = byType.get(root.account_type);
    const subKey = root.account_sub_type || 'OTHER';
    if (!bySub.has(subKey)) bySub.set(subKey, []);
    bySub.get(subKey).push(serializeNode(root, sign));
  }

  const data = [];
  let debitTotal = 0;
  let creditTotal = 0;
  for (const [normal, byType] of byNormal) {
    for (const [type, bySub] of byType) {
      const accounts = [];
      for (const [subType, ledgers] of bySub) {
        accounts.push({ sub_type: subType, account_ledgers: ledgers });
        const subTotal = ledgers.reduce((s, l) => s + l.amount, 0);
        if (normal === 'DEBIT') debitTotal += subTotal; else creditTotal += subTotal;
      }
      data.push({ normal, type, accounts });
    }
  }
  return { data, debitTotal: round2(debitTotal), creditTotal: round2(creditTotal) };
}

// Trial Balance: every account type, "as of" a single cutoff date. `balanced` is the
// core correctness check for this whole GL Impact + Reports effort -- it can only be
// true if every one of the 8 transaction types' GL postings are genuinely double-entry.
async function buildTrialBalance(asOfDate, scope = null) {
  const [coaRows, glLines] = await Promise.all([loadCoa(), scopedPosted({ toDate: asOfDate }, scope)]);
  const balances = netBalancesByCode(glLines);
  const roots = buildTree(coaRows, balances);
  const { data, debitTotal, creditTotal } = groupRoots(roots);
  return {
    as_of: asOfDate, data, debit_total: debitTotal, credit_total: creditTotal,
    balanced: Math.abs(debitTotal - creditTotal) < 0.01,
    ...scopeInfo(scope, glLines.unassigned),
  };
}

// Balance Sheet: ASSET/LIABILITY/EQUITY only, same "as of" point-in-time semantics as
// Trial Balance, plus a synthetic "Current Earnings" line under Equity (cumulative
// INCOME - cumulative EXPENSE to date) -- this build has no formal period-closing
// entries, so without this line the sheet would never actually balance. Documented
// simplification, not a real posted account.
async function buildBalanceSheet(asOfDate, scope = null) {
  const [coaRows, glLines] = await Promise.all([loadCoa(), scopedPosted({ toDate: asOfDate }, scope)]);
  const balances = netBalancesByCode(glLines);
  const roots = buildTree(coaRows, balances);

  const earningsOf = (rs) => {
    let income = 0;
    let expense = 0;
    for (const root of rs) {
      if (root.account_type === 'INCOME') income += root.rawAmount * -1;
      if (root.account_type === 'EXPENSE') expense += root.rawAmount * 1;
    }
    return income - expense;
  };
  const totalEarnings = round2(earningsOf(roots));

  // Presented the way the source's balance sheet does: profit from before this year sits in
  // Retained Earnings, only this year's shows as Current Year Earnings. Nothing is ever closed
  // (neither here nor in the source), so without this split all profit since inception landed on
  // one line and Retained Earnings read 24.4M off the source's at 2025-12-31 -- same total equity,
  // different lines.
  const ys = yearStart(asOfDate);
  const priorEarnings = round2(earningsOf(buildTree(coaRows, netBalancesByCode(glLines.filter((l) => String(l.entry_date).slice(0, 10) < ys)))));
  const currentEarnings = round2(totalEarnings - priorEarnings);

  const { data, debitTotal, creditTotal } = groupRoots(roots, { typeFilter: ['ASSET', 'LIABILITY', 'EQUITY'] });
  const equityBucket = data.find((d) => d.type === 'EQUITY');
  let reNode = null;
  const findRe = (nodes) => { for (const n of nodes || []) { if (n.account_code === RETAINED_EARNINGS_CODE) reNode = n; findRe(n.children); } };
  for (const g of data) for (const a of g.accounts || []) findRe(a.account_ledgers);
  if (reNode && priorEarnings) {
    reNode.amount = round2(Number(reNode.amount || 0) + priorEarnings);
  } else if (priorEarnings) {
    const prior = { account_code: 'PRIOR-EARNINGS', account_name: 'Retained Earnings (prior years, unclosed)', is_summary: false, amount: priorEarnings, children: [] };
    if (equityBucket) {
      if (!equityBucket.accounts.length) equityBucket.accounts.push({ sub_type: 'EQUITIES', account_ledgers: [] });
      equityBucket.accounts[0].account_ledgers.push(prior);
    }
  }
  const earningsNode = {
    account_code: 'CURRENT-EARNINGS', account_name: 'Current Year Earnings',
    is_summary: false, amount: currentEarnings, children: [],
  };
  if (equityBucket) {
    if (!equityBucket.accounts.length) equityBucket.accounts.push({ sub_type: 'EQUITIES', account_ledgers: [] });
    equityBucket.accounts[0].account_ledgers.push(earningsNode);
  } else {
    data.push({ normal: 'CREDIT', type: 'EQUITY', accounts: [{ sub_type: 'EQUITIES', account_ledgers: [earningsNode] }] });
  }
  // creditTotal was summed before prior-years earnings were added to the RE line, so add ALL earnings.
  const finalCreditTotal = round2(creditTotal + totalEarnings);

  return {
    as_of: asOfDate, data,
    asset_total: debitTotal, liability_equity_total: finalCreditTotal,
    current_earnings: currentEarnings,
    balanced: Math.abs(debitTotal - finalCreditTotal) < 0.01,
    ...scopeInfo(scope, glLines.unassigned),
  };
}

const INCOME_SECTION_ORDER = ['REVENUES', 'OTHER INCOME'];
const EXPENSE_SECTION_ORDER = ['COST OF GOOD SOLDS', 'COST OF SERVICES', 'OPERATING EXPENSES', 'NON-OPERATING EXPENSES', 'OTHER EXPENSE', 'EXPENSE'];

// Multi-column variants of buildTree/serializeNode/section-grouping, used only by
// Income Statement's breakdown modes (Months/Location/Department) -- Trial
// Balance/Balance Sheet/General Ledger stay single-column via the originals above.
// Each node carries one raw amount per column/partition instead of a single number,
// rolled up in parallel so every column shares the exact same account tree/ordering.
function buildTreeMulti(coaRows, balanceMaps) {
  const byId = new Map(coaRows.map((c) => [c.id, {
    ...c, children: [], rawAmounts: balanceMaps.map((m) => m.get(c.account_code) || 0),
  }]));
  const roots = [];
  for (const node of byId.values()) {
    if (node.parent_account_id && byId.has(node.parent_account_id)) {
      byId.get(node.parent_account_id).children.push(node);
    } else if (!node.parent_account_id) {
      roots.push(node);
    }
  }
  function rollup(node) {
    let sums = node.rawAmounts.slice();
    for (const c of node.children) {
      const childSums = rollup(c);
      sums = sums.map((s, i) => s + childSums[i]);
    }
    node.rawAmounts = sums;
    return sums;
  }
  roots.forEach(rollup);
  return roots;
}

function serializeNodeMulti(node, sign) {
  return {
    account_code: node.account_code,
    account_name: node.account_name,
    is_summary: !!node.is_summary,
    amounts: node.rawAmounts.map((a) => round2(a * sign)),
    children: node.children.map((c) => serializeNodeMulti(c, sign)),
  };
}

function buildIncomeSectionMulti(roots, accountType, sectionOrder, sign, numCols) {
  const bySub = new Map();
  for (const root of roots) {
    if (root.account_type !== accountType || !root.account_sub_type) continue;
    if (!bySub.has(root.account_sub_type)) bySub.set(root.account_sub_type, []);
    bySub.get(root.account_sub_type).push(serializeNodeMulti(root, sign));
  }
  const sections = [];
  const totals = new Array(numCols).fill(0);
  const order = [...sectionOrder, ...[...bySub.keys()].filter((k) => !sectionOrder.includes(k))];
  for (const subType of order) {
    const accounts = bySub.get(subType);
    if (!accounts || !accounts.length) continue;
    const subtotals = new Array(numCols).fill(0);
    for (const a of accounts) a.amounts.forEach((v, i) => { subtotals[i] += v; });
    const subtotalsRounded = subtotals.map(round2);
    sections.push({ sub_type: subType, accounts, subtotals: subtotalsRounded });
    subtotalsRounded.forEach((v, i) => { totals[i] += v; });
  }
  return { sections, totals: totals.map(round2) };
}

// Splits the period's GL lines into the columns for a given breakdown mode -- 'total'
// (the default, one column), 'months' (one column per calendar month spanned by the
// period), 'location'/'department' (one column per distinct value seen on the
// transactions themselves, plus an "Unassigned" column for lines with no value --
// Inventory Adjustment's location/department is approximated from its first line since
// this build's GL lines are posted per-transaction, not per-line; see glImpact.js).
function partitionGlLines(glLines, breakdown, fromDate, asOfDate) {
  if (breakdown === 'months') {
    const start = new Date(fromDate);
    const end = new Date(asOfDate);
    const months = [];
    let cur = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cur <= end) {
      const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`;
      const label = displayMonth(cur); // "Sept 2026", the app-wide format (lib/dates.js)
      months.push({ key, label, lines: [] });
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
    const byKey = new Map(months.map((m) => [m.key, m]));
    for (const l of glLines) {
      const d = new Date(l.entry_date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (byKey.has(key)) byKey.get(key).lines.push(l);
    }
    return months;
  }
  if (breakdown === 'location' || breakdown === 'department' || breakdown === 'company') {
    const field = breakdown === 'location' ? 'location_id' : breakdown === 'company' ? 'company_id' : 'department_id';
    const groups = new Map();
    for (const l of glLines) {
      const key = l[field] ? String(l[field]) : 'unassigned';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(l);
    }
    return [...groups.entries()].map(([key, lines]) => ({ key, label: null, lines }));
  }
  return [{ key: 'total', label: 'Total', lines: glLines }];
}

// Sub-departments shown as their parent in a by-department report (asked 2026-10-26): Support-IT,
// Support-System, Support-Technical, Support-Costing and Support-Operations Audit are parts of Support,
// so their amounts are lumped into its column -- T1S lines by department id, the source's months by
// name (`src:<name>`). The departments themselves stay separate everywhere else (forms, bills, budgets).
const DEPARTMENT_ROLLUP = { Support: ['Support-IT', 'Support-System', 'Support-Technical', 'Support-Costing', 'Support-Operations Audit'] };
const normDept = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
async function rollupDepartments(lines) {
  const [rows] = await pool.query('SELECT id, name FROM departments');
  const idByName = new Map(rows.map((r) => [normDept(r.name), String(r.id)]));
  const parentOf = new Map(); // child key (T1S id, or `src:` normalised name) -> parent's id
  for (const [parent, children] of Object.entries(DEPARTMENT_ROLLUP)) {
    const parentId = idByName.get(normDept(parent));
    if (!parentId) continue;
    for (const child of children) {
      const childId = idByName.get(normDept(child));
      if (childId) parentOf.set(childId, parentId);
      parentOf.set(`src:${normDept(child)}`, parentId);
    }
  }
  if (!parentOf.size) return lines;
  return lines.map((l) => {
    if (l.department_id == null) return l;
    const k = String(l.department_id);
    const parent = parentOf.get(k.startsWith('src:') ? `src:${normDept(k.slice(4))}` : k);
    return parent ? { ...l, department_id: Number(parent) } : l;
  });
}

async function resolvePartitionLabels(partitions, breakdown) {
  const table = breakdown === 'location' ? 'locations' : breakdown === 'company' ? 'companies' : 'departments';
  const nameCol = breakdown === 'location' ? 'location_name' : 'name';
  // `src:<name>`: a source-system department T1S has no record of (splitSourceLinesByDepartment).
  const ids = partitions.map((p) => p.key).filter((k) => k !== 'unassigned' && !k.startsWith('src:'));
  let names = new Map();
  if (ids.length) {
    const [rows] = await pool.query(`SELECT id, ${nameCol} AS name FROM ${table} WHERE id IN (?)`, [ids]);
    names = new Map(rows.map((r) => [String(r.id), r.name]));
  }
  const labelOf = (k) => (k === 'unassigned' ? (breakdown === 'company' ? 'No company' : 'Unassigned') : k.startsWith('src:') ? k.slice(4) : (names.get(k) || `#${k}`));
  const labeled = partitions.map((p) => ({ ...p, label: labelOf(p.key) }));
  labeled.sort((a, b) => a.label.localeCompare(b.label));
  return labeled;
}

// Income Statement: a period report (flow, not point-in-time) -- the real UI's single
// "as of" date defaults to a calendar-year-to-date period (Jan 1 through that date).
// The real system's own "Date:" filter also offers a "Period from" mode -- an explicit
// custom range instead of the YTD default -- replicated here via `fromDateOverride`.
// `breakdown` mirrors the real "Generate" split button's 4 modes (Total Only/Months/
// Location/Department): every mode shares this same multi-column pipeline, with
// 'total' simply being the one-column case, so results are always internally
// consistent with each other (e.g. summing the Months columns reproduces the Total).
// Percent-of-revenue per line/column, matching the real payload's `amounts:[[value,pct]]`.
async function buildIncomeStatement(asOfDate, fromDateOverride, breakdown = 'total', scope = null) {
  const fromDate = fromDateOverride || yearStart(asOfDate);
  const [coaRows, posted] = await Promise.all([
    loadCoa(),
    scopedPosted({ toDate: asOfDate, fromDate }, scope),
  ]);
  // Months before the cut-over are the source's trial balance; by department / location they are
  // split by the source's own department / location income statement.
  const glLines = breakdown === 'department' ? await rollupDepartments(await splitSourceLinesByDepartment(posted))
    : breakdown === 'location' ? await splitSourceLinesByLocation(posted)
      : breakdown === 'company' ? await withCompany(posted) : posted;

  let partitions = partitionGlLines(glLines, breakdown, fromDate, asOfDate);
  if (breakdown === 'location' || breakdown === 'department' || breakdown === 'company') {
    partitions = await resolvePartitionLabels(partitions, breakdown);
  }
  if (!partitions.length) partitions = [{ key: 'total', label: 'Total', lines: [] }];
  // By department / location / month: a Total column last (asked 2026-10-26) -- every column's lines
  // together, so it is the sum across the row and drills down to all of them (TOTAL_COLUMN_KEY).
  if (breakdown !== 'total') {
    partitions.push({ key: TOTAL_COLUMN_KEY, label: 'Total', lines: partitions.flatMap((p) => p.lines) });
  }
  const columns = partitions.map((p) => ({ key: p.key, label: p.label }));

  const balanceMaps = partitions.map((p) => netBalancesByCode(p.lines));
  const roots = buildTreeMulti(coaRows, balanceMaps);

  const revenue = buildIncomeSectionMulti(roots, 'INCOME', INCOME_SECTION_ORDER, -1, columns.length);
  const expense = buildIncomeSectionMulti(roots, 'EXPENSE', EXPENSE_SECTION_ORDER, 1, columns.length);
  const netIncome = revenue.totals.map((v, i) => round2(v - (expense.totals[i] || 0)));

  // Percent-of-revenue for every account AND its descendants, so the breakdown rows
  // (e.g. 30100 Sales under 30000 Revenue) carry their own percentage too.
  const addPercents = (a) => ({
    ...a,
    percents: a.amounts.map((v, i) => (revenue.totals[i] ? round2((v / revenue.totals[i]) * 100) : 0)),
    children: (a.children || []).map(addPercents),
  });
  const withPercent = (sections) => sections.map((s) => ({
    ...s,
    accounts: s.accounts.map(addPercents),
  }));

  return {
    as_of: asOfDate, from_date: fromDate, breakdown, columns,
    revenue_sections: withPercent(revenue.sections), revenue_totals: revenue.totals,
    expense_sections: withPercent(expense.sections), expense_totals: expense.totals,
    net_income: netIncome,
    ...scopeInfo(scope, posted.unassigned),
  };
}

// Each line tagged with its branch's company (company_id), for the by-company columns.
async function withCompany(lines) {
  const companyOf = await companyByLocation();
  return lines.map((l) => ({ ...l, company_id: companyOf.get(Number(l.location_id)) || null }));
}

// General Ledger: a flat per-account list (not the parent/child tree TB/BS use), each
// row carrying its own `ledgers` array of the raw GL lines that produced its balance
// (source type/no, date, memo, debit, credit, running balance) -- the real system
// fetches this on-demand via a separate "Expand" click; ours includes it inline.
//
// `fromDate` mirrors the "Period from" mode the other reports' Date filter offers. Unlike
// the Income Statement (a flow report, where a period simply narrows the window), the GL
// is a balance report -- so a period must NOT restart the running balance at zero or the
// Balance column stops meaning "this account's balance". Instead, everything posted before
// `fromDate` folds into a single opening balance and the period's own lines run on from
// there, the standard opening/activity/closing shape. That also means period mode costs no
// more than "as of" (the same single pass through asOfDate feeds both) while returning far
// fewer ledger lines.
async function buildGeneralLedger(asOfDate, fromDate = null, scope = null) {
  const [coaRows, glLines] = await Promise.all([loadCoa(), scopedPosted({ toDate: asOfDate }, scope)]);

  const linesByCode = new Map();
  for (const l of glLines) {
    if (!linesByCode.has(l.account_code)) linesByCode.set(l.account_code, []);
    linesByCode.get(l.account_code).push(l);
  }

  const rows = [];
  for (const acct of coaRows) {
    if (acct.is_summary) continue;
    const sign = acct.normal_balance === 'CREDIT' ? -1 : 1;
    const own = (linesByCode.get(acct.account_code) || [])
      .slice()
      .sort((a, b) => new Date(a.entry_date) - new Date(b.entry_date) || a.source_id - b.source_id);

    let running = 0;
    let opening = 0;
    const ledgers = [];
    for (const l of own) {
      running += ((Number(l.debit) || 0) - (Number(l.credit) || 0)) * sign;
      // Pre-period activity is carried as the opening balance, not listed line by line.
      if (fromDate && String(l.entry_date).slice(0, 10) < fromDate) { opening = running; continue; }
      ledgers.push({
        entry_date: l.entry_date, source_type: l.source_type, source_no: l.source_no,
        memo: l.memo, debit: round2(l.debit), credit: round2(l.credit), balance: round2(running),
      });
    }

    rows.push({
      account_code: acct.account_code, account_name: acct.account_name,
      normal_balance: acct.normal_balance,
      opening_balance: round2(opening), balance: round2(running), ledgers,
    });
  }
  return { as_of: asOfDate, from_date: fromDate, rows, ...scopeInfo(scope, glLines.unassigned) };
}

// The party name shown per GL line in the drill-down (customer for sales-side sources).
async function resolveGlLineNames(lines) {
  const idsByType = new Map();
  for (const l of lines) { if (!idsByType.has(l.source_type)) idsByType.set(l.source_type, new Set()); idsByType.get(l.source_type).add(l.source_id); }
  const NAME_SQL = {
    sales_invoice: 'SELECT si.id, c.name FROM sales_invoices si LEFT JOIN sales_orders so ON so.id=si.sales_order_id LEFT JOIN estimates e ON e.id=si.estimate_id LEFT JOIN non_standard_sales_orders ns ON ns.id=si.nsso_id JOIN customers c ON c.id=COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id) WHERE si.id IN (?)',
    assembly_build: 'SELECT ab.id, c.name FROM assembly_builds ab JOIN job_orders jo ON jo.id=ab.job_order_id LEFT JOIN sales_orders so ON so.id=jo.sales_order_id LEFT JOIN non_standard_sales_orders ns ON ns.id=jo.nsso_id JOIN customers c ON c.id=COALESCE(so.customer_id, ns.customer_id) WHERE ab.id IN (?)',
    item_delivery: 'SELECT del.id, c.name FROM item_deliveries del LEFT JOIN sales_orders so ON so.id=del.sales_order_id LEFT JOIN non_standard_sales_orders ns ON ns.id=del.nsso_id JOIN customers c ON c.id=COALESCE(so.customer_id, ns.customer_id) WHERE del.id IN (?)',
    customer_payment: 'SELECT cp.id, c.name FROM customer_payments cp JOIN customers c ON c.id=cp.customer_id WHERE cp.id IN (?)',
    credit_memo: 'SELECT cm.id, c.name FROM credit_memos cm JOIN sales_orders so ON so.id=cm.sales_order_id JOIN customers c ON c.id=so.customer_id WHERE cm.id IN (?)',
    delivery_ticket: 'SELECT dt.id, c.name FROM delivery_tickets dt JOIN sales_orders so ON so.id=dt.sales_order_id JOIN customers c ON c.id=so.customer_id WHERE dt.id IN (?)',
  };
  const names = new Map();
  for (const [type, ids] of idsByType) {
    const sql = NAME_SQL[type]; if (!sql || !ids.size) continue;
    try { const [rows] = await pool.query(sql, [[...ids]]); for (const r of rows) names.set(`${type}:${r.id}`, r.name); } catch { /* leave blank */ }
  }
  return names;
}

// Transaction-level drill-down behind one income-statement cell: the posted GL lines for one
// account, scoped to the clicked column (a department / location / month, or all for Total),
// over the report's period -- Trans #, date, party name, debit, credit + totals.
async function buildGlTransactions({ accountCode, breakdown = 'total', columnKey = 'total', asOfDate, fromDate, scope = null }) {
  const from = fromDate || yearStart(asOfDate);
  const [coaRows, posted] = await Promise.all([loadCoa(), scopedPosted({ toDate: asOfDate, fromDate: from }, scope)]);
  // Split in every mode but Location: a source month split by department is what lets its documents
  // be listed. By location the source's months are split by location and listed one line per month.
  // By department, sub-departments are drilled under their parent's column (rollupDepartments).
  const glLines = breakdown === 'location' ? await splitSourceLinesByLocation(posted)
    : breakdown === 'department' ? await rollupDepartments(await splitSourceLinesByDepartment(posted))
      : breakdown === 'company' ? await withCompany(posted) : await splitSourceLinesByDepartment(posted);
  const monthKey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`; };

  // A clicked account may be a summary; its transactions post to descendant leaf accounts, so
  // collect the account and all its descendants' codes.
  const target = coaRows.find((c) => c.account_code === accountCode);
  const childrenByParent = new Map();
  for (const c of coaRows) { if (c.parent_account_id != null) { if (!childrenByParent.has(c.parent_account_id)) childrenByParent.set(c.parent_account_id, []); childrenByParent.get(c.parent_account_id).push(c); } }
  const codes = new Set([accountCode]);
  if (target) { const q = [target.id]; while (q.length) { for (const ch of childrenByParent.get(q.shift()) || []) { codes.add(ch.account_code); q.push(ch.id); } } }

  let lines = glLines.filter((l) => codes.has(l.account_code) && ((Number(l.debit) || 0) || (Number(l.credit) || 0)));
  // The breakdown's Total column keeps every line of the period (already fetched from `from`).
  if (String(columnKey) === TOTAL_COLUMN_KEY) { /* all columns */ }
  else if (breakdown === 'department') lines = lines.filter((l) => String(l.department_id || 'unassigned') === String(columnKey));
  else if (breakdown === 'location') lines = lines.filter((l) => String(l.location_id || 'unassigned') === String(columnKey));
  else if (breakdown === 'company') lines = lines.filter((l) => String(l.company_id || 'unassigned') === String(columnKey));
  else if (breakdown === 'months') lines = lines.filter((l) => monthKey(l.entry_date) === String(columnKey));

  const names = await resolveGlLineNames(lines);
  const own = lines.filter((l) => !l.source_department);
  const rows = own.map((l) => ({
    source_no: l.source_no, source_type: l.source_type, entry_date: l.entry_date,
    name: names.get(`${l.source_type}:${l.source_id}`) || l.memo || '',
    debit: round2(l.debit || 0), credit: round2(l.credit || 0),
  }));
  rows.push(...await itemiseSourceLines(lines.filter((l) => l.source_department)));
  // Each row opens its document: T1S's own lines by type + id, the source's by document number.
  own.forEach((l, i) => { rows[i].link = linkFor(l.source_type, l.source_id); });
  const byNo = await linksForNumbers(rows.filter((r) => r.source_type === 'source_ledger').map((r) => r.source_no));
  for (const r of rows) if (r.source_type === 'source_ledger') r.link = byNo.get(String(r.source_no)) || null;
  rows.sort((a, b) => new Date(a.entry_date) - new Date(b.entry_date) || String(a.source_no).localeCompare(String(b.source_no)));
  return {
    account_code: accountCode, rows,
    total_debit: round2(rows.reduce((s, r) => s + r.debit, 0)),
    total_credit: round2(rows.reduce((s, r) => s + r.credit, 0)),
  };
}

// Drill-down behind one Balance Sheet amount: every transaction that makes up the account's
// balance as of the date -- the account and all its sub-accounts, from the first entry, as the
// source's own Balance Sheet lists it (10001 Change Fund: JRNL-1 17,000 / JRNL-1059 -2,500 /
// CHK-5965 2,000 = 16,500).
//
// Up to the cut-over T1S holds the source's balances, not its documents (lib/openingBalances.js),
// so that part is read live from the source's ledger, location by location (lib/sourceLedger.js
// accountLedger). After it, T1S's own posted lines. The source's documents are checked against
// T1S's own balance at the cut-over; any gap is shown as one "Difference" line, and if the source
// cannot be reached the balance stands as one line -- so the list always totals to the report.
async function buildBalanceSheetTransactions({ accountCode, asOfDate, limit = 1000, scope = null }) {
  const coaRows = await loadCoa();
  const target = coaRows.find((c) => c.account_code === accountCode);
  const childrenByParent = new Map();
  for (const c of coaRows) { if (c.parent_account_id != null) { if (!childrenByParent.has(c.parent_account_id)) childrenByParent.set(c.parent_account_id, []); childrenByParent.get(c.parent_account_id).push(c); } }
  const accounts = new Map([[accountCode, target]]);
  if (target) { const q = [target.id]; while (q.length) { for (const ch of childrenByParent.get(q.shift()) || []) { accounts.set(ch.account_code, ch); q.push(ch.id); } } }
  const codes = new Set(accounts.keys());

  const books = await booksStart();
  const cutover = books ? books.asOf : null; // last day the source's figures cover
  const sourceTo = cutover && asOfDate > cutover ? cutover : asOfDate;
  const rows = [];

  if (cutover) {
    // T1S's own balance for these accounts at the end of the source period -- what the source's
    // documents have to add up to.
    const upTo = await getPostedGlLines({ toDate: sourceTo });
    const expected = round2(upTo.filter((l) => codes.has(l.account_code)).reduce((s, l) => s + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0));
    let listed = 0;
    try {
      // Leaf accounts only: a summary account's own code carries no postings.
      for (const [code, acct] of accounts) {
        if (acct && acct.is_summary) continue;
        const docs = await accountLedger({ accountCode: code, side: acct?.normal_balance === 'CREDIT' ? 'CREDIT' : 'DEBIT', from: '2000-01-01', to: sourceTo });
        for (const t of docs) {
          listed += t.amount;
          rows.push({ source_no: t.document, source_type: 'source_ledger', entry_date: t.date,
            name: t.name || t.memo || '', debit: t.debit, credit: t.credit, account_code: code });
        }
      }
      // Journals and vendor bills keyed in T1S for the source period (lib/glImpact.js
      // preStartT1sJournalLines / preStartVendorBillLines) are part of the balance but not of the
      // source's documents: listed as themselves, not folded into the Difference line.
      for (const l of upTo) {
        if (!['journal', 'vendor_bill'].includes(l.source_type) || !codes.has(l.account_code)) continue;
        listed += (Number(l.debit) || 0) - (Number(l.credit) || 0);
        rows.push({ source_no: l.source_no, source_type: l.source_type, source_id: l.source_id, entry_date: l.entry_date,
          name: l.memo || '', debit: Number(l.debit) || 0, credit: Number(l.credit) || 0, account_code: l.account_code });
      }
      const gap = round2(expected - listed);
      if (Math.abs(gap) >= 0.01) {
        rows.push({ source_no: '', source_type: 'difference', entry_date: sourceTo,
          name: `Difference: the old system's documents vs its balance as of ${sourceTo}`,
          debit: gap > 0 ? gap : 0, credit: gap < 0 ? -gap : 0 });
      }
    } catch (e) {
      rows.length = 0;
      rows.push({ source_no: '', source_type: 'opening_balance', entry_date: sourceTo,
        name: `Balance as of ${sourceTo} from the old system (could not list its documents: ${e.message})`,
        debit: expected > 0 ? expected : 0, credit: expected < 0 ? -expected : 0 });
    }
  }

  // T1S's own transactions: after the cut-over, or everything when there is no source period.
  if (!cutover || asOfDate > cutover) {
    const own = await buildGlTransactions({ accountCode, asOfDate, fromDate: cutover ? books.start : '2000-01-01', scope });
    rows.push(...own.rows);
  }

  const byNo = await linksForNumbers(rows.filter((r) => r.source_type === 'source_ledger').map((r) => r.source_no));
  for (const r of rows) if (r.source_type === 'source_ledger') r.link = byNo.get(String(r.source_no)) || null;
  rows.sort((a, b) => new Date(a.entry_date) - new Date(b.entry_date) || String(a.source_no).localeCompare(String(b.source_no)));
  const totalDebit = round2(rows.reduce((s, r) => s + (Number(r.debit) || 0), 0));
  const totalCredit = round2(rows.reduce((s, r) => s + (Number(r.credit) || 0), 0));
  // A busy account runs to tens of thousands of lines (Cash on Hand 124k, AP 50k), more than a
  // browser can list. Keep the latest `limit`; carry everything older as one opening line, so the
  // list still totals to the report. limit 0 = every line.
  const totalCount = rows.length;
  let shown = rows;
  if (limit > 0 && rows.length > limit) {
    const older = rows.slice(0, rows.length - limit);
    const net = round2(older.reduce((s, r) => s + (Number(r.debit) || 0) - (Number(r.credit) || 0), 0));
    shown = [{ source_no: '', source_type: 'brought_forward', entry_date: older[older.length - 1].entry_date,
      name: `Balance brought forward: ${older.length.toLocaleString('en-US')} earlier transaction(s)`,
      debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 }, ...rows.slice(rows.length - limit)];
  }
  return { account_code: accountCode, as_of: asOfDate, rows: shown, total_count: totalCount, shown_count: Math.min(totalCount, limit > 0 ? limit : totalCount),
    total_debit: round2(shown.reduce((s2, r) => s2 + (Number(r.debit) || 0), 0)), total_credit: round2(shown.reduce((s2, r) => s2 + (Number(r.credit) || 0), 0)),
    balance: round2(totalDebit - totalCredit) };
}

// A source month's per-department line -> the documents behind it, read live from the source
// (lib/sourceLedger). The source's own figure stays the authority: if its ledger does not add up
// to the line, the difference is shown as one line saying so, and if the source cannot be reached
// the line is shown as it is -- the drill-down never disagrees with the report it came from.
async function itemiseSourceLines(lines) {
  if (!lines.length) return [];
  const sum = (l) => ({
    source_no: l.source_no, source_type: l.source_type, entry_date: l.entry_date, name: l.memo || '',
    debit: round2(l.debit || 0), credit: round2(l.credit || 0),
  });
  const codes = [...new Set(lines.map((l) => l.account_code))];
  const depts = [...new Set(lines.map((l) => l.source_department))];
  const [coaKeys] = await pool.query('SELECT * FROM source_coa_keys WHERE account_code IN (?)', [codes]);
  const [deptKeys] = await pool.query('SELECT * FROM source_dept_keys WHERE source_department IN (?)', [depts]);
  const coa = new Map(coaKeys.map((c) => [c.account_code, c]));
  const dept = new Map(deptKeys.map((d) => [d.source_department, d.dept_pk]));
  const out = [];
  await pool4(lines, async (l) => {
    const c = coa.get(l.account_code);
    const month = String(l.entry_date).slice(0, 7);
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
    let docs;
    try {
      if (!c) throw new Error('account not on file');
      docs = await departmentLedger({ coa: c, department: l.source_department, deptPk: dept.get(l.source_department), from: `${month}-01`, to: `${month}-${last}` });
    } catch (e) {
      out.push({ ...sum(l), name: `${l.memo} (could not list its documents: ${e.message})` });
      return;
    }
    let rest = (Number(l.debit) || 0) - (Number(l.credit) || 0);
    for (const t of docs) {
      rest -= t.amount;
      out.push({ source_no: t.document, source_type: 'source_ledger', entry_date: t.date, name: t.name || t.memo || '', debit: t.debit, credit: t.credit });
    }
    rest = round2(rest);
    if (Math.abs(rest) >= 0.01) {
      out.push({
        source_no: l.source_no, source_type: l.source_type, entry_date: l.entry_date,
        name: `Difference: the old system's ledger for ${l.source_department} vs its ${month} figure`,
        debit: rest > 0 ? rest : 0, credit: rest < 0 ? -rest : 0,
      });
    }
  }, 6);
  return out;
}

module.exports = { buildTrialBalance, buildBalanceSheet, buildIncomeStatement, buildGeneralLedger, buildGlTransactions, buildBalanceSheetTransactions };
