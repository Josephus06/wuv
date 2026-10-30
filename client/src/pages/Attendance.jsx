import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import {
  cutoffRange, formatDate, formatLocalTime, formatMinutes, statusBadgeClass, toInputValue,
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
  const [dtr, setDtr] = useState(null); // the Print DTR dialog's choices

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
      lunch_out: '',
      lunch_in: '',
      remarks: '',
      approved_ot_hours: '',
    });
    setEditing({ mode: 'new', row });
    setError('');
  }

  function openEdit(row) {
    setForm({
      time_in: toInputValue(row.time_in_local), time_out: toInputValue(row.time_out_local), remarks: row.remarks || '',
      lunch_out: toInputValue(row.lunch_out_local), lunch_in: toInputValue(row.lunch_in_local),
      approved_ot_hours: row.approved_ot_minutes === null || row.approved_ot_minutes === undefined ? '' : String(row.approved_ot_minutes / 60),
    });
    setEditing({ mode: 'edit', row });
    setError('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const payload = { ...form, time_out: form.time_out || null, lunch_out: form.lunch_out || null, lunch_in: form.lunch_in || null };
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

  function openDtr() {
    setDtr({ ...cutoffRange(0), scope: filters.employee_id ? 'employee' : 'company', employee_id: filters.employee_id, company_id: filters.company_id, branch_id: filters.branch_id });
  }

  function printDtr(e) {
    e.preventDefault();
    const q = new URLSearchParams({ from: dtr.from, to: dtr.to });
    if (dtr.scope === 'employee') q.set('employee_id', dtr.employee_id);
    else {
      q.set('company_id', dtr.company_id);
      if (dtr.branch_id) q.set('branch_id', dtr.branch_id);
    }
    window.open(`/attendance/dtr/print?${q.toString()}`, '_blank');
    setDtr(null);
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
      key: 'lunch',
      label: 'Lunch',
      render: (r) => (r.lunch_out_local
        ? `${formatLocalTime(r.lunch_out_local)} – ${formatLocalTime(r.lunch_in_local) || '?'}`
        : <span className="muted">{r.has_lunch && r.log_id ? 'not stamped' : '—'}</span>),
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
    { key: 'late_minutes', label: 'Late', render: (r) => <>{formatMinutes(r.late_minutes)}{r.halfday_absent && <div className="muted" style={{ fontSize: 11 }}>half day absent</div>}</> },
    { key: 'undertime_minutes', label: 'Undertime', render: (r) => formatMinutes(r.undertime_minutes) },
    { key: 'overtime_minutes', label: 'Overtime', render: (r) => <>{formatMinutes(r.overtime_minutes)}{r.approved_ot_minutes !== null && r.approved_ot_minutes !== undefined && r.log_id && <div className="muted" style={{ fontSize: 11 }}>approved</div>}</> },
    { key: 'worked_minutes', label: 'Worked', render: (r) => formatMinutes(r.worked_minutes) },
    {
      key: 'status',
      label: 'Status',
      render: (r) => (
        <>
          <span className={`badge ${statusBadgeClass(r.status)}`}>{r.status}</span>
          {r.source === 'manual' && <div className="muted" style={{ fontSize: 11 }}>entered by HR</div>}
          {r.source === 'kiosk' && <div className="muted" style={{ fontSize: 11 }}>via time clock</div>}
          {r.source === 'import' && <div className="muted" style={{ fontSize: 11 }}>imported</div>}
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
          {can('/attendance', 'can_add') && <button className="btn" onClick={() => window.location.assign('/attendance/import')}>Import</button>}
          <button className="btn" onClick={openDtr}>Print DTR</button>
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
                {!row.log_id && can('/attendance', 'can_add') && (
                  <button className="btn btn-sm" onClick={() => openAdd(row)}>Add Record</button>
                )}
              </>
            )}
          />
        )}
      </div>

      {dtr && (
        <Modal title="Print DTR" onClose={() => setDtr(null)}>
          <form onSubmit={printDtr}>
            <div className="field">
              <label>Period</label>
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <button type="button" className="btn btn-sm" onClick={() => setDtr({ ...dtr, ...cutoffRange(0) })}>This cutoff</button>
                <button type="button" className="btn btn-sm" onClick={() => setDtr({ ...dtr, ...cutoffRange(-1) })}>Last cutoff</button>
              </div>
              <div className="field-row">
                <input type="date" required value={dtr.from} onChange={(e) => setDtr({ ...dtr, from: e.target.value })} />
                <input type="date" required min={dtr.from} value={dtr.to} onChange={(e) => setDtr({ ...dtr, to: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label>Print for</label>
              <div style={{ display: 'flex', gap: 16 }}>
                <label className="field-checkbox" style={{ fontWeight: 400 }}>
                  <input type="radio" name="dtr-scope" checked={dtr.scope === 'employee'} onChange={() => setDtr({ ...dtr, scope: 'employee' })} style={{ width: 'auto' }} /> One employee
                </label>
                <label className="field-checkbox" style={{ fontWeight: 400 }}>
                  <input type="radio" name="dtr-scope" checked={dtr.scope === 'company'} onChange={() => setDtr({ ...dtr, scope: 'company' })} style={{ width: 'auto' }} /> Whole company
                </label>
              </div>
            </div>
            {dtr.scope === 'employee' ? (
              <div className="field">
                <label>Employee</label>
                <select required value={dtr.employee_id || ''} onChange={(e) => setDtr({ ...dtr, employee_id: e.target.value })}>
                  <option value="">— Choose —</option>
                  {employees.map((emp) => <option key={emp.id} value={emp.id}>{emp.name}{emp.company_name ? ` (${emp.company_name})` : ''}</option>)}
                </select>
              </div>
            ) : (
              <div className="field-row">
                <div className="field">
                  <label>Company</label>
                  <select required value={dtr.company_id || ''} onChange={(e) => setDtr({ ...dtr, company_id: e.target.value, branch_id: '' })}>
                    <option value="">— Choose —</option>
                    {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>Branch (optional)</label>
                  <select value={dtr.branch_id || ''} onChange={(e) => setDtr({ ...dtr, branch_id: e.target.value })}>
                    <option value="">All branches</option>
                    {[...new Map(employees
                      .filter((emp) => emp.branch_id && String(emp.company_id) === String(dtr.company_id))
                      .map((emp) => [emp.branch_id, emp.branch_name])).entries()]
                      .map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                  </select>
                </div>
              </div>
            )}
            <p className="muted">Opens in a new tab: one page per employee, every date listed, with signature lines.</p>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setDtr(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Open DTR</button>
            </div>
          </form>
        </Modal>
      )}

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
            <div className="field-row">
              <div className="field">
                <label>Lunch Out <span className="muted">(optional)</span></label>
                <input type="datetime-local" value={form.lunch_out} onChange={(e) => setForm({ ...form, lunch_out: e.target.value })} />
              </div>
              <div className="field">
                <label>Lunch In <span className="muted">(optional)</span></label>
                <input type="datetime-local" value={form.lunch_in} onChange={(e) => setForm({ ...form, lunch_in: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label>Approved Overtime (hours)</label>
              <input type="number" min="0" max="16" step="0.25" value={form.approved_ot_hours}
                onChange={(e) => setForm({ ...form, approved_ot_hours: e.target.value })} placeholder="Blank = overtime after the shift end" />
              <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                When set, payroll pays exactly this much overtime for the day (0 = none approved).
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
