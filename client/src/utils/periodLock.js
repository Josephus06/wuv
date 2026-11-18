import { useEffect, useState } from 'react';
import api from '../api/client';

// Closed accounting periods (Accounting > Manage Accounting Period), read once and shared by every
// transaction screen (2026-10-12). A document dated in a month closed for its category -- or under
// Close All -- shows no Edit / Void / Cancel: the server refuses those anyway (lib/accountingPeriod.js),
// so the buttons are not offered. Re-read after a minute, so a period closed meanwhile takes hold.
//
// Categories, as the server files each transaction:
//   'ar'        Sales Invoice, Customer Payment, Credit Memo, Customer Refund, Deposit, Delivery Ticket
//   'ap'        Vendor Bill, Bill Payment, Bill Credit
//   'other_gl'  Cheque, Journal, Fund Transfer, Commission Voucher / Payable, Asset Disposal / Depreciation
//   'non_gl'    Sales Order, NSSO, Estimate, PO / Receiving / Return, Transfer Order, Item Delivery,
//               Inventory Adjustment, Assembly Build, Quality Inspection, Office Supply Requisition
let cache = { at: 0, promise: null };
function fetchLocks() {
  if (!cache.promise || Date.now() - cache.at > 60 * 1000) {
    cache = {
      at: Date.now(),
      promise: api.get('/manage-accounting-period/locks').then(({ data }) => data || []).catch(() => { cache.at = 0; return []; }),
    };
  }
  return cache.promise;
}

// The reason a date is locked for `category` ('Close All' / 'Close A/R' ...), or null when open.
export function lockReason(locks, date, category) {
  const month = date ? String(date).slice(0, 7) : '';
  const row = month && (locks || []).find((l) => l.month === month);
  if (!row) return null;
  if (row.all) return 'Close All';
  if (row[category]) return { ar: 'Close A/R', ap: 'Close A/P', other_gl: 'Close Other GL', non_gl: 'Close Non-GL' }[category];
  return null;
}

// In a screen: const periodLocked = usePeriodLocked(doc?.date_created, 'ar');
// Returns the reason string when the document's period is closed, else null (falsy).
export function usePeriodLocked(date, category) {
  const [locks, setLocks] = useState([]);
  useEffect(() => { let alive = true; fetchLocks().then((l) => { if (alive) setLocks(l); }); return () => { alive = false; }; }, []);
  return lockReason(locks, date, category);
}
