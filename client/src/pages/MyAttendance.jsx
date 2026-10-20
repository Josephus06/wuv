import { useEffect, useState } from 'react';
import api from '../api/client';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';
import { parseUtc } from '../utils/datetime';
import {
  formatDate, formatLocalTime, formatMinutes, formatShiftHours, statusBadgeClass,
} from '../utils/attendance';

// Every logged-in user's own time clock. The stamp itself is taken by the server at the
// moment of the request -- the clock shown here is only for reading.
export default function MyAttendance() {
  const [data, setData] = useState(null);
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    try {
      const { data: d } = await api.get('/attendance/me');
      setData(d);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load your attendance');
    }
  }

  useEffect(() => { load(); }, []);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  async function stamp(kind) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { data: log } = await api.post(`/attendance/me/${kind}`);
      setNotice(kind === 'time-in'
        ? `Timed in at ${formatLocalTime(log.time_in_local)}${log.late_minutes ? ` — ${formatMinutes(log.late_minutes)} late` : ''}.`
        : `Timed out at ${formatLocalTime(log.time_out_local)}. Worked ${formatMinutes(log.worked_minutes, { blankZero: false })}.`);
      // Tell the top-bar chip to refresh without waiting for its own poll.
      window.dispatchEvent(new Event('attendance:changed'));
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not record your time');
    } finally {
      setBusy(false);
    }
  }

  if (!data && !error) return <LoadingSpinner />;

  const tz = data?.timezone;
  const clock = tz ? new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(now) : '';
  const dateLine = tz ? new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(now) : '';

  if (data && !data.employee) {
    return (
      <div>
        <div className="page-header"><h1>My Attendance</h1></div>
        <div className="card">
          <p>Your user account is not linked to an employee record, so there is nothing to time in to.</p>
          <p className="muted">Ask HR or an admin to set the Employee on your account in Users &amp; Permissions.</p>
        </div>
      </div>
    );
  }

  const open = data?.open_log;
  const today = data?.today;
  const todayDone = today?.log && today.log.time_out_local;
  const elapsedMin = open ? Math.max(0, Math.floor((now - parseUtc(open.time_in)) / 60000)) : 0;

  const columns = [
    { key: 'work_date', label: 'Date', render: (r) => formatDate(r.work_date) },
    { key: 'shift_name', label: 'Shift', render: (r) => r.shift_name || <span className="muted">Unscheduled</span> },
    { key: 'time_in', label: 'Time In', render: (r) => formatLocalTime(r.time_in_local, r.work_date) },
    { key: 'time_out', label: 'Time Out', render: (r) => formatLocalTime(r.time_out_local, r.work_date) || '—' },
    { key: 'late_minutes', label: 'Late', render: (r) => formatMinutes(r.late_minutes) },
    { key: 'undertime_minutes', label: 'Undertime', render: (r) => formatMinutes(r.undertime_minutes) },
    { key: 'worked_minutes', label: 'Worked', render: (r) => formatMinutes(r.worked_minutes) },
    {
      key: 'status',
      label: 'Status',
      render: (r) => {
        const status = !r.time_out_local ? (open?.id === r.id ? 'On Duty' : 'No Time Out') : r.late_minutes ? 'Late' : 'Present';
        return (
          <>
            <span className={`badge ${statusBadgeClass(status)}`}>{status}</span>
            {r.source === 'manual' && <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>by HR</span>}
            {r.original_time_in_local && <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>corrected</span>}
          </>
        );
      },
    },
  ];

  return (
    <div>
      <div className="page-header">
        <h1>My Attendance</h1>
        {data?.employee && (
          <span className="muted">
            {data.employee.first_name} {data.employee.last_name}
            {data.employee.employee_code ? ` · ${data.employee.employee_code}` : ''}
          </span>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="success-banner">{notice}</div>}

      {data && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="time-clock">
            <div>
              <div className="time-clock-now">{clock}</div>
              <div className="time-clock-date">{dateLine}</div>
              <div className="time-clock-shift">
                {today.shift ? (
                  <>
                    <strong>{today.shift.name}</strong>{' · '}
                    {formatShiftHours(today.shift.start_time, today.shift.end_time)}
                    {today.work_date !== data.now_local.slice(0, 10) && <span className="muted"> (started {formatDate(today.work_date, { month: 'short', day: 'numeric' })})</span>}
                    {today.shift.grace_minutes > 0 && <span className="muted"> · {today.shift.grace_minutes} min grace</span>}
                  </>
                ) : (
                  <span className="muted">No shift scheduled today</span>
                )}
              </div>
            </div>

            <div className="time-clock-actions">
              {open ? (
                <>
                  <button type="button" className="btn btn-danger" disabled={busy} onClick={() => stamp('time-out')}>
                    {busy ? 'Saving…' : 'Time Out'}
                  </button>
                  <span className="time-clock-elapsed">
                    In since {formatLocalTime(open.time_in_local)} · {formatMinutes(elapsedMin, { blankZero: false })}
                  </span>
                </>
              ) : todayDone ? (
                <span className="time-clock-elapsed">
                  Done for today: {formatLocalTime(today.log.time_in_local)} – {formatLocalTime(today.log.time_out_local, today.work_date)}
                </span>
              ) : (
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => stamp('time-in')}>
                  {busy ? 'Saving…' : 'Time In'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Last 14 days</h3>
        <DataTable columns={columns} rows={data?.recent || []} emptyLabel="No time records yet." />
      </div>
    </div>
  );
}
