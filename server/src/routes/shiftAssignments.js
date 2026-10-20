const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, requireAnyPermission } = require('../middleware/auth');
const { isIsoDate, parseDays, addDays, todayLocal } = require('../lib/attendance');

const router = express.Router();
const ROUTE = '/shift-assignments';

const SELECT = `
  SELECT a.id, a.employee_id, a.shift_id,
         DATE_FORMAT(a.effective_from, '%Y-%m-%d') AS effective_from,
         DATE_FORMAT(a.effective_to, '%Y-%m-%d') AS effective_to,
         a.days_of_week, a.notes, a.created_at,
         e.employee_code, CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
         d.name AS department_name,
         s.name AS shift_name, s.start_time, s.end_time
  FROM employee_shift_assignments a
  JOIN employees e ON e.id = a.employee_id
  LEFT JOIN departments d ON d.id = e.department_id
  JOIN shifts s ON s.id = a.shift_id`;

// The employee picker for this page and for manual attendance entries. Separate from
// /api/employees so assigning shifts does not also require the Employees master list.
router.get('/employees', requireAuth, requireAnyPermission([ROUTE, '/attendance']), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT e.id, e.employee_code, CONCAT(e.first_name, ' ', e.last_name) AS name,
              e.department_id, d.name AS department_name,
              e.company_id, c.name AS company_name, e.branch_id, l.location_name AS branch_name
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN companies c ON c.id = e.company_id
       LEFT JOIN locations l ON l.id = e.branch_id
       WHERE e.is_active = TRUE
       ORDER BY e.first_name, e.last_name`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ?status=current (default) | upcoming | ended | all, measured against today on the
// business clock. ?employee_id / ?shift_id narrow further.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const today = todayLocal();
    const where = [];
    const params = [];
    const status = req.query.status || 'current';
    if (status === 'current') {
      where.push('a.effective_from <= ? AND (a.effective_to IS NULL OR a.effective_to >= ?)');
      params.push(today, today);
    } else if (status === 'upcoming') {
      where.push('a.effective_from > ?'); params.push(today);
    } else if (status === 'ended') {
      where.push('a.effective_to < ?'); params.push(today);
    }
    if (req.query.employee_id) { where.push('a.employee_id = ?'); params.push(req.query.employee_id); }
    if (req.query.shift_id) { where.push('a.shift_id = ?'); params.push(req.query.shift_id); }

    const [rows] = await pool.query(
      `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY e.first_name, e.last_name, a.effective_from DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

function readBody(body) {
  const shiftId = Number(body.shift_id);
  const from = body.effective_from;
  const to = body.effective_to || null;
  const days = parseDays(body.days_of_week);

  if (!shiftId) return { error: 'Choose a shift' };
  if (!isIsoDate(from)) return { error: 'Effective from must be a valid date' };
  if (to && !isIsoDate(to)) return { error: 'Effective to must be a valid date' };
  if (to && to < from) return { error: 'Effective to cannot be before effective from' };
  if (!days.length) return { error: 'Pick at least one working day' };

  return {
    values: {
      shift_id: shiftId,
      effective_from: from,
      effective_to: to,
      days_of_week: days.join(','),
      notes: body.notes ? String(body.notes).trim().slice(0, 255) : null,
    },
  };
}

// Assignments for one employee that share at least one day with [from, to] (to = null is
// open-ended), other than `exceptId`.
async function overlapping(conn, employeeId, from, to, exceptId = 0) {
  const [rows] = await conn.query(
    `SELECT id, DATE_FORMAT(effective_from, '%Y-%m-%d') AS effective_from,
            DATE_FORMAT(effective_to, '%Y-%m-%d') AS effective_to
     FROM employee_shift_assignments
     WHERE employee_id = ? AND id <> ?
       AND (effective_to IS NULL OR effective_to >= ?)
       AND (? IS NULL OR effective_from <= ?)
     FOR UPDATE`,
    [employeeId, exceptId, from, to, to]
  );
  return rows;
}

function describe(a) {
  return `${a.effective_from} to ${a.effective_to || 'open-ended'}`;
}

// Creates one assignment per employee in `employee_ids` (or the single `employee_id`), so a
// whole team can be put on a shift in one save.
//
// An assignment that began EARLIER and is still running on the new start date is handled
// rather than refused:
//   - new one open-ended  -> a move to a new shift: the old one is ended the day before.
//   - new one has an end  -> a temporary change: the old one is left alone. The newer
//     assignment wins for its window (lib/attendance pickAssignment) and the regular
//     schedule resumes by itself afterwards.
// Anything else in the way (an assignment that starts on or after the new one) is a
// genuine clash and the whole save is refused, naming who and what -- silently trimming a
// future schedule someone deliberately set up would be worse.
router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const { values, error } = readBody(req.body);
  if (error) return res.status(400).json({ error });

  const employeeIds = [...new Set(
    (Array.isArray(req.body.employee_ids) ? req.body.employee_ids : [req.body.employee_id])
      .map(Number).filter(Boolean)
  )];
  if (!employeeIds.length) return res.status(400).json({ error: 'Choose at least one employee' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[shift]] = await conn.query('SELECT id, is_active FROM shifts WHERE id = ?', [values.shift_id]);
    if (!shift) { await conn.rollback(); return res.status(400).json({ error: 'Shift not found' }); }
    if (!shift.is_active) { await conn.rollback(); return res.status(400).json({ error: 'That shift is inactive' }); }

    const [employees] = await conn.query(
      "SELECT id, CONCAT(first_name, ' ', last_name) AS name FROM employees WHERE id IN (?)", [employeeIds]
    );
    const names = new Map(employees.map((e) => [e.id, e.name]));
    const missing = employeeIds.filter((id) => !names.has(id));
    if (missing.length) { await conn.rollback(); return res.status(400).json({ error: `Employee not found: ${missing.join(', ')}` }); }

    const clashes = [];
    const ended = [];
    const created = [];
    for (const employeeId of employeeIds) {
      const rows = await overlapping(conn, employeeId, values.effective_from, values.effective_to);
      const blocking = rows.filter((r) => r.effective_from >= values.effective_from);
      if (blocking.length) {
        clashes.push(`${names.get(employeeId)} already has ${blocking.map(describe).join(', ')}`);
        continue;
      }
      for (const r of values.effective_to ? [] : rows) {
        const newEnd = addDays(values.effective_from, -1);
        await conn.query(
          'UPDATE employee_shift_assignments SET effective_to = ?, updated_at = NOW() WHERE id = ?', [newEnd, r.id]
        );
        ended.push(`${names.get(employeeId)}: previous assignment now ends ${newEnd}`);
      }
      const [result] = await conn.query('INSERT INTO employee_shift_assignments SET ?', [{
        ...values, employee_id: employeeId, created_by_user_id: req.user.id,
      }]);
      created.push(result.insertId);
    }

    if (clashes.length) {
      await conn.rollback();
      return res.status(409).json({ error: `Overlapping assignment. ${clashes.join('; ')}. Edit or remove it first.` });
    }

    await conn.commit();
    const [rows] = await pool.query(`${SELECT} WHERE a.id IN (?)`, [created]);
    res.status(201).json({ created: rows, ended });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// An edit never shortens a neighbouring assignment on its own. Overlaps are allowed where
// the latest-start rule decides which one applies; two overlapping assignments starting on
// the SAME day would be a coin toss, so that is refused.
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const { values, error } = readBody(req.body);
  if (error) return res.status(400).json({ error });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[current]] = await conn.query('SELECT employee_id FROM employee_shift_assignments WHERE id = ?', [req.params.id]);
    if (!current) { await conn.rollback(); return res.status(404).json({ error: 'Not found' }); }

    const clashes = (await overlapping(conn, current.employee_id, values.effective_from, values.effective_to, req.params.id))
      .filter((r) => r.effective_from === values.effective_from);
    if (clashes.length) {
      await conn.rollback();
      return res.status(409).json({ error: `This employee already has an assignment starting the same day (${clashes.map(describe).join(', ')}).` });
    }

    await conn.query('UPDATE employee_shift_assignments SET ?, updated_at = NOW() WHERE id = ?', [values, req.params.id]);
    await conn.commit();
    const [[row]] = await pool.query(`${SELECT} WHERE a.id = ?`, [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM employee_shift_assignments WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
