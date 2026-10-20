const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const {
  BUSINESS_TZ, MAX_OPEN_HOURS, HttpError,
  toDbUtc, fromDbUtc, toLocalDisplay, addDays, todayLocal, isIsoDate, parseLocalDateTime,
  isOvernight, scheduleFor, pickAssignment, assignmentsFor, scheduledShift, computeMetrics,
  employeeForUser,
} = require('../lib/attendance');

const router = express.Router();
const ROUTE = '/attendance';
const MAX_REPORT_DAYS = 62;

const LOG_SELECT = `
  SELECT l.*, DATE_FORMAT(l.work_date, '%Y-%m-%d') AS work_date, s.name AS shift_name
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

function scheduleSnapshot(schedule) {
  return {
    shift_id: schedule ? schedule.shift_id : null,
    scheduled_start: schedule ? toDbUtc(schedule.start) : null,
    scheduled_end: schedule ? toDbUtc(schedule.end) : null,
    grace_minutes: schedule ? schedule.grace_minutes : 0,
    break_minutes: schedule ? schedule.break_minutes : 0,
  };
}

function metricsFor(snapshot, timeIn, timeOut) {
  return computeMetrics({
    timeIn,
    timeOut,
    scheduledStart: fromDbUtc(snapshot.scheduled_start),
    scheduledEnd: fromDbUtc(snapshot.scheduled_end),
    graceMinutes: snapshot.grace_minutes,
    breakMinutes: snapshot.break_minutes,
  });
}

async function requireEmployee(req) {
  const employee = await employeeForUser(req.user.id);
  if (!employee) throw new HttpError(400, 'Your user account is not linked to an employee record. Ask HR or an admin to link it in Users & Permissions.');
  if (!employee.is_active) throw new HttpError(400, 'Your employee record is inactive.');
  return employee;
}

// ---------------------------------------------------------------------------------------
// Self-service: any logged-in user stamps their OWN time. No page permission is needed --
// the employee is always the one linked to the caller's account, never one from the body.
// ---------------------------------------------------------------------------------------

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const employee = await employeeForUser(req.user.id);
    const now = new Date();
    if (!employee) {
      return res.json({ employee: null, timezone: BUSINESS_TZ, now_local: toLocalDisplay(toDbUtc(now)) });
    }

    const open = await openLog(employee.id, now);
    const { workDate, schedule } = await currentWorkDate(employee.id, now);
    const [[todayLog]] = await pool.query(`${LOG_SELECT} WHERE l.employee_id = ? AND l.work_date = ?`, [employee.id, workDate]);
    const [recent] = await pool.query(
      `${LOG_SELECT} WHERE l.employee_id = ? AND l.work_date >= ? ORDER BY l.work_date DESC`,
      [employee.id, addDays(todayLocal(now), -13)]
    );

    res.json({
      employee,
      timezone: BUSINESS_TZ,
      now_local: toLocalDisplay(toDbUtc(now)),
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
      recent: recent.map(serializeLog),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/me/time-in', requireAuth, async (req, res, next) => {
  try {
    const employee = await requireEmployee(req);
    const now = new Date();

    const open = await openLog(employee.id, now);
    if (open) {
      return res.status(409).json({ error: `You are still timed in since ${toLocalDisplay(open.time_in)}. Time out first.` });
    }

    const { workDate, schedule } = await currentWorkDate(employee.id, now);
    const snapshot = scheduleSnapshot(schedule);
    const [result] = await pool.query('INSERT INTO attendance_logs SET ?', [{
      employee_id: employee.id,
      work_date: workDate,
      ...snapshot,
      time_in: toDbUtc(now),
      ...metricsFor(snapshot, now, null),
      source: 'self',
      recorded_by_user_id: req.user.id,
    }]);

    const [[row]] = await pool.query(`${LOG_SELECT} WHERE l.id = ?`, [result.insertId]);
    res.status(201).json(serializeLog(row));
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'You already have a time record for this work day. Ask HR to correct it if it is wrong.' });
    }
    next(err);
  }
});

router.post('/me/time-out', requireAuth, async (req, res, next) => {
  try {
    const employee = await requireEmployee(req);
    const now = new Date();

    const open = await openLog(employee.id, now);
    if (!open) {
      return res.status(409).json({ error: `You have no time-in from the last ${MAX_OPEN_HOURS} hours to time out of. Ask HR to correct an older record.` });
    }

    const remarks = req.body?.remarks ? String(req.body.remarks).trim().slice(0, 255) : open.remarks;
    await pool.query(
      // time_out IS NULL guards a double-tapped Time Out: the second one changes nothing.
      'UPDATE attendance_logs SET ?, time_out = ?, remarks = ? WHERE id = ? AND time_out IS NULL',
      [metricsFor(open, fromDbUtc(open.time_in), now), toDbUtc(now), remarks, open.id]
    );

    const [[row]] = await pool.query(`${LOG_SELECT} WHERE l.id = ?`, [open.id]);
    res.json(serializeLog(row));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------------
// HR: the attendance report and manual corrections.
// ---------------------------------------------------------------------------------------

function statusOf(log, schedule, now) {
  if (log) {
    if (!log.time_out) {
      return now - fromDbUtc(log.time_in) > MAX_OPEN_HOURS * 3600000 ? 'No Time Out' : 'On Duty';
    }
    return log.late_minutes > 0 ? 'Late' : 'Present';
  }
  return schedule.end < now ? 'Absent' : 'Scheduled';
}

// One row per employee per day in [from, to] that was either scheduled or has a record --
// so a scheduled day with no time-in shows up as Absent, which a plain list of punches
// could never show. Rest days with nothing recorded are left out.
//   ?from=&to= (default today, max MAX_REPORT_DAYS), ?employee_id, ?company_id, ?branch_id,
//   ?department_id, ?status
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const now = new Date();
    const today = todayLocal(now);
    const from = req.query.from || today;
    const to = req.query.to || from;
    if (!isIsoDate(from) || !isIsoDate(to)) return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });
    if (from > to) return res.status(400).json({ error: 'from must be on or before to' });
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    if (days > MAX_REPORT_DAYS) return res.status(400).json({ error: `Pick a range of at most ${MAX_REPORT_DAYS} days` });

    const empWhere = [];
    const empParams = [];
    if (req.query.employee_id) { empWhere.push('e.id = ?'); empParams.push(req.query.employee_id); }
    if (req.query.company_id) { empWhere.push('e.company_id = ?'); empParams.push(req.query.company_id); }
    if (req.query.branch_id) { empWhere.push('e.branch_id = ?'); empParams.push(req.query.branch_id); }
    if (req.query.department_id) { empWhere.push('e.department_id = ?'); empParams.push(req.query.department_id); }
    const empFilter = empWhere.length ? `AND ${empWhere.join(' AND ')}` : '';

    const [logs] = await pool.query(
      `${LOG_SELECT} JOIN employees e ON e.id = l.employee_id
       WHERE l.work_date BETWEEN ? AND ? ${empFilter}`,
      [from, to, ...empParams]
    );
    const logMap = new Map(logs.map((l) => [`${l.employee_id}|${l.work_date}`, l]));

    // Inactive employees are only listed for days they actually have a record.
    const [employees] = await pool.query(
      `SELECT e.id, e.employee_code, CONCAT(e.first_name, ' ', e.last_name) AS name, d.name AS department_name, e.is_active,
              c.name AS company_name, l.location_name AS branch_name
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN companies c ON c.id = e.company_id
       LEFT JOIN locations l ON l.id = e.branch_id
       WHERE (e.is_active = TRUE OR e.id IN (?)) ${empFilter}
       ORDER BY e.first_name, e.last_name`,
      [logs.length ? logs.map((l) => l.employee_id) : [0], ...empParams]
    );

    const assignments = await assignmentsFor(employees.map((e) => e.id), from, to);
    const byEmployee = new Map();
    for (const a of assignments) {
      if (!byEmployee.has(a.employee_id)) byEmployee.set(a.employee_id, []);
      byEmployee.get(a.employee_id).push(a);
    }

    const rows = [];
    for (let date = to; date >= from; date = addDays(date, -1)) {
      for (const emp of employees) {
        const log = logMap.get(`${emp.id}|${date}`);
        const assignment = log ? null : pickAssignment(byEmployee.get(emp.id) || [], date);
        if (!log && (!assignment || !emp.is_active)) continue;
        const schedule = assignment ? scheduleFor(date, assignment) : null;
        const s = serializeLog(log);
        rows.push({
          id: log ? `log-${log.id}` : `sched-${emp.id}-${date}`,
          log_id: log ? log.id : null,
          employee_id: emp.id,
          employee_code: emp.employee_code,
          employee_name: emp.name,
          department_name: emp.department_name,
          company_name: emp.company_name,
          branch_name: emp.branch_name,
          work_date: date,
          shift_name: log ? log.shift_name : assignment.shift_name,
          scheduled_start_local: log ? s.scheduled_start_local : toLocalDisplay(toDbUtc(schedule.start)),
          scheduled_end_local: log ? s.scheduled_end_local : toLocalDisplay(toDbUtc(schedule.end)),
          time_in_local: s ? s.time_in_local : null,
          time_out_local: s ? s.time_out_local : null,
          late_minutes: log ? log.late_minutes : 0,
          undertime_minutes: log ? log.undertime_minutes : 0,
          overtime_minutes: log ? log.overtime_minutes : 0,
          worked_minutes: log ? log.worked_minutes : 0,
          source: log ? log.source : null,
          remarks: log ? log.remarks : null,
          original_time_in_local: s ? s.original_time_in_local : null,
          original_time_out_local: s ? s.original_time_out_local : null,
          edited: !!(log && log.edited_at),
          status: statusOf(log, schedule, now),
        });
      }
    }

    const summary = { Present: 0, Late: 0, Absent: 0, 'On Duty': 0, 'No Time Out': 0, Scheduled: 0, late_minutes: 0, undertime_minutes: 0, overtime_minutes: 0, worked_minutes: 0 };
    for (const r of rows) {
      summary[r.status] += 1;
      summary.late_minutes += r.late_minutes;
      summary.undertime_minutes += r.undertime_minutes;
      summary.overtime_minutes += r.overtime_minutes;
      summary.worked_minutes += r.worked_minutes;
    }

    const status = req.query.status;
    res.json({ from, to, timezone: BUSINESS_TZ, summary, rows: status ? rows.filter((r) => r.status === status) : rows });
  } catch (err) {
    next(err);
  }
});

// time_in / time_out arrive as "YYYY-MM-DDTHH:MM" on the business clock (a datetime-local
// input). Checked against the work date so a typo in the year cannot slip through.
function readTimes(body, workDate) {
  const timeIn = parseLocalDateTime(body.time_in);
  if (!timeIn) throw new HttpError(400, 'Time in is required (YYYY-MM-DD HH:MM)');
  const timeOut = body.time_out ? parseLocalDateTime(body.time_out) : null;
  if (body.time_out && !timeOut) throw new HttpError(400, 'Time out must be YYYY-MM-DD HH:MM');
  if (timeOut && timeOut <= timeIn) throw new HttpError(400, 'Time out must be after time in');
  if (timeOut && timeOut - timeIn > 24 * 3600000) throw new HttpError(400, 'A single record cannot be longer than 24 hours');
  const inDate = toLocalDisplay(toDbUtc(timeIn)).slice(0, 10);
  if (inDate < addDays(workDate, -1) || inDate > addDays(workDate, 1)) {
    throw new HttpError(400, `Time in should fall on or next to the work date ${workDate}`);
  }
  if (timeIn > new Date() || (timeOut && timeOut > new Date())) throw new HttpError(400, 'Times cannot be in the future');
  return { timeIn, timeOut };
}

function readRemarks(body) {
  return body.remarks ? String(body.remarks).trim().slice(0, 255) : null;
}

// A record HR enters for someone who could not stamp (forgot, no device, field work).
router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const employeeId = Number(req.body.employee_id);
    const workDate = req.body.work_date;
    if (!employeeId) return res.status(400).json({ error: 'Choose an employee' });
    if (!isIsoDate(workDate)) return res.status(400).json({ error: 'Work date must be a valid date' });
    const { timeIn, timeOut } = readTimes(req.body, workDate);

    const [[emp]] = await pool.query('SELECT id FROM employees WHERE id = ?', [employeeId]);
    if (!emp) return res.status(400).json({ error: 'Employee not found' });

    const snapshot = scheduleSnapshot(await scheduledShift(employeeId, workDate));
    const [result] = await pool.query('INSERT INTO attendance_logs SET ?', [{
      employee_id: employeeId,
      work_date: workDate,
      ...snapshot,
      time_in: toDbUtc(timeIn),
      time_out: timeOut ? toDbUtc(timeOut) : null,
      ...metricsFor(snapshot, timeIn, timeOut),
      source: 'manual',
      remarks: readRemarks(req.body),
      recorded_by_user_id: req.user.id,
    }]);
    const [[row]] = await pool.query(`${LOG_SELECT} WHERE l.id = ?`, [result.insertId]);
    res.status(201).json(serializeLog(row));
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This employee already has a record for that work date. Edit it instead.' });
    next(err);
  }
});

// Corrects the times on a record. The first correction of a self-stamped record keeps the
// employee's own stamps in original_time_in/out. The schedule snapshot is kept as-is, except
// on a record that had none -- that is how a shift assigned after the fact gets applied.
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [[log]] = await pool.query(`${LOG_SELECT} WHERE l.id = ?`, [req.params.id]);
    if (!log) return res.status(404).json({ error: 'Not found' });
    const { timeIn, timeOut } = readTimes(req.body, log.work_date);

    const snapshot = log.scheduled_start
      ? log
      : scheduleSnapshot(await scheduledShift(log.employee_id, log.work_date));
    const keepOriginal = log.source === 'self' && !log.original_time_in;

    await pool.query('UPDATE attendance_logs SET ? WHERE id = ?', [{
      shift_id: snapshot.shift_id,
      scheduled_start: snapshot.scheduled_start,
      scheduled_end: snapshot.scheduled_end,
      grace_minutes: snapshot.grace_minutes,
      break_minutes: snapshot.break_minutes,
      time_in: toDbUtc(timeIn),
      time_out: timeOut ? toDbUtc(timeOut) : null,
      ...metricsFor(snapshot, timeIn, timeOut),
      remarks: readRemarks(req.body),
      ...(keepOriginal ? { original_time_in: log.time_in, original_time_out: log.time_out } : {}),
      edited_by_user_id: req.user.id,
      edited_at: toDbUtc(new Date()),
    }, req.params.id]);

    const [[row]] = await pool.query(`${LOG_SELECT} WHERE l.id = ?`, [req.params.id]);
    res.json(serializeLog(row));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM attendance_logs WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
