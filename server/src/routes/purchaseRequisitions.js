const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { assignDocNo } = require('../lib/docNumber');
const { headerDepartmentError } = require('../lib/requireDepartment');

const router = express.Router();
const ROUTE = '/purchase-requisitions';

async function logAudit(conn, { prId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('PurchaseRequisition', ?, ?, ?, ?, ?, ?)`,
    [prId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// A PR line's own progress, mirroring the real "Item Status" column -- OPEN until a
// Purchase Order picks it up, FULLY ORDERED once po_qty catches the full requested qty,
// FULLY RECEIVED once received_qty does too. No Purchase Order module exists in this
// build yet, so every line starts (and stays) OPEN until that's built.
function lineItemStatus(l) {
  const qty = Number(l.qty || 0);
  const poQty = Number(l.po_qty || 0);
  const receivedQty = Number(l.received_qty || 0);
  if (qty > 0 && receivedQty >= qty) return 'FULLY RECEIVED';
  if (qty > 0 && poQty >= qty) return 'FULLY ORDERED';
  return 'OPEN';
}
function aggregateItemStatus(lines) {
  if (!lines.length) return 'OPEN';
  const statuses = lines.map(lineItemStatus);
  if (statuses.every((s) => s === 'FULLY RECEIVED')) return 'FULLY RECEIVED';
  if (statuses.every((s) => s === 'FULLY ORDERED' || s === 'FULLY RECEIVED')) return 'FULLY ORDERED';
  return 'OPEN';
}

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, department_id: departmentId, status } = req.query;
    const where = [];
    const params = [];
    if (departmentId) { where.push('pr.department_id = ?'); params.push(departmentId); }
    if (status) { where.push('pr.status = ?'); params.push(status); }
    if (search) { where.push('pr.pr_no LIKE ?'); params.push(`%${search}%`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT pr.id, pr.pr_no, pr.date_created, pr.status, pr.memo,
              d.name AS department_name,
              CONCAT(e.first_name, ' ', e.last_name) AS requestor_name,
              u.display_name AS prepared_by_name
       FROM purchase_requisitions pr
       LEFT JOIN departments d ON d.id = pr.department_id
       LEFT JOIN employees e ON e.id = pr.requestor_id
       LEFT JOIN users u ON u.id = pr.prepared_by_user_id
       ${whereSql}
       ORDER BY pr.id DESC`,
      params
    );

    // Item Status for every PR from ONE grouped query, by the same rules as lineItemStatus /
    // aggregateItemStatus. It used to run a query per PR -- thousands of round trips, which is
    // what made the Placing Order Form's "Select Purchase Requisitions" take so long (2026-10-03).
    const byPr = new Map();
    if (rows.length) {
      const [agg] = await pool.query(
        `SELECT purchase_requisition_id AS id, COUNT(*) AS n,
                SUM(qty > 0 AND received_qty >= qty) AS rec,
                SUM(qty > 0 AND (received_qty >= qty OR po_qty >= qty)) AS ord
           FROM purchase_requisition_lines GROUP BY purchase_requisition_id`);
      agg.forEach((a) => byPr.set(a.id, a));
    }
    for (const r of rows) {
      const a = byPr.get(r.id);
      const n = Number(a?.n || 0);
      r.item_status = !n ? 'OPEN' : Number(a.rec) === n ? 'FULLY RECEIVED' : Number(a.ord) === n ? 'FULLY ORDERED' : 'OPEN';
    }
    // open_only: what the Placing Order Form can still order from -- not cancelled, not fully ordered.
    res.json(req.query.open_only ? rows.filter((r) => r.status !== 'cancelled' && r.item_status !== 'FULLY ORDERED') : rows);
  } catch (err) {
    next(err);
  }
});

// The Requestor picker's list: names and positions only, for anyone who may use PRs. The form
// used to load /employees, which needs the Employees page -- a PR maker without it (Randill,
// 2026-10-03) got a create page that never finished loading.
router.get('/requestors', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, first_name, last_name, position_title FROM employees ORDER BY first_name, last_name');
    res.json(rows);
  } catch (err) { next(err); }
});

// The JO # picker on a material line (asked 2026-10-14): Job Orders searched on the server -- there
// are hundreds of thousands -- by number, description or customer. Open ones only (not Cancelled),
// newest first, 50 at a time. Under the PR permission, so a PR maker needs no Job Orders access.
router.get('/job-orders', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    // A JO number ("JO-195581", "195581-1") is matched from its start, on the job_order_no index --
    // 4 ms against 1.3 s for a "contains" over every Job Order. Words search description and customer.
    const num = /^(jo-?)?(\d[\d-]*)$/i.exec(q);
    let where = '';
    let params = [];
    if (num) { where = 'AND jo.job_order_no LIKE ?'; params = [`JO-${num[2]}%`]; }
    else if (q) { where = 'AND (jo.job_order_no LIKE ? OR jo.description LIKE ? OR c.name LIKE ?)'; params = [`%${q}%`, `%${q}%`, `%${q}%`]; }
    const [rows] = await pool.query(
      `SELECT jo.id, jo.job_order_no, jo.description, jo.status, c.name AS customer_name
         FROM job_orders jo
         LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
         LEFT JOIN customers c ON c.id = so.customer_id
        WHERE (jo.status IS NULL OR jo.status <> 'Cancelled') ${where}
        ORDER BY jo.id DESC LIMIT 50`, params);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[pr]] = await pool.query(
      `SELECT pr.*, d.name AS department_name,
              CONCAT(e.first_name, ' ', e.last_name) AS requestor_name,
              u.display_name AS prepared_by_name
       FROM purchase_requisitions pr
       LEFT JOIN departments d ON d.id = pr.department_id
       LEFT JOIN employees e ON e.id = pr.requestor_id
       LEFT JOIN users u ON u.id = pr.prepared_by_user_id
       WHERE pr.id = ?`,
      [req.params.id]
    );
    if (!pr) return res.status(404).json({ error: 'Not found' });

    // Qty on Hand is a company-wide figure here (a PR isn't raised against one specific
    // warehouse) -- summed live across every location rather than snapshotted, so it
    // never goes stale the way Transfer Order's line snapshot originally did.
    const [lines] = await pool.query(
      `SELECT prl.*, i.item_code, i.display_name AS item_name, jo.job_order_no,
              COALESCE((SELECT SUM(qty_on_hand) FROM inventory_locations WHERE inventory_id = prl.item_id), 0) AS qty_on_hand
       FROM purchase_requisition_lines prl
       LEFT JOIN inventories i ON i.id = prl.item_id
       LEFT JOIN job_orders jo ON jo.id = prl.job_order_id
       WHERE prl.purchase_requisition_id = ? ORDER BY prl.line_no`,
      [req.params.id]
    );
    lines.forEach((l) => { l.item_status = lineItemStatus(l); });

    res.json({ ...pr, item_status: aggregateItemStatus(lines), lines });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/purchase-orders', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT po.id, po.po_no, po.date_created, po.status, po.total_amount, po.supplier_id, s.name AS supplier_name
       FROM purchase_order_lines pol
       JOIN purchase_orders po ON po.id = pol.purchase_order_id
       JOIN purchase_requisition_lines prl ON prl.id = pol.purchase_requisition_line_id
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       WHERE prl.purchase_requisition_id = ?
       ORDER BY po.id DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'PurchaseRequisition' AND a.auditable_id = ?
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
    const {
      date_created: dateCreated, date_needed: dateNeeded, department_id: departmentId,
      requestor_id: requestorId, memo, lines,
    } = req.body;

    const submitted = (Array.isArray(lines) ? lines : []).filter((l) => l.item_id && Number(l.qty) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Add at least one material with a Qty greater than 0.' });
    const deptError = headerDepartmentError(departmentId);
    if (deptError) return res.status(400).json({ error: deptError });

    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO purchase_requisitions
         (pr_no, date_created, date_needed, department_id, requestor_id, prepared_by_user_id, memo, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?)`,
      [dateCreated || new Date().toISOString().slice(0, 10), dateNeeded || null, departmentId || null, requestorId || null, req.user.id, memo || null, req.user.id]
    );
    const prId = result.insertId;
    // Next free PR-# after the highest in use (the migrated source numbers run to PR-10711), not
    // PR-<row id>: ids are auto-increment in steps across the replicated pair and would collide with
    // a migrated number.
    const prNo = await assignDocNo(conn, { table: 'purchase_requisitions', column: 'pr_no', prefix: 'PR-', id: prId });

    let lineNo = 1;
    for (const l of submitted) {
      await conn.query(
        `INSERT INTO purchase_requisition_lines (purchase_requisition_id, line_no, item_id, purchase_description, job_order_id, qty, purchase_unit, unit_title)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [prId, lineNo++, l.item_id, l.purchase_description || null, l.job_order_id || null, l.qty, l.purchase_unit || null, l.unit_title || null]
      );
    }
    await logAudit(conn, { prId, userId: req.user.id, eventType: 'Created', fieldName: 'pr_no', newValue: prNo });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM purchase_requisitions WHERE id = ?', [prId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Edit (asked 2026-10-31: "add edit in purchase requisition"): any PR that is not cancelled, not just a
// Pending Request -- most PRs are Request In-Process within the day, and were locked from then on.
// Lines are updated IN PLACE by id (purchase_order_lines point at purchase_requisition_lines.id, so the
// old delete-and-reinsert would orphan every PO line). A line a Purchase Order has already taken
// (po_qty > 0) keeps its item, cannot be removed, and its Qty cannot drop below what is on order.
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const {
      date_created: dateCreated, date_needed: dateNeeded, department_id: departmentId,
      requestor_id: requestorId, memo, lines,
    } = req.body;
    const submitted = (Array.isArray(lines) ? lines : []).filter((l) => l.item_id && Number(l.qty) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Add at least one material with a Qty greater than 0.' });
    const deptError = headerDepartmentError(departmentId);
    if (deptError) return res.status(400).json({ error: deptError });

    await conn.beginTransaction();
    const [[pr]] = await conn.query('SELECT * FROM purchase_requisitions WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!pr) { await conn.rollback(); return res.status(404).json({ error: 'Not found' }); }
    if (pr.status === 'cancelled') { await conn.rollback(); return res.status(409).json({ error: 'A cancelled PR cannot be edited.' }); }

    const [existing] = await conn.query(
      `SELECT prl.*, i.item_code FROM purchase_requisition_lines prl LEFT JOIN inventories i ON i.id = prl.item_id
        WHERE prl.purchase_requisition_id = ? FOR UPDATE`, [req.params.id]);
    const byId = new Map(existing.map((l) => [String(l.id), l]));
    const keptIds = new Set();
    for (const [i, l] of submitted.entries()) {
      if (!l.id) continue;
      const old = byId.get(String(l.id));
      if (!old) { await conn.rollback(); return res.status(400).json({ error: `Line ${i + 1} is not on this PR.` }); }
      keptIds.add(String(l.id));
      const ordered = Number(old.po_qty || 0);
      if (ordered > 0 && String(l.item_id) !== String(old.item_id)) {
        await conn.rollback();
        return res.status(409).json({ error: `Line ${i + 1} (${old.item_code}) is already on a Purchase Order -- its item cannot be changed.` });
      }
      if (Number(l.qty) < ordered - 1e-9) {
        await conn.rollback();
        return res.status(409).json({ error: `Line ${i + 1} (${old.item_code}): Qty can be no lower than ${ordered}, already on a Purchase Order.` });
      }
    }
    const removed = existing.filter((l) => !keptIds.has(String(l.id)));
    const blocked = removed.find((l) => Number(l.po_qty || 0) > 0);
    if (blocked) {
      await conn.rollback();
      return res.status(409).json({ error: `${blocked.item_code} is already on a Purchase Order and cannot be removed.` });
    }

    const header = {
      date_created: dateCreated || pr.date_created, date_needed: dateNeeded || null, department_id: departmentId || null,
      requestor_id: requestorId || null, memo: memo || null,
    };
    await conn.query(
      'UPDATE purchase_requisitions SET date_created = ?, date_needed = ?, department_id = ?, requestor_id = ?, memo = ?, updated_at = NOW() WHERE id = ?',
      [header.date_created, header.date_needed, header.department_id, header.requestor_id, header.memo, req.params.id]
    );
    const norm = (v) => (v === null || v === undefined ? '' : String(v));
    for (const [field, value] of Object.entries(header)) {
      const before = field.startsWith('date_') && pr[field] ? String(pr[field]).slice(0, 10) : pr[field];
      if (norm(before) !== norm(value)) {
        await logAudit(conn, { prId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: field, oldValue: before, newValue: value });
      }
    }

    for (const l of removed) {
      await conn.query('DELETE FROM purchase_requisition_lines WHERE id = ?', [l.id]);
      await logAudit(conn, { prId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'line removed', oldValue: `${l.item_code} x ${Number(l.qty)}` });
    }
    let lineNo = 1;
    for (const l of submitted) {
      const vals = [l.item_id, l.purchase_description || null, l.job_order_id || null, l.qty, l.purchase_unit || null, l.unit_title || null];
      const old = l.id ? byId.get(String(l.id)) : null;
      if (old) {
        await conn.query(
          `UPDATE purchase_requisition_lines SET line_no = ?, item_id = ?, purchase_description = ?, job_order_id = ?, qty = ?, purchase_unit = ?, unit_title = ?
            WHERE id = ?`, [lineNo++, ...vals, old.id]);
        if (Number(old.qty) !== Number(l.qty)) {
          await logAudit(conn, { prId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: `qty (${old.item_code})`, oldValue: Number(old.qty), newValue: Number(l.qty) });
        }
        if (String(old.job_order_id || '') !== String(l.job_order_id || '')) {
          await logAudit(conn, { prId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: `job_order_id (${old.item_code})`, oldValue: old.job_order_id, newValue: l.job_order_id || null });
        }
      } else {
        await conn.query(
          `INSERT INTO purchase_requisition_lines (purchase_requisition_id, line_no, item_id, purchase_description, job_order_id, qty, purchase_unit, unit_title)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [req.params.id, lineNo++, ...vals]);
        const [[item]] = await conn.query('SELECT item_code FROM inventories WHERE id = ?', [l.item_id]);
        await logAudit(conn, { prId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'line added', newValue: `${item?.item_code || l.item_id} x ${Number(l.qty)}` });
      }
    }
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM purchase_requisitions WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id/cancel', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[pr]] = await conn.query('SELECT status FROM purchase_requisitions WHERE id = ?', [req.params.id]);
    if (!pr) return res.status(404).json({ error: 'Not found' });
    if (pr.status === 'cancelled') return res.status(409).json({ error: 'This PR is already cancelled.' });

    await conn.beginTransaction();
    await conn.query(
      "UPDATE purchase_requisitions SET status = 'cancelled', cancelled_by_user_id = ?, cancelled_at = NOW() WHERE id = ?",
      [req.user.id, req.params.id]
    );
    await logAudit(conn, { prId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: pr.status, newValue: 'cancelled' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM purchase_requisitions WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[pr]] = await conn.query('SELECT status FROM purchase_requisitions WHERE id = ?', [req.params.id]);
    if (!pr) return res.status(404).json({ error: 'Not found' });
    if (pr.status !== 'pending_request') {
      return res.status(409).json({ error: 'Only a Pending Request PR can be deleted -- cancel it instead.' });
    }

    await conn.beginTransaction();
    await conn.query('DELETE FROM purchase_requisition_lines WHERE purchase_requisition_id = ?', [req.params.id]);
    await conn.query('DELETE FROM purchase_requisitions WHERE id = ?', [req.params.id]);
    await conn.commit();
    res.status(204).send();
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
