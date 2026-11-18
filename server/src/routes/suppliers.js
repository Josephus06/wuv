const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, isSystemAdmin } = require('../middleware/auth');
const { mergeParty } = require('../lib/partyMerge');
const { sendXlsx, day } = require('../lib/xlsxExport');

const router = express.Router();
const ROUTE = '/suppliers';

// Everything a supplier record holds. The block after `is_active` came across from the live system
// with the supplier import -- address, contact numbers, credit terms and payee/bank details -- and
// is editable here so the two systems do not drift apart.
//
// `live_pk` and `live_id` are deliberately NOT here: they are the link back to the live record and
// are set by the importer alone, never typed in.
const FIELDS = ['supplier_code', 'name', 'company_name', 'tin', 'payment_term_id', 'is_active',
  'address', 'contact_no', 'mobile_no', 'office_no', 'fax_no', 'email',
  'credit_term', 'term_days', 'payee_name', 'bank_name', 'bank_account_name', 'bank_account_no',
  // What this supplier is willing to let us owe. Typed in, never derived -- it is a term they
  // grant us, not something this system can work out. Recorded only: nothing refuses a purchase
  // order that would breach it (see db/add-supplier-credit-limit.js).
  'credit_limit'];

// An empty box or an unselected <select> posts '', and "not filled in" is NULL, not ''. It matters
// most for payment_term_id and term_days, which are INT: '' there either becomes 0 or errors
// outright depending on the server's SQL mode, and a payment term of 0 points at no row at all.
// Applying it to the text columns too keeps a cleared field matching what the importer stores.
const blankToNull = (value) => (value === '' || value === undefined ? null : value);

// Change history (2026-10-19): suppliers had none, so when SUP-249's TIN went back nobody could
// say who did it. Each field a save changes is one audit_logs row, read on the System Information tab.
const FIELD_LABEL = {
  supplier_code: 'Supplier Code', name: 'Name', company_name: 'Company Name', tin: 'TIN', payment_term_id: 'Payment Term',
  is_active: 'Active', address: 'Address', contact_no: 'Contact No', mobile_no: 'Mobile No', office_no: 'Office No',
  fax_no: 'Fax No', email: 'Email', credit_term: 'Credit Term', term_days: 'Term Days', payee_name: 'Payee Name',
  bank_name: 'Bank Name', bank_account_name: 'Bank Account Name', bank_account_no: 'Bank Account No', credit_limit: 'Credit Limit',
};
const NUMERIC = new Set(['payment_term_id', 'term_days', 'credit_limit', 'is_active']);
// Equal as stored? '' and null are both "not filled in"; numbers compare as numbers (0.00 = 0,
// true = 1) -- but a TIN or account number is text, where a leading zero matters.
function same(field, a, b) {
  const norm = (v) => {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'boolean') return v ? '1' : '0';
    const s = String(v).trim();
    return NUMERIC.has(field) && s !== '' && Number.isFinite(Number(s)) ? String(Number(s)) : s;
  };
  return norm(a) === norm(b);
}
async function logSupplierAudit(q, supplierId, userId, eventType, field, oldValue, newValue) {
  const text = (v) => (v === null || v === undefined ? null : String(v));
  await q.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('Supplier', ?, ?, ?, ?, ?, ?)`,
    [supplierId, eventType, field, text(oldValue), text(newValue), userId]);
}

// The list's filters, shared with its Excel extract so the file holds exactly what the list shows.
// All optional: with none given the list is every supplier, which is the shape the supplier
// dropdowns on seven other pages rely on. The Suppliers page itself filters in the browser on the
// same rules (see `visible` in pages/Suppliers.jsx) -- keep the two in step.
const SEARCH_FIELDS = ['supplier_code', 'name', 'company_name', 'tin', 'address', 'contact_no', 'mobile_no', 'email'];
function listFilter(req) {
  const { date_from: dateFrom, as_of: asOf } = req.query;
  const search = String(req.query.search || '').trim();
  const where = [];
  const params = [];
  // Period From / As of Date: inclusive bounds on the day the supplier was created. created_at is
  // a DATETIME, so the upper bound is "before the start of the next day" rather than <= the date,
  // which would drop everything created after midnight on the As of day.
  if (dateFrom) { where.push('s.created_at >= ?'); params.push(String(dateFrom).slice(0, 10)); }
  if (asOf) { where.push('s.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(String(asOf).slice(0, 10)); }
  if (search) {
    where.push(`(${SEARCH_FIELDS.map((f) => `s.${f} LIKE ?`).join(' OR ')})`);
    params.push(...SEARCH_FIELDS.map(() => `%${search}%`));
  }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

const LIST_SELECT = `SELECT s.*, pt.term_name AS payment_term_name
       FROM suppliers s
       LEFT JOIN payment_terms pt ON pt.id = s.payment_term_id`;

// Merge two suppliers (asked 2026-10-08): retain_id keeps its record, delete_id's transactions move
// onto it and its record is removed -- see lib/partyMerge.js. dry_run reports what would move.
// System Admin only: it cannot be undone.
router.post('/merge', requireAuth, async (req, res, next) => {
  try {
    if (!(await isSystemAdmin(req.user.id))) return res.status(403).json({ error: 'Only a System Admin can merge suppliers.' });
    const out = await mergeParty('supplier', req.body?.retain_id, req.body?.delete_id, { dryRun: !!req.body?.dry_run, userId: req.user.id });
    res.json(out);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { whereSql, params } = listFilter(req);
    const [rows] = await pool.query(`${LIST_SELECT} ${whereSql} ORDER BY s.id DESC`, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Extract: every supplier under the list's current filters, as a workbook. Registered before /:id.
router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { whereSql, params } = listFilter(req);
    const [rows] = await pool.query(`${LIST_SELECT} ${whereSql} ORDER BY s.id DESC`, params);
    await sendXlsx(res, {
      filename: 'suppliers.xlsx',
      sheet: 'Suppliers',
      columns: [
        { header: 'Code', key: 'code', width: 14 },
        { header: 'Name', key: 'name', width: 38 },
        { header: 'Company', key: 'company', width: 38 },
        { header: 'Contact', key: 'contact_no', width: 18 },
        { header: 'Payment Term', key: 'payment_term', width: 18 },
        { header: 'Status', key: 'status', width: 10 },
        { header: 'TIN', key: 'tin', width: 22 },
        { header: 'Address', key: 'address', width: 50 },
        { header: 'Mobile No.', key: 'mobile_no', width: 18 },
        { header: 'Office No.', key: 'office_no', width: 18 },
        { header: 'Fax No.', key: 'fax_no', width: 16 },
        { header: 'Email', key: 'email', width: 30 },
        { header: 'Credit Term', key: 'credit_term', width: 18 },
        { header: 'Term (days)', key: 'term_days', width: 11 },
        { header: 'Credit Limit', key: 'credit_limit', width: 15, money: true },
        { header: 'Payee Name', key: 'payee_name', width: 30 },
        { header: 'Bank Name', key: 'bank_name', width: 24 },
        { header: 'Bank Account Name', key: 'bank_account_name', width: 30 },
        { header: 'Bank Account No.', key: 'bank_account_no', width: 20 },
        { header: 'Date Created', key: 'date_created', width: 12 },
      ],
      rows: rows.map((r) => ({
        code: r.supplier_code || '', name: r.name || '', company: r.company_name || '', contact_no: r.contact_no || '',
        // Same fallback as the list column: imported suppliers carry live's free-text credit term only.
        payment_term: r.payment_term_name || r.credit_term || '',
        status: r.is_active ? 'Active' : 'Inactive', tin: r.tin || '', address: r.address || '',
        mobile_no: r.mobile_no || '', office_no: r.office_no || '', fax_no: r.fax_no || '', email: r.email || '',
        credit_term: r.credit_term || '', term_days: r.term_days ?? '',
        // Blank means no limit agreed, which is not zero -- left blank rather than written as 0.00.
        credit_limit: r.credit_limit == null ? '' : Number(r.credit_limit),
        payee_name: r.payee_name || '', bank_name: r.bank_name || '', bank_account_name: r.bank_account_name || '',
        bank_account_no: r.bank_account_no || '', date_created: day(r.created_at),
      })),
    });
  } catch (err) {
    if (res.headersSent) { res.destroy(err); return; }
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[supplier]] = await pool.query(
      `SELECT s.*, pt.term_name AS payment_term_name
         FROM suppliers s LEFT JOIN payment_terms pt ON pt.id = s.payment_term_id
        WHERE s.id = ?`, [req.params.id]
    );
    if (!supplier) return res.status(404).json({ error: 'Not found' });
    const [contacts] = await pool.query('SELECT * FROM supplier_contacts WHERE supplier_id = ? ORDER BY id', [req.params.id]);
    const [addresses] = await pool.query('SELECT * FROM supplier_addresses WHERE supplier_id = ? ORDER BY id', [req.params.id]);

    // What is still owed this supplier. Read straight off vendor_bills.amount_due, which the bill
    // payment routes decrement as each payment applies (and put back on a void), rather than
    // recomputing gross minus payments here -- two places deriving the same figure differently is
    // how a statement and a payment screen come to disagree. Bills settled in full carry 0, so a
    // plain SUM over every bill is the balance; verified against the clone, where all 18,760 paid
    // bills hold exactly 0 and only the 402 open ones contribute.
    const [[{ balance }]] = await pool.query(
      `SELECT IFNULL(ROUND(SUM(vb.amount_due), 2), 0) AS balance
         FROM vendor_bills vb
         LEFT JOIN purchase_orders po ON po.id = vb.purchase_order_id
        WHERE COALESCE(po.supplier_id, vb.supplier_id) = ?`, [req.params.id]
    );

    // Items this supplier has been bought from, with the last price paid. Empty until the
    // inventory/supplier price list is imported; the tab says so rather than looking broken.
    const [items] = await pool.query(
      `SELECT isp.id, isp.price, isp.last_purchase_date, isp.ref_no,
              i.item_code, i.display_name, i.item_type
         FROM inventory_supplier_prices isp
         JOIN inventories i ON i.id = isp.inventory_id
        WHERE isp.supplier_id = ?
        ORDER BY i.item_code`, [req.params.id]
    );

    res.json({ ...supplier, contacts, addresses, items, balance: Number(balance) });
  } catch (err) {
    next(err);
  }
});

// Every document this supplier appears on, in one list, newest first -- the supplier's own
// statement. Four sources, which is why it is a UNION rather than a filter on one table:
//
//   PO    purchase_orders        supplier_id directly
//   RR    purchase_order_receipts  through its purchase order
//   VB    vendor_bills             through its purchase order (it has no supplier_id of its own)
//   BPAY  bill_payments          supplier_id directly
//
// PAGINATED, not optional: the busiest supplier in the clone has 3,027 of these rows, and this is
// exactly the "fetch the whole table to show ten of it" shape that has bitten this app elsewhere.
// The count comes from the same subquery so the pager cannot disagree with the page.
//
// The filters mirror the column boxes on the live screen. `as_of` is inclusive and is the one
// that changes the meaning of the list rather than just narrowing it: it answers "where did this
// supplier stand on that date", so it belongs with the date column it sits under.
const LEDGER_SQL = `
  SELECT 'PO' AS doc_type, po.id AS doc_id, po.po_no AS doc_no, po.date_created AS doc_date,
         po.status AS status, po.ref_no AS reference_no, po.memo AS memo, po.total_amount AS amount
    FROM purchase_orders po
   WHERE po.supplier_id = ?
  UNION ALL
  SELECT 'RR', r.id, r.receipt_no, r.date_created, NULL, r.ref_no, r.memo, r.total_amount
    FROM purchase_order_receipts r
    JOIN purchase_orders po ON po.id = r.purchase_order_id
   WHERE po.supplier_id = ?
  UNION ALL
  SELECT 'VB', vb.id, vb.bill_no, vb.date_created, vb.status, vb.reference_no, vb.memo, vb.gross_amount
    FROM vendor_bills vb
    LEFT JOIN purchase_orders po ON po.id = vb.purchase_order_id
   WHERE COALESCE(po.supplier_id, vb.supplier_id) = ?
  UNION ALL
  SELECT 'BPAY', bp.id, bp.bill_payment_no, bp.date_created, bp.status, bp.reference_no, bp.memo, bp.total_amount
    FROM bill_payments bp
   WHERE bp.supplier_id = ?
`;

router.get('/:id/transactions', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { as_of: asOf, date_from: dateFrom, doc_no: docNo, status, reference_no: referenceNo, memo, doc_type: docType } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 20));

    const id = req.params.id;
    const where = [];
    const params = [id, id, id, id];
    // Period from (2026-11-11): date_from .. as_of, both inclusive; without it, As of alone.
    if (dateFrom) { where.push('t.doc_date >= ?'); params.push(dateFrom); }
    if (asOf) { where.push('t.doc_date <= ?'); params.push(asOf); }
    if (docType) { where.push('t.doc_type = ?'); params.push(docType); }
    if (docNo) { where.push('t.doc_no LIKE ?'); params.push(`%${docNo}%`); }
    if (status) { where.push('t.status LIKE ?'); params.push(`%${status}%`); }
    if (referenceNo) { where.push('t.reference_no LIKE ?'); params.push(`%${referenceNo}%`); }
    if (memo) { where.push('t.memo LIKE ?'); params.push(`%${memo}%`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM (${LEDGER_SQL}) t ${whereSql}`, params
    );
    const [rows] = await pool.query(
      `SELECT t.* FROM (${LEDGER_SQL}) t ${whereSql}
        ORDER BY t.doc_date DESC, t.doc_no DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );
    res.json({ rows, total, page, limit });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const values = FIELDS.map((f) => blankToNull(req.body[f]));
    const [result] = await conn.query(
      `INSERT INTO suppliers (${FIELDS.join(', ')}) VALUES (${FIELDS.map(() => '?').join(', ')})`,
      values
    );
    const supplierId = result.insertId;
    await logSupplierAudit(conn, supplierId, req.user.id, 'Created', null, null, req.body.name || null);

    for (const c of req.body.contacts || []) {
      await conn.query(
        `INSERT INTO supplier_contacts (supplier_id, contact_name, title, email, phone, is_primary) VALUES (?, ?, ?, ?, ?, ?)`,
        [supplierId, c.contact_name, c.title || null, c.email || null, c.phone || null, !!c.is_primary]
      );
    }
    for (const a of req.body.addresses || []) {
      await conn.query(
        `INSERT INTO supplier_addresses (supplier_id, address_line, is_default) VALUES (?, ?, ?)`,
        [supplierId, a.address_line, !!a.is_default]
      );
    }

    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM suppliers WHERE id = ?', [supplierId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Supplier code already in use' });
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    // Only the fields actually SENT are written. This matters now that a supplier carries the
    // twelve imported columns: the old version wrote every field in FIELDS, using null for any the
    // caller omitted, so a client that posted just a name and a code would silently blank the
    // address, TIN, credit term and bank details that came across from the live system.
    // Clearing a field on purpose still works -- that sends the field, as an empty string.
    const present = FIELDS.filter((f) => req.body[f] !== undefined);
    if (present.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    await conn.beginTransaction();
    const [[cur]] = await conn.query('SELECT * FROM suppliers WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!cur) { await conn.rollback(); return res.status(404).json({ error: 'Not found' }); }

    // A STALE TAB (2026-10-19). SUP-249's TIN was put back on 16 Oct by a save of the whole form
    // from a page opened before the TIN was corrected. The edit screen now sends `_original`, the
    // values as it loaded them: a field the user did not touch is not written at all, and a field
    // they did change that someone else has changed in the meantime is refused, not overwritten.
    const original = req.body._original && typeof req.body._original === 'object' ? req.body._original : null;
    const toWrite = original
      ? present.filter((f) => !(f in original) || same(f, req.body[f], original[f]) === false)
      : present;
    if (original) {
      const clashes = toWrite.filter((f) => f in original && !same(f, cur[f], original[f]) && !same(f, cur[f], req.body[f]));
      if (clashes.length) {
        await conn.rollback();
        const what = clashes.map((f) => `${FIELD_LABEL[f] || f} (now "${cur[f] ?? ''}")`).join(', ');
        return res.status(409).json({
          error: `Someone else changed ${what} on this supplier after you opened it. Close and reopen it to see the latest, then make your change again.`,
          conflict_fields: clashes,
        });
      }
    }

    // What actually changes, written and recorded field by field in the supplier's history.
    const changed = toWrite.filter((f) => !same(f, cur[f], req.body[f]));
    if (changed.length) {
      await conn.query(
        `UPDATE suppliers SET ${changed.map((f) => `${f} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
        [...changed.map((f) => blankToNull(req.body[f])), req.params.id]
      );
      for (const f of changed) {
        await logSupplierAudit(conn, cur.id, req.user.id, 'Updated', f, cur[f], blankToNull(req.body[f]));
      }
    }
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM suppliers WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// The supplier's change history (System Information tab): who changed which field, from what to what.
router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
        WHERE a.auditable_type = 'Supplier' AND a.auditable_id = ? ORDER BY a.set_at DESC, a.id DESC`,
      [req.params.id]);
    res.json(rows.map((r) => ({ ...r, field_name: FIELD_LABEL[r.field_name] || r.field_name })));
  } catch (err) { next(err); }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM supplier_contacts WHERE supplier_id = ?', [req.params.id]);
    await conn.query('DELETE FROM supplier_addresses WHERE supplier_id = ?', [req.params.id]);
    await conn.query('DELETE FROM suppliers WHERE id = ?', [req.params.id]);
    await conn.commit();
    res.status(204).send();
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ error: 'This supplier is referenced by other data and cannot be deleted.' });
    }
    next(err);
  } finally {
    conn.release();
  }
});

router.post('/:id/contacts', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { contact_name, title, email, phone, is_primary } = req.body;
    const [result] = await pool.query(
      `INSERT INTO supplier_contacts (supplier_id, contact_name, title, email, phone, is_primary) VALUES (?, ?, ?, ?, ?, ?)`,
      [req.params.id, contact_name, title || null, email || null, phone || null, !!is_primary]
    );
    const [[row]] = await pool.query('SELECT * FROM supplier_contacts WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/contacts/:contactId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM supplier_contacts WHERE id = ? AND supplier_id = ?', [req.params.contactId, req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.post('/:id/addresses', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { address_line, is_default } = req.body;
    const [result] = await pool.query(
      `INSERT INTO supplier_addresses (supplier_id, address_line, is_default) VALUES (?, ?, ?)`,
      [req.params.id, address_line, !!is_default]
    );
    const [[row]] = await pool.query('SELECT * FROM supplier_addresses WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/addresses/:addressId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM supplier_addresses WHERE id = ? AND supplier_id = ?', [req.params.addressId, req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
