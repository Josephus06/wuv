const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, requireAnyPermission } = require('../middleware/auth');
const { isTime, isOvernight, todayLocal } = require('../lib/attendance');

const router = express.Router();
const ROUTE = '/shifts';

function withFlags(row) {
  return { ...row, is_active: !!row.is_active, is_overnight: isOvernight(row) };
}

// The pickers on Shift Assignments and Attendance read this list too, so viewing it is
// open to either of those pages' viewers as well as Shifts' own.
const canViewShifts = requireAnyPermission(['/shifts', '/shift-assignments', '/attendance']);

router.get('/', requireAuth, canViewShifts, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT s.*,
              (SELECT COUNT(DISTINCT a.employee_id) FROM employee_shift_assignments a
               WHERE a.shift_id = s.id AND a.effective_from <= ?
                 AND (a.effective_to IS NULL OR a.effective_to >= ?)) AS assigned_count
       FROM shifts s
       ORDER BY s.is_active DESC, s.start_time, s.name`,
      [todayLocal(), todayLocal()]
    );
    res.json(rows.map(withFlags));
  } catch (err) {
    next(err);
  }
});

function readBody(body) {
  const name = String(body.name || '').trim();
  const startTime = body.start_time;
  const endTime = body.end_time;
  const grace = Number(body.grace_minutes ?? 0);
  const brk = Number(body.break_minutes ?? 0);

  if (!name) return { error: 'Shift name is required' };
  if (!isTime(startTime) || !isTime(endTime)) return { error: 'Start and end time must be HH:MM' };
  if (startTime.slice(0, 5) === endTime.slice(0, 5)) return { error: 'Start and end time cannot be the same' };
  if (!Number.isInteger(grace) || grace < 0 || grace > 240) return { error: 'Grace minutes must be a whole number from 0 to 240' };
  if (!Number.isInteger(brk) || brk < 0 || brk > 480) return { error: 'Break minutes must be a whole number from 0 to 480' };

  return {
    values: {
      name,
      start_time: startTime,
      end_time: endTime,
      grace_minutes: grace,
      break_minutes: brk,
      description: body.description ? String(body.description).trim() : null,
      is_active: body.is_active ?? true,
    },
  };
}

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const { values, error } = readBody(req.body);
    if (error) return res.status(400).json({ error });
    const [result] = await pool.query('INSERT INTO shifts SET ?', [{ ...values, created_by_user_id: req.user.id }]);
    const [[row]] = await pool.query('SELECT * FROM shifts WHERE id = ?', [result.insertId]);
    res.status(201).json(withFlags(row));
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A shift with that name already exists.' });
    next(err);
  }
});

// Changing a shift's hours affects schedules from now on only: attendance already recorded
// keeps the start/end it was measured against (see create-attendance.js).
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { values, error } = readBody(req.body);
    if (error) return res.status(400).json({ error });
    const [result] = await pool.query('UPDATE shifts SET ?, updated_at = NOW() WHERE id = ?', [values, req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Not found' });
    const [[row]] = await pool.query('SELECT * FROM shifts WHERE id = ?', [req.params.id]);
    res.json(withFlags(row));
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A shift with that name already exists.' });
    next(err);
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    const [[used]] = await pool.query(
      'SELECT COUNT(*) AS n FROM employee_shift_assignments WHERE shift_id = ?', [req.params.id]
    );
    if (used.n > 0) {
      return res.status(409).json({ error: `This shift is used by ${used.n} assignment(s). Mark it inactive instead.` });
    }
    await pool.query('DELETE FROM shifts WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
