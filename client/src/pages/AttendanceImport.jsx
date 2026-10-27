import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { formatClock, formatDate } from '../utils/attendance';

// Import a branch's manual attendance sheet (.xlsx): upload -> review -> import.
// Nothing is saved until Import; the review is where names are matched to employees, the
// sheet's shifts to the system's, and flagged days corrected or skipped.

const LEVEL_CLASS = { error: 'badge-danger', warn: 'badge-warning', info: 'badge-muted' };
const hours = (min) => (min === null || min === undefined ? '' : String(Math.round((min / 60) * 100) / 100));

export default function AttendanceImport() {
  const navigate = useNavigate();
  const [preview, setPreview] = useState(null);
  const [rows, setRows] = useState([]);
  const [empMap, setEmpMap] = useState({});
  const [shiftMap, setShiftMap] = useState({});
  const [replace, setReplace] = useState(false);
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  async function readFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setResult(null);
    setReading(true);
    try {
      const body = new FormData();
      body.append('file', file);
      const { data } = await api.post('/attendance/import/preview', body);
      setPreview(data);
      setRows(data.rows);
      setEmpMap(Object.fromEntries(data.employees.map((m) => [m.sheet_name, m.employee_id ? String(m.employee_id) : ''])));
      setShiftMap(Object.fromEntries(data.shifts.map((m) => [m.sheet_shift, m.shift_id ? String(m.shift_id) : ''])));
    } catch (err) {
      setError(err.response?.data?.error || 'Could not read that file.');
    } finally {
      setReading(false);
    }
  }

  const setRow = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const existing = useMemo(() => new Set(preview?.existing || []), [preview]);
  const byEmployee = useMemo(() => {
    const groups = new Map();
    for (const r of rows) {
      if (!groups.has(r.sheet_name)) groups.set(r.sheet_name, []);
      groups.get(r.sheet_name).push(r);
    }
    return [...groups.entries()];
  }, [rows]);

  const isExisting = (r) => empMap[r.sheet_name] && existing.has(`${empMap[r.sheet_name]}|${r.date}`);
  const included = rows.filter((r) => !r.skip && empMap[r.sheet_name]);
  const withTimes = included.filter((r) => r.time_in);
  const unmatchedNames = preview ? preview.employees.filter((m) => !empMap[m.sheet_name]) : [];
  const unmatchedShifts = preview ? preview.shifts.filter((m) => !shiftMap[m.sheet_shift]) : [];
  const flaggedCount = rows.filter((r) => r.flags.some((f) => f.level !== 'info')).length;
  const existingCount = included.filter((r) => r.time_in && isExisting(r)).length;

  async function doImport() {
    if (!confirm(`Import ${withTimes.length} time records and plot ${included.length} schedule days? ${existingCount
      ? (replace ? `${existingCount} existing records will be REPLACED.` : `${existingCount} days that already have a record keep it.`) : ''}`)) return;
    setSaving(true);
    setError('');
    try {
      const { data } = await api.post('/attendance/import', {
        file_name: preview.file_name,
        replace_existing: replace,
        employees: Object.fromEntries(Object.entries(empMap).filter(([, v]) => v).map(([k, v]) => [k, Number(v)])),
        shifts: Object.fromEntries(Object.entries(shiftMap).filter(([, v]) => v).map(([k, v]) => [k, Number(v)])),
        rows: rows.map((r) => ({
          sheet_name: r.sheet_name, date: r.date, sheet_shift: r.sheet_shift, rest: r.rest,
          time_in: r.time_in || null, time_out: r.time_out || null, approved_ot_minutes: r.approved_ot_minutes, skip: r.skip,
        })),
      });
      setResult(data);
      setPreview(null);
    } catch (err) {
      setError(err.response?.data?.error || 'Import failed -- nothing was saved.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Import Attendance</h1>
        <button className="btn" onClick={() => navigate('/attendance')}>Back to Attendance</button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {result && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>Imported</h3>
          <p style={{ margin: 0 }}>
            {result.records} time records created{result.replaced ? ` (${result.replaced} replaced)` : ''}, {result.plotted} schedule days plotted
            {result.kept_existing ? `, ${result.kept_existing} days kept their existing record` : ''}
            {result.skipped ? `, ${result.skipped} days skipped` : ''}.
          </p>
          <p className="muted" style={{ marginBottom: 0 }}>Check them in HR → Attendance, then recompute the cutoff&apos;s payroll.</p>
        </div>
      )}

      {!preview && (
        <div className="card">
          <p style={{ marginTop: 0 }}>
            Upload a branch&apos;s attendance sheet (.xlsx) with the columns <strong>Name, Date, Shift, Time In, Time Out</strong>,
            and optionally <strong>OT Time In, OT Time Out, Overtime</strong>. You&apos;ll review everything before it is saved.
          </p>
          <ul className="muted" style={{ fontSize: 13 }}>
            <li>Each day&apos;s shift (or REST DAY) is plotted on the Schedule.</li>
            <li>Late and undertime are worked out from that shift; the sheet&apos;s own Late / Undertime / Worked columns are not used.</li>
            <li>The <strong>Overtime</strong> column becomes the day&apos;s approved overtime. Blank means none approved.</li>
          </ul>
          <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
            {reading ? 'Reading…' : 'Choose Excel File'}
            <input type="file" accept=".xlsx" hidden disabled={reading} onChange={readFile} />
          </label>
        </div>
      )}

      {preview && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <strong>{preview.file_name}</strong>
            <span className="muted"> · {formatDate(preview.from)} – {formatDate(preview.to)} · {preview.employees.length} employees · {rows.length} days
              {flaggedCount > 0 && <> · <span className="badge badge-warning">{flaggedCount} to check</span></>}
            </span>
            <button type="button" className="btn btn-sm" style={{ marginLeft: 12 }} onClick={() => { setPreview(null); setRows([]); }}>Choose another file</button>
          </div>

          <div className="settings-grid" style={{ marginBottom: 16 }}>
            <section className="card">
              <h3 style={{ marginTop: 0 }}>Employees</h3>
              <table className="payslip-table">
                <thead><tr><th>Name on the sheet</th><th>Employee</th></tr></thead>
                <tbody>
                  {preview.employees.map((m) => (
                    <tr key={m.sheet_name}>
                      <td>
                        {m.sheet_name}
                        {m.match === 'close' && empMap[m.sheet_name] === String(m.employee_id) && <span className="badge badge-warning" style={{ marginLeft: 6 }}>check</span>}
                      </td>
                      <td>
                        <select value={empMap[m.sheet_name]} onChange={(e) => setEmpMap({ ...empMap, [m.sheet_name]: e.target.value })}
                          className={empMap[m.sheet_name] ? '' : 'select-missing'}>
                          <option value="">— Not imported —</option>
                          {preview.employee_options.map((o) => (
                            <option key={o.id} value={o.id}>{o.name}{o.employee_code ? ` (${o.employee_code})` : ''}{o.branch_name ? ` · ${o.branch_name}` : ''}</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {unmatchedNames.length > 0 && (
                <p className="warning-banner" style={{ marginBottom: 0 }}>
                  {unmatchedNames.length} name{unmatchedNames.length > 1 ? 's are' : ' is'} not matched and will be skipped. Choose the
                  employee, or add them in Employees first and upload again.
                </p>
              )}
            </section>

            <section className="card">
              <h3 style={{ marginTop: 0 }}>Shifts</h3>
              <table className="payslip-table">
                <thead><tr><th>Shift on the sheet</th><th>Shift in the system</th></tr></thead>
                <tbody>
                  {preview.shifts.map((m) => (
                    <tr key={m.sheet_shift}>
                      <td>{m.sheet_shift}</td>
                      <td>
                        <select value={shiftMap[m.sheet_shift]} onChange={(e) => setShiftMap({ ...shiftMap, [m.sheet_shift]: e.target.value })}
                          className={shiftMap[m.sheet_shift] ? '' : 'select-missing'}>
                          <option value="">— Not plotted —</option>
                          {preview.shift_options.map((s) => (
                            <option key={s.id} value={s.id}>{s.name} ({formatClock(s.start_time)}–{formatClock(s.end_time)})</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {unmatchedShifts.length > 0 && (
                <p className="warning-banner" style={{ marginBottom: 0 }}>
                  Days on an unmatched shift are imported without a schedule, so no late or undertime is worked out for them.
                </p>
              )}
              <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>REST DAY rows are plotted as rest days.</p>
            </section>
          </div>

          <div className="card">
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
              <label className="field-checkbox" style={{ margin: 0, fontWeight: 400 }}>
                <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} style={{ width: 'auto' }} />
                Show only days to check
              </label>
              {existingCount > 0 && (
                <label className="field-checkbox" style={{ margin: 0, fontWeight: 400 }}>
                  <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} style={{ width: 'auto' }} />
                  Replace the {existingCount} days that already have a time record
                </label>
              )}
            </div>
            <div className="table-wrap">
              <table className="import-table">
                <thead>
                  <tr>
                    <th>Import</th><th>Date</th><th>Shift</th><th>Time In</th><th>Time Out</th><th>Approved OT (hrs)</th><th>Notes</th>
                  </tr>
                </thead>
                {byEmployee.map(([name, days]) => {
                  const shown = onlyFlagged ? days.filter((r) => r.flags.some((f) => f.level !== 'info')) : days;
                  if (!shown.length) return null;
                  const mapped = !!empMap[name];
                  return (
                    <tbody key={name}>
                      <tr className="import-group"><th colSpan={7}>{name}{!mapped && <span className="badge badge-danger" style={{ marginLeft: 8 }}>not matched — skipped</span>}</th></tr>
                      {shown.map((r) => {
                        const level = r.flags.some((f) => f.level === 'error') ? 'error' : r.flags.some((f) => f.level === 'warn') ? 'warn' : '';
                        return (
                          <tr key={r.key} className={`${r.skip || !mapped ? 'is-skipped' : ''} ${level ? `is-${level}` : ''}`}>
                            <td><input type="checkbox" checked={!r.skip} disabled={!mapped} onChange={(e) => setRow(r.key, { skip: !e.target.checked })} /></td>
                            <td className="nowrap">{formatDate(r.date)}</td>
                            <td className="nowrap">{r.rest ? <span className="muted">Rest day</span> : r.sheet_shift || '—'}</td>
                            <td><input type="time" value={r.time_in || ''} onChange={(e) => setRow(r.key, { time_in: e.target.value || null })} /></td>
                            <td><input type="time" value={r.time_out || ''} onChange={(e) => setRow(r.key, { time_out: e.target.value || null })} /></td>
                            <td>
                              <input type="number" min="0" max="16" step="0.25" value={hours(r.approved_ot_minutes)}
                                onChange={(e) => setRow(r.key, { approved_ot_minutes: e.target.value === '' ? 0 : Math.round(Number(e.target.value) * 60) })} />
                            </td>
                            <td>
                              {isExisting(r) && r.time_in && <div><span className="badge badge-info">{replace ? 'replaces existing record' : 'has a record — kept'}</span></div>}
                              {r.flags.map((f) => <div key={f.text}><span className={`badge ${LEVEL_CLASS[f.level]}`}>{f.text}</span></div>)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  );
                })}
              </table>
            </div>
            <p className="muted" style={{ fontSize: 12 }}>
              A time out earlier than the time in counts as after midnight. Untick a day to leave it out.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-primary" disabled={saving || !included.length} onClick={doImport}>
                {saving ? 'Importing…' : `Import ${withTimes.length} records · ${included.length} days`}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
