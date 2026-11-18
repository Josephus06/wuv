const express = require('express');
const pool = require('../db');
const { releaseWaitingForJobType } = require('../lib/directToProduction');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/job-types';

const FIELDS = [
  'item_code', 'display_name', 'sales_description', 'purchase_description', 'jo_type',
  'parent_job_type_id', 'department_id',
  'unit_type', 'stock_unit', 'purchase_unit', 'sales_unit', 'base_unit',
  'is_area', 'is_piece', 'is_for_sample', 'is_direct_to_prod', 'is_ecommerce',
  'income_account_id', 'cogs_account_id', 'asset_account_id',
  'gp_rate_head', 'gp_rate_branch', 'is_active',
];

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search } = req.query;
    const where = [];
    const params = [];
    if (search) {
      where.push('(jt.display_name LIKE ? OR jt.item_code LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT jt.*, ca.account_code AS cogs_account_code, ca.account_name AS cogs_account_name,
              aa.account_code AS asset_account_code, aa.account_name AS asset_account_name,
              ia.account_code AS income_account_code, ia.account_name AS income_account_name
       FROM job_types jt
       LEFT JOIN chart_of_accounts ca ON ca.id = jt.cogs_account_id
       LEFT JOIN chart_of_accounts aa ON aa.id = jt.asset_account_id
       LEFT JOIN chart_of_accounts ia ON ia.id = jt.income_account_id
       ${whereSql}
       ORDER BY jt.display_name`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[row]] = await pool.query(
      `SELECT jt.*, d.name AS department_name, pjt.display_name AS parent_job_type_name,
              ca.account_code AS cogs_account_code, ca.account_name AS cogs_account_name,
              aa.account_code AS asset_account_code, aa.account_name AS asset_account_name,
              ia.account_code AS income_account_code, ia.account_name AS income_account_name
       FROM job_types jt
       LEFT JOIN departments d ON d.id = jt.department_id
       LEFT JOIN job_types pjt ON pjt.id = jt.parent_job_type_id
       LEFT JOIN chart_of_accounts ca ON ca.id = jt.cogs_account_id
       LEFT JOIN chart_of_accounts aa ON aa.id = jt.asset_account_id
       LEFT JOIN chart_of_accounts ia ON ia.id = jt.income_account_id
       WHERE jt.id = ?`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });

    // Both numbers go down: jtp.minutes_per_unit is this job type's own time study for the
    // process, p.minutes_per_unit is the process's general one. The screen shows the effective
    // value and needs the fallback to say where it came from.
    const [processes] = await pool.query(
      `SELECT jtp.*, p.process_code, p.process_name, p.minutes_per_unit AS process_minutes_per_unit,
              COALESCE(jtp.minutes_per_unit, p.minutes_per_unit) AS effective_minutes_per_unit
       FROM job_type_processes jtp
       JOIN processes p ON p.id = jtp.process_id
       WHERE jtp.job_type_id = ? ORDER BY jtp.sort_order, jtp.id`,
      [req.params.id]
    );
    const [customers] = await pool.query(
      `SELECT jtc.*, c.customer_code, c.name AS customer_name
       FROM job_type_customers jtc
       JOIN customers c ON c.id = jtc.customer_id
       WHERE jtc.job_type_id = ? ORDER BY jtc.id`,
      [req.params.id]
    );

    res.json({ ...row, processes, customers });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const body = { ...req.body };
    const values = FIELDS.map((f) => (body[f] === undefined || body[f] === '' ? null : body[f]));
    const [result] = await pool.query(
      `INSERT INTO job_types (${FIELDS.join(', ')}) VALUES (${FIELDS.map(() => '?').join(', ')})`,
      values
    );
    const [[row]] = await pool.query('SELECT * FROM job_types WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Display name already in use' });
    next(err);
  }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [[before]] = await pool.query('SELECT id, is_direct_to_prod FROM job_types WHERE id = ?', [req.params.id]);
    if (!before) return res.status(404).json({ error: 'Not found' });

    const body = { ...req.body };
    const values = FIELDS.map((f) => (body[f] === undefined || body[f] === '' ? null : body[f]));
    await pool.query(
      `UPDATE job_types SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
      [...values, req.params.id]
    );

    // Just ticked Direct to Production: its job orders still waiting in Design go to Production now,
    // as new ones of this type do (lib/directToProduction.js releaseWaitingForJobType).
    let released = [];
    const [[row]] = await pool.query('SELECT * FROM job_types WHERE id = ?', [req.params.id]);
    if (!Number(before.is_direct_to_prod) && Number(row.is_direct_to_prod)) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        released = await releaseWaitingForJobType(conn, row.id, req.user.id);
        await conn.commit();
      } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    }
    res.json({ ...row, released_job_orders: released });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM job_type_processes WHERE job_type_id = ?', [req.params.id]);
    await conn.query('DELETE FROM job_type_customers WHERE job_type_id = ?', [req.params.id]);
    await conn.query('DELETE FROM job_types WHERE id = ?', [req.params.id]);
    await conn.commit();
    res.status(204).send();
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ error: 'This job type is referenced by other data and cannot be deleted.' });
    }
    next(err);
  } finally {
    conn.release();
  }
});

// Blank clears the override so the link inherits the process's own study again -- distinct
// from 0, which is a deliberate "this costs no time on this job".
const INVALID = Symbol('invalid');
function parseMinutes(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return INVALID;
  return n;
}

const PROCESS_LINK_SELECT = `SELECT jtp.*, p.process_code, p.process_name,
         p.minutes_per_unit AS process_minutes_per_unit,
         COALESCE(jtp.minutes_per_unit, p.minutes_per_unit) AS effective_minutes_per_unit
    FROM job_type_processes jtp
    JOIN processes p ON p.id = jtp.process_id WHERE jtp.id = ?`;

router.post('/:id/processes', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { process_id, minutes_per_unit } = req.body;
    const minutes = parseMinutes(minutes_per_unit);
    if (minutes === INVALID) return res.status(400).json({ error: 'Time study must be a number of minutes, 0 or greater.' });

    const [[{ maxSort }]] = await pool.query(
      'SELECT COALESCE(MAX(sort_order), 0) AS maxSort FROM job_type_processes WHERE job_type_id = ?',
      [req.params.id]
    );
    const [result] = await pool.query(
      'INSERT INTO job_type_processes (job_type_id, process_id, sort_order, minutes_per_unit) VALUES (?, ?, ?, ?)',
      [req.params.id, process_id, maxSort + 1, minutes]
    );
    const [[row]] = await pool.query(PROCESS_LINK_SELECT, [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This process is already assigned to this job type.' });
    next(err);
  }
});

// Set (or clear) this job type's time study for one of its processes. Scoped by job_type_id
// as well as link id so a link on another job type cannot be retimed through this URL.
router.patch('/:id/processes/:processLinkId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const minutes = parseMinutes(req.body?.minutes_per_unit);
    if (minutes === INVALID) return res.status(400).json({ error: 'Time study must be a number of minutes, 0 or greater.' });

    const [result] = await pool.query(
      'UPDATE job_type_processes SET minutes_per_unit = ? WHERE id = ? AND job_type_id = ?',
      [minutes, req.params.processLinkId, req.params.id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Not found' });

    const [[row]] = await pool.query(PROCESS_LINK_SELECT, [req.params.processLinkId]);
    res.json(row);
  } catch (err) { next(err); }
});

// The processes defined for one job type. The estimate asks for this when a Job Type is
// chosen on a job order line, so the operator picks from that job's own processes instead of
// searching the whole process master for the handful that apply.
router.get('/:id/processes', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT jtp.id, jtp.process_id, jtp.sort_order, jtp.minutes_per_unit,
              p.process_code, p.process_name, p.base_unit_id, p.is_active,
              COALESCE(jtp.minutes_per_unit, p.minutes_per_unit) AS effective_minutes_per_unit
         FROM job_type_processes jtp
         JOIN processes p ON p.id = jtp.process_id
        WHERE jtp.job_type_id = ? ORDER BY jtp.sort_order, p.process_name`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------------------
// Materials a process may use, per job type
// ---------------------------------------------------------------------------------------
//
// Hung off the job_type_processes link row, because the restriction belongs to the (job
// type, process) pair: the same cutting process draws on different stock depending on what
// is being made. The estimate reads this to narrow its Material picker.

const MATERIAL_SELECT = `SELECT m.id, m.job_type_process_id, m.inventory_id, m.is_default,
         jtp.process_id, p.process_code, p.process_name,
         i.item_code, i.display_name, i.base_unit_id
    FROM job_type_process_materials m
    JOIN job_type_processes jtp ON jtp.id = m.job_type_process_id
    JOIN processes p ON p.id = jtp.process_id
    JOIN inventories i ON i.id = m.inventory_id`;

// Every material defined across this job type's processes -- what the Materials tab lists.
router.get('/:id/materials', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `${MATERIAL_SELECT} WHERE jtp.job_type_id = ? ORDER BY jtp.sort_order, jtp.id, i.display_name`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// What the estimate asks: given the job type on the line and the process on the row, which
// materials may be chosen? An empty array means nobody has restricted this pair -- the
// caller decides what to do about that, and the estimate treats it as "no restriction"
// rather than locking the picker down to nothing.
router.get('/:id/process-materials/:processId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `${MATERIAL_SELECT} WHERE jtp.job_type_id = ? AND jtp.process_id = ? ORDER BY m.is_default DESC, i.display_name`,
      [req.params.id, req.params.processId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/:id/processes/:processLinkId/materials', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { inventory_id: inventoryId, is_default: isDefault } = req.body || {};
    if (!inventoryId) return res.status(400).json({ error: 'inventory_id is required.' });

    // Scoped by job_type_id so a link on another job type cannot be given materials here.
    const [[link]] = await pool.query(
      'SELECT id FROM job_type_processes WHERE id = ? AND job_type_id = ?',
      [req.params.processLinkId, req.params.id]
    );
    if (!link) return res.status(404).json({ error: 'Not found' });

    const [result] = await pool.query(
      'INSERT INTO job_type_process_materials (job_type_process_id, inventory_id, is_default) VALUES (?, ?, ?)',
      [link.id, inventoryId, isDefault ? 1 : 0]
    );
    const [[row]] = await pool.query(`${MATERIAL_SELECT} WHERE m.id = ?`, [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That material is already allowed for this process.' });
    if (err.code === 'ER_NO_REFERENCED_ROW_2') return res.status(400).json({ error: 'That material does not exist.' });
    next(err);
  }
});

// Learn a material from the estimate floor.
//
// When an estimator picks a material this pair has never been given, that choice is what the
// process actually uses -- so it is remembered here and offered as a defined material next
// time. Addressed by process_id rather than link id because the estimate knows the process it
// put on the line, not which job_type_processes row represents it.
//
// Gated on the ESTIMATE's can_edit, not the job type's: Sales can view job types but not edit
// them, so gating this the obvious way would 403 for exactly the people doing the estimating.
// The write it allows is deliberately narrow -- one row on one (job type, process) pair.
router.post('/:id/process-materials/:processId', requireAuth, requirePermission('/estimates', 'can_edit'), async (req, res, next) => {
  try {
    const { inventory_id: inventoryId } = req.body || {};
    if (!inventoryId) return res.status(400).json({ error: 'inventory_id is required.' });

    const [[link]] = await pool.query(
      'SELECT id FROM job_type_processes WHERE job_type_id = ? AND process_id = ? ORDER BY id LIMIT 1',
      [req.params.id, req.params.processId]
    );
    // The process is not on this job type at all -- nothing to hang the material off. Not an
    // error for the caller: the estimate keeps the material it chose, it just is not learned.
    if (!link) return res.status(204).send();

    // Idempotent: two estimators picking the same material must not race into a 409.
    await pool.query(
      'INSERT IGNORE INTO job_type_process_materials (job_type_process_id, inventory_id) VALUES (?, ?)',
      [link.id, inventoryId]
    );
    const [[row]] = await pool.query(
      `${MATERIAL_SELECT} WHERE m.job_type_process_id = ? AND m.inventory_id = ?`,
      [link.id, inventoryId]
    );
    // IGNORE downgrades the foreign-key violation to a warning, so a bad inventory_id inserts
    // nothing and reaches here looking like success. No row back means it was never valid.
    if (!row) return res.status(400).json({ error: 'That material does not exist.' });
    res.status(201).json(row);
  } catch (err) {
    if (err.code === 'ER_NO_REFERENCED_ROW_2') return res.status(400).json({ error: 'That material does not exist.' });
    next(err);
  }
});

// Unlearn a material from the estimate floor -- the counterpart to the learn POST above.
//
// Learning happens as a SIDE EFFECT of picking: choose a material this pair has never had and it
// is silently added to the pair's defined list for everyone, for good. Without a way back, one
// misclick permanently widened what the next estimator is offered, and the list could only ever
// grow. The delete that already existed is addressed by link id and gated on the job type's own
// can_edit, which Sales does not have -- so it was unreachable from the screen where the mistake
// is made and noticed.
//
// Gated exactly like the learn endpoint, and for the same reason: /estimates can_edit, so the
// people doing the estimating can undo their own mistake. Addressed by process_id and
// inventory_id, because that is what the estimate line knows.
//
// Removes the pair's material from EVERY job_type_processes row that matches, not just the first
// one the learn endpoint would have written to: the GET above lists across all of them, so
// deleting from one link could leave the material still showing.
router.delete('/:id/process-materials/:processId/:inventoryId', requireAuth, requirePermission('/estimates', 'can_edit'), async (req, res, next) => {
  try {
    const [result] = await pool.query(
      `DELETE m FROM job_type_process_materials m
         JOIN job_type_processes jtp ON jtp.id = m.job_type_process_id
        WHERE jtp.job_type_id = ? AND jtp.process_id = ? AND m.inventory_id = ?`,
      [req.params.id, req.params.processId, req.params.inventoryId]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

router.delete('/:id/processes/:processLinkId/materials/:materialId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [result] = await pool.query(
      `DELETE m FROM job_type_process_materials m
         JOIN job_type_processes jtp ON jtp.id = m.job_type_process_id
        WHERE m.id = ? AND m.job_type_process_id = ? AND jtp.job_type_id = ?`,
      [req.params.materialId, req.params.processLinkId, req.params.id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

router.delete('/:id/processes/:processLinkId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM job_type_processes WHERE id = ? AND job_type_id = ?', [req.params.processLinkId, req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.post('/:id/customers', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { customer_id, gp_rate } = req.body;
    const [result] = await pool.query(
      'INSERT INTO job_type_customers (job_type_id, customer_id, gp_rate) VALUES (?, ?, ?)',
      [req.params.id, customer_id, gp_rate || 0]
    );
    const [[row]] = await pool.query(
      `SELECT jtc.*, c.customer_code, c.name AS customer_name FROM job_type_customers jtc
       JOIN customers c ON c.id = jtc.customer_id WHERE jtc.id = ?`,
      [result.insertId]
    );
    res.status(201).json(row);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This customer already has a GP Rate override for this job type.' });
    next(err);
  }
});

router.delete('/:id/customers/:customerLinkId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM job_type_customers WHERE id = ? AND job_type_id = ?', [req.params.customerLinkId, req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
