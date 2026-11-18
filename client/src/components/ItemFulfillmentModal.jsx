import { useState } from 'react';
import api from '../api/client';
import LoadingSpinner from './LoadingSpinner';
import { isNonStockItem } from '../utils/itemTypes';

import { displayDate } from '../utils/dates';

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}
function formatDate(v) { return v ? displayDate(v) : '—'; }

// Mirrors the real "Item Fulfillment" popup reached from a Transfer Order's Fulfill
// button -- a transaction of its own, distinct from the TO. Saving it only pulls stock
// out of Withdraw From right now; the destination doesn't get it until a later Item
// Receipt step this build doesn't model, so each line's remaining balance (its own qty,
// or Adjusted Qty if tweaked, minus whatever's already been fulfilled across earlier
// Item Fulfillments) is what caps Qty to Fulfill here -- lines already fully fulfilled
// don't show up at all.
export default function ItemFulfillmentModal({ to, lines, onClose, onSaved }) {
  const [dateCreated, setDateCreated] = useState(new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState('');
  const [qtyToFulfill, setQtyToFulfill] = useState({});
  const [lineMemo, setLineMemo] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const fulfillableLines = lines.filter((l) => Number(l.fulfilled || 0) < Number(l.adjusted_qty ?? l.qty));

  async function handleSave() {
    setError('');
    const payload = fulfillableLines
      .map((l) => ({ transfer_order_line_id: l.id, qty_to_fulfill: qtyToFulfill[l.id] || 0, memo: lineMemo[l.id] || '' }))
      .filter((l) => Number(l.qty_to_fulfill) > 0);
    if (!payload.length) { setError('Enter a Qty to Fulfill for at least one item.'); return; }

    setSaving(true);
    try {
      await api.post(`/transfer-orders/${to.id}/item-fulfillments`, { date_created: dateCreated, memo, lines: payload });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-xl" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="estimate-banner" style={{ borderRadius: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <h2 style={{ margin: 0, color: '#fff' }}>Item Fulfillment</h2>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 24, lineHeight: 1, cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ padding: 24 }}>
          {error && <div className="error-banner">{error}</div>}

          <div className="estimate-detail-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
            <div>
              <div className="field">
                <label>Date Created</label>
                <input type="date" value={dateCreated} onChange={(e) => setDateCreated(e.target.value)} />
              </div>
              <div>TO # : <span className="hi">{to.to_no}</span></div>
              <div>TO Date : <span className="hi">{formatDate(to.date_created)}</span></div>
            </div>
            <div>
              <div>Withdraw From : <span className="hi">{to.withdraw_from_name}</span></div>
              <div>Requested To : <span className="hi">{to.transfer_to_name}</span></div>
              <div>Requestor : <span className="hi">{to.requestor_name || '—'}</span></div>
              <div className="field" style={{ marginTop: 8 }}>
                <label>Memo</label>
                <textarea rows={2} value={memo} onChange={(e) => setMemo(e.target.value)} />
              </div>
            </div>
          </div>

          <div className="table-wrap" style={{ marginTop: 20 }}>
            <table>
              <thead>
                <tr>
                  <th></th><th>Item</th><th>Qty</th><th>UOM</th><th>Unit</th>
                  <th>Committed</th><th>Fulfilled</th><th>Qty to Fulfill</th><th>Memo</th>
                </tr>
              </thead>
              <tbody>
                {fulfillableLines.length === 0 && (
                  <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>Everything on this transfer order is already fulfilled.</td></tr>
                )}
                {fulfillableLines.map((l, idx) => {
                  // A Service line has no stock to commit, so Committed never moves off 0
                  // and the committed check would block it forever -- its cap is simply
                  // whatever's left on the line. See utils/itemTypes.js; the same rule
                  // gates the server side in routes/transferOrders.js.
                  const nonStock = isNonStockItem(l.item_type);
                  // `committed` is the quantity still reserved and unshipped -- it comes down as
                  // each fulfilment goes out -- so it is the cap as it stands. Subtracting
                  // `fulfilled` from it again double-counted a reservation made after a partial
                  // shipment, which is already net of it. Mirrors routes/transferOrders.js.
                  const committedRemaining = Number(l.committed || 0);
                  const remaining = Number(l.adjusted_qty ?? l.qty) - Number(l.fulfilled || 0);
                  // Never more than the order has left to give, whatever the reservation says --
                  // the same belt-and-braces the server applies, and what keeps a legacy line
                  // whose committed was never decremented from being over-fulfilled.
                  const cap = nonStock ? remaining : Math.min(committedRemaining, remaining);
                  const blocked = !nonStock && cap <= 0;
                  return (
                    <tr key={l.id}>
                      <td style={{ color: '#db2777', fontWeight: 600 }}>{idx + 1}</td>
                      <td>{l.item_code} {l.item_name ? `— ${l.item_name}` : ''}</td>
                      <td>{qty(l.qty)}</td>
                      <td>{l.uom}</td>
                      <td>{l.unit}</td>
                      <td>{nonStock ? <span className="muted" title="Service items hold no stock, so nothing is committed.">—</span> : qty(l.committed)}</td>
                      <td>{qty(l.fulfilled)}</td>
                      <td>
                        {blocked ? (
                          <span className="muted" title="Reallocate stock to this order before it can be fulfilled.">Not committed</span>
                        ) : (
                          <input
                            type="number" step="0.0001" max={cap} style={{ width: 100 }}
                            value={qtyToFulfill[l.id] ?? ''}
                            onChange={(e) => setQtyToFulfill((prev) => ({ ...prev, [l.id]: e.target.value }))}
                          />
                        )}
                      </td>
                      <td>
                        <input
                          disabled={blocked}
                          style={{ width: 120 }}
                          value={lineMemo[l.id] ?? ''}
                          onChange={(e) => setLineMemo((prev) => ({ ...prev, [l.id]: e.target.value }))}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={saving || fulfillableLines.length === 0} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
