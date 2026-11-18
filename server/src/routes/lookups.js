const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { DEPARTMENT_NOTED_TYPES } = require('../lib/formNoters');

const router = express.Router();

// Whitelist of simple lookup tables exposed via this generic CRUD endpoint.
// `columns` lists the writable fields (besides id/created_at/updated_at).
const TABLES = {
  'chart-of-accounts': { table: 'chart_of_accounts', columns: ['account_code', 'account_name', 'account_type', 'parent_account_id', 'is_active'] },
  companies: { table: 'companies', columns: ['code', 'name', 'is_active'] },
  locations: { table: 'locations', columns: ['location_code', 'location_name', 'location_type', 'company_id', 'address', 'telephone', 'contact_person', 'is_active'] },
  'business-styles': { table: 'business_styles', columns: ['name', 'description', 'is_active'] },
  // job_location_id is the warehouse a department's people are restricted to on every job order
  // list -- empty means unrestricted. See lib/jobLocationVisibility.js.
  departments: { table: 'departments', columns: ['name', 'description', 'head_user_id', 'job_location_id', 'is_active'] },
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
  // item_id is the inventory item a Landed Cost PO line records for this charge. Listed here so
  // the generic save writes it -- a column absent from this list is silently ignored.
  'landed-costs': { table: 'landed_costs', columns: ['name', 'allocation_method', 'item_id', 'is_active'] },
  'non-inventories': { table: 'non_inventories', columns: ['item_code', 'display_name', 'unit_price', 'is_active'] },
  'service-items': { table: 'service_items', columns: ['item_code', 'display_name', 'unit_price', 'is_active'] },
  processes: { table: 'processes', columns: ['process_code', 'process_name', 'base_unit_id', 'default_location_id', 'minutes_per_unit', 'is_active'] },
  'user-groups': { table: 'user_groups', columns: ['name', 'is_active'] },
  // The precise spots an asset can sit in -- '2nd Floor Server Room', 'Rack 3'. Deliberately its
  // own list rather than the locations master: locations drive transfers, branches and the rest
  // of the ERP, and furniture-level placements do not belong in front of every other module.
  'asset-assigned-locations': { table: 'asset_assigned_locations', columns: ['name', 'description', 'is_active'] },
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

// The group's companies and their branches, for the Company / Branch filter on reports and lists
// (client/src/components/CompanyBranchFilter.jsx). Read-only and needs only a login: it names the
// companies, it does not open their figures -- each report checks its own permission.
router.get('/company-branches', requireAuth, async (req, res, next) => {
  try {
    const [companies] = await pool.query('SELECT id, code, name FROM companies WHERE is_active = TRUE ORDER BY name');
    const [branches] = await pool.query(
      'SELECT id, location_name, location_code, company_id FROM locations WHERE is_active = TRUE ORDER BY location_name'
    );
    res.json({ companies, branches });
  } catch (err) { next(err); }
});

// Ticket approvers are a many-to-many per department (department_ticket_approvers),
// which doesn't fit the generic single-row-payload CRUD below -- a small dedicated
// sub-resource instead. Placed before /:key/:id so Express matches these first (they
// have a different segment shape anyway, but keeping them together for clarity).
//
// The list is the department's HEADS, and each row says which of two jobs that person does:
//   can_approve_ticket   signs off tickets raised by this department
//   can_note_form        notes this department's liquidations and requests for payment
// Both are on by default when somebody is added -- naming a head who does neither would be an
// empty row -- and either can be unticked per person.
// The inventory items a Landed Cost may point at, for the Inventory Item picker on that lookup.
//
// READ-ONLY, and its own route rather than an entry in TABLES above, deliberately: every key in
// that map gets generic create, update AND DELETE. Listing `inventories` there to fill one
// dropdown would expose the item master to deletion through the lookups screen, which is not a
// trade worth making for a picker.
//
// Placed before /:key so the generic handler never sees it.
router.get('/landed-cost-items', requireAuth, requirePermission('/lookups', 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, item_code, display_name,
              CONCAT(item_code, ' — ', COALESCE(display_name, '')) AS label
         FROM inventories
        ORDER BY item_code`,
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/departments/:id/ticket-approvers', requireAuth, requirePermission('/lookups', 'can_view'), async (req, res, next) => {
  try {
    const sql = (leaveCol) => `SELECT u.id, u.display_name, u.username,
              dta.can_approve_ticket, dta.can_note_form, dta.note_form_types${leaveCol ? ', dta.can_approve_leave' : ''}
       FROM department_ticket_approvers dta
       JOIN users u ON u.id = dta.user_id
       WHERE dta.department_id = ? ORDER BY u.display_name`;
    // can_approve_leave arrives with db/add-department-leave-approvers.js; until then, without it.
    const [rows] = await pool.query(sql(true), [req.params.id]).catch((e) => {
      if (e.code === 'ER_BAD_FIELD_ERROR') return pool.query(sql(false), [req.params.id]);
      throw e;
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/departments/:id/ticket-approvers', requireAuth, requirePermission('/lookups', 'can_edit'), async (req, res, next) => {
  try {
    const { user_id: userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'user_id is required.' });
    // Adding somebody who is already on the list updates their two flags rather than doing
    // nothing, so the same endpoint serves the checkboxes.
    const approveTicket = req.body.can_approve_ticket === undefined ? 1 : (req.body.can_approve_ticket ? 1 : 0);
    const noteForm = req.body.can_note_form === undefined ? 1 : (req.body.can_note_form ? 1 : 0);
    await pool.query(
      `INSERT INTO department_ticket_approvers (department_id, user_id, can_approve_ticket, can_note_form)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE can_approve_ticket = VALUES(can_approve_ticket), can_note_form = VALUES(can_note_form)`,
      [req.params.id, userId, approveTicket, noteForm]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Changing what one of them does, without removing and re-adding them.
router.put('/departments/:id/ticket-approvers/:userId', requireAuth, requirePermission('/lookups', 'can_edit'), async (req, res, next) => {
  try {
    const fields = [];
    const params = [];
    if (req.body.can_approve_ticket !== undefined) {
      fields.push('can_approve_ticket = ?'); params.push(req.body.can_approve_ticket ? 1 : 0);
    }
    if (req.body.can_note_form !== undefined) {
      fields.push('can_note_form = ?'); params.push(req.body.can_note_form ? 1 : 0);
    }
    // Approves the Leave Applications filed from this department (2026-10-19; see routes/forms.js).
    if (req.body.can_approve_leave !== undefined) {
      fields.push('can_approve_leave = ?'); params.push(req.body.can_approve_leave ? 1 : 0);
    }
    // Which forms they note (2026-10-08): a list of department-noted form types; empty or every one
    // of them is stored as NULL, meaning all -- so a form type added later is included by default.
    if (req.body.note_form_types !== undefined) {
      const picked = (Array.isArray(req.body.note_form_types) ? req.body.note_form_types : [])
        .filter((t) => DEPARTMENT_NOTED_TYPES.includes(t));
      fields.push('note_form_types = ?');
      params.push(picked.length && picked.length < DEPARTMENT_NOTED_TYPES.length ? [...new Set(picked)].join(',') : null);
    }
    if (!fields.length) return res.json({ ok: true });
    params.push(req.params.id, req.params.userId);
    const [r] = await pool.query(
      `UPDATE department_ticket_approvers SET ${fields.join(', ')} WHERE department_id = ? AND user_id = ?`,
      params
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'That person is not on this department\'s list.' });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
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
