import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { usePeriodLocked } from '../utils/periodLock';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDate,  displayMonth, displayAuditTime } from '../utils/dates';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
}
function formatDate(v) { return v ? displayDate(v) : '—'; }
function formatMonth(v) { return v ? displayMonth(v) : '—'; }

const STATUS_LABELS = { posted: 'POSTED', void: 'VOID' };

// Mirrors the live "Commission Voucher" detail view (COMVCH-#): the release/payment of an
// employee's Commission Payables from a cash/bank account, net of expense adjustments.
export default function CommissionVoucherView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [cv, setCv] = useState(null);
  const [tab, setTab] = useState('commissions');
  const [auditLogs, setAuditLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function load() { return api.get(`/commission-vouchers/${id}`).then(({ data }) => { setCv(data); setLoading(false); }); }
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'system') api.get(`/commission-vouchers/${id}/audit-logs`).then(({ data }) => setAuditLogs(data)); }, [tab, id]);

  async function handleVoid() {
    if (!confirm('Void this Commission Voucher? This reverses the payments applied to its commissions.')) return;
    setBusy(true); setError('');
    try { await api.put(`/commission-vouchers/${id}/void`); await load(); }
    catch (err) { setError(err.response?.data?.error || 'Void failed'); }
    finally { setBusy(false); }
  }

  // Closed accounting period: no Edit / Void / Cancel (utils/periodLock.js; the server refuses them too).
  const periodLocked = usePeriodLocked(cv?.date_created, 'other_gl');

  if (loading || !cv) return <LoadingSpinner />;

  const canEdit = (can('/commission-vouchers', 'can_edit') && !periodLocked);
  const canVoid = (can('/commission-vouchers', 'can_void') && !periodLocked);
  const isOpen = cv.status !== 'void';
  const glDebit = (cv.gl_impact || []).reduce((s, r) => s + Number(r.debit || 0), 0);
  const glCredit = (cv.gl_impact || []).reduce((s, r) => s + Number(r.credit || 0), 0);

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate(-1)}>Back to Lists</button>
          {/* The printed Payment Voucher (2026-10-26); a voided one prints marked VOID. */}
          {can('/commission-vouchers', 'can_print') && (
            <button className="btn btn-sm" onClick={() => window.open(`/commission-vouchers/${id}/print`, '_blank')}>Print</button>
          )}
          {canEdit && isOpen && <Link className="btn btn-sm btn-primary" to={`/commission-vouchers/${id}/edit`}>Edit</Link>}
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
          <h1>Commission Voucher</h1>
          <span className="estimate-no">{cv.voucher_no}</span>
        </div>
        <div className="estimate-status">{STATUS_LABELS[cv.status] || cv.status}</div>

        <div className="estimate-detail-grid">
          <div>
            <div>Employee : <span className="hi">{cv.employee_name}</span></div>
            <div>Payee Name : <span className="hi">{cv.payee_name || cv.employee_name}</span></div>
          </div>
          <div>
            <div>Date Created : <span className="hi">{formatDate(cv.date_created)}</span></div>
            <div>Reference # : <span className="hi">{cv.reference_no || '—'}</span></div>
            <div>Memo : <span className="hi">{cv.memo || ''}</span></div>
          </div>
          <div>
            <div>Payment Method : <span className="hi">{cv.payment_method_name || '—'}</span></div>
            <div>Cash/Bank Account : <span className="hi">{cv.cash_account_name || '—'}</span></div>
            <div>Date Released : <span className="hi">{cv.date_released ? formatDate(cv.date_released) : '—'}</span></div>
          </div>
          <div className="commission-summary-box">
            <div className="commission-summary-row"><span>Total Payments</span><span className="hi">{money(cv.total_payments)}</span></div>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'commissions' ? 'active' : ''}`} onClick={() => setTab('commissions')}>Commissions</button>
        <button className={`status-tab ${tab === 'expenses' ? 'active' : ''}`} onClick={() => setTab('expenses')}>Expenses</button>
        <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        <button className={`status-tab ${tab === 'related' ? 'active' : ''}`} onClick={() => setTab('related')}>Related Records</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'commissions' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Trans #</th><th>Trans Date</th><th>Commission Date</th><th style={{ textAlign: 'right' }}>Released Amount</th></tr></thead>
              <tbody>
                {cv.lines.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No commissions released.</td></tr>}
                {cv.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.commission_payable_id
                      ? <Link className="link-btn" to={`/commission-payables/${l.commission_payable_id}`}>{l.commission_payable_no}</Link>
                      : (l.commission_payable_no || '—')}</td>
                    <td>{formatDate(l.payable_date)}</td>
                    <td>{formatMonth(l.period_from)}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.released_amount)}</td>
                  </tr>
                ))}
                {cv.lines.length > 0 && (
                  <tr><td colSpan={3} style={{ textAlign: 'right' }}><strong>Total Released</strong></td>
                    <td style={{ textAlign: 'right' }}><strong>{money(cv.lines.reduce((s, l) => s + Number(l.released_amount || 0), 0))}</strong></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'expenses' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Account Code</th><th>Account Title</th><th>Applies To</th><th>Description</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
              <tbody>
                {cv.expenses.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No expenses.</td></tr>}
                {cv.expenses.map((e) => (
                  <tr key={e.id}>
                    <td>{e.account_code}</td><td>{e.account_name}</td>
                    {/* Set only on a payback -- an expense pointed at a month reduces that
                        month's Released Commission instead of joining the refund pool. */}
                    <td>{e.applies_to_period_from
                      ? displayMonth(e.applies_to_period_from)
                      : <span className="muted">—</span>}</td>
                    <td>{e.description || ''}</td>
                    <td style={{ textAlign: 'right' }}>{money(e.amount)}</td>
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
              <thead><tr><th>Account Code</th><th>Account Title</th><th style={{ textAlign: 'right' }}>Debit</th><th style={{ textAlign: 'right' }}>Credit</th></tr></thead>
              <tbody>
                {(!cv.gl_impact || cv.gl_impact.length === 0) && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No GL impact.</td></tr>}
                {(cv.gl_impact || []).map((row, idx) => (
                  <tr key={idx}>
                    <td>{row.account_code}</td><td>{row.account_name}</td>
                    <td style={{ textAlign: 'right' }}>{money(row.debit)}</td>
                    <td style={{ textAlign: 'right' }}>{money(row.credit)}</td>
                  </tr>
                ))}
                {cv.gl_impact?.length > 0 && (
                  <tr><td /><td />
                    <td style={{ textAlign: 'right' }}><strong>{money(glDebit)}</strong></td>
                    <td style={{ textAlign: 'right' }}><strong>{money(glCredit)}</strong></td></tr>
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
              <thead><tr><th>Commission Payable</th><th>Commission Date</th><th style={{ textAlign: 'right' }}>Released Amount</th></tr></thead>
              <tbody>
                {cv.lines.length === 0 && <tr><td colSpan={3} className="muted" style={{ textAlign: 'center', padding: 20 }}>No related commission payables.</td></tr>}
                {cv.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.commission_payable_id
                      ? <Link className="link-btn" to={`/commission-payables/${l.commission_payable_id}`}>{l.commission_payable_no}</Link>
                      : (l.commission_payable_no || '—')}</td>
                    <td>{formatMonth(l.period_from)}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.released_amount)}</td>
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
              { key: 'set_by_name', label: 'Set By' }, { key: 'event_type', label: 'Type' },
              { key: 'field_name', label: 'Field' }, { key: 'old_value', label: 'Old Value' }, { key: 'new_value', label: 'New Value' },
            ]}
            rows={auditLogs}
            emptyLabel="No audit history yet."
          />
        </div>
      )}
    </div>
  );
}
