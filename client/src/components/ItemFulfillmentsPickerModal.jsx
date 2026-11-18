import { useEffect, useState } from 'react';
import api from '../api/client';
import LoadingSpinner from './LoadingSpinner';
import { displayDate } from '../utils/dates';

function formatDate(v) { return v ? displayDate(v) : '—'; }

// Mirrors the real "Item Fulfillments" popup reached from a Transfer Order's Receive
// button -- lists every fulfillment batch raised against the TO so the user can pick
// which one to receive against (a line can be fulfilled across several batches, each
// received independently). Picking an OPEN one opens the Item Receipt form; a CLOSED one
// (already fully received) just opens its own view instead, since there's nothing left
// to receive.
export default function ItemFulfillmentsPickerModal({ toId, onClose, onAddNew, onPickOpen, onPickClosed }) {
  const [fulfillments, setFulfillments] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/transfer-orders/${toId}/item-fulfillments`).then(({ data }) => { setFulfillments(data); setLoading(false); });
  }, [toId]);

  const filtered = fulfillments.filter((f) => !search || f.fulfillment_no.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-lg" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="estimate-banner" style={{ borderRadius: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, color: '#fff' }}>Item Fulfillments</h2>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 24, lineHeight: 1, cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ padding: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
            <input placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 320 }} />
            <button type="button" className="btn btn-primary" onClick={onAddNew}>Add New</button>
          </div>
          {loading ? <LoadingSpinner /> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Item Fulfillment #</th><th>Date</th><th>Status</th></tr></thead>
                <tbody>
                  {filtered.length === 0 && (
                    <tr><td colSpan={3} className="muted" style={{ textAlign: 'center', padding: 20 }}>No Item Fulfillments yet.</td></tr>
                  )}
                  {filtered.map((f) => (
                    <tr
                      key={f.id} className="picker-row" style={{ cursor: 'pointer' }}
                      onClick={() => (f.status === 'OPEN' ? onPickOpen(f) : onPickClosed(f))}
                    >
                      <td>{f.fulfillment_no}</td>
                      <td>{formatDate(f.date_created)}</td>
                      <td>{f.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
