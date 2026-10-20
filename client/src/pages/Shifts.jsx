import { useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import { formatMinutes, formatShiftHours } from '../utils/attendance';

const EMPTY = {
  name: '', start_time: '08:00', end_time: '17:00', grace_minutes: 0, break_minutes: 60, paid_break_minutes: 0,
  branch_id: '', description: '', is_active: true,
};

export default function Shifts() {
  const { can } = useAuth();
  const [rows, setRows] = useState([]);
  const [branches, setBranches] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const { data } = await api.get('/shifts');
    setRows(data);
    setLoading(false);
  }

  useEffect(() => {
    load();
    api.get('/schedule/branches').then(({ data }) => setBranches(data)).catch(() => {});
  }, []);

  function openCreate() {
    setForm(EMPTY);
    setEditing('new');
    setError('');
  }

  function openEdit(row) {
    setForm({
      name: row.name,
      start_time: row.start_time.slice(0, 5),
      end_time: row.end_time.slice(0, 5),
      grace_minutes: row.grace_minutes,
      break_minutes: row.break_minutes,
      paid_break_minutes: row.paid_break_minutes || 0,
      branch_id: row.branch_id || '',
      description: row.description || '',
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
      grace_minutes: Number(form.grace_minutes),
      break_minutes: Number(form.break_minutes),
      paid_break_minutes: Number(form.paid_break_minutes),
      branch_id: form.branch_id || null,
    };
    try {
      if (editing === 'new') await api.post('/shifts', payload);
      else await api.put(`/shifts/${editing}`, payload);
      setEditing(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    }
  }

  async function handleDelete(row) {
    if (!confirm(`Delete shift "${row.name}"?`)) return;
    try {
      await api.delete(`/shifts/${row.id}`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Delete failed');
    }
  }

  const overnight = form.end_time && form.start_time && form.end_time <= form.start_time;

  // Paid hours a full day earns: Shift In to Shift Out, less the unpaid break, plus paid breaks.
  function paidMinutes(r) {
    const [sh, sm] = String(r.start_time).split(':').map(Number);
    const [eh, em] = String(r.end_time).split(':').map(Number);
    let span = eh * 60 + em - (sh * 60 + sm);
    if (span <= 0) span += 1440;
    return span - Number(r.break_minutes || 0) + Number(r.paid_break_minutes || 0);
  }
  const formPaid = form.start_time && form.end_time ? paidMinutes(form) : 0;

  const columns = [
    { key: 'name', label: 'Shift', render: (r) => <>{r.name}{r.branch_name && <div className="muted" style={{ fontSize: 11 }}>{r.branch_name}</div>}</> },
    {
      key: 'hours',
      label: 'Hours',
      render: (r) => (
        <>
          {formatShiftHours(r.start_time, r.end_time)}
          {r.is_overnight && <span className="badge badge-info" style={{ marginLeft: 6 }}>Overnight</span>}
        </>
      ),
    },
    { key: 'grace_minutes', label: 'Grace', render: (r) => formatMinutes(r.grace_minutes) || '—' },
    { key: 'break_minutes', label: 'Break', render: (r) => <>{formatMinutes(r.break_minutes) || '—'}{r.paid_break_minutes > 0 && <div className="muted" style={{ fontSize: 11 }}>+{formatMinutes(r.paid_break_minutes)} paid</div>}</> },
    { key: 'paid', label: 'Paid Hours', render: (r) => formatMinutes(paidMinutes(r)) },
    { key: 'assigned_count', label: 'Assigned Now' },
    { key: 'is_active', label: 'Status', render: (r) => (r.is_active ? <span className="badge badge-success">Active</span> : <span className="badge badge-muted">Inactive</span>) },
  ];

  return (
    <div>
      <div className="page-header">
        <h1>Shifts</h1>
        {can('/shifts', 'can_add') && <button className="btn btn-primary" onClick={openCreate}>Create Shift</button>}
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <DataTable
            paginate
            columns={columns}
            rows={rows}
            emptyLabel="No shifts yet. Create one, then assign employees to it under Shift Assignments."
            actions={(row) => (
              <>
                {can('/shifts', 'can_edit') && <button className="btn btn-sm" onClick={() => openEdit(row)}>Edit</button>}
                {can('/shifts', 'can_delete') && <button className="btn btn-sm btn-danger" onClick={() => handleDelete(row)}>Delete</button>}
              </>
            )}
          />
        )}
      </div>

      {editing && (
        <Modal title={editing === 'new' ? 'Create Shift' : 'Edit Shift'} onClose={() => setEditing(null)}>
          <form onSubmit={handleSubmit}>
            {error && <div className="error-banner">{error}</div>}
            <div className="field">
              <label>Shift Name</label>
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Day Shift" />
            </div>
            <div className="field-row">
              <div className="field">
                <label>Start Time</label>
                <input type="time" required value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} />
              </div>
              <div className="field">
                <label>End Time</label>
                <input type="time" required value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} />
              </div>
            </div>
            {overnight && form.end_time !== form.start_time && (
              <p className="muted" style={{ marginTop: -4 }}>Ends the next day (overnight shift). It counts toward the date it starts.</p>
            )}
            <div className="field-row">
              <div className="field">
                <label>Branch</label>
                <select value={form.branch_id} onChange={(e) => setForm({ ...form, branch_id: e.target.value })}>
                  <option value="">Any branch</option>
                  {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Paid Break (minutes)</label>
                <input type="number" min="0" max="240" value={form.paid_break_minutes} onChange={(e) => setForm({ ...form, paid_break_minutes: e.target.value })} />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Grace Period (minutes)</label>
                <input type="number" min="0" max="240" value={form.grace_minutes} onChange={(e) => setForm({ ...form, grace_minutes: e.target.value })} />
              </div>
              <div className="field">
                <label>Unpaid Break (minutes)</label>
                <input type="number" min="0" max="480" value={form.break_minutes} onChange={(e) => setForm({ ...form, break_minutes: e.target.value })} />
              </div>
            </div>
            <p className="muted" style={{ marginTop: -4 }}>
              Arriving within the grace period is on time; after it, lateness counts from the start time.
              The unpaid break is taken off worked hours; paid breaks (e.g. two 15-minute breaks outside
              Shift In / Out) are added. Paid hours for a full day: <strong>{formatMinutes(formPaid) || '—'}</strong>.
            </p>
            <div className="field">
              <label>Description</label>
              <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div className="field field-checkbox">
              <input type="checkbox" id="shift-active" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
              <label htmlFor="shift-active">Active</label>
            </div>
            {editing !== 'new' && (
              <p className="muted">Changing the hours applies from now on. Attendance already recorded keeps the schedule it was measured against.</p>
            )}
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
