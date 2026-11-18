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

// Mirrors the real "Item Receipt" detail view -- the document that actually landed
// stock at Transfer To. Always reached via the Item Fulfillment it closed (TO #/TO Date
// and IF #/IF Date both carried through), same Total Amount treatment as
// ItemFulfillmentView (derived, not posted).
export default function ItemReceiptView() {
  const { receiptId } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('items');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/transfer-orders/item-receipts/${receiptId}`).then(({ data: d }) => { setData(d); setLoading(false); });
  }, [receiptId]);

  if (loading || !data) return <LoadingSpinner />;

  const canEdit = can('/item-receipts', 'can_edit');

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={`/transfer-orders/${data.transfer_order_id}`}>Back</Link>
          {canEdit && <button className="btn btn-sm" disabled title="Editing a saved Item Receipt isn't implemented in this build">Edit</button>}
        </div>
      </div>

      <div className="estimate-banner" style={{ position: 'relative' }}>
        <div className="estimate-banner-title">
          <h1>Item Receipt</h1>
          <span className="estimate-no">{data.receipt_no}</span>
        </div>

        <div className="estimate-detail-grid" style={{ marginTop: 12 }}>
          <div>
            <div>Item Receipt # : <span className="hi">{data.receipt_no}</span></div>
            <div>Date : <span className="hi">{formatDate(data.date_created)}</span></div>
            <div>TO # : <Link className="link-btn" to={`/transfer-orders/${data.transfer_order_id}`}>{data.to_no}</Link></div>
            <div>TO Date : <span className="hi">{formatDate(data.to_date_created)}</span></div>
            <div>IF # : <Link className="link-btn" to={`/transfer-orders/item-fulfillments/${data.item_fulfillment_id}`}>{data.fulfillment_no}</Link></div>
            <div>IF Date : <span className="hi">{formatDate(data.if_date_created)}</span></div>
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
                {/* UOM dropped for the same reason as the Item Fulfillment view: it is the job
                    order's dimension unit, not the quantity's. */}
                <tr><th>Item</th><th>Fulfill</th><th>Received</th><th>Qty On Hand</th><th>Unit</th></tr>
              </thead>
              <tbody>
                {data.lines.map((l, idx) => (
                  <tr key={idx}>
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
              <thead><tr><th>Type</th><th>Reference</th></tr></thead>
              <tbody>
                <tr>
                  <td>Item Fulfillment</td>
                  <td><Link className="link-btn" to={`/transfer-orders/item-fulfillments/${data.item_fulfillment_id}`}>{data.fulfillment_no}</Link></td>
                </tr>
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
