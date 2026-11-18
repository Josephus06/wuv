const express = require('express');
const pool = require('../db');
const { assignDocNo } = require('../lib/docNumber');
const { requireAuth, requirePermission, isSystemAdmin } = require('../middleware/auth');
const { assertPeriodOpen } = require('../lib/accountingPeriod');
const { computeInventoryAdjustmentGl } = require('../lib/glImpact');
const { lineDepartmentError } = require('../lib/requireDepartment');
const { deriveOnHand } = require('../lib/stockLedger');

const router = express.Router();
const ROUTE = '/inventory-adjustments';

const STATUS_VALUES = ['pending_approval', 'approved', 'cancelled'];

// unit_used is stored two ways. Lines written by this file hold 'stock' / 'base'; lines that came
// across in the migration hold 'StockUnit' (7,333) / 'BaseUnit' (286). Anything compared with a
// bare `=== 'stock'` therefore silently mis-reads every migrated row, so both spellings are folded
// here and nothing downstream compares the raw column.
//
// Stock is the default because that is what the form defaults to: an adjustment of "2" against a
// 4'x8' acrylic sheet means 2 SHEETS, which is 64 SQFT.
const unitUsedIsBase = (v) => ['base', 'baseunit'].includes(String(v || '').trim().toLowerCase());
const normaliseUnitUsed = (v) => (unitUsedIsBase(v) ? 'base' : 'stock');

// Shared line-row select: UOM reflects whichever unit is toggled (Stock Unit / Base
// Unit) via unit_used, falling back to Base Unit if the item has no Stock Unit set.
// est_unit_cost (== inventories.average_cost) is priced per Stock/Purchase Unit (e.g.
// pesos per ROLL, matching how Purchase Order Rate is entered) -- est_unit_cost_base
// divides that down by the item's conversion_factor to get the per-Base-Unit price
// (pesos per SQFT), for display next to Qty on Hand/New Qty which are always Base Unit.
const LINE_SELECT = `
  SELECT l.*, i.item_code, i.display_name AS item_name, i.asset_account_id,
         CASE WHEN LOWER(l.unit_used) IN ('base', 'baseunit') THEN bu.title
              ELSE COALESCE(su.title, bu.title) END AS uom_title,
         l.est_unit_cost / COALESCE(NULLIF(i.conversion_factor, 0), 1) AS est_unit_cost_base,
         loc.location_name, d.name AS department_name
  FROM inventory_adjustment_lines l
  LEFT JOIN inventories i ON i.id = l.item_id
  LEFT JOIN units_of_measure bu ON bu.id = i.base_unit_id
  LEFT JOIN units_of_measure su ON su.id = i.stock_unit_id
  LEFT JOIN locations loc ON loc.id = l.location_id
  LEFT JOIN departments d ON d.id = l.department_id
`;

// GL Impact computation lives in server/src/lib/glImpact.js (computeInventoryAdjustmentGl),
// shared with the Reports engine so the reports can never drift from what this tab shows.
const computeGlImpact = computeInventoryAdjustmentGl;

async function logAudit(conn, { adjustmentId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('InventoryAdjustment', ?, ?, ?, ?, ?, ?)`,
    [adjustmentId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { status, search } = req.query;
    const where = [];
    const params = [];
    if (status && STATUS_VALUES.includes(status)) { where.push('ia.status = ?'); params.push(status); }
    if (search) {
      where.push('(ia.adjustment_no LIKE ? OR ia.memo LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT ia.* FROM inventory_adjustments ia ${whereSql} ORDER BY ia.id DESC`,
      params
    );

    const [countRows] = await pool.query(
      'SELECT status, COUNT(*) AS count FROM inventory_adjustments GROUP BY status'
    );
    const counts = Object.fromEntries(STATUS_VALUES.map((s) => [s, 0]));
    countRows.forEach((r) => { if (counts[r.status] !== undefined) counts[r.status] = r.count; });

    res.json({ rows, counts });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[adj]] = await pool.query(
      `SELECT ia.*, coa.account_code AS adjustment_account_code, coa.account_name AS adjustment_account_name,
              CONCAT(cu.display_name) AS created_by_name, CONCAT(au.display_name) AS approved_by_name
       FROM inventory_adjustments ia
       LEFT JOIN chart_of_accounts coa ON coa.id = ia.adjustment_account_id
       LEFT JOIN users cu ON cu.id = ia.created_by_user_id
       LEFT JOIN users au ON au.id = ia.approved_by_user_id
       WHERE ia.id = ?`,
      [req.params.id]
    );
    if (!adj) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `${LINE_SELECT} WHERE l.inventory_adjustment_id = ? ORDER BY l.line_no`,
      [req.params.id]
    );
    const glImpact = adj.status === 'approved' ? await computeGlImpact(adj, lines) : [];

    res.json({ ...adj, gl_impact: glImpact, lines });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'InventoryAdjustment' AND a.auditable_id = ?
       ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { date_created: dateCreated, adjustment_account_id: adjustmentAccountId, memo } = req.body;
    await assertPeriodOpen(dateCreated, 'non_gl', conn);
    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO inventory_adjustments (adjustment_no, date_created, adjustment_account_id, memo, created_by_user_id)
       VALUES ('', ?, ?, ?, ?)`,
      [dateCreated || new Date().toISOString().slice(0, 10), adjustmentAccountId || null, memo || null, req.user.id]
    );
    const adjNo = await assignDocNo(conn, { table: 'inventory_adjustments', column: 'adjustment_no', prefix: 'IA-', id: result.insertId });
    await logAudit(conn, { adjustmentId: result.insertId, userId: req.user.id, eventType: 'Created', fieldName: 'adjustment_no', newValue: adjNo });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM inventory_adjustments WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Who may edit an adjustment in its current state: anyone with Edit while it is Pending Approval;
// once APPROVED, a System Admin only (asked 2026-10-06) -- correcting a count after the stock has
// moved. A cancelled one, nobody. Returns the refusal message, or null when the edit may go ahead.
async function editRefusal(userId, adj) {
  if (adj.status === 'pending_approval') return null;
  if (adj.status === 'approved') {
    return (await isSystemAdmin(userId)) ? null : 'An approved adjustment can only be edited by a System Admin.';
  }
  return 'Only a Pending Approval adjustment can be edited.';
}

// An APPROVED line has already written its New Qty into inventory_locations (see approve below), so
// editing, adding or deleting one moves that stored balance by exactly the change in the line's
// delta (New Qty - Qty on Hand). The Bin Card, On Hand and GL Impact are derived from the approved
// lines on read and follow the edit by themselves.
async function shiftStock(conn, itemId, locationId, by) {
  if (!itemId || !locationId || Math.abs(by) < 1e-9) return;
  await conn.query(
    `INSERT INTO inventory_locations (inventory_id, location_id, qty_on_hand) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE qty_on_hand = qty_on_hand + VALUES(qty_on_hand)`,
    [itemId, locationId, by]
  );
}

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [[adj]] = await pool.query('SELECT status, date_created FROM inventory_adjustments WHERE id = ?', [req.params.id]);
    if (!adj) return res.status(404).json({ error: 'Not found' });
    const refusal = await editRefusal(req.user.id, adj);
    if (refusal) return res.status(409).json({ error: refusal });
    const { date_created: dateCreated, adjustment_account_id: adjustmentAccountId, memo } = req.body;
    await assertPeriodOpen([adj.date_created, dateCreated], 'non_gl');
    // Department is required on every line. Lines are written one at a time as they are added and
    // edited (a new line starts with none and the user picks it next), so the document's Save --
    // and Approve below -- is where a line still missing one is refused.
    const [deptLines] = await pool.query(
      'SELECT department_id FROM inventory_adjustment_lines WHERE inventory_adjustment_id = ? ORDER BY line_no, id',
      [req.params.id]
    );
    const deptError = lineDepartmentError(deptLines);
    if (deptError) return res.status(400).json({ error: deptError });
    await pool.query(
      'UPDATE inventory_adjustments SET date_created = ?, adjustment_account_id = ?, memo = ?, updated_at = NOW() WHERE id = ?',
      [dateCreated, adjustmentAccountId || null, memo || null, req.params.id]
    );
    const [[row]] = await pool.query('SELECT * FROM inventory_adjustments WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// (new_qty - qty_on_hand) is a Base Unit delta, but est_unit_cost is priced per
// Stock/Purchase Unit -- has to come down to a per-Base-Unit price (/ conversion_factor)
// before multiplying, same as est_unit_cost_base above.
async function recomputeTotal(conn, adjustmentId) {
  const [[{ total }]] = await conn.query(
    `SELECT COALESCE(SUM((l.new_qty - l.qty_on_hand) * (l.est_unit_cost / COALESCE(NULLIF(i.conversion_factor, 0), 1))), 0) AS total
     FROM inventory_adjustment_lines l
     LEFT JOIN inventories i ON i.id = l.item_id
     WHERE l.inventory_adjustment_id = ?`,
    [adjustmentId]
  );
  await conn.query('UPDATE inventory_adjustments SET estimated_total_value = ?, updated_at = NOW() WHERE id = ?', [total, adjustmentId]);
}

// The item's Qty on Hand at a location, in Base Unit: the Bin Card's own closing balance
// (lib/stockLedger.js deriveOnHand -- the source's Beginning Balance plus the movements since).
// Not inventory_locations.qty_on_hand: that counter never received the opening balances, so a
// line read it as the movements alone -- -41 against the Bin Card's 22 for the stainless valve on
// IA-1196 (2026-10-12), off by exactly its 63 Beginning Balance. Only APPROVED adjustments are
// movements, so a pending line's own change is not in it.
async function onHandAt(conn, itemId, locationId) {
  if (!itemId || !locationId) return 0;
  const byPair = await deriveOnHand(conn, [itemId]);
  return Number(byPair.get(`${Number(itemId)}|${Number(locationId)}`) || 0);
}

// Adding a line snapshots the item's current Qty on Hand / Value at that location --
// matching the real form's behavior of pulling live values in at add-time, not
// re-querying them live forever after.
router.post('/:id/lines', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[adj]] = await conn.query('SELECT status, date_created FROM inventory_adjustments WHERE id = ?', [req.params.id]);
    if (adj) await assertPeriodOpen(adj.date_created, 'non_gl', conn);
    if (!adj) { return res.status(404).json({ error: 'Not found' }); }
    const refusal = await editRefusal(req.user.id, adj);
    if (refusal) { return res.status(409).json({ error: refusal }); }

    const { item_id: itemId, location_id: locationId, department_id: departmentId, unit_used: unitUsed } = req.body;
    if (!itemId) { return res.status(400).json({ error: 'Item is required.' }); }

    await conn.beginTransaction();
    const [[item]] = await conn.query('SELECT average_cost, base_unit_id, conversion_factor FROM inventories i WHERE i.id = ?', [itemId]);
    const [[unit]] = await conn.query('SELECT title FROM units_of_measure WHERE id = ?', [item?.base_unit_id]);
    // average_cost is priced per Stock/Purchase Unit -- current_value has to multiply a
    // per-Base-Unit price against qtyOnHand (Base Unit), so divide it down first.
    const estUnitCost = Number(item?.average_cost || 0);
    const conversionFactor = Number(item?.conversion_factor) || 1;
    const qtyOnHand = await onHandAt(conn, itemId, locationId);

    const [[{ nextLine }]] = await conn.query(
      'SELECT COALESCE(MAX(line_no), 0) + 1 AS nextLine FROM inventory_adjustment_lines WHERE inventory_adjustment_id = ?',
      [req.params.id]
    );
    const [result] = await conn.query(
      `INSERT INTO inventory_adjustment_lines
         (inventory_adjustment_id, line_no, item_id, location_id, department_id, qty_on_hand, unit, unit_used, current_value, adjust_qty_by, new_qty, est_unit_cost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [req.params.id, nextLine, itemId, locationId || null, departmentId || null, qtyOnHand, unit?.title || null, normaliseUnitUsed(unitUsed), qtyOnHand * (estUnitCost / conversionFactor), qtyOnHand, estUnitCost]
    );
    await recomputeTotal(conn, req.params.id);
    await conn.commit();

    const [[row]] = await pool.query(`${LINE_SELECT} WHERE l.id = ?`, [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id/lines/:lineId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[adj]] = await conn.query('SELECT status, date_created FROM inventory_adjustments WHERE id = ?', [req.params.id]);
    if (adj) await assertPeriodOpen(adj.date_created, 'non_gl', conn);
    if (!adj) { return res.status(404).json({ error: 'Not found' }); }
    const refusal = await editRefusal(req.user.id, adj);
    if (refusal) { return res.status(409).json({ error: refusal }); }

    const [[line]] = await conn.query(
      'SELECT line_no, item_id, location_id, department_id, qty_on_hand, new_qty, est_unit_cost, adjust_qty_by, unit_used, memo FROM inventory_adjustment_lines WHERE id = ? AND inventory_adjustment_id = ?',
      [req.params.lineId, req.params.id]
    );
    if (!line) { return res.status(404).json({ error: 'Line not found' }); }

    const locationId = req.body.location_id !== undefined ? (req.body.location_id || null) : line.location_id;
    const departmentId = req.body.department_id !== undefined ? (req.body.department_id || null) : line.department_id;
    // Changing a line's Department may set it, never clear it (it is required; see PUT /:id).
    if (req.body.department_id !== undefined) {
      const deptError = lineDepartmentError([{ department_id: departmentId }]);
      if (deptError) return res.status(400).json({ error: deptError.replace('line 1', `line ${line.line_no}`) });
    }
    const locationChanged = Number(locationId || 0) !== Number(line.location_id || 0);
    // An approved line's stock has landed at its location; moving it is a delete and a new line.
    if (adj.status === 'approved' && locationChanged) {
      return res.status(409).json({ error: 'On an approved adjustment, delete the line and add it again at the other location.' });
    }

    let qtyOnHand = Number(line.qty_on_hand || 0);
    let estUnitCost = Number(line.est_unit_cost || 0);
    if (locationChanged && locationId) {
      const [[item]] = await conn.query('SELECT average_cost FROM inventories WHERE id = ?', [line.item_id]);
      estUnitCost = Number(item?.average_cost || 0);
    }
    // While pending, Qty on Hand is re-read on every edit, so it is the Bin Card's figure when the
    // adjustment is approved (and lines saved with the old, wrong figure correct themselves). An
    // approved line keeps the snapshot it posted with.
    if (adj.status !== 'approved') qtyOnHand = await onHandAt(conn, line.item_id, locationId);

    // Only fields actually present in the request are changed -- everything else falls
    // back to what's already saved. The frontend fires one PUT per field edited (Unit
    // Used, Adjust Qty By, Location, ... can each be committed independently in quick
    // succession), so treating every field as "must be in this request or it resets to a
    // default" let concurrent edits clobber each other (e.g. picking Base Unit right
    // before blurring Adjust Qty By could silently revert Unit Used back to Stock).
    const adjustQtyBy = req.body.adjust_qty_by !== undefined ? Number(req.body.adjust_qty_by || 0) : Number(line.adjust_qty_by || 0);
    const memo = req.body.memo !== undefined ? (req.body.memo || null) : line.memo;
    // Normalised on BOTH paths. The fallback is the one that mattered: an untouched migrated line
    // carries 'StockUnit', which `=== 'stock'` reads as false, so editing any other field on it --
    // a location, a memo -- recomputed New Qty with no conversion at all and wrote the unscaled
    // figure back. On the 4'x8' acrylic that turns 2 sheets into 2 SQFT instead of 64.
    const unitUsed = normaliseUnitUsed(req.body.unit_used !== undefined ? req.body.unit_used : line.unit_used);
    // Qty on Hand/New Qty are always tracked in Base Unit (matches Bin Card and every
    // other stock-moving feature); est_unit_cost (average_cost) is priced per Stock/
    // Purchase Unit. Adjust Qty By is only already in Base Unit when Unit Used = Base
    // Unit -- when it's Stock Unit (the default -- e.g. "1" meaning 1 ROLL), it has to be
    // scaled up by conversion_factor before it's added, the same Purchase Unit -> Base
    // Unit scaling Purchase Order receiving/return apply. current_value needs the same
    // factor applied the other way (cost per Base Unit) since it multiplies against a
    // Base Unit qty.
    const [[itemConv]] = await conn.query('SELECT conversion_factor FROM inventories WHERE id = ?', [line.item_id]);
    const conversionFactor = Number(itemConv?.conversion_factor) || 1;
    const newQty = qtyOnHand + adjustQtyBy * (unitUsed === 'stock' ? conversionFactor : 1);

    await conn.beginTransaction();
    await conn.query(
      `UPDATE inventory_adjustment_lines
       SET location_id = ?, department_id = ?, qty_on_hand = ?, est_unit_cost = ?, current_value = ?,
           adjust_qty_by = ?, new_qty = ?, memo = ?, unit_used = ?
       WHERE id = ?`,
      [locationId, departmentId, qtyOnHand, estUnitCost, qtyOnHand * (estUnitCost / conversionFactor), adjustQtyBy, newQty, memo, unitUsed, req.params.lineId]
    );
    if (adj.status === 'approved') {
      const was = Number(line.new_qty || 0) - Number(line.qty_on_hand || 0);
      await shiftStock(conn, line.item_id, line.location_id, (newQty - qtyOnHand) - was);
      await logAudit(conn, {
        adjustmentId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: `line ${req.params.lineId} (approved)`,
        oldValue: `adjust by ${Number(line.adjust_qty_by || 0)}`, newValue: `adjust by ${adjustQtyBy}`,
      });
    }
    await recomputeTotal(conn, req.params.id);
    await conn.commit();

    const [[row]] = await pool.query(`${LINE_SELECT} WHERE l.id = ?`, [req.params.lineId]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.delete('/:id/lines/:lineId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[adj]] = await conn.query('SELECT status, date_created FROM inventory_adjustments WHERE id = ?', [req.params.id]);
    if (adj) await assertPeriodOpen(adj.date_created, 'non_gl', conn);
    if (!adj) { return res.status(404).json({ error: 'Not found' }); }
    const refusal = await editRefusal(req.user.id, adj);
    if (refusal) { return res.status(409).json({ error: refusal }); }

    const [[gone]] = await conn.query(
      'SELECT item_id, location_id, qty_on_hand, new_qty, adjust_qty_by FROM inventory_adjustment_lines WHERE id = ? AND inventory_adjustment_id = ?',
      [req.params.lineId, req.params.id]);
    await conn.beginTransaction();
    if (gone && adj.status === 'approved') {
      // Take back what the line put into stock when it was approved.
      await shiftStock(conn, gone.item_id, gone.location_id, -(Number(gone.new_qty || 0) - Number(gone.qty_on_hand || 0)));
      await logAudit(conn, {
        adjustmentId: req.params.id, userId: req.user.id, eventType: 'Deleted', fieldName: `line ${req.params.lineId} (approved)`,
        oldValue: `adjust by ${Number(gone.adjust_qty_by || 0)}`, newValue: null,
      });
    }
    await conn.query('DELETE FROM inventory_adjustment_lines WHERE id = ? AND inventory_adjustment_id = ?', [req.params.lineId, req.params.id]);
    await recomputeTotal(conn, req.params.id);
    await conn.commit();
    res.status(204).send();
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Approving is what actually moves the needle: each line's New Qty is written into
// inventory_locations.qty_on_hand (upserting the row if one doesn't exist yet).
router.put('/:id/approve', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[adj]] = await conn.query('SELECT status, date_created FROM inventory_adjustments WHERE id = ?', [req.params.id]);
    if (adj) await assertPeriodOpen(adj.date_created, 'non_gl', conn);
    if (!adj) { return res.status(404).json({ error: 'Not found' }); }
    if (adj.status !== 'pending_approval') { return res.status(409).json({ error: 'Only a Pending Approval adjustment can be approved.' }); }

    const [lines] = await conn.query('SELECT item_id, location_id, department_id, new_qty FROM inventory_adjustment_lines WHERE inventory_adjustment_id = ? ORDER BY line_no, id', [req.params.id]);
    if (lines.length === 0) { return res.status(409).json({ error: 'Add at least one material line before approving.' }); }
    if (lines.some((l) => !l.location_id)) { return res.status(409).json({ error: 'Every line needs a Location before this can be approved.' }); }
    const deptError = lineDepartmentError(lines);
    if (deptError) { return res.status(409).json({ error: deptError }); }

    await conn.beginTransaction();
    for (const line of lines) {
      await conn.query(
        `INSERT INTO inventory_locations (inventory_id, location_id, qty_on_hand)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE qty_on_hand = VALUES(qty_on_hand)`,
        [line.item_id, line.location_id, line.new_qty]
      );
    }
    await conn.query(
      "UPDATE inventory_adjustments SET status = 'approved', approved_by_user_id = ?, approved_at = NOW(), updated_at = NOW() WHERE id = ?",
      [req.user.id, req.params.id]
    );
    await logAudit(conn, { adjustmentId: req.params.id, userId: req.user.id, eventType: 'Approved', fieldName: 'status', oldValue: 'pending_approval', newValue: 'approved' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM inventory_adjustments WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id/cancel', requireAuth, requirePermission(ROUTE, 'can_void'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[adj]] = await conn.query('SELECT status, date_created FROM inventory_adjustments WHERE id = ?', [req.params.id]);
    if (adj) await assertPeriodOpen(adj.date_created, 'non_gl', conn);
    if (!adj) { return res.status(404).json({ error: 'Not found' }); }
    if (adj.status !== 'pending_approval') { return res.status(409).json({ error: 'Only a Pending Approval adjustment can be cancelled.' }); }

    await conn.beginTransaction();
    await conn.query("UPDATE inventory_adjustments SET status = 'cancelled', updated_at = NOW() WHERE id = ?", [req.params.id]);
    await logAudit(conn, { adjustmentId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: 'pending_approval', newValue: 'cancelled' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM inventory_adjustments WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
