const pool = require('../db');

// Department is REQUIRED on any line that posts to an account a budget covers -- income, expense
// and fixed assets -- so that department budgets have actuals to compare against. Measured
// 2026-09-30: of this year's lines created in T1S, 0 of 566 cheque lines and 0 of 1,248 journal
// lines carried a department, so every department's Budget vs Actual showed almost no spending.
// Lines to balance-sheet accounts (bank, payables, advances) stay optional: a department means
// nothing on them. Only the forms' create routes enforce this; system-made entries (void
// reversals and the like) are never blocked.
const BUDGETED = `(t.account_type IN ('INCOME', 'EXPENSE')
                   OR (t.account_type = 'ASSET' AND t.account_sub_type = 'FIXED ASSETS'))`;

// lines: [{ account_id, department_id }]. Returns an error message naming the first offending
// line, or null when every budgeted line has a department.
async function missingDepartmentError(lines, db = pool) {
  const ids = [...new Set(lines.map((l) => Number(l.account_id)).filter(Boolean))];
  if (!ids.length) return null;
  const [rows] = await db.query(
    `SELECT coa.id, coa.account_code, coa.account_name
       FROM chart_of_accounts coa JOIN chart_of_account_types t ON t.id = coa.coa_type_id
      WHERE coa.id IN (?) AND ${BUDGETED}`, [ids]);
  const budgeted = new Map(rows.map((r) => [Number(r.id), r]));
  for (let i = 0; i < lines.length; i += 1) {
    const a = budgeted.get(Number(lines[i].account_id));
    if (a && !lines[i].department_id) {
      return `Choose a Department on line ${i + 1} (${a.account_code} ${a.account_name}). It is required on income, expense and fixed-asset lines so department budgets can be tracked.`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Department required on EVERY Sales, Purchasing, Accounting / Treasury and Inventory transaction
// (asked 2026-10-07): a document with no department cannot be saved. One check used by every
// create / edit route, so the refusal reads the same everywhere; the screens check first only so
// the user hears it before the round trip (client/src/utils/requireDepartment.js mirrors these).
//
// On the sales documents the department is the "Sales Division" (sales_division_id); `label` names
// it the way that screen does. The account-based rule above still applies to journal, cheque and
// bill lines on top of this.
const blank = (v) => v === undefined || v === null || v === '' || v === 0 || v === '0';

// The document's own (header) department. Returns an error message, or null when it is set.
function headerDepartmentError(value, label = 'Department') {
  return blank(value) ? `Select a ${label} -- it is required.` : null;
}

// Every line's department; names the first line missing one by its position on screen.
function lineDepartmentError(lines, { key = 'department_id', label = 'Department' } = {}) {
  const list = Array.isArray(lines) ? lines : [];
  const idx = list.findIndex((l) => blank(l?.[key]));
  if (idx === -1) return null;
  const missing = list.filter((l) => blank(l?.[key])).length;
  return missing === 1
    ? `Select a ${label} on line ${idx + 1} -- it is required.`
    : `Select a ${label} on every line -- ${missing} lines have none (the first is line ${idx + 1}).`;
}

module.exports = { missingDepartmentError, headerDepartmentError, lineDepartmentError };
