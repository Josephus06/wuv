const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

// Whitelist of simple lookup tables exposed via this generic CRUD endpoint.
// `columns` lists the writable fields (besides id/created_at/updated_at).
const TABLES = {
  'chart-of-accounts': { table: 'chart_of_accounts', columns: ['account_code', 'account_name', 'account_type', 'parent_account_id', 'is_active'] },
  companies: { table: 'companies', columns: ['code', 'name', 'is_active'] },
  locations: { table: 'locations', columns: ['location_code', 'location_name', 'location_type', 'company_id', 'address', 'telephone', 'contact_person', 'is_active'] },
  'business-styles': { table: 'business_styles', columns: ['name', 'description', 'is_active'] },
  departments: { table: 'departments', columns: ['name', 'description', 'head_user_id', 'is_active'] },
  'units-of-measure': { table: 'units_of_measure', columns: ['code', 'title', 'is_active'] },
  'unit-conversions': { table: 'unit_conversions', columns: ['from_unit_id', 'to_unit_id', 'multiplier'] },
  'inventory-categories': { table: 'inventory_categories', columns: ['parent_category_id', 'name', 'description', 'is_active'] },
  taxes: { table: 'taxes', columns: ['code', 'name', 'rate', 'tax_account_id', 'is_active'] },
  'withholding-taxes': { table: 'withholding_taxes', columns: ['code', 'name', 'rate', 'atc_code', 'is_active'] },
  'payment-terms': { table: 'payment_terms', columns: ['term_name', 'no_of_days', 'is_active'] },
  'payment-methods': { table: 'payment_methods', columns: ['name', 'requires_reference', 'is_active'] },
  warranties: { table: 'warranties', columns: ['warranty_type', 'duration_label', 'duration_months', 'is_active'] },
  reasons: { table: 'reasons', columns: ['reason_type', 'name', 'is_active'] },
  'sales-divisions': { table: 'sales_divisions', columns: ['name', 'is_active'] },
  'discount-items': { table: 'discount_items', columns: ['name', 'discount_type', 'value', 'is_active'] },
  'landed-costs': { table: 'landed_costs', columns: ['name', 'allocation_method', 'is_active'] },
  'non-inventories': { table: 'non_inventories', columns: ['item_code', 'display_name', 'unit_price', 'is_active'] },
  'service-items': { table: 'service_items', columns: ['item_code', 'display_name', 'unit_price', 'is_active'] },
  processes: { table: 'processes', columns: ['process_code', 'process_name', 'base_unit_id', 'minutes_per_unit', 'is_active'] },
  'user-groups': { table: 'user_groups', columns: ['name', 'is_active'] },
};

function resolveTable(req, res, next) {
  const def = TABLES[req.params.key];
  if (!def) return res.status(404).json({ error: `Unknown lookup: ${req.params.key}` });
  req.lookupDef = def;
  next();
}

router.get('/', requireAuth, (req, res) => {
  res.json(Object.keys(TABLES).map((key) => ({ key, table: TABLES[key].table })));
});

// Ticket approvers are a many-to-many per department (department_ticket_approvers),
// which doesn't fit the generic single-row-payload CRUD below -- a small dedicated
// sub-resource instead. Placed before /:key/:id so Express matches these first (they
// have a different segment shape anyway, but keeping them together for clarity).
router.get('/departments/:id/ticket-approvers', requireAuth, requirePermission('/lookups', 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.display_name, u.username FROM department_ticket_approvers dta
       JOIN users u ON u.id = dta.user_id
       WHERE dta.department_id = ? ORDER BY u.display_name`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/departments/:id/ticket-approvers', requireAuth, requirePermission('/lookups', 'can_edit'), async (req, res, next) => {
  try {
    const { user_id: userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'user_id is required.' });
    await pool.query(
      'INSERT IGNORE INTO department_ticket_approvers (department_id, user_id) VALUES (?, ?)',
      [req.params.id, userId]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/departments/:id/ticket-approvers/:userId', requireAuth, requirePermission('/lookups', 'can_edit'), async (req, res, next) => {
  try {
    await pool.query(
      'DELETE FROM department_ticket_approvers WHERE department_id = ? AND user_id = ?',
      [req.params.id, req.params.userId]
    );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// General Managers are a flat, company-wide list (general_managers), not scoped to a
// department -- same reasoning as ticket-approvers above for why this is a dedicated
// sub-resource rather than the generic single-row CRUD.
router.get('/general-managers', requireAuth, requirePermission('/lookups', 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.display_name, u.username FROM general_managers gm
       JOIN users u ON u.id = gm.user_id ORDER BY u.display_name`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/general-managers', requireAuth, requirePermission('/lookups', 'can_edit'), async (req, res, next) => {
  try {
    const { user_id: userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'user_id is required.' });
    await pool.query('INSERT IGNORE INTO general_managers (user_id) VALUES (?)', [userId]);
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/general-managers/:userId', requireAuth, requirePermission('/lookups', 'can_edit'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM general_managers WHERE user_id = ?', [req.params.userId]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.get('/:key', requireAuth, requirePermission('/lookups', 'can_view'), resolveTable, async (req, res, next) => {
  try {
    const { table } = req.lookupDef;
    const [rows] = await pool.query(`SELECT * FROM \`${table}\` ORDER BY id DESC`);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/:key', requireAuth, requirePermission('/lookups', 'can_add'), resolveTable, async (req, res, next) => {
  try {
    const { table, columns } = req.lookupDef;
    const values = columns.map((c) => (req.body[c] === undefined ? null : req.body[c]));
    const [result] = await pool.query(
      `INSERT INTO \`${table}\` (${columns.map((c) => `\`${c}\``).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      values
    );
    const [[row]] = await pool.query(`SELECT * FROM \`${table}\` WHERE id = ?`, [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.put('/:key/:id', requireAuth, requirePermission('/lookups', 'can_edit'), resolveTable, async (req, res, next) => {
  try {
    const { table, columns } = req.lookupDef;
    const values = columns.map((c) => (req.body[c] === undefined ? null : req.body[c]));
    await pool.query(
      `UPDATE \`${table}\` SET ${columns.map((c) => `\`${c}\` = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
      [...values, req.params.id]
    );
    const [[row]] = await pool.query(`SELECT * FROM \`${table}\` WHERE id = ?`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:key/:id', requireAuth, requirePermission('/lookups', 'can_delete'), resolveTable, async (req, res, next) => {
  try {
    const { table } = req.lookupDef;
    await pool.query(`DELETE FROM \`${table}\` WHERE id = ?`, [req.params.id]);
    res.status(204).send();
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.code === 'ER_ROW_IS_REFERENCED') {
      return res.status(409).json({ error: 'This record is referenced by other data and cannot be deleted.' });
    }
    next(err);
  }
});

module.exports = router;
