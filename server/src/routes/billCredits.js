const express = require('express');
const pool = require('../db');
const { syncBillCreditStatus, syncChequeForCredit } = require('../lib/billCreditStatus');
const { assignDocNo } = require('../lib/docNumber');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { assertPeriodOpen } = require('../lib/accountingPeriod');
const { computeBillCreditGl } = require('../lib/glImpact');
const { lineDepartmentError } = require('../lib/requireDepartment');

const router = express.Router();
// Reached from an Open Vendor Bill's "Bill Credit" button, confirmed against the real
// system's Bill Credit modal. Unlike Vendor Bill, its lines aren't tied to the source
// bill's own inventory items -- they're general-ledger expense lines against arbitrary
// Chart of Accounts entries, then applied against one or more of the vendor's open bills.
//
// Deliberate deviation from the real system (see schema.sql comment on bill_credits for
// the full story): applied_amount here is capped at the credit's own total_amount and
// rejected (not clamped) if exceeded, rather than the real system's default of silently
// letting a small credit "apply" the source bill's entire total.
const ROUTE = '/bill-credits';

async function logAudit(conn, { creditId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('BillCredit', ?, ?, ?, ?, ?, ?)`,
    [creditId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

function computeLineAmounts({ amount, taxRate, isWithhold, wtaxRate }) {
  const taxAmount = Number((Number(amount || 0) * (Number(taxRate || 0) / 100)).toFixed(2));
  const grossAmount = Number((Number(amount || 0) + taxAmount).toFixed(2));
  const wtaxAmount = isWithhold ? Number((Number(amount || 0) * (Number(wtaxRate || 0) / 100)).toFixed(2)) : 0;
  return { tax_amount: taxAmount, gross_amount: grossAmount, wtax_amount: wtaxAmount, amount_due: Number((grossAmount - wtaxAmount).toFixed(2)) };
}

// A credit's expense lines, totals and applications, worked out from what the form posted.
// Shared by create and edit so the two can never compute a credit differently. Throws a
// status-tagged error for a credit with no lines or one applied beyond its own total.
async function buildCredit(conn, { expenseLines, applyLines, wtaxId, amount }) {
  const submittedExpenses = (Array.isArray(expenseLines) ? expenseLines : []).filter((l) => l.account_id && Number(l.amount) > 0);
  // Every expense line needs a department (lib/requireDepartment.js); create and edit both build here.
  const deptError = lineDepartmentError(submittedExpenses);
  if (deptError) throw Object.assign(new Error(deptError), { status: 400 });
  // A credit may be saved with no expense lines (asked 2026-10-06) -- its total is then 0.00, so the
  // Total Applied check below still stops it applying anything until lines are added by Edit.

  const taxCodeIds = [...new Set(submittedExpenses.map((l) => l.tax_code_id).filter(Boolean))];
  const taxRateById = new Map();
  if (taxCodeIds.length) {
    const [taxRows] = await conn.query('SELECT id, rate FROM taxes WHERE id IN (?)', [taxCodeIds]);
    taxRows.forEach((t) => taxRateById.set(t.id, Number(t.rate)));
  }
  let wtaxRate = 0;
  let wtaxDescription = null;
  if (wtaxId) {
    const [[wt]] = await conn.query('SELECT rate, name FROM withholding_taxes WHERE id = ?', [wtaxId]);
    wtaxRate = Number(wt?.rate) || 0;
    wtaxDescription = wt?.name || null;
  }

  const computedLines = submittedExpenses.map((l) => ({
    account_id: l.account_id, department_id: l.department_id || null, amount: Number(l.amount),
    tax_code_id: l.tax_code_id || null, is_withhold: !!l.is_withhold,
    ...computeLineAmounts({ amount: l.amount, taxRate: l.tax_code_id ? taxRateById.get(l.tax_code_id) : 0, isWithhold: l.is_withhold, wtaxRate }),
  }));

  let subtotal = computedLines.reduce((s, l) => s + l.amount, 0);
  const taxAmount = computedLines.reduce((s, l) => s + l.tax_amount, 0);
  const wtaxAmount = computedLines.reduce((s, l) => s + l.wtax_amount, 0);
  let totalAmount = Number((subtotal + taxAmount).toFixed(2));

  const submittedApply = (Array.isArray(applyLines) ? applyLines : []).filter((l) => l.vendor_bill_id && Number(l.applied_amount) > 0);

  // No expense lines but a typed Amount (asked 2026-10-06 -- the source raises credits this way,
  // BC-7431: 9,240.00 with no lines): the Amount is the credit's total, no VAT or withholding on it.
  // Its GL credits back what the bills it is applied to debited (glImpact typedCreditOffsets), so it
  // must be applied to at least one bill. Once it has expense lines, they decide the total.
  if (!computedLines.length && Number(amount) > 0) {
    if (!submittedApply.length) {
      throw Object.assign(new Error('A Bill Credit entered as an Amount, with no expense lines, must be applied to at least one bill.'), { status: 400 });
    }
    subtotal = Number(Number(amount).toFixed(2));
    totalAmount = subtotal;
  }
  const totalApplied = submittedApply.reduce((s, l) => s + Number(l.applied_amount), 0);
  if (totalApplied > totalAmount + 1e-9) {
    throw Object.assign(new Error(`Total Applied Amount (${totalApplied.toFixed(2)}) exceeds this credit's Total Amount (${totalAmount.toFixed(2)}).`), { status: 409 });
  }
  return { computedLines, subtotal, taxAmount, wtaxAmount, totalAmount, submittedApply, totalApplied, wtaxDescription };
}

async function insertCreditLines(conn, creditId, computedLines, submittedApply) {
  for (const l of computedLines) {
    await conn.query(
      `INSERT INTO bill_credit_lines
         (bill_credit_id, account_id, department_id, amount, tax_code_id, tax_amount, gross_amount, is_withhold, wtax_amount, amount_due)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [creditId, l.account_id, l.department_id, l.amount, l.tax_code_id, l.tax_amount, l.gross_amount, l.is_withhold, l.wtax_amount, l.amount_due]
    );
  }
  for (const l of submittedApply) {
    await conn.query(
      'INSERT INTO bill_credit_applications (bill_credit_id, vendor_bill_id, applied_amount) VALUES (?, ?, ?)',
      [creditId, l.vendor_bill_id, l.applied_amount]
    );
  }
}

// Why a credit can no longer be changed (or voided): it has been spent on a Bill Payment, or on a
// Cheque that still stands. Returns the message, or null when it is free to change.
async function creditInUse(conn, creditId, action) {
  const [[usedByPayments]] = await conn.query('SELECT COUNT(*) AS n FROM bill_payment_lines WHERE bill_credit_id = ? AND applied_amount > 0', [creditId]);
  if (usedByPayments.n > 0) return `This Bill Credit has already been used to offset a Bill Payment and cannot be ${action}.`;
  const [onCheques] = await conn.query(
    `SELECT c.cheque_no FROM cheque_bill_credits cbc JOIN cheques c ON c.id = cbc.cheque_id
      WHERE cbc.bill_credit_id = ? AND c.status <> 'void' LIMIT 1`, [creditId]).catch((e) => {
    if (e.code === 'ER_NO_SUCH_TABLE') return [[]];
    throw e;
  });
  if (onCheques.length) return `This Bill Credit has been used on Cheque ${onCheques[0].cheque_no} and cannot be ${action}. Remove it from the cheque first.`;
  return null;
}

// GL Impact computation lives in server/src/lib/glImpact.js (computeBillCreditGl),
// shared with the Reports engine so the reports can never drift from what this tab shows.
const computeGlImpact = computeBillCreditGl;

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
  const [[vb]] = await conn.query('SELECT amount_due FROM vendor_bills WHERE id = ?', [vendorBillId]);
  if (!vb) return;
  const newDue = Number((Number(vb.amount_due) + amount).toFixed(2));
  await conn.query(
    "UPDATE vendor_bills SET amount_due = ?, status = IF(status IN ('paid_in_full', 'paid') AND ? > 0.005, 'open', status) WHERE id = ?",
    [newDue, newDue, vendorBillId]
  );
}

router.get('/for-vendor-bill/:vbId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[vb]] = await pool.query(
      `SELECT vb.id, vb.bill_no, vb.office_location_id, vb.memo, vb.amount_due,
              COALESCE(po.supplier_id, vb.supplier_id) AS supplier_id, s.name AS supplier_name
       FROM vendor_bills vb
       LEFT JOIN purchase_orders po ON po.id = vb.purchase_order_id
       LEFT JOIN suppliers s ON s.id = COALESCE(po.supplier_id, vb.supplier_id)
       WHERE vb.id = ?`,
      [req.params.vbId]
    );
    if (!vb) return res.status(404).json({ error: 'Not found' });

    // Pre-fills the Create Bill Credit modal's own "A/P Account" picker. This is always
    // Accounts Payable itself (a credit reduces what's owed, the same liability account
    // Vendor Bill/Sales Invoice both treat as fixed elsewhere in this build) -- it was
    // previously defaulted to the *vendor bill's own* offset account instead, which
    // would make computeGlImpact() below debit e.g. "Inventory Received Not Billed"
    // against itself rather than against AP.
    const [[apAccount]] = await pool.query("SELECT id FROM chart_of_accounts WHERE account_code = '20100' LIMIT 1");
    vb.ap_account_id = apAccount?.id || null;

    const [applyLines] = await pool.query(
      `SELECT vb2.id AS vendor_bill_id, vb2.bill_no, vb2.date_created, vb2.date_due, vb2.gross_amount, vb2.amount_due
       FROM vendor_bills vb2
       LEFT JOIN purchase_orders po2 ON po2.id = vb2.purchase_order_id
       WHERE COALESCE(po2.supplier_id, vb2.supplier_id) = ? AND vb2.status = 'open'
       ORDER BY vb2.id DESC`,
      [vb.supplier_id]
    );

    res.json({ ...vb, apply_lines: applyLines });
  } catch (err) {
    next(err);
  }
});

// The Cheque screen's "Bill Credit" button: a credit for the cheque's Vendor payee, created from
// the cheque rather than from a bill. Pre-fills the same modal: vendor, office, memo, AP account,
// and the vendor's open bills to apply it to.
router.get('/for-cheque/:chequeId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[c]] = await pool.query(
      `SELECT c.id, c.cheque_no, c.office_location_id, c.memo, c.payee_type, c.payee_id, c.status, s.name AS supplier_name
         FROM cheques c LEFT JOIN suppliers s ON s.id = c.payee_id WHERE c.id = ?`, [req.params.chequeId]);
    if (!c) return res.status(404).json({ error: 'Not found' });
    if (!['VENDOR', 'supplier'].includes(String(c.payee_type)) || !c.payee_id) {
      return res.status(400).json({ error: 'A Bill Credit can only be made from a cheque whose Payee is a Vendor.' });
    }
    if (c.status === 'void') return res.status(409).json({ error: 'This cheque is voided.' });
    const [[apAccount]] = await pool.query("SELECT id FROM chart_of_accounts WHERE account_code = '20100' LIMIT 1");
    const [applyLines] = await pool.query(
      `SELECT vb2.id AS vendor_bill_id, vb2.bill_no, vb2.date_created, vb2.date_due, vb2.gross_amount, vb2.amount_due
       FROM vendor_bills vb2
       LEFT JOIN purchase_orders po2 ON po2.id = vb2.purchase_order_id
       WHERE COALESCE(po2.supplier_id, vb2.supplier_id) = ? AND vb2.status = 'open'
       ORDER BY vb2.id DESC`, [c.payee_id]);
    // The cheque's own expense lines start the credit's Expenses tab, so the credit mirrors what
    // was paid (account, department, amount, tax code, withholding) -- the biller trims or edits
    // them from there. They used to start empty.
    const [lines] = await pool.query(
      `SELECT cl.account_id, coa.account_code, coa.account_name, cl.department_id, cl.amount,
              cl.tax_code_id, t.rate AS tax_rate, cl.apply_withholding_tax AS is_withhold
         FROM cheque_lines cl
         LEFT JOIN chart_of_accounts coa ON coa.id = cl.account_id
         LEFT JOIN taxes t ON t.id = cl.tax_code_id
        WHERE cl.cheque_id = ? ORDER BY cl.line_no`, [c.id]);
    res.json({
      cheque_id: c.id, bill_no: c.cheque_no, supplier_id: c.payee_id, supplier_name: c.supplier_name,
      office_location_id: c.office_location_id, memo: c.memo, ap_account_id: apAccount?.id || null, apply_lines: applyLines,
      lines,
    });
  } catch (err) { next(err); }
});

// Whose credit it is: the vendor on its bill, or its own supplier_id when it came from a cheque.
const CREDIT_FROM_SQL = `FROM bill_credits bc
       LEFT JOIN vendor_bills vb ON vb.id = bc.vendor_bill_id
       LEFT JOIN purchase_orders po ON po.id = vb.purchase_order_id
       LEFT JOIN suppliers s ON s.id = COALESCE(po.supplier_id, vb.supplier_id, bc.supplier_id)
       LEFT JOIN cheques ch ON ch.id = bc.cheque_id`;

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, status } = req.query;
    const where = [];
    const params = [];
    if (status) { where.push('bc.status = ?'); params.push(status); }
    if (search) {
      where.push('(bc.bill_credit_no LIKE ? OR s.name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT bc.id, bc.bill_credit_no, bc.date_created, bc.total_amount, bc.applied_amount, bc.status,
              COALESCE(vb.bill_no, ch.cheque_no) AS bill_no, s.id AS supplier_id, s.name AS supplier_name
       ${CREDIT_FROM_SQL}
       ${whereSql}
       ORDER BY bc.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[bc]] = await pool.query(
      `SELECT bc.*, COALESCE(vb.bill_no, ch.cheque_no) AS bill_no, ch.cheque_no, s.name AS supplier_name, s.id AS vendor_id, s.tin,
              loc.location_name AS office_location_name,
              apcoa.account_code AS ap_account_code, apcoa.account_name AS ap_account_name
       ${CREDIT_FROM_SQL}
       LEFT JOIN locations loc ON loc.id = bc.office_location_id
       LEFT JOIN chart_of_accounts apcoa ON apcoa.id = bc.ap_account_id
       WHERE bc.id = ?`,
      [req.params.id]
    );
    if (!bc) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT bcl.*, coa.account_code, coa.account_name, d.name AS department_name, t.code AS tax_code
       FROM bill_credit_lines bcl
       LEFT JOIN chart_of_accounts coa ON coa.id = bcl.account_id
       LEFT JOIN departments d ON d.id = bcl.department_id
       LEFT JOIN taxes t ON t.id = bcl.tax_code_id
       WHERE bcl.bill_credit_id = ?`,
      [req.params.id]
    );

    const [applications] = await pool.query(
      `SELECT bca.*, vb2.bill_no
       FROM bill_credit_applications bca
       LEFT JOIN vendor_bills vb2 ON vb2.id = bca.vendor_bill_id
       WHERE bca.bill_credit_id = ?`,
      [req.params.id]
    );

    const glImpact = await computeGlImpact(bc, lines);
    res.json({ ...bc, gl_impact: glImpact, lines, applications });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'BillCredit' AND a.auditable_id = ?
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
      vendor_bill_id: vendorBillId, date_created: dateCreated, office_location_id: officeLocationId,
      ap_account_id: apAccountId, memo, wtax_id: wtaxId, expense_lines: expenseLines, apply_lines: applyLines,
      cheque_id: chequeId, amount,
    } = req.body;
    // Created from a Vendor Bill, or from a Cheque to a Vendor (which then names the supplier).
    let supplierId = null;
    if (!vendorBillId && chequeId) {
      const [[c]] = await conn.query('SELECT payee_type, payee_id, status FROM cheques WHERE id = ?', [chequeId]);
      if (!c) return res.status(400).json({ error: 'The cheque this credit is made from was not found.' });
      if (!['VENDOR', 'supplier'].includes(String(c.payee_type)) || !c.payee_id) return res.status(400).json({ error: 'A Bill Credit can only be made from a cheque whose Payee is a Vendor.' });
      if (c.status === 'void') return res.status(409).json({ error: 'This cheque is voided.' });
      supplierId = c.payee_id;
    } else if (!vendorBillId) return res.status(400).json({ error: 'Created From (Vendor Bill or Cheque) is required.' });

    const {
      computedLines, subtotal, taxAmount, wtaxAmount, totalAmount, submittedApply, totalApplied, wtaxDescription,
    } = await buildCredit(conn, { expenseLines, applyLines, wtaxId, amount });
    await assertPeriodOpen(dateCreated, 'ap', conn);

    await conn.beginTransaction();

    for (const l of submittedApply) {
      await applyToVendorBill(conn, l.vendor_bill_id, Number(l.applied_amount));
    }

    const [result] = await conn.query(
      `INSERT INTO bill_credits
         (bill_credit_no, vendor_bill_id, ${supplierId ? 'supplier_id, cheque_id, ' : ''}date_created, office_location_id, ap_account_id, memo, wtax_id,
          wtax_description, wtax_amount, subtotal, tax_amount, total_amount, applied_amount, created_by_user_id)
       VALUES ('', ?, ${supplierId ? '?, ?, ' : ''}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        vendorBillId || null, ...(supplierId ? [supplierId, chequeId] : []), dateCreated || new Date().toISOString().slice(0, 10), officeLocationId || null, apAccountId || null,
        memo || null, wtaxId || null, wtaxDescription, wtaxAmount, subtotal, taxAmount, totalAmount, totalApplied, req.user.id,
      ]
    );
    const creditId = result.insertId;
    await syncBillCreditStatus(conn, creditId); // Fully Applied when created fully applied
    await syncChequeForCredit(conn, creditId); // ...and so is the cheque it was made from
    const creditNo = await assignDocNo(conn, { table: 'bill_credits', column: 'bill_credit_no', prefix: 'BC-', id: creditId });

    await insertCreditLines(conn, creditId, computedLines, submittedApply);

    await logAudit(conn, { creditId, userId: req.user.id, eventType: 'Created', fieldName: 'bill_credit_no', newValue: creditNo });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM bill_credits WHERE id = ?', [creditId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    conn.release();
  }
});

// The Edit form: the saved credit with its lines, and the bills it may be applied to -- the
// vendor's open bills plus any this credit is already applied to, each with this credit's own
// application added back to its Amount Due so the form shows what is really available.
router.get('/:id/edit-form', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [[bc]] = await pool.query(
      `SELECT bc.*, COALESCE(vb.bill_no, ch.cheque_no) AS bill_no, s.name AS supplier_name,
              COALESCE(po.supplier_id, vb.supplier_id, bc.supplier_id) AS vendor_id,
              w.rate AS wtax_rate, w.name AS wtax_name
       ${CREDIT_FROM_SQL}
       LEFT JOIN withholding_taxes w ON w.id = bc.wtax_id
       WHERE bc.id = ?`, [req.params.id]);
    if (!bc) return res.status(404).json({ error: 'Not found' });
    const [lines] = await pool.query(
      `SELECT bcl.account_id, bcl.department_id, bcl.amount, bcl.tax_code_id, t.rate AS tax_rate, bcl.is_withhold
         FROM bill_credit_lines bcl LEFT JOIN taxes t ON t.id = bcl.tax_code_id
        WHERE bcl.bill_credit_id = ? ORDER BY bcl.id`, [req.params.id]);
    const [applied] = await pool.query(
      'SELECT vendor_bill_id, applied_amount FROM bill_credit_applications WHERE bill_credit_id = ?', [req.params.id]);
    const mine = new Map(applied.map((a) => [a.vendor_bill_id, Number(a.applied_amount)]));
    const [bills] = await pool.query(
      `SELECT vb2.id AS vendor_bill_id, vb2.bill_no, vb2.date_created, vb2.date_due, vb2.gross_amount, vb2.amount_due
         FROM vendor_bills vb2 LEFT JOIN purchase_orders po2 ON po2.id = vb2.purchase_order_id
        WHERE (COALESCE(po2.supplier_id, vb2.supplier_id) = ? AND vb2.status = 'open') OR vb2.id IN (?)
        ORDER BY vb2.id DESC`, [bc.vendor_id, mine.size ? [...mine.keys()] : [0]]);
    const applyLines = bills.map((b) => ({
      ...b, amount_due: Number((Number(b.amount_due) + (mine.get(b.vendor_bill_id) || 0)).toFixed(2)),
      applied_amount: mine.get(b.vendor_bill_id) || 0,
    }));
    res.json({ ...bc, lines, apply_lines: applyLines, in_use: await creditInUse(pool, req.params.id, 'edited') });
  } catch (err) { next(err); }
});

// Editing a saved credit. Its old applications are given back to their bills first, then the
// edited lines and applications are written exactly as a new credit's would be (buildCredit), all
// in one transaction -- so a refused application (more than a bill's Amount Due) leaves the
// credit and every bill as they were. Not allowed once the credit is void, spent on a Bill
// Payment or a standing Cheque, or in a closed period.
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const creditId = Number(req.params.id);
    const {
      date_created: dateCreated, office_location_id: officeLocationId, ap_account_id: apAccountId,
      memo, wtax_id: wtaxId, expense_lines: expenseLines, apply_lines: applyLines, amount,
    } = req.body;
    const [[bc]] = await conn.query('SELECT * FROM bill_credits WHERE id = ?', [creditId]);
    if (!bc) return res.status(404).json({ error: 'Not found' });
    if (bc.status === 'voided') return res.status(409).json({ error: 'This Bill Credit is voided and cannot be edited.' });
    const inUse = await creditInUse(conn, creditId, 'edited');
    if (inUse) return res.status(409).json({ error: inUse });

    const built = await buildCredit(conn, { expenseLines, applyLines, wtaxId, amount });
    const newDate = dateCreated || bc.date_created;
    await assertPeriodOpen(bc.date_created, 'ap', conn);
    await assertPeriodOpen(newDate, 'ap', conn);

    await conn.beginTransaction();
    const [oldApps] = await conn.query('SELECT vendor_bill_id, applied_amount FROM bill_credit_applications WHERE bill_credit_id = ?', [creditId]);
    for (const a of oldApps) await reverseVendorBillApplication(conn, a.vendor_bill_id, Number(a.applied_amount));
    for (const l of built.submittedApply) await applyToVendorBill(conn, l.vendor_bill_id, Number(l.applied_amount));

    await conn.query('DELETE FROM bill_credit_applications WHERE bill_credit_id = ?', [creditId]);
    await conn.query('DELETE FROM bill_credit_lines WHERE bill_credit_id = ?', [creditId]);
    await insertCreditLines(conn, creditId, built.computedLines, built.submittedApply);
    await conn.query(
      `UPDATE bill_credits SET date_created = ?, office_location_id = ?, ap_account_id = ?, memo = ?, wtax_id = ?,
         wtax_description = ?, wtax_amount = ?, subtotal = ?, tax_amount = ?, total_amount = ?, applied_amount = ?,
         status = ?
       WHERE id = ?`,
      [newDate, officeLocationId || null, apAccountId || null, memo || null, wtaxId || null, built.wtaxDescription,
        built.wtaxAmount, built.subtotal, built.taxAmount, built.totalAmount, built.totalApplied,
        bc.status,
        creditId]);
    // Open or Fully Applied from what the edit leaves applied (lib/billCreditStatus.js).
    await syncBillCreditStatus(conn, creditId);
    await syncChequeForCredit(conn, creditId);

    // One audit row per header figure that actually changed.
    const changes = [
      ['date_created', String(bc.date_created ?? '').slice(0, 10), String(newDate).slice(0, 10)],
      ['memo', bc.memo, memo || null],
      ['total_amount', Number(bc.total_amount).toFixed(2), built.totalAmount.toFixed(2)],
      ['applied_amount', Number(bc.applied_amount).toFixed(2), built.totalApplied.toFixed(2)],
    ].filter(([, o, n]) => String(o ?? '') !== String(n ?? ''));
    for (const [field, o, n] of changes) {
      await logAudit(conn, { creditId, userId: req.user.id, eventType: 'Updated', fieldName: field, oldValue: o, newValue: n });
    }
    if (!changes.length) await logAudit(conn, { creditId, userId: req.user.id, eventType: 'Updated' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM bill_credits WHERE id = ?', [creditId]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id/void', requireAuth, requirePermission(ROUTE, 'can_void'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[bc]] = await conn.query('SELECT status, date_created FROM bill_credits WHERE id = ?', [req.params.id]);
    if (bc) await assertPeriodOpen(bc.date_created, 'ap', conn);
    if (!bc) return res.status(404).json({ error: 'Not found' });
    if (bc.status === 'voided') return res.status(409).json({ error: 'This Bill Credit is already voided.' });

    const [applications] = await conn.query('SELECT vendor_bill_id, applied_amount FROM bill_credit_applications WHERE bill_credit_id = ?', [req.params.id]);
    // Spent on a Bill Payment, or on a Cheque still standing (a voided cheque has given its credits back).
    const inUse = await creditInUse(conn, req.params.id, 'voided');
    if (inUse) return res.status(409).json({ error: inUse });

    await conn.beginTransaction();
    for (const a of applications) {
      await reverseVendorBillApplication(conn, a.vendor_bill_id, Number(a.applied_amount));
    }
    await conn.query("UPDATE bill_credits SET status = 'voided', voided_by_user_id = ?, voided_at = NOW() WHERE id = ?", [req.user.id, req.params.id]);
    await syncChequeForCredit(conn, req.params.id); // its cheque is no longer applied by it
    await logAudit(conn, { creditId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: 'open', newValue: 'voided' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM bill_credits WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
