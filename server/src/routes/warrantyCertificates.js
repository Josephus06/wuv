const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, isSystemAdmin } = require('../middleware/auth');

const { insertFor } = require('../lib/approvalNotifications');

const router = express.Router();

// The bell (2026-11-12): a new certificate tells the approvers -- the General Managers, as
// mayApprove() below defines them -- and an approval tells whoever made it. After the commit, and a
// failure is only logged: a notification must never block or undo the certificate.
async function approverIds() {
  const [rows] = await pool.query(
    `SELECT id FROM users WHERE is_active = 1
        AND (account_type = 'General Manager' OR id IN (SELECT user_id FROM general_managers))`);
  return rows.map((r) => r.id);
}
async function notifyWc(kind, wcId, actorId) {
  try {
    const [[wc]] = await pool.query(
      `SELECT wc.wc_no, wc.created_by_user_id, so.sales_order_no AS so_no, c.name AS customer_name
         FROM warranty_certificates wc
         LEFT JOIN sales_orders so ON so.id = wc.sales_order_id
         LEFT JOIN customers c ON c.id = wc.customer_id
        WHERE wc.id = ?`, [wcId]);
    if (!wc) return;
    const about = [wc.so_no, wc.customer_name].filter(Boolean).join(', ');
    if (kind === 'pending') {
      await insertFor(await approverIds(), {
        type: 'wc_pending_approval', title: `${wc.wc_no} needs your approval`,
        message: `Warranty Certificate ${wc.wc_no}${about ? ` (${about})` : ''} is pending approval.`,
        relatedType: 'WarrantyCertificate', relatedId: wcId,
      }, actorId);
    } else {
      await insertFor([wc.created_by_user_id], {
        type: 'wc_approved', title: `${wc.wc_no} was approved`,
        message: `Warranty Certificate ${wc.wc_no}${about ? ` (${about})` : ''} has been approved.`,
        relatedType: 'WarrantyCertificate', relatedId: wcId,
      }, actorId);
    }
  } catch (err) { console.error('[notifications] warranty certificate:', err.message); }
}
// Warranty Certificate (WC-##): raised against a BILLED Sales Order. Pulls the SO's job orders in as
// warranty lines (coverage type + warranty date range + optional extended warranty). Pending
// Approval -> Approved (only then can it be Printed) -> Void.
const ROUTE = '/warranty-certificates';

const trunc = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));
const day = (v) => (v ? String(v).slice(0, 10) : null);

async function logAudit(conn, { wcId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('WarrantyCertificate', ?, ?, ?, ?, ?, ?)`,
    [wcId, eventType, fieldName, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), userId]
  );
}

// Billed Sales Orders only -- a warranty certificate can only be raised once the order is billed.
router.get('/billable-sales-orders', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const search = req.query.search ? `%${req.query.search}%` : null;
    const where = ["so.status = 'billed'"];
    const params = [];
    if (search) { where.push('(so.sales_order_no LIKE ? OR c.name LIKE ?)'); params.push(search, search); }
    const [rows] = await pool.query(
      `SELECT so.id, so.sales_order_no, so.date_created, so.contract_description, c.name AS customer_name, so.customer_id
       FROM sales_orders so LEFT JOIN customers c ON c.id = so.customer_id
       WHERE ${where.join(' AND ')} ORDER BY so.id DESC LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// The details a certificate pulls from a chosen (billed) Sales Order: header info + its job orders.
router.get('/source-sales-order/:soId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[so]] = await pool.query(
      `SELECT so.id, so.sales_order_no, so.date_created, so.customer_id, so.contact_person_id, so.contact_phone,
              so.contract_description, so.shipping_address,
              c.name AS customer_name, cc.contact_name,
              (SELECT address_line FROM customer_addresses a WHERE a.customer_id = so.customer_id ORDER BY a.is_default DESC, a.id LIMIT 1) AS address,
              (SELECT phone FROM customer_contacts x WHERE x.id = so.contact_person_id) AS contact_number
       FROM sales_orders so
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN customer_contacts cc ON cc.id = so.contact_person_id
       WHERE so.id = ?`,
      [req.params.soId]
    );
    if (!so) return res.status(404).json({ error: 'Sales Order not found' });
    const [jobOrders] = await pool.query(
      `SELECT jo.id AS job_order_id, jo.job_order_no, jo.description AS job_description, jt.display_name AS coverage
       FROM job_orders jo LEFT JOIN job_types jt ON jt.id = jo.job_type_id
       WHERE jo.sales_order_id = ? ORDER BY jo.job_order_no`,
      [req.params.soId]
    );
    res.json({ sales_order: so, job_orders: jobOrders });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, status } = req.query;
    const where = [];
    const params = [];
    if (status) { where.push('wc.status = ?'); params.push(status); }
    if (search) { where.push('(wc.wc_no LIKE ? OR c.name LIKE ? OR so.sales_order_no LIKE ? OR wc.contract_description LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT wc.id, wc.wc_no, wc.date_created, wc.status, wc.contract_description,
              wc.customer_id, c.name AS customer_name, so.sales_order_no
       FROM warranty_certificates wc
       LEFT JOIN customers c ON c.id = wc.customer_id
       LEFT JOIN sales_orders so ON so.id = wc.sales_order_id
       ${whereSql} ORDER BY wc.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[wc]] = await pool.query(
      `SELECT wc.*, c.name AS customer_name, so.sales_order_no, so.date_created AS sales_order_date,
              CONCAT(ab.first_name, ' ', ab.last_name) AS approved_by_name
       FROM warranty_certificates wc
       LEFT JOIN customers c ON c.id = wc.customer_id
       LEFT JOIN sales_orders so ON so.id = wc.sales_order_id
       LEFT JOIN users au ON au.id = wc.approved_by_user_id
       LEFT JOIN employees ab ON ab.id = au.employee_id
       WHERE wc.id = ?`,
      [req.params.id]
    );
    if (!wc) return res.status(404).json({ error: 'Not found' });
    const [lines] = await pool.query('SELECT * FROM warranty_certificate_lines WHERE wc_id = ? ORDER BY line_no', [req.params.id]);
    res.json({ ...wc, lines });
  } catch (err) { next(err); }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'WarrantyCertificate' AND a.auditable_id = ? ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

async function writeLines(conn, wcId, lines) {
  await conn.query('DELETE FROM warranty_certificate_lines WHERE wc_id = ?', [wcId]);
  let lineNo = 0;
  for (const l of (Array.isArray(lines) ? lines : [])) {
    lineNo += 1;
    await conn.query(
      `INSERT INTO warranty_certificate_lines
         (wc_id, line_no, job_order_id, job_order_no, job_description, coverage, warranty_date_from, warranty_date_to, remarks, ext_warranty_date_from, ext_warranty_date_to, ext_remarks)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [wcId, lineNo, l.job_order_id || null, trunc(l.job_order_no, 50), trunc(l.job_description, 500), trunc(l.coverage, 255),
       day(l.warranty_date_from), day(l.warranty_date_to), trunc(l.remarks, 500), day(l.ext_warranty_date_from), day(l.ext_warranty_date_to), trunc(l.ext_remarks, 500)]
    );
  }
}

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body;
    if (!b.sales_order_id) return res.status(400).json({ error: 'Select the (billed) Sales Order this warranty covers.' });
    const [[so]] = await conn.query('SELECT status FROM sales_orders WHERE id = ?', [b.sales_order_id]);
    if (!so) return res.status(400).json({ error: 'Sales Order not found.' });
    if (so.status !== 'billed') return res.status(409).json({ error: 'A warranty certificate can only be created for a billed Sales Order.' });

    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO warranty_certificates
         (wc_no, date_created, sales_order_id, customer_id, contact_person_id, contact_name, contact_number, address, contract_description, status, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?)`,
      [day(b.date_created) || new Date().toISOString().slice(0, 10), b.sales_order_id, b.customer_id || null, b.contact_person_id || null,
       trunc(b.contact_name, 255), trunc(b.contact_number, 100), trunc(b.address, 500), trunc(b.contract_description, 500), req.user.id]
    );
    const wcId = r.insertId;
    const wcNo = `WC-${wcId}`;
    await conn.query('UPDATE warranty_certificates SET wc_no = ? WHERE id = ?', [wcNo, wcId]);
    await writeLines(conn, wcId, b.lines);
    await logAudit(conn, { wcId, userId: req.user.id, eventType: 'Created', fieldName: 'wc_no', newValue: wcNo });
    await conn.commit();
    res.status(201).json({ id: wcId, wc_no: wcNo });
    notifyWc('pending', wcId, req.user.id);
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[wc]] = await conn.query('SELECT status FROM warranty_certificates WHERE id = ?', [req.params.id]);
    if (!wc) return res.status(404).json({ error: 'Not found' });
    if (wc.status === 'voided') return res.status(409).json({ error: 'A voided certificate cannot be edited.' });
    const b = req.body;
    await conn.beginTransaction();
    await conn.query(
      `UPDATE warranty_certificates SET date_created = ?, contact_name = ?, contact_number = ?, address = ?, contract_description = ?, updated_at = NOW() WHERE id = ?`,
      [day(b.date_created), trunc(b.contact_name, 255), trunc(b.contact_number, 100), trunc(b.address, 500), trunc(b.contract_description, 500), req.params.id]
    );
    if (Array.isArray(b.lines)) await writeLines(conn, req.params.id, b.lines);
    await logAudit(conn, { wcId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'certificate' });
    await conn.commit();
    res.json({ ok: true });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// Approved by a General Manager (2026-10-28) -- one on the General Managers list or with that
// account type -- or a System Admin.
async function mayApprove(userId) {
  if (await isSystemAdmin(userId)) return true;
  const [[row]] = await pool.query(
    `SELECT 1 AS x FROM users u WHERE u.id = ? AND u.is_active = 1
        AND (u.account_type = 'General Manager' OR u.id IN (SELECT user_id FROM general_managers))`, [userId]);
  return !!row;
}

router.put('/:id/approve', requireAuth, async (req, res, next) => {
  if (!(await mayApprove(req.user.id).catch(() => false))) {
    return res.status(403).json({ error: 'Only a General Manager can approve a Warranty Certificate.' });
  }
  const conn = await pool.getConnection();
  try {
    const [[wc]] = await conn.query('SELECT status FROM warranty_certificates WHERE id = ?', [req.params.id]);
    if (!wc) return res.status(404).json({ error: 'Not found' });
    if (wc.status === 'voided') return res.status(409).json({ error: 'This certificate is voided.' });
    if (wc.status === 'approved') return res.status(409).json({ error: 'Already approved.' });
    await conn.beginTransaction();
    await conn.query("UPDATE warranty_certificates SET status = 'approved', approved_at = NOW(), approved_by_user_id = ? WHERE id = ?", [req.user.id, req.params.id]);
    await logAudit(conn, { wcId: req.params.id, userId: req.user.id, eventType: 'Approved', fieldName: 'status', oldValue: wc.status, newValue: 'approved' });
    await conn.commit();
    res.json({ ok: true });
    notifyWc('approved', Number(req.params.id), req.user.id);
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.put('/:id/void', requireAuth, requirePermission(ROUTE, 'can_void'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[wc]] = await conn.query('SELECT status FROM warranty_certificates WHERE id = ?', [req.params.id]);
    if (!wc) return res.status(404).json({ error: 'Not found' });
    if (wc.status === 'voided') return res.status(409).json({ error: 'Already voided.' });
    await conn.beginTransaction();
    await conn.query("UPDATE warranty_certificates SET status = 'voided', voided_at = NOW(), voided_by_user_id = ? WHERE id = ?", [req.user.id, req.params.id]);
    await logAudit(conn, { wcId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: wc.status, newValue: 'voided' });
    await conn.commit();
    res.json({ ok: true });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

module.exports = router;
