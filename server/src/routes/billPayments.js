const express = require('express');
const pool = require('../db');
const { CREDIT_STATUS_SQL, syncChequeForCredit } = require('../lib/billCreditStatus');
const { insertNumbered } = require('../lib/docNumber');
const { requireAuth, requirePermission, isSystemAdmin, userCan } = require('../middleware/auth');
const { assertPeriodOpen } = require('../lib/accountingPeriod');
const { computeBillPaymentGl } = require('../lib/glImpact');
const { postReversalJournal } = require('../lib/reversalJournal');
const { sendXlsx, day } = require('../lib/xlsxExport');
const { companyWhere } = require('../lib/requestScope');

const router = express.Router();
// Reached from an Open Vendor Bill's "Bill Payment" button, confirmed against the real
// system's Bill Payment modal. A single payment can settle several of the same vendor's
// open bills at once (the "Apply" tab) and/or offset the payment with the vendor's own
// existing open Bill Credits (the "Debits" tab).
const ROUTE = '/bill-payments';

async function logAudit(conn, { paymentId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('BillPayment', ?, ?, ?, ?, ?, ?)`,
    [paymentId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

async function applyToVendorBill(conn, vendorBillId, amount) {
  const [[vb]] = await conn.query('SELECT amount_due FROM vendor_bills WHERE id = ?', [vendorBillId]);
  if (!vb) throw Object.assign(new Error('One of the selected bills is no longer valid.'), { status: 400 });
  if (amount > Number(vb.amount_due) + 1e-9) {
    throw Object.assign(new Error(`Applied Amount (${amount}) exceeds this bill's remaining Amount Due (${vb.amount_due}).`), { status: 409 });
  }
  const newDue = Number((Number(vb.amount_due) - amount).toFixed(2));
  await conn.query(
    "UPDATE vendor_bills SET amount_due = ?, status = IF(? <= 0.005, 'paid_in_full', status) WHERE id = ?",
    [newDue, newDue, vendorBillId]
  );
}

async function reverseVendorBillApplication(conn, vendorBillId, amount) {
  const [[vb]] = await conn.query('SELECT amount_due, gross_amount FROM vendor_bills WHERE id = ?', [vendorBillId]);
  if (!vb) return;
  const newDue = Number((Number(vb.amount_due) + amount).toFixed(2));
  await conn.query(
    "UPDATE vendor_bills SET amount_due = ?, status = IF(status IN ('paid_in_full', 'paid') AND ? > 0.005, 'open', status) WHERE id = ?",
    [newDue, newDue, vendorBillId]
  );
}

// LEFT JOIN throughout, with the supplier taken from the PO when there is one and from the
// bill's own supplier_id when there isn't. A standalone (expense) Vendor Bill has no PO at
// all, so an inner join made every one of them 404 here -- unpayable through the UI.
router.get('/for-vendor-bill/:vbId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[vb]] = await pool.query(
      `SELECT vb.id, vb.bill_no, vb.office_location_id, vb.account_id AS ap_account_id, vb.memo,
              COALESCE(po.supplier_id, vb.supplier_id) AS supplier_id, s.name AS supplier_name, coa.account_code, coa.account_name
       FROM vendor_bills vb
       LEFT JOIN purchase_orders po ON po.id = vb.purchase_order_id
       LEFT JOIN suppliers s ON s.id = COALESCE(po.supplier_id, vb.supplier_id)
       LEFT JOIN chart_of_accounts coa ON coa.id = vb.account_id
       WHERE vb.id = ?`,
      [req.params.vbId]
    );
    if (!vb) return res.status(404).json({ error: 'Not found' });

    const [applyLines] = await pool.query(
      `SELECT vb2.id AS vendor_bill_id, vb2.bill_no, vb2.date_created, vb2.date_due, vb2.gross_amount, vb2.amount_due
       FROM vendor_bills vb2
       LEFT JOIN purchase_orders po2 ON po2.id = vb2.purchase_order_id
       WHERE COALESCE(po2.supplier_id, vb2.supplier_id) = ? AND vb2.status = 'open'
       ORDER BY vb2.id DESC`,
      [vb.supplier_id]
    );

    const [debitLines] = await pool.query(
      `SELECT id AS bill_credit_id, bill_credit_no, date_created, total_amount, applied_amount,
              (total_amount - applied_amount) AS remaining
       FROM bill_credits
       WHERE (vendor_bill_id IN (SELECT vb3.id FROM vendor_bills vb3 LEFT JOIN purchase_orders po3 ON po3.id = vb3.purchase_order_id WHERE COALESCE(po3.supplier_id, vb3.supplier_id) = ?)
              OR (vendor_bill_id IS NULL AND supplier_id = ?))
         AND status = 'open' AND applied_amount < total_amount
       ORDER BY id DESC`,
      [vb.supplier_id, vb.supplier_id]
    );

    res.json({ ...vb, apply_lines: applyLines, debit_lines: debitLines });
  } catch (err) {
    next(err);
  }
});

// The list's Vendor filter: every supplier with at least one Bill Payment -- inactive ones included --
// with its count, as the Cheque list's Payee filter (routes/cheques.js /payees).
router.get('/payees', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT bp.supplier_id AS id, s.name, COUNT(*) AS payments
         FROM bill_payments bp JOIN suppliers s ON s.id = bp.supplier_id
        GROUP BY bp.supplier_id, s.name ORDER BY s.name`);
    res.json(rows);
  } catch (err) { next(err); }
});

// The same filters and columns as the Cheque list (asked 2026-10-02): Vendor, Released / Not
// Released (Date Released set or not), Period From / As of Date on the payment date, search across
// number, vendor, payee name, check #, reference and memo; sorted by Date, newest first.
// The list and its Excel extract share one query, so the file holds exactly what the list shows.
async function listBillPayments(query) {
  const req = { query };
  {
    const { search, status, as_of: asOf, date_from: dateFrom } = req.query;
    const where = [];
    { const cw = companyWhere('bp.office_location_id'); if (cw) where.push(cw); } // topbar company switcher
    const params = [];
    if (status) { where.push('bp.status = ?'); params.push(status); }
    if (Number(req.query.supplier_id)) { where.push('bp.supplier_id = ?'); params.push(Number(req.query.supplier_id)); }
    if (req.query.released === 'released') where.push('bp.date_released IS NOT NULL');
    if (req.query.released === 'not_released') where.push('bp.date_released IS NULL');
    if (dateFrom) { where.push('bp.date_created >= ?'); params.push(String(dateFrom).slice(0, 10)); }
    if (asOf) { where.push('bp.date_created <= ?'); params.push(String(asOf).slice(0, 10)); }
    if (search) {
      where.push('(bp.bill_payment_no LIKE ? OR s.name LIKE ? OR bp.payee_name LIKE ? OR bp.check_no LIKE ? OR bp.reference_no LIKE ? OR bp.memo LIKE ?)');
      params.push(...Array(6).fill(`%${search}%`));
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT bp.id, bp.bill_payment_no, bp.date_created, bp.payment_method_id, pm.name AS payment_method_name,
              bp.total_amount, bp.status, bp.memo, bp.check_no, bp.check_date, bp.payee_name, bp.date_released,
              bp.supplier_id, s.name AS supplier_name, coa.account_name AS bank_account_name
       FROM bill_payments bp
       LEFT JOIN suppliers s ON s.id = bp.supplier_id
       LEFT JOIN payment_methods pm ON pm.id = bp.payment_method_id
       LEFT JOIN chart_of_accounts coa ON coa.id = bp.bank_account_id
       ${whereSql}
       ORDER BY bp.date_created DESC, bp.id DESC`,
      params
    );
    return rows;
  }
}

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    res.json(await listBillPayments(req.query));
  } catch (err) {
    next(err);
  }
});

// Extract: the list under its current filters, as a workbook. Registered before /:id.
router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const rows = await listBillPayments(req.query);
    const STATUS = { open: 'Open', posted: 'Posted', voided: 'Voided' };
    await sendXlsx(res, {
      filename: 'bill-payments.xlsx',
      sheet: 'Bill Payments',
      // The Cheque list's extract format (asked 2026-11-03), column for column -- routes/cheques.js -- except
      // the first column, which is the Bill Payment's own number and so reads Payment No.
      columns: [
        { header: 'Payment No', key: 'no', width: 16 },
        { header: 'Date', key: 'date', width: 12 },
        { header: 'Cheque Date', key: 'cheque_date', width: 12 },
        { header: 'Cheque #', key: 'cheque_number', width: 14 },
        { header: 'Payee', key: 'payee', width: 38 },
        { header: 'Account', key: 'account', width: 28 },
        { header: 'Total', key: 'total', width: 16, money: true },
        { header: 'Date Released', key: 'released', width: 14 },
        { header: 'Status', key: 'status', width: 13 },
        { header: 'Memo', key: 'memo', width: 50 },
      ],
      rows: rows.map((r) => ({
        no: r.bill_payment_no, date: day(r.date_created), cheque_date: day(r.check_date), cheque_number: r.check_no || '',
        payee: r.payee_name || r.supplier_name || '', account: r.bank_account_name || '', total: Number(r.total_amount || 0),
        released: day(r.date_released) || 'Not released', status: STATUS[r.status] || r.status, memo: r.memo || '',
      })),
    });
  } catch (err) {
    if (res.headersSent) { res.destroy(err); return; }
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[bp]] = await pool.query(
      `SELECT bp.*, s.name AS supplier_name, s.tin,
              loc.location_name AS office_location_name,
              apcoa.account_code AS ap_account_code, apcoa.account_name AS ap_account_name,
              bankcoa.account_code AS bank_account_code, bankcoa.account_name AS bank_account_name,
              pm.name AS payment_method_name
       FROM bill_payments bp
       LEFT JOIN suppliers s ON s.id = bp.supplier_id
       LEFT JOIN locations loc ON loc.id = bp.office_location_id
       LEFT JOIN chart_of_accounts apcoa ON apcoa.id = bp.ap_account_id
       LEFT JOIN chart_of_accounts bankcoa ON bankcoa.id = bp.bank_account_id
       LEFT JOIN payment_methods pm ON pm.id = bp.payment_method_id
       WHERE bp.id = ?`,
      [req.params.id]
    );
    if (!bp) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT bpl.*, vb.bill_no, vb.date_created AS vb_date_created, vb.date_due AS vb_date_due, vb.gross_amount AS vb_gross_amount,
              vb.memo AS vb_memo, vb.reference_no AS vb_reference_no,
              -- The voucher's Description reads the bill's memo, but a bill raised without
              -- one would otherwise print its bare number. Fall back to the descriptions of
              -- the bill's own expense lines, which is where the detail actually lives.
              (SELECT GROUP_CONCAT(NULLIF(TRIM(vbl.description), '') SEPARATOR ', ')
                 FROM vendor_bill_lines vbl WHERE vbl.vendor_bill_id = vb.id) AS vb_line_descriptions,
              -- What the bill still owed when THIS payment was made, which is what the
              -- Payment Voucher's "Amount Due" column shows. Not stored anywhere, so it is
              -- reconstructed: the bill's gross less whatever earlier, non-voided payments
              -- had already applied to it.
              (vb.gross_amount - COALESCE((
                 SELECT SUM(pl2.applied_amount)
                 FROM bill_payment_lines pl2
                 JOIN bill_payments bp2 ON bp2.id = pl2.bill_payment_id
                 WHERE pl2.vendor_bill_id = bpl.vendor_bill_id
                   AND bp2.status <> 'voided'
                   AND pl2.bill_payment_id < bpl.bill_payment_id
               ), 0)) AS amount_due_before,
              bc.bill_credit_no
       FROM bill_payment_lines bpl
       LEFT JOIN vendor_bills vb ON vb.id = bpl.vendor_bill_id
       LEFT JOIN bill_credits bc ON bc.id = bpl.bill_credit_id
       WHERE bpl.bill_payment_id = ?`,
      [req.params.id]
    );

    // GL Impact, as the ledger posts it (lib/glImpact.js computeBillPaymentGl), and the reversal
    // journal a void wrote.
    const glImpact = await computeBillPaymentGl(bp);
    const [[reversal]] = await pool.query(
      "SELECT id, journal_no, date_created FROM journals WHERE source_type = 'bill_payment' AND source_id = ? AND status <> 'void' LIMIT 1", [bp.id]);
    // wu: a payment voided before reversal journals existed posts nothing (see computePostedGlLines).
    const shownGl = bp.status === 'voided' && !reversal ? [] : glImpact;
    res.json({ ...bp, lines, gl_impact: shownGl, reversal_journal: reversal || null });
  } catch (err) {
    next(err);
  }
});

// Related Records (asked 2026-10-03), as on the Cheque page: the Vendor Bills and Bill Credits
// this payment settles, and every journal raised against it -- the REVERSAL journal of a void.
router.get('/:id/related', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [bills] = await pool.query(
      `SELECT vb.id, vb.bill_no AS doc_no, vb.date_created, vb.status, SUM(bpl.applied_amount) AS amount
         FROM bill_payment_lines bpl JOIN vendor_bills vb ON vb.id = bpl.vendor_bill_id
        WHERE bpl.bill_payment_id = ? GROUP BY vb.id ORDER BY vb.date_created, vb.id`, [req.params.id]);
    const [credits] = await pool.query(
      `SELECT bc.id, bc.bill_credit_no AS doc_no, bc.date_created, bc.status, SUM(bpl.applied_amount) AS amount
         FROM bill_payment_lines bpl JOIN bill_credits bc ON bc.id = bpl.bill_credit_id
        WHERE bpl.bill_payment_id = ? GROUP BY bc.id ORDER BY bc.date_created, bc.id`, [req.params.id]);
    const [journals] = await pool.query(
      `SELECT j.id, j.journal_no AS doc_no, j.date_created, j.status, j.total_debit AS amount
         FROM journals j WHERE j.source_type = 'bill_payment' AND j.source_id = ?
        ORDER BY j.date_created DESC, j.id DESC`, [req.params.id]);
    res.json([
      ...bills.map((r) => ({ ...r, kind: 'Vendor Bill', path: `/vendor-bills/${r.id}` })),
      ...credits.map((r) => ({ ...r, kind: 'Bill Credit', path: `/bill-credits/${r.id}` })),
      ...journals.map((r) => ({ ...r, kind: 'Journal', path: `/journals/${r.id}` })),
    ]);
  } catch (err) { next(err); }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'BillPayment' AND a.auditable_id = ?
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
      supplier_id: supplierId, date_created: dateCreated, payment_type: paymentType, payee_name: payeeName,
      office_location_id: officeLocationId, ap_account_id: apAccountId, bank_account_id: bankAccountId,
      payment_method_id: paymentMethodId, reference_no: referenceNo, check_date: checkDate, check_no: checkNo,
      memo, apply_lines: applyLines, debit_lines: debitLines,
    } = req.body;

    if (!supplierId) return res.status(400).json({ error: 'Vendor is required.' });
    if (!bankAccountId || !paymentMethodId) return res.status(400).json({ error: 'Bank Account and Payment Method are required.' });

    const submittedApply = (Array.isArray(applyLines) ? applyLines : []).filter((l) => l.vendor_bill_id && Number(l.applied_amount) > 0);
    const submittedDebits = (Array.isArray(debitLines) ? debitLines : []).filter((l) => l.bill_credit_id && Number(l.applied_amount) > 0);
    if (!submittedApply.length && !submittedDebits.length) {
      return res.status(400).json({ error: 'Apply at least one amount to a bill or credit.' });
    }

    // Re-check every line against fresh amount_due/remaining -- reject rather than clamp,
    // matching the qty/amount-cap discipline used everywhere else in this codebase.
    for (const l of submittedDebits) {
      const [[bc]] = await conn.query('SELECT total_amount, applied_amount, status FROM bill_credits WHERE id = ?', [l.bill_credit_id]);
      if (!bc || bc.status !== 'open') return res.status(400).json({ error: 'One of the selected credits is no longer valid.' });
      const remaining = Number(bc.total_amount) - Number(bc.applied_amount);
      if (Number(l.applied_amount) > remaining + 1e-9) {
        return res.status(409).json({ error: `Applied Amount (${l.applied_amount}) exceeds this credit's remaining balance (${remaining}).` });
      }
    }

    const totalAmount = [...submittedApply, ...submittedDebits].reduce((s, l) => s + Number(l.applied_amount), 0);
    await assertPeriodOpen(dateCreated, 'ap', conn);

    await conn.beginTransaction();

    for (const l of submittedApply) {
      await applyToVendorBill(conn, l.vendor_bill_id, Number(l.applied_amount));
    }
    for (const l of submittedDebits) {
      { await conn.query(`UPDATE bill_credits SET applied_amount = applied_amount + ?, ${CREDIT_STATUS_SQL} WHERE id = ?`, [Number(l.applied_amount), l.bill_credit_id]); await syncChequeForCredit(conn, l.bill_credit_id); }
    }

    const { id: paymentId } = await insertNumbered(conn, {
      table: 'bill_payments',
      column: 'bill_payment_no',
      prefix: 'BPAY-',
      run: (no) => conn.query(
        `INSERT INTO bill_payments
           (bill_payment_no, date_created, payment_type, supplier_id, payee_name, office_location_id, ap_account_id,
            bank_account_id, payment_method_id, reference_no, check_date, check_no, memo, total_amount, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          no, dateCreated || new Date().toISOString().slice(0, 10), paymentType || 'full', supplierId, payeeName || null,
          officeLocationId || null, apAccountId || null, bankAccountId, paymentMethodId, referenceNo || null,
          checkDate || null, checkNo || null, memo || null, totalAmount, req.user.id,
        ]
      ),
    });

    for (const l of submittedApply) {
      await conn.query(
        'INSERT INTO bill_payment_lines (bill_payment_id, vendor_bill_id, applied_amount) VALUES (?, ?, ?)',
        [paymentId, l.vendor_bill_id, l.applied_amount]
      );
    }
    for (const l of submittedDebits) {
      await conn.query(
        'INSERT INTO bill_payment_lines (bill_payment_id, bill_credit_id, applied_amount) VALUES (?, ?, ?)',
        [paymentId, l.bill_credit_id, l.applied_amount]
      );
    }

    await logAudit(conn, { paymentId, userId: req.user.id, eventType: 'Created', fieldName: 'bill_payment_no', newValue: `BPAY-${paymentId}` });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM bill_payments WHERE id = ?', [paymentId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    conn.release();
  }
});

// ---------------------------------------------------------------- print
//
// The Bill Payment Voucher (client/src/pages/BillPaymentPrint.jsx). Gated like the other printed
// documents: System Admin always, everyone else needs can_print on /bill-payments. A voided payment
// still prints -- marked VOID on the sheet -- because the paper trail of what was cancelled matters.
router.get('/:id/print', requireAuth, async (req, res, next) => {
  try {
    if (!(await isSystemAdmin(req.user.id)) && !(await userCan(req.user.id, ROUTE, 'can_print'))) {
      return res.status(403).json({ error: 'You do not have permission to print a Bill Payment.' });
    }
    const [[bp]] = await pool.query(
      `SELECT bp.*, s.name AS supplier_name, s.tin AS supplier_tin, s.address AS supplier_address,
              loc.location_name AS office_location_name,
              apcoa.account_code AS ap_account_code, apcoa.account_name AS ap_account_name,
              bankcoa.account_code AS bank_account_code, bankcoa.account_name AS bank_account_name,
              pm.name AS payment_method_name, u.display_name AS created_by_name, u.signature_data AS prepared_signature
         FROM bill_payments bp
         LEFT JOIN suppliers s ON s.id = bp.supplier_id
         LEFT JOIN locations loc ON loc.id = bp.office_location_id
         LEFT JOIN chart_of_accounts apcoa ON apcoa.id = bp.ap_account_id
         LEFT JOIN chart_of_accounts bankcoa ON bankcoa.id = bp.bank_account_id
         LEFT JOIN payment_methods pm ON pm.id = bp.payment_method_id
         LEFT JOIN users u ON u.id = bp.created_by_user_id
        WHERE bp.id = ?`, [req.params.id]);
    if (!bp) return res.status(404).json({ error: 'Not found' });
    const [lines] = await pool.query(
      `SELECT bpl.*, vb.bill_no, vb.reference_no AS vb_reference_no, vb.date_created AS vb_date_created,
              vb.gross_amount AS vb_gross_amount, vb.amount_due AS vb_amount_due_now, bc.bill_credit_no
         FROM bill_payment_lines bpl
         LEFT JOIN vendor_bills vb ON vb.id = bpl.vendor_bill_id
         LEFT JOIN bill_credits bc ON bc.id = bpl.bill_credit_id
        WHERE bpl.bill_payment_id = ? ORDER BY bpl.id`, [req.params.id]);
    res.json({ ...bp, lines });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- edit
//
// What the edit popup offers: the payment as saved, plus every bill and credit of the same vendor
// it could apply to -- the vendor's open ones AND the ones this payment already settles, with this
// payment's own amount added back to what is due (that is what would be due were it not applied).
router.get('/:id/edit-options', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [[bp]] = await pool.query(
      `SELECT bp.*, s.name AS supplier_name, apcoa.account_code AS ap_account_code, apcoa.account_name AS ap_account_name,
              bankcoa.account_code AS bank_account_code, bankcoa.account_name AS bank_account_name, pm.name AS payment_method_name,
              loc.location_name AS office_location_name
         FROM bill_payments bp
         LEFT JOIN suppliers s ON s.id = bp.supplier_id
         LEFT JOIN chart_of_accounts apcoa ON apcoa.id = bp.ap_account_id
         LEFT JOIN chart_of_accounts bankcoa ON bankcoa.id = bp.bank_account_id
         LEFT JOIN payment_methods pm ON pm.id = bp.payment_method_id
         LEFT JOIN locations loc ON loc.id = bp.office_location_id
        WHERE bp.id = ?`, [req.params.id]);
    if (!bp) return res.status(404).json({ error: 'Not found' });
    const [mine] = await pool.query('SELECT vendor_bill_id, bill_credit_id, applied_amount FROM bill_payment_lines WHERE bill_payment_id = ?', [req.params.id]);
    const myBill = new Map(mine.filter((l) => l.vendor_bill_id).map((l) => [Number(l.vendor_bill_id), Number(l.applied_amount)]));
    const myCredit = new Map(mine.filter((l) => l.bill_credit_id).map((l) => [Number(l.bill_credit_id), Number(l.applied_amount)]));
    const [bills] = await pool.query(
      `SELECT vb.id AS vendor_bill_id, vb.bill_no, vb.date_created, vb.date_due, vb.gross_amount, vb.amount_due, vb.status
         FROM vendor_bills vb LEFT JOIN purchase_orders po ON po.id = vb.purchase_order_id
        WHERE (COALESCE(po.supplier_id, vb.supplier_id) = ? AND vb.status = 'open') OR vb.id IN (?)
        ORDER BY vb.id DESC`, [bp.supplier_id, [...myBill.keys(), 0]]);
    const [credits] = await pool.query(
      `SELECT id AS bill_credit_id, bill_credit_no, date_created, total_amount, applied_amount, status
         FROM bill_credits
        WHERE (status = 'open' AND applied_amount < total_amount AND (vendor_bill_id IN
                (SELECT vb3.id FROM vendor_bills vb3 LEFT JOIN purchase_orders po3 ON po3.id = vb3.purchase_order_id WHERE COALESCE(po3.supplier_id, vb3.supplier_id) = ?)
                OR (vendor_bill_id IS NULL AND supplier_id = ?)))
           OR id IN (?)
        ORDER BY id DESC`, [bp.supplier_id, bp.supplier_id, [...myCredit.keys(), 0]]);
    const reconciled = await isReconciled(pool, req.params.id);
    res.json({
      ...bp,
      reconciled,
      apply_lines: bills.map((b) => ({ ...b, amount_due: Number((Number(b.amount_due) + (myBill.get(Number(b.vendor_bill_id)) || 0)).toFixed(2)), applied_amount: myBill.get(Number(b.vendor_bill_id)) || 0 })),
      debit_lines: credits.map((c) => {
        const remaining = Number(c.total_amount) - Number(c.applied_amount) + (myCredit.get(Number(c.bill_credit_id)) || 0);
        return { ...c, remaining: Number(remaining.toFixed(2)), applied_amount: myCredit.get(Number(c.bill_credit_id)) || 0 };
      }),
    });
  } catch (err) {
    next(err);
  }
});

async function isReconciled(db, paymentId) {
  const [[m]] = await db.query("SELECT COUNT(*) n FROM bank_reconciliation_matches WHERE source_kind = 'bill_payment' AND source_id = ?", [paymentId]);
  return Number(m.n) > 0;
}

const HEADER_EDIT_FIELDS = ['date_created', 'payment_type', 'payee_name', 'office_location_id', 'ap_account_id', 'bank_account_id',
  'payment_method_id', 'reference_no', 'check_date', 'check_no', 'memo'];
// Once the bank statement has been matched to this payment, the money side is fixed: changing what
// was paid, from which account, or when, would silently unbalance a finished reconciliation.
const MONEY_FIELDS = ['date_created', 'bank_account_id'];

// Editing a saved payment: undo what it applied, apply what the edit says, in one transaction --
// the same arithmetic as void followed by a fresh payment, but keeping the payment's number and
// history. Header fields are written as sent; every change is logged field by field.
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[bp]] = await conn.query('SELECT * FROM bill_payments WHERE id = ?', [req.params.id]);
    if (!bp) return res.status(404).json({ error: 'Not found' });
    if (bp.status === 'voided') return res.status(409).json({ error: 'This Bill Payment is voided and cannot be edited.' });

    const body = req.body;
    if (!body.bank_account_id || !body.payment_method_id) return res.status(400).json({ error: 'Bank Account and Payment Method are required.' });
    const applyLines = (Array.isArray(body.apply_lines) ? body.apply_lines : []).filter((l) => l.vendor_bill_id && Number(l.applied_amount) > 0);
    const debitLines = (Array.isArray(body.debit_lines) ? body.debit_lines : []).filter((l) => l.bill_credit_id && Number(l.applied_amount) > 0);
    if (!applyLines.length && !debitLines.length) return res.status(400).json({ error: 'Apply at least one amount to a bill or credit.' });
    const total = Number([...applyLines, ...debitLines].reduce((s, l) => s + Number(l.applied_amount), 0).toFixed(2));

    const newHeader = {};
    for (const f of HEADER_EDIT_FIELDS) {
      const v = body[f] === undefined ? bp[f] : (body[f] === '' ? null : body[f]);
      newHeader[f] = v;
    }
    newHeader.date_created = String(newHeader.date_created || bp.date_created).slice(0, 10);
    const day = (v) => (v == null ? null : String(v instanceof Date ? v.toISOString() : v).slice(0, 10));

    if (await isReconciled(conn, req.params.id)) {
      const changed = MONEY_FIELDS.filter((f) => String(day(bp[f]) ?? bp[f] ?? '') !== String(day(newHeader[f]) ?? newHeader[f] ?? ''));
      if (changed.length || Math.abs(total - Number(bp.total_amount)) > 0.005) {
        return res.status(409).json({ error: 'This payment is already matched on a bank reconciliation, so its date, bank account and amounts cannot change. Unmatch it there first; the other fields can still be edited.' });
      }
    }
    await assertPeriodOpen(bp.date_created, 'ap', conn);
    await assertPeriodOpen(newHeader.date_created, 'ap', conn);

    await conn.beginTransaction();
    // 1. Undo the old applications.
    const [oldLines] = await conn.query('SELECT vendor_bill_id, bill_credit_id, applied_amount FROM bill_payment_lines WHERE bill_payment_id = ?', [req.params.id]);
    // Each touched bill as it stands, so one this edit leaves owing exactly what it did keeps its
    // own status label (migrated bills say 'paid', the app writes 'paid_in_full').
    const touchedBills = [...new Set([...oldLines, ...applyLines].map((l) => Number(l.vendor_bill_id)).filter(Boolean))];
    const [billsBefore] = touchedBills.length ? await conn.query('SELECT id, amount_due, status FROM vendor_bills WHERE id IN (?)', [touchedBills]) : [[]];
    for (const l of oldLines) {
      if (l.vendor_bill_id) await reverseVendorBillApplication(conn, l.vendor_bill_id, Number(l.applied_amount));
      if (l.bill_credit_id) { await conn.query(`UPDATE bill_credits SET applied_amount = GREATEST(applied_amount - ?, 0), ${CREDIT_STATUS_SQL} WHERE id = ?`, [Number(l.applied_amount), l.bill_credit_id]); await syncChequeForCredit(conn, l.bill_credit_id); }
    }
    // 2. Apply the new ones -- same checks as a new payment, against the amounts as they now stand.
    for (const l of applyLines) {
      const [[vb]] = await conn.query(
        'SELECT COALESCE(po.supplier_id, vb.supplier_id) AS supplier_id FROM vendor_bills vb LEFT JOIN purchase_orders po ON po.id = vb.purchase_order_id WHERE vb.id = ?', [l.vendor_bill_id]);
      if (!vb || Number(vb.supplier_id) !== Number(bp.supplier_id)) throw Object.assign(new Error('One of the selected bills is not this vendor\'s.'), { status: 400 });
      await applyToVendorBill(conn, l.vendor_bill_id, Number(l.applied_amount));
    }
    for (const l of debitLines) {
      const [[bc]] = await conn.query('SELECT total_amount, applied_amount, status FROM bill_credits WHERE id = ?', [l.bill_credit_id]);
      if (!bc || bc.status !== 'open') throw Object.assign(new Error('One of the selected credits is no longer valid.'), { status: 400 });
      const remaining = Number(bc.total_amount) - Number(bc.applied_amount);
      if (Number(l.applied_amount) > remaining + 1e-9) throw Object.assign(new Error(`Applied Amount (${l.applied_amount}) exceeds this credit's remaining balance (${remaining.toFixed(2)}).`), { status: 409 });
      { await conn.query(`UPDATE bill_credits SET applied_amount = applied_amount + ?, ${CREDIT_STATUS_SQL} WHERE id = ?`, [Number(l.applied_amount), l.bill_credit_id]); await syncChequeForCredit(conn, l.bill_credit_id); }
    }
    for (const b of billsBefore) {
      await conn.query('UPDATE vendor_bills SET status = ? WHERE id = ? AND ABS(amount_due - ?) < 0.005', [b.status, b.id, b.amount_due]);
    }
    // 3. Header and lines.
    await conn.query(
      `UPDATE bill_payments SET ${HEADER_EDIT_FIELDS.map((f) => `${f} = ?`).join(', ')}, total_amount = ? WHERE id = ?`,
      [...HEADER_EDIT_FIELDS.map((f) => newHeader[f]), total, req.params.id]);
    await conn.query('DELETE FROM bill_payment_lines WHERE bill_payment_id = ?', [req.params.id]);
    for (const l of applyLines) await conn.query('INSERT INTO bill_payment_lines (bill_payment_id, vendor_bill_id, applied_amount) VALUES (?, ?, ?)', [req.params.id, l.vendor_bill_id, l.applied_amount]);
    for (const l of debitLines) await conn.query('INSERT INTO bill_payment_lines (bill_payment_id, bill_credit_id, applied_amount) VALUES (?, ?, ?)', [req.params.id, l.bill_credit_id, l.applied_amount]);

    // 4. History.
    for (const f of HEADER_EDIT_FIELDS) {
      const was = f.includes('date') ? day(bp[f]) : (bp[f] ?? null);
      const now = f.includes('date') ? day(newHeader[f]) : (newHeader[f] ?? null);
      if (String(was ?? '') !== String(now ?? '')) await logAudit(conn, { paymentId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: f, oldValue: was, newValue: now });
    }
    const sig = (rows) => rows.map((l) => `${l.vendor_bill_id ? `VB${l.vendor_bill_id}` : `BC${l.bill_credit_id}`}:${Number(l.applied_amount).toFixed(2)}`).sort().join(', ');
    const oldSig = sig(oldLines); const newSig = sig([...applyLines, ...debitLines]);
    if (oldSig !== newSig) await logAudit(conn, { paymentId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'applied_lines', oldValue: oldSig, newValue: newSig });
    if (Math.abs(total - Number(bp.total_amount)) > 0.005) await logAudit(conn, { paymentId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'total_amount', oldValue: bp.total_amount, newValue: total });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM bill_payments WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    conn.release();
  }
});

// Date Released on its own, the way the source system edits it: a payment is raised on one day
// and the money actually handed over on another, and that second date is set once it happens. Its
// own endpoint (the full edit is PUT /:id) so it stays editable at any time, on any payment.
//
// Clearing it back to empty is allowed: a release recorded by mistake has to be retractable, and
// the payment then reads as not yet released, which is what it is.
router.put('/:id/date-released', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const raw = req.body.date_released;
    const dateReleased = raw === '' || raw === null || raw === undefined ? null : String(raw).slice(0, 10);
    if (dateReleased && !/^\d{4}-\d{2}-\d{2}$/.test(dateReleased)) {
      return res.status(400).json({ error: 'Date Released must be a date.' });
    }

    const [[bp]] = await pool.query('SELECT status, date_released FROM bill_payments WHERE id = ?', [req.params.id]);
    if (!bp) return res.status(404).json({ error: 'Not found' });
    // Editable at any time, voided payments included (the user's rule, 2026-10-01): a wrong date
    // must always be correctable.

    await pool.query('UPDATE bill_payments SET date_released = ? WHERE id = ?', [dateReleased, req.params.id]);
    const conn = await pool.getConnection();
    try {
      await logAudit(conn, {
        paymentId: req.params.id, userId: req.user.id, eventType: 'Updated',
        fieldName: 'date_released', oldValue: bp.date_released, newValue: dateReleased,
      });
    } finally {
      conn.release();
    }
    res.json({ ok: true, date_released: dateReleased });
  } catch (err) {
    next(err);
  }
});

router.put('/:id/void', requireAuth, requirePermission(ROUTE, 'can_void'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[bp]] = await conn.query('SELECT status, date_created FROM bill_payments WHERE id = ?', [req.params.id]);
    if (bp) await assertPeriodOpen(bp.date_created, 'ap', conn);
    if (!bp) return res.status(404).json({ error: 'Not found' });
    if (bp.status === 'voided') return res.status(409).json({ error: 'This Bill Payment is already voided.' });

    const [lines] = await conn.query('SELECT vendor_bill_id, bill_credit_id, applied_amount FROM bill_payment_lines WHERE bill_payment_id = ?', [req.params.id]);

    await conn.beginTransaction();
    for (const l of lines) {
      if (l.vendor_bill_id) await reverseVendorBillApplication(conn, l.vendor_bill_id, Number(l.applied_amount));
      if (l.bill_credit_id) { await conn.query(`UPDATE bill_credits SET applied_amount = GREATEST(applied_amount - ?, 0), ${CREDIT_STATUS_SQL} WHERE id = ?`, [Number(l.applied_amount), l.bill_credit_id]); await syncChequeForCredit(conn, l.bill_credit_id); }
    }
    await conn.query("UPDATE bill_payments SET status = 'voided', voided_by_user_id = ?, voided_at = NOW() WHERE id = ?", [req.user.id, req.params.id]);
    await logAudit(conn, { paymentId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: 'open', newValue: 'voided' });
    // The payment keeps posting its DR AP / CR bank in its own period; this journal cancels it in
    // the period of the void, as a voided Cheque's does (lib/reversalJournal.js).
    const [[full]] = await conn.query('SELECT * FROM bill_payments WHERE id = ?', [req.params.id]);
    const reversal = await postReversalJournal(conn, {
      sourceType: 'bill_payment', sourceId: Number(req.params.id), sourceNo: full.bill_payment_no,
      glRows: await computeBillPaymentGl(full), documentDate: full.date_created, voidedAt: new Date(),
      reason: req.body?.reason || null, userId: req.user.id, locationId: full.office_location_id || null,
    });
    if (reversal) {
      await logAudit(conn, { paymentId: req.params.id, userId: req.user.id, eventType: 'Created', fieldName: 'reversal_journal_no', newValue: reversal.journalNo });
    }
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM bill_payments WHERE id = ?', [req.params.id]);
    res.json({ ...row, reversal_journal_no: reversal?.journalNo || null });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
