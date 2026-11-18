import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { usePeriodLocked } from '../utils/periodLock';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDate, displayAuditTime } from '../utils/dates';
import { CustomerLink } from '../components/PartyLink';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? displayDate(v) : '—'; }

const STATUS_LABELS = { posted: 'POSTED', voided: 'VOID' };

// Mirrors the live "Customer Refund" detail view (CRFND-#): a standalone AR refund that
// returns cash against one or more of the customer's payments. Debits A/R Trade, credits the
// Customer Refund account (see the GL Impact tab).
export default function CustomerRefundView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [cr, setCr] = useState(null);
  const [tab, setTab] = useState('apply');
  const [auditLogs, setAuditLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function load() {
    return api.get(`/customer-refunds/${id}`).then(({ data }) => { setCr(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'system') api.get(`/customer-refunds/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
  }, [tab, id]);

  async function handleVoid() {
    if (!confirm('Void this Customer Refund?')) return;
    setBusy(true);
    setError('');
    try {
      await api.put(`/customer-refunds/${id}/void`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Void failed');
    } finally {
      setBusy(false);
    }
  }

  // Closed accounting period: no Edit / Void / Cancel (utils/periodLock.js; the server refuses them too).
  const periodLocked = usePeriodLocked(cr?.date_created, 'ar');

  if (loading || !cr) return <LoadingSpinner />;

  const canEdit = (can('/customer-refunds', 'can_edit') && !periodLocked);
  const canVoid = (can('/customer-refunds', 'can_void') && !periodLocked);
  const isOpen = cr.status !== 'voided';

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate(-1)}>Back to Lists</button>
          {canEdit && isOpen && <button className="btn btn-sm" disabled title="Editing a posted Customer Refund isn't implemented in this build -- void and re-enter instead">Edit</button>}
          <button className="btn btn-sm" disabled title="Print formats aren't implemented in this build">Print</button>
          {canVoid && isOpen && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleVoid}>Void</button>}
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
          <h1>Customer Refund</h1>
          <span className="estimate-no">{cr.customer_refund_no}</span>
        </div>
        <div className="estimate-status">{STATUS_LABELS[cr.status] || cr.status}</div>

        <div className="estimate-detail-grid">
          <div>
            <div>Customer : <span className="hi"><CustomerLink id={cr.customer_id} name={cr.customer_name} /></span></div>
            <div>TIN : <span className="hi">{cr.customer_tin || '—'}</span></div>
          </div>
          <div>
            <div>Date Created : <span className="hi">{formatDate(cr.date_created)}</span></div>
            <div>Memo : <span className="hi">{cr.memo || ''}</span></div>
            <div>Office Location : <span className="hi">{cr.office_location_name || '—'}</span></div>
            <div>Department : <span className="hi">{cr.department_name || '—'}</span></div>
            <div>Issued By : <span className="hi">{cr.issued_by_name || '—'}</span></div>
          </div>
          <div>
            <div>Account : <span className="hi">{cr.account_name || '—'}</span></div>
            <div>A/R Account : <span className="hi">{cr.ar_account_name || '—'}</span></div>
            <div>Refund Method : <span className="hi">{cr.payment_method_name || '—'}</span></div>
          </div>
        </div>
      </div>

      <div className="estimate-footer card" style={{ marginTop: 20 }}>
        <div><span className="muted">Total Refund</span><div className="hi-lg">{money(cr.refund_amount)}</div></div>
        {cr.amount_due !== undefined && (
          <>
            <div><span className="muted">Paid by Customer Payments</span><div className="hi-lg">{money(cr.amount_paid)}</div></div>
            <div><span className="muted">Amount Due</span><div className="hi-lg">{money(cr.amount_due)}</div></div>
          </>
        )}
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'apply' ? 'active' : ''}`} onClick={() => setTab('apply')}>Apply {money(cr.refund_amount)}</button>
        <button className={`status-tab ${tab === 'payments' ? 'active' : ''}`} onClick={() => setTab('payments')}>Payments {money(cr.amount_paid || 0)}</button>
        <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'apply' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Payment #</th><th>Date Created</th><th>Original Amount</th><th>Refund Amount</th></tr></thead>
              <tbody>
                {cr.lines.length === 0 && (
                  <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No payments refunded.</td></tr>
                )}
                {cr.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.customer_payment_id
                      ? <Link className="link-btn" to={`/customer-payments/${l.customer_payment_id}`}>{l.customer_payment_no}</Link>
                      : (l.customer_payment_no || '—')}</td>
                    <td>{formatDate(l.payment_date)}</td>
                    <td>{money(l.original_amount)}</td>
                    <td>{money(l.refund_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Customer Payments applied to this refund (2026-11-05) -- applied from the payment's APPLY tab. */}
      {tab === 'payments' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Customer Payment #</th><th>Date</th><th>Applied Amount</th></tr></thead>
              <tbody>
                {!(cr.payments_applied || []).length && (
                  <tr><td colSpan={3} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    No Customer Payment is applied to this refund yet -- apply one from the payment&apos;s APPLY tab.
                  </td></tr>
                )}
                {(cr.payments_applied || []).map((p) => (
                  <tr key={p.id}>
                    <td><Link className="link-btn" to={`/customer-payments/${p.customer_payment_id}`}>{p.customer_payment_no}</Link></td>
                    <td>{formatDate(p.date_created)}</td>
                    <td>{money(p.applied_amount)}</td>
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
              <thead><tr><th>Account Code</th><th>Account Title</th><th>Debit</th><th>Credit</th></tr></thead>
              <tbody>
                {(!cr.gl_impact || cr.gl_impact.length === 0) && (
                  <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No GL impact.</td></tr>
                )}
                {(cr.gl_impact || []).map((row, idx) => (
                  <tr key={idx}>
                    <td>{row.account_code}</td>
                    <td>{row.account_name}</td>
                    <td>{row.debit ? money(row.debit) : '0.00'}</td>
                    <td>{row.credit ? money(row.credit) : '0.00'}</td>
                  </tr>
                ))}
                {cr.gl_impact?.length > 0 && (
                  <tr>
                    <td /><td />
                    <td><strong>{money(cr.gl_impact.reduce((s, r) => s + Number(r.debit || 0), 0))}</strong></td>
                    <td><strong>{money(cr.gl_impact.reduce((s, r) => s + Number(r.credit || 0), 0))}</strong></td>
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
