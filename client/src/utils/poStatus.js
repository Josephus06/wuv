// One reading of a purchase order's status, mirroring server/src/lib/poStatus.js.
//
// Two vocabularies live in purchase_orders.status: the app writes CODES ('pending_approval',
// 'approved'), while the import from the live system wrote that system's LABELS ('Fully Billed',
// 'Approved by General Manager'). On the droplet that is 19,475 rows of labels against 6 of codes.
//
// Comparing to codes alone made this screen show "Fully Billed" while the list called the same PO
// "Pending Receipt", and -- worse -- hid the Receive button on every imported purchase order,
// because 'Approved by General Manager' is not 'approved'.
//
// Duplicated rather than imported because the server cannot be imported from here, the same way
// utils/unitUsed.js mirrors its server counterpart. The two must be changed together.

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

export function normalisePoStatus(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase().replace(/\s+/g, '_');
  return ALIASES[key] || key;
}

// Approved by either route, in either vocabulary -- and anything the source has already moved
// PAST approval counts, since a PO it calls Pending Billing was plainly approved first.
const APPROVED_OR_BEYOND = new Set([
  'approved', 'pending_billing', 'partially_billed', 'fully_billed',
  'partially_received', 'fully_received',
]);

export const isApprovedPo = (raw) => APPROVED_OR_BEYOND.has(normalisePoStatus(raw));
export const isCancelledPo = (raw) => normalisePoStatus(raw) === 'cancelled';

// Settled: nothing further is done to it here. Used to stop offering Receive on a purchase order
// the source already considers finished.
const SETTLED = new Set(['fully_billed', 'cancelled']);
export const isSettledPo = (raw) => SETTLED.has(normalisePoStatus(raw));
