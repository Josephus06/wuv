// What payroll is computed from, besides attendance and pay rates: the rate tables, the holiday
// calendar, recurring allowances/deductions and loans. Each has its own page and permission.
const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, requireAnyPermission } = require('../middleware/auth');
const { isIsoDate } = require('../lib/attendance');
const { DEFAULT_RULES, withDefaults, periodBrackets } = require('../lib/payrollRules');

const router = express.Router();
const SETTINGS = '/payroll-settings';
const HOLIDAYS = '/payroll-holidays';
const PAY_ITEMS = '/payroll-pay-items';
const LOANS = '/payroll-loans';

const badRequest = (res, error) => res.status(400).json({ error });
const money = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));

// Employee and company pickers for the payroll pages.
router.get('/employees', requireAuth, requireAnyPermission(['/payroll', PAY_ITEMS, LOANS]), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT e.id, e.employee_code, CONCAT(e.first_name, ' ', e.last_name) AS name, e.company_id,
              c.name AS company_name, l.location_name AS branch_name
       FROM employees e
       LEFT JOIN companies c ON c.id = e.company_id
       LEFT JOIN locations l ON l.id = e.branch_id
       WHERE e.is_active = TRUE ORDER BY e.first_name, e.last_name`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/companies', requireAuth, requireAnyPermission(['/payroll', HOLIDAYS]), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT id, code, name FROM companies WHERE is_active = TRUE ORDER BY name');
    res.json(rows);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------------------
// Rate tables
// ---------------------------------------------------------------------------------------

router.get('/rule-sets', requireAuth, requirePermission(SETTINGS, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT s.id, DATE_FORMAT(s.effective_from, '%Y-%m-%d') AS effective_from, s.rules, s.notes, s.created_at,
              s.updated_at, u.display_name AS created_by
       FROM payroll_rule_sets s LEFT JOIN users u ON u.id = s.created_by_user_id
       ORDER BY s.effective_from DESC`
    );
    res.json({
      defaults: DEFAULT_RULES,
      rule_sets: rows.map((r) => {
        const rules = withDefaults(JSON.parse(r.rules));
        return { ...r, rules, semi_monthly_tax_table: periodBrackets(rules.tax_brackets, 24) };
      }),
    });
  } catch (err) { next(err); }
});

const NUMBER_PATHS = [
  'hours_per_day', 'working_days_per_year', 'overtime_block_minutes', 'overtime_multiplier_ordinary',
  'overtime_multiplier_other', 'night_differential_rate',
  ...Object.keys(DEFAULT_RULES.day_multipliers).map((k) => `day_multipliers.${k}`),
  ...Object.keys(DEFAULT_RULES.sss).map((k) => `sss.${k}`),
  ...Object.keys(DEFAULT_RULES.philhealth).map((k) => `philhealth.${k}`),
  ...Object.keys(DEFAULT_RULES.pagibig).map((k) => `pagibig.${k}`),
];

// Validates and normalises a rule set from the form; returns { rules } or { error }.
function readRules(input) {
  const rules = withDefaults(input || {});
  for (const path of NUMBER_PATHS) {
    const [a, b] = path.split('.');
    const v = Number(b ? rules[a][b] : rules[a]);
    if (!Number.isFinite(v) || v < 0) return { error: `${path.replace(/[._]/g, ' ')} must be a number, 0 or more` };
    if (b) rules[a][b] = v; else rules[a] = v;
  }
  if (!(rules.hours_per_day > 0 && rules.hours_per_day <= 24)) return { error: 'Hours per day must be between 1 and 24' };
  if (!(rules.working_days_per_year >= 200 && rules.working_days_per_year <= 366)) return { error: 'Working days per year must be between 200 and 366' };
  if (!(rules.overtime_block_minutes >= 1)) return { error: 'Overtime block must be at least 1 minute' };
  for (const k of ['sss', 'philhealth', 'pagibig']) {
    if (!['split', 'first', 'second'].includes(rules.contribution_cutoffs[k])) return { error: 'Choose the cutoff each contribution is deducted in' };
  }
  rules.contribution_cutoffs = { sss: rules.contribution_cutoffs.sss, philhealth: rules.contribution_cutoffs.philhealth, pagibig: rules.contribution_cutoffs.pagibig };
  for (const k of ['night_start', 'night_end']) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(rules[k]))) return { error: 'Night differential hours must be HH:MM' };
  }
  const brackets = (Array.isArray(rules.tax_brackets) ? rules.tax_brackets : [])
    .map((t) => ({ over: Number(t.over), base: Number(t.base), rate: Number(t.rate) }))
    .sort((x, y) => x.over - y.over);
  if (!brackets.length || brackets[0].over !== 0) return { error: 'The tax table must start with a bracket over 0' };
  if (brackets.some((t) => ![t.over, t.base, t.rate].every((n) => Number.isFinite(n) && n >= 0) || t.rate >= 1)) {
    return { error: 'Each tax bracket needs an amount, a fixed tax and a rate below 100%' };
  }
  rules.tax_brackets = brackets;
  return { rules };
}

// Saves the rates effective from a date. Saving the same date again corrects that set; a new
// date starts a new one, so payrolls before it keep computing with the old rates.
router.post('/rule-sets', requireAuth, requirePermission(SETTINGS, 'can_edit'), async (req, res, next) => {
  try {
    if (!isIsoDate(req.body.effective_from)) return badRequest(res, 'Effective date is required');
    const { rules, error } = readRules(req.body.rules);
    if (error) return badRequest(res, error);
    await pool.query(
      `INSERT INTO payroll_rule_sets (effective_from, rules, notes, created_by_user_id) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE rules = VALUES(rules), notes = VALUES(notes), updated_at = NOW()`,
      [req.body.effective_from, JSON.stringify(rules), req.body.notes ? String(req.body.notes).slice(0, 255) : null, req.user.id]
    );
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/rule-sets/:id', requireAuth, requirePermission(SETTINGS, 'can_delete'), async (req, res, next) => {
  try {
    const [[used]] = await pool.query('SELECT COUNT(*) AS n FROM payroll_runs WHERE rule_set_id = ?', [req.params.id]);
    if (used.n) return res.status(409).json({ error: `${used.n} payroll(s) were computed with these rates. Save a newer set instead.` });
    const [[count]] = await pool.query('SELECT COUNT(*) AS n FROM payroll_rule_sets');
    if (count.n <= 1) return res.status(409).json({ error: 'Payroll needs at least one set of rates.' });
    await pool.query('DELETE FROM payroll_rule_sets WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------------------

router.get('/holidays', requireAuth, requireAnyPermission([HOLIDAYS, '/payroll']), async (req, res, next) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const [rows] = await pool.query(
      `SELECT h.id, DATE_FORMAT(h.holiday_date, '%Y-%m-%d') AS holiday_date, h.name, h.holiday_type, h.company_id,
              c.name AS company_name
       FROM holidays h LEFT JOIN companies c ON c.id = h.company_id
       WHERE YEAR(h.holiday_date) = ? ORDER BY h.holiday_date`,
      [year]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

function readHoliday(body) {
  if (!isIsoDate(body.holiday_date)) return { error: 'Date is required' };
  const name = String(body.name || '').trim();
  if (!name) return { error: 'Name is required' };
  if (!['regular', 'special'].includes(body.holiday_type)) return { error: 'Choose Regular or Special' };
  return { values: { holiday_date: body.holiday_date, name: name.slice(0, 150), holiday_type: body.holiday_type, company_id: body.company_id || null } };
}

router.post('/holidays', requireAuth, requirePermission(HOLIDAYS, 'can_add'), async (req, res, next) => {
  try {
    const { values, error } = readHoliday(req.body);
    if (error) return badRequest(res, error);
    const [result] = await pool.query('INSERT INTO holidays SET ?', [values]);
    res.status(201).json({ id: result.insertId });
  } catch (err) { next(err); }
});

router.put('/holidays/:id', requireAuth, requirePermission(HOLIDAYS, 'can_edit'), async (req, res, next) => {
  try {
    const { values, error } = readHoliday(req.body);
    if (error) return badRequest(res, error);
    await pool.query('UPDATE holidays SET ?, updated_at = NOW() WHERE id = ?', [values, req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/holidays/:id', requireAuth, requirePermission(HOLIDAYS, 'can_delete'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM holidays WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------------------
// Recurring allowances and deductions
// ---------------------------------------------------------------------------------------

router.get('/pay-items', requireAuth, requirePermission(PAY_ITEMS, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.id, p.employee_id, p.item_type, p.name, p.amount, p.is_taxable, p.remarks,
              DATE_FORMAT(p.effective_from, '%Y-%m-%d') AS effective_from, DATE_FORMAT(p.effective_to, '%Y-%m-%d') AS effective_to,
              CONCAT(e.first_name, ' ', e.last_name) AS employee_name, e.employee_code, c.name AS company_name
       FROM employee_pay_items p
       JOIN employees e ON e.id = p.employee_id
       LEFT JOIN companies c ON c.id = e.company_id
       ORDER BY e.first_name, e.last_name, p.item_type, p.name`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

function readPayItem(body) {
  const amount = money(body.amount);
  if (!Number(body.employee_id)) return { error: 'Choose the employee' };
  if (!['allowance', 'deduction'].includes(body.item_type)) return { error: 'Choose Allowance or Deduction' };
  const name = String(body.name || '').trim();
  if (!name) return { error: 'Name is required (e.g. Rice allowance)' };
  if (!(amount > 0)) return { error: 'Enter the amount per payroll' };
  if (!isIsoDate(body.effective_from)) return { error: 'Start date is required' };
  if (body.effective_to && (!isIsoDate(body.effective_to) || body.effective_to < body.effective_from)) return { error: 'End date must be on or after the start date' };
  return {
    values: {
      employee_id: Number(body.employee_id), item_type: body.item_type, name: name.slice(0, 100), amount,
      is_taxable: body.item_type === 'allowance' && body.is_taxable ? 1 : 0,
      effective_from: body.effective_from, effective_to: body.effective_to || null,
      remarks: body.remarks ? String(body.remarks).slice(0, 255) : null,
    },
  };
}

router.post('/pay-items', requireAuth, requirePermission(PAY_ITEMS, 'can_add'), async (req, res, next) => {
  try {
    const { values, error } = readPayItem(req.body);
    if (error) return badRequest(res, error);
    const [result] = await pool.query('INSERT INTO employee_pay_items SET ?', [{ ...values, created_by_user_id: req.user.id }]);
    res.status(201).json({ id: result.insertId });
  } catch (err) { next(err); }
});

router.put('/pay-items/:id', requireAuth, requirePermission(PAY_ITEMS, 'can_edit'), async (req, res, next) => {
  try {
    const { values, error } = readPayItem(req.body);
    if (error) return badRequest(res, error);
    await pool.query('UPDATE employee_pay_items SET ?, updated_at = NOW() WHERE id = ?', [values, req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/pay-items/:id', requireAuth, requirePermission(PAY_ITEMS, 'can_delete'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM employee_pay_items WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------------------
// Loans
// ---------------------------------------------------------------------------------------

// Paid = the loan's lines in APPROVED payrolls; balance = loan amount less that.
const LOAN_SELECT = `
  SELECT ln.id, ln.employee_id, ln.loan_type, ln.reference_no, ln.loan_amount, ln.amortization, ln.status, ln.remarks,
         DATE_FORMAT(ln.start_date, '%Y-%m-%d') AS start_date,
         CONCAT(e.first_name, ' ', e.last_name) AS employee_name, e.employee_code, c.name AS company_name,
         COALESCE((SELECT SUM(pl.amount) FROM payroll_run_lines pl JOIN payroll_runs r ON r.id = pl.run_id
                   WHERE pl.loan_id = ln.id AND r.status = 'approved'), 0) AS paid
  FROM employee_loans ln
  JOIN employees e ON e.id = ln.employee_id
  LEFT JOIN companies c ON c.id = e.company_id`;

const withBalance = (r) => {
  const balance = Math.round((Number(r.loan_amount) - Number(r.paid)) * 100) / 100;
  return { ...r, paid: Number(r.paid), balance, is_paid: balance <= 0 };
};

router.get('/loans', requireAuth, requirePermission(LOANS, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(`${LOAN_SELECT} ORDER BY e.first_name, e.last_name, ln.start_date DESC`);
    res.json(rows.map(withBalance));
  } catch (err) { next(err); }
});

router.get('/loans/:id/payments', requireAuth, requirePermission(LOANS, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT r.id AS run_id, DATE_FORMAT(r.period_start, '%Y-%m-%d') AS period_start,
              DATE_FORMAT(r.period_end, '%Y-%m-%d') AS period_end, DATE_FORMAT(r.pay_date, '%Y-%m-%d') AS pay_date,
              r.status, pl.amount
       FROM payroll_run_lines pl JOIN payroll_runs r ON r.id = pl.run_id
       WHERE pl.loan_id = ? ORDER BY r.period_start`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

function readLoan(body) {
  const loanAmount = money(body.loan_amount);
  const amortization = money(body.amortization);
  if (!Number(body.employee_id)) return { error: 'Choose the employee' };
  const loanType = String(body.loan_type || '').trim();
  if (!loanType) return { error: 'Loan type is required (e.g. SSS Salary Loan)' };
  if (!(loanAmount > 0)) return { error: 'Enter the total amount to be repaid' };
  if (!(amortization > 0)) return { error: 'Enter the deduction per payroll' };
  if (amortization > loanAmount) return { error: 'The deduction per payroll cannot be more than the loan' };
  if (!isIsoDate(body.start_date)) return { error: 'Start date is required: the first cutoff to deduct from' };
  if (!['active', 'paused', 'cancelled'].includes(body.status || 'active')) return { error: 'Unknown status' };
  return {
    values: {
      employee_id: Number(body.employee_id), loan_type: loanType.slice(0, 60),
      reference_no: body.reference_no ? String(body.reference_no).slice(0, 60) : null,
      loan_amount: loanAmount, amortization, start_date: body.start_date, status: body.status || 'active',
      remarks: body.remarks ? String(body.remarks).slice(0, 255) : null,
    },
  };
}

router.post('/loans', requireAuth, requirePermission(LOANS, 'can_add'), async (req, res, next) => {
  try {
    const { values, error } = readLoan(req.body);
    if (error) return badRequest(res, error);
    const [result] = await pool.query('INSERT INTO employee_loans SET ?', [{ ...values, created_by_user_id: req.user.id }]);
    res.status(201).json({ id: result.insertId });
  } catch (err) { next(err); }
});

router.put('/loans/:id', requireAuth, requirePermission(LOANS, 'can_edit'), async (req, res, next) => {
  try {
    const { values, error } = readLoan(req.body);
    if (error) return badRequest(res, error);
    await pool.query('UPDATE employee_loans SET ?, updated_at = NOW() WHERE id = ?', [values, req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// A loan with deductions in any payroll is part of that payroll's record: cancel it instead.
router.delete('/loans/:id', requireAuth, requirePermission(LOANS, 'can_delete'), async (req, res, next) => {
  try {
    const [[used]] = await pool.query('SELECT COUNT(*) AS n FROM payroll_run_lines WHERE loan_id = ?', [req.params.id]);
    if (used.n) return res.status(409).json({ error: 'This loan has deductions in a payroll. Set it to Cancelled instead.' });
    await pool.query('DELETE FROM employee_loans WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
