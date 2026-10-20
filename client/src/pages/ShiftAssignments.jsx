import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import { WEEKDAYS, formatDate, formatDays, formatShiftHours } from '../utils/attendance';

const STATUSES = [
  { value: 'current', label: 'Current' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'ended', label: 'Ended' },
  { value: 'all', label: 'All' },
];

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const emptyForm = () => ({
  employee_ids: [], shift_id: '', effective_from: todayIso(), effective_to: '', days_of_week: [1, 2, 3, 4, 5], notes: '',
});

export default function ShiftAssignments() {
  const { can } = useAuth();
  const [rows, setRows] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [status, setStatus] = useState('current');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // 'new' | assignment row
  const [form, setForm] = useState(emptyForm);
  const [pickerSearch, setPickerSearch] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    setLoading(true);
    const { data } = await api.get('/shift-assignments', { params: { status } });
    setRows(data);
    setLoading(false);
  }

  useEffect(() => { load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    Promise.all([api.get('/shifts'), api.get('/shift-assignments/employees')]).then(([s, e]) => {
      setShifts(s.data);
      setEmployees(e.data);
    });
  }, []);

  function openCreate() {
    setForm(emptyForm());
    setPickerSearch('');
    setEditing('new');
    setError('');
  }

  function openEdit(row) {
    setForm({
      employee_ids: [row.employee_id],
      shift_id: String(row.shift_id),
      effective_from: row.effective_from,
      effective_to: row.effective_to || '',
      days_of_week: row.days_of_week.split(',').map(Number),
      notes: row.notes || '',
    });
    setEditing(row);
    setError('');
  }

  function toggleDay(day) {
    setForm((f) => ({
      ...f,
      days_of_week: f.days_of_week.includes(day) ? f.days_of_week.filter((d) => d !== day) : [...f.days_of_week, day],
    }));
  }

  function toggleEmployee(id) {
    setForm((f) => ({
      ...f,
      employee_ids: f.employee_ids.includes(id) ? f.employee_ids.filter((x) => x !== id) : [...f.employee_ids, id],
    }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const payload = { ...form, effective_to: form.effective_to || null };
    try {
      if (editing === 'new') {
        const { data } = await api.post('/shift-assignments', payload);
        setNotice([`Assigned ${data.created.length} employee(s).`, ...data.ended].join(' '));
      } else {
        await api.put(`/shift-assignments/${editing.id}`, payload);
        setNotice('Assignment updated.');
      }
      setEditing(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    }
  }

  async function handleDelete(row) {
    if (!confirm(`Remove ${row.employee_name}'s ${row.shift_name} assignment (${row.effective_from} to ${row.effective_to || 'open-ended'})?`)) return;
    try {
      await api.delete(`/shift-assignments/${row.id}`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Delete failed');
    }
  }

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => [r.employee_code, r.employee_name, r.department_name, r.shift_name]
      .filter(Boolean).join(' ').toLowerCase().includes(q));
  }, [rows, search]);

  const pickerEmployees = useMemo(() => {
    const q = pickerSearch.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((e) => [e.employee_code, e.name, e.department_name].filter(Boolean).join(' ').toLowerCase().includes(q));
  }, [employees, pickerSearch]);

  const activeShifts = shifts.filter((s) => s.is_active || String(s.id) === form.shift_id);

  const columns = [
    { key: 'employee_name', label: 'Employee', render: (r) => <>{r.employee_name}{r.employee_code && <span className="muted"> · {r.employee_code}</span>}</> },
    { key: 'department_name', label: 'Department' },
    { key: 'shift_name', label: 'Shift', render: (r) => <>{r.shift_name} <span className="muted">({formatShiftHours(r.start_time, r.end_time)})</span></> },
    { key: 'days_of_week', label: 'Days', render: (r) => formatDays(r.days_of_week) },
    { key: 'effective_from', label: 'From', render: (r) => formatDate(r.effective_from) },
    { key: 'effective_to', label: 'To', render: (r) => (r.effective_to ? formatDate(r.effective_to) : <span className="muted">Open-ended</span>) },
    { key: 'notes', label: 'Notes' },
  ];

  return (
    <div>
      <div className="page-header">
        <h1>Shift Assignments</h1>
        {can('/shift-assignments', 'can_add') && <button className="btn btn-primary" onClick={openCreate}>Assign Shift</button>}
      </div>

      {notice && <div className="success-banner">{notice}</div>}

      <div className="status-tabs">
        {STATUSES.map((s) => (
          <button key={s.value} className={`status-tab ${status === s.value ? 'active' : ''}`} onClick={() => setStatus(s.value)}>{s.label}</button>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 16, marginTop: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Search</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Employee, department, shift..." />
          </div>
        </div>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <DataTable
            paginate
            columns={columns}
            rows={filteredRows}
            emptyLabel="No shift assignments match this filter."
            actions={(row) => (
              <>
                {can('/shift-assignments', 'can_edit') && <button className="btn btn-sm" onClick={() => openEdit(row)}>Edit</button>}
                {can('/shift-assignments', 'can_delete') && <button className="btn btn-sm btn-danger" onClick={() => handleDelete(row)}>Delete</button>}
              </>
            )}
          />
        )}
      </div>

      {editing && (
        <Modal title={editing === 'new' ? 'Assign Shift' : `Edit Assignment · ${editing.employee_name}`} onClose={() => setEditing(null)} large={editing === 'new'}>
          <form onSubmit={handleSubmit}>
            {error && <div className="error-banner">{error}</div>}

            {editing === 'new' && (
              <div className="field">
                <label>Employees ({form.employee_ids.length} selected)</label>
                <input value={pickerSearch} onChange={(e) => setPickerSearch(e.target.value)} placeholder="Search name, code, department..." style={{ marginBottom: 6 }} />
                <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 6 }}>
                  {pickerEmployees.map((emp) => (
                    <label key={emp.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', cursor: 'pointer', fontWeight: 400 }}>
                      <input type="checkbox" checked={form.employee_ids.includes(emp.id)} onChange={() => toggleEmployee(emp.id)} />
                      <span>{emp.name}</span>
                      <span className="muted" style={{ fontSize: 12 }}>{[emp.employee_code, emp.department_name].filter(Boolean).join(' · ')}</span>
                    </label>
                  ))}
                  {!pickerEmployees.length && <div className="muted" style={{ padding: 6 }}>No active employees match.</div>}
                </div>
              </div>
            )}

            <div className="field">
              <label>Shift</label>
              <select required value={form.shift_id} onChange={(e) => setForm({ ...form, shift_id: e.target.value })}>
                <option value="">— Choose a shift —</option>
                {activeShifts.map((s) => (
                  <option key={s.id} value={s.id}>{s.name} ({formatShiftHours(s.start_time, s.end_time)})</option>
                ))}
              </select>
            </div>

            <div className="field">
              <label>Working Days</label>
              <div className="day-picker">
                {WEEKDAYS.map((d) => (
                  <button type="button" key={d.value} className={`btn btn-sm ${form.days_of_week.includes(d.value) ? 'is-on' : ''}`} onClick={() => toggleDay(d.value)}>
                    {d.short}
                  </button>
                ))}
              </div>
            </div>

            <div className="field-row">
              <div className="field">
                <label>Effective From</label>
                <input type="date" required value={form.effective_from} onChange={(e) => setForm({ ...form, effective_from: e.target.value })} />
              </div>
              <div className="field">
                <label>Effective To (optional)</label>
                <input type="date" value={form.effective_to} min={form.effective_from} onChange={(e) => setForm({ ...form, effective_to: e.target.value })} />
              </div>
            </div>
            {editing === 'new' && (
              <p className="muted" style={{ marginTop: -4 }}>
                {form.effective_to
                  ? 'A temporary assignment: it takes priority for these dates, and the employee’s regular schedule resumes afterwards.'
                  : 'An employee’s current open-ended assignment will end the day before this one starts.'}
              </p>
            )}

            <div className="field">
              <label>Notes</label>
              <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>

            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={editing === 'new' && !form.employee_ids.length}>Save</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
