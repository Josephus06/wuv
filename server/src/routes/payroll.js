const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { periodFor, computeRun } = require('../lib/payroll');
const { isIsoDate } = require('../lib/attendance');

const router = express.Router();
const ROUTE = '/payroll';

const RUN_SELECT = `
  SELECT r.id, r.company_id, c.name AS company_name, r.cutoff, r.status,
         DATE_FORMAT(r.period_start, '%Y-%m-%d') AS period_start, DATE_FORMAT(r.period_end, '%Y-%m-%d') AS period_end,
         DATE_FORMAT(r.pay_date, '%Y-%m-%d') AS pay_date, r.employee_count, r.total_gross, r.total_deductions,
         r.total_net, r.total_employer, r.notes, r.warnings, r.computed_at, r.approved_at, r.created_at,
         cu.display_name AS created_by, au.display_name AS approved_by
  FROM payroll_runs r
  JOIN companies c ON c.id = r.company_id
  LEFT JOIN users cu ON cu.id = r.created_by_user_id
  LEFT JOIN users au ON au.id = r.approved_by_user_id`;

const parseJson = (v) => { try { return v ? JSON.parse(v) : []; } catch { return []; } };

function conflict(message) {
  const e = new Error(message);
  e.status = 409;
  return e;
}

async function draftRun(id) {
  const [[run]] = await pool.query('SELECT id, status FROM payroll_runs WHERE id = ?', [id]);
  if (!run) { const e = new Error('Not found'); e.status = 404; throw e; }
  if (run.status !== 'draft') throw conflict('This payroll is approved and locked. Reopen it to make changes.');
  return run;
}

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    if (req.query.company_id) { where.push('r.company_id = ?'); params.push(req.query.company_id); }
    if (req.query.status) { where.push('r.status = ?'); params.push(req.query.status); }
    if (req.query.year) { where.push('YEAR(r.period_start) = ?'); params.push(req.query.year); }
    const [rows] = await pool.query(
      `${RUN_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.period_start DESC, c.name`,
      params
    );
    res.json(rows.map((r) => ({ ...r, warnings: parseJson(r.warnings) })));
  } catch (err) {
    next(err);
  }
});

// Creates the run for one company's cutoff and computes it straight away.
router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const companyId = Number(req.body.company_id);
    const year = Number(req.body.year);
    const month = Number(req.body.month);
    const cutoff = Number(req.body.cutoff);
    if (!companyId) return res.status(400).json({ error: 'Choose the company' });
    if (!(year >= 2000 && year <= 2100) || !(month >= 1 && month <= 12)) return res.status(400).json({ error: 'Choose the month' });
    if (![1, 2].includes(cutoff)) return res.status(400).json({ error: 'Choose the cutoff: 1st–15th or 16th–end' });
    // The dates default to the 1st–15th / 16th–end, and can be moved for a company whose cutoff
    // runs on other dates (e.g. the 12th–26th). The cutoff still says which half of the month's
    // contributions and tax the run carries.
    let { start, end } = periodFor(year, month, cutoff);
    if (req.body.period_start || req.body.period_end) {
      start = req.body.period_start;
      end = req.body.period_end;
      if (!isIsoDate(start) || !isIsoDate(end)) return res.status(400).json({ error: 'Enter the cutoff\'s From and To dates' });
      if (start > end) return res.status(400).json({ error: 'The cutoff\'s From date is after its To date' });
      const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000 + 1;
      if (days > 31) return res.status(400).json({ error: 'A cutoff can be at most 31 days' });
    }
    const [[overlap]] = await pool.query(
      `SELECT DATE_FORMAT(period_start, '%Y-%m-%d') AS s, DATE_FORMAT(period_end, '%Y-%m-%d') AS e
       FROM payroll_runs WHERE company_id = ? AND period_start <= ? AND period_end >= ? LIMIT 1`,
      [companyId, end, start]
    );
    if (overlap) throw conflict(`This company already has a payroll for ${overlap.s} to ${overlap.e}, which overlaps these dates.`);
    const payDate = req.body.pay_date || end;
    if (!isIsoDate(payDate)) return res.status(400).json({ error: 'Pay date must be a valid date' });

    let id;
    try {
      const [result] = await pool.query('INSERT INTO payroll_runs SET ?', [{
        company_id: companyId, period_start: start, period_end: end, cutoff, pay_date: payDate,
        notes: req.body.notes ? String(req.body.notes).slice(0, 255) : null, created_by_user_id: req.user.id,
      }]);
      id = result.insertId;
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw conflict(`A payroll for this company's ${start} to ${end} cutoff already exists.`);
      throw err;
    }
    try {
      await computeRun(id);
    } catch (err) {
      // A run that could not be computed (e.g. no rates for the date) is not left behind as
      // an empty draft blocking the cutoff.
      await pool.query('DELETE FROM payroll_runs WHERE id = ?', [id]);
      throw err;
    }
    const [[run]] = await pool.query(`${RUN_SELECT} WHERE r.id = ?`, [id]);
    res.status(201).json(run);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[run]] = await pool.query(`${RUN_SELECT} WHERE r.id = ?`, [req.params.id]);
    if (!run) return res.status(404).json({ error: 'Not found' });
    const [employees] = await pool.query(
      `SELECT pe.*, e.employee_code, CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
              l.location_name AS branch_name, e.bank_account_no
       FROM payroll_run_employees pe
       JOIN employees e ON e.id = pe.employee_id
       LEFT JOIN locations l ON l.id = e.branch_id
       WHERE pe.run_id = ? ORDER BY e.last_name, e.first_name`,
      [run.id]
    );
    const [adjustments] = await pool.query(
      `SELECT a.id, a.employee_id, a.adj_type, a.label, a.amount, a.is_taxable, u.display_name AS created_by
       FROM payroll_adjustments a LEFT JOIN users u ON u.id = a.created_by_user_id
       WHERE a.run_id = ? ORDER BY a.id`,
      [run.id]
    );
    res.json({
      ...run,
      warnings: parseJson(run.warnings),
      employees: employees.map((e) => ({ ...e, warnings: parseJson(e.warnings) })),
      adjustments,
    });
  } catch (err) {
    next(err);
  }
});

// One employee's payslip in a run: its lines, in order.
router.get('/:id/employees/:employeeId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[pe]] = await pool.query(
      `SELECT pe.*, e.employee_code, CONCAT(e.first_name, ' ', e.last_name) AS employee_name, e.position_title,
              l.location_name AS branch_name
       FROM payroll_run_employees pe
       JOIN employees e ON e.id = pe.employee_id
       LEFT JOIN locations l ON l.id = e.branch_id
       WHERE pe.run_id = ? AND pe.employee_id = ?`,
      [req.params.id, req.params.employeeId]
    );
    if (!pe) return res.status(404).json({ error: 'Not found' });
    const [lines] = await pool.query(
      'SELECT line_type, code, label, quantity, unit, rate, amount, is_taxable FROM payroll_run_lines WHERE run_employee_id = ? ORDER BY sort_order',
      [pe.id]
    );
    res.json({ ...pe, warnings: parseJson(pe.warnings), lines });
  } catch (err) {
    next(err);
  }
});

// Printable payslips: the run's header and every payslip with its lines, or one employee's
// (?employee_id=). Read from what is stored, so a reprint says what the run said.
router.get('/:id/payslips', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[run]] = await pool.query(`${RUN_SELECT} WHERE r.id = ?`, [req.params.id]);
    if (!run) return res.status(404).json({ error: 'Not found' });
    const params = [run.id];
    let only = '';
    if (req.query.employee_id) { only = 'AND pe.employee_id = ?'; params.push(req.query.employee_id); }
    const [slips] = await pool.query(
      `SELECT pe.*, e.employee_code, CONCAT(e.first_name, ' ', e.last_name) AS employee_name, e.position_title,
              l.location_name AS branch_name, d.name AS department_name
       FROM payroll_run_employees pe
       JOIN employees e ON e.id = pe.employee_id
       LEFT JOIN locations l ON l.id = e.branch_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE pe.run_id = ? ${only} ORDER BY l.location_name, e.last_name, e.first_name`,
      params
    );
    const [lines] = slips.length ? await pool.query(
      `SELECT run_employee_id, line_type, code, label, quantity, unit, rate, amount, is_taxable
       FROM payroll_run_lines WHERE run_employee_id IN (?) ORDER BY run_employee_id, sort_order`,
      [slips.map((s) => s.id)]
    ) : [[]];
    res.json({
      run: { ...run, warnings: undefined },
      slips: slips.map((s) => ({ ...s, warnings: undefined, lines: lines.filter((l) => l.run_employee_id === s.id) })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/compute', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    await computeRun(req.params.id);
    const [[run]] = await pool.query(`${RUN_SELECT} WHERE r.id = ?`, [req.params.id]);
    res.json({ ...run, warnings: parseJson(run.warnings) });
  } catch (err) {
    next(err);
  }
});

// Approving locks the run: nothing recomputes it, and its loan lines now count against the
// loans' balances. It is recomputed first, so what is approved reflects attendance as it is now.
router.post('/:id/approve', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  try {
    await draftRun(req.params.id);
    await computeRun(req.params.id);
    await pool.query(
      "UPDATE payroll_runs SET status = 'approved', approved_by_user_id = ?, approved_at = NOW(), updated_at = NOW() WHERE id = ? AND status = 'draft'",
      [req.user.id, req.params.id]
    );
    const [[run]] = await pool.query(`${RUN_SELECT} WHERE r.id = ?`, [req.params.id]);
    res.json({ ...run, warnings: parseJson(run.warnings) });
  } catch (err) {
    next(err);
  }
});

// Back to draft, e.g. to fix a mistake found after approval. Its loan deductions stop counting
// against the balances until it is approved again.
router.post('/:id/reopen', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  try {
    const [result] = await pool.query(
      "UPDATE payroll_runs SET status = 'draft', approved_by_user_id = NULL, approved_at = NULL, updated_at = NOW() WHERE id = ? AND status = 'approved'",
      [req.params.id]
    );
    if (!result.affectedRows) return res.status(409).json({ error: 'Only an approved payroll can be reopened.' });
    const [[run]] = await pool.query(`${RUN_SELECT} WHERE r.id = ?`, [req.params.id]);
    res.json({ ...run, warnings: parseJson(run.warnings) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    await draftRun(req.params.id);
    await pool.query("DELETE FROM payroll_runs WHERE id = ? AND status = 'draft'", [req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// One-off additions/deductions on a draft run (a bonus, a refund, a uniform charge ...).
// Kept apart from the computed lines so a recompute keeps them.
router.post('/:id/adjustments', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    await draftRun(req.params.id);
    const employeeId = Number(req.body.employee_id);
    const adjType = req.body.adj_type;
    const label = String(req.body.label || '').trim();
    const amount = Number(req.body.amount);
    if (!employeeId) return res.status(400).json({ error: 'Choose the employee' });
    if (!['earning', 'deduction'].includes(adjType)) return res.status(400).json({ error: 'Choose addition or deduction' });
    if (!label) return res.status(400).json({ error: 'Describe the adjustment' });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Enter an amount above zero' });
    const [[inRun]] = await pool.query(
      'SELECT id FROM payroll_run_employees WHERE run_id = ? AND employee_id = ?', [req.params.id, employeeId]
    );
    if (!inRun) return res.status(400).json({ error: 'That employee is not in this payroll' });
    await pool.query('INSERT INTO payroll_adjustments SET ?', [{
      run_id: req.params.id, employee_id: employeeId, adj_type: adjType, label: label.slice(0, 150),
      amount, is_taxable: adjType === 'earning' ? (req.body.is_taxable === false ? 0 : 1) : 1,
      created_by_user_id: req.user.id,
    }]);
    await computeRun(req.params.id);
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/adjustments/:adjId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    await draftRun(req.params.id);
    await pool.query('DELETE FROM payroll_adjustments WHERE id = ? AND run_id = ?', [req.params.adjId, req.params.id]);
    await computeRun(req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
