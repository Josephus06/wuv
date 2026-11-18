const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { collectOpenItems } = require('../lib/arAging');
const { buildApAgingSupplierDetails } = require('../lib/apAging');

// Accounting > Statement of Account (asked 2026-10-08, as live has it): one customer's -- or one
// vendor's -- open documents as of a date, with a running Balance Due and the aging summary.
//
// Built from the same open items as AR Aging / AP Aging (lib/arAging.js, lib/apAging.js), so the
// statement and the aging reports can never disagree about what is owed: invoices / bills less
// what has settled them by the statement date, and open credits or unapplied payments as negative
// lines. Aging is by due date (documents without one by their own date) -- Current is not yet due.
const router = express.Router();
const ROUTE = '/statement-of-accounts';

const round2 = (n) => Math.round(Number((Number(n) * 100).toFixed(6))) / 100;
const daysBetween = (from, to) => Math.round(
  (new Date(`${String(to).slice(0, 10)}T00:00:00Z`) - new Date(`${String(from).slice(0, 10)}T00:00:00Z`)) / 86400000);
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// The Account picker: customers or vendors matching the search, a page at a time.
router.get('/parties', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const type = req.query.type === 'vendor' ? 'vendor' : 'customer';
    const q = String(req.query.search || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = 15;
    const table = type === 'vendor' ? 'suppliers' : 'customers';
    const codeCol = type === 'vendor' ? 'supplier_code' : 'customer_code';
    const [cols] = await pool.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [codeCol]);
    const code = cols.length ? codeCol : 'NULL';
    const where = q ? `WHERE name LIKE ?${cols.length ? ` OR ${codeCol} LIKE ?` : ''}` : '';
    const params = q ? (cols.length ? [`%${q}%`, `%${q}%`] : [`%${q}%`]) : [];
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${table} ${where}`, params);
    const [rows] = await pool.query(
      `SELECT id, name, ${code} AS code FROM ${table} ${where} ORDER BY name LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]);
    res.json({ type, rows, total: Number(total), page, page_size: pageSize });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const type = req.query.type === 'vendor' ? 'vendor' : 'customer';
    const id = Number(req.query.id);
    if (!id) return res.status(400).json({ error: 'Choose an account.' });
    const asOf = isDay(req.query.as_of) ? String(req.query.as_of) : new Date().toISOString().slice(0, 10);

    let party; let items;
    if (type === 'customer') {
      const [[c]] = await pool.query(
        `SELECT id, name, COALESCE(NULLIF(bill_to_address, ''), address) AS address FROM customers WHERE id = ?`, [id]);
      if (!c) return res.status(404).json({ error: 'Customer not found.' });
      party = c;
      items = (await collectOpenItems(asOf, { customerId: id })).map((i) => ({
        type: i.type, id: i.id, date: i.date, document_no: i.reference, bs_no: i.bs_no || null, po_no: i.po_no || null,
        due_date: i.due_date || null, aging_date: i.aging_date || i.due_date || i.date,
        original_amount: Number(i.original_amount || 0), balance: Number(i.balance || 0),
      }));
    } else {
      const details = await buildApAgingSupplierDetails(id, asOf);
      if (!details) return res.status(404).json({ error: 'Vendor not found.' });
      const [[sup]] = await pool.query('SELECT address FROM suppliers WHERE id = ?', [id]);
      party = { id: details.supplier_id, name: details.supplier_name, address: sup?.address || null };
      items = details.items.map((i) => ({
        type: i.type, id: i.id, date: i.date, document_no: i.reference, bs_no: i.ref_no || null,
        due_date: i.due_date || null, aging_date: i.due_date || i.date,
        original_amount: Number(i.original_amount || 0), balance: Number(i.balance || 0),
      }));
    }

    // Terms and the full amount, from the invoice / bill itself. An item carried in from the source's
    // opening balance has no original amount of its own (0) -- its document's gross is the figure.
    const docType = type === 'customer' ? 'Invoice' : 'Vendor Bill';
    const docIds = items.filter((i) => i.type === docType && i.id).map((i) => i.id);
    const termOf = new Map(); const grossOf = new Map();
    if (docIds.length) {
      const [t] = await pool.query(
        `SELECT id, term, gross_amount FROM ${type === 'customer' ? 'sales_invoices' : 'vendor_bills'} WHERE id IN (?)`, [docIds]);
      t.forEach((r) => { termOf.set(Number(r.id), r.term || null); grossOf.set(Number(r.id), Number(r.gross_amount || 0)); });
    }
    for (const i of items) {
      if (i.type === docType && !i.original_amount) i.original_amount = grossOf.get(Number(i.id)) || i.balance;
    }

    items.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.document_no).localeCompare(String(b.document_no)));
    const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, over_90: 0 };
    let running = 0;
    const rows = items.map((i) => {
      const isDoc = i.type === docType;
      const amountDue = round2(i.balance);
      running = round2(running + amountDue);
      const overdue = daysBetween(i.aging_date, asOf);
      if (overdue <= 0) buckets.current += amountDue;
      else if (overdue <= 30) buckets.d1_30 += amountDue;
      else if (overdue <= 60) buckets.d31_60 += amountDue;
      else if (overdue <= 90) buckets.d61_90 += amountDue;
      else buckets.over_90 += amountDue;
      return {
        type: i.type, id: i.id, date: i.date, document_no: i.document_no,
        terms: isDoc ? (termOf.get(Number(i.id)) || null) : null,
        bs_no: i.bs_no,
        po_no: i.po_no || null,
        // An open credit or unapplied payment is not an invoice: only what is still open of it shows,
        // in Amount Due (negative -- it reduces the balance). Its full original size would read as
        // if that much were still owed back.
        invoice_amount: isDoc ? round2(i.original_amount) : null,
        amount_due: amountDue,
        // What has already been paid or credited against the document by the statement date.
        receipt_amount: isDoc && Math.abs(i.original_amount - i.balance) >= 0.005 ? round2(i.original_amount - i.balance) : null,
        balance_due: running,
        days_overdue: Math.max(overdue, 0),
      };
    });
    for (const k of Object.keys(buckets)) buckets[k] = round2(buckets[k]);

    res.json({
      type, as_of: asOf,
      party: { id: party.id, name: party.name, address: party.address || null },
      rows,
      aging: { ...buckets, total: running },
    });
  } catch (err) { next(err); }
});

module.exports = router;
