import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { usePeriodLocked } from '../utils/periodLock';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDate, displayAuditTime } from '../utils/dates';

function money(v) { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function formatDate(v) { return v ? displayDate(v) : ''; }

export default function FundTransferView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, user } = useAuth();
  // The server lets a System Admin print without can_print, which /fund-transfers was never granted.
  const canPrint = can('/fund-transfers', 'can_print') || user?.account_type === 'System Admin';
  const [ft, setFt] = useState(null);
  const [tab, setTab] = useState('gl');
  const [auditLogs, setAuditLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function load() { return api.get(`/fund-transfers/${id}`).then(({ data }) => { setFt(data); setLoading(false); }); }
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'system') api.get(`/fund-transfers/${id}/audit-logs`).then(({ data }) => setAuditLogs(data)); }, [tab, id]);

  async function handleVoid() {
    if (!confirm('Void this Fund Transfer?')) return;
    setBusy(true); setError('');
    try { await api.put(`/fund-transfers/${id}/void`); await load(); }
    catch (err) { setError(err.response?.data?.error || 'Void failed'); }
    finally { setBusy(false); }
  }

  // Closed accounting period: no Edit / Void / Cancel (utils/periodLock.js; the server refuses them too).
  const periodLocked = usePeriodLocked(ft?.date_created, 'other_gl');

  if (loading || !ft) return <LoadingSpinner />;
  const gl = ft.gl || [];
  const totalDebit = gl.reduce((s, l) => s + num(l.debit), 0);
  const totalCredit = gl.reduce((s, l) => s + num(l.credit), 0);

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={'/fund-transfers'}>Back to Lists</Link>
          {canPrint && <button className="btn btn-sm" onClick={() => window.open(`/fund-transfers/${ft.id}/print`, '_blank')}>Print</button>}
          {(can('/fund-transfers', 'can_edit') && !periodLocked) && ft.status !== 'void' && <Link className="btn btn-sm" to={`/fund-transfers/${ft.id}/edit`}>Edit</Link>}
          {(can('/fund-transfers', 'can_void') && !periodLocked) && ft.status !== 'void' && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleVoid}>Void</button>}
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
          <h1>Fund Transfer</h1>
          <span className="estimate-no">{ft.ft_no}</span>
          <span style={{ marginLeft: 10, opacity: 0.85 }}>{ft.status === 'void' ? 'VOID' : ''}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 12 }}>
          <div>
            <div>Date : <span className="hi">{formatDate(ft.date_created)}</span></div>
            <div>From Account : <span className="hi">{ft.from_account_name || ''}</span></div>
            <div>To Account : <span className="hi">{ft.to_account_name || ''}</span></div>
            <div>Branch : <span className="hi">{ft.location_name ? `${ft.company_name ? `${ft.company_name} — ` : ''}${ft.location_name}` : ''}</span></div>
          </div>
          <div>
            <div>Memo : <span className="hi">{ft.memo || ''}</span></div>
            <div>Amount : <span className="hi">{money(ft.amount)}</span></div>
            <div>Prepared By : <span className="hi">{ft.prepared_by_name || ''}</span></div>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

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
