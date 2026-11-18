const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { syncNewInkCost } = require('../lib/processInk');

const router = express.Router();
const ROUTE = '/process-costing';

const FIELDS = [
  'qty_min', 'qty_max', 'click_charge', 'new_ink_cost', 'ink_cost', 'direct_labor',
  'moh_power_equipment', 'moh_depreciation', 'moh_repairs_maintenance',
  'moh_indirect_materials', 'moh_indirect_labor', 'other_charges', 'sub_con', 'markup_sub_con_pct',
  'costing_allowance_pct', 'markup_cogs_pct', 'opex_admin_pct', 'markup_opex_admin_pct',
  'opex_selling_pct', 'markup_opex_selling_pct',
  'disc_ceiling_pct', 'disc_supervisor_pct', 'disc_manager_pct', 'disc_gm_pct',
  'costing_reference', 'is_active',
];
// selling_price_override is no longer written: Selling Price is always Total Price rounded up
// (shared/costing.js, 2026-10-02). The column stays only for the old values' history.

// ---------------------------------------------------------------- System Info
//
// Every bracket created, changed or deleted is written to audit_logs against the PROCESS
// (auditable_type 'ProcessCosting', auditable_id = process id), one row per changed field, named
// the way the Process Costing screen names it -- so the process's System Info tab reads as
// "1-269 · Mark-Up (COGS) %: 100 -> 90, by <user>".
const AUDIT_TYPE = 'ProcessCosting';
const LABELS = {
  qty_min: 'Qty Min', qty_max: 'Qty Max', click_charge: 'Click Charge', new_ink_cost: 'New INK Cost',
  ink_cost: 'INK', direct_labor: 'DL', moh_power_equipment: 'MOH (P/E)', moh_depreciation: 'MOH (DC)',
  moh_repairs_maintenance: 'MOH (R&M)', moh_indirect_materials: 'MOH (IM&C)', moh_indirect_labor: 'MOH (IL)',
  other_charges: 'Other Charges', sub_con: 'Sub Con', markup_sub_con_pct: 'Mark-Up Sub Con %',
  costing_allowance_pct: 'Costing Allowance %', markup_cogs_pct: 'Mark-Up (COGS) %',
  opex_admin_pct: 'OPEX (Admin) %', markup_opex_admin_pct: 'Mark-Up OPEX (Admin) %',
  opex_selling_pct: 'OPEX (Selling) %', markup_opex_selling_pct: 'Mark-Up OPEX (Selling) %',
  disc_ceiling_pct: 'DC Account Officer %', disc_supervisor_pct: 'DC Sales Supervisor %',
  disc_manager_pct: 'DC Sales Manager %', disc_gm_pct: 'DC General Manager %',
  selling_price_override: 'Selling Price', costing_reference: 'Costing Reference', is_active: 'Active',
};

// "5.0000" from the DB and "5" from the form are the same value, not a change.
function display(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && String(v).trim() !== '' ? String(n) : String(v);
}
const bracketName = (row) => `${display(row.qty_min) ?? '?'}-${display(row.qty_max) ?? '?'}`;

async function audit(processId, userId, eventType, fieldName, oldValue = null, newValue = null) {
  // A failed audit line must not undo a costing change that already saved.
  try {
    await pool.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [AUDIT_TYPE, processId, eventType, String(fieldName).slice(0, 150), oldValue, newValue, userId]
    );
  } catch (err) {
    console.error(`process costing ${processId}: audit entry failed --`, err.message);
  }
}

router.get('/:processId/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.id, a.event_type, a.field_name, a.old_value, a.new_value, a.set_at, u.display_name AS set_by_name
         FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
        WHERE a.auditable_type = ? AND a.auditable_id = ?
        ORDER BY a.set_at DESC, a.id DESC
        LIMIT 500`,
      [AUDIT_TYPE, req.params.processId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:processId/cost-brackets', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM process_cost_brackets WHERE process_id = ? ORDER BY qty_min',
      [req.params.processId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/:processId/cost-brackets', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const values = FIELDS.map((f) => (req.body[f] === undefined || req.body[f] === '' ? null : req.body[f]));
    const [result] = await pool.query(
      `INSERT INTO process_cost_brackets (process_id, ${FIELDS.join(', ')}) VALUES (?, ${FIELDS.map(() => '?').join(', ')})`,
      [req.params.processId, ...values]
    );
    // New INK Cost is the process's (lib/processInk.js), whatever was typed.
    await syncNewInkCost(pool, req.params.processId);
    const [[row]] = await pool.query('SELECT * FROM process_cost_brackets WHERE id = ?', [result.insertId]);
    await audit(req.params.processId, req.user.id, 'Created', `Bracket ${bracketName(row)}`);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.put('/:processId/cost-brackets/:bracketId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [[before]] = await pool.query(
      'SELECT * FROM process_cost_brackets WHERE id = ? AND process_id = ?', [req.params.bracketId, req.params.processId]);
    if (!before) return res.status(404).json({ error: 'Not found' });
    const values = FIELDS.map((f) => (req.body[f] === undefined || req.body[f] === '' ? null : req.body[f]));
    await pool.query(
      `UPDATE process_cost_brackets SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = NOW() WHERE id = ? AND process_id = ?`,
      [...values, req.params.bracketId, req.params.processId]
    );
    await syncNewInkCost(pool, req.params.processId);
    const [[row]] = await pool.query('SELECT * FROM process_cost_brackets WHERE id = ?', [req.params.bracketId]);
    // Named by the bracket's range as it was, so a changed Qty Min/Max still reads sensibly.
    const name = bracketName(before);
    for (const f of FIELDS) {
      const was = display(before[f]); const now = display(row[f]);
      if (was !== now) await audit(req.params.processId, req.user.id, 'Updated', `${name} · ${LABELS[f] || f}`, was, now);
    }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// Update (2026-11-04): every bracket's INK takes its New INK Cost -- the process's ink cost per unit
// from Lookups > Processes > Ink -- so the two read the same again. Audited per bracket.
router.post('/:processId/cost-brackets/apply-ink-cost', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    await syncNewInkCost(pool, req.params.processId);
    const [rows] = await pool.query(
      'SELECT * FROM process_cost_brackets WHERE process_id = ? AND new_ink_cost IS NOT NULL AND (ink_cost IS NULL OR ink_cost <> new_ink_cost)',
      [req.params.processId]);
    for (const b of rows) {
      await pool.query('UPDATE process_cost_brackets SET ink_cost = new_ink_cost, updated_at = NOW() WHERE id = ?', [b.id]);
      await audit(req.params.processId, req.user.id, 'Updated', `${bracketName(b)} · INK`, display(b.ink_cost), display(b.new_ink_cost));
    }
    const [all] = await pool.query('SELECT * FROM process_cost_brackets WHERE process_id = ? ORDER BY qty_min', [req.params.processId]);
    res.json({ updated: rows.length, brackets: all });
  } catch (err) {
    next(err);
  }
});

router.delete('/:processId/cost-brackets/:bracketId', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    const [[before]] = await pool.query(
      'SELECT * FROM process_cost_brackets WHERE id = ? AND process_id = ?', [req.params.bracketId, req.params.processId]);
    await pool.query('DELETE FROM process_cost_brackets WHERE id = ? AND process_id = ?', [req.params.bracketId, req.params.processId]);
    if (before) await audit(req.params.processId, req.user.id, 'Deleted', `Bracket ${bracketName(before)}`);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
