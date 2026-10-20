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
function scheduleFor(workDate, shift) {
  const start = localToUtc(workDate, shift.start_time);
  const end = localToUtc(isOvernight(shift) ? addDays(workDate, 1) : workDate, shift.end_time);
  return { start, end };
}

// The assignment that governs one employee's day: the latest-starting one whose window
// covers the date. A covering assignment that does not include that weekday makes the day a
// rest day (null), rather than falling through to an older assignment.
function pickAssignment(assignments, workDate) {
  const covering = assignments
    .filter((a) => a.effective_from <= workDate && (!a.effective_to || a.effective_to >= workDate))
    .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1));
  const a = covering[0];
  if (!a) return null;
  return parseDays(a.days_of_week).includes(weekdayOf(workDate)) ? a : null;
}

const ASSIGNMENT_SELECT = `
  SELECT a.id AS assignment_id, a.employee_id, a.shift_id,
         DATE_FORMAT(a.effective_from, '%Y-%m-%d') AS effective_from,
         DATE_FORMAT(a.effective_to, '%Y-%m-%d') AS effective_to,
         a.days_of_week, s.name AS shift_name, s.start_time, s.end_time,
         s.grace_minutes, s.break_minutes
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

// The scheduled shift for one employee on one work date, or null for a rest day / no
// assignment. Carries the UTC start and end so callers can compare against punches.
async function scheduledShift(employeeId, workDate, conn = pool) {
  const a = pickAssignment(await assignmentsFor([employeeId], workDate, workDate, conn), workDate);
  if (!a) return null;
  return { ...a, ...scheduleFor(workDate, a) };
}

function minutesBetween(a, b) {
  return Math.round((b - a) / 60000);
}

// Late / undertime / overtime / worked minutes for one record. Late counts from the
// scheduled start, but only once the grace period is used up: 08:04 on a 5-minute grace is
// on time, 08:06 is 6 minutes late. Break minutes come off worked time only when the record
// spans more than the break itself. A record with no schedule (unscheduled day) still gets
// its worked time; the schedule-relative figures stay zero.
function computeMetrics({ timeIn, timeOut, scheduledStart, scheduledEnd, graceMinutes = 0, breakMinutes = 0 }) {
  const lateRaw = scheduledStart ? minutesBetween(scheduledStart, timeIn) : 0;
  const late = lateRaw > graceMinutes ? lateRaw : 0;
  if (!timeOut) {
    return { late_minutes: late, undertime_minutes: 0, overtime_minutes: 0, worked_minutes: 0 };
  }
  const span = Math.max(0, minutesBetween(timeIn, timeOut));
  return {
    late_minutes: late,
    undertime_minutes: scheduledEnd ? Math.max(0, minutesBetween(timeOut, scheduledEnd)) : 0,
    overtime_minutes: scheduledEnd ? Math.max(0, minutesBetween(scheduledEnd, timeOut)) : 0,
    worked_minutes: span > breakMinutes ? span - breakMinutes : span,
  };
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
  scheduledShift,
  computeMetrics,
  employeeForUser,
};
