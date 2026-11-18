import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { usePeriodLocked } from '../utils/periodLock';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDate, displayAuditTime } from '../utils/dates';
import { CustomerLink } from '../components/PartyLink';

function money(v) { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function formatDate(v) { return v ? displayDate(v) : ''; }

export default function DepositView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [d, setD] = useState(null);
  const [tab, setTab] = useState('payments');
  const [auditLogs, setAuditLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function load() { return api.get(`/deposits/${id}`).then(({ data }) => { setD(data); setLoading(false); }); }
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'system') api.get(`/deposits/${id}/audit-logs`).then(({ data }) => setAuditLogs(data)); }, [tab, id]);

  async function handleVoid() {
    if (!confirm('Void this Deposit? The payments will return to Not Deposited.')) return;
    setBusy(true); setError('');
    try { await api.put(`/deposits/${id}/void`); await load(); }
    catch (err) { setError(err.response?.data?.error || 'Void failed'); }
    finally { setBusy(false); }
  }

  // Closed accounting period: no Edit / Void / Cancel (utils/periodLock.js; the server refuses them too).
  const periodLocked = usePeriodLocked(d?.date_created, 'ar');

  if (loading || !d) return <LoadingSpinner />;
  const payments = d.payments || [];
  // Counter-sales orders swept into this deposit alongside customer payments.
  const salesOrders = d.sales_orders || [];
  const gl = d.gl || [];
  const others = (d.lines || []).filter((l) => l.line_type === 'other');
  const cashBacks = (d.lines || []).filter((l) => l.line_type === 'cashback');
  const otherTotal = others.reduce((s, l) => s + num(l.amount), 0);
  const cashBackTotal = cashBacks.reduce((s, l) => s + num(l.amount), 0);
  const acctLabel = (l) => `${l.account_code} — ${l.account_name}`;
  const totalDebit = gl.reduce((s, l) => s + num(l.debit), 0);
  const totalCredit = gl.reduce((s, l) => s + num(l.credit), 0);

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={'/deposits'}>Back to Lists</Link>
          {(can('/deposits', 'can_edit') && !periodLocked) && d.status !== 'void' && (d.reconciled
            ? <button className="btn btn-sm" disabled title="Cleared in a Bank Reconciliation -- it can no longer be edited">Edit</button>
            : <Link className="btn btn-sm" to={`/deposits/${d.id}/edit`}>Edit</Link>)}
          {(can('/deposits', 'can_void') && !periodLocked) && d.status !== 'void' && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleVoid}>Void</button>}
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
          <h1>Deposit</h1>
          <span className="estimate-no">{d.bd_no}</span>
          <span style={{ marginLeft: 10, opacity: 0.85 }}>{d.status === 'void' ? 'VOID' : 'OPEN'}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 20, marginTop: 12, alignItems: 'start' }}>
          <div>
            <div>Date : <span className="hi">{formatDate(d.date_created)}</span></div>
            <div>Account : <span className="hi">{d.account_name || ''}</span></div>
            <div>Branch : <span className="hi">{d.location_name ? `${d.company_name ? `${d.company_name} — ` : ''}${d.location_name}` : ''}</span></div>
          </div>
          <div>
            <div>Memo : <span className="hi">{d.memo || ''}</span></div>
          </div>
          <div style={{ background: '#fff', color: '#0f172a', borderRadius: 8, padding: '14px 20px', minWidth: 260 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Total Deposit</span><span style={{ color: 'var(--accent)', fontWeight: 700 }}>{money(d.total_amount)}</span></div>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'payments' ? 'active' : ''}`} onClick={() => setTab('payments')}>Payments</button>
        <button className={`status-tab ${tab === 'other' ? 'active' : ''}`} onClick={() => setTab('other')}>Other Deposit {money(otherTotal)}</button>
        <button className={`status-tab ${tab === 'cashback' ? 'active' : ''}`} onClick={() => setTab('cashback')}>Cash Back {money(cashBackTotal)}</button>
        <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'payments' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Trans. #</th><th>Customer</th><th>Date Created</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
              <tbody>
                {payments.length === 0 && salesOrders.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No payments.</td></tr>}
                {payments.map((p) => (
                  <tr key={`cp-${p.id}`}>
                    <td><Link className="link-btn" to={`/customer-payments/${p.id}`}>{p.customer_payment_no}</Link></td>
                    <td><CustomerLink id={p.customer_id} name={p.customer_name} /></td>
                    <td>{formatDate(p.date_created)}</td>
                    <td style={{ textAlign: 'right' }}>{money(p.payment_amount)}</td>
                  </tr>
                ))}
                {salesOrders.map((o) => (
                  <tr key={`so-${o.id}`}>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/sales-orders/${o.id}`)}>{o.sales_order_no}</button></td>
                    <td>{o.customer_name}</td>
                    <td>{formatDate(o.date_created)}</td>
                    <td style={{ textAlign: 'right' }}>{money(o.total_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'other' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th style={{ textAlign: 'right' }}>Amount</th><th>Account</th><th>Payment Method</th><th>Department</th><th>Location</th><th>Memo</th></tr></thead>
              <tbody>
                {others.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No other deposits.</td></tr>}
                {others.map((l) => (
                  <tr key={l.id}>
                    <td>{l.party_name}</td><td style={{ textAlign: 'right' }}>{money(l.amount)}</td><td>{acctLabel(l)}</td>
                    <td>{l.payment_method_name}</td><td>{l.department_name}</td><td>{l.location_name}</td><td>{l.memo}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'cashback' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th style={{ textAlign: 'right' }}>Amount</th><th>Account</th><th>Department</th><th>Location</th><th>Memo</th></tr></thead>
              <tbody>
                {cashBacks.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No cash back.</td></tr>}
                {cashBacks.map((l) => (
                  <tr key={l.id}>
                    <td style={{ textAlign: 'right' }}>{money(l.amount)}</td><td>{acctLabel(l)}</td>
                    <td>{l.department_name}</td><td>{l.location_name}</td><td>{l.memo}</td>
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
                {gl.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No GL impact.</td></tr>}
                {gl.map((l, i) => (
                  <tr key={i}><td>{l.account_code}</td><td>{l.account_name}</td><td style={{ textAlign: 'right' }}>{money(l.debit)}</td><td style={{ textAlign: 'right' }}>{money(l.credit)}</td></tr>
                ))}
              </tbody>
              <tfoot><tr style={{ fontWeight: 700 }}><td colSpan={2} style={{ textAlign: 'right' }}>Total</td><td style={{ textAlign: 'right' }}>{money(totalDebit)}</td><td style={{ textAlign: 'right' }}>{money(totalCredit)}</td></tr></tfoot>
            </table>
          </div>
        </div>
      )}

      {tab === 'system' && (
        <div className="card">
          <DataTable
            columns={[
              { key: 'set_at', label: 'When', render: (r) => displayAuditTime(r.set_at) },
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
