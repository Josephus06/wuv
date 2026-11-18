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

const STATUS_LABELS = { unpaid: 'UNPAID', partial: 'PARTIALLY PAID', paid: 'PAID', void: 'VOID' };

// Mirrors the live "Commission Payable" detail view (CP-#): a sales employee's earned commission
// for a commission-month range, booked as a payable. Posts DR Commission Expense - Internal /
// CR Commission Payable (see the GL Impact tab).
export default function CommissionPayableView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [cp, setCp] = useState(null);
  const [tab, setTab] = useState('commissions');
  const [auditLogs, setAuditLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function load() {
    return api.get(`/commission-payables/${id}`).then(({ data }) => { setCp(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (tab === 'system') api.get(`/commission-payables/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
  }, [tab, id]);

  async function handleVoid() {
    if (!confirm('Void this Commission Payable?')) return;
    setBusy(true); setError('');
    try { await api.put(`/commission-payables/${id}/void`); await load(); }
    catch (err) { setError(err.response?.data?.error || 'Void failed'); }
    finally { setBusy(false); }
  }
  async function handlePay(paid) {
    setBusy(true); setError('');
    try { await api.put(`/commission-payables/${id}/pay`, { paid }); await load(); }
    catch (err) { setError(err.response?.data?.error || 'Update failed'); }
    finally { setBusy(false); }
  }

  // Closed accounting period: no Edit / Void / Cancel (utils/periodLock.js; the server refuses them too).
  // The GL posts on the commission month (server lib/glImpact.js commissionPostingDate) -- a payable
  // raised from 1 Oct 2026 for Sept posts on 30 Sep -- so that month being closed locks it too.
  const postingDate = (() => {
    if (!cp) return null;
    const created = cp.date_created ? String(cp.date_created).slice(0, 10) : null;
    if (created && created < '2026-10-01') return created;
    const base = String(cp.period_to || cp.date_created || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(base)) return created;
    const [y, m] = base.split('-').map(Number);
    return `${base}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  })();
  const createdLocked = usePeriodLocked(cp?.date_created, 'other_gl');
  const postingLocked = usePeriodLocked(postingDate, 'other_gl');
  const periodLocked = createdLocked || postingLocked;

  if (loading || !cp) return <LoadingSpinner />;

  const canEdit = (can('/commission-payables', 'can_edit') && !periodLocked && cp?.can_edit_record !== false);
  const canVoid = (can('/commission-payables', 'can_void') && !periodLocked);
  const isOpen = cp.status !== 'void';

  // Mirrors the server's PUT guards: a payable that has been paid, or that a live Commission
  // Voucher has already released against, backs a settlement -- recomputing it would strand those
  // released amounts. can_approve overrides both (the server checks the same thing), so the lock
  // is a prompt for a deliberate decision rather than a dead end.
  const releasedAgainst = (cp.vouchers || []).some((v) => v.status !== 'void');
  const lockReason = cp.status === 'paid' || Number(cp.amount_paid) > 0
    ? 'Mark this Commission Payable unpaid before editing.'
    : releasedAgainst
      ? 'A Commission Voucher has already released against this payable -- void that voucher first.'
      : null;
  const isEditable = !lockReason || cp.can_override_edit_lock;
  const editTitle = !lockReason ? undefined
    : cp.can_override_edit_lock
      ? `${lockReason} You may edit it anyway -- recomputing can strand amounts already released.`
      : lockReason;

  // PAID is only offered once the commission has actually been released in full. Short of that
  // the document would claim to be settled while still owing the rep the difference.
  const releasedAmount = Number(cp.released_commission || 0);
  const shortfall = Number(cp.expected_commission || 0) - releasedAmount;
  const payTitle = cp.fully_released ? undefined
    : `Released ${money(releasedAmount)} of an Expected Commission of ${money(cp.expected_commission)} `
      + `-- release the remaining ${money(shortfall)} through a Commission Voucher first.`;

  // Released sits next to Expected because the gap between them is what decides whether this
  // payable can be marked paid -- without it on screen the disabled button looks arbitrary.
  const summary = [
    ['Quota', cp.quota], ['Weighted Sales', cp.weighted_sales], ['JO with Passing GP Rate', cp.passing_jos],
    ['Expected Commission', cp.expected_commission], ['Released Commission', releasedAmount],
    ['Commissionable Amount', cp.commissionable_amount],
  ];

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate(-1)}>Back to Lists</button>
          {canEdit && isOpen && (
            <button
              className="btn btn-sm"
              disabled={!isEditable}
              title={editTitle}
              onClick={() => navigate(`/commission-payables/${id}/edit`)}
            >Edit</button>
          )}
          {canEdit && isOpen && cp.status !== 'paid' && (
            <button
              className="btn btn-sm btn-primary"
              disabled={busy || !cp.fully_released}
              title={payTitle}
              onClick={() => handlePay(true)}
            >Mark Paid</button>
          )}
          {canEdit && isOpen && cp.status === 'paid' && <button className="btn btn-sm" disabled={busy} onClick={() => handlePay(false)}>Mark Unpaid</button>}
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
          <h1>Commission Payable</h1>
          <span className="estimate-no">{cp.commission_payable_no}</span>
        </div>
        <div className="estimate-status">{STATUS_LABELS[cp.status] || cp.status}</div>

        <div className="estimate-detail-grid">
          <div>
            <div>Employee : <span className="hi">{cp.employee_name}</span></div>
            <div>Location : <span className="hi">{cp.office_location_name || '—'}</span></div>
            <div>Department : <span className="hi">{cp.department_name || '—'}</span></div>
          </div>
          <div>
            <div>Date : <span className="hi">{formatDate(cp.date_created)}</span></div>
            <div>Commission Date : <span className="hi">{formatMonth(cp.period_from)} to {formatMonth(cp.period_to)}</span></div>
            {postingDate && <div>GL Posting Date : <span className="hi">{postingDate}</span></div>}
            <div>Memo : <span className="hi">{cp.memo || ''}</span></div>
          </div>
          <div className="commission-summary-box">
            {summary.map(([label, val]) => (
              <div key={label} className="commission-summary-row"><span>{label}</span><span className="hi">{money(val)}</span></div>
            ))}
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'commissions' ? 'active' : ''}`} onClick={() => setTab('commissions')}>Commissions</button>
        <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        <button className={`status-tab ${tab === 'related' ? 'active' : ''}`} onClick={() => setTab('related')}>Related Records</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'commissions' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th>Date</th><th style={{ textAlign: 'right' }}>Quota</th><th style={{ textAlign: 'right' }}>Weighted</th>
                <th style={{ textAlign: 'right' }}>JO with Passing GP Rate</th><th style={{ textAlign: 'right' }}>Expected Comission</th>
                <th style={{ textAlign: 'right' }}>Confirmed Comission</th><th style={{ textAlign: 'right' }}>Released Comission</th>
                <th style={{ textAlign: 'right' }}>Commission Amount</th>
              </tr></thead>
              <tbody>
                {cp.lines.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>No commission lines.</td></tr>}
                {cp.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{formatMonth(l.line_month)}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.quota)}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.weighted)}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.passing_jos)}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.expected)}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.confirmed)}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.released)}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.commission)}</td>
                  </tr>
                ))}
                {cp.lines.length > 0 && (
                  <tr>
                    <td colSpan={7} style={{ textAlign: 'right' }}><strong>Total</strong></td>
                    <td style={{ textAlign: 'right' }}><strong>{money(cp.commissionable_amount)}</strong></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'gl' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th>Account Code</th><th>Account Title</th><th>Department</th>
                <th style={{ textAlign: 'right' }}>Debit</th><th style={{ textAlign: 'right' }}>Credit</th>
                <th style={{ textAlign: 'right' }}>Amount Due</th><th style={{ textAlign: 'right' }}>Paid Amount</th>
              </tr></thead>
              <tbody>
                {(!cp.gl_impact || cp.gl_impact.length === 0) && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No GL impact.</td></tr>}
                {(cp.gl_impact || []).map((row, idx) => (
                  <tr key={idx}>
                    <td>{row.account_code}</td><td>{row.account_name}</td><td>{row.department || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{money(row.debit)}</td>
                    <td style={{ textAlign: 'right' }}>{money(row.credit)}</td>
                    <td style={{ textAlign: 'right' }}>{money(row.amount_due)}</td>
                    <td style={{ textAlign: 'right' }}>{money(row.paid_amount)}</td>
                  </tr>
                ))}
                {cp.gl_impact?.length > 0 && (
                  <tr>
                    <td /><td /><td />
                    <td style={{ textAlign: 'right' }}><strong>{money(cp.gl_impact.reduce((s, r) => s + Number(r.debit || 0), 0))}</strong></td>
                    <td style={{ textAlign: 'right' }}><strong>{money(cp.gl_impact.reduce((s, r) => s + Number(r.credit || 0), 0))}</strong></td>
                    <td /><td />
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
              <thead><tr><th>Commission Voucher</th><th>Date</th><th style={{ textAlign: 'right' }}>Released Amount</th><th>Status</th></tr></thead>
              <tbody>
                {(!cp.vouchers || cp.vouchers.length === 0) && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No commission voucher has released this payable yet.</td></tr>}
                {(cp.vouchers || []).map((v) => (
                  <tr key={v.id}>
                    <td><Link className="link-btn" to={`/commission-vouchers/${v.id}`}>{v.voucher_no}</Link></td>
                    <td>{formatDate(v.date_created)}</td>
                    <td style={{ textAlign: 'right' }}>{money(v.released_amount)}</td>
                    <td>{v.status === 'void' ? 'Void' : 'Posted'}</td>
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
