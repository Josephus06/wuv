import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { formatLocalTime } from '../utils/attendance';

// Top-bar shortcut to My Attendance showing whether the user is timed in. It links rather
// than stamping on click: a time record is not something to create by brushing past a
// button in the header. Only rendered for accounts linked to an employee.
export default function TimeClockChip() {
  const [open, setOpen] = useState(undefined);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => api.get('/attendance/me')
      .then(({ data }) => { if (!cancelled) setOpen(data.employee ? data.open_log : undefined); })
      .catch(() => {});
    refresh();
    const t = setInterval(refresh, 5 * 60 * 1000);
    window.addEventListener('attendance:changed', refresh);
    return () => {
      cancelled = true;
      clearInterval(t);
      window.removeEventListener('attendance:changed', refresh);
    };
  }, []);

  if (open === undefined) return null;
  return (
    <Link
      to="/my-attendance"
      className={`timeclock-chip ${open ? 'is-on' : ''}`}
      title={open ? 'You are timed in. Open My Attendance to time out.' : 'Open My Attendance to time in.'}
    >
      <span className="dot" />
      <span className="timeclock-chip-label">{open ? `In · ${formatLocalTime(open.time_in_local)}` : 'Time In'}</span>
    </Link>
  );
}
