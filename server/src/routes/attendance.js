const express = require('express');
const multer = require('multer');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const {
  BUSINESS_TZ, MAX_OPEN_HOURS, HttpError,
  toDbUtc, fromDbUtc, toLocalDisplay, addDays, todayLocal, isIsoDate, parseLocalDateTime, localToUtc,
  isOvernight, scheduleFor, scheduleSources, dayShift, scheduledShift, scheduleSnapshot, metricsFor,
  remeasureDay, employeeForUser,
} = require('../lib/attendance');
const {
  LOG_SELECT, serializeLog, clockStatus, stampIn, stampOut, stampLunch,
} = require('../lib/timeClock');
const { readFirstSheet } = require('../lib/xlsx');
const { parseAttendanceSheet, matchEmployee, matchShift } = require('../lib/attendanceImport');

const router = express.Router();
const ROUTE = '/attendance';
const MAX_REPORT_DAYS = 62;

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

    const status = await clockStatus(employee.id, now);
    const [recent] = await pool.query(
      `${LOG_SELECT} WHERE l.employee_id = ? AND l.work_date >= ? ORDER BY l.work_date DESC`,
      [employee.id, addDays(todayLocal(now), -13)]
    );

    res.json({
      employee,
      timezone: BUSINESS_TZ,
      now_local: toLocalDisplay(toDbUtc(now)),
      ...status,
      recent: recent.map(serializeLog),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/me/time-in', requireAuth, async (req, res, next) => {
  try {
    const employee = await requireEmployee(req);
    res.status(201).json(await stampIn(employee.id, { source: 'self', userId: req.user.id }));
  } catch (err) {
    next(err);
  }
});

router.post('/me/time-out', requireAuth, async (req, res, next) => {
  try {
    const employee = await requireEmployee(req);
    res.json(await stampOut(employee.id, { remarks: req.body?.remarks }));
  } catch (err) {
    next(err);
  }
});

// Lunch Out / Lunch In, on a shift with a stamped lunch.
router.post('/me/lunch-out', requireAuth, async (req, res, next) => {
  try {
    const employee = await requireEmployee(req);
    res.json(await stampLunch(employee.id, 'lunch_out'));
  } catch (err) {
    next(err);
  }
});

router.post('/me/lunch-in', requireAuth, async (req, res, next) => {
  try {
    const employee = await requireEmployee(req);
    res.json(await stampLunch(employee.id, 'lunch_in'));
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

// ---------------------------------------------------------------------------------------
// DTR (Daily Time Record): the printable record of a period, one sheet per employee, with
// EVERY date listed -- rest days and holidays included -- the way a DTR is signed off.
// ---------------------------------------------------------------------------------------

function rangeError(from, to, max = MAX_REPORT_DAYS) {
  if (!isIsoDate(from) || !isIsoDate(to)) return 'from and to must be YYYY-MM-DD';
  if (from > to) return 'from must be on or before to';
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  return days > max ? `Pick a range of at most ${max} days` : null;
}

async function buildDtr(employeeIds, from, to) {
  if (!employeeIds.length) return [];
  const now = new Date();
  const [employees] = await pool.query(
    `SELECT e.id, e.employee_code, CONCAT(e.first_name, ' ', e.last_name) AS name, e.position_title,
            e.company_id, c.name AS company_name, l.location_name AS branch_name, d.name AS department_name
     FROM employees e
     LEFT JOIN companies c ON c.id = e.company_id
     LEFT JOIN locations l ON l.id = e.branch_id
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE e.id IN (?) ORDER BY c.name, l.location_name, e.last_name, e.first_name`,
    [employeeIds]
  );
  const [logs] = await pool.query(`${LOG_SELECT} WHERE l.employee_id IN (?) AND l.work_date BETWEEN ? AND ?`, [employeeIds, from, to]);
  const logMap = new Map(logs.map((l) => [`${l.employee_id}|${l.work_date}`, l]));
  const sources = await scheduleSources(employeeIds, from, to);
  // The holiday calendar belongs to payroll; before it exists a DTR simply shows none.
  const [holidays] = await pool.query(
    `SELECT DATE_FORMAT(holiday_date, '%Y-%m-%d') AS date, name, holiday_type, company_id
     FROM holidays WHERE holiday_date BETWEEN ? AND ?`,
    [from, to]
  ).catch((err) => { if (err.code === 'ER_NO_SUCH_TABLE') return [[]]; throw err; });

  const dates = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);

  return employees.map((emp) => {
    const totals = { present: 0, absent: 0, rest: 0, late_minutes: 0, undertime_minutes: 0, overtime_minutes: 0, worked_minutes: 0 };
    const days = dates.map((date) => {
      const log = logMap.get(`${emp.id}|${date}`);
      const planned = dayShift(sources, emp.id, date);
      const holiday = holidays.find((h) => h.date === date && (!h.company_id || h.company_id === emp.company_id)) || null;
      const s = serializeLog(log);
      const schedule = log
        ? (s.scheduled_start_local ? { name: log.shift_name, start: s.scheduled_start_local, end: s.scheduled_end_local } : null)
        : planned ? (() => {
          const t = scheduleFor(date, planned);
          return { name: planned.shift_name, start: toLocalDisplay(toDbUtc(t.start)), end: toLocalDisplay(toDbUtc(t.end)) };
        })() : null;

      const remarks = [];
      if (holiday) remarks.push(`${holiday.name} (${holiday.holiday_type === 'regular' ? 'regular holiday' : 'special day'})`);
      if (log) {
        totals.present += 1;
        totals.late_minutes += log.late_minutes;
        totals.undertime_minutes += log.undertime_minutes;
        totals.overtime_minutes += log.approved_ot_minutes ?? log.overtime_minutes;
        totals.worked_minutes += log.worked_minutes;
        if (!schedule) remarks.push('Worked on rest day');
        if (!log.time_out) remarks.push(now - fromDbUtc(log.time_in) > MAX_OPEN_HOURS * 3600000 ? 'No time out' : 'On duty');
        if (log.source === 'manual') remarks.push('Entered by HR');
        else if (log.source === 'import') remarks.push('Imported');
        else if (log.edited_at) remarks.push('Corrected by HR');
        if (log.remarks) remarks.push(log.remarks);
      } else if (!planned) {
        totals.rest += 1;
        remarks.push('Rest day');
      } else if (!holiday && scheduleFor(date, planned).end < now) {
        totals.absent += 1;
        remarks.push('Absent');
      }

      return {
        date,
        schedule,
        time_in_local: s ? s.time_in_local : null,
        time_out_local: s ? s.time_out_local : null,
        late_minutes: log ? log.late_minutes : 0,
        undertime_minutes: log ? log.undertime_minutes : 0,
        overtime_minutes: log ? (log.approved_ot_minutes ?? log.overtime_minutes) : 0,
        worked_minutes: log ? log.worked_minutes : 0,
        remarks,
      };
    });
    return { employee: emp, days, totals };
  });
}

// HR: ?from=&to= and either ?employee_id= (one sheet) or ?company_id= (one sheet per active
// employee of the company, optionally narrowed by ?branch_id=).
router.get('/dtr', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const invalid = rangeError(from, to);
    if (invalid) return res.status(400).json({ error: invalid });
    let ids;
    if (req.query.employee_id) {
      ids = [Number(req.query.employee_id)];
    } else if (req.query.company_id) {
      const where = ['e.company_id = ?', 'e.is_active = TRUE'];
      const params = [req.query.company_id];
      if (req.query.branch_id) { where.push('e.branch_id = ?'); params.push(req.query.branch_id); }
      const [rows] = await pool.query(`SELECT e.id FROM employees e WHERE ${where.join(' AND ')}`, params);
      ids = rows.map((r) => r.id);
    } else {
      return res.status(400).json({ error: 'Choose an employee or a company' });
    }
    res.json({ from, to, timezone: BUSINESS_TZ, sheets: await buildDtr(ids, from, to) });
  } catch (err) {
    next(err);
  }
});

// An employee's own DTR, from My Attendance.
router.get('/me/dtr', requireAuth, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const invalid = rangeError(from, to);
    if (invalid) return res.status(400).json({ error: invalid });
    const employee = await employeeForUser(req.user.id);
    if (!employee) return res.status(400).json({ error: 'Your user account is not linked to an employee record.' });
    res.json({ from, to, timezone: BUSINESS_TZ, sheets: await buildDtr([employee.id], from, to) });
  } catch (err) {
    next(err);
  }
});

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

    // Who was meant to work when: plotted days first, then Shift Assignments.
    const sources = await scheduleSources(employees.map((e) => e.id), from, to);

    const rows = [];
    for (let date = to; date >= from; date = addDays(date, -1)) {
      for (const emp of employees) {
        const log = logMap.get(`${emp.id}|${date}`);
        const assignment = log ? null : dayShift(sources, emp.id, date);
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
          lunch_out_local: s ? s.lunch_out_local : null,
          lunch_in_local: s ? s.lunch_in_local : null,
          has_lunch: log ? !!log.scheduled_lunch_start : !!assignment.lunch_start,
          halfday_absent: !!(log && log.halfday_absent),
          late_minutes: log ? log.late_minutes : 0,
          undertime_minutes: log ? log.undertime_minutes : 0,
          overtime_minutes: log ? (log.approved_ot_minutes ?? log.overtime_minutes) : 0,
          approved_ot_minutes: log ? log.approved_ot_minutes ?? null : null,
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

// Lunch Out / Lunch In from the form (optional, same format), in order between in and out.
function readLunch(body, timeIn, timeOut) {
  const lunchOut = body.lunch_out ? parseLocalDateTime(body.lunch_out) : null;
  const lunchIn = body.lunch_in ? parseLocalDateTime(body.lunch_in) : null;
  if ((body.lunch_out && !lunchOut) || (body.lunch_in && !lunchIn)) throw new HttpError(400, 'Lunch times must be YYYY-MM-DD HH:MM');
  if (lunchIn && !lunchOut) throw new HttpError(400, 'Enter the Lunch Out too, or leave both lunch times blank');
  if (lunchOut && lunchOut <= timeIn) throw new HttpError(400, 'Lunch out must be after time in');
  if (lunchIn && lunchIn <= lunchOut) throw new HttpError(400, 'Lunch in must be after lunch out');
  if (timeOut && ((lunchIn && timeOut <= lunchIn) || timeOut <= lunchOut)) throw new HttpError(400, 'Time out must be after the lunch times');
  return { lunchOut, lunchIn };
}

function readRemarks(body) {
  return body.remarks ? String(body.remarks).trim().slice(0, 255) : null;
}

// Approved overtime in hours from the form: blank = none decided (overtime is measured from
// the shift end); 0 = none approved. Absent from the body = leave as it is.
function readApprovedOt(body) {
  if (!('approved_ot_hours' in body)) return undefined;
  if (body.approved_ot_hours === '' || body.approved_ot_hours === null) return null;
  const h = Number(body.approved_ot_hours);
  if (!Number.isFinite(h) || h < 0 || h > 16) throw new HttpError(400, 'Approved overtime must be 0 to 16 hours');
  return Math.round(h * 60);
}

// A record HR enters for someone who could not stamp (forgot, no device, field work).
router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const employeeId = Number(req.body.employee_id);
    const workDate = req.body.work_date;
    if (!employeeId) return res.status(400).json({ error: 'Choose an employee' });
    if (!isIsoDate(workDate)) return res.status(400).json({ error: 'Work date must be a valid date' });
    const { timeIn, timeOut } = readTimes(req.body, workDate);
    const lunch = readLunch(req.body, timeIn, timeOut);
    const approvedOt = readApprovedOt(req.body);

    const [[emp]] = await pool.query('SELECT id FROM employees WHERE id = ?', [employeeId]);
    if (!emp) return res.status(400).json({ error: 'Employee not found' });

    const snapshot = scheduleSnapshot(await scheduledShift(employeeId, workDate));
    const [result] = await pool.query('INSERT INTO attendance_logs SET ?', [{
      employee_id: employeeId,
      work_date: workDate,
      ...snapshot,
      time_in: toDbUtc(timeIn),
      time_out: timeOut ? toDbUtc(timeOut) : null,
      lunch_out: lunch.lunchOut ? toDbUtc(lunch.lunchOut) : null,
      lunch_in: lunch.lunchIn ? toDbUtc(lunch.lunchIn) : null,
      ...metricsFor(snapshot, timeIn, timeOut, lunch),
      source: 'manual',
      remarks: readRemarks(req.body),
      recorded_by_user_id: req.user.id,
      ...(approvedOt !== undefined ? { approved_ot_minutes: approvedOt } : {}),
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
    const lunch = readLunch(req.body, timeIn, timeOut);
    const approvedOt = readApprovedOt(req.body);

    const snapshot = log.scheduled_start
      ? log
      : scheduleSnapshot(await scheduledShift(log.employee_id, log.work_date));
    const keepOriginal = log.source === 'self' && !log.original_time_in;

    await pool.query('UPDATE attendance_logs SET ? WHERE id = ?', [{
      shift_id: snapshot.shift_id,
      shift_name: snapshot.shift_name,
      scheduled_start: snapshot.scheduled_start,
      scheduled_end: snapshot.scheduled_end,
      grace_minutes: snapshot.grace_minutes,
      break_minutes: snapshot.break_minutes,
      paid_break_minutes: snapshot.paid_break_minutes || 0,
      scheduled_lunch_start: snapshot.scheduled_lunch_start || null,
      scheduled_lunch_end: snapshot.scheduled_lunch_end || null,
      late_block_minutes: snapshot.late_block_minutes ?? null,
      halfday_late_minutes: snapshot.halfday_late_minutes ?? null,
      undertime_grace_minutes: snapshot.undertime_grace_minutes || 0,
      time_in: toDbUtc(timeIn),
      time_out: timeOut ? toDbUtc(timeOut) : null,
      lunch_out: lunch.lunchOut ? toDbUtc(lunch.lunchOut) : null,
      lunch_in: lunch.lunchIn ? toDbUtc(lunch.lunchIn) : null,
      ...metricsFor(snapshot, timeIn, timeOut, lunch),
      remarks: readRemarks(req.body),
      ...(approvedOt !== undefined ? { approved_ot_minutes: approvedOt } : {}),
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

// ---------------------------------------------------------------------------------------
// Import: a branch's manual attendance sheet (.xlsx). Preview first -- nothing is saved --
// so HR matches names and shifts and fixes flagged days; then import the reviewed rows.
// ---------------------------------------------------------------------------------------

const sheetUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

router.post('/import/preview', requireAuth, requirePermission(ROUTE, 'can_add'), sheetUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Attach the attendance sheet (.xlsx).' });
    const rows = parseAttendanceSheet(readFirstSheet(req.file.buffer), { fileName: req.file.originalname });
    if (!rows.length) return res.status(400).json({ error: 'No attendance rows found under the headings.' });

    const [employees] = await pool.query(
      `SELECT e.id, e.employee_code, e.first_name, e.last_name, CONCAT(e.first_name, ' ', e.last_name) AS name,
              c.name AS company_name, l.location_name AS branch_name
       FROM employees e LEFT JOIN companies c ON c.id = e.company_id LEFT JOIN locations l ON l.id = e.branch_id
       WHERE e.is_active = TRUE ORDER BY e.first_name, e.last_name`
    );
    const [shifts] = await pool.query('SELECT id, name, start_time, end_time FROM shifts WHERE is_active = TRUE ORDER BY name');

    const sheetNames = [...new Set(rows.map((r) => r.sheet_name))];
    const nameMatches = sheetNames.map((n) => ({ sheet_name: n, ...matchEmployee(n, employees) }));
    const sheetShifts = [...new Set(rows.filter((r) => r.sheet_shift && !r.rest).map((r) => r.sheet_shift))];
    const shiftMatches = sheetShifts.map((s) => ({ sheet_shift: s, shift_id: matchShift(s, shifts) }));

    // Days that already have a time record, for the matched employees.
    const dates = rows.map((r) => r.date).sort();
    const matchedIds = nameMatches.map((m) => m.employee_id).filter(Boolean);
    const [existing] = matchedIds.length
      ? await pool.query(
        `SELECT employee_id, DATE_FORMAT(work_date, '%Y-%m-%d') AS work_date, source FROM attendance_logs
         WHERE employee_id IN (?) AND work_date BETWEEN ? AND ?`,
        [matchedIds, dates[0], dates[dates.length - 1]]
      )
      : [[]];

    res.json({
      file_name: req.file.originalname,
      from: dates[0],
      to: dates[dates.length - 1],
      rows,
      employees: nameMatches,
      shifts: shiftMatches,
      existing: existing.map((e) => `${e.employee_id}|${e.work_date}`),
      employee_options: employees.map(({ id, employee_code, name, company_name, branch_name }) => ({ id, employee_code, name, company_name, branch_name })),
      shift_options: shifts,
    });
  } catch (err) {
    next(err);
  }
});

// Saves the reviewed rows in one transaction, all or nothing. For each included day of a
// mapped employee: the sheet's shift (or rest day) is plotted on the schedule, then the time
// record is created against it -- late / undertime measured from that shift, overtime as
// approved on the sheet. An existing record for the day is kept unless replace_existing.
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

router.post('/import', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const { rows = [], employees = {}, shifts = {}, replace_existing: replace = false } = req.body || {};
  const fileName = String(req.body?.file_name || 'attendance sheet').slice(0, 120);
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'Nothing to import' });
  if (rows.length > 3000) return res.status(400).json({ error: 'Too many rows -- import one cutoff at a time' });

  const conn = await pool.getConnection();
  const summary = { records: 0, replaced: 0, kept_existing: 0, plotted: 0, skipped: 0 };
  try {
    await conn.beginTransaction();
    const empIds = [...new Set(Object.values(employees).map(Number).filter(Boolean))];
    const shiftIds = [...new Set(Object.values(shifts).map(Number).filter(Boolean))];
    if (empIds.length) {
      const [found] = await conn.query('SELECT id FROM employees WHERE id IN (?)', [empIds]);
      if (found.length !== empIds.length) throw new HttpError(400, 'An employee chosen no longer exists. Preview the file again.');
    }
    if (shiftIds.length) {
      const [found] = await conn.query('SELECT id FROM shifts WHERE id IN (?)', [shiftIds]);
      if (found.length !== shiftIds.length) throw new HttpError(400, 'A shift chosen no longer exists. Preview the file again.');
    }

    const now = new Date();
    for (const r of rows) {
      const employeeId = Number(employees[r.sheet_name]);
      if (r.skip || !employeeId) { summary.skipped += 1; continue; }
      if (!isIsoDate(r.date)) throw new HttpError(400, `${r.sheet_name}: bad date "${r.date}"`);
      for (const t of [r.time_in, r.time_out]) {
        if (t && !HHMM.test(t)) throw new HttpError(400, `${r.sheet_name} ${r.date}: time "${t}" must be HH:MM`);
      }
      if (!r.time_in && r.time_out) throw new HttpError(400, `${r.sheet_name} ${r.date}: time out without a time in -- skip or fix the day`);

      // 1. The day's shift, as the sheet says.
      const plan = r.rest ? 'rest' : (r.sheet_shift ? shifts[r.sheet_shift] : undefined);
      if (plan === 'rest' || Number(plan) > 0) {
        await conn.query(
          `INSERT INTO employee_schedules (employee_id, work_date, shift_id, updated_by_user_id) VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE shift_id = VALUES(shift_id), updated_by_user_id = VALUES(updated_by_user_id)`,
          [employeeId, r.date, plan === 'rest' ? null : Number(plan), req.user.id]
        );
        summary.plotted += 1;
      }

      // 2. The time record.
      const [[existing]] = await conn.query('SELECT id FROM attendance_logs WHERE employee_id = ? AND work_date = ?', [employeeId, r.date]);
      if (!r.time_in) {
        // No times: the day is only plotted (a rest day, or an absence). An existing record
        // follows the new plan.
        if (existing) await remeasureDay(employeeId, r.date, conn);
        continue;
      }
      if (existing && !replace) {
        await remeasureDay(employeeId, r.date, conn);
        summary.kept_existing += 1;
        continue;
      }
      const timeIn = localToUtc(r.date, r.time_in);
      let timeOut = null;
      if (r.time_out) {
        timeOut = localToUtc(r.date, r.time_out);
        if (timeOut <= timeIn) timeOut = localToUtc(addDays(r.date, 1), r.time_out); // past midnight
      }
      if (timeIn > now || (timeOut && timeOut > now)) throw new HttpError(400, `${r.sheet_name} ${r.date}: times cannot be in the future`);
      const otMin = r.approved_ot_minutes === null || r.approved_ot_minutes === undefined || r.approved_ot_minutes === ''
        ? 0 : Math.round(Number(r.approved_ot_minutes));
      if (!Number.isFinite(otMin) || otMin < 0 || otMin > 16 * 60) throw new HttpError(400, `${r.sheet_name} ${r.date}: overtime must be 0 to 16 hours`);

      if (existing) { await conn.query('DELETE FROM attendance_logs WHERE id = ?', [existing.id]); summary.replaced += 1; }
      const snapshot = scheduleSnapshot(await scheduledShift(employeeId, r.date, conn));
      await conn.query('INSERT INTO attendance_logs SET ?', [{
        employee_id: employeeId,
        work_date: r.date,
        ...snapshot,
        time_in: toDbUtc(timeIn),
        time_out: timeOut ? toDbUtc(timeOut) : null,
        ...metricsFor(snapshot, timeIn, timeOut),
        // The sheet's Overtime column is the approved overtime; blank means none approved.
        approved_ot_minutes: otMin,
        source: 'import',
        remarks: `Imported from ${fileName}`.slice(0, 255),
        recorded_by_user_id: req.user.id,
      }]);
      summary.records += 1;
    }
    await conn.commit();
    res.status(201).json(summary);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Re-measure: the records of a date range measured again against the schedules as they are
// NOW -- after a shift's hours or rules were corrected (8:15-4:45 -> 8:00-5:00 with grace).
// The stamped times are kept; only the schedule snapshot and late / undertime / overtime /
// worked change. Days already in a payroll out of draft (for checking, approval, approved)
// are left alone, so attendance keeps matching what was checked and paid.
router.post('/remeasure', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { from, to } = req.body;
    if (!isIsoDate(from) || !isIsoDate(to) || from > to) return res.status(400).json({ error: 'Choose a valid date range' });
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    if (days > MAX_REPORT_DAYS) return res.status(400).json({ error: `Pick a range of at most ${MAX_REPORT_DAYS} days` });

    const where = ['l.work_date BETWEEN ? AND ?'];
    const params = [from, to];
    for (const [key, col] of [['employee_id', 'e.id'], ['company_id', 'e.company_id'], ['branch_id', 'e.branch_id'], ['department_id', 'e.department_id']]) {
      if (req.body[key]) { where.push(`${col} = ?`); params.push(req.body[key]); }
    }
    const [logs] = await pool.query(
      `SELECT l.employee_id, DATE_FORMAT(l.work_date, '%Y-%m-%d') AS work_date,
              EXISTS (SELECT 1 FROM payroll_run_employees pe JOIN payroll_runs r ON r.id = pe.run_id
                      WHERE pe.employee_id = l.employee_id AND r.status <> 'draft'
                        AND l.work_date BETWEEN r.period_start AND r.period_end) AS locked
       FROM attendance_logs l JOIN employees e ON e.id = l.employee_id
       WHERE ${where.join(' AND ')}`,
      params
    );
    let remeasured = 0;
    let locked = 0;
    for (const log of logs) {
      if (log.locked) { locked += 1; continue; }
      if (await remeasureDay(log.employee_id, log.work_date)) remeasured += 1;
    }
    res.json({ remeasured, locked });
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
