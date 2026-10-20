import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import LoadingSpinner from '../components/LoadingSpinner';
import { formatClock } from '../utils/attendance';

const ROUTE = '/schedule';
const BRANCH_KEY = 'schedule.branch';

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function mondayOf(iso) {
  const wd = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return addDays(iso, wd === 0 ? -6 : 1 - wd);
}

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const dayHead = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
const dayNum = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

// "Seaside - Opening" -> "Opening": inside a branch's grid the branch name is noise.
const shortName = (name) => String(name || '').replace(/^.+? - /, '');

function readBranch() {
  try { return localStorage.getItem(BRANCH_KEY) || ''; } catch { return ''; }
}

export default function Schedule() {
  const { can } = useAuth();
  const editable = can(ROUTE, 'can_edit');
  const [branches, setBranches] = useState([]);
  const [branchId, setBranchId] = useState(readBranch);
  const [weekStart, setWeekStart] = useState(() => mondayOf(localToday()));
  const [data, setData] = useState(null);
  const [changes, setChanges] = useState({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    api.get('/schedule/branches').then(({ data: b }) => setBranches(b)).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    if (!branchId) { setData(null); return; }
    setLoading(true);
    setError('');
    try {
      const { data: d } = await api.get('/schedule', { params: { branch_id: branchId, week_start: weekStart } });
      setData(d);
      setChanges({});
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load the schedule');
    } finally {
      setLoading(false);
    }
  }, [branchId, weekStart]);

  useEffect(() => { load(); }, [load]);

  const dirty = Object.keys(changes).length > 0;
  const confirmLeave = () => !dirty || confirm('You have unsaved changes. Discard them?');

  function pickBranch(id) {
    if (!confirmLeave()) return;
    setBranchId(id);
    setNotice('');
    try { localStorage.setItem(BRANCH_KEY, id); } catch { /* per-viewer convenience only */ }
  }

  function moveWeek(target) {
    if (!confirmLeave()) return;
    setNotice('');
    setWeekStart(mondayOf(target));
  }

  const shiftById = useMemo(() => new Map((data?.shifts || []).map((s) => [String(s.id), s])), [data]);

  // A cell's current value: an unsaved change, else what is plotted, else 'default'.
  function cellValue(emp, date) {
    const key = `${emp.id}|${date}`;
    if (key in changes) return changes[key];
    const day = emp.days[date];
    if (day.source === 'plotted') return day.shift_id ? String(day.shift_id) : 'rest';
    return 'default';
  }

  function setCell(emp, date, value) {
    const key = `${emp.id}|${date}`;
    const day = emp.days[date];
    const original = day.source === 'plotted' ? (day.shift_id ? String(day.shift_id) : 'rest') : 'default';
    setChanges((c) => {
      const next = { ...c };
      if (value === original) delete next[key]; else next[key] = value;
      return next;
    });
  }

  // What a cell resolves to, for its colour and the day totals.
  function effective(emp, date) {
    const v = cellValue(emp, date);
    if (v === 'rest') return { kind: 'rest' };
    if (v === 'default') {
      const def = emp.days[date].default;
      return def ? { kind: 'shift', shift: def, inherited: true } : { kind: 'rest', inherited: true };
    }
    const s = shiftById.get(v);
    return s ? { kind: 'shift', shift: { shift_id: s.id, shift_name: s.name, start_time: s.start_time, end_time: s.end_time } } : { kind: 'rest' };
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      const entries = Object.entries(changes).map(([key, value]) => {
        const [employeeId, workDate] = key.split('|');
        return { employee_id: Number(employeeId), work_date: workDate, value };
      });
      await api.put('/schedule', { entries });
      setNotice(`Saved ${entries.length} change${entries.length > 1 ? 's' : ''}.`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function copyLastWeek() {
    if (dirty) { alert('Save or discard your changes first.'); return; }
    if (!confirm('Copy last week\'s plotted schedule onto this week? Anything plotted this week is replaced.')) return;
    setError('');
    try {
      const { data: res } = await api.post('/schedule/copy', { branch_id: branchId, from_week: addDays(weekStart, -7), to_week: weekStart });
      setNotice(`Copied ${res.copied} plotted day${res.copied > 1 ? 's' : ''} from last week.`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Copy failed');
    }
  }

  const today = localToday();

  return (
    <div>
      <div className="page-header">
        <h1>Schedule</h1>
        {editable && data && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={copyLastWeek}>Copy Last Week</button>
            {dirty && <button className="btn" onClick={() => setChanges({})}>Discard</button>}
            <button className="btn btn-primary" disabled={!dirty || saving} onClick={save}>
              {saving ? 'Saving…' : dirty ? `Save ${Object.keys(changes).length} change${Object.keys(changes).length > 1 ? 's' : ''}` : 'Saved'}
            </button>
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="schedule-toolbar">
          <div className="field">
            <label>Branch</label>
            <select value={branchId} onChange={(e) => pickBranch(e.target.value)}>
              <option value="">— Choose a branch —</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}{b.company_name ? ` (${b.company_name})` : ''}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Week</label>
            <div className="schedule-week">
              <button type="button" className="btn btn-sm" onClick={() => moveWeek(addDays(weekStart, -7))} aria-label="Previous week">‹</button>
              <input type="date" value={weekStart} onChange={(e) => e.target.value && moveWeek(e.target.value)} />
              <button type="button" className="btn btn-sm" onClick={() => moveWeek(addDays(weekStart, 7))} aria-label="Next week">›</button>
              <button type="button" className="btn btn-sm" onClick={() => moveWeek(today)}>This week</button>
            </div>
          </div>
        </div>
        <p className="muted" style={{ margin: '8px 0 0' }}>
          Set each person&apos;s shift or rest day. <strong>Default</strong> follows their Shift Assignment (for fixed staff
          like Main Office). Attendance and payroll use what is plotted here.
        </p>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="success-banner">{notice}</div>}

      {!branchId ? (
        <div className="card"><div className="empty-state">Choose a branch to plot its week.</div></div>
      ) : loading || !data ? <LoadingSpinner /> : data.employees.length === 0 ? (
        <div className="card">
          <div className="empty-state">No active employees have this branch. Set the Branch on each employee in Master Lists → Employees.</div>
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="schedule-grid">
              <thead>
                <tr>
                  <th>Employee</th>
                  {data.dates.map((d) => (
                    <th key={d} className={d === today ? 'is-today' : ''}>
                      {dayHead(d)}<div className="muted">{dayNum(d)}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.employees.map((emp) => (
                  <tr key={emp.id}>
                    <td className="schedule-emp">
                      <strong>{emp.name}</strong>
                      <div className="muted">{[emp.employee_code, emp.position_title].filter(Boolean).join(' · ')}</div>
                    </td>
                    {data.dates.map((d) => {
                      const v = cellValue(emp, d);
                      const eff = effective(emp, d);
                      const def = emp.days[d].default;
                      const changed = `${emp.id}|${d}` in changes;
                      return (
                        <td key={d} className={`schedule-cell ${eff.kind === 'rest' ? 'is-rest' : 'is-shift'} ${eff.inherited ? 'is-default' : ''} ${changed ? 'is-changed' : ''}`}>
                          <select value={v} disabled={!editable} onChange={(e) => setCell(emp, d, e.target.value)}
                            title={eff.kind === 'shift' ? `${eff.shift.shift_name}: ${formatClock(eff.shift.start_time)} – ${formatClock(eff.shift.end_time)}` : 'Rest day'}>
                            <option value="default">Default{def ? ` (${shortName(def.shift_name)})` : ' (Rest)'}</option>
                            <option value="rest">Rest day</option>
                            {data.shifts.map((s) => <option key={s.id} value={String(s.id)}>{shortName(s.name)}</option>)}
                          </select>
                          <div className="schedule-time">
                            {eff.kind === 'shift' ? `${formatClock(eff.shift.start_time)}–${formatClock(eff.shift.end_time)}` : 'Rest'}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>Working</th>
                  {data.dates.map((d) => {
                    const working = data.employees.filter((emp) => effective(emp, d).kind === 'shift').length;
                    return <th key={d}>{working} / {data.employees.length}</th>;
                  })}
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
