const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
// Manage Accounting Period ("Close Accounting"): per fiscal-year month, five close/lock flags --
// Close A/R, Close A/P, Close Other GL, Close Non-GL, Close All. Toggling them locks that period.
const ROUTE = '/manage-accounting-period';
const FLAGS = ['close_ar', 'close_ap', 'close_other_gl', 'close_non_gl', 'close_all'];

// The closed months, for every signed-in user (2026-10-12): each transaction screen reads this to
// hide Edit / Void / Cancel on a document dated in a month closed for its category -- the server's
// assertPeriodOpen refuses the change anyway; this only stops offering a button that cannot work.
router.get('/locks', requireAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT fiscal_year, period_month, close_all, close_ar, close_ap, close_other_gl, close_non_gl
         FROM accounting_periods
        WHERE close_all OR close_ar OR close_ap OR close_other_gl OR close_non_gl`);
    res.json(rows.map((r) => ({
      month: `${r.fiscal_year}-${String(r.period_month).padStart(2, '0')}`,
      all: !!r.close_all, ar: !!r.close_ar, ap: !!r.close_ap, other_gl: !!r.close_other_gl, non_gl: !!r.close_non_gl,
    })));
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM accounting_periods ORDER BY fiscal_year DESC, period_month ASC');
    res.json(rows);
  } catch (err) { next(err); }
});

// Add a fiscal year: create its 12 month rows (idempotent).
router.post('/add-fy', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const fy = Number(req.body.fiscal_year);
    if (!Number.isInteger(fy) || fy < 1900 || fy > 3000) return res.status(400).json({ error: 'Enter a valid fiscal year.' });
    for (let m = 1; m <= 12; m += 1) {
      await pool.query('INSERT IGNORE INTO accounting_periods (fiscal_year, period_month) VALUES (?, ?)', [fy, m]);
    }
    res.status(201).json({ ok: true, fiscal_year: fy });
  } catch (err) { next(err); }
});

// Toggle one month's close flags. Body carries any subset of the five flags (0/1).
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const sets = [];
    const params = [];
    for (const f of FLAGS) {
      if (req.body[f] !== undefined) { sets.push(`${f} = ?`); params.push(req.body[f] ? 1 : 0); }
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
    params.push(req.user.id, req.params.id);
    const [r] = await pool.query(`UPDATE accounting_periods SET ${sets.join(', ')}, updated_at = NOW(), updated_by_user_id = ? WHERE id = ?`, params);
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    const [[row]] = await pool.query('SELECT * FROM accounting_periods WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) { next(err); }
});

module.exports = router;
