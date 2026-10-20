import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import EmployeeProfileModal from '../components/EmployeeProfileModal';
import LoadingSpinner from '../components/LoadingSpinner';

export default function Employees() {
  const { can } = useAuth();
  const [rows, setRows] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [companyFilter, setCompanyFilter] = useState('');
  const [editing, setEditing] = useState(null);
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

  function openCreate() { setEditing('new'); }
  function openEdit(row) { setEditing(row.id); }

  async function handleDelete(row) {
    if (!confirm(`Delete employee "${row.first_name} ${row.last_name}"?`)) return;
    try {
      await api.delete(`/employees/${row.id}`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Delete failed');
    }
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
        <EmployeeProfileModal
          employeeId={editing === 'new' ? null : editing}
          isHr={can('/employees', 'can_edit')}
          departments={departments}
          companies={companies}
          locations={locations}
          employees={rows}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}
