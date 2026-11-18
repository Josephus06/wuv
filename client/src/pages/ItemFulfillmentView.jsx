import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import LoadingSpinner from '../components/LoadingSpinner';

import { displayDate } from '../utils/dates';

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? displayDate(v) : '—'; }

// Mirrors the real "Item Fulfillment" detail view -- reached from a Transfer Order's
// Related Records tab. Total Amount and GL Impact are both derived on the fly
// (qty_fulfilled x each item's average_cost) rather than stored/posted figures --
// there's no real Journal/GL module in this build yet, only per-request computation.
export default function ItemFulfillmentView() {
  const { fulfillmentId } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('items');
  const [receipts, setReceipts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/transfer-orders/item-fulfillments/${fulfillmentId}`).then(({ data: d }) => { setData(d); setLoading(false); });
  }, [fulfillmentId]);

  useEffect(() => {
    if (tab === 'related') {
      api.get(`/transfer-orders/item-fulfillments/${fulfillmentId}/item-receipts`).then(({ data: d }) => setReceipts(d));
    }
  }, [tab, fulfillmentId]);

  if (loading || !data) return <LoadingSpinner />;

  const canEdit = can('/item-fulfillments', 'can_edit');

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={`/transfer-orders/${data.transfer_order_id}`}>Back</Link>
          {canEdit && <button className="btn btn-sm" disabled title="Editing a saved Item Fulfillment isn't implemented in this build">Edit</button>}
          <button className="btn btn-sm" disabled title="Print formats aren't implemented in this build">Print</button>
        </div>
      </div>

      <div className="estimate-banner" style={{ position: 'relative' }}>
        <div className="estimate-banner-title">
          <h1>Item Fulfillment</h1>
          <span className="estimate-no">{data.fulfillment_no}</span>
        </div>
        <div className="estimate-status">{data.status}</div>

        <div className="estimate-detail-grid">
          <div>
            <div>Item Fulfillment # : <span className="hi">{data.fulfillment_no}</span></div>
            <div>Date : <span className="hi">{formatDate(data.date_created)}</span></div>
            <div>Created From : <Link className="link-btn" to={`/transfer-orders/${data.transfer_order_id}`}>{data.to_no}</Link></div>
          </div>
          <div>
            <div>Withdraw From : <span className="hi">{data.withdraw_from_name}</span></div>
            <div>Transfer To : <span className="hi">{data.transfer_to_name}</span></div>
            <div>Memo : <span className="hi">{data.memo || ''}</span></div>
          </div>
          <div>
            <div>Requestor : <span className="hi">{data.requestor_name || '—'}</span></div>
          </div>
        </div>

        <div style={{ position: 'absolute', top: 24, right: 28, background: 'var(--surface-2)', borderRadius: 8, padding: '14px 20px', minWidth: 200 }}>
          <div className="muted" style={{ fontSize: 13 }}>Total Amount</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent)' }}>{money(data.total_amount)}</div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>Items</button>
        <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        <button className={`status-tab ${tab === 'related' ? 'active' : ''}`} onClick={() => setTab('related')}>Related Records</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'items' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                {/* No UOM column. It showed transfer_order_lines.uom, which on job-order-driven
                    lines is the unit the LENGTH and WIDTH were keyed in -- "MM" beside a quantity
                    of 192 that is 192 square feet. Sitting next to the quantities it read as
                    their unit, which it is not. Unit already carries the real one. */}
                <tr><th>Item</th><th>Fulfill</th><th>Received</th><th>Qty On Hand</th><th>Unit</th></tr>
              </thead>
              <tbody>
                {data.lines.map((l, idx) => (
                  <tr key={l.id}>
                    <td>
                      <span style={{ color: '#db2777', fontWeight: 600, marginRight: 8 }}>{idx + 1}</span>
                      <Link className="link-btn" to={`/inventory/${l.item_id}`}>
                        {l.item_code} {l.item_name ? `— ${l.item_name}` : ''}
                      </Link>
                    </td>
                    <td>{qty(l.qty_fulfilled)}</td>
                    <td>{qty(l.received)}</td>
                    <td>{qty(l.qty_on_hand)}</td>
                    <td>{l.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'gl' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Account Code</th><th>Account Title</th><th>Debit</th><th>Credit</th></tr>
              </thead>
              <tbody>
                {(!data.gl_impact || data.gl_impact.length === 0) && (
                  <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No GL impact yet.</td></tr>
                )}
                {(data.gl_impact || []).map((row, idx) => (
                  <tr key={idx}>
                    <td>{row.account_code}</td>
                    <td>{row.account_name}</td>
                    <td>{row.debit ? money(row.debit) : ''}</td>
                    <td>{row.credit ? money(row.credit) : ''}</td>
                  </tr>
                ))}
                {data.gl_impact?.length > 0 && (
                  <tr>
                    <td /><td />
                    <td><strong>{money(data.gl_impact.reduce((s, r) => s + Number(r.debit || 0), 0))}</strong></td>
                    <td><strong>{money(data.gl_impact.reduce((s, r) => s + Number(r.credit || 0), 0))}</strong></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'related' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Type</th><th>Reference</th><th>Date</th></tr></thead>
              <tbody>
                {receipts.length === 0 && (
                  <tr><td colSpan={3} className="muted" style={{ textAlign: 'center', padding: 20 }}>No Item Receipts yet.</td></tr>
                )}
                {receipts.map((r) => (
                  <tr key={r.id}>
                    <td>Item Receipt</td>
                    <td><Link className="link-btn" to={`/transfer-orders/item-receipts/${r.id}`}>{r.receipt_no}</Link></td>
                    <td>{formatDate(r.date_created)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'system' && (
        <div className="card">
          <p className="muted">No audit history for this record type.</p>
        </div>
      )}
    </div>
  );
}
