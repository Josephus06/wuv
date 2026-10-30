// Time and schedule arithmetic shared by the shift, shift-assignment and attendance routes.
//
// Every DATETIME this module writes is UTC wall-clock ("YYYY-MM-DD HH:MM:SS", no marker),
// the same contract client/src/utils/datetime.js#parseUtc reads. What a "work date" is, and
// whether someone was late, is a question about the BUSINESS's clock, not the server's or
// the database's -- a 08:00 shift starts at 08:00 in Manila whether the API runs in a UTC
// container or on a dev box -- so those are always worked out in BUSINESS_TZ.
const pool = require('../db');

const BUSINESS_TZ = process.env.BUSINESS_TZ || 'Asia/Manila';

// A time-in older than this with no time-out is treated as forgotten rather than still
// running: pressing Time Out the next morning must not close yesterday's record as a
// 26-hour shift. HR fixes those by hand from the Attendance page.
const MAX_OPEN_HOURS = 20;

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

function localParts(date) {
  const p = Object.fromEntries(partsFormatter.formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}

function pad(n) { return String(n).padStart(2, '0'); }

// Date -> "YYYY-MM-DD HH:MM:SS" in UTC, for writing to the database.
function toDbUtc(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function fromDbUtc(value) {
  if (!value) return null;
  return new Date(`${String(value).replace(' ', 'T')}Z`);
}

// A UTC database value -> "YYYY-MM-DD HH:MM" on the business clock, for display and for
// pre-filling the correction form. Returned by the API so the browser's own timezone
// never enters into what HR sees.
function toLocalDisplay(value) {
  const d = fromDbUtc(value);
  if (!d) return null;
  const { date, time } = localParts(d);
  return `${date} ${time.slice(0, 5)}`;
}

// "YYYY-MM-DD" + "HH:MM[:SS]" on the business clock -> the UTC instant. Two passes so a
// zone with daylight saving lands on the right side of a transition; for Manila (no DST)
// the second pass is a no-op.
function localToUtc(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm, ss = 0] = timeStr.split(':').map(Number);
  const wanted = Date.UTC(y, m - 1, d, hh, mm, ss);
  let guess = wanted;
  for (let i = 0; i < 2; i += 1) {
    const p = localParts(new Date(guess));
    const [py, pm, pd] = p.date.split('-').map(Number);
    const [ph, pmi, ps] = p.time.split(':').map(Number);
    guess += wanted - Date.UTC(py, pm - 1, pd, ph, pmi, ps);
  }
  return new Date(guess);
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function weekdayOf(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay(); // 0 = Sunday
}

function todayLocal(now = new Date()) {
  return localParts(now).date;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const LOCAL_DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[T ]([01]\d|2[0-3]):([0-5]\d)$/;

function isIsoDate(v) {
  return typeof v === 'string' && ISO_DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

function isTime(v) {
  return typeof v === 'string' && TIME_RE.test(v);
}

// "YYYY-MM-DDTHH:MM" (what <input type="datetime-local"> sends) on the business clock -> UTC Date.
function parseLocalDateTime(v) {
  const m = typeof v === 'string' ? v.match(LOCAL_DATETIME_RE) : null;
  if (!m) return null;
  return localToUtc(m[1], `${m[2]}:${m[3]}`);
}

// days_of_week is stored as "1,2,3,4,5" (0 = Sunday). Kept as text rather than a SET so the
// same string round-trips through the API and the form without a mapping table.
function parseDays(value) {
  if (Array.isArray(value)) return [...new Set(value.map(Number))].filter((n) => n >= 0 && n <= 6).sort();
  if (typeof value !== 'string' || !value.trim()) return [];
  return parseDays(value.split(','));
}

function isOvernight(shift) {
  return shift.end_time <= shift.start_time;
}

// A shift's start and end as UTC instants for a given work date. An overnight shift
// (22:00-06:00) ends on the following calendar day but still belongs to the date it began.
// A stamped lunch (lunch_start / lunch_end) falls on the next calendar day when it is earlier in
// the day than the shift's start (an overnight shift's lunch after midnight).
function scheduleFor(workDate, shift) {
  const start = localToUtc(workDate, shift.start_time);
  const end = localToUtc(isOvernight(shift) ? addDays(workDate, 1) : workDate, shift.end_time);
  if (!shift.lunch_start || !shift.lunch_end) return { start, end, lunchStart: null, lunchEnd: null };
  const lunchDate = (t) => (t < shift.start_time ? addDays(workDate, 1) : workDate);
  return {
    start,
    end,
    lunchStart: localToUtc(lunchDate(shift.lunch_start), shift.lunch_start),
    lunchEnd: localToUtc(lunchDate(shift.lunch_end), shift.lunch_end),
  };
}

// The assignment that governs one employee's day: of the assignments covering the date AND
// working that weekday, the latest-starting one. Weekday-aware so one person can hold two at
// once -- Main Office's Mon-Fri shift beside its shorter Saturday one. A day no assignment
// works is a rest day (null).
function pickAssignment(assignments, workDate) {
  const weekday = weekdayOf(workDate);
  const covering = assignments
    .filter((a) => a.effective_from <= workDate && (!a.effective_to || a.effective_to >= workDate)
      && parseDays(a.days_of_week).includes(weekday))
    .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1));
  return covering[0] || null;
}

const SHIFT_FIELDS = `s.name AS shift_name, s.start_time, s.end_time, s.grace_minutes, s.break_minutes,
         COALESCE(s.paid_break_minutes, 0) AS paid_break_minutes, s.lunch_start, s.lunch_end,
         s.late_block_minutes, s.halfday_late_minutes, COALESCE(s.undertime_grace_minutes, 0) AS undertime_grace_minutes`;

const ASSIGNMENT_SELECT = `
  SELECT a.id AS assignment_id, a.employee_id, a.shift_id,
         DATE_FORMAT(a.effective_from, '%Y-%m-%d') AS effective_from,
         DATE_FORMAT(a.effective_to, '%Y-%m-%d') AS effective_to,
         a.days_of_week, ${SHIFT_FIELDS}
  FROM employee_shift_assignments a
  JOIN shifts s ON s.id = a.shift_id`;

async function assignmentsFor(employeeIds, from, to, conn = pool) {
  if (!employeeIds.length) return [];
  const [rows] = await conn.query(
    `${ASSIGNMENT_SELECT}
     WHERE a.employee_id IN (?) AND a.effective_from <= ? AND (a.effective_to IS NULL OR a.effective_to >= ?)`,
    [employeeIds, to, from]
  );
  return rows;
}

// A supervisor's plotted days (employee_schedules) in a range, keyed "employeeId|date". The
// value is the shift, or null for a plotted rest day -- a key that is present always wins
// over the Shift Assignment, null included.
async function plottedFor(employeeIds, from, to, conn = pool) {
  const plotted = new Map();
  if (!employeeIds.length) return plotted;
  const [rows] = await conn.query(
    `SELECT es.employee_id, DATE_FORMAT(es.work_date, '%Y-%m-%d') AS work_date, es.shift_id, ${SHIFT_FIELDS}
     FROM employee_schedules es LEFT JOIN shifts s ON s.id = es.shift_id
     WHERE es.employee_id IN (?) AND es.work_date BETWEEN ? AND ?`,
    [employeeIds, from, to]
  ).catch((err) => {
    if (err.code === 'ER_NO_SUCH_TABLE') return [[]]; // before add-schedules.js has run
    throw err;
  });
  for (const r of rows) plotted.set(`${r.employee_id}|${r.work_date}`, r.shift_id ? r : null);
  return plotted;
}

// Everything that decides who works when, for a set of employees over a range.
async function scheduleSources(employeeIds, from, to, conn = pool) {
  const [assignments, plotted] = await Promise.all([
    assignmentsFor(employeeIds, from, to, conn),
    plottedFor(employeeIds, from, to, conn),
  ]);
  const byEmployee = new Map();
  for (const a of assignments) {
    if (!byEmployee.has(a.employee_id)) byEmployee.set(a.employee_id, []);
    byEmployee.get(a.employee_id).push(a);
  }
  return { assignments: byEmployee, plotted };
}

// The shift one employee works on one date: the plotted day if there is one, otherwise their
// Shift Assignment for that weekday. Null = rest day. `plotted: true` marks a plotted day.
function dayShift(sources, employeeId, date) {
  const key = `${employeeId}|${date}`;
  if (sources.plotted.has(key)) {
    const p = sources.plotted.get(key);
    return p ? { ...p, plotted: true } : null;
  }
  return pickAssignment(sources.assignments.get(employeeId) || [], date);
}

// The scheduled shift for one employee on one work date, or null for a rest day / nothing
// scheduled. Carries the UTC start and end so callers can compare against punches.
async function scheduledShift(employeeId, workDate, conn = pool) {
  const sources = await scheduleSources([employeeId], workDate, workDate, conn);
  const s = dayShift(sources, employeeId, workDate);
  if (!s) return null;
  return { ...s, ...scheduleFor(workDate, s) };
}

function minutesBetween(a, b) {
  return Math.round((b - a) / 60000);
}

// Late / undertime / overtime / worked minutes for one record. Late counts from the
// scheduled start, but only once the grace period is used up: 08:04 on a 5-minute grace is
// on time, 08:06 is 6 minutes late. Break minutes come off worked time only when the record
// spans more than the break itself; paid-break minutes (the 15-minute breaks outside Shift
// In / Out) are added back. A record with no schedule (unscheduled day) still gets its worked
// time; the schedule-relative figures stay zero.
//
// A shift can be stricter (see db/add-shift-lunch.js):
//   lunch stamps     back from lunch after lunchEnd is late too (no grace); out to lunch
//                    before lunchStart is undertime. Worked time is the two halves.
//   lateBlock        late counts from the END of the grace period and goes up in blocks:
//                    8:20 on a 15-minute grace is 5 minutes -> 30; 46 minutes -> 60.
//   halfdayLate      late this much or more, in the morning or after lunch, is half a day
//                    absent (halfday_absent) instead of late minutes.
//   undertimeGrace   leaving this close to the end is not undertime; earlier counts from
//                    that point (4:40 on a 5:00 end with 15 minutes is 5 minutes).
function computeMetrics({
  timeIn, timeOut, scheduledStart, scheduledEnd, graceMinutes = 0, breakMinutes = 0, paidBreakMinutes = 0,
  lunchStart = null, lunchEnd = null, lunchOut = null, lunchIn = null,
  lateBlockMinutes = null, halfdayLateMinutes = null, undertimeGraceMinutes = 0,
}) {
  const blocks = lateBlockMinutes > 0;
  let halfday = false;
  const penalize = (minutes) => {
    if (minutes <= 0) return 0;
    if (halfdayLateMinutes > 0 && minutes >= halfdayLateMinutes && !halfday) { halfday = true; return 0; }
    return blocks ? Math.ceil(minutes / lateBlockMinutes) * lateBlockMinutes : minutes;
  };
  const lateRaw = scheduledStart ? minutesBetween(scheduledStart, timeIn) : 0;
  let late = penalize(lateRaw > graceMinutes ? (blocks ? lateRaw - graceMinutes : lateRaw) : 0);
  if (lunchEnd && lunchIn) late += penalize(minutesBetween(lunchEnd, lunchIn));
  if (!timeOut) {
    return { late_minutes: late, undertime_minutes: 0, overtime_minutes: 0, worked_minutes: 0, halfday_absent: halfday };
  }
  const span = Math.max(0, minutesBetween(timeIn, timeOut));
  const endGap = scheduledEnd ? minutesBetween(timeOut, scheduledEnd) : 0;
  let undertime = endGap > undertimeGraceMinutes ? endGap - undertimeGraceMinutes : 0;
  if (lunchStart && lunchOut) undertime += Math.max(0, minutesBetween(lunchOut, lunchStart));
  const worked = lunchOut && lunchIn && lunchIn > lunchOut && timeOut > lunchIn
    ? minutesBetween(timeIn, lunchOut) + minutesBetween(lunchIn, timeOut) + paidBreakMinutes
    : (span > breakMinutes ? span - breakMinutes : span) + (span > breakMinutes ? paidBreakMinutes : 0);
  return {
    late_minutes: late,
    undertime_minutes: undertime,
    overtime_minutes: scheduledEnd ? Math.max(0, minutesBetween(scheduledEnd, timeOut)) : 0,
    worked_minutes: Math.max(0, worked),
    halfday_absent: halfday,
  };
}

// The schedule a time record is measured against, as stored on the record: a copy, so later
// edits to the shift or the plotted schedule only reach a record when it is re-measured.
function scheduleSnapshot(schedule) {
  return {
    shift_id: schedule ? schedule.shift_id : null,
    shift_name: schedule ? schedule.shift_name : null,
    scheduled_start: schedule ? toDbUtc(schedule.start) : null,
    scheduled_end: schedule ? toDbUtc(schedule.end) : null,
    grace_minutes: schedule ? schedule.grace_minutes : 0,
    break_minutes: schedule ? schedule.break_minutes : 0,
    paid_break_minutes: schedule ? schedule.paid_break_minutes || 0 : 0,
    scheduled_lunch_start: schedule?.lunchStart ? toDbUtc(schedule.lunchStart) : null,
    scheduled_lunch_end: schedule?.lunchEnd ? toDbUtc(schedule.lunchEnd) : null,
    late_block_minutes: schedule ? schedule.late_block_minutes ?? null : null,
    halfday_late_minutes: schedule ? schedule.halfday_late_minutes ?? null : null,
    undertime_grace_minutes: schedule ? schedule.undertime_grace_minutes || 0 : 0,
  };
}

// `lunch`: { lunchOut, lunchIn } as Dates, when the record has lunch stamps.
function metricsFor(snapshot, timeIn, timeOut, lunch = {}) {
  return computeMetrics({
    timeIn,
    timeOut,
    scheduledStart: fromDbUtc(snapshot.scheduled_start),
    scheduledEnd: fromDbUtc(snapshot.scheduled_end),
    graceMinutes: snapshot.grace_minutes,
    breakMinutes: snapshot.break_minutes,
    paidBreakMinutes: snapshot.paid_break_minutes || 0,
    lunchStart: fromDbUtc(snapshot.scheduled_lunch_start),
    lunchEnd: fromDbUtc(snapshot.scheduled_lunch_end),
    lunchOut: lunch.lunchOut || null,
    lunchIn: lunch.lunchIn || null,
    lateBlockMinutes: snapshot.late_block_minutes ?? null,
    halfdayLateMinutes: snapshot.halfday_late_minutes ?? null,
    undertimeGraceMinutes: snapshot.undertime_grace_minutes || 0,
  });
}

// The lunch stamps of a stored record, for metricsFor.
function lunchOf(log) {
  return { lunchOut: fromDbUtc(log.lunch_out), lunchIn: fromDbUtc(log.lunch_in) };
}

// Re-measures the time record (if any) of one employee's day against the schedule as it is
// NOW -- for when a supervisor changes a day's shift after the employee already timed in
// (an emergency switch from Opening to Closing entered late). The stamped times are not
// touched; only which shift they are measured against, and so late / undertime / overtime.
// Returns true when there was a record to re-measure.
async function remeasureDay(employeeId, workDate, conn = pool) {
  const [[log]] = await conn.query(
    'SELECT id, time_in, time_out, lunch_out, lunch_in FROM attendance_logs WHERE employee_id = ? AND work_date = ?',
    [employeeId, workDate]
  );
  if (!log) return false;
  const snapshot = scheduleSnapshot(await scheduledShift(employeeId, workDate, conn));
  await conn.query('UPDATE attendance_logs SET ? WHERE id = ?', [{
    ...snapshot,
    ...metricsFor(snapshot, fromDbUtc(log.time_in), log.time_out ? fromDbUtc(log.time_out) : null, lunchOf(log)),
  }, log.id]);
  return true;
}

// The employee record behind the logged-in user. Read fresh rather than from the JWT, so
// linking or unlinking an employee in Users takes effect without a re-login.
async function employeeForUser(userId) {
  const [[row]] = await pool.query(
    `SELECT e.id, e.employee_code, e.first_name, e.last_name, e.is_active, d.name AS department_name
     FROM users u
     JOIN employees e ON e.id = u.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE u.id = ?`,
    [userId]
  );
  return row || null;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = {
  BUSINESS_TZ,
  MAX_OPEN_HOURS,
  HttpError,
  toDbUtc,
  fromDbUtc,
  toLocalDisplay,
  localToUtc,
  addDays,
  weekdayOf,
  todayLocal,
  isIsoDate,
  isTime,
  parseLocalDateTime,
  parseDays,
  isOvernight,
  scheduleFor,
  pickAssignment,
  assignmentsFor,
  plottedFor,
  scheduleSources,
  dayShift,
  scheduledShift,
  computeMetrics,
  scheduleSnapshot,
  metricsFor,
  lunchOf,
  remeasureDay,
  employeeForUser,
};
