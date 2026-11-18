import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDateTime } from '../utils/dates';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDateTime(v) { return v ? displayDateTime(v) : '—'; }
function currentYear() { return new Date().getFullYear(); }

// Mirrors the real Employee Quota detail: the employee's name in a banner, an Employee
// Quotas tab holding the per-month target grid (Year / Month / Quota), a System
// Information tab, and Back/Edit. Edit turns the grid editable and saves it in one shot.
export default function EmployeeQuotaView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [emp, setEmp] = useState(null);
  const [tab, setTab] = useState('quotas');
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function toRows(quotas) {
    return quotas.map((q, i) => ({ ...q, key: `q-${q.id ?? i}` }));
  }

  function load() {
    return api.get(`/employee-quotas/${id}`).then(({ data }) => {
      setEmp(data);
      setRows(toRows(data.quotas));
      setLoading(false);
    });
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const canEdit = can('/employee-quotas', 'can_edit');

  function updateRow(key, patch) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((prev) => [...prev, { key: `new-${prev.length}-${prev.reduce((s, r) => s + r.key.length, 0)}`, year: currentYear(), month: 1, quota: '' }]);
  }
  // Fills all twelve months of a chosen year with one amount -- the real data shows a flat
  // quota repeated across every month, so seeding a year at once is the common path.
  function fillYear() {
    const yStr = prompt('Fill a full year of quotas. Enter the year:', String(currentYear()));
    if (!yStr) return;
    const year = Number(yStr);
    if (!Number.isInteger(year)) { alert('Enter a valid year.'); return; }
    const aStr = prompt('Quota amount for every month of ' + year + ':', '0');
    if (aStr === null) return;
    const quota = Number(aStr) || 0;
    setRows((prev) => {
      const kept = prev.filter((r) => Number(r.year) !== year);
      const filled = MONTHS.map((_, i) => ({ key: `fill-${year}-${i}`, year, month: i + 1, quota }));
      return [...kept, ...filled].sort((a, b) => b.year - a.year || b.month - a.month);
    });
  }

  function startEdit() { setEditing(true); setError(''); }
  function cancelEdit() { setEditing(false); setRows(toRows(emp.quotas)); setError(''); }

  async function save() {
    setError('');
    const seen = new Set();
    for (const r of rows) {
      if (!r.year || !r.month) { setError('Every row needs a Year and Month.'); return; }
      const key = `${r.year}-${r.month}`;
      if (seen.has(key)) { setError(`${r.year} ${MONTHS[r.month - 1]} appears twice. Each month can have only one quota.`); return; }
      seen.add(key);
    }
    setSaving(true);
    try {
      await api.put(`/employee-quotas/${id}`, {
        quotas: rows.map((r) => ({ year: Number(r.year), month: Number(r.month), quota: Number(r.quota) || 0 })),
      });
      setEditing(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (loading || !emp) return <LoadingSpinner />;

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={'/employee-quotas'}>Back</Link>
          {canEdit && !editing && <button className="btn btn-sm btn-primary" onClick={startEdit}>Edit</button>}
          {editing && <button className="btn btn-sm btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>}
          {editing && <button className="btn btn-sm" onClick={cancelEdit}>Cancel</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>{emp.employee_name}</h1>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'quotas' ? 'active' : ''}`} onClick={() => setTab('quotas')}>Employee Quotas</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Information</button>
      </div>

      {tab === 'quotas' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Year</th><th>Month</th><th style={{ textAlign: 'right' }}>Quota</th>{editing && <th></th>}</tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={editing ? 4 : 3} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    No quotas set.{editing ? ' Use Add Row or Fill Year below.' : ''}
                  </td></tr>
                )}
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td>
                      {editing
                        ? <input type="number" style={{ width: 90 }} value={r.year} onChange={(e) => updateRow(r.key, { year: e.target.value })} />
                        : r.year}
                    </td>
                    <td>
                      {editing ? (
                        <select value={r.month} onChange={(e) => updateRow(r.key, { month: Number(e.target.value) })}>
                          {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                        </select>
                      ) : MONTHS[r.month - 1]}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {editing
                        ? <input type="number" step="0.01" style={{ width: 160 }} value={r.quota} onChange={(e) => updateRow(r.key, { quota: e.target.value })} />
                        : money(r.quota)}
                    </td>
                    {editing && <td><button className="btn btn-sm" onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}>Delete</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {editing && (
            <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" onClick={addRow}>Add Row</button>
              <button className="btn" onClick={fillYear}>Fill Year...</button>
            </div>
          )}
        </div>
      )}

      {tab === 'system' && (
        <div className="card">
          <div className="estimate-detail-grid">
            <div>
              <div>Employee : <span className="hi">{emp.employee_name}</span></div>
              <div>Code : <span className="hi">{emp.employee_code || '—'}</span></div>
            </div>
            <div>
              <div>Position : <span className="hi">{emp.position_title || '—'}</span></div>
              <div>Department : <span className="hi">{emp.department_name || '—'}</span></div>
              <div>Employee Since : <span className="hi">{formatDateTime(emp.created_at)}</span></div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
