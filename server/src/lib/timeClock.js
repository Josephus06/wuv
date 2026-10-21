// Time In / Time Out, in one place for every way of stamping: My Attendance and the Time
// Clock app (a signed-in employee, source 'self') and the branch kiosk (an employee PIN on a
// registered device, source 'kiosk'). Same rules everywhere: the server's clock, the shift
// the day is scheduled for, one record per work day.
const pool = require('../db');
const {
  MAX_OPEN_HOURS, HttpError, toDbUtc, fromDbUtc, toLocalDisplay, addDays, todayLocal,
  isOvernight, scheduledShift, scheduleSnapshot, metricsFor,
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
    late_minutes: row.late_minutes,
    undertime_minutes: row.undertime_minutes,
    overtime_minutes: row.overtime_minutes,
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

// What a time clock shows before anyone presses anything: is the employee in, and the
// shift a Time In now would be measured against.
async function clockStatus(employeeId, now = new Date()) {
  const open = await openLog(employeeId, now);
  const { workDate, schedule } = await currentWorkDate(employeeId, now);
  const [[todayLog]] = await pool.query(`${LOG_SELECT} WHERE l.employee_id = ? AND l.work_date = ?`, [employeeId, workDate]);
  return {
    open_log: serializeLog(open),
    today: {
      work_date: workDate,
      shift: schedule ? {
        name: schedule.shift_name,
        start_time: schedule.start_time,
        end_time: schedule.end_time,
        grace_minutes: schedule.grace_minutes,
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

  const remarks = by.remarks ? String(by.remarks).trim().slice(0, 255) : open.remarks;
  await pool.query(
    // time_out IS NULL guards a double-tapped Time Out: the second one changes nothing.
    'UPDATE attendance_logs SET ?, time_out = ?, remarks = ? WHERE id = ? AND time_out IS NULL',
    [{ ...metricsFor(open, fromDbUtc(open.time_in), now), ...(by.deviceId ? { out_device_id: by.deviceId } : {}) },
      toDbUtc(now), remarks, open.id]
  );
  const [[row]] = await pool.query(`${LOG_SELECT} WHERE l.id = ?`, [open.id]);
  return serializeLog(row);
}

module.exports = { LOG_SELECT, serializeLog, openLog, currentWorkDate, clockStatus, stampIn, stampOut };
