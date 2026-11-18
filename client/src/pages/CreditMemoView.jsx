import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { usePeriodLocked } from '../utils/periodLock';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';

import { displayDate, displayAuditTime } from '../utils/dates';
import { CustomerLink } from '../components/PartyLink';

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? displayDate(v) : '—'; }

const STATUS_LABELS = { open: 'OPEN', voided: 'VOID' };

// Mirrors the real "Credit Memo" detail view (CM-#). Its GL Impact is the exact reversal
// of the invoice entry it credits back -- debit Sales and VAT on Sales, credit Accounts
// Receivable Trade -- so the customer owes less and the revenue is unwound.
export default function CreditMemoView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [cm, setCm] = useState(null);
  const [tab, setTab] = useState('items');
  const [auditLogs, setAuditLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function load() {
    return api.get(`/credit-memos/${id}`).then(({ data }) => { setCm(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'system') {
      api.get(`/credit-memos/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
    }
  }, [tab, id]);

  async function handleVoid() {
    if (!confirm('Void this Credit Memo? Any amount it offset will be put back on the invoice.')) return;
    setBusy(true);
    setError('');
    try {
      await api.put(`/credit-memos/${id}/void`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Void failed');
    } finally {
      setBusy(false);
    }
  }

  // Closed accounting period: no Edit / Void / Cancel (utils/periodLock.js; the server refuses them too).
  const periodLocked = usePeriodLocked(cm?.date_created, 'ar');

  if (loading || !cm) return <LoadingSpinner />;

  const canEdit = (can('/credit-memos', 'can_edit') && !periodLocked);
  const canVoid = (can('/credit-memos', 'can_void') && !periodLocked);
  const isOpen = cm.status === 'open';

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={`/sales-invoices/${cm.sales_invoice_id}`}>Back</Link>
          {canEdit && isOpen && <Link className="btn btn-sm" to={`/credit-memos/${cm.id}/edit`}>Edit</Link>}
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
          <h1>Credit Memo</h1>
          <span className="estimate-no">{cm.credit_memo_no}</span>
        </div>
        <div className="estimate-status">
          {STATUS_LABELS[cm.status] || cm.status}
          <Link className="estimate-so-link" to={`/sales-invoices/${cm.sales_invoice_id}`}>
            {cm.invoice_no}
          </Link>
        </div>

        <div className="estimate-detail-grid">
          <div>
            <div>Customer : <span className="hi"><CustomerLink id={cm.customer_id} name={cm.customer_name} /></span></div>
            <div>Sales Rep : <span className="hi">{cm.sales_rep_name || '—'}</span></div>
            <div>Date : <span className="hi">{formatDate(cm.date_created)}</span></div>
            {/* An imported memo can apply to several invoices at once, so there is no single
                "created from" -- the Apply tab lists them all. */}
            {cm.sales_invoice_id && (
              <div>Created From : <Link className="link-btn" to={`/sales-invoices/${cm.sales_invoice_id}`}>{cm.invoice_no}</Link></div>
            )}
          </div>
          <div>
            <div>Office Location : <span className="hi">{cm.office_location_name || '—'}</span></div>
            <div>A/R Account : <span className="hi">{cm.ar_account_code ? `${cm.ar_account_code} ${cm.ar_account_name}` : '—'}</span></div>
            <div>Memo : <span className="hi">{cm.memo || ''}</span></div>
          </div>
          <div>
            <div>Applied : <span className="hi">{money(cm.applied_amount)}</span></div>
            <div>Remaining : <span className="hi">{money(Number(cm.gross_amount) - Number(cm.applied_amount))}</span></div>
            <div>Created By : <span className="hi">{cm.created_by_name || '—'}</span></div>
          </div>
        </div>
      </div>

      <div className="estimate-footer card" style={{ marginTop: 20 }}>
        <div><span className="muted">Sub Total</span><div className="hi-lg">{money(cm.subtotal)}</div></div>
        <div><span className="muted">Discount Amount</span><div className="hi-lg">{money(cm.discount_amount)}</div></div>
        <div><span className="muted">Net of Tax</span><div className="hi-lg">{money(cm.net_of_tax)}</div></div>
        <div><span className="muted">Tax Amount</span><div className="hi-lg">{money(cm.tax_amount)}</div></div>
        <div><span className="muted">Gross Amount</span><div className="hi-lg">{money(cm.gross_amount)}</div></div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>Items</button>
        <button className={`status-tab ${tab === 'apply' ? 'active' : ''}`} onClick={() => setTab('apply')}>Apply</button>
        <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'items' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th><th>JO #</th><th>Item</th><th>Description</th><th>Department</th><th>Qty</th>
                  <th>Unit</th><th>Price/Unit</th><th>Subtotal</th><th>Disc.%</th><th>Disc. / Unit</th>
                  <th>Disc. Amt</th><th>Disc. Price/Unit</th><th>Net of Tax</th><th>Tax Code</th>
                  <th>Tax Amt</th><th>Gross Amt</th>
                </tr>
              </thead>
              <tbody>
                {cm.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.line_no}</td>
                    <td>{l.job_order_id ? (
                      <Link className="link-btn" to={`/production/${l.job_order_id}`}>{l.job_order_no}</Link>
                    ) : '—'}</td>
                    <td>{l.item_name || '—'}</td>
                    <td>{l.description}</td>
                    <td>{l.department_name || '—'}</td>
                    <td>{qty(l.quantity)}</td>
                    <td>{l.units}</td>
                    <td>{money(l.price_per_unit)}</td>
                    <td>{money(l.subtotal)}</td>
                    <td>{money(l.disc_percent)}</td>
                    <td>{money(l.disc_per_unit)}</td>
                    <td>{money(l.disc_amount)}</td>
                    <td>{money(l.disc_price_per_unit)}</td>
                    <td>{money(l.net_of_tax)}</td>
                    <td>{l.tax_code}</td>
                    <td>{money(l.tax_amount)}</td>
                    <td>{money(l.gross_amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={8} />
                  <td><strong>{money(cm.subtotal)}</strong></td>
                  <td colSpan={2} />
                  <td><strong>{money(cm.discount_amount)}</strong></td>
                  <td />
                  <td><strong>{money(cm.net_of_tax)}</strong></td>
                  <td />
                  <td><strong>{money(cm.tax_amount)}</strong></td>
                  <td><strong>{money(cm.gross_amount)}</strong></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {tab === 'apply' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              {/* Mirrors live's Apply tab: what the invoice originally billed, what it still
                  owed when this credit hit it, and what remains after. */}
              <thead>
                <tr>
                  <th>Invoice #</th><th>Date Created</th>
                  <th style={{ textAlign: 'right' }}>Original Amount</th>
                  <th style={{ textAlign: 'right' }}>Original Amount Due</th>
                  <th style={{ textAlign: 'right' }}>Amount Due</th>
                  <th style={{ textAlign: 'right' }}>Applied Amount</th>
                </tr>
              </thead>
              <tbody>
                {cm.applications.length === 0 && (
                  <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>Not applied to any invoice yet.</td></tr>
                )}
                {cm.applications.map((a) => (
                  <tr key={a.id}>
                    {/* Not every applied invoice exists in this database; show the number
                        live recorded rather than a link that would 404. */}
                    <td>
                      {a.sales_invoice_id
                        ? <Link className="link-btn" to={`/sales-invoices/${a.sales_invoice_id}`}>{a.invoice_no}</Link>
                        : <span title="This invoice is not in this database">{a.invoice_no || '—'}</span>}
                    </td>
                    <td>{formatDate(a.invoice_date)}</td>
                    <td style={{ textAlign: 'right' }}>{money(a.invoice_gross)}</td>
                    <td style={{ textAlign: 'right' }}>{money(a.original_amount_due)}</td>
                    <td style={{ textAlign: 'right' }}>{money(Number(a.original_amount_due || 0) - Number(a.applied_amount || 0))}</td>
                    <td style={{ textAlign: 'right' }}>{money(a.applied_amount)}</td>
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
                {(!cm.gl_impact || cm.gl_impact.length === 0) && (
                  <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No GL impact yet.</td></tr>
                )}
                {(cm.gl_impact || []).map((row, idx) => (
                  <tr key={idx}>
                    <td>{row.account_code}</td>
                    <td>{row.account_name}</td>
                    <td>{row.debit ? money(row.debit) : '0.00'}</td>
                    <td>{row.credit ? money(row.credit) : '0.00'}</td>
                  </tr>
                ))}
                {cm.gl_impact?.length > 0 && (
                  <tr>
                    <td /><td />
                    <td><strong>{money(cm.gl_impact.reduce((s, r) => s + Number(r.debit || 0), 0))}</strong></td>
                    <td><strong>{money(cm.gl_impact.reduce((s, r) => s + Number(r.credit || 0), 0))}</strong></td>
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
