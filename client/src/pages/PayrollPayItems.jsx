import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import { formatDate, peso, todayIso } from '../utils/payroll';

const ROUTE = '/payroll-pay-items';
const emptyForm = () => ({
  employee_id: '', item_type: 'allowance', name: '', amount: '', is_taxable: false,
  effective_from: todayIso(), effective_to: '', remarks: '',
});

export default function PayrollPayItems() {
  const { can } = useAuth();
  const [rows, setRows] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    const { data } = await api.get('/payroll-setup/pay-items');
    setRows(data);
    setLoading(false);
  }

  useEffect(() => {
    load();
    api.get('/payroll-setup/employees').then(({ data }) => setEmployees(data)).catch(() => {});
  }, []);

  function open(row) {
    setForm(row ? {
      employee_id: row.employee_id, item_type: row.item_type, name: row.name, amount: row.amount, is_taxable: !!row.is_taxable,
      effective_from: row.effective_from, effective_to: row.effective_to || '', remarks: row.remarks || '',
    } : emptyForm());
    setEditing(row ? row.id : 'new');
    setError('');
  }

  async function save(e) {
    e.preventDefault();
    setError('');
    const payload = { ...form, effective_to: form.effective_to || null };
    try {
      if (editing === 'new') await api.post('/payroll-setup/pay-items', payload);
      else await api.put(`/payroll-setup/pay-items/${editing}`, payload);
      setEditing(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    }
  }

  async function remove(row) {
    if (!confirm(`Delete ${row.employee_name}'s ${row.name}? Payrolls already approved keep it. To stop it from a date instead, set an end date.`)) return;
    await api.delete(`/payroll-setup/pay-items/${row.id}`);
    load();
  }

  const today = todayIso();
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => (!type || r.item_type === type)
      && (!q || [r.employee_name, r.employee_code, r.name, r.company_name].filter(Boolean).join(' ').toLowerCase().includes(q)));
  }, [rows, type, search]);

  const columns = [
    { key: 'employee_name', label: 'Employee', render: (r) => <>{r.employee_name}<div className="muted" style={{ fontSize: 11 }}>{[r.employee_code, r.company_name].filter(Boolean).join(' · ')}</div></> },
    { key: 'item_type', label: 'Type', render: (r) => (r.item_type === 'allowance' ? <span className="badge badge-success">Allowance</span> : <span className="badge badge-danger">Deduction</span>) },
    { key: 'name', label: 'Name', render: (r) => <>{r.name}{r.item_type === 'allowance' && <div className="muted" style={{ fontSize: 11 }}>{r.is_taxable ? 'Taxable' : 'Non-taxable'}</div>}</> },
    { key: 'amount', label: 'Per Payroll', render: (r) => <span className="num">{peso(r.amount)}</span> },
    {
      key: 'dates',
      label: 'Period',
      render: (r) => {
        const ended = r.effective_to && r.effective_to < today;
        return <>{formatDate(r.effective_from)} – {r.effective_to ? formatDate(r.effective_to) : 'ongoing'}{ended && <div><span className="badge badge-muted">Ended</span></div>}</>;
      },
    },
  ];

  return (
    <div>
      <div className="page-header">
        <h1>Allowances &amp; Deductions</h1>
        {can(ROUTE, 'can_add') && <button className="btn btn-primary" onClick={() => open(null)}>Add</button>}
      </div>

      <div className="status-tabs">
        {[['', 'All'], ['allowance', 'Allowances'], ['deduction', 'Deductions']].map(([v, l]) => (
          <button key={v} className={`status-tab ${type === v ? 'active' : ''}`} onClick={() => setType(v)}>{l}</button>
        ))}
      </div>

      <div className="card" style={{ margin: '16px 0' }}>
        <div className="filter-grid">
          <div className="field">
            <label>Search</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Employee, item, company..." />
          </div>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Amounts here are added or deducted in <strong>every</strong> payroll between the dates. For a one-time amount, use an
          adjustment on the payroll itself. Loans have their own page.
        </p>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <DataTable
            paginate
            columns={columns}
            rows={filtered}
            emptyLabel="No recurring allowances or deductions yet."
            actions={(row) => (
              <>
                {can(ROUTE, 'can_edit') && <button className="btn btn-sm" onClick={() => open(row)}>Edit</button>}
                {can(ROUTE, 'can_delete') && <button className="btn btn-sm btn-danger" onClick={() => remove(row)}>Delete</button>}
              </>
            )}
          />
        )}
      </div>

      {editing && (
        <Modal title={editing === 'new' ? 'Add Allowance or Deduction' : 'Edit'} onClose={() => setEditing(null)}>
          <form onSubmit={save}>
            {error && <div className="error-banner">{error}</div>}
            <div className="field">
              <label>Employee</label>
              <select required value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })}>
                <option value="">— Choose —</option>
                {employees.map((emp) => <option key={emp.id} value={emp.id}>{emp.name}{emp.company_name ? ` (${emp.company_name})` : ''}</option>)}
              </select>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Type</label>
                <select value={form.item_type} onChange={(e) => setForm({ ...form, item_type: e.target.value })}>
                  <option value="allowance">Allowance (added to pay)</option>
                  <option value="deduction">Deduction (taken from pay)</option>
                </select>
              </div>
              <div className="field">
                <label>Amount per Payroll</label>
                <input type="number" step="0.01" min="0.01" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label>Name</label>
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={form.item_type === 'allowance' ? 'e.g. Rice allowance, Transportation' : 'e.g. Uniform, HMO dependent'} />
            </div>
            {form.item_type === 'allowance' && (
              <div className="field field-checkbox">
                <input type="checkbox" id="item-taxable" checked={form.is_taxable} onChange={(e) => setForm({ ...form, is_taxable: e.target.checked })} />
                <label htmlFor="item-taxable">Taxable (leave unticked for de minimis benefits such as rice or uniform allowance)</label>
              </div>
            )}
            <div className="field-row">
              <div className="field">
                <label>From</label>
                <input type="date" required value={form.effective_from} onChange={(e) => setForm({ ...form, effective_from: e.target.value })} />
              </div>
              <div className="field">
                <label>Until (optional)</label>
                <input type="date" min={form.effective_from} value={form.effective_to} onChange={(e) => setForm({ ...form, effective_to: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label>Remarks</label>
              <input value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Save</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
