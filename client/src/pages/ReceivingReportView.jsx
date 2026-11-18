import { rate6 } from '../utils/rate';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { usePeriodLocked } from '../utils/periodLock';
import { useAuth } from '../context/useAuth';
import LoadingSpinner from '../components/LoadingSpinner';
import { SupplierLink } from '../components/PartyLink';
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

// Mirrors the real "Receiving Report" view -- the document produced by receiving a
// Purchase Order. Always reached via the PO it closed (Created From / PO # carried
// through).
export default function ReceivingReportView() {
  const { receiptId } = useParams();
  const navigate = useNavigate();
  const fromModule = useLocation().pathname.startsWith('/receiving-reports');
  const { can } = useAuth();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('items');
  const [loading, setLoading] = useState(true);

  // Served by the Receiving Report module, which accepts either that page's view permission
  // or the Purchase Order's -- this view is reached from both.
  useEffect(() => {
    api.get(`/receiving-reports/${receiptId}`).then(({ data: d }) => { setData(d); setLoading(false); });
  }, [receiptId]);

  // Closed accounting period: no Edit / Void / Cancel (utils/periodLock.js; the server refuses them too).
  const periodLocked = usePeriodLocked(data?.date_created, 'non_gl');

  if (loading || !data) return <LoadingSpinner />;

  // The same right that receives (server: requireReceiveRight): PO Edit, or Add on Receiving Reports.
  const canEdit = (can('/purchase-orders', 'can_edit') || can('/receiving-reports', 'can_add')) && !periodLocked;

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          {/* Back goes where the user came from: the module list, or the PO that raised it. */}
          <Link
            className="btn btn-sm"
            to={fromModule ? '/receiving-reports' : `/purchase-orders/${data.purchase_order_id}`}
          >
            Back
          </Link>
          {canEdit && <Link className="btn btn-sm" to={`/receiving-reports/${receiptId}/edit`}>Edit</Link>}
        </div>
      </div>

      {periodLocked && (
        <div className="warning-banner" style={{ marginBottom: 12 }}>
          The accounting period for this transaction is closed ({periodLocked}), so it can no longer be edited, voided or cancelled.
        </div>
      )}
      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Receiving Report</h1>
          <span className="estimate-no">{data.receipt_no}</span>
        </div>
        <div className="estimate-status">{data.is_on_hold ? 'On Hold' : ''}</div>

        <div className="estimate-detail-grid">
          <div>
            <div>Date Created : <span className="hi">{formatDate(data.date_created)}</span></div>
            <div>Created From : <Link className="link-btn" to={`/purchase-orders/${data.purchase_order_id}`}>{data.po_no}</Link></div>
            <div>Ref. # : <span className="hi">{data.ref_no || '—'}</span></div>
          </div>
          <div>
            <div>Supplier : <span className="hi"><SupplierLink id={data.supplier_id} name={data.supplier_name} /></span></div>
            <div>Memo : <span className="hi">{data.memo || ''}</span></div>
          </div>
          <div>
            <div>Prepared By : <span className="hi">{data.created_by_name || '—'}</span></div>
          </div>
        </div>
      </div>

      <div className="estimate-footer card" style={{ marginTop: 20 }}>
        <div><span className="muted">Subtotal</span><div className="hi-lg">{money(data.subtotal)}</div></div>
        <div><span className="muted">Discount</span><div className="hi-lg">{money(data.discount_amount)}</div></div>
        <div><span className="muted">Net of Tax</span><div className="hi-lg">{money(data.net_of_tax)}</div></div>
        <div><span className="muted">Tax</span><div className="hi-lg">{money(data.tax_amount)}</div></div>
        <div><span className="muted">Total Amount</span><div className="hi-lg">{money(data.total_amount)}</div></div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>Items</button>
        <button className={`status-tab ${tab === 'related' ? 'active' : ''}`} onClick={() => setTab('related')}>Related Records</button>
      </div>

      {tab === 'items' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Item</th><th>Location</th><th>Department</th><th>Qty Received</th><th>Rate</th><th>Disc %</th>
                  <th>Net of Tax</th><th>Tax Code</th><th>Tax Amt</th><th>Ext. Price</th>
                </tr>
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
                    <td>{l.location_name || '—'}</td>
                    {/* From the purchase order line -- a receipt carries no department of its own. */}
                    <td>{l.department_name || '—'}</td>
                    <td>{qty(l.qty_received)}</td>
                    <td>{rate6(l.rate)}</td>
                    <td>{l.disc_percent}</td>
                    <td>{money(l.net_of_tax)}</td>
                    <td>{l.tax_code}</td>
                    <td>{money(l.tax_amount)}</td>
                    <td>{money(l.ext_price)}</td>
                  </tr>
                ))}
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
                  <td>Purchase Order</td>
                  <td><Link className="link-btn" to={`/purchase-orders/${data.purchase_order_id}`}>{data.po_no}</Link></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
