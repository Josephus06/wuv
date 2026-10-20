// The weekly schedule a branch supervisor plots: for each employee of the branch and each day
// of the week, a shift or a rest day. A plotted day overrides the employee's Shift Assignment
// for that date (see lib/attendance dayShift); a day left on "Default" follows the assignment.
// Attendance (late, absent) and payroll read the same resolution, so what is plotted here is
// what the employee is measured and paid against.
const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, requireAnyPermission } = require('../middleware/auth');
const { isIsoDate, addDays, weekdayOf, scheduleSources, pickAssignment } = require('../lib/attendance');

const router = express.Router();
const ROUTE = '/schedule';

// Monday of the week a date falls in.
function mondayOf(date) {
  const wd = weekdayOf(date); // 0 = Sunday
  return addDays(date, wd === 0 ? -6 : 1 - wd);
}

router.get('/branches', requireAuth, requireAnyPermission([ROUTE, '/shifts', '/shift-assignments']), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT l.id, l.location_name AS name, l.location_type, c.name AS company_name
       FROM locations l LEFT JOIN companies c ON c.id = l.company_id
       WHERE l.is_active = TRUE ORDER BY l.location_name`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const branchId = Number(req.query.branch_id);
    if (!branchId) return res.status(400).json({ error: 'Choose a branch' });
    if (req.query.week_start && !isIsoDate(req.query.week_start)) return res.status(400).json({ error: 'week_start must be YYYY-MM-DD' });
    const weekStart = mondayOf(req.query.week_start || new Date().toISOString().slice(0, 10));
    const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    const weekEnd = dates[6];

    const [employees] = await pool.query(
      `SELECT id, employee_code, CONCAT(first_name, ' ', last_name) AS name, position_title
       FROM employees WHERE branch_id = ? AND is_active = TRUE ORDER BY first_name, last_name`,
      [branchId]
    );
    const [shifts] = await pool.query(
      `SELECT id, name, start_time, end_time, branch_id FROM shifts
       WHERE is_active = TRUE AND (branch_id = ? OR branch_id IS NULL)
       ORDER BY branch_id IS NULL, start_time, name`,
      [branchId]
    );
    const sources = await scheduleSources(employees.map((e) => e.id), weekStart, weekEnd);

    res.json({
      week_start: weekStart,
      dates,
      shifts,
      employees: employees.map((emp) => ({
        ...emp,
        days: Object.fromEntries(dates.map((d) => {
          const key = `${emp.id}|${d}`;
          const fallback = pickAssignment(sources.assignments.get(emp.id) || [], d);
          const def = fallback ? { shift_id: fallback.shift_id, shift_name: fallback.shift_name, start_time: fallback.start_time, end_time: fallback.end_time } : null;
          if (sources.plotted.has(key)) {
            const p = sources.plotted.get(key);
            return [d, { source: 'plotted', shift_id: p ? p.shift_id : null, default: def }];
          }
          return [d, { source: 'default', shift_id: def ? def.shift_id : null, default: def }];
        })),
      })),
    });
  } catch (err) { next(err); }
});

// Saves changed cells: value 'rest' plots a rest day, a shift id plots that shift, 'default'
// removes the plotted day so the Shift Assignment applies again.
router.put('/', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
  if (!entries.length) return res.status(400).json({ error: 'Nothing to save' });
  if (entries.length > 2000) return res.status(400).json({ error: 'Too many changes at once' });
  for (const e of entries) {
    if (!Number(e.employee_id) || !isIsoDate(e.work_date)) return res.status(400).json({ error: 'Each change needs an employee and a date' });
    if (!(e.value === 'rest' || e.value === 'default' || Number(e.value) > 0)) return res.status(400).json({ error: 'Each change must be a shift, Rest or Default' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const shiftIds = [...new Set(entries.filter((e) => Number(e.value) > 0).map((e) => Number(e.value)))];
    if (shiftIds.length) {
      const [found] = await conn.query('SELECT id FROM shifts WHERE id IN (?)', [shiftIds]);
      if (found.length !== shiftIds.length) { await conn.rollback(); return res.status(400).json({ error: 'A chosen shift no longer exists. Reload the page.' }); }
    }
    for (const e of entries) {
      if (e.value === 'default') {
        await conn.query('DELETE FROM employee_schedules WHERE employee_id = ? AND work_date = ?', [e.employee_id, e.work_date]);
      } else {
        await conn.query(
          `INSERT INTO employee_schedules (employee_id, work_date, shift_id, updated_by_user_id) VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE shift_id = VALUES(shift_id), updated_by_user_id = VALUES(updated_by_user_id)`,
          [e.employee_id, e.work_date, e.value === 'rest' ? null : Number(e.value), req.user.id]
        );
      }
    }
    await conn.commit();
    res.json({ saved: entries.length });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Copies a branch's plotted week onto another week (replacing what is plotted there), so a
// rotation that repeats is plotted once.
router.post('/copy', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const branchId = Number(req.body.branch_id);
  if (!branchId || !isIsoDate(req.body.from_week) || !isIsoDate(req.body.to_week)) {
    return res.status(400).json({ error: 'Choose the branch and both weeks' });
  }
  const from = mondayOf(req.body.from_week);
  const to = mondayOf(req.body.to_week);
  if (from === to) return res.status(400).json({ error: 'Pick a different week to copy from' });
  const offset = Math.round((Date.parse(to) - Date.parse(from)) / 86400000);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [emps] = await conn.query('SELECT id FROM employees WHERE branch_id = ? AND is_active = TRUE', [branchId]);
    const ids = emps.map((e) => e.id);
    if (!ids.length) { await conn.rollback(); return res.status(400).json({ error: 'No active employees in this branch' }); }
    const [rows] = await conn.query(
      `SELECT employee_id, DATE_FORMAT(work_date, '%Y-%m-%d') AS work_date, shift_id FROM employee_schedules
       WHERE employee_id IN (?) AND work_date BETWEEN ? AND ?`,
      [ids, from, addDays(from, 6)]
    );
    if (!rows.length) { await conn.rollback(); return res.status(400).json({ error: 'Nothing is plotted in that week to copy' }); }
    await conn.query('DELETE FROM employee_schedules WHERE employee_id IN (?) AND work_date BETWEEN ? AND ?', [ids, to, addDays(to, 6)]);
    await conn.query(
      'INSERT INTO employee_schedules (employee_id, work_date, shift_id, updated_by_user_id) VALUES ?',
      [rows.map((r) => [r.employee_id, addDays(r.work_date, offset), r.shift_id, req.user.id])]
    );
    await conn.commit();
    res.json({ copied: rows.length, week_start: to });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
