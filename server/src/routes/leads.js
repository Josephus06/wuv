const express = require('express');
const pool = require('../db');
const { findCustomerByName, duplicateMessage } = require('../lib/customerDuplicates');
const { upperCustomerName } = require('../lib/customerName');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/leads';

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { status, search } = req.query;
    const where = [];
    const params = [];
    if (status) { where.push('l.status = ?'); params.push(status); }
    if (search) {
      where.push('(l.lead_no LIKE ? OR l.company_name LIKE ? OR l.contact_name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT l.*, CONCAT(e.first_name, ' ', e.last_name) AS sales_rep_name, c.name AS converted_customer_name
       FROM leads l
       LEFT JOIN employees e ON e.id = l.sales_rep_id
       LEFT JOIN customers c ON c.id = l.converted_customer_id
       ${whereSql}
       ORDER BY l.id DESC`,
      params
    );

    const [countRows] = await pool.query('SELECT status, COUNT(*) AS count FROM leads GROUP BY status');
    const counts = { new: 0, contacted: 0, qualified: 0, unqualified: 0, converted: 0 };
    countRows.forEach((r) => { if (counts[r.status] !== undefined) counts[r.status] = r.count; });

    res.json({ rows, counts });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[lead]] = await pool.query(
      `SELECT l.*, CONCAT(e.first_name, ' ', e.last_name) AS sales_rep_name, c.name AS converted_customer_name,
              u.display_name AS created_by_name
       FROM leads l
       LEFT JOIN employees e ON e.id = l.sales_rep_id
       LEFT JOIN customers c ON c.id = l.converted_customer_id
       LEFT JOIN users u ON u.id = l.created_by_user_id
       WHERE l.id = ?`,
      [req.params.id]
    );
    if (!lead) return res.status(404).json({ error: 'Not found' });
    res.json(lead);
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const { company_name: companyName, contact_name: contactName, email, phone, source, sales_rep_id: salesRepId, memo } = req.body;
    if (!companyName) return res.status(400).json({ error: 'Company Name is required.' });

    const [result] = await pool.query(
      `INSERT INTO leads (lead_no, company_name, contact_name, email, phone, source, sales_rep_id, memo, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [companyName, contactName || null, email || null, phone || null, source || null, salesRepId || null, memo || null, req.user.id]
    );
    const leadId = result.insertId;
    await pool.query('UPDATE leads SET lead_no = ? WHERE id = ?', [`LEAD-${leadId}`, leadId]);

    const [[row]] = await pool.query('SELECT * FROM leads WHERE id = ?', [leadId]);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const {
      company_name: companyName, contact_name: contactName, email, phone, source,
      status, sales_rep_id: salesRepId, memo,
    } = req.body;
    await pool.query(
      `UPDATE leads SET company_name = ?, contact_name = ?, email = ?, phone = ?, source = ?,
              status = ?, sales_rep_id = ?, memo = ?, updated_at = NOW()
       WHERE id = ?`,
      [companyName, contactName || null, email || null, phone || null, source || null,
        status || 'new', salesRepId || null, memo || null, req.params.id]
    );
    const [[row]] = await pool.query('SELECT * FROM leads WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// Converting a Lead creates a real Customer from its company/contact info -- the point
// where a prospect graduates into an actual customer master record (customers.js's own
// FIELDS list, server/src/routes/customers.js:8-11). Idempotent-safe: refuses to
// convert a lead that's already converted rather than silently creating a duplicate
// Customer.
router.post('/:id/convert', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[lead]] = await conn.query('SELECT * FROM leads WHERE id = ?', [req.params.id]);
    if (!lead) return res.status(404).json({ error: 'Not found' });
    if (lead.status === 'converted') return res.status(409).json({ error: 'This lead has already been converted.' });
    const dup = await findCustomerByName(conn, lead.contact_name || lead.company_name);
    if (dup) return res.status(409).json({ error: duplicateMessage(dup), existing_customer_id: dup.id });

    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO customers (customer_code, name, company_name, default_sales_rep_id, is_active)
       VALUES (?, ?, ?, ?, TRUE)`,
      [null, upperCustomerName(lead.contact_name || lead.company_name), upperCustomerName(lead.company_name), null]
    );
    const customerId = result.insertId;
    await conn.query('UPDATE customers SET customer_code = ? WHERE id = ?', [`CUST-${customerId}`, customerId]);

    if (lead.contact_name || lead.email || lead.phone) {
      await conn.query(
        `INSERT INTO customer_contacts (customer_id, contact_name, email, phone, is_primary)
         VALUES (?, ?, ?, ?, TRUE)`,
        [customerId, lead.contact_name || lead.company_name, lead.email || null, lead.phone || null]
      );
    }

    await conn.query(
      "UPDATE leads SET status = 'converted', converted_customer_id = ?, converted_at = NOW() WHERE id = ?",
      [customerId, req.params.id]
    );
    await conn.commit();

    const [[customer]] = await pool.query('SELECT * FROM customers WHERE id = ?', [customerId]);
    res.json(customer);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
