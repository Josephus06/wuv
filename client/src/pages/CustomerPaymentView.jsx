import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { usePeriodLocked } from '../utils/periodLock';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';
import CustomerPaymentModal from '../components/CustomerPaymentModal';
import DocumentAttachments from '../components/DocumentAttachments';
import ApplyPaymentModal from '../components/ApplyPaymentModal';

import { displayDate, displayAuditTime } from '../utils/dates';
import { CustomerLink } from '../components/PartyLink';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? displayDate(v) : '—'; }

// A saved payment starts NOT DEPOSITED -- the cash is in hand and the invoice is settled,
// but it hasn't been swept into the bank yet. DEPOSITED is the other live value, reached
// once a bank deposit picks it up (not modelled in this build).
const STATUS_LABELS = { not_deposited: 'NOT DEPOSITED', deposited: 'DEPOSITED', voided: 'VOID' };

// Mirrors the real "Customer Payment" detail view (CPAY-#), reached from an Invoice's
// Related Records after accepting a payment. Each line is either an invoice this payment
// settled or a Credit Memo it drew on -- never both, same shape as Bill Payment.
export default function CustomerPaymentView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [cp, setCp] = useState(null);
  const [tab, setTab] = useState('apply');
  const [auditLogs, setAuditLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  // Office Location on its own, also after deposit (asked 2026-10-03): it moves no money.
  const [locEdit, setLocEdit] = useState(false);
  const [locations, setLocations] = useState([]);
  const [locId, setLocId] = useState('');
  async function openLocEdit() {
    setLocId(cp.office_location_id ? String(cp.office_location_id) : '');
    setLocEdit(true);
    if (!locations.length) { try { const { data } = await api.get('/customer-payments/meta/locations'); setLocations(data); } catch { setLocations([]); } }
  }
  async function saveLoc() {
    setError('');
    try { await api.put(`/customer-payments/${id}/office-location`, { office_location_id: locId || null }); setLocEdit(false); await load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not save the Office Location.'); }
  }
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');

  function load() {
    return api.get(`/customer-payments/${id}`).then(({ data }) => { setCp(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'system') {
      api.get(`/customer-payments/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
    }
  }, [tab, id]);

  // Take an invoice back off this payment -- all of it, or part -- deposited or not. The invoice's
  // balance comes back and the amount returns to the payment's Unapplied balance; the amount
  // received and the deposit are untouched (PUT /customer-payments/:id/unapply).
  async function handleUnapply(l) {
    const applied = Number(l.applied_amount).toFixed(2);
    const typed = window.prompt(`Unapply how much from ${l.invoice_no || l.customer_refund_no}? (applied: ${applied})`, applied);
    if (typed === null) return;
    const amount = Number(String(typed).replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) { setError('Enter an amount more than 0 to unapply.'); return; }
    setBusy(true);
    setError('');
    try {
      await api.put(`/customer-payments/${id}/unapply`, {
        lines: [l.customer_refund_id ? { customer_refund_id: l.customer_refund_id, amount } : { sales_invoice_id: l.sales_invoice_id, amount }],
      });
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Unapply failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleVoid() {
    if (!confirm('Void this Customer Payment? The amounts it settled will be released back.')) return;
    setBusy(true);
    setError('');
    try {
      await api.put(`/customer-payments/${id}/void`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Void failed');
    } finally {
      setBusy(false);
    }
  }

  // Closed accounting period: no Edit / Void / Cancel (utils/periodLock.js; the server refuses them too).
  const periodLocked = usePeriodLocked(cp?.date_created, 'ar');

  if (loading || !cp) return <LoadingSpinner />;

  const canEdit = (can('/customer-payments', 'can_edit') && !periodLocked);
  const canVoid = (can('/customer-payments', 'can_void') && !periodLocked);
  // Anything not already voided can be voided -- a deposited payment included, since
  // 'void' is the terminal state rather than an alternative to being deposited.
  const isOpen = cp.status !== 'voided';
  const invoiceLines = cp.lines.filter((l) => l.sales_invoice_id);
  const creditLines = cp.lines.filter((l) => l.credit_memo_id);
  const refundLines = cp.lines.filter((l) => l.customer_refund_id);

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate(-1)}>Back</button>
          {/* Editable until it is deposited. Past that the receipt sits inside a deposit that a
              bank statement is reconciled against, and changing the amount underneath it would
              put the two out of step -- so it is void and re-enter from there. */}
          {canEdit && cp.status === 'not_deposited' && (
            <button className="btn btn-sm" onClick={() => setEditing(true)}>Edit</button>
          )}
          {canEdit && cp.status === 'deposited' && (
            <button className="btn btn-sm" disabled title="This payment has been deposited. Void it and re-enter if it is wrong.">Edit</button>
          )}
          {/* Apply the unapplied balance to invoices -- also after deposit, when Edit is locked. */}
          {canEdit && isOpen && Number(cp.unapplied_amount) > 0.005 && (
            <button className="btn btn-sm btn-primary" onClick={() => setApplying(true)}>Apply to Invoice</button>
          )}
          {can('/deposits', 'can_add') && cp.status === 'not_deposited' && (
            <button className="btn btn-sm btn-primary" onClick={() => navigate('/deposits/new', { state: { preselectPaymentId: cp.id } })}>Deposit</button>
          )}
          {cp.deposit_id && <Link className="btn btn-sm" to={`/deposits/${cp.deposit_id}`}>View Deposit</Link>}
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
          <h1>Customer Payment</h1>
          <span className="estimate-no">{cp.customer_payment_no}</span>
        </div>
        <div className="estimate-status">{STATUS_LABELS[cp.status] || cp.status}</div>

        <div className="estimate-detail-grid">
          <div>
            <div>Customer : <span className="hi"><CustomerLink id={cp.customer_id} name={cp.customer_name} /></span></div>
            <div>Date : <span className="hi">{formatDate(cp.date_created)}</span></div>
            <div>Department : <span className="hi">{cp.department_name || '—'}</span></div>
            <div>Office Location : {locEdit ? (
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <select value={locId} onChange={(e) => setLocId(e.target.value)} style={{ maxWidth: 220 }}>
                  <option value="">--None--</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
                </select>
                <button type="button" className="btn btn-sm btn-primary" onClick={saveLoc}>Save</button>
                <button type="button" className="btn btn-sm" onClick={() => setLocEdit(false)}>Cancel</button>
              </span>
            ) : (
              <>
                <span className="hi">{cp.office_location_name || '—'}</span>
                {canEdit && cp.status !== 'voided' && <button type="button" className="link-btn" style={{ marginLeft: 8 }} onClick={openLocEdit}>Edit</button>}
              </>
            )}</div>
            <div>Memo : <span className="hi">{cp.memo || ''}</span></div>
          </div>
          <div>
            <div>Receipt : <span className="hi">{cp.receipt_type || '—'}</span></div>
            <div>{cp.receipt_type === 'Provisional Receipt' ? 'PR #' : 'OR/CR #'} : <span className="hi">{cp.or_no || '—'}</span></div>
            <div>SI# / BS# : <span className="hi">{cp.si_bs_no || '—'}</span></div>
            <div>Payment Type : <span className="hi">{cp.payment_type || '—'}</span></div>
            <div>Payment Method : <span className="hi">{cp.payment_method_name || '—'}</span></div>
            <div>Reference # : <span className="hi">{cp.reference_no || '—'}</span></div>
            <div>Issued By : <span className="hi">{cp.issued_by_name || '—'}</span></div>
          </div>
          <div>
            <div>Deposit To : <span className="hi">{cp.deposit_account_code ? `${cp.deposit_account_code} ${cp.deposit_account_name}` : '—'}</span></div>
            <div>Prepared By : <span className="hi">{cp.created_by_name || '—'}</span></div>
          </div>
        </div>
      </div>

      <div className="estimate-footer card" style={{ marginTop: 20 }}>
        <div><span className="muted">Applied Amount</span><div className="hi-lg">{money(cp.applied_amount)}</div></div>
        <div><span className="muted">Unapplied Amount</span><div className="hi-lg">{money(cp.unapplied_amount)}</div></div>
        <div><span className="muted">Total Payments</span><div className="hi-lg">{money(cp.payment_amount)}</div></div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'apply' ? 'active' : ''}`} onClick={() => setTab('apply')}>Apply</button>
        <button className={`status-tab ${tab === 'credits' ? 'active' : ''}`} onClick={() => setTab('credits')}>Credits</button>
        <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
        <button className={`status-tab ${tab === 'attachments' ? 'active' : ''}`} onClick={() => setTab('attachments')}>Attachments</button>
      </div>

      {tab === 'apply' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Invoice #</th><th>Date Created</th><th>Original Amount</th><th>Applied Amount</th><th></th></tr></thead>
              <tbody>
                {invoiceLines.length === 0 && refundLines.length === 0 && (
                  <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>Nothing applied to an invoice.</td></tr>
                )}
                {invoiceLines.map((l) => (
                  <tr key={l.id}>
                    <td><Link className="link-btn" to={`/sales-invoices/${l.sales_invoice_id}`}>{l.invoice_no}</Link></td>
                    <td>{formatDate(l.invoice_date)}</td>
                    <td>{money(l.invoice_gross)}</td>
                    <td>{money(l.applied_amount)}</td>
                    <td>
                      {canEdit && isOpen && (
                        <button type="button" className="btn btn-sm" disabled={busy}
                          title="Take this invoice off the payment; the amount goes back to Unapplied"
                          onClick={() => handleUnapply(l)}>Unapply</button>
                      )}
                    </td>
                  </tr>
                ))}
                {refundLines.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <Link className="link-btn" to={`/customer-refunds/${l.customer_refund_id}`}>{l.customer_refund_no}</Link>
                      <span className="muted" style={{ fontSize: 12 }}> (Customer Refund)</span>
                    </td>
                    <td>{formatDate(l.refund_date)}</td>
                    <td>{money(l.refund_amount)}</td>
                    <td>{money(l.applied_amount)}</td>
                    <td>
                      {canEdit && isOpen && (
                        <button type="button" className="btn btn-sm" disabled={busy}
                          title="Take this refund off the payment; the amount goes back to Unapplied"
                          onClick={() => handleUnapply(l)}>Unapply</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'credits' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Credit Memo #</th><th>Applied Amount</th></tr></thead>
              <tbody>
                {creditLines.length === 0 && (
                  <tr><td colSpan={2} className="muted" style={{ textAlign: 'center', padding: 20 }}>No credits drawn on.</td></tr>
                )}
                {creditLines.map((l) => (
                  <tr key={l.id}>
                    <td><Link className="link-btn" to={`/credit-memos/${l.credit_memo_id}`}>{l.credit_memo_no}</Link></td>
                    <td>{money(l.applied_amount)}</td>
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
                {(!cp.gl_impact || cp.gl_impact.length === 0) && (
                  <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No GL impact -- set a Deposit To account on the payment.</td></tr>
                )}
                {(cp.gl_impact || []).map((row, idx) => (
                  <tr key={idx}>
                    <td>{row.account_code}</td>
                    <td>{row.account_name}</td>
                    <td>{row.debit ? money(row.debit) : '0.00'}</td>
                    <td>{row.credit ? money(row.credit) : '0.00'}</td>
                  </tr>
                ))}
                {cp.gl_impact?.length > 0 && (
                  <tr>
                    <td /><td />
                    <td><strong>{money(cp.gl_impact.reduce((s, r) => s + Number(r.debit || 0), 0))}</strong></td>
                    <td><strong>{money(cp.gl_impact.reduce((s, r) => s + Number(r.credit || 0), 0))}</strong></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'attachments' && <DocumentAttachments docType="customer_payment" docId={id} />}
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

      {/* Same form as taking the payment, opened on what was saved. Reloaded afterwards rather
          than patched locally: the edit moves balances on the invoices it settles, and the GL
          impact shown below is derived on read. */}
      {applying && (
        <ApplyPaymentModal payment={cp} onClose={() => setApplying(false)} onApplied={() => { setApplying(false); load(); }} />
      )}

      {editing && (
        <CustomerPaymentModal
          paymentId={cp.id}
          customerId={cp.customer_id}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); load(); }}
        />
      )}
    </div>
  );
}
