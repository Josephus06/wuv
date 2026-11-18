// Which Estimates may be invoiced directly, without a Sales Order behind them.
//
// TWO CONDITIONS, and both matter:
//
// 1. THE SUPERVISOR HAS APPROVED IT. There is no status literally called "approved by
//    supervisor" -- supervisor approval is the act that moves an estimate OUT of
//    `pending_supervisor_approval`, and routes/estimates.js gates that transition on the
//    Can Approve Sales Estimate flag. So an estimate has cleared it once it sits in
//    `pending_customer_approval` or `approved`. EstimateView already draws exactly this
//    line for Print ("the real system only shows Print once an estimate has cleared
//    supervisor approval"), and billing is the stricter act of the two.
//
//    This is what keeps CANCELLED and DISAPPROVED estimates out. Both were billable before
//    this rule existed -- 35 cancelled and 9 disapproved estimates carry line items.
//
// 2. IT HAS LINE ITEMS. 68,000-odd estimates are migrated headers with no
//    estimate_job_orders at all; there is nothing on them to invoice.
//
// Enforced in three places, all from here: the picker's list, the form that sources the
// lines, and the save. The picker being filtered is a convenience, not a restriction --
// the save is what actually decides.

const SUPERVISOR_APPROVED_STATUSES = ['pending_customer_approval', 'approved'];

// Reads the way the rejection message needs to: why this estimate cannot be billed, or null
// when it can be. `row` needs `status`, and `has_lines` when the caller has it.
function whyNotBillable(row, { hasLines = null } = {}) {
  if (!row) return 'That Estimate no longer exists.';
  if (!SUPERVISOR_APPROVED_STATUSES.includes(row.status)) {
    if (row.status === 'pending_supervisor_approval') {
      return 'This Estimate has not been approved by a supervisor yet, so it cannot be invoiced.';
    }
    if (row.status === 'cancelled' || row.status === 'disapproved') {
      return `This Estimate is ${row.status} and cannot be invoiced.`;
    }
    return 'This Estimate has not been approved by a supervisor yet, so it cannot be invoiced.';
  }
  if (hasLines === false) return 'This Estimate has no line items to invoice.';
  return null;
}

// SQL fragment for the list filter, with no bound parameters to thread through callers that
// build their own WHERE. The status list is interpolated from the constant above rather than
// written out again, so the two can never drift.
const BILLABLE_ESTIMATE_SQL = `e.status IN (${SUPERVISOR_APPROVED_STATUSES.map((s) => `'${s}'`).join(', ')})
      AND EXISTS (SELECT 1 FROM estimate_job_orders ejo WHERE ejo.estimate_id = e.id)`;

module.exports = { SUPERVISOR_APPROVED_STATUSES, whyNotBillable, BILLABLE_ESTIMATE_SQL };
