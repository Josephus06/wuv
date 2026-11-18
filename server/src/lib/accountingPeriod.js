// Accounting-period lock: once a fiscal-year month is closed (via Manage Accounting Period), no
// transaction dated in that month may be posted, edited, or voided. Each transaction type maps to a
// close category -- 'ar' (receivables), 'ap' (payables), 'other_gl' (cash/journal/etc), 'non_gl' --
// and a month is locked for it when that category's flag is set OR when Close All is set.
const pool = require('../db');

const CATEGORY_FLAG = { ar: 'close_ar', ap: 'close_ap', other_gl: 'close_other_gl', non_gl: 'close_non_gl' };
const CATEGORY_LABEL = { ar: 'A/R', ap: 'A/P', other_gl: 'Other GL', non_gl: 'Non-GL' };

// Returns a short reason string if the given date's month is locked for `category`, else null.
async function periodLock(dateStr, category, conn = pool) {
  if (!dateStr) return null;
  const [y, m] = String(dateStr).slice(0, 10).split('-').map(Number);
  if (!y || !m) return null;
  const [[row]] = await conn.query('SELECT close_all, ?? AS flag FROM accounting_periods WHERE fiscal_year = ? AND period_month = ?', [CATEGORY_FLAG[category] || 'close_all', y, m]);
  if (!row) return null;
  if (row.close_all) return 'Close All';
  if (row.flag) return `Close ${CATEGORY_LABEL[category] || category}`;
  return null;
}

// Throws a 409 if the period is locked for this category. Pass every date the change touches (e.g.
// both the old and new dates on an edit) so you can't move a transaction across a closed boundary.
async function assertPeriodOpen(dates, category, conn = pool) {
  const list = (Array.isArray(dates) ? dates : [dates]).filter(Boolean);
  for (const d of list) {
    const reason = await periodLock(d, category, conn);
    if (reason) {
      const err = new Error(`The accounting period for ${String(d).slice(0, 10)} is closed (${reason}). Posting or editing transactions in a closed period is not allowed.`);
      err.status = 409;
      throw err;
    }
  }
}

// Route guard (2026-10-12): refuses any change to the document at req.params.id when its own date
// falls in a month closed for `category`. For the routes that edit a saved document without
// otherwise reaching assertPeriodOpen -- Sales Orders, NSSOs, Estimates and a few single-field edits.
function requireOpenPeriod(table, category, dateColumn = 'date_created') {
  return async (req, res, next) => {
    try {
      const [[row]] = await pool.query('SELECT ?? AS d FROM ?? WHERE id = ?', [dateColumn, table, req.params.id]);
      if (row && row.d) await assertPeriodOpen(String(row.d instanceof Date ? row.d.toISOString() : row.d).slice(0, 10), category);
      return next();
    } catch (err) { return next(err); }
  };
}

// The Sales Rep on a Sales Order is what its month's commission is worked on, so it is fixed once
// the month is closed for ANYTHING -- A/R, A/P, Other GL, Non-GL or Close All (asked 2026-10-26:
// SO-71491/71492, August, moved from Nina Ann Solano to Jessa Mae Lagat on 17 Oct with August's A/R,
// A/P and Other GL closed but Non-GL still open). Throws a 409 naming what is closed.
async function assertRepChangeAllowed(dateStr, conn = pool) {
  if (!dateStr) return;
  const [y, m] = String(dateStr).slice(0, 10).split('-').map(Number);
  const [[row]] = await conn.query('SELECT * FROM accounting_periods WHERE fiscal_year = ? AND period_month = ?', [y, m]);
  if (!row) return;
  const closed = row.close_all ? ['All'] : Object.entries(CATEGORY_FLAG).filter(([, f]) => row[f]).map(([c]) => CATEGORY_LABEL[c]);
  if (!closed.length) return;
  const err = new Error(`The accounting period for ${String(dateStr).slice(0, 7)} is closed (${closed.map((c) => `Close ${c}`).join(', ')}). The Sales Rep of an order in a closed period can no longer be changed.`);
  err.status = 409;
  throw err;
}

module.exports = { periodLock, assertPeriodOpen, requireOpenPeriod, assertRepChangeAllowed };
