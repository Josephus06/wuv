import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { usePeriodLocked } from '../utils/periodLock';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDate, displayAuditTime } from '../utils/dates';

const STATUS_LABELS = { open: 'Open', partially_served: 'Partially Served', served: 'Served', cancelled: 'Cancelled' };
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function formatDate(v) { return v ? displayDate(v) : ''; }

// Fulfill modal: serve the remaining qty per line (defaults to the remaining balance), drawing it
// down from this requisition location's on-hand.
function FulfillModal({ osr, onClose, onSaved }) {
  const [serve, setServe] = useState(() => Object.fromEntries((osr.lines || []).map((l) => [l.id, Math.max(num(l.qty) - num(l.qty_served), 0)])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setError(''); setSaving(true);
    try {
      const lines = (osr.lines || []).map((l) => ({ line_id: l.id, qty_to_serve: num(serve[l.id]) })).filter((l) => l.qty_to_serve > 0);
      if (!lines.length) { setError('Enter a Qty to Serve for at least one item.'); setSaving(false); return; }
      const { data } = await api.post(`/office-supply-requisitions/${osr.id}/fulfill`, { lines });
      onSaved(data);
    } catch (e) { setError(e.response?.data?.error || 'Fulfill failed.'); setSaving(false); }
  }

  return (
    <Modal title="Fulfill Requisition" onClose={onClose} large>
      {error && <div className="error-banner">{error}</div>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Item</th><th style={{ textAlign: 'right' }}>Requested</th><th style={{ textAlign: 'right' }}>Served</th><th style={{ textAlign: 'right' }}>Remaining</th><th style={{ textAlign: 'right' }}>On Hand</th><th style={{ textAlign: 'right' }}>Qty to Serve</th></tr></thead>
          <tbody>
            {(osr.lines || []).map((l) => {
              const remaining = Math.max(num(l.qty) - num(l.qty_served), 0);
              return (
                <tr key={l.id}>
                  <td>{l.item_code} — {l.item_name}</td>
                  <td style={{ textAlign: 'right' }}>{num(l.qty)}</td>
                  <td style={{ textAlign: 'right' }}>{num(l.qty_served)}</td>
                  <td style={{ textAlign: 'right' }}>{remaining}</td>
                  <td style={{ textAlign: 'right' }}>{l.on_hand == null ? '' : num(l.on_hand)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <input type="number" step="0.01" max={remaining} style={{ width: 90, textAlign: 'right' }}
                      value={serve[l.id] ?? ''} onChange={(e) => setServe((s) => ({ ...s, [l.id]: e.target.value }))} disabled={remaining <= 0} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Serving...' : 'Fulfill'}</button>
      </div>
    </Modal>
  );
}

export default function OfficeSupplyRequisitionView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [o, setO] = useState(null);
  const [tab, setTab] = useState('lines');
  const [auditLogs, setAuditLogs] = useState([]);
  const [showFulfill, setShowFulfill] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function load() { return api.get(`/office-supply-requisitions/${id}`).then(({ data }) => { setO(data); setLoading(false); }); }
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'system') api.get(`/office-supply-requisitions/${id}/audit-logs`).then(({ data }) => setAuditLogs(data)); }, [tab, id]);

  async function handleCancel() {
    if (!confirm('Cancel this requisition?')) return;
    setBusy(true); setError('');
    try { await api.put(`/office-supply-requisitions/${id}/cancel`); await load(); }
    catch (err) { setError(err.response?.data?.error || 'Cancel failed'); }
    finally { setBusy(false); }
  }

  // Closed accounting period: no Edit / Void / Cancel (utils/periodLock.js; the server refuses them too).
  const periodLocked = usePeriodLocked(o?.date_created, 'non_gl');

  if (loading || !o) return <LoadingSpinner />;
  const lines = o.lines || [];
  const isOpen = o.status === 'open' || o.status === 'partially_served';
  const canEdit = (can('/office-supply-requisitions', 'can_edit') && !periodLocked);
  const canFulfill = can('/office-supply-requisitions', 'can_approve');

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={'/office-supply-requisitions'}>Back to Lists</Link>
          {canEdit && o.status === 'open' && <Link className="btn btn-sm btn-primary" to={`/office-supply-requisitions/${id}/edit`}>Edit</Link>}
          {canFulfill && isOpen && <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => setShowFulfill(true)}>Fulfill</button>}
          {canEdit && o.status !== 'cancelled' && o.status !== 'served' && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleCancel}>Cancel</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {/* Closed accounting period (shown on the page itself, 2026-10-14). */}
      {periodLocked && (
        <div className="warning-banner" style={{ marginBottom: 12 }}>
          The accounting period for this transaction is closed ({periodLocked}), so it can no longer be edited, voided or cancelled.
        </div>
      )}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Office Supply Requisition</h1>
          <span className="estimate-no">{o.osr_no}</span>
          <span style={{ marginLeft: 10, opacity: 0.85 }}>{STATUS_LABELS[o.status] || o.status}</span>
        </div>
        <div className="estimate-detail-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: 12 }}>
          <div>
            <div>Date : <span className="hi">{formatDate(o.date_created)}</span></div>
            <div>Date Needed : <span className="hi">{formatDate(o.date_needed)}</span></div>
            <div>Withdraw From : <span className="hi">{o.location_name || ''}</span></div>
            <div>Transfer To : <span className="hi">{o.transfer_to_location_name || ''}</span></div>
          </div>
          <div>
            <div>Requestor : <span className="hi">{o.requestor_name || ''}</span></div>
            <div>Department : <span className="hi">{o.department_name || ''}</span></div>
          </div>
          <div>
            <div>Memo : <span className="hi">{o.memo || ''}</span></div>
            {o.fulfilled_by_name && o.fulfilled_by_name.trim() && <div>Fulfilled By : <span className="hi">{o.fulfilled_by_name}</span></div>}
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'lines' ? 'active' : ''}`} onClick={() => setTab('lines')}>Items</button>
        <button className={`status-tab ${tab === 'related' ? 'active' : ''}`} onClick={() => setTab('related')}>Related Records</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'lines' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>#</th><th>Item Code</th><th>Item</th><th style={{ textAlign: 'right' }}>Qty</th><th>UOM</th><th>Unit</th><th style={{ textAlign: 'right' }}>Fulfilled</th><th style={{ textAlign: 'right' }}>Remaining</th><th style={{ textAlign: 'right' }}>Qty on Hand</th><th>Memo</th></tr></thead>
              <tbody>
                {lines.length === 0 && <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 20 }}>No items.</td></tr>}
                {lines.map((l, i) => (
                  <tr key={l.id}>
                    <td>{i + 1}</td><td>{l.item_code}</td><td>{l.item_name}</td>
                    <td style={{ textAlign: 'right' }}>{num(l.qty)}</td>
                    <td>{l.uom}</td><td>{l.unit}</td>
                    <td style={{ textAlign: 'right' }}>{num(l.qty_served)}</td>
                    <td style={{ textAlign: 'right' }}>{Math.max(num(l.qty) - num(l.qty_served), 0)}</td>
                    <td style={{ textAlign: 'right' }}>{l.on_hand == null ? '' : num(l.on_hand)}</td>
                    <td>{l.remarks}</td>
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
              <thead><tr><th>Date</th><th>Transaction #</th><th style={{ textAlign: 'right' }}>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {(o.fulfillments || []).length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No fulfillments yet.</td></tr>}
                {(o.fulfillments || []).map((fu) => (
                  <tr key={fu.id}>
                    <td>{formatDate(fu.date_created)}</td>
                    <td><Link className="link-btn" to={`/office-supply-requisitions/fulfillments/${fu.id}`}>{fu.osrf_no}</Link></td>
                    <td style={{ textAlign: 'right' }}>{Number(fu.total_amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                    <td>{fu.status}</td>
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
              { key: 'set_at', label: 'When', render: (r) => displayAuditTime(r.set_at) },
              { key: 'set_by_name', label: 'Set By' }, { key: 'event_type', label: 'Type' },
              { key: 'field_name', label: 'Field' }, { key: 'old_value', label: 'Old Value' }, { key: 'new_value', label: 'New Value' },
            ]}
            rows={auditLogs}
            emptyLabel="No audit history yet."
          />
        </div>
      )}

      {showFulfill && <FulfillModal osr={o} onClose={() => setShowFulfill(false)} onSaved={(res) => { setShowFulfill(false); if (res?.osrf_id) navigate(`/office-supply-requisitions/fulfillments/${res.osrf_id}`); else load(); }} />}
    </div>
  );
}
