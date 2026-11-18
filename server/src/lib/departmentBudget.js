// Department budgets in the accounting manager's workbook format: "ADMIN Expenses vs Budget",
// "Selling Expenses vs Budget" and "COGS vs Budget for Production". See
// db/create-department-budgets.js.
//
// ACTUALS, by month -- always the system's, never typed:
//   up to the cut-over (lib/openingBalances booksStart().asOf, 2026-08-31 at the time of writing):
//     the source's own department income statement, loaded by db/load-source-dept-actuals.js into
//     source_dept_actuals (section totals per department) and source_dept_account_actuals (per
//     account per department). Its Operating Expenses per department reproduce the workbook's
//     2025 Admin/Selling actuals exactly.
//   after it: T1S's ledger (getPostedGlLines) by department_id.
//
// ROW RULES (the user's, 2026-09-30):
//   Accounting  its operating expenses EXCEPT Interest Expense and Taxes, Permits And Licenses...
//   Others      ...which are shown here instead (Accounting's amounts in those accounts only;
//               other departments keep their own taxes and licenses)
//   Support     the whole Support family: Support, Support-IT/-System/-Costing/-Technical, and
//               Quality Assurance
//   COGS        ONE budget line for the company (the workbook's COGS sheet). Its actual is all
//               Cost of Goods Sold + the Production departments' operating expenses, broken down
//               under each month by CNC / DPOD / LFP / SIGN, and Others for COGS booked to the
//               sales teams and branches (about a third), so the breakdown adds up to the total.
const pool = require('../db');
const { getPostedGlLines } = require('./glImpact');
const { booksStart } = require('./openingBalances');

const TEMPLATE = {
  admin: ['Accounting', 'Others', 'Building & Maintenance', 'Execom', 'Human Resource', 'Logistics', 'Supply Chain', 'Support', 'Treasury'],
  selling: ['Marketing', 'Design', 'E-Commerce', 'Branch - Ayala', 'Branch-SM_Cebu', 'Sales-1', 'Sales-2', 'Sales-3', 'Sales-4', 'Sales-5'],
  cogs: ['COGS (Production)'],
};
const GROUP_LABEL = { admin: 'Admin Expenses', selling: 'Selling Expenses', cogs: 'COGS (Production)' };
// Accounting's accounts that go on the Others line: Interest Expense; Taxes, Permits And Licenses.
const OTHERS_ACCOUNTS = new Set(['30619', '30620']);
const OTHERS_NOTE = 'Interest Expense; Taxes, Permits & Licenses (booked to Accounting)';
const SUPPORT_NOTE = 'IT, System, Quality, Costing, Technical/Engineering';
const COGS_OTHER = 'Others';
const COGS_ROW = 'COGS (Production)';
// The breakdown lines under each COGS month, in the workbook's order.
const COGS_BREAKDOWN = ['CNC', 'DPOD', 'LFP', 'SIGN', 'Others'];

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pad2 = (n) => String(n).padStart(2, '0');
const monthEnd = (y, m) => `${y}-${pad2(m)}-${pad2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
const isProduction = (name) => /^production/i.test(String(name || '').trim());
const isSupportFamily = (name) => /^support/i.test(String(name || '').trim()) || /^quality/i.test(String(name || '').trim());
// Which COGS line a department's cost of sales lands on. T1S has both "Production - SIGN" and
// "Production-SIGNAGE"; both are Signage.
function cogsLine(deptName) {
  const n = norm(deptName);
  if (n.startsWith('productioncnc')) return 'CNC';
  if (n.startsWith('productiondpod')) return 'DPOD';
  if (n.startsWith('productionlfp')) return 'LFP';
  if (n.startsWith('productionsign')) return 'SIGN';
  return COGS_OTHER;
}
const isAccounting = (name) => norm(name) === 'accounting';

// Rows for a new department budget: the workbook's departments, each matched to the T1S
// department of the same name where one exists.
async function seedRows(conn, budgetId) {
  const [deps] = await conn.query('SELECT id, name FROM departments');
  const byNorm = new Map(deps.map((d) => [norm(d.name), d.id]));
  let sort = 0;
  for (const grp of ['admin', 'selling', 'cogs']) {
    for (const name of TEMPLATE[grp]) {
      sort += 1;
      const deptId = name === 'Others' || grp === 'cogs' ? null : byNorm.get(norm(name)) || null;
      await conn.query(
        'INSERT INTO budget_rows (budget_id, grp, label, source_department, department_id, sort) VALUES (?, ?, ?, ?, ?, ?)',
        [budgetId, grp, name, name, deptId, sort]);
    }
  }
}

// Bring a budget made before a template change up to the current rows (idempotent): adds any
// missing row in its place and drops COGS rows no longer in the template (the short-lived
// per-department COGS budget lines of 2026-09-30, replaced by one COGS budget with a breakdown).
async function upgradeRows(conn, budgetId) {
  const [have] = await conn.query('SELECT id, grp, label FROM budget_rows WHERE budget_id = ?', [budgetId]);
  const key = (g, l) => `${g}|${l}`;
  const existing = new Set(have.map((r) => key(r.grp, r.label)));
  const [deps] = await conn.query('SELECT id, name FROM departments');
  const byNorm = new Map(deps.map((d) => [norm(d.name), d.id]));
  let added = 0; let removed = 0;
  for (const old of have.filter((r) => r.grp === 'cogs' && !TEMPLATE.cogs.includes(r.label))) {
    await conn.query('DELETE FROM budget_rows WHERE id = ?', [old.id]); removed += 1;
  }
  let sort = 0;
  for (const grp of ['admin', 'selling', 'cogs']) {
    for (const name of TEMPLATE[grp]) {
      sort += 1;
      if (existing.has(key(grp, name))) {
        await conn.query('UPDATE budget_rows SET sort = ? WHERE budget_id = ? AND grp = ? AND label = ?', [sort, budgetId, grp, name]);
        continue;
      }
      const deptId = name === 'Others' || grp === 'cogs' ? null : byNorm.get(norm(name)) || null;
      await conn.query(
        'INSERT INTO budget_rows (budget_id, grp, label, source_department, department_id, sort) VALUES (?, ?, ?, ?, ?, ?)',
        [budgetId, grp, name, name, deptId, sort]);
      added += 1;
    }
  }
  return { added, removed };
}

async function loadRows(budgetId, db = pool) {
  const [rows] = await db.query(
    `SELECT r.*, d.name AS department_name FROM budget_rows r LEFT JOIN departments d ON d.id = r.department_id
      WHERE r.budget_id = ? ORDER BY r.sort, r.id`, [budgetId]);
  if (!rows.length) return [];
  const [amts] = await db.query('SELECT row_id, month, amount FROM budget_row_amounts WHERE row_id IN (?)', [rows.map((r) => r.id)]);
  const byRow = new Map();
  for (const a of amts) {
    if (!byRow.has(a.row_id)) byRow.set(a.row_id, new Array(12).fill(0));
    byRow.get(a.row_id)[a.month - 1] = Number(a.amount);
  }
  return rows.map((r) => ({ ...r, pct: r.pct == null ? null : Number(r.pct), amounts: byRow.get(r.id) || new Array(12).fill(0) }));
}

// Which row(s) an amount belongs to. kind: 'opex' | 'cogs'; deptName: the department's name;
// account: the account code (for the Accounting / Others split). Returns row labels.
function rowsFor(kind, deptName, account) {
  if (kind === 'cogs') return [COGS_ROW];
  // opex
  const out = [];
  if (isProduction(deptName)) out.push(COGS_ROW); // production overheads count as COGS
  else if (isAccounting(deptName)) out.push(account && OTHERS_ACCOUNTS.has(String(account)) ? 'Others' : 'Accounting');
  else if (isSupportFamily(deptName)) out.push('Support');
  else out.push(`dept:${norm(deptName)}`);
  return out;
}

// Actuals per row per month for a fiscal year: Map(row.id -> (number|null)[12]); null = a month
// not reached yet, or a source month not loaded.
async function rowActuals(year, rows) {
  const books = await booksStart();
  const today = new Date().toISOString().slice(0, 10);
  const source = new Array(12).fill(null); // 'source' | 't1s' | 'missing' | null (future)
  for (let m = 1; m <= 12; m += 1) {
    if (`${year}-${pad2(m)}-01` > today) continue;
    source[m - 1] = books && monthEnd(year, m) <= books.asOf ? 'source' : 't1s';
  }
  // Row lookup by the label rowsFor returns: the special rows by name, the rest by department.
  const byKey = new Map();
  for (const r of rows) {
    const special = ['Accounting', 'Others', 'Support'].includes(r.label) || r.grp === 'cogs';
    byKey.set(special ? r.label : `dept:${norm(r.source_department || r.label)}`, r);
  }
  const out = new Map(rows.map((r) => [r.id, source.map((s) => (s ? 0 : null))]));
  // COGS by producing department, for the lines shown under each COGS month.
  const breakdown = Object.fromEntries(COGS_BREAKDOWN.map((k) => [k, source.map((s) => (s ? 0 : null))]));
  const add = (labels, i, amt, deptName) => {
    for (const k of labels) {
      const r = byKey.get(k); if (r) out.get(r.id)[i] += amt;
      if (k === COGS_ROW) {
        const main = cogsLine(deptName);
        if (breakdown[main][i] != null) breakdown[main][i] += amt;
        if (main === COGS_OTHER) {
          const sub = `${COGS_OTHER}|${deptName || 'No Department'}`;
          if (!breakdown[sub]) breakdown[sub] = source.map((x) => (x && x !== 'missing' ? 0 : null));
          if (breakdown[sub][i] != null) breakdown[sub][i] += amt;
        }
      }
    }
  };

  // Source months: per-account figures where loaded (they carry the Accounting / Others split),
  // else the department totals.
  if (source.includes('source')) {
    const [tot] = await pool.query('SELECT month, source_department, section, amount FROM source_dept_actuals WHERE year = ?', [year]);
    let acct = [];
    try {
      [acct] = await pool.query('SELECT month, source_department, section, account_code, amount FROM source_dept_account_actuals WHERE year = ?', [year]);
    } catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; }
    const acctMonths = new Set(acct.map((a) => a.month));
    const totMonths = new Set(tot.map((t) => t.month));
    for (let i = 0; i < 12; i += 1) {
      if (source[i] !== 'source') continue;
      const m = i + 1;
      if (acctMonths.has(m)) {
        for (const a of acct) {
          if (a.month !== m || a.source_department === 'Total') continue;
          if (a.section === 'opex' || a.section === 'cogs') add(rowsFor(a.section, a.source_department, a.account_code), i, Number(a.amount), a.source_department);
        }
      } else if (totMonths.has(m)) {
        for (const t of tot) {
          if (t.month !== m || t.source_department === 'Total') continue;
          if (t.section === 'opex' || t.section === 'cogs') add(rowsFor(t.section, t.source_department, null), i, Number(t.amount), t.source_department);
        }
      } else {
        source[i] = 'missing';
        for (const r of rows) out.get(r.id)[i] = null;
        for (const k of Object.keys(breakdown)) breakdown[k][i] = null;
      }
    }
  }

  // T1S months.
  const t1sMonths = source.map((s, i) => (s === 't1s' ? i + 1 : null)).filter(Boolean);
  if (t1sMonths.length) {
    const [coa] = await pool.query(
      `SELECT coa.account_code, t.account_sub_type FROM chart_of_accounts coa
         JOIN chart_of_account_types t ON t.id = coa.coa_type_id WHERE t.account_type = 'EXPENSE'`);
    const sub = new Map(coa.map((c) => [c.account_code, c.account_sub_type]));
    const [deps] = await pool.query('SELECT id, name FROM departments');
    const deptName = new Map(deps.map((d) => [Number(d.id), d.name]));
    const lines = await getPostedGlLines({
      fromDate: `${year}-${pad2(t1sMonths[0])}-01`, toDate: monthEnd(year, t1sMonths[t1sMonths.length - 1]),
    });
    for (const l of lines) {
      const st = sub.get(l.account_code); if (!st) continue;
      const m = Number(String(l.entry_date instanceof Date ? l.entry_date.toISOString() : l.entry_date).slice(5, 7));
      if (source[m - 1] !== 't1s') continue;
      const kind = st === 'OPERATING EXPENSES' ? 'opex' : /^COST OF/.test(st) ? 'cogs' : null;
      if (!kind) continue;
      const name = l.department_id ? deptName.get(Number(l.department_id)) || '' : '';
      // A cost with no department cannot belong to a department row; COGS without one still
      // counts, on the catch-all line.
      if (kind === 'opex' && !name) continue;
      add(rowsFor(kind, name, l.account_code), m - 1, (Number(l.debit) || 0) - (Number(l.credit) || 0), name);
    }
  }
  for (const [k, v] of out) out.set(k, v.map((x) => (x == null ? null : round2(x))));
  for (const k of Object.keys(breakdown)) breakdown[k] = breakdown[k].map((x) => (x == null ? null : round2(x)));
  return { actuals: out, cogs_breakdown: breakdown, month_source: source, books_as_of: books?.asOf || null };
}

const NOTES = { Others: OTHERS_NOTE, Support: SUPPORT_NOTE, [COGS_ROW]: 'Actual broken down by CNC, DPOD, LFP, SIGN and Others (sales teams and branches)' };

// The report: three groups, each row with budget and actual per month; variance is Budget - Actual
// exactly as the workbook computes it (positive = under budget).
async function buildReport(budget) {
  const rows = await loadRows(budget.id);
  const { actuals, cogs_breakdown: cogsBreakdown, month_source: monthSource, books_as_of: booksAsOf } = await rowActuals(budget.fiscal_year, rows);
  const groups = ['admin', 'selling', 'cogs'].map((grp) => {
    const gr = rows.filter((r) => r.grp === grp).map((r) => {
      const act = actuals.get(r.id);
      const annualBudget = round2(r.amounts.reduce((s, v) => s + v, 0));
      const annualActual = round2(act.reduce((s, v) => s + (v || 0), 0));
      return {
        id: r.id, label: r.label, department_id: r.department_id, department_name: r.department_name,
        remarks: r.remarks, pct: r.pct, budget: r.amounts.map(round2), actual: act,
        variance: r.amounts.map((b, i) => (act[i] == null ? null : round2(b - act[i]))),
        annual_budget: annualBudget, annual_actual: annualActual, annual_variance: round2(annualBudget - annualActual),
        no_t1s_department: grp !== 'cogs' && !r.department_id && !['Support', 'Others'].includes(r.label),
        includes: NOTES[r.label] || null,
      };
    });
    const sumAt = (key, i) => round2(gr.reduce((s, r) => s + (r[key][i] || 0), 0));
    const totals = {
      budget: Array.from({ length: 12 }, (_, i) => sumAt('budget', i)),
      actual: Array.from({ length: 12 }, (_, i) => (monthSource[i] && monthSource[i] !== 'missing' ? sumAt('actual', i) : null)),
      annual_budget: round2(gr.reduce((s, r) => s + r.annual_budget, 0)),
      annual_actual: round2(gr.reduce((s, r) => s + r.annual_actual, 0)),
    };
    totals.variance = totals.budget.map((b, i) => (totals.actual[i] == null ? null : round2(b - totals.actual[i])));
    totals.annual_variance = round2(totals.annual_budget - totals.annual_actual);
    return { grp, label: GROUP_LABEL[grp], rows: gr, totals };
  });
  return {
    budget: { id: budget.id, name: budget.name, fiscal_year: budget.fiscal_year, status: budget.status, version: budget.version, sales_target: budget.sales_target == null ? null : Number(budget.sales_target) },
    month_source: monthSource, books_as_of: booksAsOf, groups,
    // Under each COGS month: CNC / DPOD / LFP / SIGN / Others actuals (the workbook's layout).
    cogs_breakdown: [
      ...COGS_BREAKDOWN.map((label) => ({ label, line: label, actual: cogsBreakdown[label] })),
      // The departments inside Others, largest first, as indented lines under it.
      ...Object.keys(cogsBreakdown).filter((k) => k.startsWith(`${COGS_OTHER}|`))
        .map((k) => ({ label: k.split('|')[1], line: k, parent: COGS_OTHER, actual: cogsBreakdown[k] }))
        .filter((x) => x.actual.some((v) => v && Math.abs(v) > 0.005))
        .sort((a, b) => b.actual.reduce((t, v) => t + Math.abs(v || 0), 0) - a.actual.reduce((t, v) => t + Math.abs(v || 0), 0)),
    ],
  };
}

// ---------------------------------------------------------------- drill-down

// The transactions behind one amount on the report: a row's actual for a month, or one COGS
// breakdown line (CNC, DPOD..., Others, or "Others|<dept>"). Up to the cut-over they are fetched
// live from the source system -- get_transaction_ledgers, per account and department, exactly as
// its own department income statement drills down -- after it, from T1S's ledger.
const { departmentLedger, pool4 } = require('./sourceLedger');

// Does an amount (kind, department, account) land on the drilled target?
function hits(target, kind, deptName, account) {
  const keys = rowsFor(kind, deptName, account);
  if (target.rowKey) return keys.includes(target.rowKey);
  if (!keys.includes(COGS_ROW)) return false;
  const main = cogsLine(deptName);
  if (target.line.includes('|')) return main === COGS_OTHER && `${COGS_OTHER}|${deptName || 'No Department'}` === target.line;
  return main === target.line;
}

async function drill({ budget, month, rowId, line }) {
  const year = budget.fiscal_year; const m = Number(month);
  if (!(m >= 1 && m <= 12)) throw Object.assign(new Error('Choose a month.'), { status: 400 });
  let target; let title;
  if (rowId) {
    const [[row]] = await pool.query('SELECT * FROM budget_rows WHERE id = ? AND budget_id = ?', [rowId, budget.id]);
    if (!row) throw Object.assign(new Error('Row not found.'), { status: 404 });
    const special = ['Accounting', 'Others', 'Support'].includes(row.label) || row.grp === 'cogs';
    target = { rowKey: special ? row.label : `dept:${norm(row.source_department || row.label)}` };
    title = row.label;
  } else if (line) {
    target = { line: String(line) }; title = `COGS: ${String(line).replace('|', ' / ')}`;
  } else throw Object.assign(new Error('Choose a row or a COGS line.'), { status: 400 });

  const books = await booksStart();
  const fromSource = books && monthEnd(year, m) <= books.asOf;
  const from = `${year}-${pad2(m)}-01`; const to = monthEnd(year, m);
  const out = [];

  if (fromSource) {
    const [parts] = await pool.query(
      "SELECT source_department, section, account_code, amount FROM source_dept_account_actuals WHERE year = ? AND month = ? AND section IN ('opex','cogs')",
      [year, m]);
    const wanted = parts.filter((p) => hits(target, p.section, p.source_department, p.account_code));
    if (wanted.length) {
      const [coaKeys] = await pool.query('SELECT * FROM source_coa_keys WHERE account_code IN (?)', [[...new Set(wanted.map((w) => w.account_code))]]);
      const [deptKeys] = await pool.query('SELECT * FROM source_dept_keys WHERE source_department IN (?)', [[...new Set(wanted.map((w) => w.source_department))]]);
      const coa = new Map(coaKeys.map((c) => [c.account_code, c])); const dept = new Map(deptKeys.map((d) => [d.source_department, d]));
      await pool4(wanted, async (w) => {
        const c = coa.get(w.account_code); const d = dept.get(w.source_department);
        if (!c) { out.push({ date: null, document: '(account not on file)', memo: `${w.account_code} in ${w.source_department}`, amount: Number(w.amount), account_code: w.account_code, department: w.source_department }); return; }
        for (const t of await departmentLedger({ coa: c, department: w.source_department, deptPk: d ? d.dept_pk : null, from, to })) {
          out.push({ ...t, account_code: w.account_code, account_name: c.title, department: w.source_department });
        }
      });
    }
  } else {
    const [coa] = await pool.query(
      `SELECT coa.account_code, coa.account_name, t.account_sub_type FROM chart_of_accounts coa
         JOIN chart_of_account_types t ON t.id = coa.coa_type_id WHERE t.account_type = 'EXPENSE'`);
    const sub = new Map(coa.map((c) => [c.account_code, c]));
    const [deps] = await pool.query('SELECT id, name FROM departments');
    const deptName = new Map(deps.map((d) => [Number(d.id), d.name]));
    for (const l of await getPostedGlLines({ fromDate: from, toDate: to })) {
      const c = sub.get(l.account_code); if (!c) continue;
      const kind = c.account_sub_type === 'OPERATING EXPENSES' ? 'opex' : /^COST OF/.test(c.account_sub_type) ? 'cogs' : null;
      if (!kind) continue;
      const name = l.department_id ? deptName.get(Number(l.department_id)) || '' : '';
      if (kind === 'opex' && !name) continue;
      if (!hits(target, kind, name, l.account_code)) continue;
      const dr = Number(l.debit) || 0; const cr = Number(l.credit) || 0;
      out.push({
        date: String(l.entry_date instanceof Date ? l.entry_date.toISOString() : l.entry_date).slice(0, 10),
        document: `${l.source_no || ''}`, source_type: l.source_type, source_id: l.source_id, memo: l.memo,
        debit: round2(dr), credit: round2(cr), amount: round2(dr - cr),
        account_code: l.account_code, account_name: c.account_name, department: name || 'No Department',
      });
    }
  }
  out.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  return {
    title, month: m, year, from: fromSource ? 'source' : 't1s',
    total: round2(out.reduce((t, r) => t + (r.amount || 0), 0)), transactions: out,
  };
}

module.exports = {
  drill,
  TEMPLATE, GROUP_LABEL, OTHERS_ACCOUNTS, NOTES, COGS_OTHER, isSupportFamily, SUPPORT_NOTE,
  seedRows, upgradeRows, loadRows, rowActuals, buildReport,
};
