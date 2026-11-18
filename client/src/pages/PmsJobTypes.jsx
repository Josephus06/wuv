import { useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayAuditTime } from '../utils/dates';

// Mirrors the real system's "Master Lists > PMS - Job Types" screen: a granular,
// time-tracking breakdown of production tasks (e.g. "RFNO" / "DESIGN-Ready file with
// no changes" / 9.75 minutes), each tagged to one ERP Job Type (the plain "Job Types"
// master, our existing job_types lookup) and one Department ("Group"). Add/Edit uses
// the same searchable EntityPicker modal as the rest of the app for those two links
// (the real form's "Search Jobs" / "Departments" pickers), not plain <select>s.
const EMPTY = { code: '', display_name: '', minutes_consume: '', job_type_id: '', department_id: '' };

function jobTypeLabel(jt) { return jt ? jt.display_name : ''; }
function departmentLabel(d) { return d ? d.name : ''; }

export default function PmsJobTypes() {
  const { can } = useAuth();
  const [rows, setRows] = useState([]);
  const [jobTypes, setJobTypes] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [auditLogs, setAuditLogs] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  async function load(searchValue = search) {
    setLoading(true);
    const [p, jt, dept] = await Promise.all([
      api.get('/pms-job-types', { params: searchValue ? { search: searchValue } : {} }),
      api.get('/job-types'),
      api.get('/lookups/departments'),
    ]);
    setRows(p.data);
    setJobTypes(jt.data);
    setDepartments(dept.data);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function openCreate() {
    setForm(EMPTY);
    setEditing('new');
    setAuditLogs([]);
    setError('');
  }

  async function openEdit(row) {
    const { data } = await api.get(`/pms-job-types/${row.id}`);
    setForm({
      code: data.code, display_name: data.display_name, minutes_consume: data.minutes_consume ?? '',
      job_type_id: data.job_type_id || '', department_id: data.department_id || '',
    });
    setEditing(data);
    setError('');
    const { data: logs } = await api.get(`/pms-job-types/${row.id}/audit-logs`);
    setAuditLogs(logs);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const payload = { ...form, job_type_id: form.job_type_id || null, department_id: form.department_id || null };
    try {
      if (editing === 'new') {
        await api.post('/pms-job-types', payload);
        setEditing(null);
      } else {
        await api.put(`/pms-job-types/${editing.id}`, payload);
        await openEdit(editing);
      }
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    }
  }

  async function handleDelete(row) {
    if (!confirm(`Delete PMS job type "${row.display_name}"?`)) return;
    try {
      await api.delete(`/pms-job-types/${row.id}`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Delete failed');
    }
  }

  function runSearch() {
    load(search);
  }

  const columns = [
    { key: 'code', label: 'Code' },
    { key: 'display_name', label: 'Display Name' },
    { key: 'minutes_consume', label: 'Minutes Consume' },
    { key: 'job_type_name', label: 'ERP Job Type' },
    { key: 'department_name', label: 'Group' },
  ];

  return (
    <div>
      <div className="page-header">
        <h1>PMS Job Types</h1>
        {can('/pms-job-types', 'can_add') && <button className="btn btn-primary" onClick={openCreate}>Add Job Type</button>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Search</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="Code or display name..." />
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={runSearch}>Search</button>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <DataTable
            paginate
            columns={columns}
            rows={rows}
            actions={(row) => (
              <>
                {can('/pms-job-types', 'can_edit') && <button className="btn btn-sm" onClick={() => openEdit(row)}>Edit</button>}
                {can('/pms-job-types', 'can_delete') && <button className="btn btn-sm btn-danger" onClick={() => handleDelete(row)}>Delete</button>}
              </>
            )}
          />
        )}
      </div>

      {editing && (
        <Modal title={editing === 'new' ? 'Add Job Type' : `Edit Job Type — ${editing.display_name}`} onClose={() => setEditing(null)} large>
          <form onSubmit={handleSubmit}>
            {error && <div className="error-banner">{error}</div>}
            <div className="field-row">
              <div className="field">
                <label>Code</label>
                <input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
              </div>
              <div className="field">
                <label>Minutes Consume</label>
                <input type="number" step="0.01" value={form.minutes_consume} onChange={(e) => setForm({ ...form, minutes_consume: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label>Display Name</label>
              <input required value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
            </div>
            <div className="field-row">
              <div className="field">
                <label>WVI - Job Type</label>
                <EntityPicker
                  label="WVI Job Type" items={jobTypes} value={form.job_type_id} getLabel={jobTypeLabel}
                  columns={[{ key: 'display_name', label: 'Display Name' }]} searchKeys={['display_name']}
                  onSelect={(jt) => setForm({ ...form, job_type_id: jt.id })}
                />
              </div>
              <div className="field">
                <label>Group</label>
                <EntityPicker
                  label="Department" items={departments} value={form.department_id} getLabel={departmentLabel}
                  columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']}
                  onSelect={(d) => setForm({ ...form, department_id: d.id })}
                />
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setEditing(null)}>Close</button>
              <button type="submit" className="btn btn-primary">Save</button>
            </div>
          </form>

          {editing !== 'new' && (
            <div className="subsection">
              <h3>System Information</h3>
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
        </Modal>
      )}
    </div>
  );
}
