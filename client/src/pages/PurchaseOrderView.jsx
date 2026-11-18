import { rate6 } from '../utils/rate';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { usePeriodLocked } from '../utils/periodLock';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import VendorBillModal from '../components/VendorBillModal';
import LoadingSpinner from '../components/LoadingSpinner';
import { discountLabel } from '../utils/discountChain';
import Modal from '../components/Modal';
import { SupplierLink } from '../components/PartyLink';
import { isApprovedPo, isSettledPo, normalisePoStatus } from '../utils/poStatus';

import { displayDate, displayDateTime, displayAuditTime } from '../utils/dates';

// Keyed on the NORMALISED status, so the source's own settled states have a label here rather than
// being printed raw -- and so this screen names a purchase order exactly as the list does.
const STATUS_LABELS = {
  pending_approval: 'Pending Approval',
  pending_approval_gm: 'Pending Approval for GM',
  approved: 'Approved',
  cancelled: 'Cancelled',
  pending_billing: 'Pending Billing',
  partially_billed: 'Partially Billed',
  fully_billed: 'Fully Billed',
  partially_received: 'Partially Received',
  fully_received: 'Fully Received',
};

const RECEIPT_STATUS_LABELS = {
  not_received: null,
  partially_received: 'Partially Received',
  fully_received: 'Fully Received',
};

// Once a PO is fully received there's nothing left to approve or receive -- the real
// system's Status field itself moves on from "Approved by X" to "Pending Billing"
// (waiting on a Vendor Bill) to "Billed" once every received line has also been fully
// billed, with SubStatus showing "Fully Received" separately throughout.
function statusLabel(po) {
  // Normalised first, so an imported 'Approved by General Manager' is read as approved rather than
  // falling past every branch to be printed verbatim.
  const st = normalisePoStatus(po.status);
  // Billing done here outranks an imported Pending Billing label -- the same order the list uses.
  if (st !== 'cancelled' && po.bill_status === 'fully_billed') return 'Fully Billed';
  if (st === 'pending_billing' && po.bill_status === 'partially_billed') return 'Partially Billed';
  if (st === 'approved') {
    if (po.receipt_status === 'fully_received') {
      return po.bill_status === 'fully_billed' ? 'Billed' : 'Pending Billing';
    }
    // Who approved: a GM approval here, or the source's own label -- an imported PO reads 'Approved by
    // General Manager' with no approver id, and read "Approved by Supervisor" (PO-20380, 2026-10-08).
    const byGm = po.approved_by_gm_user_id || /general.?manager|\bgm\b/i.test(String(po.status || ''));
    // Plus where it is now, the same stage the list files it under -- the list said Pending Receipt
    // while this said only who approved it.
    const stage = po.receipt_status === 'partially_received' ? 'Partially Received' : 'Pending Receipt';
    return `${byGm ? 'Approved by General Manager' : 'Approved by Supervisor'} · ${stage}`;
  }
  // The source's settled states say more than receipt_status ever will for an imported PO, so they
  // are shown as they are -- and they are now what the LIST says too.
  return STATUS_LABELS[st] || STATUS_LABELS[po.status] || po.status;
}

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? displayDate(v) : '—'; }

export default function PurchaseOrderView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, user } = useAuth();
  const [po, setPo] = useState(null);
  const [tab, setTab] = useState('items');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [auditLogs, setAuditLogs] = useState([]);
  const [landedCosts, setLandedCosts] = useState([]);
  const [receipts, setReceipts] = useState([]);
  const [returns, setReturns] = useState([]);
  const [bills, setBills] = useState([]);
  const [showBillModal, setShowBillModal] = useState(false);
  // Send Email: the approved PO's PDF to the supplier (POST /purchase-orders/:id/email).
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailInfo, setEmailInfo] = useState(null);
  const [emailTo, setEmailTo] = useState('');
  const [emailNote, setEmailNote] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [emailResult, setEmailResult] = useState(null);

  // "Compare" on an item line: what this item has cost before, per supplier.
  const [compareLine, setCompareLine] = useState(null);
  const [compareData, setCompareData] = useState(null);
  const [compareError, setCompareError] = useState('');

  async function openCompare(line) {
    setCompareLine(line);
    setCompareData(null);
    setCompareError('');
    try {
      // exclude_po: this order is the thing being compared, not one of its own precedents.
      const { data } = await api.get(`/purchase-orders/item-price-history/${line.item_id}`, {
        params: { exclude_po: id },
      });
      setCompareData(data);
    } catch (err) {
      setCompareError(err.response?.data?.error || 'Could not load this item’s price history.');
    }
  }

  async function openEmail() {
    setEmailError('');
    setEmailResult(null);
    setEmailNote('');
    setEmailOpen(true);
    try {
      const { data } = await api.get(`/purchase-orders/${id}/email-recipient`);
      setEmailInfo(data);
      setEmailTo(data.suggested || '');
    } catch (err) {
      setEmailInfo(null);
      setEmailError(err.response?.data?.error || 'Could not look up the supplier’s address.');
    }
  }

  async function sendEmail() {
    setEmailBusy(true);
    setEmailError('');
    try {
      const { data } = await api.post(`/purchase-orders/${id}/email`, { email: emailTo.trim(), note: emailNote.trim() });
      setEmailResult(data);
      api.get(`/purchase-orders/${id}/audit-logs`).then(({ data: logs }) => setAuditLogs(logs)).catch(() => {});
    } catch (err) {
      setEmailError(err.response?.data?.error || 'Could not send it.');
    } finally {
      setEmailBusy(false);
    }
  }

  function load() {
    return api.get(`/purchase-orders/${id}`).then(({ data }) => { setPo(data); setLoading(false); });
  }

  function loadRelated() {
    api.get(`/purchase-orders/${id}/receipts`).then(({ data }) => setReceipts(data));
    api.get(`/purchase-orders/${id}/returns`).then(({ data }) => setReturns(data));
    api.get(`/vendor-bills/by-purchase-order/${id}`).then(({ data }) => setBills(data));
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'system') {
      api.get(`/purchase-orders/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
    }
    if (tab === 'landed') {
      api.get(`/purchase-orders/${id}/landed-costs`).then(({ data }) => setLandedCosts(data));
    }
    if (tab === 'related') {
      loadRelated();
    }
  }, [tab, id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleCancel() {
    if (!confirm('Cancel this Purchase Order? Its ordered qty will be reversed off the source PR.')) return;
    setBusy(true);
    setError('');
    try {
      await api.put(`/purchase-orders/${id}/cancel`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Cancel failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleApprove() {
    if (!confirm('Approve this Purchase Order?')) return;
    setBusy(true);
    setError('');
    try {
      await api.put(`/purchase-orders/${id}/approve`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Approve failed');
    } finally {
      setBusy(false);
    }
  }

  // Closed accounting period: no Edit / Void / Cancel (utils/periodLock.js; the server refuses them too).
  const periodLocked = usePeriodLocked(po?.date_created, 'non_gl');

  if (loading || !po) return <LoadingSpinner />;

  const canEdit = (can('/purchase-orders', 'can_edit') && !periodLocked);
  const canApprovePO = can('/purchase-orders', 'can_approve');
  // A printed PO is an order placed -- a supplier holding one will deliver against it -- so the
  // button only appears once the order has actually been approved. The server enforces the same
  // rule (GET /purchase-orders/:id/print); this just avoids offering a button that would refuse.
  const showPrint = can('/purchase-orders', 'can_print') && isApprovedPo(po.status);
  // Normalised: an imported PO says 'Cancelled', 'Approved by General Manager', 'Fully Billed' --
  // comparing to the app's own codes was wrong about almost every purchase order in the database.
  const st = normalisePoStatus(po.status);
  const canCancel = st !== 'cancelled';
  // Mirrors the real system: Edit only appears before approval -- once a PO is
  // Approved it may already have Receiving Reports / Vendor Bills built on top of its
  // lines, and this build has no undo path for that, same reasoning as every other
  // transaction type here only supporting Cancel (never Edit) once posted.
  // ...unless this user is switched on to edit approved POs (Users > Account Type).
  // A System Admin edits at any status (the server allows it the same way).
  const showEdit = canEdit && (st === 'pending_approval' || st === 'pending_approval_gm'
    || user?.account_type === 'System Admin'
    || (!!user?.can_edit_approved_po && isApprovedPo(po.status) && st !== 'cancelled'));
  // A Purchasing Supervisor signs a PO up to this; above it the General Manager alone. PO3 is the
  // General Manager's whatever the amount (PO4 too until 2026-10-20). Kept in step with APPROVAL_THRESHOLD /
  // GM_ONLY_TYPES in routes/purchaseOrders.js, which is what actually enforces it.
  const SUPERVISOR_APPROVAL_LIMIT = 10000;
  const withinSupervisorLimit = Number(po.total_amount || 0) <= SUPERVISOR_APPROVAL_LIMIT && po.type !== 'PO3';
  const showApprove = canApprovePO && (
    // A GM may also approve at the first stage -- it approves outright (server: PUT /approve).
    (st === 'pending_approval' && (!!user?.is_purchasing_supervisor || user?.account_type === 'System Admin' || user?.account_type === 'General Manager'))
    || (st === 'pending_approval_gm' && (
      user?.account_type === 'System Admin' || user?.account_type === 'General Manager'
      || (!!user?.is_purchasing_supervisor && withinSupervisorLimit)
    ))
  );
  // Receivable when approved by EITHER route and not already settled by the source. Requiring the
  // literal code 'approved' hid this button on every imported purchase order.
  // Receiving and billing are other people's jobs (warehouse, accounting): either right on the PO,
  // or the document's own Add right (Receiving Reports / Vendor Bills), opens them. PO Edit alone
  // hid Bill from accounting staff granted Vendor Bills but not Purchase Orders.
  // NOT gated on this PO's period (asked 2026-11-07): a Receiving Report or Vendor Bill is a document
  // of its own, dated the day it is made, so a PO from a closed month can still be received and
  // billed today. The server checks the period against the RR's / bill's own date, never the PO's.
  const poEditRight = can('/purchase-orders', 'can_edit');
  const canReceive = poEditRight || can('/receiving-reports', 'can_add');
  const canBill = poEditRight || can('/vendor-bills', 'can_add');
  // A Landed Cost PO (PO2) is received too, as in the source (922 of its receipts imported): that is
  // what makes it billable. Its charges land no stock (server: isNonStockItem).
  const showReceive = canReceive && isApprovedPo(po.status)
    && !isSettledPo(po.status) && po.receipt_status !== 'fully_received';
  const showVendorReturn = canEdit && po.type !== 'PO2' && po.receipt_status !== 'not_received';
  // "Bill" only makes sense once at least one line has been received but not yet
  // (fully) billed -- mirrors the Create Vendor Bill form's own eligibility filter.
  const hasBillableLine = canBill && po.lines.some((l) => Number(l.received_qty || 0) > Number(l.billed_qty || 0));
  // JO # on any PO type with a line bought for a job order (its own, or its PR line's) -- PO-3 always.
  const showJo = po.type === 'PO3' || po.lines.some((l) => l.job_order_no);

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={'/purchase-orders'}>Back</Link>
          {showEdit && <Link className="btn btn-sm" to={`/purchase-orders/${id}/edit`}>Edit</Link>}
          {/* A PO1 waits for its Landed Cost POs to be received first (server enforces it too). */}
          {showReceive && (po.open_landed_costs || []).length > 0 && (
            <button className="btn btn-sm btn-primary" disabled
              title={`Receive its Landed Cost PO${po.open_landed_costs.length > 1 ? 's' : ''} first: ${po.open_landed_costs.join(', ')}`}>Receive</button>
          )}
          {showReceive && !(po.open_landed_costs || []).length && <Link className="btn btn-sm btn-primary" to={`/purchase-orders/${id}/receive`}>Receive</Link>}
          {hasBillableLine && <button className="btn btn-sm btn-primary" onClick={() => setShowBillModal(true)}>Bill</button>}
          {showVendorReturn && <Link className="btn btn-sm" to={`/purchase-orders/${id}/return`}>Vendor Return</Link>}
          {showApprove && <button className="btn btn-sm btn-primary" disabled={busy} onClick={handleApprove}>Approve</button>}
          {showPrint && <button className="btn btn-sm" onClick={() => window.open(`/purchase-orders/${id}/print`, '_blank')}>Print</button>}
          {/* Same gate as Print: emailing it is delivering the printout. */}
          {showPrint && <button className="btn btn-sm btn-primary" onClick={openEmail}>Send Email</button>}
          {canEdit && canCancel && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleCancel}>Cancel</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {periodLocked && (
        <div className="warning-banner" style={{ marginBottom: 12 }}>
          The accounting period for this transaction is closed ({periodLocked}), so it can no longer be edited, voided or cancelled.
          It can still be received and billed: the Receiving Report and Vendor Bill are dated the day they are made.
        </div>
      )}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Purchase Order</h1>
          <span className="estimate-no">{po.po_no}</span>
        </div>
        <div className="estimate-status">
          {statusLabel(po)}
          {RECEIPT_STATUS_LABELS[po.receipt_status] && <span style={{ opacity: 0.7 }}> · {RECEIPT_STATUS_LABELS[po.receipt_status]}</span>}
        </div>

        <div className="estimate-detail-grid">
          <div>
            <div>Supplier : <span className="hi"><SupplierLink id={po.supplier_id} name={po.supplier_name} /></span></div>
            <div>Date Created : <span className="hi">{formatDate(po.date_created)}</span></div>
            {po.need_by_date && <div>Need by Date : <span className="hi">{formatDate(po.need_by_date)}</span></div>}
            <div>Term : <span className="hi">{po.term_name || '—'}</span></div>
          </div>
          <div>
            <div>Memo : <span className="hi">{po.memo || ''}</span></div>
            {po.type === 'PO2' && po.parent_po_no && (
              <div>Landed Cost of : <Link className="link-btn" to={`/purchase-orders/${po.parent_po_id}`}>{po.parent_po_no}</Link></div>
            )}
          </div>
          <div>
            <div>Created By : <span className="hi">{po.created_by_name || '—'}</span></div>
            <div>Type : <span className="hi">{po.type}</span></div>
          </div>
        </div>
      </div>

      <div className="estimate-footer card" style={{ marginTop: 20 }}>
        <div><span className="muted">Subtotal</span><div className="hi-lg">{money(po.subtotal)}</div></div>
        <div><span className="muted">Discount</span><div className="hi-lg">{money(po.discount_amount)}</div></div>
        <div><span className="muted">Net of Tax</span><div className="hi-lg">{money(po.net_of_tax)}</div></div>
        <div><span className="muted">Tax</span><div className="hi-lg">{money(po.tax_amount)}</div></div>
        <div><span className="muted">Total Amount</span><div className="hi-lg">{money(po.total_amount)}</div></div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>Items</button>
        {/* Any approved status, in either vocabulary -- an imported 'Approved by General Manager' PO
            (PO-20583) had no Landed Cost tab because only the app's own 'approved' was checked. */}
        {po.type !== 'PO2' && isApprovedPo(po.status) && (
          <button className={`status-tab ${tab === 'landed' ? 'active' : ''}`} onClick={() => setTab('landed')}>Landed Cost</button>
        )}
        <button className={`status-tab ${tab === 'related' ? 'active' : ''}`} onClick={() => setTab('related')}>Related Records</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'items' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th />
                  <th>Item</th>
                  <th>Purchase Desc.</th>
                  {po.type === 'PO1' && <th>PR #</th>}
                  {/* The PR line's own quantity beside it (2026-10-21), to compare with what the PO buys. */}
                  {po.type === 'PO1' && <th>PR Qty</th>}
                  {/* Every PO type carries these now, Landed Cost included -- it used to be
                      the one type that could not say which warehouse or cost centre a
                      freight charge belonged to. */}
                  <th>Location</th><th>Department</th>
                  {showJo && <th>JO #</th>}
                  <th>Qty</th><th>Unit</th><th>Rate</th><th>Disc %</th><th>Disc Amt</th>
                  <th>Net of Tax</th><th>Tax Code</th><th>Tax Amt</th><th>Ext. Price</th><th>Received</th>
                </tr>
              </thead>
              <tbody>
                {po.lines.map((l, idx) => (
                  <tr key={l.id}>
                    <td>
                      {l.item_id && (
                        <button type="button" className="btn btn-sm" onClick={() => openCompare(l)}>Compare</button>
                      )}
                    </td>
                    <td>
                      <span style={{ color: '#db2777', fontWeight: 600, marginRight: 8 }}>{idx + 1}</span>
                      <Link className="link-btn" to={`/inventory/${l.item_id}`}>
                        {l.item_code} {l.item_name ? `— ${l.item_name}` : ''}
                      </Link>
                    </td>
                    <td>
                      {/* Read-only here (asked 2026-11-04): the view is not an edit form. Changed on the
                          Edit page, like the rest of the line. */}
                      {l.purchase_description || '—'}
                    </td>
                    {po.type === 'PO1' && <td>{l.pr_no || '—'}</td>}
                    {po.type === 'PO1' && <td>{l.pr_qty != null ? Number(l.pr_qty).toFixed(4) : '—'}</td>}
                    <td>{l.location_name || '—'}</td>
                    <td>{l.department_name || '—'}</td>
                    {showJo && <td>{l.job_order_no ? <Link className="link-btn" to={`/job-orders/${l.line_job_order_id}`}>{l.job_order_no}</Link> : '—'}</td>}
                    <td>{qty(l.qty)}</td>
                    {/* The unit of the Qty beside it, which is the PURCHASE unit -- receiving
                        multiplies this quantity by the item's conversion factor. Showing
                        unit_title here labelled 1 ROLL of tarpaulin as "Square Foot", the unit it
                        becomes once received rather than the one it was ordered in. Falls back to
                        unit_title for rows saved before purchase_unit was recorded properly. */}
                    <td>{l.purchase_unit || l.unit_title}</td>
                    <td>{rate6(l.rate)}</td>
                    <td>{discountLabel(l)}</td>
                    {/* The peso amount the discount takes off this line (asked 2026-10-08). */}
                    <td>{money(l.disc_amount)}</td>
                    <td>{money(l.net_of_tax)}</td>
                    <td>{l.tax_code}</td>
                    <td>{money(l.tax_amount)}</td>
                    <td>{money(l.ext_price)}</td>
                    <td>{qty(l.received_qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'landed' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>PO #</th><th>Date</th><th>Vendor</th><th>Term</th><th>Amount</th><th>Memo</th><th>Status</th></tr>
              </thead>
              <tbody>
                {landedCosts.length === 0 && (
                  <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No Landed Cost yet.</td></tr>
                )}
                {landedCosts.map((lc) => (
                  <tr key={lc.id}>
                    <td><Link className="link-btn" to={`/purchase-orders/${lc.id}`}>{lc.po_no}</Link></td>
                    <td>{formatDate(lc.date_created)}</td>
                    <td><SupplierLink id={lc.supplier_id} name={lc.supplier_name} /></td>
                    <td>{lc.term_name || '—'}</td>
                    <td>{money(lc.total_amount)}</td>
                    <td>{lc.memo || ''}</td>
                    <td>{STATUS_LABELS[lc.status] || lc.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 12 }}>
            <Link className="btn btn-primary" to={`/purchase-orders/${id}/landed-cost/new`}>Create PO</Link>
          </div>
        </div>
      )}

      {tab === 'related' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Type</th><th>Reference</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {po.type === 'PO2' && po.parent_po_no && (
                  <tr>
                    <td>Purchase Order</td>
                    <td><Link className="link-btn" to={`/purchase-orders/${po.parent_po_id}`}>{po.parent_po_no}</Link></td>
                    <td>—</td>
                    <td>—</td>
                    <td>Parent</td>
                  </tr>
                )}
                {receipts.map((r) => (
                  <tr key={`rr-${r.id}`}>
                    <td>Receiving Report</td>
                    <td><Link className="link-btn" to={`/purchase-orders/receipts/${r.id}`}>{r.receipt_no}</Link></td>
                    <td>{formatDate(r.date_created)}</td>
                    <td>{money(r.total_amount)}</td>
                    <td>{r.is_on_hold ? 'On Hold' : 'Open'}</td>
                  </tr>
                ))}
                {returns.map((r) => (
                  <tr key={`vr-${r.id}`}>
                    <td>Vendor Return</td>
                    <td><Link className="link-btn" to={`/purchase-orders/returns/${r.id}`}>{r.return_no}</Link></td>
                    <td>{formatDate(r.date_created)}</td>
                    <td>{money(r.total_amount)}</td>
                    <td>—</td>
                  </tr>
                ))}
                {bills.map((b) => (
                  <tr key={`vb-${b.id}`}>
                    <td>Vendor Bill</td>
                    <td><Link className="link-btn" to={`/vendor-bills/${b.id}`}>{b.bill_no}</Link></td>
                    <td>{formatDate(b.date_created)}</td>
                    <td>{money(b.gross_amount)}</td>
                    <td>{b.status === 'cancelled' ? 'Cancelled' : 'Open'}</td>
                  </tr>
                ))}
                {receipts.length === 0 && returns.length === 0 && bills.length === 0 && !(po.type === 'PO2' && po.parent_po_no) && (
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

      {showBillModal && (
        <VendorBillModal
          purchaseOrderId={id}
          onClose={() => setShowBillModal(false)}
          onSaved={(vb) => { setShowBillModal(false); navigate(`/vendor-bills/${vb.id}`); }}
        />
      )}

      {compareLine && (
        <Modal
          title="Supplier Prices"
          large
          onClose={() => { setCompareLine(null); setCompareData(null); setCompareError(''); }}
        >
          <div className="estimate-detail-grid" style={{ marginBottom: 16 }}>
            <div>
              <div>Item : <span className="hi">{compareLine.item_code}{compareLine.item_name ? ` — ${compareLine.item_name}` : ''}</span></div>
              <div>Rate on this PO : <span className="hi">{rate6(compareLine.rate)}</span> {compareLine.purchase_unit || compareLine.unit_title || ''}</div>
            </div>
            <div>
              <div>Supplier : <span className="hi"><SupplierLink id={po.supplier_id} name={po.supplier_name} /></span></div>
              <div>Qty : <span className="hi">{qty(compareLine.qty)}</span></div>
            </div>
          </div>

          {compareError && <div className="error-banner">{compareError}</div>}
          {!compareData && !compareError && <LoadingSpinner />}

          {compareData && (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Supplier</th><th>Rate</th><th>vs this PO</th><th>Unit</th>
                      <th>Last Purchase Date</th><th>Ref #</th>
                    </tr>
                  </thead>
                  <tbody>
                    {compareData.suppliers.length === 0 && (
                      <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                        Nothing on record — this item has not been bought before.
                      </td></tr>
                    )}
                    {compareData.suppliers.map((sp) => {
                      const poRate = Number(compareLine.rate) || 0;
                      const rate = Number(sp.rate);
                      // Only a meaningful comparison when both sides are real numbers.
                      const diff = poRate > 0 && Number.isFinite(rate) ? ((rate - poRate) / poRate) * 100 : null;
                      const isThisSupplier = sp.supplier_id === po.supplier_id;
                      return (
                        <tr key={`${sp.source}-${sp.supplier_id}`} style={isThisSupplier ? { fontWeight: 600 } : undefined}>
                          <td>
                            <SupplierLink id={sp.supplier_id} name={sp.supplier_name} />
                            {isThisSupplier && <span className="muted"> · this PO’s supplier</span>}
                          </td>
                          <td>{rate6(sp.rate)}</td>
                          <td style={{ color: diff === null || Math.abs(diff) < 0.005 ? undefined : diff < 0 ? '#16a34a' : '#dc2626' }}>
                            {diff === null ? '—' : Math.abs(diff) < 0.005 ? 'same' : `${diff > 0 ? '+' : ''}${diff.toFixed(1)}%`}
                          </td>
                          <td>{sp.unit || '—'}</td>
                          <td>{formatDate(sp.last_purchase_date)}</td>
                          <td>
                            {sp.doc_type === 'RR' && (
                              <Link className="link-btn" to={`/purchase-orders/receipts/${sp.doc_id}`}>{sp.ref_no}</Link>
                            )}
                            {sp.doc_type === 'PO' && (
                              <Link className="link-btn" to={`/purchase-orders/${sp.doc_id}`}>{sp.ref_no}</Link>
                            )}
                            {/* Price-list rows name a document this install may not hold, so no link. */}
                            {!sp.doc_type && <span>{sp.ref_no || '—'} <span className="muted">· price list</span></span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <h3 style={{ marginTop: 20, marginBottom: 8 }}>Purchase History</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                {compareData.history.length >= compareData.history_limit
                  ? `The ${compareData.history_limit} most recent purchases of this item`
                  : 'Every purchase of this item'}, newest first — priced off the Receiving Report
                where it has been received, off the Purchase Order where it has not. This order is
                not listed. The table above reads the whole history, not just this page of it.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Date</th><th>Document</th><th>Supplier</th><th>Qty</th><th>Unit</th><th>Rate</th><th>Disc %</th></tr>
                  </thead>
                  <tbody>
                    {compareData.history.length === 0 && (
                      <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                        No purchase documents for this item yet.
                      </td></tr>
                    )}
                    {/* Keyed on the LINE, not the document: a Receiving Report can hold the same
                        item on more than one line, and two rows sharing a key is a React bug. */}
                    {compareData.history.map((h) => (
                      <tr key={`${h.doc_type}-${h.line_id}`}>
                        <td>{formatDate(h.doc_date)}</td>
                        <td>
                          <Link className="link-btn"
                            to={h.doc_type === 'RR' ? `/purchase-orders/receipts/${h.doc_id}` : `/purchase-orders/${h.doc_id}`}
                          >
                            {h.doc_no}
                          </Link>
                          {h.doc_type === 'RR' && h.po_no && <span className="muted"> · {h.po_no}</span>}
                        </td>
                        <td><SupplierLink id={h.supplier_id} name={h.supplier_name} /></td>
                        <td>{qty(h.qty)}</td>
                        <td>{h.unit || '—'}</td>
                        <td>{rate6(h.rate)}</td>
                        <td>{h.disc_percent}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Modal>
      )}

      {emailOpen && (
        <Modal title="Send Purchase Order to Supplier" onClose={() => !emailBusy && setEmailOpen(false)}>
          {emailResult ? (
            <>
              <p>Sent to <strong>{emailResult.sentTo}</strong>.</p>
              <p className="muted">
                The Purchase Order went with it as <strong>{emailResult.attachedPdf}</strong>.
                Replies come back to you, not to the system mailbox.
              </p>
              <div className="modal-actions">
                <button type="button" className="btn btn-primary" onClick={() => setEmailOpen(false)}>Close</button>
              </div>
            </>
          ) : (
            <>
              {emailInfo && !emailInfo.mailConfigured && (
                <div className="error-banner">
                  This server cannot send email — {emailInfo.mailProblem}. Ask whoever administers it
                  to set that up; nothing here will work until they do.
                </div>
              )}

              {emailInfo?.sentAt && (
                <div className="muted" style={{ marginBottom: 12 }}>
                  Already sent to <strong>{emailInfo.sentTo}</strong> on{' '}
                  {displayDateTime(emailInfo.sentAt)}
                  {emailInfo.sentByName ? ` by ${emailInfo.sentByName}` : ''}. Sending again will
                  deliver another copy.
                </div>
              )}

              <div className="field">
                <label>
                  Send to{' '}
                  {emailInfo?.source && <span className="muted">(from {emailInfo.source})</span>}
                </label>
                <input
                  autoFocus type="email" value={emailTo} placeholder="supplier@example.com"
                  onChange={(event) => setEmailTo(event.target.value)}
                />
                {emailInfo && !emailInfo.suggested && (
                  <div className="muted" style={{ marginTop: 4 }}>
                    No address on file for {emailInfo.supplierName || 'this supplier'} — type one to send it.
                  </div>
                )}
              </div>

              <div className="field">
                <label>Message <span className="muted">(optional)</span></label>
                <textarea
                  rows={3} value={emailNote}
                  placeholder="Anything you want to say alongside the Purchase Order."
                  onChange={(event) => setEmailNote(event.target.value)}
                />
              </div>

              <p className="muted">
                The supplier gets the Purchase Order — the same document the Print button produces —
                attached as a PDF.
              </p>

              {emailError && <div className="error-banner">{emailError}</div>}

              <div className="modal-actions">
                <button type="button" className="btn" disabled={emailBusy} onClick={() => setEmailOpen(false)}>Cancel</button>
                <button
                  type="button" className="btn btn-primary"
                  disabled={emailBusy || !emailTo.trim() || (emailInfo && !emailInfo.mailConfigured)}
                  onClick={sendEmail}
                >
                  {emailBusy ? 'Sending…' : 'Send'}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
