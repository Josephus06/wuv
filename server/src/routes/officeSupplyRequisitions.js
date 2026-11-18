const express = require('express');
const pool = require('../db');
const { assignDocNo } = require('../lib/docNumber');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { isNonStockItem } = require('../lib/itemTypes');
const { assertPeriodOpen } = require('../lib/accountingPeriod');
const { deriveOnHand } = require('../lib/stockLedger');
const { headerDepartmentError } = require('../lib/requireDepartment');

const router = express.Router();
// Office Supply Requisition (OSR-####): a transfer-order-like withdrawal restricted to items flagged
// is_office_supply. Request items + qty from a location (status "open"), then Fulfill to serve those
// qtys and draw them down from that location's on-hand stock. One location, no separate
// fulfillment/receipt documents (simpler than a Transfer Order).
const ROUTE = '/office-supply-requisitions';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (v) => Number(num(v).toFixed(2));
const trunc = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));

async function logAudit(conn, { osrId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('OfficeSupplyRequisition', ?, ?, ?, ?, ?, ?)`,
    [osrId, eventType, fieldName, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), userId]
  );
}

function computeStatus(lines) {
  const anyServed = lines.some((l) => num(l.qty_served) > 0);
  const allServed = lines.length > 0 && lines.every((l) => num(l.qty_served) >= num(l.qty));
  if (allServed) return 'served';
  if (anyServed) return 'partially_served';
  return 'open';
}

// Lookups for the create/edit form. Items are ONLY those flagged is_office_supply -- that flag is
// the whole point of this module (you can only requisition office-supply inventory here).
router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [items] = await pool.query(
      `SELECT i.id, i.item_code, i.display_name, i.item_type, u.code AS base_unit, i.category_id
       FROM inventories i LEFT JOIN units_of_measure u ON u.id = i.base_unit_id
       WHERE i.is_office_supply = 1 ORDER BY i.display_name`
    );
    const [locations] = await pool.query('SELECT id, location_name FROM locations ORDER BY location_name');
    // department_id rides along so the form can default Department from the Requestor.
    const [employees] = await pool.query("SELECT id, CONCAT(first_name, ' ', last_name) AS name, department_id FROM employees WHERE is_active = TRUE ORDER BY first_name, last_name");
    const [departments] = await pool.query('SELECT id, name FROM departments WHERE is_active = TRUE ORDER BY name');
    // Requestor defaults to the logged-in user's own employee, Department to that employee's.
    const [[me]] = await pool.query(
      'SELECT u.employee_id, e.department_id FROM users u LEFT JOIN employees e ON e.id = u.employee_id WHERE u.id = ?',
      [req.user.id]
    );
    // Office supplies are issued from Warehouse - Central, so a new requisition withdraws from it
    // unless changed, and the item picker shows what Warehouse - Central holds of each item.
    // Matched by name (ids differ between installs); prefix-matched as the importers do.
    const [[central]] = await pool.query("SELECT id FROM locations WHERE location_name LIKE 'Warehouse - Central%' ORDER BY id LIMIT 1");
    if (central && items.length) {
      // From the stock ledger, not inventory_locations: that snapshot holds nothing for office
      // supplies at Warehouse - Central on production, where the ledger shows 287 items in stock.
      const onHand = await deriveOnHand(pool, items.map((i) => i.id));
      for (const i of items) i.central_on_hand = Number((onHand.get(`${i.id}|${central.id}`) || 0).toFixed(4));
    }
    res.json({
      items, locations, employees, departments,
      defaults: { requestor_id: me?.employee_id || null, department_id: me?.department_id || null, withdraw_from_location_id: central?.id || null },
    });
  } catch (err) { next(err); }
});

// On-hand for one item at a location -- powers the form's "On Hand" readout as items are picked.
router.get('/on-hand', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { item_id: itemId, location_id: locationId } = req.query;
    if (!itemId || !locationId) return res.json({ qty_on_hand: 0 });
    // The stock ledger's balance -- the same figure the item picker, the Bin Card and the Inventory
    // Item page show -- rather than the inventory_locations snapshot, which is empty for these.
    const onHand = await deriveOnHand(pool, [Number(itemId)]);
    res.json({ qty_on_hand: Number((onHand.get(`${itemId}|${locationId}`) || 0).toFixed(4)) });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, status, as_of: asOf } = req.query;
    const where = [];
    const params = [];
    if (status) { where.push('o.status = ?'); params.push(status); }
    if (asOf) { where.push('o.date_created <= ?'); params.push(asOf); }
    if (search) {
      where.push('(o.osr_no LIKE ? OR o.memo LIKE ? OR loc.location_name LIKE ? OR tloc.location_name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // Transfer To is the receiving department, as the source's OSR list shows it. (Requisitions
    // saved before Department became required on the form have no department_id, so the list
    // does not lean on it.)
    const [rows] = await pool.query(
      `SELECT o.id, o.osr_no, o.date_created, o.date_needed, o.status, o.memo,
              loc.location_name, tloc.location_name AS transfer_to_location_name,
              CONCAT(e.first_name, ' ', e.last_name) AS requestor_name, d.name AS department_name
       FROM office_supply_requisitions o
       LEFT JOIN locations loc ON loc.id = o.location_id
       LEFT JOIN locations tloc ON tloc.id = o.transfer_to_location_id
       LEFT JOIN employees e ON e.id = o.requestor_id
       LEFT JOIN departments d ON d.id = o.department_id
       ${whereSql} ORDER BY o.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// On hand at the Withdraw From warehouse, from the stock ledger -- the figure the form's picker,
// the Bin Card and the item page show. It read the inventory_locations snapshot, which holds
// nothing for office supplies, so every line showed a blank Qty on Hand.
async function onHandAt(db, itemIds, locationId) {
  const out = new Map();
  if (!locationId || !itemIds.length) return out;
  const byPair = await deriveOnHand(db, itemIds);
  for (const id of itemIds) out.set(Number(id), Number((byPair.get(`${id}|${locationId}`) || 0).toFixed(4)));
  return out;
}

async function loadLines(osrId, locationId) {
  const [lines] = await pool.query(
    `SELECT l.*, i.item_code, i.display_name AS item_name, i.item_type
     FROM office_supply_requisition_lines l
     LEFT JOIN inventories i ON i.id = l.item_id
     WHERE l.osr_id = ? ORDER BY l.line_no`,
    [osrId]
  );
  const onHand = await onHandAt(pool, lines.filter((l) => l.item_id && !isNonStockItem(l.item_type)).map((l) => l.item_id), locationId);
  for (const l of lines) l.on_hand = onHand.has(Number(l.item_id)) ? onHand.get(Number(l.item_id)) : null;
  return lines;
}

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[o]] = await pool.query(
      `SELECT o.*, loc.location_name, tloc.location_name AS transfer_to_location_name,
              CONCAT(e.first_name, ' ', e.last_name) AS requestor_name, d.name AS department_name,
              CONCAT(fb.display_name) AS fulfilled_by_name
       FROM office_supply_requisitions o
       LEFT JOIN locations loc ON loc.id = o.location_id
       LEFT JOIN locations tloc ON tloc.id = o.transfer_to_location_id
       LEFT JOIN employees e ON e.id = o.requestor_id
       LEFT JOIN departments d ON d.id = o.department_id
       LEFT JOIN users fb ON fb.id = o.fulfilled_by_user_id
       WHERE o.id = ?`,
      [req.params.id]
    );
    if (!o) return res.status(404).json({ error: 'Not found' });
    const lines = await loadLines(o.id, o.location_id);
    const [fulfillments] = await pool.query(
      'SELECT id, osrf_no, date_created, total_amount, status FROM osr_fulfillments WHERE osr_id = ? ORDER BY id DESC',
      [o.id]
    );
    res.json({ ...o, lines, fulfillments });
  } catch (err) { next(err); }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'OfficeSupplyRequisition' AND a.auditable_id = ? ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Only office-supply items may be requisitioned -- reject any line whose item isn't flagged, so the
// restriction holds even if the client sends something the picker wouldn't have offered.
async function assertOfficeSupplyItems(conn, lines) {
  const ids = [...new Set(lines.map((l) => l.item_id).filter(Boolean))];
  if (!ids.length) return true;
  const [rows] = await conn.query('SELECT id FROM inventories WHERE id IN (?) AND is_office_supply = 1', [ids]);
  return rows.length === ids.length;
}

async function writeLines(conn, osrId, lines) {
  await conn.query('DELETE FROM office_supply_requisition_lines WHERE osr_id = ?', [osrId]);
  let lineNo = 0;
  for (const l of (Array.isArray(lines) ? lines : [])) {
    if (!l.item_id) continue;
    lineNo += 1;
    await conn.query(
      `INSERT INTO office_supply_requisition_lines (osr_id, line_no, item_id, location_id, qty, qty_served, uom, unit, category, remarks)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [osrId, lineNo, l.item_id, l.location_id || null, num(l.qty), num(l.qty_served), trunc(l.uom, 50), trunc(l.unit, 50), trunc(l.category, 100), trunc(l.remarks, 500)]
    );
  }
}

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { date_created: dateCreated, date_needed: dateNeeded, location_id: locationId, transfer_to_location_id: transferToId, requestor_id: requestorId, department_id: departmentId, memo, lines } = req.body;
    if (!(await assertOfficeSupplyItems(conn, lines || []))) return res.status(400).json({ error: 'Only office-supply items can be requisitioned here.' });
    const deptError = headerDepartmentError(departmentId);
    if (deptError) return res.status(400).json({ error: deptError });
    await assertPeriodOpen(dateCreated, 'non_gl', conn);
    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO office_supply_requisitions (osr_no, date_created, date_needed, location_id, transfer_to_location_id, requestor_id, department_id, memo, status, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      [dateCreated || new Date().toISOString().slice(0, 10), dateNeeded || null, locationId || null, transferToId || null, requestorId || null, departmentId || null, trunc(memo, 1000), req.user.id]
    );
    const osrId = r.insertId;
    const osrNo = await assignDocNo(conn, { table: 'office_supply_requisitions', column: 'osr_no', prefix: 'OSR-', id: osrId });
    await writeLines(conn, osrId, lines);
    await logAudit(conn, { osrId, userId: req.user.id, eventType: 'Created', fieldName: 'osr_no', newValue: osrNo });
    await conn.commit();
    res.status(201).json({ id: osrId, osr_no: osrNo });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[o]] = await conn.query('SELECT status, date_created FROM office_supply_requisitions WHERE id = ?', [req.params.id]);
    if (!o) return res.status(404).json({ error: 'Not found' });
    if (o.status === 'served' || o.status === 'cancelled') return res.status(409).json({ error: 'This requisition can no longer be edited.' });
    const { date_created: dateCreated, date_needed: dateNeeded, location_id: locationId, transfer_to_location_id: transferToId, requestor_id: requestorId, department_id: departmentId, memo, lines } = req.body;
    if (!(await assertOfficeSupplyItems(conn, lines || []))) return res.status(400).json({ error: 'Only office-supply items can be requisitioned here.' });
    const deptError = headerDepartmentError(departmentId);
    if (deptError) return res.status(400).json({ error: deptError });
    await assertPeriodOpen([o.date_created, dateCreated], 'non_gl', conn);
    await conn.beginTransaction();
    await conn.query(
      'UPDATE office_supply_requisitions SET date_created = ?, date_needed = ?, location_id = ?, transfer_to_location_id = ?, requestor_id = ?, department_id = ?, memo = ?, updated_at = NOW() WHERE id = ?',
      [dateCreated || o.date_created, dateNeeded || null, locationId || null, transferToId || null, requestorId || null, departmentId || null, trunc(memo, 1000), req.params.id]
    );
    if (Array.isArray(lines)) await writeLines(conn, req.params.id, lines);
    await logAudit(conn, { osrId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'header' });
    await conn.commit();
    res.json({ ok: true });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// Fulfill: serve the requested qtys and draw them down from the requisition location's on-hand. Body
// lines carry qty_to_serve per requisition line. Rejects serving more than the remaining balance or
// more than what's physically on hand (service/non-stock items move no stock, matching TO).
router.post('/:id/fulfill', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[o]] = await conn.query('SELECT * FROM office_supply_requisitions WHERE id = ?', [req.params.id]);
    if (!o) return res.status(404).json({ error: 'Not found' });
    if (o.status === 'served' || o.status === 'cancelled') return res.status(409).json({ error: 'This requisition has nothing left to fulfill.' });

    const submitted = (Array.isArray(req.body?.lines) ? req.body.lines : []).filter((l) => num(l.qty_to_serve) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Enter a Qty to Serve for at least one item.' });
    // Fulfilling deducts on-hand stock and posts DR 30504 / CR 15400.
    await assertPeriodOpen([o.date_created, req.body?.date_created], 'non_gl', conn);

    const [lines] = await conn.query(
      `SELECT l.*, i.item_code, i.item_type, i.average_cost, i.material_cost, i.last_purchase_price
       FROM office_supply_requisition_lines l LEFT JOIN inventories i ON i.id = l.item_id WHERE l.osr_id = ?`,
      [req.params.id]
    );
    const byId = new Map(lines.map((l) => [l.id, l]));
    // Checked against the stock ledger, the same Qty on Hand the screen shows. It read the empty
    // inventory_locations snapshot, so every fulfillment was refused as exceeding 0 on hand.
    const onHand = await onHandAt(conn, lines.filter((l) => l.item_id && !isNonStockItem(l.item_type)).map((l) => l.item_id), o.location_id);

    for (const s of submitted) {
      const line = byId.get(Number(s.line_id));
      if (!line) return res.status(400).json({ error: 'Unknown line.' });
      const remaining = num(line.qty) - num(line.qty_served);
      const serve = num(s.qty_to_serve);
      if (serve > remaining) return res.status(409).json({ error: `Qty to Serve for ${line.item_code} exceeds the remaining balance (${remaining}).` });
      if (isNonStockItem(line.item_type)) continue;
      const available = num(onHand.get(Number(line.item_id)));
      if (serve > available) return res.status(409).json({ error: `Qty to Serve for ${line.item_code} exceeds what's on hand at this location (${available}).` });
    }

    await conn.beginTransaction();
    // The fulfillment is its own document (OSRF-####): it moves the stock and, via glImpact, posts
    // DR 30504 / CR 15400 for the value withdrawn. Fulfilling completes/serves the OSR.
    const [fr] = await conn.query(
      `INSERT INTO osr_fulfillments (osrf_no, osr_id, date_created, withdraw_from_location_id, transfer_to_location_id, requestor_id, memo, total_amount, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, 0, ?)`,
      [o.id, req.body.date_created || new Date().toISOString().slice(0, 10), o.location_id, o.transfer_to_location_id, o.requestor_id, trunc(req.body.memo || o.memo, 1000), req.user.id]
    );
    const osrfId = fr.insertId;
    const osrfNo = await assignDocNo(conn, { table: 'osr_fulfillments', column: 'osrf_no', prefix: 'OSRF-', id: osrfId });

    let totalAmount = 0;
    for (const s of submitted) {
      const line = byId.get(Number(s.line_id));
      const serve = num(s.qty_to_serve);
      // Move stock like a Transfer Order: draw down the Withdraw-From location and add the same qty
      // to the Transfer-To location (upsert its row). Service/non-stock items move no stock.
      if (!isNonStockItem(line.item_type)) {
        await conn.query('UPDATE inventory_locations SET qty_on_hand = qty_on_hand - ? WHERE inventory_id = ? AND location_id = ?', [serve, line.item_id, o.location_id]);
        if (o.transfer_to_location_id) {
          await conn.query(
            `INSERT INTO inventory_locations (inventory_id, location_id, qty_on_hand) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE qty_on_hand = qty_on_hand + VALUES(qty_on_hand)`,
            [line.item_id, o.transfer_to_location_id, serve]
          );
        }
      }
      await conn.query('UPDATE office_supply_requisition_lines SET qty_served = qty_served + ? WHERE id = ?', [serve, line.id]);

      // Snapshot the item's cost so the fulfillment's GL value is stable even if cost later changes.
      const cost = num(line.average_cost) || num(line.material_cost) || num(line.last_purchase_price) || 0;
      const amount = round2(serve * cost);
      totalAmount += amount;
      await conn.query(
        `INSERT INTO osr_fulfillment_lines (osrf_id, osr_line_id, item_id, requested_qty, fulfilled_qty, uom, unit, cost, amount)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [osrfId, line.id, line.item_id, num(line.qty), serve, trunc(line.uom, 50), trunc(line.unit, 50), cost, amount]
      );
    }
    await conn.query('UPDATE osr_fulfillments SET total_amount = ? WHERE id = ?', [round2(totalAmount), osrfId]);

    const [fresh] = await conn.query('SELECT qty, qty_served FROM office_supply_requisition_lines WHERE osr_id = ?', [req.params.id]);
    const newStatus = computeStatus(fresh);
    await conn.query(
      'UPDATE office_supply_requisitions SET status = ?, fulfilled_by_user_id = ?, fulfilled_at = NOW(), updated_at = NOW() WHERE id = ?',
      [newStatus, req.user.id, req.params.id]
    );
    await logAudit(conn, { osrId: req.params.id, userId: req.user.id, eventType: 'Status Change', fieldName: 'status', newValue: newStatus });
    await conn.commit();
    res.json({ ok: true, status: newStatus, osrf_id: osrfId, osrf_no: osrfNo });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.put('/:id/cancel', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[o]] = await conn.query('SELECT status, date_created FROM office_supply_requisitions WHERE id = ?', [req.params.id]);
    if (!o) return res.status(404).json({ error: 'Not found' });
    if (o.status === 'cancelled') return res.status(409).json({ error: 'Already cancelled.' });
    await assertPeriodOpen(o.date_created, 'non_gl', conn);
    await conn.beginTransaction();
    await conn.query("UPDATE office_supply_requisitions SET status = 'cancelled', cancelled_at = NOW() WHERE id = ?", [req.params.id]);
    await logAudit(conn, { osrId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: o.status, newValue: 'cancelled' });
    await conn.commit();
    res.json({ ok: true });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// ---- OSR Fulfillment (OSRF-####) document view (reuses this module's permission scope) ----
router.get('/fulfillments/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[f]] = await pool.query(
      `SELECT f.*, o.osr_no AS created_from_osr_no, wl.location_name AS withdraw_from_name, tl.location_name AS transfer_to_name,
              CONCAT(e.first_name, ' ', e.last_name) AS requestor_name
       FROM osr_fulfillments f
       LEFT JOIN office_supply_requisitions o ON o.id = f.osr_id
       LEFT JOIN locations wl ON wl.id = f.withdraw_from_location_id
       LEFT JOIN locations tl ON tl.id = f.transfer_to_location_id
       LEFT JOIN employees e ON e.id = f.requestor_id
       WHERE f.id = ?`,
      [req.params.id]
    );
    if (!f) return res.status(404).json({ error: 'Not found' });
    const [lines] = await pool.query(
      `SELECT fl.*, i.item_code, i.display_name AS item_name, i.item_type
       FROM osr_fulfillment_lines fl LEFT JOIN inventories i ON i.id = fl.item_id
       WHERE fl.osrf_id = ? ORDER BY fl.id`,
      [req.params.id]
    );
    const onHand = await onHandAt(pool, lines.filter((l) => l.item_id && !isNonStockItem(l.item_type)).map((l) => l.item_id),
      f.transfer_to_location_id || f.withdraw_from_location_id);
    for (const l of lines) l.on_hand = onHand.has(Number(l.item_id)) ? onHand.get(Number(l.item_id)) : null;
    // GL Impact: DR 30504 Materials, Tools & Supplies / CR 15400 Supplies Inventory for the total value.
    const [[dr]] = await pool.query("SELECT account_code, account_name FROM chart_of_accounts WHERE account_code = '30504'");
    const [[cr]] = await pool.query("SELECT account_code, account_name FROM chart_of_accounts WHERE account_code = '15400'");
    const total = round2(f.total_amount);
    const gl = total > 0 ? [
      { account_code: dr?.account_code || '30504', account_name: dr?.account_name || 'Materials, Tools & Supplies', debit: total, credit: 0 },
      { account_code: cr?.account_code || '15400', account_name: cr?.account_name || 'Supplies Inventory', debit: 0, credit: total },
    ] : [];
    res.json({ ...f, lines, gl });
  } catch (err) { next(err); }
});

module.exports = router;
