// Shared "released commission" allocation for the Commission report and Commission Payable.
//
// A Commission Voucher releases commission against one or more monthly payables (its lines carry a
// gross released amount each) and may add expense adjustments. Per the business rule:
//   - a DEDUCTION (negative expense) waterfalls from the EARLIEST month, reducing that month's net
//     released until the deduction is used up, then spilling into the next month, and so on;
//   - a REFUND (positive expense) is added to the earliest month;
//   - the NET released for a month = gross − deducted + refunded, and the voucher's total net
//     released equals its Total Payments ("the total voucher created").
// e.g. Jan 1000 / Feb 215 with a −1115 deduction => Jan 0 (deducted 1000), Feb 100 (deducted 115).
const pool = require('../db');
const round2 = (n) => Number((Number(n) || 0).toFixed(2));

// Pure allocation for a single voucher. lines: [{ month, gross, ...passthrough }].
function allocateVoucher(lines, deductTotal, refundTotal) {
  const out = [...lines].sort((a, b) => a.month - b.month).map((l) => ({ ...l, deducted: 0, refunded: 0 }));
  let remaining = round2(deductTotal);
  for (const l of out) {
    if (remaining <= 0) break;
    const ded = Math.min(remaining, round2(l.gross));
    l.deducted = round2(ded);
    remaining = round2(remaining - ded);
  }
  if (out.length && refundTotal) out[0].refunded = round2(refundTotal);
  for (const l of out) l.net = round2(Number(l.gross) - l.deducted + l.refunded);
  return out;
}

// An expense pointed at a specific month is a PAYBACK, not a deduction or a refund, and is
// excluded from both pools here so the waterfalls never see it -- it is applied straight to
// its own month further down instead.
const isTargeted = (e) => e.applies_to_payable_id != null;

function splitExpenses(expenseRows) {
  let d = 0; let r = 0;
  for (const e of expenseRows) {
    if (isTargeted(e)) continue;
    const a = Number(e.amount) || 0; if (a < 0) d += -a; else r += a;
  }
  return { d: round2(d), r: round2(r) };
}

// Paybacks for one employee/year, summed per month.
//
// A payback settles an overpayment: it reduces the month's released WITHOUT the offsetting
// change to deducted that a refund makes. That distinction is the entire point -- a refund
// adds to released and takes the same off deducted, so `unpaid = confirmed - (released +
// deducted)` does not move, and an overpayment can never be cleared with one.
//
// Only expenses on Commission Payable (24200) carry a target; every other account keeps the
// deduction/refund behaviour it has always had. Resolved by account code, the same way
// glImpact.js finds the account, because the id differs between databases.
const COMMISSION_PAYABLE_CODE = '24200';

async function paybackByMonthForEmployee(employeeId, year) {
  const byMonth = new Array(13).fill(0);
  const [cols] = await pool.query("SHOW COLUMNS FROM commission_voucher_expenses LIKE 'applies_to_payable_id'");
  if (!cols.length) return byMonth; // migration not run here yet

  const [rows] = await pool.query(
    `SELECT MONTH(cp.period_from) AS month, cve.amount
       FROM commission_voucher_expenses cve
       JOIN commission_vouchers cv ON cv.id = cve.commission_voucher_id
       JOIN commission_payables cp ON cp.id = cve.applies_to_payable_id
       JOIN chart_of_accounts coa ON coa.id = cve.account_id
      WHERE cve.applies_to_payable_id IS NOT NULL
        AND coa.account_code = ?
        AND cv.status <> 'void'
        AND cp.employee_id = ? AND YEAR(cp.period_from) = ?`,
    [COMMISSION_PAYABLE_CODE, employeeId, year],
  );
  for (const r of rows) byMonth[Number(r.month)] = round2(byMonth[Number(r.month)] + (Number(r.amount) || 0));
  return byMonth;
}

async function tablesExist() {
  const [t] = await pool.query("SHOW TABLES LIKE 'commission_voucher_lines'");
  return t.length > 0;
}

// Selected explicitly rather than with * so a database where the migration has not been run
// still reads: the column simply comes back NULL and every expense stays a deduction/refund.
async function hasTargetColumn() {
  const [cols] = await pool.query("SHOW COLUMNS FROM commission_voucher_expenses LIKE 'applies_to_payable_id'");
  return cols.length > 0;
}
const expenseSelect = (targeted) => (targeted
  ? 'commission_voucher_id AS vid, amount, applies_to_payable_id'
  : 'commission_voucher_id AS vid, amount, NULL AS applies_to_payable_id');

// Per-month net released / deducted / refunded for one employee's vouchers in a year.
async function releaseByMonthForEmployee(employeeId, year) {
  const releasedByMonth = new Array(13).fill(0);
  const deductedByMonth = new Array(13).fill(0);
  const refundedByMonth = new Array(13).fill(0);
  if (!(await tablesExist())) return { releasedByMonth, deductedByMonth, refundedByMonth };

  const [vlines] = await pool.query(
    `SELECT cv.id AS vid, MONTH(cp.period_from) AS month, cvl.released_amount AS gross
     FROM commission_voucher_lines cvl
     JOIN commission_vouchers cv ON cv.id = cvl.commission_voucher_id
     JOIN commission_payables cp ON cp.id = cvl.commission_payable_id
     WHERE cp.employee_id = ? AND YEAR(cp.period_from) = ? AND cv.status <> 'void'`,
    [employeeId, year]
  );
  const byV = new Map();
  for (const l of vlines) { const g = byV.get(l.vid) || []; g.push({ month: Number(l.month), gross: Number(l.gross) }); byV.set(l.vid, g); }
  const lineVids = [...byV.keys()];
  const targeted = await hasTargetColumn();
  const expByV = new Map();
  if (lineVids.length) {
    const [exps] = await pool.query(
      `SELECT ${expenseSelect(targeted)} FROM commission_voucher_expenses WHERE commission_voucher_id IN (?)`,
      [lineVids],
    );
    for (const e of exps) { const g = expByV.get(e.vid) || []; g.push(e); expByV.set(e.vid, g); }
  }

  // Expense-only vouchers (no commission line) -- a pure refund/deduction not attached to a release.
  // These never surface via the line->payable join above, so pull them separately and attribute
  // them to their own date_created year. Positive amount = refund (pooled below); negative = a
  // deduction waterfalled across the year's released months.
  //
  // A payback is excluded here too. It is normally raised on exactly this kind of voucher --
  // no commission line, just the expense -- so without this exclusion it would land in the
  // refund pool, which is the behaviour being replaced.
  const [expOnly] = await pool.query(
    `SELECT cve.amount
       FROM commission_voucher_expenses cve
       JOIN commission_vouchers cv ON cv.id = cve.commission_voucher_id
      WHERE cv.employee_id = ? AND YEAR(cv.date_created) = ? AND cv.status <> 'void'
        ${targeted ? 'AND cve.applies_to_payable_id IS NULL' : ''}
        AND NOT EXISTS (SELECT 1 FROM commission_voucher_lines cvl WHERE cvl.commission_voucher_id = cv.id)`,
    [employeeId, year]
  );

  // Gross released per month + per-voucher DEDUCTION waterfall (deductions only). Refunds are pooled
  // across all of this employee's vouchers and applied afterward across the deducted months -- a
  // refund raised on a LATER voucher cancels an EARLIER deduction (business rule), so it can't be a
  // per-voucher step.
  const grossByMonth = new Array(13).fill(0);
  const rawDeductedByMonth = new Array(13).fill(0);
  let totalRefund = 0;
  for (const [vid, lines] of byV) {
    const { d, r } = splitExpenses(expByV.get(vid) || []);
    totalRefund = round2(totalRefund + r);
    for (const a of allocateVoucher(lines, d, 0)) { // refundTotal 0 -> deduction-only waterfall
      grossByMonth[a.month] = round2(grossByMonth[a.month] + Number(a.gross));
      rawDeductedByMonth[a.month] = round2(rawDeductedByMonth[a.month] + a.deducted);
    }
  }

  // Fold in expense-only vouchers: a positive amount joins the refund pool; a negative amount is a
  // pooled deduction waterfalled across the released months (earliest first).
  let pooledDeduction = 0;
  for (const e of expOnly) {
    const a = Number(e.amount) || 0;
    if (a > 0) totalRefund = round2(totalRefund + a);
    else pooledDeduction = round2(pooledDeduction - a);
  }
  for (let m = 1; m <= 12 && pooledDeduction > 0; m += 1) {
    const avail = round2(grossByMonth[m] - rawDeductedByMonth[m]);
    if (avail <= 0) continue;
    const applied = round2(Math.min(pooledDeduction, avail));
    rawDeductedByMonth[m] = round2(rawDeductedByMonth[m] + applied);
    pooledDeduction = round2(pooledDeduction - applied);
  }

  // Waterfall the pooled refunds across the deducted months, earliest first -- each refund cancels
  // that month's deduction (zeroing it out) before spilling into the next deducted month.
  let remaining = round2(totalRefund);
  for (let m = 1; m <= 12 && remaining > 0; m += 1) {
    if (rawDeductedByMonth[m] <= 0) continue;
    const applied = round2(Math.min(remaining, rawDeductedByMonth[m]));
    refundedByMonth[m] = round2(refundedByMonth[m] + applied);
    remaining = round2(remaining - applied);
  }
  // Any refund beyond the total deductions adds to the earliest month with released commission.
  if (remaining > 0) {
    const firstGross = grossByMonth.findIndex((g, i) => i >= 1 && g > 0);
    if (firstGross >= 1) refundedByMonth[firstGross] = round2(refundedByMonth[firstGross] + remaining);
  }

  // Paybacks: applied to the month they were pointed at, and to nothing else. Deliberately not
  // folded into the refund pool or the deduction waterfall above -- a payback settles an
  // overpayment on ONE month, and spilling it into another would move an overpayment around
  // rather than clear it.
  const paybackByMonth = await paybackByMonthForEmployee(employeeId, year);

  // Net columns: Released = gross - deducted + refunded - payback; Deducted is shown NET of the
  // refunds that cancelled it (0 once fully refunded), and is untouched by a payback -- which is
  // exactly what makes a payback move `unpaid` where a refund cannot.
  for (let m = 1; m <= 12; m += 1) {
    releasedByMonth[m] = round2(grossByMonth[m] - rawDeductedByMonth[m] + refundedByMonth[m] - paybackByMonth[m]);
    deductedByMonth[m] = round2(Math.max(rawDeductedByMonth[m] - refundedByMonth[m], 0));
  }
  // grossReleasedByMonth: what the vouchers paid against each month BEFORE any deduction, less a
  // payback aimed at that month -- the source system's "Released Commission" (2026-10-03: Nina's
  // January is 6,248.53 there, the sum of her five voucher lines, not 3,008.57 after the waterfall).
  const grossReleasedByMonth = new Array(13).fill(0);
  for (let m = 1; m <= 12; m += 1) grossReleasedByMonth[m] = round2(grossByMonth[m] - paybackByMonth[m]);
  return { releasedByMonth, deductedByMonth, refundedByMonth, paybackByMonth, grossReleasedByMonth };
}

// Net released / deducted / refunded allocated to a single payable across every voucher that pays
// it (each voucher's waterfall is computed over all of that voucher's lines, then this payable's
// share extracted).
async function releaseForPayable(payableId) {
  if (!(await tablesExist())) return { released: 0, deducted: 0, refunded: 0 };
  const [vs] = await pool.query(
    `SELECT DISTINCT cvl.commission_voucher_id AS vid FROM commission_voucher_lines cvl
     JOIN commission_vouchers cv ON cv.id = cvl.commission_voucher_id
     WHERE cvl.commission_payable_id = ? AND cv.status <> 'void'`,
    [payableId]
  );
  const targeted = await hasTargetColumn();
  let released = 0; let deducted = 0; let refunded = 0;
  for (const { vid } of vs) {
    const [lines] = await pool.query(
      `SELECT cvl.commission_payable_id AS pid, MONTH(cp.period_from) AS month, cvl.released_amount AS gross
       FROM commission_voucher_lines cvl JOIN commission_payables cp ON cp.id = cvl.commission_payable_id
       WHERE cvl.commission_voucher_id = ?`,
      [vid]
    );
    const [exps] = await pool.query(
      `SELECT ${expenseSelect(targeted)} FROM commission_voucher_expenses WHERE commission_voucher_id = ?`,
      [vid],
    );
    const { d, r } = splitExpenses(exps);
    for (const a of allocateVoucher(lines.map((l) => ({ pid: l.pid, month: Number(l.month), gross: Number(l.gross) })), d, r)) {
      if (Number(a.pid) === Number(payableId)) { released += a.net; deducted += a.deducted; refunded += a.refunded; }
    }
  }

  // Paybacks pointed at THIS payable, from any voucher -- including an expense-only one that
  // never appears in the line join above, which is how a payback is usually raised.
  let payback = 0;
  if (targeted) {
    const [[row]] = await pool.query(
      `SELECT COALESCE(SUM(cve.amount), 0) AS total
         FROM commission_voucher_expenses cve
         JOIN commission_vouchers cv ON cv.id = cve.commission_voucher_id
         JOIN chart_of_accounts coa ON coa.id = cve.account_id
        WHERE cve.applies_to_payable_id = ? AND coa.account_code = ? AND cv.status <> 'void'`,
      [payableId, COMMISSION_PAYABLE_CODE],
    );
    payback = round2(row.total);
  }

  return {
    released: round2(released - payback), deducted: round2(deducted), refunded: round2(refunded), payback,
  };
}

module.exports = { allocateVoucher, releaseByMonthForEmployee, releaseForPayable };
