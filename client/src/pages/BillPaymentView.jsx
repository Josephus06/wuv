import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { usePeriodLocked } from '../utils/periodLock';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';
import BillPaymentModal from '../components/BillPaymentModal';
import { SupplierLink } from '../components/PartyLink';
import { displayDate, displayAuditTime } from '../utils/dates';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? displayDate(v) : '—'; }
// Cheque dates keep the bank's format (e.g. Sep 18, 2026), not the app-wide 18 Sept 2026 -- as asked.
function formatChequeDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : '—'; }

const STATUS_LABELS = { open: 'Open', voided: 'Voided' };

// Mirrors the real "Bill Payment" detail view -- reached from a Vendor Bill's Related
// Records tab after paying it, or from the Bill Payments list.
export default function BillPaymentView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [bp, setBp] = useState(null);
  const [tab, setTab] = useState('apply');
  // Two print formats: the Payment Voucher hand-out, and the cheque overlay that prints
  // onto pre-printed cheque stock.
  const [showPrintMenu, setShowPrintMenu] = useState(false);
  const [auditLogs, setAuditLogs] = useState([]);
  const [related, setRelated] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editingRelease, setEditingRelease] = useState(false);
  const [releaseDate, setReleaseDate] = useState('');
  const [savingRelease, setSavingRelease] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  async function saveRelease() {
    setSavingRelease(true);
    setError('');
    try {
      await api.put(`/bill-payments/${id}/date-released`, { date_released: releaseDate || null });
      await load();
      setEditingRelease(false);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save Date Released.');
    } finally {
      setSavingRelease(false);
    }
  }

  function load() {
    return api.get(`/bill-payments/${id}`).then(({ data }) => { setBp(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Related Records: the bills and credits it settles, and its journals (the reversal of a void).
  useEffect(() => { api.get(`/bill-payments/${id}/related`).then(({ data }) => setRelated(data)).catch(() => setRelated([])); }, [id, bp?.status]);

  useEffect(() => {
    if (tab === 'system') {
      api.get(`/bill-payments/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
    }
  }, [tab, id]);

  async function handleVoid() {
    if (!confirm('Void this Bill Payment? Its applied bills/credits will be reversed.')) return;
    setBusy(true);
    setError('');
    try {
      await api.put(`/bill-payments/${id}/void`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Void failed');
    } finally {
      setBusy(false);
    }
  }

  // Closed accounting period: no Edit / Void / Cancel (utils/periodLock.js; the server refuses them too).
  const periodLocked = usePeriodLocked(bp?.date_created, 'ap');

  if (loading || !bp) return <LoadingSpinner />;

  const canEdit = (can('/bill-payments', 'can_edit') && !periodLocked);
  const canVoid = (can('/bill-payments', 'can_void') && !periodLocked);
  const canPrint = can('/bill-payments', 'can_print');
  // Anything not voided: 11,432 migrated payments say 'posted', and they are as live as 'open'.
  const isOpen = bp.status !== 'voided';
  const applyLines = bp.lines.filter((l) => l.vendor_bill_id);
  const debitLines = bp.lines.filter((l) => l.bill_credit_id);

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={'/bill-payments'}>Back</Link>
          {canEdit && isOpen && <button className="btn btn-sm" onClick={() => setEditOpen(true)}>Edit</button>}
          {canPrint && <button className="btn btn-sm" onClick={() => window.open(`/bill-payments/${id}/print`, '_blank')}>Print Voucher</button>}
          {canPrint && <button className="btn btn-sm" onClick={() => window.open(`/bill-payments/${id}/cheque`, '_blank')}>Print Cheque</button>}
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
          <h1>Bill Payment</h1>
          <span className="estimate-no">{bp.bill_payment_no}</span>
        </div>
        <div className="estimate-status">{STATUS_LABELS[bp.status] || bp.status}</div>

        <div className="estimate-detail-grid">
          <div>
            <div>Vendor : <span className="hi"><SupplierLink id={bp.supplier_id} name={bp.supplier_name} /></span></div>
            <div>Payee Name : <span className="hi">{bp.payee_name}</span></div>
            <div>TIN : <span className="hi">{bp.tin || ''}</span></div>
            <div>A/P : <span className="hi">{bp.ap_account_code ? `${bp.ap_account_code} — ${bp.ap_account_name}` : '—'}</span></div>
            <div>Account : <span className="hi">{bp.bank_account_code ? `${bp.bank_account_code} — ${bp.bank_account_name}` : '—'}</span></div>
          </div>
          <div>
            <div>Date Created : <span className="hi">{formatDate(bp.date_created)}</span></div>
            <div>Reference # : <span className="hi">{bp.reference_no || ''}</span></div>
            <div>Memo : <span className="hi">{bp.memo || ''}</span></div>
            <div>Office Location : <span className="hi">{bp.office_location_name || '—'}</span></div>
          </div>
          <div>
            <div>Payment Method : <span className="hi">{bp.payment_method_name}</span></div>
            {/* The day the money actually went out, which is not the day the payment was raised.
                Set here after the fact, as the source system does -- and the Disbursement Report
                is keyed on it, so a payment without one does not appear in any date range. */}
            <div>
              Date Released : {editingRelease ? (
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <input
                    type="date"
                    value={releaseDate}
                    onChange={(e) => setReleaseDate(e.target.value)}
                    style={{ width: 160 }}
                  />
                  <button className="btn btn-sm btn-primary" disabled={savingRelease} onClick={saveRelease}>Save</button>
                  <button className="btn btn-sm" disabled={savingRelease} onClick={() => setEditingRelease(false)}>Cancel</button>
                </span>
              ) : (
                <>
                  <span className="hi">{bp.date_released ? formatDate(bp.date_released) : '—'}</span>
                  {canEdit && (
                    <button
                      type="button"
                      className="link-btn"
                      style={{ marginLeft: 8 }}
                      onClick={() => { setReleaseDate(bp.date_released ? String(bp.date_released).slice(0, 10) : ''); setEditingRelease(true); }}
                    >
                      Edit
                    </button>
                  )}
                </>
              )}
            </div>
            {bp.check_date && <div>Check Date : <span className="hi">{formatChequeDate(bp.check_date)}</span></div>}
            {bp.check_no && <div>Check No : <span className="hi">{bp.check_no}</span></div>}
            <div>Payment Type : <span className="hi">{bp.payment_type}</span></div>
          </div>
        </div>
      </div>

      <div className="estimate-footer card" style={{ marginTop: 20 }}>
        <div><span className="muted">Total Payments</span><div className="hi-lg">{money(bp.total_amount)}</div></div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'apply' ? 'active' : ''}`} onClick={() => setTab('apply')}>Apply</button>
        <button className={`status-tab ${tab === 'debits' ? 'active' : ''}`} onClick={() => setTab('debits')}>Debits</button>
        <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        <button className={`status-tab ${tab === 'related' ? 'active' : ''}`} onClick={() => setTab('related')}>
          Related Records{related.length ? ` (${related.length})` : ''}
        </button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'related' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Type</th><th>Date</th><th>Transaction #</th><th style={{ textAlign: 'right' }}>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {related.length === 0 && (
                  <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No related records.</td></tr>
                )}
                {related.map((r) => (
                  <tr key={`${r.kind}-${r.id}`}>
                    <td>{r.kind}</td>
                    <td>{formatDate(r.date_created)}</td>
                    <td><Link className="link-btn" to={r.path}>{r.doc_no}</Link></td>
                    <td style={{ textAlign: 'right' }}>{money(r.amount)}</td>
                    <td>{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'apply' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Vendor Bill #</th><th>Date</th><th>Date Due</th><th>Original Amount</th><th>Applied Amount</th></tr></thead>
              <tbody>
                {applyLines.length === 0 && (
                  <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No bills settled.</td></tr>
                )}
                {applyLines.map((l) => (
                  <tr key={l.id}>
                    <td><Link className="link-btn" to={`/vendor-bills/${l.vendor_bill_id}`}>{l.bill_no}</Link></td>
                    <td>{formatDate(l.vb_date_created)}</td>
                    <td>{formatDate(l.vb_date_due)}</td>
                    <td>{money(l.vb_gross_amount)}</td>
                    <td>{money(l.applied_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'debits' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Bill Credit #</th><th>Applied Amount</th></tr></thead>
              <tbody>
                {debitLines.length === 0 && (
                  <tr><td colSpan={2} className="muted" style={{ textAlign: 'center', padding: 20 }}>No credits used.</td></tr>
                )}
                {debitLines.map((l) => (
                  <tr key={l.id}>
                    <td><Link className="link-btn" to={`/bill-credits/${l.bill_credit_id}`}>{l.bill_credit_no}</Link></td>
                    <td>{money(l.applied_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* What this payment posts (DR A/P / CR bank, as the source posts it). A voided one still
          shows it: the void does not un-post it, its reversal journal cancels it. */}
      {tab === 'gl' && (
        <div className="card">
          {bp.reversal_journal && (
            <div className="muted" style={{ marginBottom: 10 }}>
              Reversed by{' '}
              <Link className="link-btn" to={`/journals/${bp.reversal_journal.id}`}>{bp.reversal_journal.journal_no}</Link>
            </div>
          )}
          <div className="table-wrap">
            <table>
              <thead><tr><th>Account</th><th style={{ textAlign: 'right' }}>Debit</th><th style={{ textAlign: 'right' }}>Credit</th></tr></thead>
              <tbody>
                {(bp.gl_impact || []).length === 0 && (
                  <tr><td colSpan={3} className="muted" style={{ textAlign: 'center', padding: 20 }}>No GL entry (no bank account on this payment).</td></tr>
                )}
                {(bp.gl_impact || []).map((g) => (
                  <tr key={g.account_code}>
                    <td>{g.account_code} — {g.account_name}</td>
                    <td style={{ textAlign: 'right' }}>{g.debit ? money(g.debit) : ''}</td>
                    <td style={{ textAlign: 'right' }}>{g.credit ? money(g.credit) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editOpen && (
        <BillPaymentModal
          paymentId={id}
          onClose={() => setEditOpen(false)}
          onSaved={async () => {
            setEditOpen(false);
            await load();
            if (tab === 'system') api.get(`/bill-payments/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
          }}
        />
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
