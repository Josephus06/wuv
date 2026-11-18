import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { usePeriodLocked } from '../utils/periodLock';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import CustomerPaymentModal from '../components/CustomerPaymentModal';
import DocumentAttachments from '../components/DocumentAttachments';
import CreditMemoModal from '../components/CreditMemoModal';
import LoadingSpinner from '../components/LoadingSpinner';
import Modal from '../components/Modal';
import ButtonMenu from '../components/ButtonMenu';
import ReversalJournalModal from '../components/ReversalJournalModal';
import SalesInvoiceEditModal from '../components/SalesInvoiceEditModal';
import StandaloneInvoiceModal from '../components/StandaloneInvoiceModal';

import { displayDate, displayAuditTime } from '../utils/dates';
import { billingAddress } from '../utils/invoicePrint';
import { CustomerLink } from '../components/PartyLink';

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? displayDate(v) : '—'; }

const STATUS_LABELS = { saved: 'Open', paid_in_full: 'Paid In Full', cancelled: 'Void' };
// Related Records lists payments and credits alongside each other, so it needs both
// vocabularies -- a payment is NOT DEPOSITED until a bank deposit sweeps it, while a
// credit memo is simply open or void.
const RELATED_STATUS_LABELS = {
  not_deposited: 'Not Deposited', deposited: 'Deposited', open: 'Open', voided: 'Void',
};

// Mirrors the real "Sales Invoice" detail view -- reached from a Sales Order's Related
// Records tab after billing it. Each line was a snapshot of a sales_order_line's own
// billing figures at the moment it was included, so this view is a frozen record of
// what was actually billed, not a live re-query of the SO.
export default function SalesInvoiceView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [si, setSi] = useState(null);
  const [tab, setTab] = useState('items');
  const [auditLogs, setAuditLogs] = useState([]);
  const [payments, setPayments] = useState([]);
  const [creditMemos, setCreditMemos] = useState([]);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showCreditMemoModal, setShowCreditMemoModal] = useState(false);
  const [editing, setEditing] = useState(false);
  const [replicating, setReplicating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Received by Logistics: the date picked on the calendar while the popup is open.
  const [logisticsDate, setLogisticsDate] = useState(null);
  const [logisticsError, setLogisticsError] = useState('');

  // The two related-record lists sit behind their OWN page permissions (/customer-payments
  // and /credit-memos each require can_view), which invoice viewers are not automatically
  // granted. Batching all three in one Promise.all meant a single 403 rejected the batch,
  // setLoading(false) never ran, and the page sat on "Loading..." forever -- indistinguishable
  // from a hung request, and unfixable by granting invoice permission. They are supporting
  // detail, so each degrades to an empty list on its own; only the invoice itself is fatal.
  const optional = (p) => p.then((r) => r.data).catch(() => []);

  function load() {
    return Promise.all([
      api.get(`/sales-invoices/${id}`),
      optional(api.get(`/customer-payments/by-invoice/${id}`)),
      optional(api.get(`/credit-memos/by-invoice/${id}`)),
    ]).then(([siRes, pay, cm]) => {
      setSi(siRes.data);
      setPayments(pay);
      setCreditMemos(cm);
      setLoading(false);
    }).catch((err) => {
      setError(err.response?.status === 403
        ? "You don't have permission to view this invoice."
        : err.response?.data?.error || 'Could not load this invoice.');
      setLoading(false);
    });
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'system') {
      api.get(`/sales-invoices/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
    }
  }, [tab, id]);

  // Void opens the Reversal Journal popup (date, location, memo, GL Impact) rather than voiding on
  // the spot; the popup's Save is what voids it.
  const [showReversal, setShowReversal] = useState(false);
  function handleCancel() { setError(''); setShowReversal(true); }

  // Closed accounting period: no Edit / Void / Cancel (utils/periodLock.js; the server refuses them too).
  const periodLocked = usePeriodLocked(si?.date_created, 'ar');

  if (loading) return <LoadingSpinner />;
  // A failed load leaves si null. Without this the "loading || !si" guard spun forever on
  // an error instead of saying what went wrong.
  if (!si) {
    return (
      <div>
        <div className="page-header">
          <div />
          <button className="btn btn-sm" onClick={() => navigate(-1)}>Back</button>
        </div>
        <div className="error-banner">{error || 'Could not load this invoice.'}</div>
      </div>
    );
  }

  const canEdit = (can('/sales-invoices', 'can_edit') && !periodLocked);
  const canVoid = (can('/sales-invoices', 'can_void') && !periodLocked);
  // Replicate starts a new invoice from this one's customer, terms and lines. Only an invoice billed
  // straight to a customer can be: one raised from a Sales Order, Delivery Ticket, Estimate or NSSO
  // bills quantities against that document, and a copy would bill them a second time without the
  // order knowing. Those are billed again from their own Bill button, as the tooltip says.
  const canReplicate = can('/sales-invoices', 'can_add');
  const replicateSource = si.dt_no || si.sales_order_no || si.estimate_no || si.nsso_no
    || (si.sales_order_id || si.delivery_ticket_id || si.estimate_id || si.nsso_id ? 'an order' : null);
  const isSaved = si.status === 'saved';
  // Both actions settle or reduce what's owed, so they only make sense while something is
  // still owed and the invoice hasn't been voided.
  // Open while anything is owed on the GROSS -- a paid invoice whose withheld EWT is not yet cleared
  // by its EWT credit memo is still open for that memo (INV-80196).
  const isSettleable = si.status !== 'cancelled' && Number(si.gross_due ?? si.amount_due) > 0.005;
  // Each of these belongs to the module that actually receives the record, not to Sales
  // Invoices -- the same rule SalesOrderView already applies to Item Delivery. Accepting a
  // payment POSTs to /customer-payments and a credit memo to /credit-memos, and both servers
  // ask for can_add on their OWN page. Gating them on Sales Invoices' can_edit hid the button
  // from people the server would have allowed, which is how an account with customer-payment
  // rights ended up unable to take a payment against an invoice it could read.
  const canTakePayment = can('/customer-payments', 'can_add');
  const canRaiseCreditMemo = can('/credit-memos', 'can_add');
  // Recording the hand-over to Logistics is can_update, not can_edit (PUT /:id/logistics-received).
  const canMarkLogistics = can('/sales-invoices', 'can_update') && si.status !== 'cancelled';
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  async function saveLogistics() {
    setLogisticsError('');
    if (!logisticsDate) { setLogisticsError('Choose the date.'); return; }
    setBusy(true);
    try {
      await api.put(`/sales-invoices/${id}/logistics-received`, { date: logisticsDate });
      setLogisticsDate(null);
      await load();
    } catch (err) {
      setLogisticsError(err.response?.data?.error || 'Could not save the date.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          {/* Back to wherever this invoice came from -- an estimate-sourced one has no Sales
              Order to go back to, so it returns to the invoice list. */}
          <Link className="btn btn-sm" to={si.sales_order_id ? `/sales-orders/${si.sales_order_id}` : '/sales-invoices'}>Back</Link>
          {/* Editable while the invoice is OPEN and nothing has settled it. Both conditions are
              decided server-side (see whyNotEditable) and arrive on the invoice, so the button and
              the refusal cannot disagree -- and the disabled tooltip is the server's own words. */}
          {canEdit && si.editable && (
            <button className="btn btn-sm" onClick={() => setEditing(true)}>Edit</button>
          )}
          {canEdit && si.editable === false && (
            <button className="btn btn-sm" disabled title={si.not_editable_reason || 'This Invoice cannot be edited.'}>Edit</button>
          )}
          {canReplicate && !replicateSource && (
            <button className="btn btn-sm" title="Start a new invoice from this one's customer, terms and lines" onClick={() => setReplicating(true)}>Replicate</button>
          )}
          {canReplicate && replicateSource && (
            <button className="btn btn-sm" disabled title={`Raised from ${replicateSource} -- bill it again from that document's Bill button, so what it has billed keeps up`}>Replicate</button>
          )}
          <ButtonMenu
            label="Print"
            // A Delivery Receipt is not a Service Invoice: it has one form of its own and neither
            // of the invoice formats, so it is not offered a choice it cannot use.
            options={si.invoice_type === 'DR'
              ? [{ label: 'Delivery Receipt', hint: 'Plain paper', onClick: () => window.open(`/sales-invoices/${id}/print`, '_blank') }]
              : [
                { label: 'Type 1', hint: 'Pre-printed Service Invoice form', onClick: () => window.open(`/sales-invoices/${id}/print`, '_blank') },
                { label: 'Type 2', hint: 'Plain paper, full invoice', onClick: () => window.open(`/sales-invoices/${id}/print?type=2`, '_blank') },
              ]}
          />
          {canTakePayment && isSettleable && <button className="btn btn-sm btn-primary" onClick={() => setShowPaymentModal(true)}>Accept Payment</button>}
          {canRaiseCreditMemo && isSettleable && <button className="btn btn-sm btn-primary" onClick={() => setShowCreditMemoModal(true)}>Credit Memo</button>}
          {canMarkLogistics && (
            <button className="btn btn-sm" onClick={() => { setLogisticsError(''); setLogisticsDate(si.logistics_received_date ? String(si.logistics_received_date).slice(0, 10) : today()); }}
              title={si.logistics_received_date ? 'Change the date Logistics received this invoice' : 'Record the date Logistics received this invoice'}>
              Received by Logistics
            </button>
          )}
          {canVoid && isSaved && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleCancel}>Void</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {periodLocked && (
        <div className="warning-banner" style={{ marginBottom: 12 }}>
          The accounting period for this transaction is closed ({periodLocked}), so it can no longer be edited, voided or cancelled.
        </div>
      )}

      {logisticsDate !== null && (
        <Modal title={`Received by Logistics -- ${si.invoice_no}`} onClose={() => !busy && setLogisticsDate(null)}>
          {logisticsError && <div className="error-banner">{logisticsError}</div>}
          <div className="field">
            <label>Date received by Logistics</label>
            <input type="date" value={logisticsDate} min={String(si.date_created).slice(0, 10)} onChange={(e) => setLogisticsDate(e.target.value)} />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => setLogisticsDate(null)}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={saveLogistics}>{busy ? 'Saving...' : 'Save'}</button>
          </div>
        </Modal>
      )}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Invoice</h1>
          <span className="estimate-no">{si.invoice_no}</span>
        </div>
        <div className="estimate-status">{STATUS_LABELS[si.status] || si.status}</div>

        <div className="estimate-detail-grid">
          <div>
            <div>Customer : <span className="hi"><CustomerLink id={si.customer_link_id} name={si.customer_name} /></span></div>
            {/* An invoice raised from an Estimate has no Sales Order, so this read blank and
                linked to /sales-orders/null. It shows whichever source the invoice actually has. */}
            <div>
              Created Form :{' '}
              {si.sales_order_id ? (
                <Link className="link-btn" to={`/sales-orders/${si.sales_order_id}`}>{si.sales_order_no}</Link>
              ) : si.estimate_id ? (
                <Link className="link-btn" to={`/estimates/${si.estimate_id}`}>{si.estimate_no}</Link>
              ) : si.nsso_id ? (
                <Link className="link-btn" to={`/non-standard-sales-orders/${si.nsso_id}`}>{si.nsso_no}</Link>
              ) : <span className="hi">{si.customer_id ? 'Direct (no order)' : '—'}</span>}
            </div>
            {si.delivery_ticket_id && (
              <div>Delivery Ticket : <Link className="link-btn" to={`/delivery-tickets/${si.delivery_ticket_id}`}>{si.dt_no}</Link></div>
            )}
            <div>Date : <span className="hi">{formatDate(si.date_created)}</span></div>
            {si.invoice_type !== 'DR' && <div>BS/SI # : <span className="hi">{si.bs_si_no || ''}</span></div>}
            <div>PO # : <span className="hi">{si.po_no || ''}</span></div>
            <div>Memo : <span className="hi">{si.memo || ''}</span></div>
          </div>
          <div>
            <div>Term : <span className="hi">{si.term}</span></div>
            <div>Date Due : <span className="hi">{formatDate(si.date_due)}</span></div>
            <div>Type : <span className="hi">{si.invoice_type || 'SI'}</span></div>
            <div>
              Received by Logistics :{' '}
              <span className="hi">
                {si.logistics_received_date ? formatDate(String(si.logistics_received_date).slice(0, 10)) : '—'}
                {si.logistics_received_date && si.logistics_received_by_name ? ` (${si.logistics_received_by_name})` : ''}
              </span>
            </div>
          </div>
          <div>
            <div>Sales Rep : <span className="hi">{si.sales_rep_name || '—'}</span></div>
            <div>Office Location : <span className="hi">{si.office_location_name || '—'}</span></div>
            <div>Department : <span className="hi">{si.department_name || '—'}</span></div>
            <div>Bill to Address : <span className="hi">{billingAddress(si)}</span></div>
          </div>
        </div>
      </div>

      <div className="estimate-footer card" style={{ marginTop: 20 }}>
        <div><span className="muted">Net of Tax</span><div className="hi-lg">{money(si.net_of_tax)}</div></div>
        <div><span className="muted">Discount</span><div className="hi-lg">{money(si.discount_amount)}</div></div>
        {/* In the order the amounts build up: Gross = Net + Tax, Amount = Gross - EWT (as printed),
            Amount Due = what is still owed on the GROSS: Gross less every payment and credit memo applied
            to it -- the balance AR Aging carries (server lib/invoiceDue.js, 2026-10-12). */}
        <div><span className="muted">Tax</span><div className="hi-lg">{money(si.tax_amount)}</div></div>
        <div><span className="muted">Gross</span><div className="hi-lg">{money(si.gross_amount)}</div></div>
        <div><span className="muted">EWT</span><div className="hi-lg">{money(si.ewt_amount)}</div></div>
        <div><span className="muted">Amount</span><div className="hi-lg">{money(Number(si.gross_amount || 0) - Number(si.ewt_amount || 0))}</div></div>
        <div><span className="muted">Amount Due</span><div className="hi-lg">{money(si.gross_due ?? si.amount_due)}</div></div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>Items</button>
        <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        <button className={`status-tab ${tab === 'related' ? 'active' : ''}`} onClick={() => setTab('related')}>Related Records</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
        <button className={`status-tab ${tab === 'attachments' ? 'active' : ''}`} onClick={() => setTab('attachments')}>Attachments</button>
      </div>

      {tab === 'items' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>JO #</th><th>Description</th><th>Qty</th><th>Units</th><th>Price/Unit</th><th>Subtotal</th>
                  <th>Disc. Amt</th><th>Net of Tax</th><th>Tax Code</th><th>Tax Amt</th><th>Gross Amt</th>
                </tr>
              </thead>
              <tbody>
                {si.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.job_order_id ? (
                      <Link className="link-btn" to={`/production/${l.job_order_id}`}>{l.job_order_no}</Link>
                    ) : '—'}</td>
                    <td>{l.description}</td>
                    <td>{qty(l.quantity)}</td>
                    <td>{l.units}</td>
                    <td>{money(l.price_per_unit)}</td>
                    <td>{money(l.subtotal)}</td>
                    <td>{money(l.disc_amount)}</td>
                    <td>{money(l.net_of_tax)}</td>
                    <td>{l.tax_code}</td>
                    <td>{money(l.tax_amount)}</td>
                    <td>{money(l.gross_amount)}</td>
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
                {(!si.gl_impact || si.gl_impact.length === 0) && (
                  <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No GL impact yet.</td></tr>
                )}
                {(si.gl_impact || []).map((row, idx) => (
                  <tr key={idx}>
                    <td>{row.account_code}</td>
                    <td>{row.account_name}</td>
                    <td>{row.debit ? money(row.debit) : ''}</td>
                    <td>{row.credit ? money(row.credit) : ''}</td>
                  </tr>
                ))}
                {si.gl_impact?.length > 0 && (
                  <tr>
                    <td /><td />
                    <td><strong>{money(si.gl_impact.reduce((s, r) => s + Number(r.debit || 0), 0))}</strong></td>
                    <td><strong>{money(si.gl_impact.reduce((s, r) => s + Number(r.credit || 0), 0))}</strong></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'related' && (
        <div className="card">
          {si.sales_order_id && (
            <p>Sales Order: <Link className="btn btn-sm" to={`/sales-orders/${si.sales_order_id}`}>{si.sales_order_no}</Link></p>
          )}
          {si.estimate_id && (
            <p>Estimate: <Link className="btn btn-sm" to={`/estimates/${si.estimate_id}`}>{si.estimate_no}</Link></p>
          )}
          {si.nsso_id && (
            <p>Non-Standard SO: <Link className="btn btn-sm" to={`/non-standard-sales-orders/${si.nsso_id}`}>{si.nsso_no}</Link></p>
          )}
          {si.delivery_ticket_id && (
            <p>Delivery Ticket: <Link className="btn btn-sm" to={`/delivery-tickets/${si.delivery_ticket_id}`}>{si.dt_no}</Link></p>
          )}
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead><tr><th>Type</th><th>Reference</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {payments.length === 0 && creditMemos.length === 0 && !(si.reversal_journals || []).length && (
                  <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No payments or credits against this invoice yet.</td></tr>
                )}
                {/* Voiding writes a reversal journal (lib/reversalJournal.js); it is listed here so
                    the void's GL entry can be reached from the invoice itself. */}
                {(si.reversal_journals || []).map((j) => (
                  <tr key={`j${j.id}`}>
                    <td>Reversal Journal</td>
                    <td><Link className="link-btn" to={`/journals/${j.id}`}>{j.journal_no}</Link></td>
                    <td>{formatDate(j.date_created)}</td>
                    <td>{money(j.total_debit)}</td>
                    <td>{j.status === 'REVERSAL' ? 'Reversal' : j.status}</td>
                  </tr>
                ))}
                {payments.map((p) => (
                  <tr key={`p${p.id}`}>
                    <td>Customer Payment</td>
                    <td><Link className="link-btn" to={`/customer-payments/${p.id}`}>{p.customer_payment_no}</Link></td>
                    <td>{formatDate(p.date_created)}</td>
                    <td>{money(p.applied_amount)}</td>
                    <td>{RELATED_STATUS_LABELS[p.status] || p.status}</td>
                  </tr>
                ))}
                {creditMemos.map((c) => (
                  <tr key={`c${c.id}`}>
                    <td>Credit Memo</td>
                    <td><Link className="link-btn" to={`/credit-memos/${c.id}`}>{c.credit_memo_no}</Link></td>
                    <td>{formatDate(c.date_created)}</td>
                    {/* What this memo put against THIS invoice, like the payment rows above it.
                        Its own gross only where it is linked to the invoice but applied elsewhere. */}
                    <td>{money(Number(c.applied_amount) > 0 ? c.applied_amount : c.gross_amount)}</td>
                    <td>{RELATED_STATUS_LABELS[c.status] || c.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'attachments' && <DocumentAttachments docType="sales_invoice" docId={id} />}
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

      {showPaymentModal && (
        <CustomerPaymentModal
          invoiceId={Number(id)}
          onClose={() => setShowPaymentModal(false)}
          onSaved={async (cp) => { setShowPaymentModal(false); await load(); navigate(`/customer-payments/${cp.id}`); }}
        />
      )}

      {showCreditMemoModal && (
        <CreditMemoModal
          invoiceId={Number(id)}
          onClose={() => setShowCreditMemoModal(false)}
          onSaved={async (cm) => { setShowCreditMemoModal(false); await load(); navigate(`/credit-memos/${cm.id}`); }}
        />
      )}

      {showReversal && (
        <ReversalJournalModal
          invoiceId={Number(id)}
          onClose={() => setShowReversal(false)}
          onSaved={async () => { setShowReversal(false); await load(); }}
        />
      )}

      {/* Reloaded rather than patched from the response: the save recomputes EWT and Amount Due,
          and GL Impact and the audit trail are derived from them. */}
      {replicating && (
        <StandaloneInvoiceModal
          replicateFrom={id}
          onClose={() => setReplicating(false)}
          onSaved={(ns) => { setReplicating(false); navigate(`/sales-invoices/${ns.id}`); }}
        />
      )}
      {editing && (
        <SalesInvoiceEditModal
          invoice={si}
          onClose={() => setEditing(false)}
          onSaved={async () => { setEditing(false); await load(); }}
        />
      )}
    </div>
  );
}
