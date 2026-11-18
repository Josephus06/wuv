import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import DraftEditorModal from './DraftEditorModal';
import LoadingSpinner from './LoadingSpinner';
import { useAuth } from '../context/useAuth';
import { displayDate } from '../utils/dates';

const REASON_LABELS = { reorder: 'Late to reorder', trend: 'Sales dropping', visit: 'Visit due', overdue: 'Overdue balance', birthday: 'Birthday', scheduled: 'Booked' };
const REASON_BADGE = { reorder: 'badge-warning', trend: 'badge-warning', visit: 'badge-info', overdue: 'badge-danger', birthday: 'badge-success', scheduled: 'badge-muted' };
const PRIORITY_BADGE = { high: 'badge-danger', normal: 'badge-muted', low: 'badge-info' };
const PAGE = 50;

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) && n ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';
}
function formatDate(v) { return v ? displayDate(String(v).slice(0, 10)) : '—'; }

// The ranked "who to reach out to" list -- reads the nightly snapshot from
// server/src/lib/crmAttention.js via GET /crm/attention. Every row says why it is there, so a
// rep can judge it rather than trust a number.
export default function NeedsAttention() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [data, setData] = useState(null);
  const [filters, setFilters] = useState({ owner: 'mine', priority: '', reason: '', q: '' });
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [drafting, setDrafting] = useState(null);
  const [draft, setDraft] = useState(null);

  async function load(nextOffset = offset, f = filters) {
    setLoading(true);
    const params = { limit: PAGE, offset: nextOffset };
    for (const [k, v] of Object.entries(f)) if (v) params[k] = v;
    const { data: d } = await api.get('/crm/attention', { params });
    // "Mine" on first load for someone with no customers of their own is an empty page that
    // looks broken -- fall back to everyone they can see.
    if (f.owner === 'mine' && d.total === 0 && nextOffset === 0 && !d.owners.some((o) => o.id === d.my_employee_id)) {
      const all = { ...f, owner: '' };
      setFilters(all);
      return load(0, all);
    }
    setData(d);
    setOffset(nextOffset);
    setLoading(false);
    return undefined;
  }

  useEffect(() => { load(0); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function applyFilter(k, v) {
    const f = { ...filters, [k]: v };
    setFilters(f);
    load(0, f);
  }

  async function refresh() {
    setRefreshing(true);
    setError('');
    try {
      await api.post('/crm/attention/refresh');
      await load(0);
    } catch (err) {
      setError(err.response?.data?.error || 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }

  async function draftEmail(row) {
    setDrafting(row.customer_id);
    setError('');
    try {
      const { data: draft } = await api.post('/crm/drafts', { customer_id: row.customer_id });
      setDraft({ draft, customerName: row.customer_name });
    } catch (err) {
      setError(`${row.customer_name}: ${err.response?.data?.error || 'Could not write a draft'}`);
    } finally {
      setDrafting(null);
    }
  }

  async function snooze(row, days) {
    await api.post(`/crm/attention/${row.customer_id}/snooze`, { days });
    load(offset);
  }

  if (!data) return <LoadingSpinner />;

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="field-row" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ maxWidth: 220 }}>
            <label>Account Owner</label>
            <select value={filters.owner} onChange={(e) => applyFilter('owner', e.target.value)}>
              {data.my_employee_id && <option value="mine">My customers</option>}
              <option value="">Everyone I can see</option>
              {data.owners.map((o) => <option key={o.id} value={o.id}>{o.name || `Employee #${o.id}`} ({o.n})</option>)}
            </select>
          </div>
          <div className="field" style={{ maxWidth: 160 }}>
            <label>Priority</label>
            <select value={filters.priority} onChange={(e) => applyFilter('priority', e.target.value)}>
              <option value="">Any</option>
              <option value="high">High</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </select>
          </div>
          <div className="field" style={{ maxWidth: 180 }}>
            <label>Reason</label>
            <select value={filters.reason} onChange={(e) => applyFilter('reason', e.target.value)}>
              <option value="">Any</option>
              {['reorder', 'trend', 'visit', 'overdue', 'birthday'].map((r) => <option key={r} value={r}>{REASON_LABELS[r]}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Search</label>
            <input
              value={filters.q} placeholder="Customer name or code"
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') load(0); }}
            />
          </div>
          {data.refreshable && can('/crm-dashboard', 'can_edit') && (
            <div className="field" style={{ maxWidth: 140 }}>
              <button type="button" className="btn" onClick={refresh} disabled={refreshing}>{refreshing ? 'Rebuilding...' : 'Refresh Now'}</button>
            </div>
          )}
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          {data.computed_at ? `Ranked ${new Date(data.computed_at.replace(' ', 'T')).toLocaleString('en-US')} · rebuilt every night` : 'Not computed yet — the list is built by the nightly job.'}
          {' · '}{data.total} customer{data.total === 1 ? '' : 's'}
        </div>
      </div>

      {loading ? <LoadingSpinner /> : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Customer</th><th>Why</th><th>Owner</th><th>Last Order</th><th>Last Visit</th><th>Sales 12m</th><th>Score</th><th /></tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>Nobody needs attention here.</td></tr>}
                {data.rows.map((r) => (
                  <tr key={r.customer_id}>
                    <td>
                      <Link className="link-btn" to={`/customers/${r.customer_id}`}>{r.customer_name}</Link>
                      <div style={{ marginTop: 4 }}>
                        <span className={`badge ${PRIORITY_BADGE[r.crm_priority] || 'badge-muted'}`}>{r.crm_priority}</span>
                      </div>
                    </td>
                    <td style={{ maxWidth: 420 }}>
                      {r.reasons.map((reason, i) => (
                        <div key={i} style={{ marginBottom: 4 }}>
                          <span className={`badge ${REASON_BADGE[reason.code] || 'badge-muted'}`} style={{ marginRight: 6 }}>{REASON_LABELS[reason.code] || reason.code}</span>
                          <span style={{ fontSize: 13 }}>{reason.text}</span>
                        </div>
                      ))}
                    </td>
                    <td>{r.owner_name || '—'}</td>
                    <td>{formatDate(r.last_order_date)}</td>
                    <td>{r.last_visit_at ? formatDate(r.last_visit_at) : 'Never'}</td>
                    <td>{money(r.revenue_12m)}</td>
                    <td><strong>{Math.round(r.score)}</strong></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <Link className="btn btn-sm btn-primary" to={`/customers/${r.customer_id}?tab=activity`}>Plan Visit</Link>{' '}
                      {can('/crm-dashboard', 'can_edit') && (
                        <>
                          <button type="button" className="btn btn-sm" disabled={drafting === r.customer_id} onClick={() => draftEmail(r)}>
                            {drafting === r.customer_id ? 'Writing...' : 'Draft Email'}
                          </button>{' '}
                        </>
                      )}
                      <select
                        className="btn btn-sm" value="" title="Hide from this list for a while"
                        onChange={(e) => e.target.value && snooze(r, Number(e.target.value))}
                      >
                        <option value="">Snooze…</option>
                        <option value="7">1 week</option>
                        <option value="30">1 month</option>
                        <option value="90">3 months</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.total > PAGE && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
              <button type="button" className="btn btn-sm" disabled={offset === 0} onClick={() => load(Math.max(0, offset - PAGE))}>Previous</button>
              <span className="muted">{offset + 1}–{Math.min(offset + PAGE, data.total)} of {data.total}</span>
              <button type="button" className="btn btn-sm" disabled={offset + PAGE >= data.total} onClick={() => load(offset + PAGE)}>Next</button>
            </div>
          )}
        </div>
      )}
      {draft && (
        <DraftEditorModal draft={draft.draft} customerName={draft.customerName} onClose={() => setDraft(null)} />
      )}
    </div>
  );
}
