const express = require('express');
const { lineDepartmentError } = require('../lib/requireDepartment');
const pool = require('../db');
const { CREDIT_STATUS_SQL, syncChequeForCredit } = require('../lib/billCreditStatus');
const { assignDocNo } = require('../lib/docNumber');
const { requireAuth, requirePermission, isSystemAdmin, userCan } = require('../middleware/auth');
const { assertPeriodOpen } = require('../lib/accountingPeriod');
const { computeChequeGl, chequeCreditsByCheque } = require('../lib/glImpact');
const { postReversalJournal, mirror } = require('../lib/reversalJournal');
const { sendXlsx, day } = require('../lib/xlsxExport');
const { fundTransferPostError, hasLink } = require('../lib/fundTransferPosting');

const router = express.Router();
// Cheque (CHK-####): pays a payee for expense lines, drawn against a bank account. GL: DR each
// expense account (+ VAT input 14300 on tax) / CR Expanded Withholding Tax (21402) for any withheld
// / CR the bank account for the net cash paid.
const ROUTE = '/cheques';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (v) => Number(num(v).toFixed(2));
const trunc = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));

async function logAudit(conn, { chequeId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('Cheque', ?, ?, ?, ?, ?, ?)`,
    [chequeId, eventType, fieldName, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), userId]
  );
}

router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [bankAccounts] = await pool.query("SELECT id, account_code, account_name FROM chart_of_accounts WHERE detail_type = 'Bank' ORDER BY account_code");
    // Expense/posting accounts = non-summary (is_active unreliable in the migrated COA -- see Journal).
    const [accounts] = await pool.query('SELECT id, account_code, account_name, account_type FROM chart_of_accounts WHERE (is_summary = 0 OR is_summary IS NULL) ORDER BY account_code');
    const [departments] = await pool.query('SELECT id, name FROM departments WHERE is_active = TRUE ORDER BY name');
    const [locations] = await pool.query('SELECT id, location_name FROM locations ORDER BY location_name');
    const [vendors] = await pool.query('SELECT id, name FROM suppliers WHERE is_active = TRUE ORDER BY name');
    const [customers] = await pool.query('SELECT id, name FROM customers ORDER BY name');
    const [employees] = await pool.query("SELECT id, CONCAT(first_name, ' ', last_name) AS name FROM employees WHERE is_active = TRUE ORDER BY first_name, last_name");
    const [taxes] = await pool.query('SELECT id, code, rate FROM taxes ORDER BY code');
    res.json({ bankAccounts, accounts, departments, locations, vendors, customers, employees, taxes });
  } catch (err) { next(err); }
});

// The Payee is the linked vendor/customer/employee record; Payee Name is a separate free-typed
// field. Live prints both and they often differ (vendor YUTYCO, payee name the person who
// collected the cheque). Imported rows used to carry lower-case 'supplier'/'customer'/'employee'.
const PAYEE_ACCOUNT_NAME_SQL = `CASE
    WHEN c.payee_type IN ('VENDOR', 'supplier') THEN (SELECT s.name FROM suppliers s WHERE s.id = c.payee_id)
    WHEN c.payee_type IN ('CUSTOMER', 'customer') THEN (SELECT cu.name FROM customers cu WHERE cu.id = c.payee_id)
    WHEN c.payee_type IN ('EMPLOYEE', 'employee') THEN (SELECT CONCAT(e.first_name, ' ', e.last_name) FROM employees e WHERE e.id = c.payee_id)
  END`;

// Payee codes as stored: the form writes VENDOR / CUSTOMER / EMPLOYEE, migrated rows carried the
// lower-case names. One canonical code per kind for the list's Payee filter.
const PAYEE_KIND_SQL = `CASE
    WHEN c.payee_type IN ('VENDOR', 'supplier') THEN 'VENDOR'
    WHEN c.payee_type IN ('EMPLOYEE', 'employee') THEN 'EMPLOYEE'
    WHEN c.payee_type IN ('CUSTOMER', 'customer') THEN 'CUSTOMER'
  END`;
const PAYEE_KIND_ALIASES = { VENDOR: ['VENDOR', 'supplier'], EMPLOYEE: ['EMPLOYEE', 'employee'], CUSTOMER: ['CUSTOMER', 'customer'] };

// The list's Payee filter: every supplier / employee / customer that has at least one cheque --
// inactive ones included (a former employee's cheques still need finding), each with its count.
router.get('/payees', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT ${PAYEE_KIND_SQL} AS payee_type, c.payee_id, MAX(${PAYEE_ACCOUNT_NAME_SQL}) AS name, COUNT(*) AS cheques
         FROM cheques c
        WHERE c.payee_id IS NOT NULL AND ${PAYEE_KIND_SQL} IS NOT NULL
        GROUP BY payee_type, c.payee_id
        ORDER BY name`);
    res.json(rows.filter((r) => r.name));
  } catch (err) { next(err); }
});

// The list and its Excel extract share one query, so the file holds exactly what the list shows.
async function listCheques(query) {
  const req = { query };
  {
    const { search, status, as_of: asOf, date_from: dateFrom } = req.query;
    const where = [];
    const params = [];
    // Payee: one supplier / employee / customer (payee_type VENDOR|EMPLOYEE|CUSTOMER + payee_id).
    const kind = PAYEE_KIND_ALIASES[String(req.query.payee_type || '').toUpperCase()];
    if (kind && Number(req.query.payee_id)) {
      where.push('c.payee_type IN (?) AND c.payee_id = ?'); params.push(kind, Number(req.query.payee_id));
    } else if (kind) {
      where.push('c.payee_type IN (?)'); params.push(kind);
    }
    // Released = the cheque has gone out (Date Released set); not released = still in hand.
    if (req.query.released === 'released') where.push('c.date_released IS NOT NULL');
    if (req.query.released === 'not_released') where.push('c.date_released IS NULL');
    if (status) { where.push('c.status = ?'); params.push(status); }
    // Period From / As of Date: inclusive bounds on Date Created.
    if (dateFrom) { where.push('c.date_created >= ?'); params.push(String(dateFrom).slice(0, 10)); }
    if (asOf) { where.push('c.date_created <= ?'); params.push(String(asOf).slice(0, 10)); }
    if (search) { where.push('(c.cheque_no LIKE ? OR c.payee_name LIKE ? OR c.cheque_number LIKE ? OR c.memo LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT c.id, c.cheque_no, c.date_created, c.cheque_date, c.cheque_number, c.payee_name, c.total_amount, c.status, c.memo, c.date_released,
              coa.account_name, c.payee_type, c.payee_id, ${PAYEE_ACCOUNT_NAME_SQL} AS payee_account_name
       FROM cheques c LEFT JOIN chart_of_accounts coa ON coa.id = c.account_id
       ${whereSql} ORDER BY c.date_created DESC, c.id DESC`, // newest Date first (asked 2026-10-02); id breaks ties
      params
    );
    return rows;
  }
}

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    res.json(await listCheques(req.query));
  } catch (err) { next(err); }
});

// Extract: the list under its current filters, as a workbook. Registered before /:id.
router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const rows = await listCheques(req.query);
    const STATUS = { open: 'Open', fully_applied: 'Fully Applied', void: 'Void' };
    await sendXlsx(res, {
      filename: 'cheques.xlsx',
      sheet: 'Cheques',
      columns: [
        { header: 'Cheque No', key: 'no', width: 16 },
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
        no: r.cheque_no, date: day(r.date_created), cheque_date: day(r.cheque_date), cheque_number: r.cheque_number || '',
        payee: r.payee_account_name || r.payee_name || '', account: r.account_name || '', total: Number(r.total_amount || 0),
        released: day(r.date_released) || 'Not released', status: STATUS[r.status] || r.status, memo: r.memo || '',
      })),
    });
  } catch (err) {
    if (res.headersSent) { res.destroy(err); return; }
    next(err);
  }
});

// ---------------------------------------------------------------- bill credits on a cheque
// A Cheque to a Vendor may use up that vendor's open Bill Credits (cheque_bill_credits): each takes
// its applied amount off the credit's remaining balance and off the cash the cheque pays, and posts
// CR the credit's AP account. Same bookkeeping as a Bill Payment's credit lines.

const isVendor = (t) => ['VENDOR', 'supplier'].includes(String(t || ''));
// Whose credit it is: the vendor on its bill (the PO's supplier where the bill came from one), or,
// for a credit with no bill (made from a cheque), its own supplier_id.
const CREDIT_SUPPLIER_SQL = `COALESCE((SELECT COALESCE(po.supplier_id, vb.supplier_id) FROM vendor_bills vb
    LEFT JOIN purchase_orders po ON po.id = vb.purchase_order_id WHERE vb.id = bc.vendor_bill_id), bc.supplier_id)`;

async function chequeCredits(db, chequeId) {
  return (await chequeCreditsByCheque([Number(chequeId)])).get(Number(chequeId)) || [];
}

// [{ bill_credit_id, applied_amount }] from the request, positive amounts only.
function normalizeCredits(credits) {
  return (Array.isArray(credits) ? credits : [])
    .map((c) => ({ bill_credit_id: Number(c.bill_credit_id), applied_amount: round2(c.applied_amount) }))
    .filter((c) => c.bill_credit_id && c.applied_amount > 0);
}

// Take the credits up: each must be the payee vendor's, open, and have that much left.
async function applyCredits(conn, chequeId, supplierId, credits) {
  for (const c of credits) {
    const [[bc]] = await conn.query(
      `SELECT bc.bill_credit_no, bc.total_amount, bc.applied_amount, bc.status, ${CREDIT_SUPPLIER_SQL} AS supplier_id
         FROM bill_credits bc WHERE bc.id = ? FOR UPDATE`, [c.bill_credit_id]);
    if (!bc || bc.status !== 'open') throw Object.assign(new Error('One of the selected bill credits is no longer open.'), { status: 400 });
    if (Number(bc.supplier_id) !== Number(supplierId)) throw Object.assign(new Error(`${bc.bill_credit_no} is not this vendor's credit.`), { status: 400 });
    const remaining = round2(Number(bc.total_amount) - Number(bc.applied_amount));
    if (c.applied_amount > remaining + 0.001) throw Object.assign(new Error(`${bc.bill_credit_no} has only ${remaining.toFixed(2)} left to apply.`), { status: 409 });
    { await conn.query(`UPDATE bill_credits SET applied_amount = applied_amount + ?, ${CREDIT_STATUS_SQL} WHERE id = ?`, [c.applied_amount, c.bill_credit_id]); await syncChequeForCredit(conn, c.bill_credit_id); }
    try {
      await conn.query('INSERT INTO cheque_bill_credits (cheque_id, bill_credit_id, applied_amount) VALUES (?, ?, ?)', [chequeId, c.bill_credit_id, c.applied_amount]);
    } catch (e) {
      if (e.code === 'ER_NO_SUCH_TABLE') throw Object.assign(new Error('Bill credits on cheques are not set up on this server yet (src/db/create-cheque-bill-credits.js).'), { status: 503 });
      throw e;
    }
  }
}

// Give a cheque's credits back (edit, void). Returns what it had taken.
async function releaseCredits(conn, chequeId) {
  let rows = [];
  try {
    [rows] = await conn.query('SELECT bill_credit_id, applied_amount FROM cheque_bill_credits WHERE cheque_id = ?', [chequeId]);
  } catch (e) { if (e.code === 'ER_NO_SUCH_TABLE') return []; throw e; }
  for (const r of rows) { await conn.query(`UPDATE bill_credits SET applied_amount = GREATEST(applied_amount - ?, 0), ${CREDIT_STATUS_SQL} WHERE id = ?`, [Number(r.applied_amount), r.bill_credit_id]); await syncChequeForCredit(conn, r.bill_credit_id); }
  await conn.query('DELETE FROM cheque_bill_credits WHERE cheque_id = ?', [chequeId]);
  return rows;
}

// Credits on a cheque must belong to a Vendor payee, and leave something to pay.
function creditsError(b, credits, t) {
  if (!credits.length) return null;
  if (!isVendor(b.payee_type) || !b.payee_id) return 'Bill credits can only be applied when the Payee is a Vendor.';
  const credit = round2(credits.reduce((s, c) => s + c.applied_amount, 0));
  if (credit >= round2(t.gross_amount - t.withholding_tax_amount)) return 'The bill credits applied must be less than the amount the cheque pays.';
  return null;
}

// The vendor's open credits for the form, with what THIS cheque already uses counted as available.
router.get('/vendor-credits', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const supplierId = Number(req.query.supplier_id);
    if (!supplierId) return res.json([]);
    const chequeId = Number(req.query.cheque_id) || 0;
    const mine = new Map();
    if (chequeId) for (const c of await chequeCredits(pool, chequeId)) mine.set(Number(c.bill_credit_id), Number(c.applied_amount));
    const [rows] = await pool.query(
      `SELECT bc.id AS bill_credit_id, bc.bill_credit_no, bc.date_created, bc.memo, bc.total_amount, bc.applied_amount
         FROM bill_credits bc
        WHERE ${CREDIT_SUPPLIER_SQL} = ? AND (bc.status = 'open' AND bc.applied_amount < bc.total_amount OR bc.id IN (?))
          AND (bc.cheque_id IS NULL OR bc.cheque_id <> ?) -- not a credit made from this very cheque
        ORDER BY bc.date_created, bc.id`, [supplierId, [...mine.keys(), 0], chequeId]);
    res.json(rows.map((r) => ({
      bill_credit_id: r.bill_credit_id, bill_credit_no: r.bill_credit_no, date_created: r.date_created, memo: r.memo,
      total_amount: Number(r.total_amount),
      remaining: round2(Number(r.total_amount) - Number(r.applied_amount) + (mine.get(Number(r.bill_credit_id)) || 0)),
      applied_amount: mine.get(Number(r.bill_credit_id)) || 0,
    })));
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return res.json([]);
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[c]] = await pool.query(
      `SELECT c.*, coa.account_code, coa.account_name, loc.location_name,
              ${PAYEE_ACCOUNT_NAME_SQL} AS payee_account_name,
              CONCAT(u.display_name) AS created_by_name
       FROM cheques c
       LEFT JOIN chart_of_accounts coa ON coa.id = c.account_id
       LEFT JOIN locations loc ON loc.id = c.office_location_id
       LEFT JOIN users u ON u.id = c.created_by_user_id
       WHERE c.id = ?`,
      [req.params.id]
    );
    if (!c) return res.status(404).json({ error: 'Not found' });
    const [lines] = await pool.query(
      `SELECT cl.*, coa.account_code, coa.account_name, d.name AS department_name, t.code AS tax_code
       FROM cheque_lines cl
       LEFT JOIN chart_of_accounts coa ON coa.id = cl.account_id
       LEFT JOIN departments d ON d.id = cl.department_id
       LEFT JOIN taxes t ON t.id = cl.tax_code_id
       WHERE cl.cheque_id = ? ORDER BY cl.line_no`,
      [req.params.id]
    );

    // GL Impact (matches the live tab): DR expenses (+VAT input) / CR EWT / CR bank.
    //
    // Shown for voided cheques too. This tab documents what THIS cheque posted, and a void
    // does not un-post it: live keeps the original entries and reverses them with a separate
    // journal, which appears under Related Records. Blanking the tab on void hid the entries
    // for all 690 imported voided cheques even though their reversal is right there.
    // (The /void handler below now posts that reversal itself, so a cheque voided in-app reads
    // the same as an imported one -- it used to only flip the status, and the entry it left
    // behind had nothing reversing it.) The same function the ledger uses, bill credits included.
    const credits = await chequeCredits(pool, req.params.id);
    const gl = await computeChequeGl({ ...c, bank_code: c.account_code, bank_name: c.account_name }, lines, credits);
    res.json({ ...c, lines, credits, gl });
  } catch (err) { next(err); }
});

// The Payment Voucher and the BPI cheque face (client/src/pages/BillPaymentPrint.jsx, kind
// "cheque") -- the same two printouts as a Bill Payment. System Admin always; everyone else needs
// can_print on /cheques. A voided cheque still prints, marked VOID.
router.get('/:id/print', requireAuth, async (req, res, next) => {
  try {
    if (!(await isSystemAdmin(req.user.id)) && !(await userCan(req.user.id, ROUTE, 'can_print'))) {
      return res.status(403).json({ error: 'You do not have permission to print a Cheque.' });
    }
    const [[c]] = await pool.query(
      `SELECT c.*, coa.account_code AS bank_account_code, coa.account_name AS bank_account_name, loc.location_name,
              ${PAYEE_ACCOUNT_NAME_SQL} AS payee_account_name,
              u.display_name AS created_by_name, u.signature_data AS prepared_signature
         FROM cheques c
         LEFT JOIN chart_of_accounts coa ON coa.id = c.account_id
         LEFT JOIN locations loc ON loc.id = c.office_location_id
         LEFT JOIN users u ON u.id = c.created_by_user_id
        WHERE c.id = ?`, [req.params.id]);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const [lines] = await pool.query(
      `SELECT cl.*, coa.account_code, coa.account_name, d.name AS department_name
         FROM cheque_lines cl
         LEFT JOIN chart_of_accounts coa ON coa.id = cl.account_id
         LEFT JOIN departments d ON d.id = cl.department_id
        WHERE cl.cheque_id = ? ORDER BY cl.line_no`, [req.params.id]);
    res.json({ ...c, lines, credits: await chequeCredits(pool, req.params.id) });
  } catch (err) { next(err); }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'Cheque' AND a.auditable_id = ? ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    // A cheque brought over from the source has no Created entry (the importer logs nothing) -- its
    // own creator and time stand in, so System Info is never blank (2026-10-29, CHK-9206).
    if (!rows.some((r) => r.event_type === 'Created')) {
      const [[c]] = await pool.query(
        `SELECT c.cheque_no, c.created_at, u.display_name FROM cheques c LEFT JOIN users u ON u.id = c.created_by_user_id WHERE c.id = ?`,
        [req.params.id]);
      if (c) rows.push({ id: `created-${req.params.id}`, set_at: c.created_at, set_by_name: c.display_name || 'Imported from source', event_type: 'Created', field_name: 'cheque_no', old_value: null, new_value: c.cheque_no });
    }
    res.json(rows);
  } catch (err) { next(err); }
});

// Related Records: the journals raised against this cheque -- in practice the REVERSAL
// journal posted when it was voided. Live keeps no foreign key for this; the link is
// reconstructed at import time from the reversal's memo ("Voided from CHK-####") into
// journals.source_type/source_id, which is what this reads.
router.get('/:id/related', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT j.id, j.journal_no, j.date_created, j.status, j.memo, j.total_debit AS amount
         FROM journals j
        WHERE j.source_type = 'cheque' AND j.source_id = ?
        ORDER BY j.date_created DESC, j.id DESC`,
      [req.params.id]
    );
    // ...and the Bill Credits made from it (its "Bill Credit" button).
    const [credits] = await pool.query(
      `SELECT bc.id, bc.bill_credit_no, bc.date_created, bc.status, bc.total_amount AS amount
         FROM bill_credits bc WHERE bc.cheque_id = ? ORDER BY bc.id DESC`, [req.params.id],
    ).catch((e) => { if (e.code === 'ER_BAD_FIELD_ERROR') return [[]]; throw e; });
    res.json([
      ...credits.map((c) => ({ ...c, kind: 'bill_credit', doc_no: c.bill_credit_no, path: `/bill-credits/${c.id}` })),
      ...rows.map((r) => ({ ...r, kind: 'journal', doc_no: r.journal_no, path: `/journals/${r.id}` })),
    ]);
  } catch (err) { next(err); }
});

function normalizeLines(lines) {
  return (Array.isArray(lines) ? lines : [])
    .filter((l) => l.account_id && (num(l.amount) !== 0 || num(l.tax_amount) !== 0))
    .map((l) => {
      const amount = round2(l.amount);
      const taxAmount = round2(l.tax_amount);
      const wtax = round2(l.withholding_tax_amount);
      const gross = round2(amount + taxAmount);
      return {
        account_id: l.account_id, department_id: l.department_id || null, description: trunc(l.description, 500),
        amount, tax_code_id: l.tax_code_id || null, tax_amount: taxAmount,
        apply_withholding_tax: l.apply_withholding_tax ? 1 : 0, withholding_tax_amount: wtax,
        gross_amount: gross, total_amount: round2(gross - wtax),
      };
    });
}

// total_amount is the cash the cheque pays: gross, less withholding, less any bill credits used.
function headerTotals(rows, credits = []) {
  const net = round2(rows.reduce((s, l) => s + l.amount, 0));
  const tax = round2(rows.reduce((s, l) => s + l.tax_amount, 0));
  const wtax = round2(rows.reduce((s, l) => s + l.withholding_tax_amount, 0));
  const gross = round2(net + tax);
  const credit = round2(credits.reduce((s, c) => s + c.applied_amount, 0));
  return { subtotal: net, net_of_tax: net, tax_amount: tax, withholding_tax_amount: wtax, gross_amount: gross, credit_amount: credit, total_amount: round2(gross - wtax - credit) };
}

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body;
    const rows = normalizeLines(b.lines);
    if (!rows.length) return res.status(400).json({ error: 'Add at least one expense line with an account and amount.' });
    if (!b.account_id) return res.status(400).json({ error: 'Select the bank Account to draw the cheque against.' });
    const deptError = lineDepartmentError(rows); // every line (2026-10-07), not only budgeted accounts
    if (deptError) return res.status(400).json({ error: deptError });
    const credits = normalizeCredits(b.credits);
    const t = headerTotals(rows, credits);
    const crError = creditsError(b, credits, t);
    if (crError) return res.status(400).json({ error: crError });
    await assertPeriodOpen(b.date_created, 'other_gl');
    // Raised from an approved Fund Transfer Request (Create Check Voucher on the form, 2026-10-14):
    // it may not post more than the request has left (lib/fundTransferPosting.js).
    const formRequestId = Number(b.form_request_id) || null;
    if (formRequestId) {
      const why = await fundTransferPostError(conn, formRequestId, t.total_amount);
      if (why) return res.status(409).json({ error: why });
    }
    const linkForm = formRequestId && await hasLink(conn, 'cheques');

    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO cheques (cheque_no, date_created, payee_type, payee_id, payee_name, office_location_id, account_id,
         cheque_date, cheque_number, date_released, currency, conversion_rate, memo,
         subtotal, discount_amount, net_of_tax, tax_amount, withholding_tax_amount, gross_amount, total_amount, status, created_by_user_id${linkForm ? ', form_request_id' : ''})
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'open', ?${linkForm ? ', ?' : ''})`,
      [b.date_created || new Date().toISOString().slice(0, 10), trunc(b.payee_type, 20), b.payee_id || null, trunc(b.payee_name, 255),
       b.office_location_id || null, b.account_id, b.cheque_date || null, trunc(b.cheque_number, 60), b.date_released || null,
       trunc(b.currency, 10), num(b.conversion_rate) || 1, trunc(b.memo, 1000),
       t.subtotal, t.net_of_tax, t.tax_amount, t.withholding_tax_amount, t.gross_amount, t.total_amount, req.user.id,
       ...(linkForm ? [formRequestId] : [])]
    );
    const chequeId = r.insertId;
    const chequeNo = await assignDocNo(conn, { table: 'cheques', column: 'cheque_no', prefix: 'CHK-', id: chequeId });
    let lineNo = 0;
    for (const l of rows) {
      lineNo += 1;
      await conn.query(
        `INSERT INTO cheque_lines (cheque_id, line_no, account_id, department_id, description, amount, tax_code_id, tax_amount, apply_withholding_tax, withholding_tax_amount, gross_amount, total_amount)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [chequeId, lineNo, l.account_id, l.department_id, l.description, l.amount, l.tax_code_id, l.tax_amount, l.apply_withholding_tax, l.withholding_tax_amount, l.gross_amount, l.total_amount]
      );
    }
    await applyCredits(conn, chequeId, b.payee_id, credits);
    await logAudit(conn, { chequeId, userId: req.user.id, eventType: 'Created', fieldName: 'cheque_no', newValue: chequeNo });
    await conn.commit();
    res.status(201).json({ id: chequeId, cheque_no: chequeNo });
  } catch (err) {
    await conn.rollback();
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally { conn.release(); }
});

// Editing a saved cheque: header and expense lines rewritten, every change logged. The GL is
// derived from these rows (lib/glImpact.js), so nothing posted needs re-posting. A voided cheque
// is not editable -- its reversal journal was built from what it was. Once the bank statement is
// matched to it, its date, bank account and amount are fixed.
const CHEQUE_EDIT_FIELDS = ['date_created', 'payee_type', 'payee_id', 'payee_name', 'office_location_id', 'account_id',
  'cheque_date', 'cheque_number', 'date_released', 'currency', 'conversion_rate', 'memo'];
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body;
    const [[c]] = await conn.query('SELECT * FROM cheques WHERE id = ?', [req.params.id]);
    if (!c) return res.status(404).json({ error: 'Not found' });
    if (c.status === 'void') return res.status(409).json({ error: 'This cheque is voided and cannot be edited.' });
    const rows = normalizeLines(b.lines);
    if (!rows.length) return res.status(400).json({ error: 'Add at least one expense line with an account and amount.' });
    if (!b.account_id) return res.status(400).json({ error: 'Select the bank Account to draw the cheque against.' });
    // Department is required on every line, carried-over ones included (2026-10-07): a migrated
    // cheque with none must have them filled in before an edit can be saved.
    const deptError = lineDepartmentError(rows);
    if (deptError) return res.status(400).json({ error: deptError });
    // A request that does not mention credits keeps the ones the cheque has.
    const credits = b.credits === undefined
      ? normalizeCredits(await chequeCredits(conn, req.params.id))
      : normalizeCredits(b.credits);
    const t = headerTotals(rows, credits);
    const crError = creditsError(b, credits, t);
    if (crError) return res.status(400).json({ error: crError });
    const day = (v) => (v == null || v === '' ? null : String(v instanceof Date ? v.toISOString() : v).slice(0, 10));
    const next_ = {
      date_created: day(b.date_created) || day(c.date_created), payee_type: trunc(b.payee_type, 20), payee_id: b.payee_id || null,
      payee_name: trunc(b.payee_name, 255), office_location_id: b.office_location_id || null, account_id: b.account_id,
      cheque_date: day(b.cheque_date), cheque_number: trunc(b.cheque_number, 60), date_released: day(b.date_released),
      currency: trunc(b.currency, 10), conversion_rate: num(b.conversion_rate) || 1, memo: trunc(b.memo, 1000),
    };
    const [[m]] = await conn.query("SELECT COUNT(*) n FROM bank_reconciliation_matches WHERE source_kind = 'cheque' AND source_id = ?", [req.params.id]);
    if (Number(m.n) && (day(c.date_created) !== next_.date_created || Number(c.account_id) !== Number(next_.account_id)
        || Math.abs(Number(c.total_amount) - t.total_amount) > 0.005)) {
      return res.status(409).json({ error: 'This cheque is already matched on a bank reconciliation, so its date, bank account and amount cannot change. Unmatch it there first; the other fields can still be edited.' });
    }
    await assertPeriodOpen(c.date_created, 'other_gl', conn);
    await assertPeriodOpen(next_.date_created, 'other_gl', conn);

    await conn.beginTransaction();
    await conn.query(
      `UPDATE cheques SET ${CHEQUE_EDIT_FIELDS.map((f) => `${f} = ?`).join(', ')},
              subtotal = ?, net_of_tax = ?, tax_amount = ?, withholding_tax_amount = ?, gross_amount = ?, total_amount = ?
        WHERE id = ?`,
      [...CHEQUE_EDIT_FIELDS.map((f) => next_[f]), t.subtotal, t.net_of_tax, t.tax_amount, t.withholding_tax_amount, t.gross_amount, t.total_amount, req.params.id]);
    const [oldLines] = await conn.query('SELECT account_id, department_id, description, amount, tax_code_id, withholding_tax_amount FROM cheque_lines WHERE cheque_id = ? ORDER BY line_no', [req.params.id]);
    await conn.query('DELETE FROM cheque_lines WHERE cheque_id = ?', [req.params.id]);
    let lineNo = 0;
    for (const l of rows) {
      lineNo += 1;
      await conn.query(
        `INSERT INTO cheque_lines (cheque_id, line_no, account_id, department_id, description, amount, tax_code_id, tax_amount, apply_withholding_tax, withholding_tax_amount, gross_amount, total_amount)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [req.params.id, lineNo, l.account_id, l.department_id, l.description, l.amount, l.tax_code_id, l.tax_amount, l.apply_withholding_tax, l.withholding_tax_amount, l.gross_amount, l.total_amount]);
    }
    // Bill credits: give back what it had, take up what it has now (checked against what is left).
    const oldCredits = await releaseCredits(conn, req.params.id);
    await applyCredits(conn, req.params.id, b.payee_id, credits);
    const csig = (cs) => cs.map((x) => `BC${x.bill_credit_id}:${Number(x.applied_amount).toFixed(2)}`).sort().join(', ');
    if (csig(oldCredits) !== csig(credits)) await logAudit(conn, { chequeId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'bill_credits', oldValue: csig(oldCredits) || null, newValue: csig(credits) || null });
    for (const f of CHEQUE_EDIT_FIELDS) {
      const was = f.includes('date') ? day(c[f]) : c[f];
      if (String(was ?? '') !== String(next_[f] ?? '')) await logAudit(conn, { chequeId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: f, oldValue: was, newValue: next_[f] });
    }
    const sig = (ls) => ls.map((l) => `${l.account_id}/${l.department_id || ''}:${Number(l.amount).toFixed(2)}${Number(l.withholding_tax_amount) ? ` wtax ${Number(l.withholding_tax_amount).toFixed(2)}` : ''}`).join('; ');
    if (sig(oldLines) !== sig(rows)) await logAudit(conn, { chequeId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'expense_lines', oldValue: sig(oldLines).slice(0, 1000), newValue: sig(rows).slice(0, 1000) });
    if (Math.abs(Number(c.total_amount) - t.total_amount) > 0.005) await logAudit(conn, { chequeId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'total_amount', oldValue: c.total_amount, newValue: t.total_amount });
    await conn.commit();
    res.json({ id: Number(req.params.id), cheque_no: c.cheque_no });
  } catch (err) {
    await conn.rollback();
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally { conn.release(); }
});

// Date Released on its own, editable at any time and on any cheque (the user's rule): the money
// is released after the cheque is written, and a wrong date must always be correctable.
router.put('/:id/date-released', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const raw = req.body.date_released;
    const dateReleased = raw === '' || raw == null ? null : String(raw).slice(0, 10);
    if (dateReleased && !/^\d{4}-\d{2}-\d{2}$/.test(dateReleased)) return res.status(400).json({ error: 'Date Released must be a date.' });
    const [[c]] = await conn.query('SELECT date_released FROM cheques WHERE id = ?', [req.params.id]);
    if (!c) return res.status(404).json({ error: 'Not found' });
    await conn.query('UPDATE cheques SET date_released = ? WHERE id = ?', [dateReleased, req.params.id]);
    const was = c.date_released ? String(c.date_released instanceof Date ? c.date_released.toISOString() : c.date_released).slice(0, 10) : null;
    if (was !== dateReleased) await logAudit(conn, { chequeId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'date_released', oldValue: was, newValue: dateReleased });
    res.json({ ok: true, date_released: dateReleased });
  } catch (err) { next(err); } finally { conn.release(); }
});

// The cheque's GL Impact as its void will post it -- the same rows the void reverses below.
async function chequeGlRows(db, chequeId) {
  const [[fullCheque]] = await db.query(
    `SELECT c.*, coa.account_code AS bank_code, coa.account_name AS bank_name, loc.location_name AS office_location_name
       FROM cheques c
       LEFT JOIN chart_of_accounts coa ON coa.id = c.account_id
       LEFT JOIN locations loc ON loc.id = c.office_location_id
      WHERE c.id = ?`, [chequeId]);
  if (!fullCheque) return null;
  const [chequeLines] = await db.query(
    `SELECT cl.amount, cl.department_id, coa.account_code, coa.account_name
       FROM cheque_lines cl LEFT JOIN chart_of_accounts coa ON coa.id = cl.account_id
      WHERE cl.cheque_id = ? ORDER BY cl.line_no`, [chequeId]);
  const credits = await chequeCredits(db, chequeId);
  return { fullCheque, credits, glRows: await computeChequeGl(fullCheque, chequeLines, credits) };
}

// The Reversal Journal popup shown before a cheque is voided (asked 2026-10-08, as live shows it):
// the entry the void will post -- the cheque's GL Impact with debits and credits swapped, by the
// same mirror() the void posts with -- and the cheque's location to default the picker to.
router.get('/:id/reversal-preview', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const gl = await chequeGlRows(pool, req.params.id);
    if (!gl) return res.status(404).json({ error: 'Not found' });
    const rows = mirror(gl.glRows);
    const deptIds = [...new Set(rows.map((r) => r.department_id).filter(Boolean))];
    const [depts] = deptIds.length ? await pool.query('SELECT id, name FROM departments WHERE id IN (?)', [deptIds]) : [[]];
    const deptName = new Map(depts.map((d) => [Number(d.id), d.name]));
    const c = gl.fullCheque;
    res.json({
      doc_no: c.cheque_no,
      doc_date: c.date_created,
      location: c.office_location_id ? { id: c.office_location_id, location_name: c.office_location_name } : null,
      rows: rows.map((r) => ({ ...r, department_name: r.department_id ? deptName.get(Number(r.department_id)) || null : null })),
    });
  } catch (err) { next(err); }
});

// Void: from the Reversal Journal popup, which sends the reversal's date, location and memo
// (reversal_date / location_id / memo). Without them it behaves as it always has.
router.put('/:id/void', requireAuth, requirePermission(ROUTE, 'can_void'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[c]] = await conn.query('SELECT status, date_created FROM cheques WHERE id = ?', [req.params.id]);
    if (!c) return res.status(404).json({ error: 'Not found' });
    if (c.status === 'void') return res.status(409).json({ error: 'Already voided.' });
    await assertPeriodOpen(c.date_created, 'other_gl', conn);
    // The reversal's own date: never before the cheque's, and in an open period.
    const body = req.body || {};
    const reversalDateIn = /^\d{4}-\d{2}-\d{2}$/.test(String(body.reversal_date || '')) ? String(body.reversal_date) : null;
    if (reversalDateIn) {
      if (reversalDateIn < String(c.date_created).slice(0, 10)) {
        return res.status(400).json({ error: 'The reversal date cannot be before the cheque date.' });
      }
      await assertPeriodOpen(reversalDateIn, 'other_gl', conn);
    }
    await conn.beginTransaction();
    await conn.query("UPDATE cheques SET status = 'void', voided_at = NOW(), voided_by_user_id = ? WHERE id = ?", [req.user.id, req.params.id]);
    // The reversal the imported cheques always had, now written by the app that voids them rather
    // than only ever arriving from the live system. A void cheque keeps posting its own entry
    // (lib/glImpact.js) and this cancels it.
    // Its bill credits are reversed with the rest of its entry and go back to the vendor. The
    // rows stay, so the voided cheque's GL Impact still shows what it had used. Read BEFORE the
    // credits are given back, so the reversal mirrors exactly what the cheque posted.
    const { fullCheque, credits, glRows } = await chequeGlRows(conn, req.params.id);
    for (const cr of credits) { await conn.query(`UPDATE bill_credits SET applied_amount = GREATEST(applied_amount - ?, 0), ${CREDIT_STATUS_SQL} WHERE id = ?`, [Number(cr.applied_amount), cr.bill_credit_id]); await syncChequeForCredit(conn, cr.bill_credit_id); }
    const reversal = await postReversalJournal(conn, {
      sourceType: 'cheque', sourceId: Number(req.params.id), sourceNo: fullCheque.cheque_no,
      glRows,
      documentDate: fullCheque.date_created, voidedAt: new Date(),
      reason: String(body.memo || body.reason || '').trim() || null, userId: req.user.id,
      locationId: body.location_id ? Number(body.location_id) : (fullCheque.office_location_id || null),
      date: reversalDateIn,
    });
    await logAudit(conn, { chequeId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: c.status, newValue: 'void' });
    if (reversal) {
      await logAudit(conn, {
        chequeId: req.params.id, userId: req.user.id, eventType: 'Created',
        fieldName: 'reversal_journal_no', newValue: reversal.journalNo,
      });
    }
    await conn.commit();
    res.json({ ok: true, reversal_journal_no: reversal?.journalNo || null });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

module.exports = router;
