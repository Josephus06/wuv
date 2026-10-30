// Time In / Time Out, in one place for every way of stamping: My Attendance and the Time
// Clock app (a signed-in employee, source 'self') and the branch kiosk (an employee PIN on a
// registered device, source 'kiosk'). Same rules everywhere: the server's clock, the shift
// the day is scheduled for, one record per work day.
//
// A shift with a stamped lunch (shifts.lunch_start / lunch_end) takes four stamps a day:
// In, Lunch Out, Lunch In, Out. nextAction() says which one the next stamp is.
const pool = require('../db');
const {
  MAX_OPEN_HOURS, HttpError, toDbUtc, fromDbUtc, toLocalDisplay, addDays, todayLocal,
  isOvernight, scheduledShift, scheduleSnapshot, metricsFor, lunchOf,
} = require('./attendance');

const LOG_SELECT = `
  SELECT l.*, DATE_FORMAT(l.work_date, '%Y-%m-%d') AS work_date, COALESCE(l.shift_name, s.name) AS shift_name
  FROM attendance_logs l
  LEFT JOIN shifts s ON s.id = l.shift_id`;

function serializeLog(row) {
  if (!row) return null;
  return {
    id: row.id,
    employee_id: row.employee_id,
    work_date: row.work_date,
    shift_id: row.shift_id,
    shift_name: row.shift_name || null,
    scheduled_start_local: toLocalDisplay(row.scheduled_start),
    scheduled_end_local: toLocalDisplay(row.scheduled_end),
    time_in: row.time_in,
    time_out: row.time_out,
    time_in_local: toLocalDisplay(row.time_in),
    time_out_local: toLocalDisplay(row.time_out),
    lunch_out: row.lunch_out || null,
    lunch_in: row.lunch_in || null,
    lunch_out_local: toLocalDisplay(row.lunch_out),
    lunch_in_local: toLocalDisplay(row.lunch_in),
    scheduled_lunch_start_local: toLocalDisplay(row.scheduled_lunch_start),
    scheduled_lunch_end_local: toLocalDisplay(row.scheduled_lunch_end),
    halfday_absent: !!row.halfday_absent,
    late_minutes: row.late_minutes,
    undertime_minutes: row.undertime_minutes,
    overtime_minutes: row.overtime_minutes,
    // Set when a supervisor approved the day's overtime; payroll then pays this figure.
    approved_ot_minutes: row.approved_ot_minutes ?? null,
    worked_minutes: row.worked_minutes,
    source: row.source,
    remarks: row.remarks,
    original_time_in_local: toLocalDisplay(row.original_time_in),
    original_time_out_local: toLocalDisplay(row.original_time_out),
    edited_at: row.edited_at,
  };
}

function openThreshold(now) {
  return toDbUtc(new Date(now.getTime() - MAX_OPEN_HOURS * 3600000));
}

// The most recent time-in still waiting for its time-out, if it is recent enough to still
// be running (see MAX_OPEN_HOURS).
async function openLog(employeeId, now, conn = pool) {
  const [[row]] = await conn.query(
    `${LOG_SELECT} WHERE l.employee_id = ? AND l.time_out IS NULL AND l.time_in >= ?
     ORDER BY l.time_in DESC LIMIT 1`,
    [employeeId, openThreshold(now)]
  );
  return row || null;
}

// Which work date a time-in made right now belongs to. Normally today -- but at 01:30
// during a 22:00-06:00 shift that started yesterday, it is yesterday's shift being
// (late) clocked into, as long as yesterday has no record yet.
async function currentWorkDate(employeeId, now) {
  const today = todayLocal(now);
  const yesterday = addDays(today, -1);
  const prev = await scheduledShift(employeeId, yesterday);
  if (prev && isOvernight(prev) && now < prev.end) {
    const [[taken]] = await pool.query(
      'SELECT id FROM attendance_logs WHERE employee_id = ? AND work_date = ?', [employeeId, yesterday]
    );
    if (!taken) return { workDate: yesterday, schedule: prev };
  }
  return { workDate: today, schedule: await scheduledShift(employeeId, today) };
}

const HOUR = 3600000;

// Which stamp comes next: 'in', 'lunch_out', 'lunch_in', 'out', or 'done' for the day.
// Lunch Out is offered from an hour before lunch until lunch ends, and not at all to someone
// who timed in after lunch began (a half day); out at lunch, the next stamp is the return
// until the shift's end -- after that a forgotten Lunch In makes it the Time Out.
function nextAction(open, todayLog, now) {
  if (!open) return todayLog?.time_out ? 'done' : 'in';
  if (!open.scheduled_lunch_start || !open.scheduled_lunch_end || open.lunch_in) return 'out';
  const lunchStart = fromDbUtc(open.scheduled_lunch_start);
  const lunchEnd = fromDbUtc(open.scheduled_lunch_end);
  if (!open.lunch_out) {
    if (fromDbUtc(open.time_in) >= lunchStart) return 'out';
    return now >= new Date(lunchStart.getTime() - HOUR) && now < lunchEnd ? 'lunch_out' : 'out';
  }
  return open.scheduled_end && now >= fromDbUtc(open.scheduled_end) ? 'out' : 'lunch_in';
}

// The time of the latest stamp on an open record, for "you just stamped" guards.
function lastStampAt(open) {
  return fromDbUtc(open.lunch_in || open.lunch_out || open.time_in);
}

// What a time clock shows before anyone presses anything: is the employee in, and the
// shift a Time In now would be measured against.
async function clockStatus(employeeId, now = new Date()) {
  const open = await openLog(employeeId, now);
  const { workDate, schedule } = await currentWorkDate(employeeId, now);
  const [[todayLog]] = await pool.query(`${LOG_SELECT} WHERE l.employee_id = ? AND l.work_date = ?`, [employeeId, workDate]);
  return {
    next_action: nextAction(open, todayLog, now),
    open_log: serializeLog(open),
    today: {
      work_date: workDate,
      shift: schedule ? {
        name: schedule.shift_name,
        start_time: schedule.start_time,
        end_time: schedule.end_time,
        grace_minutes: schedule.grace_minutes,
        lunch_start: schedule.lunch_start || null,
        lunch_end: schedule.lunch_end || null,
        scheduled_start_local: toLocalDisplay(toDbUtc(schedule.start)),
        scheduled_end_local: toLocalDisplay(toDbUtc(schedule.end)),
      } : null,
      log: serializeLog(todayLog),
    },
  };
}

// `by`: { source: 'self' | 'kiosk', userId?, deviceId? }.
async function stampIn(employeeId, by) {
  const now = new Date();
  const open = await openLog(employeeId, now);
  if (open) throw new HttpError(409, `Already timed in since ${toLocalDisplay(open.time_in)}. Time out first.`);

  const { workDate, schedule } = await currentWorkDate(employeeId, now);
  const snapshot = scheduleSnapshot(schedule);
  let result;
  try {
    [result] = await pool.query('INSERT INTO attendance_logs SET ?', [{
      employee_id: employeeId,
      work_date: workDate,
      ...snapshot,
      time_in: toDbUtc(now),
      ...metricsFor(snapshot, now, null),
      source: by.source,
      recorded_by_user_id: by.userId || null,
      ...(by.deviceId ? { in_device_id: by.deviceId } : {}),
    }]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'There is already a time record for this work day. Ask HR to correct it if it is wrong.');
    throw err;
  }
  const [[row]] = await pool.query(`${LOG_SELECT} WHERE l.id = ?`, [result.insertId]);
  return serializeLog(row);
}

// `by`: { remarks?, deviceId? }.
async function stampOut(employeeId, by = {}) {
  const now = new Date();
  const open = await openLog(employeeId, now);
  if (!open) throw new HttpError(409, `No time-in from the last ${MAX_OPEN_HOURS} hours to time out of. Ask HR to correct an older record.`);

  let remarks = by.remarks ? String(by.remarks).trim().slice(0, 255) : open.remarks;
  if (open.lunch_out && !open.lunch_in) remarks = [remarks, 'No lunch time-in'].filter(Boolean).join(' · ').slice(0, 255);
  await pool.query(
    // time_out IS NULL guards a double-tapped Time Out: the second one changes nothing.
    'UPDATE attendance_logs SET ?, time_out = ?, remarks = ? WHERE id = ? AND time_out IS NULL',
    [{ ...metricsFor(open, fromDbUtc(open.time_in), now, lunchOf(open)), ...(by.deviceId ? { out_device_id: by.deviceId } : {}) },
      toDbUtc(now), remarks, open.id]
  );
  const [[row]] = await pool.query(`${LOG_SELECT} WHERE l.id = ?`, [open.id]);
  return serializeLog(row);
}

// Lunch Out / Lunch In on the open record. `column` is 'lunch_out' or 'lunch_in'.
async function stampLunch(employeeId, column) {
  const now = new Date();
  const open = await openLog(employeeId, now);
  if (!open) throw new HttpError(409, 'Time in first.');
  if (column === 'lunch_out' && open.lunch_out) throw new HttpError(409, `Already out to lunch since ${toLocalDisplay(open.lunch_out)}.`);
  if (column === 'lunch_in' && !open.lunch_out) throw new HttpError(409, 'Stamp Lunch Out first.');
  if (column === 'lunch_in' && open.lunch_in) throw new HttpError(409, `Already back from lunch at ${toLocalDisplay(open.lunch_in)}.`);
  const lunch = { ...lunchOf(open), [column === 'lunch_out' ? 'lunchOut' : 'lunchIn']: now };
  await pool.query(
    `UPDATE attendance_logs SET ?, ${column} = ? WHERE id = ? AND ${column} IS NULL AND time_out IS NULL`,
    [metricsFor(open, fromDbUtc(open.time_in), null, lunch), toDbUtc(now), open.id]
  );
  const [[row]] = await pool.query(`${LOG_SELECT} WHERE l.id = ?`, [open.id]);
  return serializeLog(row);
}

// One stamp of any kind. `by` as for stampIn / stampOut.
function stamp(employeeId, action, by) {
  if (action === 'in') return stampIn(employeeId, by);
  if (action === 'out') return stampOut(employeeId, by);
  if (action === 'lunch_out' || action === 'lunch_in') return stampLunch(employeeId, action);
  throw new HttpError(400, 'Unknown time clock action');
}

module.exports = {
  LOG_SELECT, serializeLog, openLog, currentWorkDate, clockStatus, nextAction, lastStampAt,
  stampIn, stampOut, stampLunch, stamp,
};
