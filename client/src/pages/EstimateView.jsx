import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { usePeriodLocked } from '../utils/periodLock';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import GpComputations from '../components/GpComputations';
import EstimateApprovalModal from '../components/EstimateApprovalModal';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';

import { displayDateTime, displayAuditTime } from '../utils/dates';
import { CustomerLink } from '../components/PartyLink';
import ButtonMenu from '../components/ButtonMenu';
import { isPrintSelected } from '../utils/estimatePrintSelected';
import { downloadFile } from '../utils/downloadFile';

// Read-only counterpart to EstimateWizard (which stays the create/edit form): mirrors
// the real system's estimate detail screen -- a summary banner with status-driven
// actions, then the full Job Order / Process breakdown and totals, all display-only.
const STATUS_LABELS = {
  pending_supervisor_approval: 'Pending Supervisor Approval',
  pending_customer_approval: 'Pending Customer Approval',
  approved: 'Approved',
  cancelled: 'Cancelled',
  disapproved: 'Disapproved',
};

const JOB_VIEW_COLUMNS = [
  { key: 'job_type_name', label: 'Job Type' },
  { key: 'nstdjo_no', label: 'NSTDJO#' },
  { key: 'job_location_name', label: 'Job Location' },
  { key: 'description', label: 'Description' },
  { key: 'quantity', label: 'Qty' },
  { key: 'units', label: 'Units' },
  { key: 'price_per_unit', label: 'Price/Unit' },
  // Shown before Subtotal because that is where it acts: the processes come to a base, the
  // contingency is added, and Subtotal is the result. Blank where none was allowed for.
  { key: 'contingency_percent', label: 'Contingency %' },
  { key: 'contingency_amount', label: 'Contingency Amt' },
  { key: 'subtotal', label: 'Subtotal' },
  { key: 'disc_percent', label: 'Disc %' },
  // Per piece, as typed on the estimate (the line's whole discount / Qty).
  { key: 'disc_amount', label: 'Disc Amt', render: (jo) => (Number(jo.quantity) ? Number((Number(jo.disc_amount || 0) / Number(jo.quantity)).toFixed(4)) : jo.disc_amount) },
  { key: 'disc_price_per_unit', label: 'Disc Price/Unit' },
  { key: 'net_of_tax', label: 'Net of Tax' },
  { key: 'tax_code', label: 'Tax Code' },
  { key: 'tax_amount', label: 'Tax Amt' },
  { key: 'gross_amount', label: 'Gross Amt' },
  { key: 'length', label: 'Length' },
  { key: 'width', label: 'Width' },
  { key: 'height', label: 'Height' },
  { key: 'uom', label: 'UOM' },
  { key: 'shipping', label: 'Shipping' },
  { key: 'remarks', label: 'Remarks' },
  { key: 'memo', label: 'Memo' },
  { key: 'delivery_date', label: 'Delivery Date', render: (r) => (r.delivery_date ? String(r.delivery_date).slice(0, 10) : '') },
  { key: 'delivery_time', label: 'Delivery Time' },
  { key: 'gp_rate', label: 'GP Rate', render: (r) => (r.gp_rate != null ? `${r.gp_rate}%` : '') },
];

const PROCESS_VIEW_COLUMNS = [
  { key: 'process_name', label: 'Process' },
  { key: 'process_qty', label: 'Process Qty' },
  { key: 'process_uom', label: 'Process UOM' },
  { key: 'item_name', label: 'Item' },
  { key: 'location_name', label: 'Process Location' },
  { key: 'length', label: 'Length' },
  { key: 'width', label: 'Width' },
  { key: 'uom', label: 'UOM' },
  { key: 'qty', label: 'Qty' },
  { key: 'total', label: 'Total' },
  { key: 'unit', label: 'Unit' },
  { key: 'process_price', label: 'Process Price' },
  { key: 'process_disc_percent', label: 'Process Disc %' },
  { key: 'process_disc_amount', label: 'Process Disc Amt' },
  { key: 'disc_process_price', label: 'Disc Process Price' },
  { key: 'material_price', label: 'Material Price' },
  { key: 'material_disc_percent', label: 'Material Disc %' },
  { key: 'material_disc_amount', label: 'Material Disc Amt' },
  { key: 'disc_material_price', label: 'Disc Material Price' },
  { key: 'net_of_tax', label: 'Net of Tax' },
  { key: 'tax_amount', label: 'Tax Amt' },
  { key: 'gross_amount', label: 'Gross Amt' },
  { key: 'remarks', label: 'Remarks' },
  { key: 'memo', label: 'Memo' },
  { key: 'gp_rate', label: 'GP Rate', render: (r) => (r.gp_rate != null ? `${r.gp_rate}%` : '') },
  { key: 'process_cost', label: 'Process Cost' },
  { key: 'material_cost', label: 'Material Cost' },
  { key: 'total_cost', label: 'Total Cost' },
  { key: 'total_price', label: 'Total Price' },
];

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

function num(v) { return v === null || v === undefined || v === '' ? 0 : Number(v); }

export default function EstimateView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, user } = useAuth();

  const [estimate, setEstimate] = useState(null);
  const [auditLogs, setAuditLogs] = useState([]);
  const [tab, setTab] = useState('job');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [showApproval, setShowApproval] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailInfo, setEmailInfo] = useState(null);
  const [emailTo, setEmailTo] = useState('');
  const [emailNote, setEmailNote] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [emailResult, setEmailResult] = useState(null);

  async function load() {
    setLoading(true);
    const { data } = await api.get(`/estimates/${id}`);
    setEstimate(data);
    setLoading(false);
  }

  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    if (tab === 'system') {
      api.get(`/estimates/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
    }
  }, [tab, id]);

  async function setStatus(newStatus) {
    setBusy(true);
    try {
      await api.put(`/estimates/${id}/status`, { status: newStatus });
      await load();
    } finally {
      setBusy(false);
    }
  }

  // Approving opens the GP-review modal (below-GP lines can be overridden by an Admin/GM there),
  // which posts the status change itself with any low-GP approvals.
  const nextStatus = estimate?.status === 'pending_supervisor_approval' ? 'pending_customer_approval'
    : (estimate?.status === 'pending_customer_approval' ? 'approved' : null);
  function handleApprove() { if (nextStatus) setShowApproval(true); }

  // Opened rather than sent outright. The address is usually not on the estimate, and even
  // when it is, letting somebody see where a message to a customer is about to go before it
  // goes is worth one extra click.
  async function openEmail() {
    setEmailError('');
    setEmailResult(null);
    setEmailOpen(true);
    try {
      const { data } = await api.get(`/estimates/${id}/email-recipient`);
      setEmailInfo(data);
      setEmailTo(data.suggested || '');
    } catch (err) {
      setEmailInfo(null);
      // The server's own words, not a generic stand-in. Swallowing them meant a missing database
      // column surfaced as "could not work out where to send this", which points at the address
      // rather than at the schema and sends whoever reads it looking in the wrong place.
      setEmailError(err.response?.data?.error
        || `Could not work out where to send this (server returned ${err.response?.status || 'no response'}).`);
    }
  }

  async function sendEmail() {
    setEmailBusy(true);
    setEmailError('');
    try {
      const { data } = await api.post(`/estimates/${id}/email`, { email: emailTo.trim(), note: emailNote.trim() });
      setEmailResult(data);
      await load();
    } catch (err) {
      setEmailError(err.response?.data?.error || 'Could not send it.');
    } finally {
      setEmailBusy(false);
    }
  }

  // A source line with no processes is copied empty -- said plainly, so the copy is not sent on
  // with 0.00 cost and 100% GP (EST-210521, 2026-10-14).
  function warnNoProcesses(data) {
    const lines = data?.lines_without_processes || [];
    if (lines.length) {
      alert(`${estimate.estimate_no} has no processes on line ${lines.join(', ')}, so ${data.estimate_no || 'the copy'} has none there either. Add them before sending it for approval.`);
    }
  }

  async function handleReplicate() {
    if (!confirm('Replicate this estimate into a new draft?')) return;
    setBusy(true);
    try {
      const { data } = await api.post(`/estimates/${id}/replicate`);
      warnNoProcesses(data);
      navigate(`/estimates/${data.id}`);
    } finally {
      setBusy(false);
    }
  }

  // Cancel & Replicate: this estimate is cancelled and a new one made from it, as the person doing
  // it -- Sales Rep, Office Location and Sales Division become theirs. One server call, one
  // transaction: never one half without the other.
  async function handleCancelAndReplicate() {
    if (!confirm(`Cancel ${estimate.estimate_no} and replicate it into a new estimate?

${estimate.estimate_no} will be CANCELLED. The new estimate will have you as its Sales Rep.`)) return;
    setBusy(true);
    try {
      const { data } = await api.post(`/estimates/${id}/cancel-and-replicate`);
      warnNoProcesses(data);
      navigate(`/estimates/${data.id}`);
    } catch (err) {
      alert(err.response?.data?.error || 'Could not cancel and replicate this estimate.');
    } finally {
      setBusy(false);
    }
  }

  // Closed accounting period: no Edit / Void / Cancel (utils/periodLock.js; the server refuses them too).
  const periodLocked = usePeriodLocked(estimate?.date_created, 'non_gl');

  if (loading || !estimate) return <LoadingSpinner />;

  const jobOrders = estimate.jobOrders || [];
  // The Print Selected tick, saved the moment it is clicked (and put back if the save fails).
  const canTickPrint = can('/estimates', 'can_edit') || can('/estimates', 'can_print') || user?.account_type === 'System Admin';
  const setPrintSelected = (jo, p, selected) => {
    const apply = (val) => setEstimate((e) => ({
      ...e,
      jobOrders: e.jobOrders.map((j) => (j.id !== jo.id ? j : { ...j, processes: j.processes.map((x) => (x.id === p.id ? { ...x, print_selected: val } : x)) })),
    }));
    apply(selected ? 1 : 0);
    api.put(`/estimates/${id}/job-orders/${jo.id}/processes/${p.id}/print-selected`, { selected })
      .catch((e) => { apply(p.print_selected ?? null); alert(e.response?.data?.error || 'Could not save the Print Selected tick.'); });
  };
  // Computed from the lines whenever there ARE lines -- they are the truth, and the header
  // aggregates are only written when someone clicks "Recalculate from Job Orders" in the Billing
  // step, so they go stale.
  //
  // But 68,281 estimates here are migrated history that arrived as a header and nothing else: no
  // job order lines at all. Reducing over an empty array gives 0, so every one of those showed
  // "Total Amount 0.00" on this screen while the Saved Estimates list showed the real figure off
  // the header. With no lines to compute from, the stored header is the only record there is, so
  // it is used instead of inventing a zero. Same fallback the list makes.
  const hasLines = jobOrders.length > 0;
  const subtotal = hasLines ? jobOrders.reduce((s, jo) => s + num(jo.subtotal), 0) : num(estimate.subtotal);
  const discountTotal = hasLines
    ? jobOrders.reduce((s, jo) => s + num(jo.disc_amount), 0) : num(estimate.discount_total);
  const netOfTax = hasLines ? subtotal - discountTotal : num(estimate.net_of_tax);
  const taxTotal = hasLines ? jobOrders.reduce((s, jo) => s + num(jo.tax_amount), 0) : num(estimate.tax_total);
  const totalAmount = hasLines ? netOfTax + taxTotal : num(estimate.total_amount);
  // Overall GP is the SUM of the lines' own GP -- the figures each line is judged on -- as the
  // Sales Order screen totals it. It used to be Net of Tax less every process's Total Cost, which
  // on a migrated estimate (or a replica of one) disagrees with its lines: those process cost
  // fields hold the source's rates, not costs (EST-203231: every line 62-74%, "overall" 48%).
  // A line with no stored GP counts as its Net of Tax less its processes' cost.
  const lineCost = (jo) => (jo.processes || []).reduce((ps, p) => ps + num(p.total_cost), 0);
  const lineGp = (jo) => (jo.gp_amount != null && jo.gp_amount !== ''
    ? num(jo.gp_amount) : num(jo.subtotal) - num(jo.disc_amount) - lineCost(jo));
  // Same fallback, and it matters more here: with no lines there are no processes either, so the
  // margin would read as a flat 100% -- a confident, entirely invented number. The stored figures
  // are used instead.
  const gpAmount = hasLines ? jobOrders.reduce((s, jo) => s + lineGp(jo), 0) : num(estimate.est_gp_amount);
  // Shown beside it, and kept consistent with it: what the lines' GP leaves of their Net of Tax.
  const totalCost = hasLines ? netOfTax - gpAmount : 0;
  const gpRate = hasLines
    ? (netOfTax ? (gpAmount / netOfTax) * 100 : 0)
    : num(estimate.est_gp_rate);

  const isPending = estimate.status === 'pending_supervisor_approval' || estimate.status === 'pending_customer_approval';
  // Once a SUPERVISOR has signed the estimate off, the figures on it have been agreed and
  // anyone changing them afterwards is changing something somebody else approved. From that
  // point Edit belongs to a System Admin alone.
  //
  // Both statuses past the supervisor count: approval moves the estimate from
  // pending_supervisor_approval to pending_customer_approval and later to approved, so
  // checking only for 'approved' would leave it editable through the whole customer stage --
  // exactly the window where the quoted price is out with the customer.
  const supervisorApproved = ['pending_customer_approval', 'approved'].includes(estimate.status);
  const isSystemAdmin = user?.account_type === 'System Admin';
  // Gates the workflow buttons below. Unchanged: disapproving or cancelling is not rewriting.
  const canEdit = (can('/estimates', 'can_edit') && !periodLocked) && (!supervisorApproved || isSystemAdmin);
  // Gates the Edit button itself, which is stricter: the content is only open while the
  // estimate is Pending Supervisor Approval. Disapproved and cancelled estimates are closed
  // too, and every status but that one belongs to a System Admin. Mirrors
  // requireEditableEstimate on the server.
  const canEditContent = (can('/estimates', 'can_edit') && !periodLocked)
    && (estimate.status === 'pending_supervisor_approval' || isSystemAdmin);
  const canAdd = can('/estimates', 'can_add');
  // Approving out of "pending supervisor approval" specifically requires the Can
  // Approve Sales Estimate flag from the user's Account Type settings (Step 4 of the
  // user wizard) -- without it the Approve button doesn't even show at that stage.
  // Once it's moved to pending_customer_approval, any editor can advance it further.
  // The supervisor of the estimate's sales rep (GET /:id is_rep_supervisor, from Users >
  // Supervisors) approves their team's estimates and records the customer's answer on them,
  // without the account-wide flag or Edit on Estimates -- the server checks the same thing.
  const isRepSupervisor = !!estimate.is_rep_supervisor;
  const supervisorCanAct = isRepSupervisor
    && ['pending_supervisor_approval', 'pending_customer_approval'].includes(estimate.status);
  const canShowApprove = estimate.status === 'pending_supervisor_approval'
    ? (!!user?.can_approve_sales_estimate || isRepSupervisor)
    : true;
  // Reaching the customer stage takes Edit away from everyone but a System Admin, yet somebody
  // still has to record what the customer said -- and recording an answer advances the estimate
  // rather than rewriting it, which is what can_update is for.
  //
  // WHOSE ANSWER IT IS TO RECORD, two ways. The author, who raised it (created_by_user_id comes
  // off the audit trail, via GET /:id). Or anyone outside Head Office: the branches cover the
  // same counter, so the rep who is in when the customer rings back is rarely the rep who typed
  // the estimate. is_head_office is resolved server-side from the user's default login location
  // (lib/userLocation.js) and compared against false explicitly, so an account whose location has
  // not loaded reads as Head Office -- the stricter side -- rather than as a branch.
  //
  // A branch account only ever SEES branch transactions (lib/salesVisibility.js), which is what
  // keeps this off Head Office's own work without asking a second question here.
  //
  // Mirrors mayActAsOwner + requireStatusChange on the server, which accept exactly these two
  // moves out of this one stage. Edit stays where it was: changing agreed figures is not a
  // workflow step, and past supervisor approval it belongs to a System Admin alone.
  const isCreator = estimate.created_by_user_id != null && Number(estimate.created_by_user_id) === Number(user?.id);
  // Or the estimate's own sales rep -- an estimate migrated from the source has no recorded
  // creator, so without this its rep lost these buttons (EST-109619).
  const isRep = !!user?.employee_id && estimate.sales_rep_id != null && Number(estimate.sales_rep_id) === Number(user.employee_id);
  const mayActAsOwner = isCreator || isRep || user?.is_head_office === false;
  const canRecordCustomerAnswer = estimate.status === 'pending_customer_approval'
    && ((mayActAsOwner && can('/estimates', 'can_update')) || isRepSupervisor);
  // The real system only shows Print once an estimate has cleared supervisor
  // approval -- printing a still-pending quotation isn't meaningful yet.
  const canShowPrint = estimate.status === 'pending_customer_approval' || estimate.status === 'approved';
  // The button says whose approval it is recording. Out of supervisor approval it is the
  // supervisor's own decision, so plain "Approve"; out of pending customer approval the person
  // clicking is entering what the CUSTOMER has said, which is a different act -- and the one place
  // where "Approve" could be read as the operator approving it themselves.
  const approveLabel = estimate.status === 'pending_customer_approval' ? 'Approved by Customer' : 'Approve';

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={'/estimates'}>Back</Link>
          <button type="button" className="btn btn-sm" disabled={extracting} onClick={async () => {
            setExtracting(true);
            try { await downloadFile(`/estimates/${id}/extract`, {}, `${estimate.estimate_no || 'estimate'}.xlsx`); }
            catch { alert('Extract failed. Please try again.'); }
            finally { setExtracting(false); }
          }}>{extracting ? 'Extracting...' : 'Extract'}</button>
          {canEditContent && <Link className="btn btn-sm btn-primary" to={`/estimates/${id}/edit`}>Edit</Link>}
          {/* Three quotations, as the source's Print menu: the plain one, and the two listing each job's
              Print Selected items -- with the discount hidden (net prices) or shown. */}
          {canShowPrint && (
            <ButtonMenu
              label="Print"
              options={[
                { label: 'Print', onClick: () => window.open(`/estimates/${id}/print`, '_blank') },
                { label: 'Print with Selected Items (Hide Discount)', onClick: () => window.open(`/estimates/${id}/print?items=1`, '_blank') },
                { label: 'Print with Selected Items (Show Discount)', onClick: () => window.open(`/estimates/${id}/print?items=1&discount=1`, '_blank') },
              ]}
            />
          )}
          {(canEdit || canRecordCustomerAnswer || supervisorCanAct) && isPending && canShowApprove && <button className="btn btn-sm btn-primary" disabled={busy} onClick={handleApprove}>{approveLabel}</button>}
          {/* The customer saying no is as much their answer as saying yes, so it opens to the same
              people -- at the customer stage only. canRecordCustomerAnswer is false at the
              supervisor stage, where this still asks for canEdit exactly as before. */}
          {(canEdit || canRecordCustomerAnswer || supervisorCanAct) && isPending && <button className="btn btn-sm btn-warning" disabled={busy} onClick={() => setStatus('disapproved')}>Disapprove</button>}
          {/* Only while the estimate is actually waiting on the customer -- sending one that is
              already approved or cancelled would confuse the person receiving it. */}
          {(canEdit || canRecordCustomerAnswer) && estimate.status === 'pending_customer_approval' && (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={openEmail}>
              {estimate.sent_to_customer_at ? 'Send Again' : 'Send to Email'}
            </button>
          )}
          {canAdd && <button className="btn btn-sm btn-primary" disabled={busy} onClick={handleReplicate}>Replicate</button>}
          {/* Not on a cancelled estimate (nothing left to cancel), nor one already turned into a Sales
              Order -- the server refuses both. Needs Edit as well as Add: it cancels. */}
          {canAdd && (can('/estimates', 'can_edit') && !periodLocked) && estimate.status !== 'cancelled' && !estimate.sales_order_id && (
            <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleCancelAndReplicate}>Cancel &amp; Replicate</button>
          )}
        </div>
      </div>

      {periodLocked && (
        <div className="warning-banner" style={{ marginBottom: 12 }}>
          The accounting period for this transaction is closed ({periodLocked}), so it can no longer be edited, voided or cancelled.
        </div>
      )}
      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Estimate</h1>
          <span className="estimate-no">{estimate.estimate_no}</span>
        </div>
        <div className="estimate-status">
          {STATUS_LABELS[estimate.status] || estimate.status}
          {estimate.sales_order_no && (
            <Link className="estimate-so-link" to={`/sales-orders/${estimate.sales_order_id}`}>
              {estimate.sales_order_no}
            </Link>
          )}
        </div>

        <div className="estimate-detail-grid">
          <div>
            <h4>Customer Details</h4>
            <div className="hi"><CustomerLink id={estimate.customer_id} name={estimate.customer_name} /></div>
            <div>Contact Name : <span className="hi">{estimate.contact_name}</span></div>
            <div>Contact Title : <span className="hi">{estimate.contact_title}</span></div>
            <div>Contact Email : <span className="hi">{estimate.contact_email}</span></div>
            <div>Contact Phone : <span className="hi">{estimate.contact_phone}</span></div>
            <div>Blanket PO : <span className="hi">{estimate.blanket_po_no}</span></div>
            <div>Blanket PO Memo : <span className="hi">{estimate.blanket_po_memo}</span></div>
          </div>
          <div>
            <h4>Estimate Details</h4>
            <div>Date Created : <span className="hi">{estimate.date_created ? String(estimate.date_created).slice(0, 10) : ''}</span></div>
            <div>Sales Division : <span className="hi">{estimate.sales_division_name}</span></div>
            <div>Office Location : <span className="hi">{estimate.office_location_name}</span></div>
            <div>Contract Desc. : <span className="hi">{estimate.contract_description}</span></div>
            <div>Memo : <span className="hi">{estimate.memo}</span></div>
            <div>Shipping Address : <span className="hi">{estimate.shipping_address}</span></div>
          </div>
          <div>
            <h4>Other Details</h4>
            <div>Sales Rep : <span className="hi">{estimate.sales_rep_name}</span></div>
            <div>Prepared By : <span className="hi">{estimate.prepared_by_name}</span></div>
            <div>Approved By : <span className="hi">{estimate.approved_by_name}</span></div>
            <div>Production Lead Time : <span className="hi">{estimate.production_lead_time}</span></div>
            <div>Price Validity : <span className="hi">{estimate.price_validity}</span></div>
            <div>Order Confirmation : <span className="hi">{estimate.order_confirmation_type}</span></div>
          </div>
          <div>
            <h4>Billing Details</h4>
            <div>Credit Term : <span className="hi">{estimate.credit_term}</span></div>
            <div>Credit Limit : <span className="hi">{estimate.credit_limit}</span></div>
            <div>Credit Balance : <span className="hi">{estimate.credit_balance}</span></div>
            <div>Bill to Contact Number : <span className="hi">{estimate.bill_to_contact_number}</span></div>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'job' ? 'active' : ''}`} onClick={() => setTab('job')}>Job</button>
        <button className={`status-tab ${tab === 'gp' ? 'active' : ''}`} onClick={() => setTab('gp')}>GP Computations</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'job' && (
        <div className="card">
          {jobOrders.length === 0 && <p className="muted">No job orders.</p>}
          {jobOrders.map((jo, idx) => (
            <div key={jo.id} className="jo-view-block">
              <div className="jo-view-index">#{idx + 1}</div>
              <div className="table-wrap">
                <table>
                  <thead><tr>{JOB_VIEW_COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
                  <tbody>
                    <tr>{JOB_VIEW_COLUMNS.map((c) => <td key={c.key}>{c.render ? c.render(jo) : jo[c.key]}</td>)}</tr>
                  </tbody>
                </table>
              </div>
              <div className="table-wrap" style={{ marginTop: 6 }}>
                <table>
                  <thead><tr><th>#</th>{PROCESS_VIEW_COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}<th>Print Selected</th></tr></thead>
                  <tbody>
                    {(jo.processes || []).map((p, pi) => (
                      <tr key={p.id}>
                        <td>{pi + 1}</td>
                        {PROCESS_VIEW_COLUMNS.map((c) => <td key={c.key}>{c.render ? c.render(p) : p[c.key]}</td>)}
                        <td style={{ textAlign: 'center' }}>
                          <input type="checkbox" style={{ width: 'auto' }} checked={isPrintSelected(p)} disabled={!canTickPrint}
                            title="List this line's item on Print with Selected Items" onChange={(e) => setPrintSelected(jo, p, e.target.checked)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* GP Computations -- laid out as the working: each line's Net of Tax, the cost taken off it,
          the GP that leaves and its rate against the job type's passing rate, then the same sums
          for the estimate, which is the footer's Est. GP Rate. Lines and footer use one basis
          (lineGp above), so the table always adds up to the footer.
          Cost basis: a line carries the GP it was saved with. Where that differs from what its
          process lines add up to -- a migrated estimate, or a replica of one, whose process cost
          fields are the old system's rates -- the saved GP is used and the process figure shown
          beside it, so the difference is visible rather than silently mixed in. */}
      {tab === 'gp' && (
        <GpComputations jobOrders={jobOrders} lineGp={lineGp} lineCost={lineCost} money={money} num={num} />
      )}

      {tab === 'system' && (
        <div className="card">
          <div className="field-row">
            <div className="field"><label>Created At</label><input readOnly value={estimate.created_at ? displayDateTime(estimate.created_at) : ''} /></div>
            <div className="field"><label>Last Updated</label><input readOnly value={estimate.updated_at ? displayDateTime(estimate.updated_at) : ''} /></div>
          </div>
          <h3 className="subsection">Audit Trail</h3>
          <DataTable
            columns={[
              { key: 'set_at', label: 'When', render: (r) => displayAuditTime(r.set_at) },
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

      <div className="estimate-footer card">
        <div><span className="muted">Est. GP Rate</span><div className="hi-lg">{gpRate.toFixed(2)}%</div></div>
        <div><span className="muted">Est. GP Amount</span><div className="hi-lg">{money(gpAmount)}</div></div>
        <div><span className="muted">Total Cost</span><div className="hi-lg">{money(totalCost)}</div></div>
        <div><span className="muted">Net of Tax</span><div className="hi-lg">{money(netOfTax)}</div></div>
        <div><span className="muted">Discount</span><div className="hi-lg">{money(discountTotal)}</div></div>
        <div><span className="muted">Tax</span><div className="hi-lg">{money(taxTotal)}</div></div>
        <div><span className="muted">Total Amount</span><div className="hi-lg">{money(totalAmount)}</div></div>
      </div>

      {emailOpen && (
        <Modal title="Send Estimate to Customer" onClose={() => !emailBusy && setEmailOpen(false)}>
          {emailResult ? (
            // Says where it went, not just that it went. "Sent" on its own invites the follow-up
            // question this whole feature exists to answer.
            <>
              <p>Sent to <strong>{emailResult.sentTo}</strong>.</p>
              <p className="muted">
                {emailResult.lines} job line{emailResult.lines === 1 ? '' : 's'} were included, with the
                estimate total{emailResult.attachedPdf ? ', and the price quotation went with it as ' : '. '}
                {emailResult.attachedPdf && <strong>{emailResult.attachedPdf}</strong>}
                {emailResult.attachedPdf ? '. ' : ''}
                Replies come back to you, not to the system mailbox.
              </p>
              {/* The message has gone either way -- this says what the customer did NOT get, so
                  nobody assumes they are holding a quotation they can sign. */}
              {emailResult.pdfProblem && (
                <div className="error-banner">
                  The email went out, but the quotation PDF could not be attached —
                  {' '}{emailResult.pdfProblem}. The job lines and total are in the message itself;
                  send the printed quotation separately if the customer needs it.
                </div>
              )}
              <div className="modal-actions">
                <button type="button" className="btn btn-primary" onClick={() => setEmailOpen(false)}>Close</button>
              </div>
            </>
          ) : (
            <>
              {/* Said before they fill anything in, rather than after they press Send. */}
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
                  autoFocus type="email" value={emailTo} placeholder="customer@example.com"
                  onChange={(event) => setEmailTo(event.target.value)}
                />
                {/* Most estimates carry no address, so this is the normal case rather than an
                    error state -- worded so it does not read as something having gone wrong. */}
                {emailInfo && !emailInfo.suggested && (
                  <div className="muted" style={{ marginTop: 4 }}>
                    No address on file for {emailInfo.contactName || emailInfo.customerName || 'this customer'} —
                    type one to send it.
                  </div>
                )}
              </div>

              <div className="field">
                <label>Message <span className="muted">(optional — appears above the figures)</span></label>
                <textarea
                  rows={3} value={emailNote}
                  placeholder="Anything you want to say alongside the estimate."
                  onChange={(event) => setEmailNote(event.target.value)}
                />
              </div>

              {emailInfo?.replyTo && (
                <p className="muted">
                  Goes out as <strong>{emailInfo.sendAsName}</strong>, and replies come back to{' '}
                  <strong>{emailInfo.replyTo}</strong> — the estimate&rsquo;s sales rep, not you,
                  unless they have no address on file.
                </p>
              )}
              <p className="muted">
                The customer gets the job lines and the total in the message, and the full price
                quotation — the same document the Print button produces — attached as a PDF. The
                process and material costing underneath is not included in either.
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

      {showApproval && nextStatus && (
        <EstimateApprovalModal
          estimateId={id}
          nextStatus={nextStatus}
          onClose={() => setShowApproval(false)}
          onApproved={async () => { setShowApproval(false); await load(); }}
        />
      )}
    </div>
  );
}
