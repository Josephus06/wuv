import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { usePeriodLocked } from '../utils/periodLock';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';
import BillCreditModal from '../components/BillCreditModal';
import ReversalJournalModal from '../components/ReversalJournalModal';
import { CustomerLink, SupplierLink } from '../components/PartyLink';
import { displayDate, displayAuditTime } from '../utils/dates';

// The Payee opens its Master List record when it is a supplier or a customer; an employee (or a
// cheque with no linked payee) stays plain text.
function PayeeLink({ type, id, name }) {
  if (['VENDOR', 'supplier'].includes(type)) return <SupplierLink id={id} name={name} />;
  if (['CUSTOMER', 'customer'].includes(type)) return <CustomerLink id={id} name={name} />;
  return <>{name}</>;
}

function money(v) { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
// Live's banner wording. FULLY APPLIED is a settled cheque, still live -- only 'void' is cancelled.
const STATUS_LABELS = { open: 'OPEN', fully_applied: 'FULLY APPLIED', void: 'VOID' };
function formatDate(v) { return v ? displayDate(v) : ''; }
// Cheque dates keep the bank's format (e.g. Sep 18, 2026), not the app-wide 18 Sept 2026 -- as asked.
function formatChequeDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : ''; }

export default function ChequeView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [c, setC] = useState(null);
  const [tab, setTab] = useState('expenses');
  const [auditLogs, setAuditLogs] = useState([]);
  const [related, setRelated] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editingRelease, setEditingRelease] = useState(false);
  const [releaseDate, setReleaseDate] = useState('');
  const [savingRelease, setSavingRelease] = useState(false);
  const [showBillCredit, setShowBillCredit] = useState(false);

  // Date Released is editable at any time, on any cheque (voided included).
  async function saveRelease() {
    setSavingRelease(true); setError('');
    try { await api.put(`/cheques/${id}/date-released`, { date_released: releaseDate || null }); await load(); setEditingRelease(false); }
    catch (err) { setError(err.response?.data?.error || 'Could not save Date Released.'); }
    finally { setSavingRelease(false); }
  }

  function load() { return api.get(`/cheques/${id}`).then(({ data }) => { setC(data); setLoading(false); }); }
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'system') api.get(`/cheques/${id}/audit-logs`).then(({ data }) => setAuditLogs(data)); }, [tab, id]);
  // Loaded up front rather than on tab click so the tab can show its own count, and because
  // a voided cheque's reversal journal is the first thing anyone opens this record to find.
  useEffect(() => { api.get(`/cheques/${id}/related`).then(({ data }) => setRelated(data)).catch(() => setRelated([])); }, [id]);

  // Void opens the Reversal Journal popup, as live does (asked 2026-10-08): the entry the void will
  // post, with its date, location and memo to choose. Nothing is voided until its Save.
  const [showReversal, setShowReversal] = useState(false);
  function handleVoid() {
    setError('');
    setShowReversal(true);
  }

  // Closed accounting period: no Edit / Void / Cancel (utils/periodLock.js; the server refuses them too).
  const periodLocked = usePeriodLocked(c?.date_created, 'other_gl');

  if (loading || !c) return <LoadingSpinner />;
  const lines = c.lines || [];
  const gl = c.gl || [];
  const wtaxLines = lines.filter((l) => num(l.withholding_tax_amount) > 0 || l.apply_withholding_tax);
  const totalDebit = gl.reduce((s, l) => s + num(l.debit), 0);
  const totalCredit = gl.reduce((s, l) => s + num(l.credit), 0);
  const credits = c.credits || [];
  const creditTotal = credits.reduce((s, x) => s + num(x.applied_amount), 0);
  const T = ({ label, value }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}><span>{label}</span><span style={{ color: 'var(--accent)' }}>{money(value)}</span></div>
  );

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={'/cheques'}>Back to Lists</Link>
          {(can('/cheques', 'can_edit') && !periodLocked) && c.status !== 'void' && <Link className="btn btn-sm" to={`/cheques/${c.id}/edit`}>Edit</Link>}
          {can('/cheques', 'can_print') && <button className="btn btn-sm" onClick={() => window.open(`/cheques/${c.id}/print`, '_blank')}>Print Voucher</button>}
          {can('/cheques', 'can_print') && <button className="btn btn-sm" onClick={() => window.open(`/cheques/${c.id}/print?as=cheque`, '_blank')}>Print Cheque</button>}
          {/* As on a Vendor Bill: a new Bill Credit for this cheque's vendor, made from the cheque. */}
          {can('/bill-credits', 'can_add') && c.status !== 'void' && ['VENDOR', 'supplier'].includes(c.payee_type) && c.payee_id && (
            <button className="btn btn-sm btn-primary" onClick={() => setShowBillCredit(true)}>Bill Credit</button>
          )}
          {(can('/cheques', 'can_void') && !periodLocked) && c.status !== 'void' && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleVoid}>Void</button>}
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
          <h1>Cheque</h1>
          <span className="estimate-no">{c.cheque_no}</span>
          <span style={{ marginLeft: 10, opacity: 0.85 }}>{STATUS_LABELS[c.status] || String(c.status || '').toUpperCase()}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 320px', gap: 20, marginTop: 12, alignItems: 'start' }}>
          <div>
            <h4>Payee</h4>
            <div className="hi"><PayeeLink type={c.payee_type} id={c.payee_id} name={c.payee_account_name || c.payee_name} /></div>
            <div>Payee Name : <span className="hi">{c.payee_name}</span></div>
            <div>Office Location : <span className="hi">{c.location_name || ''}</span></div>
            <div>Account : <span className="hi">{c.account_name || ''}</span></div>
          </div>
          <div>
            <div>Date : <span className="hi">{formatDate(c.date_created)}</span></div>
            <div>Cheque Date : <span className="hi">{formatChequeDate(c.cheque_date)}</span></div>
            <div>Cheque No : <span className="hi">{c.cheque_number || ''}</span></div>
            <div>
              Date Released : {editingRelease ? (
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <input type="date" value={releaseDate} onChange={(e) => setReleaseDate(e.target.value)} style={{ width: 160 }} />
                  <button className="btn btn-sm btn-primary" disabled={savingRelease} onClick={saveRelease}>Save</button>
                  <button className="btn btn-sm" disabled={savingRelease} onClick={() => setEditingRelease(false)}>Cancel</button>
                </span>
              ) : (
                <>
                  <span className="hi">{formatDate(c.date_released) || '—'}</span>
                  {(can('/cheques', 'can_edit') && !periodLocked) && (
                    <button type="button" className="link-btn" style={{ marginLeft: 8, color: 'inherit', textDecoration: 'underline' }}
                      onClick={() => { setReleaseDate(c.date_released ? String(c.date_released).slice(0, 10) : ''); setEditingRelease(true); }}>
                      Edit
                    </button>
                  )}
                </>
              )}
            </div>
            <div>Currency : <span className="hi">{c.currency || ''}</span></div>
            <div>Conversion : <span className="hi">{Number(c.conversion_rate)}</span></div>
            <div>Memo : <span className="hi">{c.memo || ''}</span></div>
          </div>
          <div style={{ background: '#fff', color: '#0f172a', borderRadius: 8, padding: '14px 18px' }}>
            <T label="Sub Total" value={c.subtotal} />
            <T label="Discount Amount" value={c.discount_amount} />
            <T label="Net of Tax" value={c.net_of_tax} />
            <T label="Tax Amount" value={c.tax_amount} />
            <T label="Gross Amount" value={c.gross_amount} />
            <T label="Withholding Tax Amount" value={c.withholding_tax_amount} />
            {creditTotal > 0 && <T label="Less: Bill Credits" value={creditTotal} />}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0 0', fontWeight: 700 }}><span>Total Amount</span><span style={{ color: 'var(--accent)' }}>{money(c.total_amount)}</span></div>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'expenses' ? 'active' : ''}`} onClick={() => setTab('expenses')}>Expenses</button>
        <button className={`status-tab ${tab === 'wtax' ? 'active' : ''}`} onClick={() => setTab('wtax')}>Withholding Tax</button>
        <button className={`status-tab ${tab === 'credits' ? 'active' : ''}`} onClick={() => setTab('credits')}>Bill Credits{credits.length ? ` (${credits.length})` : ''}</button>
        <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        <button className={`status-tab ${tab === 'related' ? 'active' : ''}`} onClick={() => setTab('related')}>
          Related Records{related.length ? ` (${related.length})` : ''}
        </button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'expenses' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th>Account Code</th><th>Account Title</th><th>Description</th><th>Department</th><th style={{ textAlign: 'right' }}>Amount</th>
                <th>Tax Code</th><th style={{ textAlign: 'right' }}>Tax Amount</th><th style={{ textAlign: 'center' }}>Apply WTax</th>
                <th style={{ textAlign: 'right' }}>Gross Amount</th><th style={{ textAlign: 'right' }}>Withholding Tax</th><th style={{ textAlign: 'right' }}>Total Amount</th>
              </tr></thead>
              <tbody>
                {lines.length === 0 && <tr><td colSpan={11} className="muted" style={{ textAlign: 'center', padding: 20 }}>No expenses.</td></tr>}
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.account_code}</td><td>{l.account_name}</td><td>{l.description}</td><td>{l.department_name}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.amount)}</td>
                    <td>{l.tax_code}</td><td style={{ textAlign: 'right' }}>{money(l.tax_amount)}</td>
                    <td style={{ textAlign: 'center' }}>{l.apply_withholding_tax ? '✓' : ''}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.gross_amount)}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.withholding_tax_amount)}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.total_amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr style={{ fontWeight: 700 }}>
                <td colSpan={4} style={{ textAlign: 'right' }}>Total</td>
                <td style={{ textAlign: 'right' }}>{money(c.net_of_tax)}</td><td />
                <td style={{ textAlign: 'right' }}>{money(c.tax_amount)}</td><td />
                <td style={{ textAlign: 'right' }}>{money(c.gross_amount)}</td>
                <td style={{ textAlign: 'right' }}>{money(c.withholding_tax_amount)}</td>
                {/* The lines' own total; any bill credits come off it in the panel above. */}
                <td style={{ textAlign: 'right' }}>{money(num(c.gross_amount) - num(c.withholding_tax_amount))}</td>
              </tr></tfoot>
            </table>
          </div>
        </div>
      )}

      {tab === 'wtax' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Account</th><th>Description</th><th style={{ textAlign: 'right' }}>Amount</th><th style={{ textAlign: 'right' }}>Withholding Tax</th></tr></thead>
              <tbody>
                {wtaxLines.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No withholding tax.</td></tr>}
                {wtaxLines.map((l) => (
                  <tr key={l.id}><td>{l.account_code} — {l.account_name}</td><td>{l.description}</td><td style={{ textAlign: 'right' }}>{money(l.amount)}</td><td style={{ textAlign: 'right' }}>{money(l.withholding_tax_amount)}</td></tr>
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
              <thead><tr><th>Bill Credit #</th><th>AP Account</th><th style={{ textAlign: 'right' }}>Applied</th></tr></thead>
              <tbody>
                {credits.length === 0 && <tr><td colSpan={3} className="muted" style={{ textAlign: 'center', padding: 20 }}>No bill credits applied.</td></tr>}
                {credits.map((x) => (
                  <tr key={x.bill_credit_id}>
                    <td><Link className="link-btn" to={`/bill-credits/${x.bill_credit_id}`}>{x.bill_credit_no}</Link></td>
                    <td>{x.ap_account_code} — {x.ap_account_name}</td>
                    <td style={{ textAlign: 'right' }}>{money(x.applied_amount)}</td>
                  </tr>
                ))}
              </tbody>
              {credits.length > 0 && <tfoot><tr style={{ fontWeight: 700 }}><td colSpan={2} style={{ textAlign: 'right' }}>Total</td><td style={{ textAlign: 'right' }}>{money(creditTotal)}</td></tr></tfoot>}
            </table>
          </div>
          {c.status === 'void' && credits.length > 0 && <div className="muted" style={{ marginTop: 8 }}>Voided: these credits were given back to the vendor.</div>}
        </div>
      )}

      {tab === 'gl' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Account Code</th><th>Account Title</th><th style={{ textAlign: 'right' }}>Debit</th><th style={{ textAlign: 'right' }}>Credit</th></tr></thead>
              <tbody>
                {gl.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No GL impact.</td></tr>}
                {gl.map((l, i) => <tr key={i}><td>{l.account_code}</td><td>{l.account_name}</td><td style={{ textAlign: 'right' }}>{money(l.debit)}</td><td style={{ textAlign: 'right' }}>{money(l.credit)}</td></tr>)}
              </tbody>
              <tfoot><tr style={{ fontWeight: 700 }}><td colSpan={2} style={{ textAlign: 'right' }}>Total</td><td style={{ textAlign: 'right' }}>{money(totalDebit)}</td><td style={{ textAlign: 'right' }}>{money(totalCredit)}</td></tr></tfoot>
            </table>
          </div>
        </div>
      )}

      {tab === 'related' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Transaction #</th><th style={{ textAlign: 'right' }}>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {related.length === 0 && (
                  <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No related records.</td></tr>
                )}
                {related.map((r) => (
                  <tr key={`${r.kind}-${r.id}`}>
                    <td>{r.date_created ? String(r.date_created).slice(0, 10) : ''}</td>
                    <td><Link className="link-btn" to={r.path || `/journals/${r.id}`}>{r.doc_no || r.journal_no}</Link></td>
                    <td style={{ textAlign: 'right' }}>{money(r.amount)}</td>
                    <td>{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showBillCredit && (
        <BillCreditModal
          chequeId={c.id}
          onClose={() => setShowBillCredit(false)}
          onSaved={(bc) => { setShowBillCredit(false); navigate(`/bill-credits/${bc.id}`); }}
        />
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
      {showReversal && (
        <ReversalJournalModal
          previewPath={`/cheques/${id}/reversal-preview`}
          voidPath={`/cheques/${id}/void`}
          docLabel="cheque"
          onClose={() => setShowReversal(false)}
          onSaved={async () => {
            setShowReversal(false);
            await load();
            api.get(`/cheques/${id}/related`).then(({ data }) => setRelated(data)).catch(() => {});
          }}
        />
      )}
    </div>
  );
}
