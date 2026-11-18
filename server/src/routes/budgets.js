const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { getPostedGlLines } = require('../lib/glImpact');
const budgetAi = require('../lib/budgetAi');
const deptBudget = require('../lib/departmentBudget');

// Budgets (Accounting > Budgets) and the Budget vs Actual report. See db/create-budgets.js.
//
// A budget is entered per POSTING account per month. Actuals come from getPostedGlLines -- the
// same derived GL every financial report reads -- so a Budget vs Actual actual can never disagree
// with the Income Statement for the same account, period and department/location.
const router = express.Router();
const ROUTE = '/budgets';
const REPORT_ROUTE = '/reports/budget-vs-actual';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pad2 = (n) => String(n).padStart(2, '0');
const monthEnd = (y, m) => `${y}-${pad2(m)}-${pad2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;

// The accounts a budget can hold, in report order. P&L is every INCOME and EXPENSE posting
// account; capital spending adds the FIXED ASSETS posting accounts. Summary (parent) accounts
// are never budgeted -- they total their children in the report.
const SECTIONS = [
  { key: 'revenue', label: 'Revenue', where: "t.account_type = 'INCOME' AND t.account_sub_type = 'REVENUES'" },
  { key: 'cogs', label: 'Cost of Sales', where: "t.account_type = 'EXPENSE' AND t.account_sub_type IN ('COST OF GOOD SOLDS', 'COST OF SERVICES')" },
  { key: 'opex', label: 'Operating Expenses', where: "t.account_type = 'EXPENSE' AND t.account_sub_type IN ('OPERATING EXPENSES', 'EXPENSE')" },
  { key: 'other_income', label: 'Other Income', where: "t.account_type = 'INCOME' AND t.account_sub_type <> 'REVENUES'" },
  { key: 'other_expense', label: 'Other Expenses', where: "t.account_type = 'EXPENSE' AND t.account_sub_type IN ('OTHER EXPENSE', 'NON-OPERATING EXPENSES')" },
  { key: 'capex', label: 'Capital Spending (Fixed Assets)', where: "t.account_type = 'ASSET' AND t.account_sub_type = 'FIXED ASSETS'", capex: true },
];
// Which way an actual counts as "more": income is credit-normal, everything budgeted here debit.
const isIncome = (section) => section === 'revenue' || section === 'other_income';

async function budgetAccounts(scope) {
  const out = [];
  for (const s of SECTIONS) {
    if (s.capex && scope !== 'pl_capex') continue;
    const [rows] = await pool.query(
      `SELECT coa.id, coa.account_code, coa.account_name
         FROM chart_of_accounts coa JOIN chart_of_account_types t ON t.id = coa.coa_type_id
        WHERE coa.is_summary = 0 AND coa.exclude_from_reports = 0 AND ${s.where}
        ORDER BY coa.account_code`);
    for (const r of rows) out.push({ ...r, section: s.key, section_label: s.label });
  }
  return out;
}

async function loadBudget(id) {
  const [[b]] = await pool.query(
    `SELECT b.*, d.name AS department_name, l.location_name,
            cu.display_name AS created_by_name, au.display_name AS approved_by_name
       FROM budgets b
       LEFT JOIN departments d ON d.id = b.department_id
       LEFT JOIN locations l ON l.id = b.location_id
       LEFT JOIN users cu ON cu.id = b.created_by_user_id
       LEFT JOIN users au ON au.id = b.approved_by_user_id
      WHERE b.id = ?`, [id]);
  return b || null;
}
const dimensionLabel = (b) => (b.dimension === 'department' ? `Department: ${b.department_name || '?'}`
  : b.dimension === 'location' ? `Location: ${b.location_name || '?'}` : 'Company-wide');

// Actuals per account per month for one fiscal year, up to and including `toMonth`, narrowed to
// the budget's department or location. Returns Map(account_code -> number[12]).
async function loadActuals(year, toMonth, b) {
  const all = await getPostedGlLines({ fromDate: `${year}-01-01`, toDate: monthEnd(year, toMonth) });
  const map = new Map();
  const lines = [];
  for (const l of all) {
    if (b.dimension === 'department' && String(l.department_id) !== String(b.department_id)) continue;
    if (b.dimension === 'location' && String(l.location_id) !== String(b.location_id)) continue;
    const m = Number(String(l.entry_date instanceof Date ? l.entry_date.toISOString() : l.entry_date).slice(5, 7));
    if (!m) continue;
    if (!map.has(l.account_code)) map.set(l.account_code, new Array(12).fill(0));
    // Raw debit - credit; the sign is fixed per section by the caller.
    const amt = (Number(l.debit) || 0) - (Number(l.credit) || 0);
    map.get(l.account_code)[m - 1] += amt;
    lines.push({ ...l, month: m, amount: amt });
  }
  return { map, lines };
}
async function actualsByMonth(year, toMonth, b) { return (await loadActuals(year, toMonth, b)).map; }

// ---------------------------------------------------------------- setup

router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [departments] = await pool.query('SELECT id, name FROM departments ORDER BY name');
    const [locations] = await pool.query('SELECT id, location_name FROM locations ORDER BY location_name');
    res.json({ departments, locations, sections: SECTIONS.map(({ key, label, capex }) => ({ key, label, capex: !!capex })) });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const year = Number(req.query.year) || null;
    const [rows] = await pool.query(
      `SELECT b.id, b.name, b.fiscal_year, b.dimension, b.scope, b.status, b.version, b.approved_at, b.kind,
              d.name AS department_name, l.location_name, au.display_name AS approved_by_name,
              CASE WHEN b.kind = 'department'
                   THEN COALESCE((SELECT SUM(ra.amount) FROM budget_rows br JOIN budget_row_amounts ra ON ra.row_id = br.id WHERE br.budget_id = b.id), 0)
                   ELSE COALESCE((SELECT SUM(amount) FROM budget_lines bl WHERE bl.budget_id = b.id), 0) END AS total
         FROM budgets b
         LEFT JOIN departments d ON d.id = b.department_id
         LEFT JOIN locations l ON l.id = b.location_id
         LEFT JOIN users au ON au.id = b.approved_by_user_id
        ${year ? 'WHERE b.fiscal_year = ?' : ''}
        ORDER BY b.fiscal_year DESC, b.status = 'approved' DESC, b.name, b.version DESC`,
      year ? [year] : []);
    res.json(rows.map((r) => ({ ...r, dimension_label: dimensionLabel(r) })));
  } catch (err) { next(err); }
});

function readHeader(body) {
  const kind = body.kind === 'department' ? 'department' : 'account';
  if (kind === 'department') { body = { ...body, dimension: 'company' }; }
  const year = Number(body.fiscal_year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return { error: 'Choose a fiscal year.' };
  const dimension = ['company', 'department', 'location'].includes(body.dimension) ? body.dimension : 'company';
  const departmentId = dimension === 'department' ? Number(body.department_id) || null : null;
  const locationId = dimension === 'location' ? Number(body.location_id) || null : null;
  if (dimension === 'department' && !departmentId) return { error: 'Choose the department this budget is for.' };
  if (dimension === 'location' && !locationId) return { error: 'Choose the location this budget is for.' };
  const name = String(body.name || '').trim().slice(0, 150);
  if (!name) return { error: 'Give the budget a name.' };
  return {
    name, fiscal_year: year, dimension, department_id: departmentId, location_id: locationId,
    scope: body.scope === 'pl_capex' ? 'pl_capex' : 'pl', notes: body.notes ? String(body.notes).slice(0, 1000) : null,
    kind,
    sales_target: body.sales_target === '' || body.sales_target == null ? null : round2(body.sales_target),
  };
}

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const h = readHeader(req.body);
    if (h.error) return res.status(400).json({ error: h.error });
    const conn = await pool.getConnection();
    let id;
    try {
      await conn.beginTransaction();
      const [r] = await conn.query(
        `INSERT INTO budgets (name, fiscal_year, dimension, department_id, location_id, scope, notes, kind, sales_target, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [h.name, h.fiscal_year, h.dimension, h.department_id, h.location_id, h.scope, h.notes, h.kind, h.sales_target, req.user.id]);
      id = r.insertId;
      // A department budget starts with the accounting workbook's rows.
      if (h.kind === 'department') await deptBudget.seedRows(conn, id);
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    res.status(201).json(await loadBudget(id));
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const b = await loadBudget(req.params.id);
    if (!b) return res.status(404).json({ error: 'Not found' });
    if (b.kind === 'department') {
      return res.json({ ...b, dimension_label: dimensionLabel(b), rows: await deptBudget.loadRows(b.id) });
    }
    const accounts = await budgetAccounts(b.scope);
    const [lines] = await pool.query('SELECT account_id, month, amount FROM budget_lines WHERE budget_id = ?', [b.id]);
    const amounts = {};
    for (const l of lines) {
      if (!amounts[l.account_id]) amounts[l.account_id] = new Array(12).fill(0);
      amounts[l.account_id][l.month - 1] = Number(l.amount);
    }
    res.json({ ...b, dimension_label: dimensionLabel(b), accounts, amounts });
  } catch (err) { next(err); }
});

async function requireDraft(req, res) {
  const b = await loadBudget(req.params.id);
  if (!b) { res.status(404).json({ error: 'Not found' }); return null; }
  if (b.status !== 'draft') {
    res.status(409).json({ error: 'An approved budget is locked. Make a new version to change it.' });
    return null;
  }
  return b;
}

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const b = await requireDraft(req, res); if (!b) return;
    const h = readHeader({ ...b, ...req.body });
    if (h.error) return res.status(400).json({ error: h.error });
    await pool.query(
      `UPDATE budgets SET name = ?, fiscal_year = ?, dimension = ?, department_id = ?, location_id = ?, scope = ?,
              notes = ?, updated_at = NOW() WHERE id = ?`,
      [h.name, h.fiscal_year, h.dimension, h.department_id, h.location_id, h.scope, h.notes, b.id]);
    // Narrowing P&L + capex back to P&L drops the fixed-asset lines rather than hiding them.
    if (h.scope === 'pl') {
      const capex = (await budgetAccounts('pl_capex')).filter((a) => a.section === 'capex').map((a) => a.id);
      if (capex.length) await pool.query('DELETE FROM budget_lines WHERE budget_id = ? AND account_id IN (?)', [b.id, capex]);
    }
    res.json(await loadBudget(b.id));
  } catch (err) { next(err); }
});

// The whole grid in one go: { amounts: { [account_id]: [12 numbers] } }. Zero rows are not kept.
async function saveAmounts(conn, budgetId, scope, amounts) {
  const allowed = new Set((await budgetAccounts(scope)).map((a) => String(a.id)));
  await conn.query('DELETE FROM budget_lines WHERE budget_id = ?', [budgetId]);
  const rows = [];
  for (const [accountId, months] of Object.entries(amounts || {})) {
    if (!allowed.has(String(accountId)) || !Array.isArray(months)) continue;
    months.slice(0, 12).forEach((v, i) => {
      const n = round2(v);
      if (n) rows.push([budgetId, Number(accountId), i + 1, n]);
    });
  }
  for (let i = 0; i < rows.length; i += 1000) {
    await conn.query('INSERT INTO budget_lines (budget_id, account_id, month, amount) VALUES ?', [rows.slice(i, i + 1000)]);
  }
  return rows.length;
}

router.put('/:id/lines', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = await requireDraft(req, res); if (!b) return;
    await conn.beginTransaction();
    const n = await saveAmounts(conn, b.id, b.scope, req.body.amounts);
    await conn.query('UPDATE budgets SET updated_at = NOW() WHERE id = ?', [b.id]);
    await conn.commit();
    res.json({ saved_lines: n });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// A starting point: last year's actuals for the same department / location, adjusted by a
// percentage. Returned for the grid to show -- nothing is saved until the user saves.
router.get('/:id/suggest-from-actuals', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const b = await loadBudget(req.params.id);
    if (!b) return res.status(404).json({ error: 'Not found' });
    const fromYear = Number(req.query.year) || b.fiscal_year - 1;
    const factor = 1 + (Number(req.query.pct) || 0) / 100;
    const accounts = await budgetAccounts(b.scope);
    const actual = await actualsByMonth(fromYear, 12, b);
    const amounts = {};
    for (const a of accounts) {
      const raw = actual.get(a.account_code);
      if (!raw) continue;
      const sign = isIncome(a.section) ? -1 : 1;
      amounts[a.id] = raw.map((v) => round2(v * sign * factor));
    }
    res.json({ from_year: fromYear, amounts });
  } catch (err) { next(err); }
});

router.post('/:id/approve', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = await loadBudget(req.params.id);
    if (!b) return res.status(404).json({ error: 'Not found' });
    if (b.status !== 'draft') return res.status(409).json({ error: 'Only a draft can be approved.' });
    await conn.beginTransaction();
    // One live budget per year and department/location: the one approved before is superseded.
    await conn.query(
      `UPDATE budgets SET status = 'superseded', updated_at = NOW()
        WHERE status = 'approved' AND fiscal_year = ? AND dimension = ? AND kind = ?
          AND department_id <=> ? AND location_id <=> ? AND id <> ?`,
      [b.fiscal_year, b.dimension, b.kind, b.department_id, b.location_id, b.id]);
    await conn.query(
      "UPDATE budgets SET status = 'approved', approved_by_user_id = ?, approved_at = NOW(), updated_at = NOW() WHERE id = ?",
      [req.user.id, b.id]);
    await conn.commit();
    res.json(await loadBudget(b.id));
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// An approved budget is never edited in place: a revision is a new draft version of it.
router.post('/:id/new-version', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = await loadBudget(req.params.id);
    if (!b) return res.status(404).json({ error: 'Not found' });
    const [[{ v }]] = await conn.query(
      `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM budgets
        WHERE fiscal_year = ? AND dimension = ? AND department_id <=> ? AND location_id <=> ?`,
      [b.fiscal_year, b.dimension, b.department_id, b.location_id]);
    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO budgets (name, fiscal_year, dimension, department_id, location_id, scope, notes, kind, sales_target, version, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [b.name, b.fiscal_year, b.dimension, b.department_id, b.location_id, b.scope, b.notes, b.kind, b.sales_target, v, req.user.id]);
    if (b.kind === 'department') {
      for (const row of await deptBudget.loadRows(b.id, conn)) {
        const [nr] = await conn.query(
          'INSERT INTO budget_rows (budget_id, grp, label, source_department, department_id, sort, pct, remarks) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [r.insertId, row.grp, row.label, row.source_department, row.department_id, row.sort, row.pct, row.remarks]);
        const vals = row.amounts.map((a, i) => [nr.insertId, i + 1, a]).filter((x) => x[2]);
        if (vals.length) await conn.query('INSERT INTO budget_row_amounts (row_id, month, amount) VALUES ?', [vals]);
      }
    }
    await conn.query(
      'INSERT INTO budget_lines (budget_id, account_id, month, amount) SELECT ?, account_id, month, amount FROM budget_lines WHERE budget_id = ?',
      [r.insertId, b.id]);
    await conn.commit();
    res.status(201).json(await loadBudget(r.insertId));
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    const b = await requireDraft(req, res); if (!b) return;
    await pool.query('DELETE FROM budgets WHERE id = ?', [b.id]); // lines cascade
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------- Excel template

const TEMPLATE_HEAD = ['Account Code', 'Account Title', 'Section', ...MONTHS, 'Total'];

router.get('/:id/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const b = await loadBudget(req.params.id);
    if (!b) return res.status(404).json({ error: 'Not found' });
    const accounts = await budgetAccounts(b.scope);
    const [lines] = await pool.query('SELECT account_id, month, amount FROM budget_lines WHERE budget_id = ?', [b.id]);
    const byAcct = new Map();
    for (const l of lines) {
      if (!byAcct.has(l.account_id)) byAcct.set(l.account_id, new Array(12).fill(0));
      byAcct.get(l.account_id)[l.month - 1] = Number(l.amount);
    }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Budget');
    ws.addRow([`${b.name} -- FY ${b.fiscal_year} -- ${dimensionLabel(b)} -- v${b.version} (${b.status})`]).font = { bold: true };
    ws.addRow(['Fill in the month columns and import this file back. Leave Account Code as it is; blanks count as zero.']);
    const head = ws.addRow(TEMPLATE_HEAD); head.font = { bold: true };
    for (const a of accounts) {
      const m = byAcct.get(a.id) || new Array(12).fill(0);
      const row = ws.addRow([a.account_code, a.account_name, a.section_label, ...m.map((v) => v || null)]);
      const r = row.number;
      row.getCell(16).value = { formula: `SUM(D${r}:O${r})` };
    }
    ws.columns.forEach((c, i) => { c.width = i === 1 ? 44 : i === 2 ? 26 : 14; });
    for (let c = 4; c <= 16; c += 1) ws.getColumn(c).numFmt = '#,##0.00';
    ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 3 }];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="budget-${b.fiscal_year}-${b.id}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

// The template back, as base64 in JSON (a ~100-row sheet is a few KB). Read by Account Code;
// codes not in this budget's scope are reported and skipped. Replaces the whole grid.
router.post('/:id/import', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = await requireDraft(req, res); if (!b) return;
    const buf = Buffer.from(String(req.body.file_base64 || ''), 'base64');
    if (!buf.length) return res.status(400).json({ error: 'No file received.' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    let headRow = 0;
    ws.eachRow((row, n) => { if (!headRow && String(row.getCell(1).value || '').trim() === 'Account Code') headRow = n; });
    if (!headRow) return res.status(400).json({ error: 'This is not a budget template: no "Account Code" header row.' });
    const accounts = await budgetAccounts(b.scope);
    const byCode = new Map(accounts.map((a) => [String(a.account_code), a]));
    const amounts = {}; const unknown = [];
    const cellNum = (v) => {
      const raw = v && typeof v === 'object' ? (v.result ?? v.value ?? 0) : v;
      const n = Number(String(raw ?? '').replace(/,/g, ''));
      return Number.isFinite(n) ? n : 0;
    };
    ws.eachRow((row, n) => {
      if (n <= headRow) return;
      const code = String(row.getCell(1).value ?? '').trim();
      if (!code) return;
      const a = byCode.get(code);
      if (!a) { unknown.push(code); return; }
      amounts[a.id] = MONTHS.map((_, i) => cellNum(row.getCell(4 + i).value));
    });
    await conn.beginTransaction();
    const saved = await saveAmounts(conn, b.id, b.scope, amounts);
    await conn.query('UPDATE budgets SET updated_at = NOW() WHERE id = ?', [b.id]);
    await conn.commit();
    res.json({ saved_lines: saved, skipped_codes: unknown });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// ---------------------------------------------------------------- Budget vs Actual

// period: 'month' (just `month`), 'quarter' (the quarter `month` falls in, up to `month`) or
// 'ytd' (January to `month`). YTD columns always run January to `month`.
async function buildBudgetVsActual(budgetId, period, month, { withLines = false } = {}) {
  const b = await loadBudget(budgetId);
  if (!b) return null;
  const m = Math.min(12, Math.max(1, Number(month) || 12));
  const from = period === 'month' ? m : period === 'quarter' ? Math.floor((m - 1) / 3) * 3 + 1 : 1;
  const accounts = await budgetAccounts(b.scope);
  const [lines] = await pool.query('SELECT account_id, month, amount FROM budget_lines WHERE budget_id = ?', [b.id]);
  const budget = new Map();
  for (const l of lines) {
    if (!budget.has(l.account_id)) budget.set(l.account_id, new Array(12).fill(0));
    budget.get(l.account_id)[l.month - 1] = Number(l.amount);
  }
  const { map: actual, lines: glLines } = await loadActuals(b.fiscal_year, m, b);
  const sourcesByCode = new Map();
  for (const l of glLines) {
    if (!sourcesByCode.has(l.account_code)) sourcesByCode.set(l.account_code, {});
    const src = sourcesByCode.get(l.account_code);
    src[l.source_type] = (src[l.source_type] || 0) + l.amount;
  }
  const sum = (arr, a, z) => (arr ? arr.slice(a - 1, z).reduce((s, v) => s + v, 0) : 0);

  const sections = SECTIONS.filter((s) => !s.capex || b.scope === 'pl_capex').map((s) => ({
    key: s.key, label: s.label, income: isIncome(s.key), rows: [],
    totals: { budget: 0, actual: 0, ytd_budget: 0, ytd_actual: 0 },
  }));
  const bySection = new Map(sections.map((s) => [s.key, s]));
  for (const a of accounts) {
    const sec = bySection.get(a.section);
    const sign = sec.income ? -1 : 1;
    const bud = budget.get(a.id);
    const act = actual.get(a.account_code)?.map((v) => v * sign);
    const row = {
      account_id: a.id, account_code: a.account_code, account_name: a.account_name,
      budget: round2(sum(bud, from, m)), actual: round2(sum(act, from, m)),
      ytd_budget: round2(sum(bud, 1, m)), ytd_actual: round2(sum(act, 1, m)),
      annual_budget: round2(sum(bud, 1, 12)),
    };
    if (!row.budget && !row.actual && !row.ytd_budget && !row.ytd_actual && !row.annual_budget) continue;
    // Rule-based warnings that a number may be wrong -- see lib/budgetAi.js. Not AI.
    row.flags = budgetAi.flagsFor(row, {
      income: sec.income, months: (act || new Array(12).fill(0)).slice(0, m), sources: sourcesByCode.get(a.account_code) || {},
    });
    sec.rows.push(row);
    for (const k of Object.keys(sec.totals)) sec.totals[k] = round2(sec.totals[k] + row[k]);
  }
  const t = (key, k) => bySection.get(key)?.totals[k] || 0;
  const summary = {};
  for (const k of ['budget', 'actual', 'ytd_budget', 'ytd_actual']) {
    const gross = t('revenue', k) - t('cogs', k);
    summary[k] = { gross_profit: round2(gross), net_income: round2(gross - t('opex', k) + t('other_income', k) - t('other_expense', k)) };
  }
  return {
    budget: { ...b, dimension_label: dimensionLabel(b) },
    period, month: m, from_month: from,
    period_label: period === 'month' ? `${MONTHS[m - 1]} ${b.fiscal_year}` : `${MONTHS[from - 1]}-${MONTHS[m - 1]} ${b.fiscal_year}`,
    sections, summary,
    flag_count: sections.reduce((n, sec) => n + sec.rows.filter((r) => r.flags.length).length, 0),
    ai_available: budgetAi.aiConfigured(),
    ...(withLines ? { _lines: glLines } : {}),
  };
}

// The largest transactions behind the biggest variances, for the AI to explain them from.
function varianceDrivers(report) {
  const rows = [];
  for (const sec of report.sections) {
    for (const r of sec.rows) {
      const v = sec.income ? r.actual - r.budget : r.budget - r.actual;
      rows.push({ sec, r, v });
    }
  }
  rows.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  return rows.slice(0, 6).map(({ sec, r, v }) => {
    const sign = sec.income ? -1 : 1;
    const txns = (report._lines || [])
      .filter((l) => l.account_code === r.account_code && l.month >= report.from_month && l.month <= report.month)
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
      .slice(0, 5)
      .map((l) => ({
        date: String(l.entry_date instanceof Date ? l.entry_date.toISOString() : l.entry_date).slice(0, 10),
        document: `${l.source_type} ${l.source_no || ''}`.trim(),
        memo: String(l.memo || '').slice(0, 80),
        amount: round2(l.amount * sign),
      }));
    return { account: `${r.account_code} ${r.account_name}`, variance: round2(v), largest_transactions: txns };
  });
}

router.get('/report/vs-actual', requireAuth, requirePermission(REPORT_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const data = await buildBudgetVsActual(req.query.budget_id, req.query.period, req.query.month);
    if (!data) return res.status(404).json({ error: 'Choose a budget.' });
    res.json(data);
  } catch (err) { next(err); }
});

// Budgets to pick from on the report: approved first. Its own gate, so someone granted only the
// report does not need the Budgets page.
router.get('/report/options', requireAuth, requirePermission(REPORT_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT b.id, b.name, b.fiscal_year, b.dimension, b.status, b.version, b.kind, d.name AS department_name, l.location_name
         FROM budgets b LEFT JOIN departments d ON d.id = b.department_id LEFT JOIN locations l ON l.id = b.location_id
        WHERE b.status <> 'superseded'
        ORDER BY b.fiscal_year DESC, b.status = 'approved' DESC, b.name`);
    res.json(rows.map((r) => ({ ...r, dimension_label: dimensionLabel(r) })));
  } catch (err) { next(err); }
});

router.get('/report/vs-actual/export', requireAuth, requirePermission(REPORT_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const data = await buildBudgetVsActual(req.query.budget_id, req.query.period, req.query.month);
    if (!data) return res.status(404).json({ error: 'Choose a budget.' });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Budget vs Actual');
    ws.addRow([`Budget vs Actual -- ${data.budget.name} (v${data.budget.version}, ${data.budget.status}) -- ${data.budget.dimension_label} -- ${data.period_label}`]).font = { bold: true, size: 13 };
    ws.addRow([]);
    const head = ws.addRow(['Account Code', 'Account Title', 'Budget', 'Actual', 'Variance', 'Variance %', 'YTD Budget', 'YTD Actual', 'YTD Variance', 'Annual Budget']);
    head.font = { bold: true };
    const variance = (sec, b, a) => (sec.income ? a - b : b - a); // positive = favourable
    const pct = (v, b) => (b ? v / b : null);
    for (const sec of data.sections) {
      ws.addRow([sec.label]).font = { bold: true };
      for (const r of sec.rows) {
        const v = variance(sec, r.budget, r.actual); const yv = variance(sec, r.ytd_budget, r.ytd_actual);
        ws.addRow([r.account_code, r.account_name, r.budget, r.actual, v, pct(v, r.budget), r.ytd_budget, r.ytd_actual, yv, r.annual_budget]);
      }
      const T = sec.totals;
      const tv = variance(sec, T.budget, T.actual); const tyv = variance(sec, T.ytd_budget, T.ytd_actual);
      ws.addRow(['', `Total ${sec.label}`, T.budget, T.actual, tv, pct(tv, T.budget), T.ytd_budget, T.ytd_actual, tyv]).font = { bold: true };
    }
    ws.addRow([]);
    for (const [label, k] of [['Gross Profit', 'gross_profit'], ['Net Income', 'net_income']]) {
      const s = data.summary;
      ws.addRow(['', label, s.budget[k], s.actual[k], s.actual[k] - s.budget[k], null, s.ytd_budget[k], s.ytd_actual[k], s.ytd_actual[k] - s.ytd_budget[k]]).font = { bold: true };
    }
    ws.getColumn(2).width = 44; [1, 3, 4, 5, 7, 8, 9, 10].forEach((c) => { ws.getColumn(c).width = 16; ws.getColumn(c).numFmt = '#,##0.00;(#,##0.00)'; });
    ws.getColumn(1).numFmt = '@'; ws.getColumn(6).numFmt = '0.0%'; ws.getColumn(6).width = 11;
    ws.views = [{ state: 'frozen', ySplit: 3 }];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="budget-vs-actual-${data.budget.fiscal_year}-${data.month}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------- department budgets

// Save a department budget's grid: { sales_target, rows: [{ id, pct, remarks, amounts: [12] }] }.
router.put('/:id/rows', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = await requireDraft(req, res); if (!b) return;
    if (b.kind !== 'department') return res.status(400).json({ error: 'Not a department budget.' });
    const own = new Set((await deptBudget.loadRows(b.id)).map((r) => Number(r.id)));
    await conn.beginTransaction();
    const target = req.body.sales_target === '' || req.body.sales_target == null ? null : round2(req.body.sales_target);
    await conn.query('UPDATE budgets SET sales_target = ?, updated_at = NOW() WHERE id = ?', [target, b.id]);
    for (const r of Array.isArray(req.body.rows) ? req.body.rows : []) {
      if (!own.has(Number(r.id))) continue;
      const pct = r.pct === '' || r.pct == null ? null : Number(r.pct);
      await conn.query('UPDATE budget_rows SET pct = ?, remarks = ? WHERE id = ?',
        [Number.isFinite(pct) ? pct : null, r.remarks ? String(r.remarks).slice(0, 500) : null, r.id]);
      await conn.query('DELETE FROM budget_row_amounts WHERE row_id = ?', [r.id]);
      const vals = (Array.isArray(r.amounts) ? r.amounts : []).slice(0, 12).map((a, i) => [r.id, i + 1, round2(a)]).filter((x) => x[2]);
      if (vals.length) await conn.query('INSERT INTO budget_row_amounts (row_id, month, amount) VALUES ?', [vals]);
    }
    await conn.commit();
    res.json({ ok: true });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// Import the accounting manager's workbook layout: sheets whose header row reads "Department |
// Monthly Budget" (Admin / Selling) and one reading "Month | Budget" (COGS). Rows are matched by
// department name; the Remarks column and the "Budget @ 8.5M Sales" note come across too.
router.post('/:id/import-workbook', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = await requireDraft(req, res); if (!b) return;
    if (b.kind !== 'department') return res.status(400).json({ error: 'Not a department budget.' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(String(req.body.file_base64 || ''), 'base64'));
    const txt = (v) => {
      if (v == null) return '';
      if (typeof v === 'object') return String(v.richText ? v.richText.map((t) => t.text).join('') : (v.result ?? v.text ?? ''));
      return String(v);
    };
    const num = (v) => { const n = Number(typeof v === 'object' && v ? (v.result ?? 0) : String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
    const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const rows = await deptBudget.loadRows(b.id);
    const byNorm = new Map(rows.filter((r) => r.grp !== 'cogs').map((r) => [norm(r.label), r]));
    const cogs = rows.find((r) => r.grp === 'cogs');
    const updates = new Map(); const unmatched = []; let target = null; let qaMonthly = 0; let cogsSkipped = false;
    for (const ws of wb.worksheets) {
      let head = 0; let remarksCol = 0; let cogsHead = 0;
      ws.eachRow((row, n) => {
        const a = txt(row.getCell(1).value).trim().toLowerCase(); const bcell = txt(row.getCell(2).value).trim().toLowerCase();
        if (!head && a === 'department' && bcell.startsWith('monthly budget')) {
          head = n; row.eachCell((c, col) => { if (txt(c.value).trim().toLowerCase() === 'remarks') remarksCol = col; });
        }
        if (!cogsHead && a === 'month' && bcell === 'budget') cogsHead = n;
        const note = /budget\s*@\s*([\d.]+)\s*m/i.exec(txt(row.getCell(2).value));
        if (note && target == null) target = Number(note[1]) * 1000000;
      });
      if (head) {
        ws.eachRow((row, n) => {
          if (n <= head) return;
          const label = txt(row.getCell(1).value).trim();
          if (!label || /^total$/i.test(label)) return;
          const monthly = num(row.getCell(2).value);
          // Quality Assurance is part of Support now: its budget is added to Support's.
          if (/^quality/i.test(label)) { qaMonthly += monthly; return; }
          const r = byNorm.get(norm(label));
          if (!r) { unmatched.push(label); return; }
          updates.set(r.id, { amounts: new Array(12).fill(round2(monthly)), remarks: remarksCol ? txt(row.getCell(remarksCol).value).trim() || null : r.remarks });
        });
      }
      if (cogsHead && cogs) {
        const amounts = new Array(12).fill(0); let i = 0;
        ws.eachRow((row, n) => {
          if (n <= cogsHead || i >= 12) return;
          // Column A holds the month as a real date; breakdown lines (CNC, DPOD...) leave it empty.
          const v = row.getCell(1).value;
          if (v == null || (typeof v === 'string' && !v.trim())) return;
          const label = v instanceof Date ? 'month' : txt(v).trim();
          if (/^total$/i.test(label)) { i = 12; return; }
          amounts[i] = round2(num(row.getCell(2).value)); i += 1;
        });
        updates.set(cogs.id, { amounts, remarks: cogs.remarks });
      }
    }
    if (!updates.size) return res.status(400).json({ error: 'No "Department | Monthly Budget" or "Month | Budget" table found in this workbook.' });
    const supportRow = rows.find((x) => x.label === 'Support');
    if (qaMonthly && supportRow) {
      const u = updates.get(supportRow.id) || { amounts: new Array(12).fill(0), remarks: supportRow.remarks };
      u.amounts = u.amounts.map((a) => round2(a + qaMonthly));
      u.remarks = [u.remarks, 'incl. Quality Assurance'].filter(Boolean).join('; ');
      updates.set(supportRow.id, u);
    }
    await conn.beginTransaction();
    for (const [rowId, u] of updates) {
      await conn.query('UPDATE budget_rows SET remarks = ?, pct = NULL WHERE id = ?', [u.remarks, rowId]);
      await conn.query('DELETE FROM budget_row_amounts WHERE row_id = ?', [rowId]);
      const vals = u.amounts.map((a, i) => [rowId, i + 1, a]).filter((x) => x[2]);
      if (vals.length) await conn.query('INSERT INTO budget_row_amounts (row_id, month, amount) VALUES ?', [vals]);
    }
    if (target != null) await conn.query('UPDATE budgets SET sales_target = ? WHERE id = ?', [target, b.id]);
    await conn.commit();
    res.json({ rows_updated: updates.size, unmatched, sales_target: target, cogs_skipped: cogsSkipped });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// The transactions behind one amount (a row's month, or a COGS line's month). See drill().
router.get('/report/department-sheets/drill', requireAuth, requirePermission(REPORT_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const b = await loadBudget(req.query.budget_id);
    if (!b || b.kind !== 'department') return res.status(404).json({ error: 'Choose a department budget.' });
    res.json(await deptBudget.drill({ budget: b, month: req.query.month, rowId: req.query.row_id, line: req.query.line }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.get('/report/department-sheets', requireAuth, requirePermission(REPORT_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const b = await loadBudget(req.query.budget_id);
    if (!b || b.kind !== 'department') return res.status(404).json({ error: 'Choose a department budget.' });
    const report = await deptBudget.buildReport(b);
    // Rule-based warnings that a number may be wrong -- see lib/budgetAi.js. Not AI, and computed
    // whether or not an OpenAI key is set, so the useful half of this never depends on a balance.
    res.json({ ...report, flags: budgetAi.deptFlags(report), ai_available: budgetAi.aiConfigured() });
  } catch (err) { next(err); }
});

// The same three sheets as the accounting workbook: Admin Expenses, Selling Expenses, COGS.
router.get('/report/department-sheets/export', requireAuth, requirePermission(REPORT_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const b = await loadBudget(req.query.budget_id);
    if (!b || b.kind !== 'department') return res.status(404).json({ error: 'Choose a department budget.' });
    const rep = await deptBudget.buildReport(b);
    const Y = rep.budget.fiscal_year;
    const wb = new ExcelJS.Workbook();
    const FONT = { name: 'Courier New', size: 9 };
    const NUM = '#,##0.00;[Red]-#,##0.00;"-"';
    const BLUE = { name: 'Courier New', size: 9, bold: true, color: { argb: 'FF0070C0' } };
    const note = rep.budget.sales_target ? `Note: Budget @ ${(rep.budget.sales_target / 1000000).toLocaleString('en-US', { maximumFractionDigits: 2 })}M Sales` : null;
    const title = (ws, text) => {
      ws.getCell('A1').value = require('../config/company').COMPANY.name.toUpperCase(); ws.getCell('A2').value = text;
      ['A1', 'A2'].forEach((c) => { ws.getCell(c).font = FONT; });
    };
    const SHEET = { admin: ['Admin Expenses', 'ADMIN Expenses vs Budget'], selling: ['Selling Expenses', 'Selling Expenses vs Budget'], cogs: ['COGS', 'COGS vs Budget for Production'] };
    for (const g of rep.groups) {
      if (g.grp === 'cogs') {
        const ws = wb.addWorksheet(`${Y} ${SHEET.cogs[0]}`);
        title(ws, `${Y} ${SHEET.cogs[1]}`);
        ws.getRow(5).values = ['Month', 'Budget', 'Actual Expenses', 'Variance']; ws.getRow(5).font = { ...FONT, bold: true };
        ws.getRow(5).eachCell((c) => { c.border = { bottom: { style: 'thin' } }; });
        const row = g.rows[0]; let r = 7;
        if (row) {
          MONTHS.forEach((m, i) => {
            const mr = ws.getRow(r);
            mr.values = [`${m}-${String(Y).slice(2)}`, row.budget[i], row.actual[i], row.variance[i]];
            mr.font = FONT; ws.getCell(r, 2).font = { ...FONT, bold: true }; r += 1;
            for (const b of rep.cogs_breakdown) {
              const br = ws.getRow(r);
              br.values = [null, b.label, b.actual[i]]; br.font = { ...FONT, color: { argb: 'FF555555' }, size: b.parent ? 8 : 9 };
              ws.getCell(r, 2).alignment = { indent: b.parent ? 3 : 1 }; r += 1;
            }
          });
          r += 1;
          const tr = ws.getRow(r); tr.values = ['Total', row.annual_budget, row.annual_actual, row.annual_variance]; tr.font = { ...FONT, bold: true };
          tr.eachCell((c) => { c.border = { top: { style: 'thin' }, bottom: { style: 'double' } }; });
          if (note) { ws.getCell(r + 1, 2).value = note; ws.getCell(r + 1, 2).font = { ...FONT, bold: true, color: { argb: 'FFFF0000' } }; }
        }
        ws.getColumn(1).width = 10; ws.getColumn(2).width = 18; [2, 3, 4].forEach((c) => { ws.getColumn(c).numFmt = NUM; });
        ws.getColumn(3).width = 18; ws.getColumn(4).width = 18;
        ws.views = [{ state: 'frozen', ySplit: 5 }];
        continue;
      }
      const ws = wb.addWorksheet(`${Y} ${SHEET[g.grp][0]}`);
      title(ws, `${Y} ${SHEET[g.grp][1]}`);
      // Two header rows, as the workbook: the month over its pair, then ACTUAL | Variance beneath.
      const head = ['Department', 'Monthly Budget'];
      const sub = ['', ''];
      MONTHS.forEach((m) => { head.push(`${m}-${String(Y).slice(2)}`, null); sub.push('ACTUAL', 'Variance'); });
      head.push('', 'Annual Budget', 'Annual Expenses', 'Variance', 'Remarks');
      const hr = ws.getRow(4); hr.values = head; hr.font = { ...FONT, bold: true };
      const sr = ws.getRow(5); sr.values = sub; sr.font = { ...FONT, bold: true };
      MONTHS.forEach((_, i) => {
        ws.mergeCells(4, 3 + i * 2, 4, 4 + i * 2);
        ws.getCell(4, 3 + i * 2).alignment = { horizontal: 'center' };
      });
      ws.getColumn(2).font = BLUE;
      ws.getCell(4, 2).font = { ...BLUE };
      for (let c = 1; c <= 31; c += 1) ws.getCell(5, c).border = { bottom: { style: 'thin' } };
      let r = 6;
      for (const row of g.rows) {
        const vals = [row.label, row.budget[0]];
        MONTHS.forEach((_, i) => vals.push(row.actual[i], row.variance[i]));
        vals.push(null, row.annual_budget, row.annual_actual, row.annual_variance, row.remarks || null);
        ws.getRow(r).values = vals; ws.getRow(r).font = FONT; ws.getCell(r, 2).font = BLUE; r += 1;
      }
      const T = g.totals; const tv = ['Total', T.budget[0]];
      MONTHS.forEach((_, i) => tv.push(T.actual[i], T.variance[i]));
      tv.push(null, T.annual_budget, T.annual_actual, T.annual_variance);
      r += 1; ws.getRow(r).values = tv; ws.getRow(r).font = { ...FONT, bold: true };
      ws.getRow(r).eachCell((c) => { c.border = { top: { style: 'thin' }, bottom: { style: 'double' } }; });
      if (note) { ws.getCell(r + 1, 2).value = note; ws.getCell(r + 1, 2).font = { ...FONT, bold: true, color: { argb: 'FFFF0000' } }; }
      ws.getColumn(1).width = 26; ws.getColumn(2).width = 16;
      for (let c = 3; c <= 31; c += 1) { ws.getColumn(c).width = 14; ws.getColumn(c).numFmt = NUM; }
      ws.getColumn(2).numFmt = NUM; ws.getColumn(31).width = 36;
      // Alternate month bands, as in the workbook.
      for (let i = 1; i < 12; i += 2) {
        for (let rr = 4; rr <= r; rr += 1) for (const c of [3 + i * 2, 4 + i * 2]) ws.getCell(rr, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEDED' } };
      }
      ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 5 }];
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${Y}-expenses-vs-budget.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

// All departments side by side: each department's APPROVED budget for the year against the actuals
// carrying that department, plus an Unassigned column for actuals with no department at all --
// shown, not hidden, because it is the measure of how far department budgets can be trusted yet.
router.get('/report/departments', requireAuth, requirePermission(REPORT_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const m = Math.min(12, Math.max(1, Number(req.query.month) || 12));
    const period = ['month', 'quarter', 'ytd'].includes(req.query.period) ? req.query.period : 'ytd';
    const from = period === 'month' ? m : period === 'quarter' ? Math.floor((m - 1) / 3) * 3 + 1 : 1;

    const accounts = await budgetAccounts('pl_capex');
    const sectionById = new Map(accounts.map((a) => [a.id, a.section]));
    const sectionByCode = new Map(accounts.map((a) => [a.account_code, a.section]));

    const [budgets] = await pool.query(
      `SELECT b.id, b.department_id, d.name AS department_name FROM budgets b JOIN departments d ON d.id = b.department_id
        WHERE b.fiscal_year = ? AND b.dimension = 'department' AND b.status = 'approved'`, [year]);
    const cols = new Map(); // key -> { key, label, budget: {section: n}, actual: {section: n}, has_budget }
    const col = (key, label) => {
      if (!cols.has(key)) cols.set(key, { key, label, budget: {}, actual: {}, has_budget: false });
      return cols.get(key);
    };
    for (const b of budgets) col(String(b.department_id), b.department_name).has_budget = true;
    if (budgets.length) {
      const [lines] = await pool.query(
        'SELECT budget_id, account_id, SUM(amount) AS amount FROM budget_lines WHERE budget_id IN (?) AND month BETWEEN ? AND ? GROUP BY budget_id, account_id',
        [budgets.map((b) => b.id), from, m]);
      const deptOf = new Map(budgets.map((b) => [b.id, String(b.department_id)]));
      for (const l of lines) {
        const sec = sectionById.get(Number(l.account_id)); if (!sec) continue;
        const c = cols.get(deptOf.get(l.budget_id));
        c.budget[sec] = (c.budget[sec] || 0) + Number(l.amount);
      }
    }

    const gl = await getPostedGlLines({ fromDate: `${year}-01-01`, toDate: monthEnd(year, m) });
    const deptIds = new Set();
    for (const l of gl) {
      const sec = sectionByCode.get(l.account_code); if (!sec) continue;
      const mm = Number(String(l.entry_date instanceof Date ? l.entry_date.toISOString() : l.entry_date).slice(5, 7));
      if (mm < from || mm > m) continue;
      const key = l.department_id ? String(l.department_id) : 'unassigned';
      if (l.department_id) deptIds.add(Number(l.department_id));
      const c = col(key, key === 'unassigned' ? 'Unassigned' : null);
      const signed = ((Number(l.debit) || 0) - (Number(l.credit) || 0)) * (isIncome(sec) ? -1 : 1);
      c.actual[sec] = (c.actual[sec] || 0) + signed;
    }
    if (deptIds.size) {
      const [names] = await pool.query('SELECT id, name FROM departments WHERE id IN (?)', [[...deptIds]]);
      for (const n of names) { const c = cols.get(String(n.id)); if (c && !c.label) c.label = n.name; }
    }
    const netOf = (x) => (x.revenue || 0) - (x.cogs || 0) - (x.opex || 0) + (x.other_income || 0) - (x.other_expense || 0);
    const columns = [...cols.values()]
      .map((c) => ({
        ...c, label: c.label || `#${c.key}`,
        budget: { ...Object.fromEntries(Object.entries(c.budget).map(([k, v]) => [k, round2(v)])), net_income: round2(netOf(c.budget)) },
        actual: { ...Object.fromEntries(Object.entries(c.actual).map(([k, v]) => [k, round2(v)])), net_income: round2(netOf(c.actual)) },
      }))
      .sort((a, b) => (a.key === 'unassigned') - (b.key === 'unassigned') || a.label.localeCompare(b.label));
    const unassigned = columns.find((c) => c.key === 'unassigned');
    // By SIZE, whatever the sign: some departments carry credit-balance costs (a negative Direct
    // Labor, say), and a plain ratio of signed totals came out at -79%.
    const costSize = (c) => Math.abs(c.actual.cogs || 0) + Math.abs(c.actual.opex || 0) + Math.abs(c.actual.other_expense || 0);
    const totalActualCost = columns.reduce((s, c) => s + costSize(c), 0);
    const unassignedCost = unassigned ? costSize(unassigned) : 0;
    res.json({
      year, period, month: m, from_month: from,
      period_label: period === 'month' ? `${MONTHS[m - 1]} ${year}` : `${MONTHS[from - 1]}-${MONTHS[m - 1]} ${year}`,
      sections: SECTIONS.map(({ key, label }) => ({ key, label, income: isIncome(key) })),
      columns,
      approved_department_budgets: budgets.length,
      unassigned_cost_share: totalActualCost ? round2((unassignedCost / totalActualCost) * 100) : 0,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------- AI

router.post('/report/ai/explain', requireAuth, requirePermission(REPORT_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const report = await buildBudgetVsActual(req.body.budget_id, req.body.period, req.body.month, { withLines: true });
    if (!report) return res.status(404).json({ error: 'Choose a budget.' });
    res.json({ text: await budgetAi.explainReport(report, varianceDrivers(report)) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post('/report/ai/ask', requireAuth, requirePermission(REPORT_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const question = String(req.body.question || '').trim();
    if (!question) return res.status(400).json({ error: 'Type a question.' });
    const report = await buildBudgetVsActual(req.body.budget_id, req.body.period, req.body.month, { withLines: true });
    if (!report) return res.status(404).json({ error: 'Choose a budget.' });
    res.json({ answer: await budgetAi.askReport(report, varianceDrivers(report), question, req.body.history) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// The same two, for the DEPARTMENT report (Admin / Selling / COGS sheets). Separate endpoints
// rather than a flag on the account ones: the two reports are different shapes, carry different
// rules -- costs only, variance positive-is-good, months that simply have no actuals yet -- and
// a prompt that tried to serve both would state neither correctly.
router.post('/report/ai/dept-explain', requireAuth, requirePermission(REPORT_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const b = await loadBudget(req.body.budget_id);
    if (!b || b.kind !== 'department') return res.status(404).json({ error: 'Choose a department budget.' });
    res.json({ text: await budgetAi.explainDeptReport(await deptBudget.buildReport(b)) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post('/report/ai/dept-ask', requireAuth, requirePermission(REPORT_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const question = String(req.body.question || '').trim();
    if (!question) return res.status(400).json({ error: 'Type a question.' });
    const b = await loadBudget(req.body.budget_id);
    if (!b || b.kind !== 'department') return res.status(404).json({ error: 'Choose a department budget.' });
    const report = await deptBudget.buildReport(b);
    res.json({ answer: await budgetAi.askDeptReport(report, question, req.body.history) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// AI Suggest for the budget grid. T1S computes each account's baseline -- last year's total
// spread by the account's own seasonality over up to three past years -- and the AI only picks a
// growth % per account with a reason (lib/budgetAi.js). Without AI, the account's own last-year
// trend is used, clamped the same way. Nothing is saved: the grid shows it for review.
router.get('/:id/ai-suggest', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const b = await loadBudget(req.params.id);
    if (!b) return res.status(404).json({ error: 'Not found' });
    const accounts = await budgetAccounts(b.scope);
    const years = [b.fiscal_year - 3, b.fiscal_year - 2, b.fiscal_year - 1];
    const byYear = {};
    for (const y of years) byYear[y] = await actualsByMonth(y, 12, b);
    const last = b.fiscal_year - 1;

    const hist = [];
    for (const a of accounts) {
      const sign = isIncome(a.section) ? -1 : 1;
      const ys = {};
      for (const y of years) {
        const raw = byYear[y].get(a.account_code);
        if (raw && raw.some((v) => Math.abs(v) > 0.005)) ys[y] = raw.map((v) => v * sign);
      }
      if (!ys[last]) continue; // nothing last year to build on
      hist.push({ ...a, income: isIncome(a.section), years: ys });
    }

    // Seasonality: each month's average share of its year, over the years that have data.
    const baseline = (h) => {
      const shares = new Array(12).fill(0); let n = 0;
      for (const m of Object.values(h.years)) {
        const t = m.reduce((s, v) => s + v, 0);
        if (Math.abs(t) < 0.005) continue;
        m.forEach((v, i) => { shares[i] += v / t; }); n += 1;
      }
      const lastTotal = h.years[last].reduce((s, v) => s + v, 0);
      return shares.map((sh) => (n ? (sh / n) * lastTotal : lastTotal / 12));
    };
    const trendPct = (h) => {
      const t1 = (h.years[last] || []).reduce((s, v) => s + v, 0);
      const t0 = (h.years[last - 1] || []).reduce((s, v) => s + v, 0);
      if (!t0 || Math.sign(t0) !== Math.sign(t1)) return 0;
      return Math.max(-50, Math.min(50, Math.round(((t1 - t0) / Math.abs(t0)) * 100)));
    };

    let ai = {}; let source = 'trend';
    if (budgetAi.aiConfigured() && hist.length) {
      try { ai = await budgetAi.suggestGrowth({ ...b, dimension_label: dimensionLabel(b) }, hist); source = 'ai'; }
      catch (e) { console.error('Budget AI suggest failed, using trend:', e.message); }
    }
    const amounts = {}; const notes = {};
    for (const h of hist) {
      const g = ai[h.account_code] ? ai[h.account_code].growth_pct : trendPct(h);
      const reason = ai[h.account_code]?.reason || `last year's trend (${g >= 0 ? '+' : ''}${g}%)`;
      amounts[h.id] = baseline(h).map((v) => round2(v * (1 + g / 100)));
      notes[h.id] = `${g >= 0 ? '+' : ''}${g}%: ${reason}`;
    }
    res.json({ source, based_on: years.filter((y) => hist.some((h) => h.years[y])), amounts, notes });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
