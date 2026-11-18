import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { usePeriodLocked } from '../utils/periodLock';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';
import { isBaseUnit } from '../utils/unitUsed';
import { displayDate, displayAuditTime } from '../utils/dates';

// Mirrors the real system's Inventory Adjustment detail screen: banner + Details +
// Items/GL Impact/System Info tabs. GL Impact is derived on the fly from
// estimated_total_value against the single Adjustment Account rather than a real
// posted journal entry pair (Dr inventory asset / Cr adjustment account or vice versa)
// -- there's no Journal/GL module in this build to post real double-entry lines to, and
// the real screen itself only ever showed a single populated pair once Approved.
const STATUS_LABELS = {
  pending_approval: 'Pending Approval',
  approved: 'Approved',
  cancelled: 'Cancelled',
};

// The unit a figure is in, set small and muted beside it so the number still reads as the number.
function Unit({ u }) {
  if (!u) return null;
  return <span className="muted" style={{ marginLeft: 4, fontSize: '0.85em' }}>{u}</span>;
}

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? displayDate(String(v).slice(0, 10)) : ''; }

export default function InventoryAdjustmentView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, user } = useAuth();
  const [adj, setAdj] = useState(null);
  const [tab, setTab] = useState('items');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [auditLogs, setAuditLogs] = useState([]);

  function load() {
    return api.get(`/inventory-adjustments/${id}`).then(({ data }) => { setAdj(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    if (tab === 'system') {
      api.get(`/inventory-adjustments/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
    }
  }, [tab, id]);

  async function handleApprove() {
    if (!confirm('Approve this adjustment? This will update on-hand quantities at each location.')) return;
    setBusy(true);
    setError('');
    try {
      await api.put(`/inventory-adjustments/${id}/approve`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Approve failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!confirm('Cancel this adjustment?')) return;
    setBusy(true);
    setError('');
    try {
      await api.put(`/inventory-adjustments/${id}/cancel`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Cancel failed');
    } finally {
      setBusy(false);
    }
  }

  // Closed accounting period: no Edit / Void / Cancel (utils/periodLock.js; the server refuses them too).
  const periodLocked = usePeriodLocked(adj?.date_created, 'non_gl');

  if (loading || !adj) return <LoadingSpinner />;

  const canEdit = (can('/inventory-adjustments', 'can_edit') && !periodLocked);
  const canVoid = (can('/inventory-adjustments', 'can_void') && !periodLocked);
  const canApprove = can('/inventory-adjustments', 'can_approve');
  const isPending = adj.status === 'pending_approval';
  // Once approved, a System Admin may still correct it (the server moves stock by the difference).
  const adminEditsApproved = adj.status === 'approved' && user?.account_type === 'System Admin';
  const lines = adj.lines || [];

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={'/inventory-adjustments'}>Back to Lists</Link>
          {canApprove && isPending && <button className="btn btn-sm btn-primary" disabled={busy} onClick={handleApprove}>Approve</button>}
          {canEdit && (isPending || adminEditsApproved) && (
            <Link className="btn btn-sm btn-primary" to={`/inventory-adjustments/${id}/edit`}
              title={adminEditsApproved ? 'Approved -- your changes move stock by the difference they make' : undefined}>Edit</Link>
          )}
          {canVoid && isPending && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleCancel}>Cancel</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {periodLocked && (
        <div className="warning-banner" style={{ marginBottom: 12 }}>
          The accounting period for this transaction is closed ({periodLocked}), so it can no longer be edited, voided or cancelled.
        </div>
      )}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Inventory Adjustment</h1>
          <span className="estimate-no">{adj.adjustment_no}</span>
        </div>
        <div className="estimate-status">{STATUS_LABELS[adj.status] || adj.status}</div>

        <div className="estimate-detail-grid">
          <div>
            <h4>Details</h4>
            <div>Date Created : <span className="hi">{formatDate(adj.date_created)}</span></div>
            <div>Adjustment Account : <span className="hi">{adj.adjustment_account_code ? `${adj.adjustment_account_code} — ${adj.adjustment_account_name}` : '—'}</span></div>
          </div>
          <div>
            <div>Memo : <span className="hi">{adj.memo}</span></div>
          </div>
          <div>
            <div>Estimated Total Value : <span className="hi">{money(adj.estimated_total_value)}</span></div>
            {adj.status === 'approved' && <div>Approved By : <span className="hi">{adj.approved_by_name}</span></div>}
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>Items</button>
        <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'items' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th><th>Item</th><th>Location</th><th>Department</th><th>Qty on Hand</th>
                  <th>Unit Used</th><th>UOM</th><th>Unit</th><th>Current Value</th><th>Adjust Qty. By</th><th>New Qty</th>
                  <th>Est. Unit Cost</th><th>Est. Unit Cost (Base)</th><th>Memo</th>
                </tr>
              </thead>
              <tbody>
                {lines.length === 0 && (
                  <tr><td colSpan={14} className="muted" style={{ textAlign: 'center', padding: 20 }}>No adjustment lines.</td></tr>
                )}
                {lines.map((l, idx) => (
                  <tr key={l.id}>
                    <td>{idx + 1}</td>
                    <td>{l.item_code} {l.item_name ? `— ${l.item_name}` : ''}</td>
                    <td>{l.location_name}</td>
                    <td>{l.department_name}</td>
                    {/* Each quantity carries its own unit, because the three of them are NOT all
                        in the same one and the row was unreadable without saying so: a sheet of
                        4'x8' acrylic is 32 SQFT, so "Qty on Hand 96, Adjust By 2, New Qty 160"
                        beside a UOM of SHT looks like arithmetic that does not add up until you
                        know that 96 and 160 are square feet while the 2 is sheets. */}
                    <td>{l.qty_on_hand}<Unit u={l.unit} /></td>
                    <td>{isBaseUnit(l.unit_used) ? 'Base Unit' : 'Stock Unit'}</td>
                    <td>{l.uom_title}</td>
                    <td>{l.unit}</td>
                    <td>{money(l.current_value)}</td>
                    <td>{l.adjust_qty_by}<Unit u={l.uom_title} /></td>
                    <td>{l.new_qty}<Unit u={l.unit} /></td>
                    <td>{money(l.est_unit_cost)}</td>
                    <td>{money(l.est_unit_cost_base)}</td>
                    <td>{l.memo}</td>
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
                {(!adj.gl_impact || adj.gl_impact.length === 0) && (
                  <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No GL impact yet.</td></tr>
                )}
                {(adj.gl_impact || []).map((row, idx) => (
                  <tr key={idx}>
                    <td>{row.account_code}</td>
                    <td>{row.account_name}</td>
                    <td>{row.debit ? money(row.debit) : ''}</td>
                    <td>{row.credit ? money(row.credit) : ''}</td>
                  </tr>
                ))}
                {adj.gl_impact?.length > 0 && (
                  <tr>
                    <td /><td />
                    <td><strong>{money(adj.gl_impact.reduce((s, r) => s + Number(r.debit || 0), 0))}</strong></td>
                    <td><strong>{money(adj.gl_impact.reduce((s, r) => s + Number(r.credit || 0), 0))}</strong></td>
                  </tr>
                )}
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
