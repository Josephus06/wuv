import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import SalesInvoiceModal from '../components/SalesInvoiceModal';
import DeliveryTicketModal from '../components/DeliveryTicketModal';
import LoadingSpinner from '../components/LoadingSpinner';
import {
  STATUS_LABELS, DAILY_COLLECTION_COLUMNS, LINE_COLUMNS, money, moneyOrBlank, salesOrderTotals,
  cellClass, hasTenderVariance, tenderVarianceTotal,
} from '../utils/salesOrderColumns';

// Read-only Sales Order detail -- mirrors EstimateView.jsx's layout (banner + 4-column
// details + tabs + totals footer), since the real system's Sales Order screen is
// structurally the estimate screen's sibling. No process sub-rows here (the real
// system's "Items" tab is flatter than the estimate's "Job" tab), and no
// Approve/Disapprove since orders don't go through that workflow -- they exist because
// the estimate they came from already did. Print opens the hand-out sheet in a new tab.

export default function SalesOrderView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [so, setSo] = useState(null);
  const [tab, setTab] = useState('items');
  const [loading, setLoading] = useState(true);
  const [creatingLineId, setCreatingLineId] = useState(null);
  const [showBillMenu, setShowBillMenu] = useState(false);
  const [showSIModal, setShowSIModal] = useState(false);
  const [showDTModal, setShowDTModal] = useState(false);
  const [invoices, setInvoices] = useState([]);
  const [deliveries, setDeliveries] = useState([]);

  function load() {
    return api.get(`/sales-orders/${id}`).then(({ data }) => { setSo(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'related') {
      api.get(`/sales-invoices/by-sales-order/${id}`).then(({ data }) => setInvoices(data));
      api.get(`/item-deliveries/by-sales-order/${id}`).then(({ data }) => setDeliveries(data));
    }
  }, [tab, id]);

  async function handleCreateJo(lineId) {
    setCreatingLineId(lineId);
    try {
      const { data: jobOrder } = await api.post(`/sales-orders/${id}/lines/${lineId}/create-jo`);
      setSo((prev) => ({
        ...prev,
        status: prev.status === 'pending_for_jo' ? 'jo_in_process' : prev.status,
        lines: prev.lines.map((l) => (l.id === lineId
          ? { ...l, job_order_id: jobOrder.id, job_order_no: jobOrder.job_order_no, job_order_status: jobOrder.status }
          : l)),
      }));
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to create Job Order');
    } finally {
      setCreatingLineId(null);
    }
  }

  if (loading || !so) return <LoadingSpinner />;

  const lines = so.lines || [];
  // Imported from a POS category-sales shift report rather than raised from an Estimate:
  // the sale is already done, so none of the production actions apply to it.
  const isPosImport = !!so.pos_import_key;
  const isDailyCollections = so.sales_layout === 'daily_collections';
  // Counter takings sit in Undeposited Funds until a Bank Deposit sweeps them, exactly like a
  // not-deposited Customer Payment -- same button, same destination.
  const canDeposit = isDailyCollections && so.status === 'undeposited' && !so.deposit_id;
  // "Item Delivery" only makes sense once at least one JO line has something both Built
  // and QI'd that hasn't shipped yet -- mirrors the create form's own eligibility filter,
  // so the button doesn't open onto an empty form.
  const hasDeliverableLine = lines.some((l) => {
    const cap = Math.min(Number(l.quantity_built || 0), Number(l.quantity_inspected || 0));
    return cap - Number(l.quantity_delivered || 0) > 0;
  });
  // "Bill" only makes sense once at least one JO line has been delivered but not yet
  // (fully) invoiced -- mirrors the Create SI form's own eligibility filter.
  const hasInvoiceableLine = lines.some((l) => l.job_order_id && Number(l.quantity_delivered || 0) > Number(l.quantity_invoiced || 0));
  const canEdit = can('/sales-orders', 'can_edit');
  const { netOfTax, discountTotal, taxTotal, totalAmount } = salesOrderTotals(lines, isDailyCollections);
  // A day whose tenders did not add up to its sales is saved rather than refused, so the
  // order has to say so where the status is read.
  const unbalanced = isDailyCollections && hasTenderVariance(lines);

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate('/sales-orders')}>Back</button>
          <button className="btn btn-sm btn-primary" onClick={() => window.open(`/sales-orders/${id}/print`, '_blank')}>Print</button>
          {canEdit && <button className="btn btn-sm" disabled title="Editing a Sales Order isn't implemented in this build -- amend the originating Estimate instead">Edit</button>}
          {canDeposit && (
            <button className="btn btn-sm btn-primary" onClick={() => navigate('/deposits/new', { state: { preselectSalesOrderId: so.id } })}>Deposit</button>
          )}
          {so.deposit_id && (
            <button className="btn btn-sm" onClick={() => navigate(`/deposits/${so.deposit_id}`)}>View Deposit</button>
          )}
          {hasDeliverableLine && <button className="btn btn-sm btn-primary" onClick={() => navigate(`/sales-orders/${id}/item-delivery/new`)}>Item Delivery</button>}
          {hasInvoiceableLine && (
            <div style={{ position: 'relative' }}>
              <button className="btn btn-sm btn-primary" onClick={() => setShowBillMenu((s) => !s)}>Bill ▾</button>
              {showBillMenu && (
                <div className="card" style={{ position: 'absolute', right: 0, top: '110%', zIndex: 20, padding: 6, minWidth: 80 }}>
                  <button type="button" className="btn btn-sm" disabled style={{ width: '100%', marginBottom: 4 }} title="Billing Statements aren't implemented in this build">BS</button>
                  <button type="button" className="btn btn-sm" style={{ width: '100%', marginBottom: 4 }} onClick={() => { setShowBillMenu(false); setShowSIModal(true); }}>SI</button>
                  <button type="button" className="btn btn-sm" disabled style={{ width: '100%', marginBottom: 4 }} title="Delivery Receipts aren't implemented in this build">DR</button>
                  <button type="button" className="btn btn-sm" style={{ width: '100%' }} onClick={() => { setShowBillMenu(false); setShowDTModal(true); }}>DT</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Sales Order</h1>
          <span className="estimate-no">{so.sales_order_no}</span>
        </div>
        <div className="estimate-status">
          {unbalanced && (
            <span className="so-unbalanced-badge" title={`Cash + e-wallet is off total daily sales by ${money(tenderVarianceTotal(lines))}`}>
              Unbalanced {money(tenderVarianceTotal(lines))}
            </span>
          )}
          {STATUS_LABELS[so.status] || so.status}
          <button type="button" className="estimate-so-link" onClick={() => navigate(`/estimates/${so.estimate_id}`)}>
            {so.estimate_no}
          </button>
        </div>

        <div className="estimate-detail-grid">
          <div>
            <h4>Customer Details</h4>
            <div className="hi">{so.customer_name}</div>
            <div>Contact Name : <span className="hi">{so.contact_name}</span></div>
            <div>Contact Title : <span className="hi">{so.contact_title}</span></div>
            <div>Contact Email : <span className="hi">{so.contact_email}</span></div>
            <div>Contact Phone : <span className="hi">{so.contact_phone}</span></div>
            <div>Blanket PO : <span className="hi">{so.blanket_po_no}</span></div>
            <div>Blanket PO Memo : <span className="hi">{so.blanket_po_memo}</span></div>
          </div>
          <div>
            <h4>Estimate Details</h4>
            <div>Date Created : <span className="hi">{so.date_created ? String(so.date_created).slice(0, 10) : ''}</span></div>
            <div>Sales Division : <span className="hi">{so.sales_division_name}</span></div>
            <div>Office Location : <span className="hi">{so.office_location_name}</span></div>
            {/* Only imported counter sales carry one -- an estimate-derived order's department
                follows from its sales division, so the row would just read empty. */}
            {isDailyCollections && <div>Department : <span className="hi">{so.department_name}</span></div>}
            <div>Contract Desc. : <span className="hi">{so.contract_description}</span></div>
            <div>Ref # : <span className="hi">{so.ref_no}</span></div>
            <div>Memo : <span className="hi">{so.memo}</span></div>
            <div>Shipping Address : <span className="hi">{so.shipping_address}</span></div>
          </div>
          <div>
            <h4>Other Details</h4>
            <div>Sales Rep : <span className="hi">{so.sales_rep_name}</span></div>
            <div>Prepared By : <span className="hi">{so.prepared_by_name}</span></div>
            <div>Approved By : <span className="hi">{so.approved_by_name}</span></div>
            <div>Production Lead Time : <span className="hi">{so.production_lead_time}</span></div>
            <div>Price Validity : <span className="hi">{so.price_validity}</span></div>
            <div>Order Confirmation : <span className="hi">{so.order_confirmation_type}</span></div>
          </div>
          <div>
            <h4>Billing Details</h4>
            <div>Credit Term : <span className="hi">{so.credit_term}</span></div>
            <div>Credit Limit : <span className="hi">{so.credit_limit}</span></div>
            <div>Credit Balance : <span className="hi">{so.credit_balance}</span></div>
            <div>Bill to Contact Number : <span className="hi">{so.bill_to_contact_number}</span></div>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>{isDailyCollections ? 'Daily Sales & Collections' : 'Items'}</button>
        {isDailyCollections && (
          <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        )}
        <button className={`status-tab ${tab === 'related' ? 'active' : ''}`} onClick={() => setTab('related')}>Related Records</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'items' && isDailyCollections && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>{DAILY_COLLECTION_COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {lines.length === 0 && (
                  <tr><td colSpan={DAILY_COLLECTION_COLUMNS.length} className="muted" style={{ textAlign: 'center', padding: 20 }}>No days recorded.</td></tr>
                )}
                {lines.map((l) => (
                  <tr key={l.id}>
                    {DAILY_COLLECTION_COLUMNS.map((c) => (
                      <td key={c.key} className={cellClass(c, l)}>{c.render ? c.render(l) : (c.money ? money(l[c.key]) : l[c.key])}</td>
                    ))}
                  </tr>
                ))}
                {lines.length > 0 && (
                  <tr>
                    <td><strong>Total</strong></td>
                    {/* Only the money columns carry a total -- the attendant columns hold
                        names, and summing those produced an empty cell by accident rather
                        than by intent. */}
                    {DAILY_COLLECTION_COLUMNS.slice(1).map((c) => (
                      <td key={c.key}>
                        {c.money && <strong>{(c.blankWhenZero ? moneyOrBlank : money)(lines.reduce((s, l) => s + Number(l[c.key] || 0), 0))}</strong>}
                      </td>
                    ))}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'items' && !isDailyCollections && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>#</th><th>JO #</th>{LINE_COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
              <tbody>
                {lines.length === 0 && (
                  <tr><td colSpan={LINE_COLUMNS.length + 2} className="muted" style={{ textAlign: 'center', padding: 20 }}>No items.</td></tr>
                )}
                {lines.map((l, idx) => (
                  <tr key={l.id}>
                    <td>{idx + 1}</td>
                    <td>
                      {l.job_order_id ? (
                        <button type="button" className="link-btn" onClick={() => navigate(`/job-orders/${l.job_order_id}`)}>
                          {l.job_order_no}
                        </button>
                      ) : isPosImport ? (
                        // Counter sales imported from a POS shift report are already
                        // complete -- there is no production work to raise a JO for.
                        <span className="muted">—</span>
                      ) : (
                        <button type="button" className="link-btn" disabled={creatingLineId === l.id} onClick={() => handleCreateJo(l.id)}>
                          {creatingLineId === l.id ? 'Creating...' : 'Create JO'}
                        </button>
                      )}
                    </td>
                    {LINE_COLUMNS.map((c) => <td key={c.key}>{c.render ? c.render(l) : l[c.key]}</td>)}
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
                {(!so.gl_impact || so.gl_impact.length === 0) && (
                  <tr>
                    <td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                      No GL impact. This needs an "Undeposited Funds" (or Accounts Receivable) account,
                      and every POS category on the order mapped to a revenue account.
                    </td>
                  </tr>
                )}
                {(so.gl_impact || []).map((row, idx) => (
                  <tr key={idx}>
                    <td>{row.account_code}</td>
                    <td>{row.account_name}</td>
                    <td>{row.debit ? money(row.debit) : ''}</td>
                    <td>{row.credit ? money(row.credit) : ''}</td>
                  </tr>
                ))}
                {so.gl_impact?.length > 0 && (
                  <tr>
                    <td /><td />
                    <td><strong>{money(so.gl_impact.reduce((s, r) => s + Number(r.debit || 0), 0))}</strong></td>
                    <td><strong>{money(so.gl_impact.reduce((s, r) => s + Number(r.credit || 0), 0))}</strong></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'related' && (
        <div className="card">
          <p>Originating Estimate: <button type="button" className="btn btn-sm" onClick={() => navigate(`/estimates/${so.estimate_id}`)}>{so.estimate_no}</button></p>
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead><tr><th>Type</th><th>Reference</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {invoices.length === 0 && deliveries.length === 0 && (
                  <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No related records yet.</td></tr>
                )}
                {deliveries.map((del) => (
                  <tr key={`del-${del.id}`}>
                    <td>Item Delivery</td>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/item-deliveries/${del.id}`)}>{del.delivery_no}</button></td>
                    <td>{del.date_created ? String(del.date_created).slice(0, 10) : ''}</td>
                    <td></td>
                    <td>{del.status === 'cancelled' ? 'Cancelled' : 'Saved'}</td>
                  </tr>
                ))}
                {invoices.map((inv) => (
                  <tr key={inv.id}>
                    <td>Invoice</td>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/sales-invoices/${inv.id}`)}>{inv.invoice_no}</button></td>
                    <td>{inv.date_created ? String(inv.date_created).slice(0, 10) : ''}</td>
                    <td>{money(inv.gross_amount)}</td>
                    <td>{inv.status === 'cancelled' ? 'Cancelled' : 'Saved'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'system' && (
        <div className="card">
          <div className="field-row">
            <div className="field"><label>Created At</label><input readOnly value={so.created_at ? new Date(so.created_at).toLocaleString() : ''} /></div>
            <div className="field"><label>Last Updated</label><input readOnly value={so.updated_at ? new Date(so.updated_at).toLocaleString() : ''} /></div>
          </div>
        </div>
      )}

      <div className="estimate-footer card">
        <div><span className="muted">Net of Tax</span><div className="hi-lg">{money(netOfTax)}</div></div>
        <div><span className="muted">Discount</span><div className="hi-lg">{money(discountTotal)}</div></div>
        <div><span className="muted">Tax</span><div className="hi-lg">{money(taxTotal)}</div></div>
        <div><span className="muted">Total Amount</span><div className="hi-lg">{money(totalAmount)}</div></div>
      </div>

      {showSIModal && (
        <SalesInvoiceModal
          salesOrderId={Number(id)}
          onClose={() => setShowSIModal(false)}
          onSaved={async (si) => { setShowSIModal(false); await load(); navigate(`/sales-invoices/${si.id}`); }}
        />
      )}

      {showDTModal && (
        <DeliveryTicketModal
          salesOrderId={Number(id)}
          onClose={() => setShowDTModal(false)}
          onSaved={async (dt) => { setShowDTModal(false); await load(); navigate(`/delivery-tickets/${dt.id}`); }}
        />
      )}
    </div>
  );
}
