// Commission Summary (asked 2026-10-14): every commissioned rep's year on one workbook, laid out as
// the team's own spreadsheet -- one sheet per group (Sales Manager, SBU, Sales-1 ... Branch SM), one
// block per person (Supervisor first, then the Account Officers), a row per month and a TOTAL of
// Unpaid Commission under each block.
//
// The figures are the Commission report's own (lib/commissionReport.js buildCommissionReport), one
// call per person, so this workbook and that screen can never disagree.
const ExcelJS = require('exceljs');
const pool = require('../db');
const { buildCommissionReport, withholdConfirmedWithoutPayable } = require('./commissionReport');

// Where a person goes. Role first (the Sales Manager and the SBU heads have sheets of their own),
// then their department. Names are compared without spaces, dashes or underscores, since the
// department table spells them "Sales - 1", "Branch - Ayala", "Branch-SM_Cebu".
const key = (v) => String(v || '').toLowerCase().replace(/[\s_-]+/g, '');
const SHEETS = [
  { name: 'Sales Manager', label: 'Sales Manager' },
  { name: 'SBU', label: 'SBU Head' },
  { name: 'Sales-1', dept: 'sales1', title: 'Sales - 1' },
  { name: 'SALES-2', dept: 'sales2', title: 'Sales - 2' },
  { name: 'Sales-3', dept: 'sales3', title: 'Sales - 3' },
  { name: 'Sales-4', dept: 'sales4', title: 'Sales - 4' },
  { name: 'Marketing', dept: 'marketing', title: 'Marketing' },
  { name: 'Branch Ayala', dept: 'branchayala', title: 'Branch Ayala' },
  { name: 'Branch SM', dept: 'branchsm', title: 'Branch SM' },
];
const sheetForDept = (deptName) => {
  const k = key(deptName);
  if (k.startsWith('branchsm')) return 'Branch SM'; // "Branch-SM_Cebu"
  return SHEETS.find((s) => s.dept && s.dept === k)?.name || null;
};

// The people to report on, placed: [{ sheet, label, employee_id, name, order }]. scope as
// routes/reports.js getCommissionScope: { all } or { allowedIds }.
async function placePeople(scope) {
  const [rows] = await pool.query(
    `SELECT e.id, CONCAT(e.first_name, ' ', e.last_name) AS name, d.name AS dept,
            MAX(u.is_supervisor) AS sup, MAX(u.is_sales_manager) AS mgr, MAX(u.is_sales_business_unit) AS sbu
       FROM employees e
       JOIN users u ON u.employee_id = e.id AND u.is_active = TRUE
       LEFT JOIN departments d ON d.id = e.department_id
      WHERE e.is_active = TRUE AND u.account_type <> 'System Admin'
        AND (u.account_type = 'Sales' OR u.is_account_officer OR u.is_supervisor OR u.is_sales_manager OR u.is_sales_business_unit)
      GROUP BY e.id, e.first_name, e.last_name, d.name
      ORDER BY name`);
  const out = [];
  for (const r of rows) {
    if (!scope.all && !scope.allowedIds.has(Number(r.id))) continue;
    let sheet; let label; let order;
    if (Number(r.mgr)) { sheet = 'Sales Manager'; label = 'Sales Manager'; order = 0; }
    else if (Number(r.sbu)) { sheet = 'SBU'; label = 'SBU Head'; order = 0; }
    else {
      sheet = sheetForDept(r.dept) || 'Others';
      const title = SHEETS.find((s) => s.name === sheet)?.title || r.dept || 'No Department';
      label = Number(r.sup) ? `${title} Supervisor` : 'Account Officer';
      order = Number(r.sup) ? 0 : 1;
    }
    out.push({ sheet, label, employee_id: Number(r.id), name: r.name, order });
  }
  return out;
}

// [{ name: sheet, blocks: [{ label, name, employee_id, rows (12 months), total_unpaid }] }]
async function buildCommissionSummary(year, scope) {
  const people = await placePeople(scope);
  const bySheet = new Map();
  for (const p of people) {
    // No CP for the month -> no Confirmed / Unpaid shown, as on the Commission report (2026-11-18).
    const data = withholdConfirmedWithoutPayable(await buildCommissionReport(p.employee_id, year, {}));
    if (!data) continue;
    const block = {
      label: p.label, name: p.name, employee_id: p.employee_id, order: p.order, rows: data.rows,
      total_unpaid: Math.round(data.rows.reduce((s, r) => s + Number(r.unpaid_commission || 0), 0) * 100) / 100,
    };
    if (!bySheet.has(p.sheet)) bySheet.set(p.sheet, []);
    bySheet.get(p.sheet).push(block);
  }
  const order = [...SHEETS.map((s) => s.name), 'Others'];
  return order.filter((n) => bySheet.has(n)).map((n) => ({
    name: n,
    blocks: bySheet.get(n).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
  }));
}

/* ------------------------------------------------------------------ the workbook ------------ */

const MONEY = '#,##0.00';
// The columns and their row keys: B is the month's Commission Payable (CP #, 2026-11-18), C..N the
// team's sheet as before.
const COLS = [
  ['B', 'CP #', 'payables'],
  ['C', 'Quota', 'quota'],
  ['D', 'Sales Division', 'division_name'],
  ['E', 'Weighted Sales', 'weighted_sales'],
  ['F', '%', 'performance_pct'],
  ['G', 'Estimated Commission', 'estimated_commission'],
  ['H', "Total Amount of JO's with Passing Rate", 'passing_gp_total'],
  ['I', 'Expected Commission', 'expected_commission'],
  ['J', 'Confirmed Commission', 'confirmed_commission'],
  ['K', 'Released Commission', 'released_commission'],
  ['L', 'Deducted', 'expenses_deducted'],
  ['M', 'Refunded', 'expenses_refunded'],
  ['N', 'Unpaid Commission', 'unpaid_commission'],
];
const WIDTHS = { A: 14, B: 11, C: 14, D: 11, E: 14, F: 8, G: 12, H: 15, I: 12, J: 12, K: 12, L: 11, M: 10, N: 13 };
// "CP-36", several joined; "No CP" (red) for a month with commission but no payable.
function payableCell(cell, m) {
  const list = m.payables || [];
  if (list.length) { cell.value = list.map((p) => p.commission_payable_no).join(', '); return; }
  if (Number(m.expected_commission) > 0 || Number(m.released_commission) !== 0) {
    cell.value = 'No CP';
    cell.font = { bold: true, color: { argb: 'FFB91C1C' } };
  }
}
const thin = { style: 'thin', color: { argb: 'FFBFBFBF' } };

function writeBlock(ws, startRow, block) {
  let r = startRow;
  // "Sales - 1 Supervisor | Arjie Bayagna"
  ws.getCell(`A${r}`).value = block.label;
  ws.getCell(`B${r}`).value = block.name;
  ws.getRow(r).font = { bold: true };
  r += 1;
  // Two header rows; Expenses spans Deducted / Refunded, the rest span both rows.
  const top = r; const sub = r + 1;
  ws.getCell(`A${top}`).value = 'Month';
  ws.mergeCells(`A${top}:A${sub}`);
  for (const [col, label] of COLS) {
    if (col === 'L' || col === 'M') continue;
    ws.getCell(`${col}${top}`).value = label;
    ws.mergeCells(`${col}${top}:${col}${sub}`);
  }
  ws.getCell(`L${top}`).value = 'Expenses';
  ws.mergeCells(`L${top}:M${top}`);
  ws.getCell(`L${sub}`).value = 'Deducted';
  ws.getCell(`M${sub}`).value = 'Refunded';
  for (const row of [top, sub]) {
    for (const c of ['A', ...COLS.map(([col]) => col)]) {
      const cell = ws.getCell(`${c}${row}`);
      cell.alignment = { wrapText: true, vertical: 'middle', horizontal: c === 'A' ? 'left' : 'center' };
      cell.border = { top: thin, bottom: thin, left: thin, right: thin };
    }
  }
  ws.getRow(top).height = 32;
  r = sub + 1;
  // A month with nothing in it reads blank, as on the team's sheet -- only the quota shows.
  for (const m of block.rows) {
    ws.getCell(`A${r}`).value = m.month_name;
    for (const [col, , k] of COLS) {
      const v = m[k];
      const cell = ws.getCell(`${col}${r}`);
      if (k === 'payables') { payableCell(cell, m); continue; }
      if (k === 'division_name') cell.value = v || null;
      else cell.value = Number(v) ? Number(v) : null;
      if (k !== 'division_name') cell.numFmt = k === 'performance_pct' ? '0.00' : MONEY;
    }
    r += 1;
  }
  ws.getCell(`M${r}`).value = 'TOTAL';
  ws.getCell(`N${r}`).value = block.total_unpaid;
  ws.getCell(`N${r}`).numFmt = MONEY;
  ws.getCell(`M${r}`).font = { bold: true };
  ws.getCell(`N${r}`).font = { bold: true };
  ws.getCell(`N${r}`).border = { top: thin, bottom: { style: 'double' } };
  return r + 2; // a blank row before the next person
}

function commissionSummaryWorkbook(summary, year) {
  const wb = new ExcelJS.Workbook();
  for (const s of summary) {
    const ws = wb.addWorksheet(s.name.slice(0, 31));
    Object.entries(WIDTHS).forEach(([c, w]) => { ws.getColumn(c).width = w; });
    let row = 1;
    for (const block of s.blocks) row = writeBlock(ws, row, block);
  }
  if (!summary.length) wb.addWorksheet(`Commission ${year}`).getCell('A1').value = 'No commissioned sales reps to report on.';
  return wb;
}

module.exports = { buildCommissionSummary, commissionSummaryWorkbook };
