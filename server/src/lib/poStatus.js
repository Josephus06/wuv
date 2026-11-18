// One reading of purchase_orders.status, because two vocabularies live in that column.
//
// The app writes CODES -- 'pending_approval', 'approved', 'cancelled'. The import from the live
// system wrote that system's LABELS -- 'Fully Billed', 'Approved by General Manager', 'Pending
// Approval for GM'. On the droplet that is 19,475 rows of labels against 6 rows of codes, so code
// that compares to codes alone is wrong about almost every purchase order in the database.
//
// It showed up as the list calling a PO "Pending Receipt" while the PO itself said "Fully Billed"
// -- same column, opposite answers -- but the damaging part was quieter: `status !== 'approved'`
// refuses to RECEIVE against a PO or hang a Landed Cost on it, and 'Approved by General Manager'
// is not 'approved'. Every imported PO awaiting receipt was unusable for both.
//
// Normalising at read time rather than rewriting the column: those labels came from the source
// system and Sync from Source writes them again, so a one-off UPDATE would be undone by the next
// sync and the bug would return.
//
// 'Approved by Supervisor' and 'Approved by General Manager' both mean APPROVED. Which of them it
// was is recorded separately (approved_by_gm_user_id) and does not change what may be done next.

// Normalised label -> canonical code. Keyed on lower-case with underscores for spaces, so a label
// and its code both land here.
const ALIASES = {
  pending_approval: 'pending_approval',
  pending_approval_gm: 'pending_approval_gm',
  pending_approval_for_gm: 'pending_approval_gm',
  approved: 'approved',
  approved_by_supervisor: 'approved',
  approved_by_general_manager: 'approved',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  pending_billing: 'pending_billing',
  partially_billed: 'partially_billed',
  fully_billed: 'fully_billed',
  billed: 'fully_billed',
  partially_received: 'partially_received',
  fully_received: 'fully_received',
  request_in_process: 'request_in_process',
};

function normalisePoStatus(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase().replace(/\s+/g, '_');
  return ALIASES[key] || key;
}

// Is this purchase order approved -- by either route, in either vocabulary?
//
// A PO the source already calls Pending Billing, Partially Billed or Fully Billed was approved and
// has moved past it, so those count too: refusing to receive against a "Pending Billing" PO on the
// grounds that it is not literally "approved" would be pedantry, not a rule.
const APPROVED_OR_BEYOND = new Set([
  'approved', 'pending_billing', 'partially_billed', 'fully_billed',
  'partially_received', 'fully_received',
]);

function isApproved(raw) {
  return APPROVED_OR_BEYOND.has(normalisePoStatus(raw));
}

const isCancelled = (raw) => normalisePoStatus(raw) === 'cancelled';

// The same normalisation in SQL, for queries that must group or filter by status. `col` is the
// qualified column, e.g. 'po.status'.
const statusNormSql = (col = 'po.status') => `LOWER(REPLACE(TRIM(${col}), ' ', '_'))`;

module.exports = { normalisePoStatus, isApproved, isCancelled, statusNormSql, ALIASES };
