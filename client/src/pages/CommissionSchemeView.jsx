import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDateTime } from '../utils/dates';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDateTime(v) { return v ? displayDateTime(v) : '—'; }

// Mirrors the real Commission Table detail: the scheme name in a banner, a Schemes tab
// holding the bracket ladder (Total Weighted Sales range -> Sales Credit/Commission
// Amount / Commission Rate), a System Information tab, and Back/Edit. Edit turns the
// whole ladder into an editable grid saved in one shot, matching the real page-level Edit.
export default function CommissionSchemeView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [scheme, setScheme] = useState(null);
  const [tab, setTab] = useState('schemes');
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function load() {
    return api.get(`/commission-schemes/${id}`).then(({ data }) => {
      setScheme(data);
      setName(data.name);
      setRows(data.brackets.map((b, i) => ({ ...b, key: `b-${b.id ?? i}` })));
      setLoading(false);
    });
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const canEdit = can('/commission-schemes', 'can_edit');

  function updateRow(key, patch) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((prev) => [...prev, {
      key: `new-${prev.length}-${prev.reduce((s, r) => s + r.key.length, 0)}`,
      min_weighted_sales: '', max_weighted_sales: '', commission_amount: '', commission_rate: '',
    }]);
  }

  function startEdit() { setEditing(true); setError(''); }
  function cancelEdit() {
    setEditing(false);
    setName(scheme.name);
    setRows(scheme.brackets.map((b, i) => ({ ...b, key: `b-${b.id ?? i}` })));
    setError('');
  }

  async function save() {
    setError('');
    if (!name.trim()) { setError('Scheme name is required.'); return; }
    for (const r of rows) {
      if (r.min_weighted_sales === '' || r.max_weighted_sales === '') { setError('Every bracket needs a From and To.'); return; }
      if (Number(r.max_weighted_sales) < Number(r.min_weighted_sales)) { setError("A bracket's To can't be less than its From."); return; }
    }
    setSaving(true);
    try {
      await api.put(`/commission-schemes/${id}`, {
        name: name.trim(),
        brackets: rows.map((r) => ({
          min_weighted_sales: Number(r.min_weighted_sales),
          max_weighted_sales: Number(r.max_weighted_sales),
          commission_amount: Number(r.commission_amount) || 0,
          commission_rate: Number(r.commission_rate) || 0,
        })),
      });
      setEditing(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (loading || !scheme) return <LoadingSpinner />;

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={'/commission-schemes'}>Back</Link>
          {canEdit && !editing && <button className="btn btn-sm btn-primary" onClick={startEdit}>Edit</button>}
          {editing && <button className="btn btn-sm btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>}
          {editing && <button className="btn btn-sm" onClick={cancelEdit}>Cancel</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          {editing
            ? <input value={name} onChange={(e) => setName(e.target.value)} style={{ fontSize: 24, fontWeight: 700, minWidth: 320 }} />
            : <h1>{scheme.name}</h1>}
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'schemes' ? 'active' : ''}`} onClick={() => setTab('schemes')}>Schemes</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Information</button>
      </div>

      {tab === 'schemes' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Total Weighted Sales</th>
                  <th style={{ textAlign: 'right' }}>Sales Credit/Commission Amount</th>
                  <th style={{ textAlign: 'right' }}>Commission Rate</th>
                  {editing && <th></th>}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={editing ? 4 : 3} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    No brackets yet.{editing ? ' Use Add Bracket below.' : ''}
                  </td></tr>
                )}
                {rows.map((r) => (
                  <tr key={r.key}>
                    {editing ? (
                      <td>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <input type="number" step="0.01" style={{ width: 150 }} value={r.min_weighted_sales} onChange={(e) => updateRow(r.key, { min_weighted_sales: e.target.value })} placeholder="From" />
                          <span>-</span>
                          <input type="number" step="0.01" style={{ width: 150 }} value={r.max_weighted_sales} onChange={(e) => updateRow(r.key, { max_weighted_sales: e.target.value })} placeholder="To" />
                        </div>
                      </td>
                    ) : (
                      <td>{money(r.min_weighted_sales)} - {money(r.max_weighted_sales)}</td>
                    )}
                    {editing ? (
                      <td style={{ textAlign: 'right' }}><input type="number" step="0.01" style={{ width: 140 }} value={r.commission_amount} onChange={(e) => updateRow(r.key, { commission_amount: e.target.value })} /></td>
                    ) : (
                      <td style={{ textAlign: 'right' }}>{money(r.commission_amount)}</td>
                    )}
                    {editing ? (
                      <td style={{ textAlign: 'right' }}><input type="number" step="0.01" style={{ width: 140 }} value={r.commission_rate} onChange={(e) => updateRow(r.key, { commission_rate: e.target.value })} /></td>
                    ) : (
                      <td style={{ textAlign: 'right' }}>{money(r.commission_rate)}</td>
                    )}
                    {editing && (
                      <td><button className="btn btn-sm" onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}>Delete</button></td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {editing && <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={addRow}>Add Bracket</button>}
        </div>
      )}

      {tab === 'system' && (
        <div className="card">
          <div className="estimate-detail-grid">
            <div>
              <div>Scheme ID : <span className="hi">{scheme.id}</span></div>
              <div>Status : <span className="hi">{scheme.is_active ? 'Active' : 'Inactive'}</span></div>
            </div>
            <div>
              <div>Created By : <span className="hi">{scheme.created_by_name || '—'}</span></div>
              <div>Created At : <span className="hi">{formatDateTime(scheme.created_at)}</span></div>
              <div>Last Updated : <span className="hi">{formatDateTime(scheme.updated_at)}</span></div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
