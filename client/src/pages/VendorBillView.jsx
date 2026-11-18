import { rate6 } from '../utils/rate';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { usePeriodLocked } from '../utils/periodLock';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import BillPaymentModal from '../components/BillPaymentModal';
import BillCreditModal from '../components/BillCreditModal';
import StandaloneVendorBillModal from '../components/StandaloneVendorBillModal';
import LoadingSpinner from '../components/LoadingSpinner';
import ReversalJournalModal from '../components/ReversalJournalModal';
import { SupplierLink } from '../components/PartyLink';
import { displayDate, displayAuditTime } from '../utils/dates';

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? displayDate(v) : '—'; }

const STATUS_LABELS = { open: 'Open', paid_in_full: 'Paid in Full', paid: 'Paid in Full', cancelled: 'Cancelled' };

// Mirrors the real "Vendor Bill" detail view -- reached from a Purchase Order's Related
// Records tab after billing it. Each line is a frozen snapshot of what was actually billed
// (Rate = the PO line's rate at that moment, Unit Price = what was actually charged), not a
// live re-query of the PO.
export default function VendorBillView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [vb, setVb] = useState(null);
  const [tab, setTab] = useState('items');
  const [auditLogs, setAuditLogs] = useState([]);
  const [related, setRelated] = useState({ bill_payments: [], bill_credits: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showBillPaymentModal, setShowBillPaymentModal] = useState(false);
  const [showBillCreditModal, setShowBillCreditModal] = useState(false);
  const [showReplicate, setShowReplicate] = useState(false);

  function load() {
    return api.get(`/vendor-bills/${id}`).then(({ data }) => { setVb(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'system') {
      api.get(`/vendor-bills/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
    }
    if (tab === 'related') {
      api.get(`/vendor-bills/${id}/related`).then(({ data }) => setRelated(data));
    }
  }, [tab, id]);

  // Cancel opens the Reversal Journal popup (2026-10-14): the bill's entry reversed, on the date,
  // location and memo chosen there -- as voiding a Sales Invoice or a Cheque does.
  const [showReversal, setShowReversal] = useState(false);
  function handleCancel() {
    setError('');
    setShowReversal(true);
  }

  // Closed accounting period: no Edit / Void / Cancel (utils/periodLock.js; the server refuses them too).
  const periodLocked = usePeriodLocked(vb?.date_created, 'ap');

  if (loading || !vb) return <LoadingSpinner />;

  const canEdit = (can('/vendor-bills', 'can_edit') && !periodLocked);
  const canVoid = (can('/vendor-bills', 'can_void') && !periodLocked);
  const isOpen = vb.status === 'open';
  // A bill entered directly (no PO) carries expense lines, so the item columns below --
  // item code, qty, unit, rate -- have nothing to show; it gets the Expenses shape instead.
  const isExpenseBill = !vb.purchase_order_id;
  // Replicate, as the Journal screen has: start a new bill from this one's vendor, account, term
  // and lines. Only a STANDALONE bill can be: a PO-backed one's lines are quantities billed
  // against purchase order lines, and copying them into an expense bill would raise a second bill
  // for goods already billed without moving the PO's billed qty an inch. Those are raised from the
  // Purchase Order's own Bill button, which is what the disabled tooltip says.
  const canReplicate = can('/vendor-bills', 'can_add');

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={vb.purchase_order_id ? `/purchase-orders/${vb.purchase_order_id}` : '/vendor-bills'}>Back</Link>
          {canEdit && vb.status !== 'cancelled' && <Link className="btn btn-sm" to={`/vendor-bills/${vb.id}/edit`}>Edit</Link>}
          {isOpen && <button className="btn btn-sm btn-primary" onClick={() => setShowBillPaymentModal(true)}>Bill Payment</button>}
          {isOpen && <button className="btn btn-sm btn-primary" onClick={() => setShowBillCreditModal(true)}>Bill Credit</button>}
          {canReplicate && !vb.purchase_order_id && (
            <button className="btn btn-sm" title="Start a new bill from this one's vendor, account and lines" onClick={() => setShowReplicate(true)}>Replicate</button>
          )}
          {canReplicate && !!vb.purchase_order_id && (
            <button className="btn btn-sm" disabled title={`Raised from ${vb.po_no || 'a Purchase Order'} -- bill that order again from the Purchase Order's Bill button, so its billed qty keeps up`}>Replicate</button>
          )}
          <Link className="btn btn-sm" to={`/vendor-bills/${id}/print`}>Print</Link>
          {/* BIR 2307 for just this bill (2026-11-05): the supplier's certificate for the bill's quarter, this bill only. */}
          {can('/reports/bir-2307') && Number(vb.wtax_amount) > 0 && vb.status !== 'cancelled' && vb.vendor_id && (() => {
            const ymd = String(vb.date_created).slice(0, 10);
            const q = `${ymd.slice(0, 4)}-Q${Math.floor((Number(ymd.slice(5, 7)) - 1) / 3) + 1}`;
            return (
              <button className="btn btn-sm" title="Generate the supplier's BIR 2307 for this bill"
                onClick={() => window.open(`/reports/bir-2307/form?quarter=${q}&payee=s${vb.vendor_id}&doc=${encodeURIComponent(`Vendor Bill-${vb.id}`)}`, '_blank')}>
                BIR 2307
              </button>
            );
          })()}
          {canVoid && isOpen && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleCancel}>Cancel</button>}
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
          <h1>Vendor Bill</h1>
          <span className="estimate-no">{vb.bill_no}</span>
        </div>
        <div className="estimate-status">{STATUS_LABELS[vb.status] || vb.status}</div>

        <div className="estimate-detail-grid">
          <div>
            <div>Vendor : <span className="hi"><SupplierLink id={vb.vendor_id} name={vb.supplier_name} /></span></div>
            <div>Office Location : <span className="hi">{vb.office_location_name || '—'}</span></div>
            <div>Account : <span className="hi">{vb.account_code ? `${vb.account_code} — ${vb.account_name}` : '—'}</span></div>
          </div>
          <div>
            <div>Date : <span className="hi">{formatDate(vb.date_created)}</span></div>
            <div>Term : <span className="hi">{vb.term}</span></div>
            <div>Date Due : <span className="hi">{formatDate(vb.date_due)}</span></div>
          </div>
          <div>
            <div>Created From : {vb.purchase_order_id
              ? <Link className="link-btn" to={`/purchase-orders/${vb.purchase_order_id}`}>{vb.po_no}</Link>
              : vb.form_request_id
                ? <Link className="link-btn" to={`/forms/${vb.form_request_id}`}>{vb.form_request_no || 'Liquidation'}</Link>
                : <span className="hi">Direct (no PO)</span>}</div>
            <div>Reference # : <span className="hi">{vb.reference_no || ''}</span></div>
            <div>Memo : <span className="hi">{vb.memo || ''}</span></div>
          </div>
        </div>
      </div>

      <div className="estimate-footer card" style={{ marginTop: 20 }}>
        <div><span className="muted">Sub Total</span><div className="hi-lg">{money(vb.subtotal)}</div></div>
        <div><span className="muted">Discount</span><div className="hi-lg">{money(vb.discount_amount)}</div></div>
        <div><span className="muted">Net of Tax</span><div className="hi-lg">{money(vb.net_of_tax)}</div></div>
        <div><span className="muted">Tax</span><div className="hi-lg">{money(vb.tax_amount)}</div></div>
        <div><span className="muted">Gross Amount</span><div className="hi-lg">{money(vb.gross_amount)}</div></div>
        <div><span className="muted">Withholding Tax</span><div className="hi-lg">{money(vb.wtax_amount)}</div></div>
        <div><span className="muted">Amount Due</span><div className="hi-lg">{money(vb.amount_due)}</div></div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>{isExpenseBill ? 'Expenses' : 'Items'}</button>
        <button className={`status-tab ${tab === 'wtax' ? 'active' : ''}`} onClick={() => setTab('wtax')}>Withholding Tax</button>
        <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        <button className={`status-tab ${tab === 'related' ? 'active' : ''}`} onClick={() => setTab('related')}>Related Records</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'items' && isExpenseBill && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account Code</th><th>Account Title</th><th>Description</th><th>Department</th>
                  <th>Amount</th><th>Tax Code</th><th>Tax Amount</th><th>Gross Amount</th>
                  <th>Withhold?</th><th>Withholding Tax Amt.</th><th>Amount Due</th>
                </tr>
              </thead>
              <tbody>
                {vb.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.line_account_code}</td>
                    <td>{l.line_account_name}</td>
                    <td>{l.description}</td>
                    <td>{l.department_name}</td>
                    <td>{money(l.net_of_tax)}</td>
                    <td>{l.tax_code}</td>
                    <td>{money(l.tax_amount)}</td>
                    <td>{money(l.ext_price)}</td>
                    <td>{l.is_withhold ? 'Yes' : 'No'}</td>
                    <td>{money(l.wtax_amount)}</td>
                    <td>{money(l.amount_due)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'items' && !isExpenseBill && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Item Code</th><th>Purchase Desc.</th><th>Location</th><th>Department</th>
                  <th>Billed Qty</th><th>Unit</th><th>Rate</th><th>Unit Price</th><th>Discount %</th>
                  <th>Total Disc. Amt.</th><th>Total Amt. (Net of Tax)</th><th>Tax Code</th><th>Tax Amt.</th>
                  <th>Ext. Price</th><th>Withhold?</th><th>Withholding Tax Amt.</th><th>Amount Due</th>
                </tr>
              </thead>
              <tbody>
                {vb.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.item_code ? `${l.item_code}${l.item_name ? ` — ${l.item_name}` : ''}` : (l.line_account_code ? `${l.line_account_code} ${l.line_account_name}` : '')}</td>
                    <td>{l.purchase_description}</td>
                    <td>{l.location_name}</td>
                    <td>{l.department_name}</td>
                    <td>{qty(l.qty)}</td>
                    <td>{l.purchase_unit || l.unit_title}</td>
                    <td>{rate6(l.rate)}</td>
                    <td>{rate6(l.unit_price)}</td>
                    <td>{l.disc_percent}</td>
                    <td>{money(l.disc_amount)}</td>
                    <td>{money(l.net_of_tax)}</td>
                    <td>{l.tax_code}</td>
                    <td>{money(l.tax_amount)}</td>
                    <td>{money(l.ext_price)}</td>
                    <td>{l.is_withhold ? 'Yes' : 'No'}</td>
                    <td>{money(l.wtax_amount)}</td>
                    <td>{money(l.amount_due)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'wtax' && (
        <div className="card">
          <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div className="field"><label>Withholding Tax</label><input readOnly value={vb.wtax_code || ''} /></div>
            <div className="field"><label>Withholding Tax Description</label><input readOnly value={vb.wtax_description || ''} /></div>
            <div className="field"><label>Withholding Tax Amount</label><input readOnly value={money(vb.wtax_amount)} /></div>
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
                {(!vb.gl_impact || vb.gl_impact.length === 0) && (
                  <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No GL impact yet.</td></tr>
                )}
                {(vb.gl_impact || []).map((row, idx) => (
                  <tr key={idx}>
                    <td>{row.account_code}</td>
                    <td>{row.account_name}</td>
                    <td>{row.debit ? money(row.debit) : ''}</td>
                    <td>{row.credit ? money(row.credit) : ''}</td>
                  </tr>
                ))}
                {vb.gl_impact?.length > 0 && (
                  <tr>
                    <td /><td />
                    <td><strong>{money(vb.gl_impact.reduce((s, r) => s + Number(r.debit || 0), 0))}</strong></td>
                    <td><strong>{money(vb.gl_impact.reduce((s, r) => s + Number(r.credit || 0), 0))}</strong></td>
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
              <thead><tr><th>Type</th><th>Reference</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {related.bill_payments.map((bp) => (
                  <tr key={`bp-${bp.id}`}>
                    <td>Bill Payment</td>
                    <td><Link className="link-btn" to={`/bill-payments/${bp.id}`}>{bp.bill_payment_no}</Link></td>
                    <td>{formatDate(bp.date_created)}</td>
                    <td>{money(bp.total_amount)}</td>
                    <td>{bp.status === 'voided' ? 'Voided' : 'Open'}</td>
                  </tr>
                ))}
                {related.bill_credits.map((bc) => (
                  <tr key={`bc-${bc.id}`}>
                    <td>Bill Credit</td>
                    <td><Link className="link-btn" to={`/bill-credits/${bc.id}`}>{bc.bill_credit_no}</Link></td>
                    <td>{formatDate(bc.date_created)}</td>
                    <td>{money(bc.total_amount)}</td>
                    <td>{bc.status === 'voided' ? 'Voided' : 'Open'}</td>
                  </tr>
                ))}
                {/* The reversal journal a cancel posted (2026-10-14). */}
                {(related.reversal_journals || []).map((j) => (
                  <tr key={`rj-${j.id}`}>
                    <td>Reversal Journal</td>
                    <td><Link className="link-btn" to={`/journals/${j.id}`}>{j.journal_no}</Link></td>
                    <td>{formatDate(j.date_created)}</td>
                    <td>{money(j.total_debit)}</td>
                    <td>{j.status === 'void' ? 'Voided' : 'Posted'}</td>
                  </tr>
                ))}
                {related.bill_payments.length === 0 && related.bill_credits.length === 0 && !(related.reversal_journals || []).length && (
                  <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No related records yet.</td></tr>
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

      {showBillPaymentModal && (
        <BillPaymentModal
          vendorBillId={id}
          onClose={() => setShowBillPaymentModal(false)}
          onSaved={(bp) => { setShowBillPaymentModal(false); navigate(`/bill-payments/${bp.id}`); }}
        />
      )}
      {showBillCreditModal && (
        <BillCreditModal
          vendorBillId={id}
          onClose={() => setShowBillCreditModal(false)}
          onSaved={(bc) => { setShowBillCreditModal(false); navigate(`/bill-credits/${bc.id}`); }}
        />
      )}
      {showReplicate && (
        <StandaloneVendorBillModal
          replicateFrom={id}
          onClose={() => setShowReplicate(false)}
          onSaved={(nb) => { setShowReplicate(false); navigate(`/vendor-bills/${nb.id}`); }}
        />
      )}
      {showReversal && (
        <ReversalJournalModal
          previewPath={`/vendor-bills/${id}/reversal-preview`}
          voidPath={`/vendor-bills/${id}/cancel`}
          docLabel="bill"
          onClose={() => setShowReversal(false)}
          onSaved={async () => { setShowReversal(false); await load(); }}
        />
      )}
    </div>
  );
}
