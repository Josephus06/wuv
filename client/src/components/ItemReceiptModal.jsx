import { useEffect, useState } from 'react';
import api from '../api/client';
import LoadingSpinner from './LoadingSpinner';
import { displayDate } from '../utils/dates';

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}
function formatDate(v) { return v ? displayDate(v) : '—'; }

// Mirrors the real "Item Receipt" popup -- the other half of the two-step stock move
// Item Fulfillment starts. Saving this is what actually lands stock at Transfer To.
// Raised against one specific Item Fulfillment batch; each line's own remaining balance
// (qty_fulfilled minus what's already been received off that same batch) caps Qty to
// Receive here, same discipline as ItemFulfillmentModal's Committed cap.
export default function ItemReceiptModal({ fulfillmentId, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [dateCreated, setDateCreated] = useState(new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState('');
  const [qtyToReceive, setQtyToReceive] = useState({});
  const [lineMemo, setLineMemo] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/transfer-orders/item-fulfillments/${fulfillmentId}`).then(({ data: d }) => { setData(d); setLoading(false); });
  }, [fulfillmentId]);

  if (loading || !data) {
    return (
      <div className="modal-overlay">
        <div className="modal modal-xl"><LoadingSpinner /></div>
      </div>
    );
  }

  const receivableLines = data.lines.filter((l) => Number(l.received || 0) < Number(l.qty_fulfilled || 0));

  async function handleSave() {
    setError('');
    const payload = receivableLines
      .map((l) => ({ item_fulfillment_line_id: l.id, qty_to_receive: qtyToReceive[l.id] || 0, memo: lineMemo[l.id] || '' }))
      .filter((l) => Number(l.qty_to_receive) > 0);
    if (!payload.length) { setError('Enter a Qty to Receive for at least one item.'); return; }

    setSaving(true);
    try {
      const { data: receipt } = await api.post(`/transfer-orders/item-fulfillments/${fulfillmentId}/item-receipts`, { date_created: dateCreated, memo, lines: payload });
      onSaved(receipt);
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
          <h2 style={{ margin: 0, color: '#fff' }}>Item Receipt</h2>
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
              <div>TO # : <span className="hi">{data.to_no}</span></div>
              <div>TO Date : <span className="hi">{formatDate(data.to_date_created)}</span></div>
              <div>IF # : <span className="hi">{data.fulfillment_no}</span></div>
              <div>IF Date : <span className="hi">{formatDate(data.date_created)}</span></div>
            </div>
            <div>
              <div>Withdraw From : <span className="hi">{data.withdraw_from_name}</span></div>
              <div>Requested To : <span className="hi">{data.transfer_to_name}</span></div>
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
                  <th></th><th>Item</th><th>Fulfilled</th><th>Received</th><th>Qty to Receive</th><th>UOM</th><th>Unit</th><th>Memo</th>
                </tr>
              </thead>
              <tbody>
                {receivableLines.length === 0 && (
                  <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>Everything on this fulfillment is already received.</td></tr>
                )}
                {receivableLines.map((l, idx) => (
                  <tr key={l.id}>
                    <td style={{ color: '#db2777', fontWeight: 600 }}>{idx + 1}</td>
                    <td>{l.item_code} {l.item_name ? `— ${l.item_name}` : ''}</td>
                    <td>{qty(l.qty_fulfilled)}</td>
                    <td>{qty(l.received)}</td>
                    <td>
                      <input
                        type="number" step="0.0001" max={Number(l.qty_fulfilled) - Number(l.received || 0)} style={{ width: 100 }}
                        value={qtyToReceive[l.id] ?? ''}
                        onChange={(e) => setQtyToReceive((prev) => ({ ...prev, [l.id]: e.target.value }))}
                      />
                    </td>
                    <td>{l.uom}</td>
                    <td>{l.unit}</td>
                    <td>
                      <input
                        style={{ width: 120 }}
                        value={lineMemo[l.id] ?? ''}
                        onChange={(e) => setLineMemo((prev) => ({ ...prev, [l.id]: e.target.value }))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={saving || receivableLines.length === 0} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
