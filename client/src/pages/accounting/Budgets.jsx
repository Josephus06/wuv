import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../../api/client';
import { useAuth } from '../../context/useAuth';
import LoadingSpinner from '../../components/LoadingSpinner';
import Modal from '../../components/Modal';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
const STATUS = { draft: 'Draft', approved: 'Approved', superseded: 'Superseded' };
const STATUS_BADGE = { draft: 'badge-warning', approved: 'badge-success', superseded: '' };
const SCOPE = { pl: 'P&L', pl_capex: 'P&L + Capital Spending' };
const KIND = { department: 'By department (Admin / Selling / COGS)', account: 'By account' };
const thisYear = new Date().getFullYear();

// Accounting > Budgets: one budget per fiscal year (January-December) for the whole company, one
// department or one location. Drafts are edited in the grid; the General Manager approves.
export default function Budgets() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [year, setYear] = useState(String(thisYear));
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);

  async function load() {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/budgets', { params: year ? { year } : {} });
      setRows(data);
    } catch (e) { setError(e.response?.data?.error || 'Could not load budgets.'); }
    setLoading(false);
  }
  useEffect(() => { load(); }, [year]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div className="page-header">
        <h1>Budgets</h1>
        {can('/budgets', 'can_add') && <button className="btn btn-primary" onClick={() => setShowNew(true)}>New Budget</button>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Fiscal Year</label>
            <select value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="">--ALL--</option>
              {[thisYear + 1, thisYear, thisYear - 1, thisYear - 2].map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Name</th><th>Year</th><th>Type</th><th>Budgeted By</th><th>Covers</th><th>Version</th><th>Status</th><th className="text-right">Annual Total</th><th>Approved By</th><th></th></tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 20 }}>No budgets yet.</td></tr>}
                {rows.map((b) => (
                  <tr key={b.id}>
                    <td>{b.name}</td>
                    <td>{b.fiscal_year}</td>
                    <td>{KIND[b.kind] || KIND.account}</td>
                    <td>{b.kind === 'department' ? '—' : b.dimension_label}</td>
                    <td>{b.kind === 'department' ? '—' : SCOPE[b.scope]}</td>
                    <td>v{b.version}</td>
                    <td><span className={`badge ${STATUS_BADGE[b.status]}`}>{STATUS[b.status]}</span></td>
                    <td className="text-right">{money(b.total)}</td>
                    <td>{b.approved_by_name || ''}</td>
                    <td><Link className="btn btn-sm btn-primary" to={`/budgets/${b.id}`}>Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showNew && <NewBudgetModal onClose={() => setShowNew(false)} onCreated={(b) => navigate(`/budgets/${b.id}`)} />}
    </div>
  );
}

function NewBudgetModal({ onClose, onCreated }) {
  const [meta, setMeta] = useState(null);
  const [form, setForm] = useState({ kind: 'department', name: '', fiscal_year: String(thisYear + 1), sales_target: '', dimension: 'company', department_id: '', location_id: '', scope: 'pl' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  useEffect(() => { api.get('/budgets/meta').then(({ data }) => setMeta(data)).catch(() => setMeta({ departments: [], locations: [] })); }, []);

  async function save() {
    setSaving(true); setError('');
    try {
      const { data } = await api.post('/budgets', form);
      onCreated(data);
    } catch (e) { setError(e.response?.data?.error || 'Could not create the budget.'); }
    setSaving(false);
  }

  return (
    <Modal title="New Budget" onClose={onClose}>
      {!meta ? <LoadingSpinner /> : (
        <>
          {error && <div className="error-banner">{error}</div>}
          <div className="field"><label>Name</label>
            <input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. 2027 Operating Budget" />
          </div>
          <div className="field"><label>Fiscal Year (January - December)</label>
            <select value={form.fiscal_year} onChange={(e) => set({ fiscal_year: e.target.value })}>
              {[thisYear + 1, thisYear, thisYear - 1].map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div className="field"><label>Type</label>
            <select value={form.kind} onChange={(e) => set({ kind: e.target.value })}>
              <option value="department">By department: Admin / Selling / COGS (the accounting workbook's format)</option>
              <option value="account">By account (detailed, per GL account)</option>
            </select>
          </div>
          {form.kind === 'department' && (
            <div className="field"><label>Monthly Sales Target</label>
              <input type="number" step="0.01" value={form.sales_target} onChange={(e) => set({ sales_target: e.target.value })} placeholder="e.g. 8500000" />
            </div>
          )}
          {form.kind === 'account' && (<>
          <div className="field"><label>Budgeted By</label>
            <select value={form.dimension} onChange={(e) => set({ dimension: e.target.value })}>
              <option value="company">Whole company</option>
              <option value="department">Department</option>
              <option value="location">Location</option>
            </select>
          </div>
          {form.dimension === 'department' && (
            <div className="field"><label>Department</label>
              <select value={form.department_id} onChange={(e) => set({ department_id: e.target.value })}>
                <option value="">--Select--</option>
                {meta.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
          )}
          {form.dimension === 'location' && (
            <div className="field"><label>Location</label>
              <select value={form.location_id} onChange={(e) => set({ location_id: e.target.value })}>
                <option value="">--Select--</option>
                {meta.locations.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
              </select>
            </div>
          )}
          <div className="field"><label>Covers</label>
            <select value={form.scope} onChange={(e) => set({ scope: e.target.value })}>
              <option value="pl">P&amp;L only (revenue, cost of sales, expenses)</option>
              <option value="pl_capex">P&amp;L + capital spending (fixed assets)</option>
            </select>
          </div>
          </>)}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Creating...' : 'Create'}</button>
          </div>
        </>
      )}
    </Modal>
  );
}
