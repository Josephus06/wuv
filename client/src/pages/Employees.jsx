import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';

const EMPTY = {
  employee_code: '', first_name: '', last_name: '', department_id: '', company_id: '', branch_id: '',
  position_title: '', email: '', phone: '', date_hired: '', is_active: true,
};

export default function Employees() {
  const { can } = useAuth();
  const [rows, setRows] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [companyFilter, setCompanyFilter] = useState('');
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');

  async function load() {
    setLoading(true);
    const [emp, dept, comp, loc] = await Promise.all([
      api.get('/employees'),
      api.get('/lookups/departments'),
      api.get('/lookups/companies'),
      api.get('/lookups/locations'),
    ]);
    setRows(emp.data);
    setDepartments(dept.data);
    setCompanies(comp.data.filter((c) => c.is_active).sort((a, b) => a.name.localeCompare(b.name)));
    setLocations(loc.data.filter((l) => l.is_active).sort((a, b) => a.location_name.localeCompare(b.location_name)));
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function openCreate() {
    setForm(EMPTY);
    setEditing('new');
    setError('');
  }

  function openEdit(row) {
    setForm({
      employee_code: row.employee_code || '',
      first_name: row.first_name || '',
      last_name: row.last_name || '',
      department_id: row.department_id || '',
      company_id: row.company_id || '',
      branch_id: row.branch_id || '',
      position_title: row.position_title || '',
      email: row.email || '',
      phone: row.phone || '',
      date_hired: row.date_hired ? row.date_hired.slice(0, 10) : '',
      is_active: !!row.is_active,
    });
    setEditing(row.id);
    setError('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const payload = {
      ...form,
      department_id: form.department_id || null,
      company_id: form.company_id || null,
      branch_id: form.branch_id || null,
      date_hired: form.date_hired || null,
    };
    try {
      if (editing === 'new') {
        await api.post('/employees', payload);
      } else {
        await api.put(`/employees/${editing}`, payload);
      }
      setEditing(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    }
  }

  async function handleDelete(row) {
    if (!confirm(`Delete employee "${row.first_name} ${row.last_name}"?`)) return;
    try {
      await api.delete(`/employees/${row.id}`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Delete failed');
    }
  }

  // Branches offered for the chosen company: its own, plus any location no company has been
  // set on yet (so nothing is unpickable before Lookups > Locations is filled in). The
  // employee's current branch stays listed even if it no longer fits, so editing doesn't
  // silently blank it.
  const branchOptions = locations.filter((l) => (
    !l.company_id || String(l.company_id) === String(form.company_id) || String(l.id) === String(form.branch_id)
  ));

  function setCompany(companyId) {
    const branch = locations.find((l) => String(l.id) === String(form.branch_id));
    const keepBranch = branch && (!branch.company_id || String(branch.company_id) === String(companyId));
    setForm({ ...form, company_id: companyId, branch_id: keepBranch ? form.branch_id : '' });
  }

  const companyRows = companyFilter
    ? rows.filter((r) => (companyFilter === 'none' ? !r.company_id : String(r.company_id) === companyFilter))
    : rows;
  const activeCount = companyRows.filter((r) => r.is_active).length;
  const inactiveCount = companyRows.length - activeCount;

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return companyRows.filter((r) => {
      if (status === 'active' && !r.is_active) return false;
      if (status === 'inactive' && r.is_active) return false;
      if (!q) return true;
      const haystack = [r.employee_code, r.first_name, r.last_name, r.company_name, r.branch_name, r.department_name, r.position_title, r.email]
        .filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [companyRows, status, search]);

  const columns = [
    { key: 'employee_code', label: 'Code' },
    { key: 'name', label: 'Name', render: (r) => `${r.first_name} ${r.last_name}` },
    { key: 'company_name', label: 'Company', render: (r) => r.company_name || <span className="muted">—</span> },
    { key: 'branch_name', label: 'Branch', render: (r) => r.branch_name || <span className="muted">—</span> },
    { key: 'department_name', label: 'Department' },
    { key: 'position_title', label: 'Position' },
    { key: 'email', label: 'Email' },
    { key: 'is_active', label: 'Status', render: (r) => (r.is_active ? <span className="badge badge-success">Active</span> : <span className="badge badge-muted">Inactive</span>) },
  ];

  return (
    <div>
      <div className="page-header">
        <h1>Employees</h1>
        {can('/employees', 'can_add') && <button className="btn btn-primary" onClick={openCreate}>Add Employee</button>}
      </div>

      <div className="status-tabs">
        <button className={`status-tab ${status === '' ? 'active' : ''}`} onClick={() => setStatus('')}>All ({companyRows.length})</button>
        <button className={`status-tab ${status === 'active' ? 'active' : ''}`} onClick={() => setStatus('active')}>Active ({activeCount})</button>
        <button className={`status-tab ${status === 'inactive' ? 'active' : ''}`} onClick={() => setStatus('inactive')}>Inactive ({inactiveCount})</button>
      </div>

      <div className="card" style={{ marginBottom: 16, marginTop: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Search</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Code, name, company, branch, department, position, email..." />
          </div>
          <div className="field">
            <label>Company</label>
            <select value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)}>
              <option value="">All companies</option>
              {companies.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
              <option value="none">No company set</option>
            </select>
          </div>
        </div>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <DataTable
            paginate
            columns={columns}
            rows={filteredRows}
            emptyLabel="No employees match this filter."
            actions={(row) => (
              <>
                {can('/employees', 'can_edit') && <button className="btn btn-sm" onClick={() => openEdit(row)}>Edit</button>}
                {can('/employees', 'can_delete') && <button className="btn btn-sm btn-danger" onClick={() => handleDelete(row)}>Delete</button>}
              </>
            )}
          />
        )}
      </div>

      {editing && (
        <Modal title={editing === 'new' ? 'Add Employee' : 'Edit Employee'} onClose={() => setEditing(null)}>
          <form onSubmit={handleSubmit}>
            {error && <div className="error-banner">{error}</div>}
            <div className="field-row">
              <div className="field">
                <label>Employee Code</label>
                <input value={form.employee_code} onChange={(e) => setForm({ ...form, employee_code: e.target.value })} />
              </div>
              <div className="field">
                <label>Department</label>
                <select value={form.department_id} onChange={(e) => setForm({ ...form, department_id: e.target.value })}>
                  <option value="">—</option>
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>First Name</label>
                <input required value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
              </div>
              <div className="field">
                <label>Last Name</label>
                <input required value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Company</label>
                <select value={form.company_id} onChange={(e) => setCompany(e.target.value)}>
                  <option value="">—</option>
                  {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Branch</label>
                <select value={form.branch_id} onChange={(e) => setForm({ ...form, branch_id: e.target.value })} disabled={!form.company_id}>
                  <option value="">{form.company_id ? '—' : 'Pick a company first'}</option>
                  {branchOptions.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
                </select>
              </div>
            </div>
            <div className="field">
              <label>Position Title</label>
              <input value={form.position_title} onChange={(e) => setForm({ ...form, position_title: e.target.value })} />
            </div>
            <div className="field-row">
              <div className="field">
                <label>Email</label>
                <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="field">
                <label>Phone</label>
                <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Date Hired</label>
                <input type="date" value={form.date_hired} onChange={(e) => setForm({ ...form, date_hired: e.target.value })} />
              </div>
              <div className="field field-checkbox" style={{ alignSelf: 'center', marginTop: 18 }}>
                <input type="checkbox" id="emp-active" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
                <label htmlFor="emp-active">Active</label>
              </div>
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
