const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/employees';

// account_type filters to employees whose linked user account is that type (e.g.
// ?account_type=Artist for an Artist-only picker) -- joins through users.employee_id
// since account_type lives on the user account, not the employee record itself.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { account_type: accountType, company_id: companyId, branch_id: branchId } = req.query;
    const where = [];
    const params = [];
    if (accountType) { where.push('u.account_type = ?'); params.push(accountType); }
    if (companyId) { where.push('e.company_id = ?'); params.push(companyId); }
    if (branchId) { where.push('e.branch_id = ?'); params.push(branchId); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT DISTINCT e.*, d.name AS department_name, c.name AS company_name, l.location_name AS branch_name
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN companies c ON c.id = e.company_id
       LEFT JOIN locations l ON l.id = e.branch_id
       ${accountType ? 'JOIN users u ON u.employee_id = e.id' : ''}
       ${whereSql}
       ORDER BY e.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[row]] = await pool.query('SELECT * FROM employees WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

const FIELDS = ['employee_code', 'first_name', 'last_name', 'department_id', 'company_id', 'branch_id', 'position_title', 'email', 'phone', 'date_hired', 'is_active'];

// A branch belongs to one company (locations.company_id), so an employee's branch has to be
// one of their own company's. A branch not yet assigned to any company is let through --
// otherwise no employee could be saved until every location had been sorted out.
async function branchError(body) {
  if (!body.branch_id) return null;
  const [[branch]] = await pool.query(
    `SELECT l.company_id, c.name AS company_name FROM locations l
     LEFT JOIN companies c ON c.id = l.company_id WHERE l.id = ?`,
    [body.branch_id]
  );
  if (!branch) return 'Branch not found';
  if (branch.company_id && Number(branch.company_id) !== Number(body.company_id)) {
    return `That branch belongs to ${branch.company_name}. Pick a ${branch.company_name} branch or change the company.`;
  }
  return null;
}

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const invalid = await branchError(req.body);
    if (invalid) return res.status(400).json({ error: invalid });
    const values = FIELDS.map((f) => (req.body[f] === undefined ? null : req.body[f]));
    const [result] = await pool.query(
      `INSERT INTO employees (${FIELDS.join(', ')}) VALUES (${FIELDS.map(() => '?').join(', ')})`,
      values
    );
    const [[row]] = await pool.query('SELECT * FROM employees WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const invalid = await branchError(req.body);
    if (invalid) return res.status(400).json({ error: invalid });
    const values = FIELDS.map((f) => (req.body[f] === undefined ? null : req.body[f]));
    await pool.query(
      `UPDATE employees SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
      [...values, req.params.id]
    );
    const [[row]] = await pool.query('SELECT * FROM employees WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM employees WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ error: 'This employee is referenced by other data (e.g. a user account) and cannot be deleted.' });
    }
    next(err);
  }
});

module.exports = router;
