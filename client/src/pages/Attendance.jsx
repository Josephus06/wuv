import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import {
  formatDate, formatLocalTime, formatMinutes, statusBadgeClass, toInputValue,
} from '../utils/attendance';

const STATUSES = ['Present', 'Late', 'Absent', 'No Time Out', 'On Duty', 'Scheduled'];

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function scheduleLabel(r) {
  if (!r.scheduled_start_local) return null;
  return `${formatLocalTime(r.scheduled_start_local)} – ${formatLocalTime(r.scheduled_end_local, r.work_date)}`;
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function Attendance() {
  const { can } = useAuth();
  const [filters, setFilters] = useState(() => ({ from: todayIso(), to: todayIso(), company_id: '', branch_id: '', employee_id: '', department_id: '' }));
  const [status, setStatus] = useState('');
  const [report, setReport] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState(null); // { mode: 'new' | 'edit', row }
  const [form, setForm] = useState({});
  const [error, setError] = useState('');

  async function load(f = filters) {
    setLoading(true);
    setLoadError('');
    try {
      const params = Object.fromEntries(Object.entries(f).filter(([, v]) => v));
      const { data } = await api.get('/attendance', { params });
      setReport(data);
    } catch (err) {
      setLoadError(err.response?.data?.error || 'Could not load attendance');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    api.get('/shift-assignments/employees').then(({ data }) => setEmployees(data)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Companies and branches are read off the employee list rather than Lookups, so the filters
  // need no Lookups permission and only offer values someone is actually assigned to.
  const companies = useMemo(() => {
    const map = new Map();
    employees.forEach((e) => { if (e.company_id) map.set(e.company_id, e.company_name); });
    return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [employees]);

  const branches = useMemo(() => {
    const map = new Map();
    employees
      .filter((e) => e.branch_id && (!filters.company_id || String(e.company_id) === String(filters.company_id)))
      .forEach((e) => map.set(e.branch_id, e.branch_name));
    return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [employees, filters.company_id]);

  const departments = useMemo(() => {
    const map = new Map();
    employees.forEach((e) => { if (e.department_id) map.set(e.department_id, e.department_name); });
    return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [employees]);

  const rows = useMemo(() => (report?.rows || []).filter((r) => !status || r.status === status), [report, status]);

  function openAdd(row) {
    setForm({
      employee_id: row?.employee_id || '',
      work_date: row?.work_date || todayIso(),
      time_in: toInputValue(row?.scheduled_start_local),
      time_out: toInputValue(row?.scheduled_end_local),
      remarks: '',
    });
    setEditing({ mode: 'new', row });
    setError('');
  }

  function openEdit(row) {
    setForm({ time_in: toInputValue(row.time_in_local), time_out: toInputValue(row.time_out_local), remarks: row.remarks || '' });
    setEditing({ mode: 'edit', row });
    setError('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const payload = { ...form, time_out: form.time_out || null };
    try {
      if (editing.mode === 'new') await api.post('/attendance', payload);
      else await api.put(`/attendance/${editing.row.log_id}`, payload);
      setEditing(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    }
  }

  async function handleDelete() {
    const r = editing.row;
    if (!confirm(`Delete ${r.employee_name}'s time record for ${formatDate(r.work_date)}?`)) return;
    try {
      await api.delete(`/attendance/${r.log_id}`);
      setEditing(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Delete failed');
    }
  }

  function exportCsv() {
    const header = ['Date', 'Employee Code', 'Employee', 'Company', 'Branch', 'Department', 'Shift', 'Scheduled In', 'Scheduled Out',
      'Time In', 'Time Out', 'Late (min)', 'Undertime (min)', 'Overtime (min)', 'Worked (min)', 'Status', 'Source', 'Remarks'];
    const lines = rows.map((r) => [
      r.work_date, r.employee_code, r.employee_name, r.company_name, r.branch_name, r.department_name, r.shift_name, r.scheduled_start_local, r.scheduled_end_local,
      r.time_in_local, r.time_out_local, r.late_minutes, r.undertime_minutes, r.overtime_minutes, r.worked_minutes,
      r.status, r.source, r.remarks,
    ].map(csvCell).join(','));
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `attendance_${report.from}_to_${report.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const s = report?.summary;

  const columns = [
    { key: 'work_date', label: 'Date', render: (r) => formatDate(r.work_date) },
    {
      key: 'employee_name',
      label: 'Employee',
      render: (r) => {
        const where = [r.company_name, r.branch_name].filter(Boolean).join(' · ') || r.department_name;
        return <>{r.employee_name}{where && <div className="muted" style={{ fontSize: 11 }}>{where}</div>}</>;
      },
    },
    { key: 'shift', label: 'Schedule', render: (r) => (r.shift_name ? <>{r.shift_name}<div className="muted" style={{ fontSize: 11 }}>{scheduleLabel(r)}</div></> : <span className="muted">Unscheduled</span>) },
    {
      key: 'time_in',
      label: 'Time In',
      render: (r) => (
        <>
          {formatLocalTime(r.time_in_local, r.work_date) || '—'}
          {r.original_time_in_local && r.original_time_in_local !== r.time_in_local && (
            <div className="muted" style={{ fontSize: 11 }}>was {formatLocalTime(r.original_time_in_local, r.work_date)}</div>
          )}
        </>
      ),
    },
    {
      key: 'time_out',
      label: 'Time Out',
      render: (r) => (
        <>
          {formatLocalTime(r.time_out_local, r.work_date) || '—'}
          {r.edited && r.original_time_out_local !== r.time_out_local && r.source === 'self' && (
            <div className="muted" style={{ fontSize: 11 }}>was {formatLocalTime(r.original_time_out_local, r.work_date) || 'none'}</div>
          )}
        </>
      ),
    },
    { key: 'late_minutes', label: 'Late', render: (r) => formatMinutes(r.late_minutes) },
    { key: 'undertime_minutes', label: 'Undertime', render: (r) => formatMinutes(r.undertime_minutes) },
    { key: 'overtime_minutes', label: 'Overtime', render: (r) => formatMinutes(r.overtime_minutes) },
    { key: 'worked_minutes', label: 'Worked', render: (r) => formatMinutes(r.worked_minutes) },
    {
      key: 'status',
      label: 'Status',
      render: (r) => (
        <>
          <span className={`badge ${statusBadgeClass(r.status)}`}>{r.status}</span>
          {r.source === 'manual' && <div className="muted" style={{ fontSize: 11 }}>entered by HR</div>}
          {r.source === 'self' && r.edited && <div className="muted" style={{ fontSize: 11 }}>corrected</div>}
          {r.remarks && <div className="muted" style={{ fontSize: 11 }} title={r.remarks}>{r.remarks}</div>}
        </>
      ),
    },
  ];

  return (
    <div>
      <div className="page-header">
        <h1>Attendance</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {rows.length > 0 && <button className="btn" onClick={exportCsv}>Export CSV</button>}
          {can('/attendance', 'can_add') && <button className="btn btn-primary" onClick={() => openAdd(null)}>Add Record</button>}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <form className="filter-grid" onSubmit={(e) => { e.preventDefault(); load(); }}>
          <div className="field">
            <label>From</label>
            <input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
          </div>
          <div className="field">
            <label>To</label>
            <input type="date" value={filters.to} min={filters.from} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
          </div>
          <div className="field">
            <label>Company</label>
            <select value={filters.company_id} onChange={(e) => setFilters({ ...filters, company_id: e.target.value, branch_id: '', employee_id: '' })}>
              <option value="">All</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Branch</label>
            <select value={filters.branch_id} onChange={(e) => setFilters({ ...filters, branch_id: e.target.value, employee_id: '' })}>
              <option value="">All</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Department</label>
            <select value={filters.department_id} onChange={(e) => setFilters({ ...filters, department_id: e.target.value })}>
              <option value="">All</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Employee</label>
            <select value={filters.employee_id} onChange={(e) => setFilters({ ...filters, employee_id: e.target.value })}>
              <option value="">All</option>
              {employees
                .filter((emp) => !filters.company_id || String(emp.company_id) === String(filters.company_id))
                .filter((emp) => !filters.branch_id || String(emp.branch_id) === String(filters.branch_id))
                .filter((emp) => !filters.department_id || String(emp.department_id) === String(filters.department_id))
                .map((emp) => <option key={emp.id} value={emp.id}>{emp.name}</option>)}
            </select>
          </div>
          <div className="field" style={{ alignSelf: 'end' }}>
            <button type="submit" className="btn btn-primary">Apply</button>
          </div>
        </form>
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}

      {s && (
        <div className="stat-grid">
          <div className="stat-card"><div className="value">{s.Present + s.Late}</div><div className="label">Present ({s.Late} late)</div></div>
          <div className="stat-card"><div className="value">{s.Absent}</div><div className="label">Absent</div></div>
          <div className="stat-card"><div className="value">{s['No Time Out']}</div><div className="label">No Time Out</div></div>
          <div className="stat-card"><div className="value">{formatMinutes(s.late_minutes, { blankZero: false })}</div><div className="label">Total Late</div></div>
          <div className="stat-card"><div className="value">{formatMinutes(s.undertime_minutes, { blankZero: false })}</div><div className="label">Total Undertime</div></div>
          <div className="stat-card"><div className="value">{formatMinutes(s.overtime_minutes, { blankZero: false })}</div><div className="label">Total Overtime</div></div>
        </div>
      )}

      <div className="status-tabs">
        <button className={`status-tab ${status === '' ? 'active' : ''}`} onClick={() => setStatus('')}>All ({report?.rows.length || 0})</button>
        {STATUSES.filter((st) => s?.[st]).map((st) => (
          <button key={st} className={`status-tab ${status === st ? 'active' : ''}`} onClick={() => setStatus(st)}>{st} ({s[st]})</button>
        ))}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        {loading ? <LoadingSpinner /> : (
          <DataTable
            paginate
            columns={columns}
            rows={rows}
            emptyLabel="Nothing scheduled or recorded for this range. Assign shifts under Shift Assignments to see absences here."
            actions={(row) => (
              <>
                {row.log_id && can('/attendance', 'can_edit') && <button className="btn btn-sm" onClick={() => openEdit(row)}>Edit</button>}
                {!row.log_id && row.status === 'Absent' && can('/attendance', 'can_add') && (
                  <button className="btn btn-sm" onClick={() => openAdd(row)}>Add Record</button>
                )}
              </>
            )}
          />
        )}
      </div>

      {editing && (
        <Modal
          title={editing.mode === 'new' ? 'Add Time Record' : `Edit Time Record · ${editing.row.employee_name}`}
          onClose={() => setEditing(null)}
        >
          <form onSubmit={handleSubmit}>
            {error && <div className="error-banner">{error}</div>}
            {editing.mode === 'new' ? (
              <div className="field-row">
                <div className="field">
                  <label>Employee</label>
                  <select required value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })} disabled={!!editing.row}>
                    <option value="">— Choose —</option>
                    {employees.map((emp) => <option key={emp.id} value={emp.id}>{emp.name}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>Work Date</label>
                  <input type="date" required value={form.work_date} onChange={(e) => setForm({ ...form, work_date: e.target.value })} disabled={!!editing.row} />
                </div>
              </div>
            ) : (
              <p className="muted" style={{ marginTop: 0 }}>
                {formatDate(editing.row.work_date)}
                {editing.row.shift_name && ` · ${editing.row.shift_name} (${scheduleLabel(editing.row)})`}
                {editing.row.original_time_in_local && (
                  <><br />Originally stamped: {formatLocalTime(editing.row.original_time_in_local)} – {formatLocalTime(editing.row.original_time_out_local, editing.row.work_date) || 'no time out'}</>
                )}
              </p>
            )}
            <div className="field-row">
              <div className="field">
                <label>Time In</label>
                <input type="datetime-local" required value={form.time_in} onChange={(e) => setForm({ ...form, time_in: e.target.value })} />
              </div>
              <div className="field">
                <label>Time Out</label>
                <input type="datetime-local" value={form.time_out} onChange={(e) => setForm({ ...form, time_out: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label>Remarks</label>
              <input value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} placeholder="Reason for the entry or correction" />
            </div>
            <p className="muted">Times are on the company clock ({report?.timezone}). Late, undertime and worked hours are recalculated on save.</p>
            <div className="modal-actions">
              {editing.mode === 'edit' && can('/attendance', 'can_delete') && (
                <button type="button" className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={handleDelete}>Delete</button>
              )}
              <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Save</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
