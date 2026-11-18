import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { usePeriodLocked } from '../utils/periodLock';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';
import BillCreditModal from '../components/BillCreditModal';
import { SupplierLink } from '../components/PartyLink';
import { displayDate, displayAuditTime } from '../utils/dates';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? displayDate(v) : '—'; }

// fully_applied: migrated from the source with its own status (import-bill-credits.js).
const STATUS_LABELS = { open: 'Open', fully_applied: 'Fully Applied', voided: 'Voided' };

// Mirrors the real "Bill Credit" detail view -- reached from a Vendor Bill's Related
// Records tab after crediting it, or from the Bill Credits list.
export default function BillCreditView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [bc, setBc] = useState(null);
  const [tab, setTab] = useState('expenses');
  const [auditLogs, setAuditLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');

  function load() {
    return api.get(`/bill-credits/${id}`).then(({ data }) => { setBc(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'system') {
      api.get(`/bill-credits/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
    }
  }, [tab, id]);

  async function handleVoid() {
    if (!confirm('Void this Bill Credit? Its applied bills will be reversed.')) return;
    setBusy(true);
    setError('');
    try {
      await api.put(`/bill-credits/${id}/void`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Void failed');
    } finally {
      setBusy(false);
    }
  }

  // Closed accounting period: no Edit / Void / Cancel (utils/periodLock.js; the server refuses them too).
  const periodLocked = usePeriodLocked(bc?.date_created, 'ap');

  if (loading || !bc) return <LoadingSpinner />;

  const canEdit = (can('/bill-credits', 'can_edit') && !periodLocked);
  const canVoid = (can('/bill-credits', 'can_void') && !periodLocked);
  // Fully Applied can still be voided: the server reverses its bill applications, and refuses
  // with the reason if a payment or cheque has spent it.
  const isOpen = bc.status !== 'voided';
  // What it was created from: a Vendor Bill, or a Cheque to the vendor.
  const source = bc.vendor_bill_id ? `/vendor-bills/${bc.vendor_bill_id}` : `/cheques/${bc.cheque_id}`;
  const unapplied = Number(bc.total_amount) - Number(bc.applied_amount);

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={source}>Back</Link>
          {/* A voided credit is final; one already spent on a payment or cheque opens read-only with the reason. */}
          {canEdit && bc.status !== 'voided' && <button className="btn btn-sm" onClick={() => setEditing(true)}>Edit</button>}
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
          <h1>Bill Credit</h1>
          <span className="estimate-no">{bc.bill_credit_no}</span>
        </div>
        <div className="estimate-status">{STATUS_LABELS[bc.status] || bc.status}</div>
        <div><Link className="link-btn" to={source}>{bc.bill_no}</Link></div>

        <div className="estimate-detail-grid">
          <div>
            <div>Vendor : <span className="hi"><SupplierLink id={bc.vendor_id} name={bc.supplier_name} /></span></div>
            <div>TIN : <span className="hi">{bc.tin || ''}</span></div>
            <div>A/P Account : <span className="hi">{bc.ap_account_code ? `${bc.ap_account_code} — ${bc.ap_account_name}` : '—'}</span></div>
          </div>
          <div>
            <div>Date : <span className="hi">{formatDate(bc.date_created)}</span></div>
            <div>Memo : <span className="hi">{bc.memo || ''}</span></div>
            <div>Office Location : <span className="hi">{bc.office_location_name || '—'}</span></div>
          </div>
          <div>
            <div>Applied Amount : <span className="hi">{money(bc.applied_amount)}</span></div>
            <div>Unapplied Amount : <span className="hi">{money(unapplied)}</span></div>
          </div>
        </div>
      </div>

      <div className="estimate-footer card" style={{ marginTop: 20 }}>
        <div><span className="muted">Net of TAX</span><div className="hi-lg">{money(bc.subtotal)}</div></div>
        <div><span className="muted">Tax Amount</span><div className="hi-lg">{money(bc.tax_amount)}</div></div>
        <div><span className="muted">Withholding Tax</span><div className="hi-lg">{money(bc.wtax_amount)}</div></div>
        <div><span className="muted">Total Amount</span><div className="hi-lg">{money(bc.total_amount)}</div></div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'expenses' ? 'active' : ''}`} onClick={() => setTab('expenses')}>Expenses</button>
        <button className={`status-tab ${tab === 'apply' ? 'active' : ''}`} onClick={() => setTab('apply')}>Apply</button>
        <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'expenses' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Account Code</th><th>Account Title</th><th>Department</th><th>Amount</th><th>Tax Code</th><th>Tax Amount</th><th>Gross Amount</th><th>Withholding Tax Amount</th></tr>
              </thead>
              <tbody>
                {bc.lines.length === 0 && (
                  <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>No expense lines.</td></tr>
                )}
                {bc.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.account_code}</td>
                    <td>{l.account_name}</td>
                    <td>{l.department_name || '—'}</td>
                    <td>{money(l.amount)}</td>
                    <td>{l.tax_code || '—'}</td>
                    <td>{money(l.tax_amount)}</td>
                    <td>{money(l.gross_amount)}</td>
                    <td>{money(l.wtax_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'apply' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Vendor Bill #</th><th>Applied Amount</th></tr></thead>
              <tbody>
                {bc.applications.length === 0 && (
                  <tr><td colSpan={2} className="muted" style={{ textAlign: 'center', padding: 20 }}>Not applied to any bill yet.</td></tr>
                )}
                {bc.applications.map((a) => (
                  <tr key={a.id}>
                    <td><Link className="link-btn" to={`/vendor-bills/${a.vendor_bill_id}`}>{a.bill_no}</Link></td>
                    <td>{money(a.applied_amount)}</td>
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
                {(!bc.gl_impact || bc.gl_impact.length === 0) && (
                  <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No GL impact yet.</td></tr>
                )}
                {(bc.gl_impact || []).map((row, idx) => (
                  <tr key={idx}>
                    <td>{row.account_code}</td>
                    <td>{row.account_name}</td>
                    <td>{row.debit ? money(row.debit) : ''}</td>
                    <td>{row.credit ? money(row.credit) : ''}</td>
                  </tr>
                ))}
                {bc.gl_impact?.length > 0 && (
                  <tr>
                    <td /><td />
                    <td><strong>{money(bc.gl_impact.reduce((s, r) => s + Number(r.debit || 0), 0))}</strong></td>
                    <td><strong>{money(bc.gl_impact.reduce((s, r) => s + Number(r.credit || 0), 0))}</strong></td>
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

      {editing && (
        <BillCreditModal
          billCreditId={bc.id}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); load(); }}
        />
      )}
    </div>
  );
}
