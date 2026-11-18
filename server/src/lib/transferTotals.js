// Transfer Order running totals, and the status derived from them.
//
// A TO line keeps `fulfilled` and `received`; an Item Fulfillment line keeps `received`. The
// screens add to them as documents are saved here, but the importer (db/import-transfer-chain.js)
// stored a TO line's totals ONCE, as the old system reported them when the TO was imported, and
// inserted later Fulfillments and Receipts without adding to anything. So a TO imported on 9-28 and
// fulfilled again on 9-30 kept the 9-28 figure (TO-38777: fulfilled 22,901 against fulfillments of
// 27,800), and fulfillment lines read 0 received however much had been received against them --
// which the Receive screen takes as still to receive (found 2026-10-09).
//
// raiseTransferTotals lifts each total to what its documents add up to, and never lowers one: a
// total above its documents is an old-system figure whose document did not import, and the
// figure is the better record of the two.

// The Transfer Order's status is entirely derived from its lines' own running totals --
// never set directly except for the one manual, terminal exception ('cancelled'). Sums
// (not per-line comparisons) are what distinguish "partially fulfilled" from "pending
// receipt / partially fulfilled": some lines can already be fully received while others
// still haven't been fulfilled at all, and it's the aggregate position across the whole
// order that decides which of the real system's six tabs a TO sits in.
function computeTOStatus(lines) {
  const totalTarget = lines.reduce((s, l) => s + Number(l.adjusted_qty ?? l.qty), 0);
  const totalFulfilled = lines.reduce((s, l) => s + Number(l.fulfilled || 0), 0);
  const totalReceived = lines.reduce((s, l) => s + Number(l.received || 0), 0);
  if (totalFulfilled <= 0) return 'pending_fulfillment';
  // What separates the two partial states is stock *in transit*, not stock already
  // received: a partly-fulfilled order whose fulfillments are still unreceived is
  // "Pending Receipt / Partially Fulfilled" (it has something to receive), while one
  // whose every fulfillment has landed is plain "Partially Fulfilled" (nothing to
  // receive -- only more to fulfill). Keying off totalReceived > 0 instead gets the
  // very first partial fulfillment wrong and hides the Receive button on it.
  if (totalFulfilled < totalTarget) return totalReceived < totalFulfilled ? 'pending_receipt_partially_fulfilled' : 'partially_fulfilled';
  return totalReceived < totalFulfilled ? 'pending_receipt' : 'received';
}

const EPS = 0.00005;
// How far along a TO is. The two partial states are the same stage.
const STAGE = { pending_fulfillment: 0, partially_fulfilled: 1, pending_receipt_partially_fulfilled: 1, pending_receipt: 2, received: 3 };

// toIds: limit to these Transfer Orders (an importer run), or null for every one (the repair).
// Returns what changed (or, with dryRun, what would): counts, and every status change.
// userId: who the status-change audit rows name (audit_logs.set_by_user_id is NOT NULL); user #1,
// the admin, when a script runs it.
async function raiseTransferTotals(conn, { toIds = null, dryRun = false, userId = 1 } = {}) {
  if (Array.isArray(toIds) && !toIds.length) return { ifl: 0, fulfilled: 0, received: 0, statuses: [] };
  const scope = Array.isArray(toIds) ? 'AND tol.transfer_order_id IN (?)' : '';
  const sp = Array.isArray(toIds) ? [toIds] : [];

  const [iflRows] = await conn.query(
    `SELECT ifl.id, r.s FROM item_fulfillment_lines ifl
       JOIN transfer_order_lines tol ON tol.id = ifl.transfer_order_line_id
       JOIN (SELECT item_fulfillment_line_id id, SUM(qty_received) s FROM item_receipt_lines GROUP BY item_fulfillment_line_id) r ON r.id = ifl.id
      WHERE COALESCE(ifl.received, 0) < r.s - ${EPS} ${scope}`, sp);
  const [fRows] = await conn.query(
    `SELECT tol.id, tol.transfer_order_id, f.s FROM transfer_order_lines tol
       JOIN (SELECT transfer_order_line_id id, SUM(qty_fulfilled) s FROM item_fulfillment_lines GROUP BY transfer_order_line_id) f ON f.id = tol.id
      WHERE COALESCE(tol.fulfilled, 0) < f.s - ${EPS} ${scope}`, sp);
  const [rRows] = await conn.query(
    `SELECT tol.id, tol.transfer_order_id, r.s FROM transfer_order_lines tol
       JOIN (SELECT transfer_order_line_id id, SUM(qty_received) s FROM item_receipt_lines GROUP BY transfer_order_line_id) r ON r.id = tol.id
      WHERE COALESCE(tol.received, 0) < r.s - ${EPS} ${scope}`, sp);

  if (!dryRun) {
    for (const r of iflRows) await conn.query('UPDATE item_fulfillment_lines SET received = ? WHERE id = ?', [r.s, r.id]);
    for (const r of fRows) await conn.query('UPDATE transfer_order_lines SET fulfilled = ? WHERE id = ?', [r.s, r.id]);
    for (const r of rRows) await conn.query('UPDATE transfer_order_lines SET received = ? WHERE id = ?', [r.s, r.id]);
  }

  // Status follows the totals on every TO a line total moved on. A dry run works it out from
  // the totals as they WOULD be.
  const touched = [...new Set([...fRows, ...rRows].map((r) => r.transfer_order_id))];
  const statuses = [];
  if (touched.length) {
    const newF = new Map(fRows.map((r) => [r.id, r.s]));
    const newR = new Map(rRows.map((r) => [r.id, r.s]));
    const [heads] = await conn.query('SELECT id, to_no, status FROM transfer_orders WHERE id IN (?)', [touched]);
    const [lines] = await conn.query(
      'SELECT id, transfer_order_id, qty, adjusted_qty, fulfilled, received FROM transfer_order_lines WHERE transfer_order_id IN (?)', [touched]);
    for (const h of heads) {
      if (h.status === 'cancelled') continue;
      const mine = lines.filter((l) => l.transfer_order_id === h.id)
        .map((l) => ({ ...l, fulfilled: newF.get(l.id) ?? l.fulfilled, received: newR.get(l.id) ?? l.received }));
      const next = computeTOStatus(mine);
      // Forward only. An imported status is the old system's own word, and it can know more than
      // the documents that made it here: 57 TOs it closed as Received have lines whose documents
      // never imported (TO-38111 reads 0 fulfilled on every line). Raising totals is never a reason
      // to reopen one.
      if (next === h.status || (STAGE[next] ?? 0) < (STAGE[h.status] ?? 0)) continue;
      statuses.push({ id: h.id, to_no: h.to_no, from: h.status, to: next });
      if (!dryRun) {
        await conn.query('UPDATE transfer_orders SET status = ?, updated_at = NOW() WHERE id = ?', [next, h.id]);
        await conn.query(
          `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
           VALUES ('TransferOrder', ?, 'Status Change', 'status', ?, ?, ?)`, [h.id, h.status, next, userId]);
      }
    }
  }
  return { ifl: iflRows.length, fulfilled: fRows.length, received: rRows.length, statuses };
}

module.exports = { computeTOStatus, raiseTransferTotals };
