import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';
import { SupplierLink } from '../components/PartyLink';
import { displayDate, displayAuditTime } from '../utils/dates';

const STATUS_LABELS = {
  pending_request: 'Pending Request',
  request_in_process: 'Request In-Process',
  partially_served: 'Partially Served',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const PO_STATUS_LABELS = {
  pending_approval: 'Pending Approval',
  pending_approval_gm: 'Pending Approval for GM',
  approved: 'Approved',
  cancelled: 'Cancelled',
};

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? displayDate(v) : '—'; }

// Mirrors the real "Purchase Requisition" detail view. PR Qty/PO Qty/Status per line
// track how much of this request a Purchase Order has picked up -- via the Place Order
// Form's Canvass step.
export default function PurchaseRequisitionView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [pr, setPr] = useState(null);
  const [tab, setTab] = useState('items');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [auditLogs, setAuditLogs] = useState([]);
  const [purchaseOrders, setPurchaseOrders] = useState([]);

  function load() {
    return api.get(`/purchase-requisitions/${id}`).then(({ data }) => { setPr(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'system') {
      api.get(`/purchase-requisitions/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
    }
    if (tab === 'related') {
      api.get(`/purchase-requisitions/${id}/purchase-orders`).then(({ data }) => setPurchaseOrders(data));
    }
  }, [tab, id]);

  async function handleCancel() {
    if (!confirm('Cancel this Purchase Requisition?')) return;
    setBusy(true);
    setError('');
    try {
      await api.put(`/purchase-requisitions/${id}/cancel`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Cancel failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading || !pr) return <LoadingSpinner />;

  const canEdit = can('/purchase-requisitions', 'can_edit');
  const isPending = pr.status === 'pending_request';

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={'/purchase-requisitions'}>Back</Link>
          {canEdit && pr.status !== 'cancelled' && <Link className="btn btn-sm btn-primary" to={`/purchase-requisitions/${id}/edit`}>Edit</Link>}
          {canEdit && isPending && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleCancel}>Cancel</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Purchase Requisition</h1>
          <span className="estimate-no">{pr.pr_no}</span>
        </div>
        <div className="estimate-status">{STATUS_LABELS[pr.status] || pr.status} <span style={{ opacity: 0.7 }}>{pr.item_status}</span></div>

        <div className="estimate-detail-grid">
          <div>
            <div className="muted" style={{ color: '#cbd5e1', fontSize: 12, textTransform: 'uppercase' }}>Details</div>
            <div>Date Created : <span className="hi">{formatDate(pr.date_created)}</span></div>
            <div>Date Needed : <span className="hi">{pr.date_needed ? formatDate(pr.date_needed) : '—'}</span></div>
          </div>
          <div>
            <div>Requested From : <span className="hi">{pr.department_name || '—'}</span></div>
            <div>Requestor : <span className="hi">{pr.requestor_name || '—'}</span></div>
          </div>
          <div>
            <div>Prepared By : <span className="hi">{pr.prepared_by_name || '—'}</span></div>
            <div>Memo : <span className="hi">{pr.memo || ''}</span></div>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>Items</button>
        <button className={`status-tab ${tab === 'related' ? 'active' : ''}`} onClick={() => setTab('related')}>Related Records</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'items' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Item</th><th>Purchase Description</th><th>JO #</th><th>Qty on Hand</th>
                  <th>PR Qty</th><th>PO Qty</th><th>Purchase Unit</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {pr.lines.length === 0 && (
                  <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>No materials.</td></tr>
                )}
                {pr.lines.map((l, idx) => (
                  <tr key={l.id}>
                    <td>
                      <span style={{ color: '#db2777', fontWeight: 600, marginRight: 8 }}>{idx + 1}</span>
                      <Link className="link-btn" to={`/inventory/${l.item_id}`}>
                        {l.item_code} {l.item_name ? `— ${l.item_name}` : ''}
                      </Link>
                    </td>
                    <td>{l.purchase_description}</td>
                    <td>{l.job_order_id ? (
                      <Link className="link-btn" to={`/production/${l.job_order_id}`}>{l.job_order_no}</Link>
                    ) : '—'}</td>
                    <td>{qty(l.qty_on_hand)}</td>
                    <td>{qty(l.qty)}</td>
                    <td>{qty(l.po_qty)}</td>
                    <td>{l.purchase_unit}</td>
                    <td>{l.item_status}</td>
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
              <thead><tr><th>Type</th><th>Reference</th><th>Date</th><th>Supplier</th><th>Status</th></tr></thead>
              <tbody>
                {purchaseOrders.length === 0 && (
                  <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No related Purchase Orders yet.</td></tr>
                )}
                {purchaseOrders.map((po) => (
                  <tr key={po.id}>
                    <td>Purchase Order</td>
                    <td><Link className="link-btn" to={`/purchase-orders/${po.id}`}>{po.po_no}</Link></td>
                    <td>{formatDate(po.date_created)}</td>
                    <td><SupplierLink id={po.supplier_id} name={po.supplier_name} /></td>
                    <td>{PO_STATUS_LABELS[po.status] || po.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'system' && (
        <div className="card">
          <DataTable
            columns={[
              { key: 'set_at', label: 'Date Time', render: (r) => displayAuditTime(r.set_at) },
              { key: 'set_by_name', label: 'Set By' },
              { key: 'event_type', label: 'Type' },
              { key: 'field_name', label: 'Field' },
              { key: 'old_value', label: 'Old Value' },
              { key: 'new_value', label: 'New Value' },
            ]}
            rows={auditLogs}
            emptyLabel="No audit history yet."
          />
        </div>
      )}
    </div>
  );
}
