// A Commission Payable's status (unpaid / partial / paid) is decided against the month's LIVE
// Expected Commission from the Commission report -- not the expected_commission stored on the
// payable when it was created.
//
// The stored figure is a snapshot. Job orders keep reaching the passing rate after the payable is
// raised, so the month's Expected grows while the snapshot stays put. Vouchers release against the
// report's live Unpaid, so a rep could be paid past the stale snapshot and the payable flipped to
// PAID while the report still showed money owed -- and a PAID payable drops out of the voucher
// form, so the rest could never be released. CP-36 (Joji Ann Nicole Fuentes, Feb 2026) is the case:
// 9,680.00 stored, 14,960.00 live, 10,611.78 released -> marked paid with 4,313.02 still unpaid.
//
// The stored figures are deliberately left alone: expected_commission is also the payable's GL
// accrual, and rewriting it would move posted entries.
const pool = require('../db');
const { buildCommissionReport } = require('./commissionReport');

const round2 = (n) => Number((Number(n) || 0).toFixed(2));

function payableStatus(expected, released) {
  const e = round2(expected); const r = round2(released);
  if (r <= 0) return 'unpaid';
  if (r + 0.005 >= e) return 'paid';
  return 'partial';
}

// Map of payable id -> { expected, released } from the Commission report, summed over the payable's
// month range: Expected Commission and Released Commission (gross of voucher deductions, less
// paybacks -- the report's own definition). null when the report cannot be built for the
// employee. `reportCache` (a Map keyed `${employeeId}:${year}`) may be shared across calls.
async function liveFiguresByPayable(payableIds, { db = pool, reportCache = new Map() } = {}) {
  const ids = [...new Set((payableIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  const out = new Map();
  if (!ids.length) return out;

  const [rows] = await db.query(
    `SELECT id, employee_id, expected_commission,
            YEAR(period_from) AS fy, MONTH(period_from) AS fm, YEAR(period_to) AS ty, MONTH(period_to) AS tm
       FROM commission_payables WHERE id IN (?)`,
    [ids]
  );
  for (const cp of rows) {
    const fy = Number(cp.fy); const fm = Number(cp.fm);
    const ty = Number(cp.ty) || fy; const tm = Number(cp.tm) || fm;
    if (!fy || !fm) { out.set(Number(cp.id), null); continue; }

    let total = 0;
    let released = 0;
    let built = true;
    for (let i = fy * 12 + (fm - 1); i <= ty * 12 + (tm - 1); i += 1) {
      const year = Math.floor(i / 12); const month = (i % 12) + 1;
      const key = `${cp.employee_id}:${year}`;
      if (!reportCache.has(key)) reportCache.set(key, await buildCommissionReport(cp.employee_id, year));
      const report = reportCache.get(key);
      if (!report) { built = false; break; }
      const row = (report.rows || []).find((r) => r.month === month);
      total += Number(row?.expected_commission) || 0;
      released += Number(row?.released_commission) || 0;
    }
    out.set(Number(cp.id), built ? { expected: round2(total), released: round2(released) } : null);
  }
  return out;
}

// Map of payable id -> live Expected Commission; a payable whose report can't be built is left out,
// so callers fall back to the stored figure with `?? cp.expected_commission`.
async function liveExpectedByPayable(payableIds, opts) {
  const figures = await liveFiguresByPayable(payableIds, opts);
  const out = new Map();
  for (const [id, f] of figures) if (f) out.set(id, f.expected);
  return out;
}

module.exports = { payableStatus, liveFiguresByPayable, liveExpectedByPayable, round2 };
