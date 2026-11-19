const express = require('express');
const pool = require('../db');
const { payableCustomerIds } = require('../lib/customerRelations');
const { grossDueSql, grossDue } = require('../lib/invoiceDue');
const { assignDocNo } = require('../lib/docNumber');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { computeCustomerPaymentGl } = require('../lib/glImpact');
const { assertPeriodOpen, requireOpenPeriod } = require('../lib/accountingPeriod');
const { resolveDefaultLocation } = require('../lib/userLocation');
const { headerDepartmentError } = require('../lib/requireDepartment');
const ExcelJS = require('exceljs');
const { companyWhere } = require('../lib/requestScope');

const router = express.Router();
// Reached from an Open Invoice's "Accept Payment" button -- the AR mirror of Bill
// Payment. One payment can settle several of the same customer's open invoices at once
// (the APPLY tab) and/or draw on that customer's existing open Credit Memos (the CREDITS
// tab).
const ROUTE = '/customer-payments';

// prepared_by_name / issued_by_name (add-customer-payment-people.js) hold the source's names on
// migrated payments. Read through these two expressions so a database the migration has not
// reached yet still serves the list and the payment -- names blank -- instead of a 500. Checked
// once, then remembered once found.
let peopleColumns = null;
async function peopleSql() {
  if (!peopleColumns) {
    const [cols] = await pool.query("SHOW COLUMNS FROM customer_payments LIKE 'issued_by_name'");
    if (!cols.length) return { prepared: 'u.display_name', issued: 'iu.display_name' };
    peopleColumns = { prepared: 'COALESCE(u.display_name, cp.prepared_by_name)', issued: 'COALESCE(iu.display_name, cp.issued_by_name)' };
  }
  return peopleColumns;
}

// The page asks for ten. The cap exists so a hand-written page_size cannot ask for all 130,000
// back and undo the reason this endpoint is paged at all.
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 200;

// A date filter that is not a date is a typo or a stale bookmark, not a reason to fail the
// request: MySQL rejects 'notadate' in a DATE comparison and the whole list 500s. Anything that
// is not YYYY-MM-DD is dropped, so the page comes back unfiltered rather than broken.
const asDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);

async function logAudit(conn, { paymentId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('CustomerPayment', ?, ?, ?, ?, ?, ?)`,
    [paymentId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// An invoice's Amount Due as the invoice view shows it: GROSS -- Gross Amount less what payments and
// credit memos have applied to it, the balance AR Aging carries (lib/invoiceDue.js, 2026-10-12). It
// used to be the cash balance plus EWT only while cash was still owed, so a paid invoice's withheld
// EWT read 0 due and its EWT credit memo had nothing to apply to (INV-80196, CM-5608).
const dueSql = grossDueSql;

// Draws an invoice's Amount Due down and flips it to paid_in_full when it lands at zero.
// Rejects rather than clamps an over-application, the same discipline used for every
// other amount cap in this codebase.
//
// Up to the GROSS Amount Due (balance + EWT), not just the balance (asked 2026-10-05): a customer
// who pays without withholding pays the EWT in cash too. What is applied past the stored balance
// comes off the invoice's EWT -- it was not withheld after all. The invoice's GL debits AR at
// gross and carries no EWT (computeSalesInvoiceGl), so this moves no entry; it only stops the
// invoice reading as still owed its EWT.
async function applyToInvoice(conn, invoiceId, amount) {
  const [[si]] = await conn.query('SELECT invoice_no, amount_due, ewt_amount, status FROM sales_invoices WHERE id = ?', [invoiceId]);
  if (!si) throw Object.assign(new Error('One of the selected invoices is no longer valid.'), { status: 400 });
  if (si.status === 'cancelled') throw Object.assign(new Error(`${si.invoice_no} is void and cannot be paid.`), { status: 409 });
  const balance = Number(si.amount_due);
  const due = await grossDue(conn, invoiceId);
  if (amount > due + 1e-9) {
    throw Object.assign(new Error(`Applied Amount (${amount}) exceeds ${si.invoice_no}'s remaining Amount Due (${due.toFixed(2)}).`), { status: 409 });
  }
  const pastBalance = Math.max(Number((amount - balance).toFixed(2)), 0);
  const newDue = Math.max(Number((balance - amount).toFixed(2)), 0);
  await conn.query(
    "UPDATE sales_invoices SET amount_due = ?, ewt_amount = GREATEST(COALESCE(ewt_amount, 0) - ?, 0), status = IF(? <= 0.005, 'paid_in_full', status) WHERE id = ?",
    [newDue, pastBalance, newDue, invoiceId]
  );
}

// Validates what is being applied and works out the three figures that must agree: what was
// applied, what cash was received, and what is left sitting on account. Shared by create and
// edit -- these are money, and two copies of the arithmetic would eventually disagree.
//
// An edit calls this AFTER reversing its own previous application, so every balance checked here
// is the balance as it would be if this payment had never existed. That ordering is what lets an
// unchanged payment be re-saved: check first and the invoice it settles no longer has the
// balance it is settling, so its own application reads as an over-application.
async function prepareApplication(conn, { applyLines, creditLines, refundLines, paymentAmount, customerId }) {
  const submittedApply = (Array.isArray(applyLines) ? applyLines : [])
    .filter((l) => l.sales_invoice_id && Number(l.applied_amount) > 0);
  // One line per refund: the same refund twice would each pass the amount-due check on its own.
  const refundById = new Map();
  for (const l of (Array.isArray(refundLines) ? refundLines : [])) {
    const id = Number(l.customer_refund_id);
    const amt = Number(Number(l.applied_amount).toFixed(2));
    if (id && amt > 0) refundById.set(id, Number(((refundById.get(id) || 0) + amt).toFixed(2)));
  }
  const submittedRefunds = [...refundById].map(([id, amt]) => ({ customer_refund_id: id, applied_amount: amt }));
  await checkRefundLines(conn, submittedRefunds, customerId);
  const submittedCredits = (Array.isArray(creditLines) ? creditLines : [])
    .filter((l) => l.credit_memo_id && Number(l.applied_amount) > 0);

  // Nothing applied is allowed: the whole payment then sits unapplied, on account (an advance, or
  // cash for invoices not raised yet), and posts to 23000 Customer Deposits -- see
  // computeCustomerPaymentGl. What it cannot be is nothing at all.
  if (!submittedApply.length && !submittedCredits.length && !submittedRefunds.length && !(Number(paymentAmount) > 0)) {
    throw Object.assign(new Error('Enter a Payment Amount, or apply an amount to an invoice or credit.'), { status: 400 });
  }

  for (const l of submittedCredits) {
    const [[cm]] = await conn.query('SELECT gross_amount, applied_amount, status FROM credit_memos WHERE id = ?', [l.credit_memo_id]);
    if (!cm || cm.status !== 'open') {
      throw Object.assign(new Error('One of the selected credits is no longer valid.'), { status: 400 });
    }
    const remaining = Number(cm.gross_amount) - Number(cm.applied_amount);
    if (Number(l.applied_amount) > remaining + 1e-9) {
      throw Object.assign(
        new Error(`Applied Amount (${l.applied_amount}) exceeds this credit's remaining balance (${remaining}).`),
        { status: 409 },
      );
    }
  }

  const appliedTotal = Number(
    [...submittedApply, ...submittedCredits, ...submittedRefunds].reduce((s, l) => s + Number(l.applied_amount), 0).toFixed(2)
  );
  // The cash actually received. Defaults to what was applied when the form doesn't say
  // otherwise; anything beyond that is unapplied cash sitting on account.
  const received = paymentAmount === undefined || paymentAmount === null || paymentAmount === ''
    ? appliedTotal
    : Number(paymentAmount);
  const creditsTotal = Number(submittedCredits.reduce((s, l) => s + Number(l.applied_amount), 0).toFixed(2));
  // Credits offset the bill without cash changing hands, so they don't count against what was
  // received -- only the invoice-applied portion consumes the payment.
  const cashApplied = Number((appliedTotal - creditsTotal).toFixed(2));
  if (cashApplied > received + 1e-9) {
    throw Object.assign(new Error(
      `Applied Amount (${cashApplied}) exceeds the Payment Amount (${received}). Raise the payment or lower what you're applying.`,
    ), { status: 409 });
  }
  return {
    submittedApply,
    submittedCredits,
    submittedRefunds,
    appliedTotal,
    received,
    unapplied: Number((received - cashApplied).toFixed(2)),
  };
}

// Every field on the Customer Payment form is required except Deposit To, which may be left for
// the Bank Deposit (an undeposited receipt sits in 10006 Undeposited Funds meanwhile -- see
// computeCustomerPaymentGl). The method decides the rest: a cheque needs its bank, date and
// number, a method flagged requires_reference needs its reference. Checked here as well as on the
// form, since the form is one way in and this is the only one. Returns the first thing missing,
// or null.
//
// Payment Amount may be zero only when the payment is nothing but credit memos offsetting
// invoices -- that moves no cash, so there is no amount to have received.
const isChequeMethod = (name) => /^che(ck|que)$/.test(String(name || '').trim().toLowerCase());
async function missingRequired(conn, b) {
  const blank = (v) => v == null || String(v).trim() === '';
  if (blank(b.date_created)) return 'Date';
  if (!b.department_id) return 'Department';
  if (blank(b.memo)) return 'Memo';
  if (blank(b.receipt_type)) return 'Receipt';
  if (blank(b.or_no)) return 'OR #';
  if (blank(b.payment_type)) return 'Payment Type';
  if (!b.issued_by_user_id) return 'Issued By';
  const creditsOnly = (Array.isArray(b.credit_lines) && b.credit_lines.some((l) => Number(l.applied_amount) > 0))
    && !(Array.isArray(b.apply_lines) && b.apply_lines.some((l) => Number(l.applied_amount) > 0));
  if (!(Number(b.payment_amount) > 0) && !creditsOnly) return 'Payment Amount';
  if (!b.payment_method_id) return 'Payment Method';
  const [[m]] = await conn.query('SELECT name, requires_reference FROM payment_methods WHERE id = ?', [b.payment_method_id]);
  if (!m) return 'Payment Method';
  if (isChequeMethod(m.name)) {
    if (blank(b.bank_name)) return 'Bank';
    if (blank(b.cheque_date)) return 'Cheque Date';
    if (blank(b.cheque_no)) return 'Cheque No';
  } else if (m.requires_reference && blank(b.reference_no)) {
    return 'Reference No';
  }
  return null;
}

async function reverseInvoiceApplication(conn, invoiceId, amount) {
  const [[si]] = await conn.query('SELECT amount_due, status FROM sales_invoices WHERE id = ?', [invoiceId]);
  if (!si) return;
  const newDue = Number((Number(si.amount_due) + amount).toFixed(2));
  await conn.query(
    "UPDATE sales_invoices SET amount_due = ?, status = IF(status = 'paid_in_full' AND ? > 0.005, 'saved', status) WHERE id = ?",
    [newDue, newDue, invoiceId]
  );
}

// CUSTOMER REFUNDS as open items (asked 2026-11-05). A refund debits A/R like an invoice, so a
// payment can be applied to it: the line carries customer_refund_id, the amount counts as cash
// applied (it credits A/R in the payment's GL), and the refund's amount due is derived -- its
// amount less what non-voided payments apply to it -- so voiding or editing a payment needs no
// separate reversal. add-payment-refund-apply.js adds the column; until it has run, refunds are
// simply not offered.
let refundApplyReady = false;
async function refundsReady(q = pool) {
  if (!refundApplyReady) {
    const [c] = await q.query("SHOW COLUMNS FROM customer_payment_lines LIKE 'customer_refund_id'");
    refundApplyReady = c.length > 0;
  }
  return refundApplyReady;
}
const refundDueSql = (a) => `(${a}.refund_amount - COALESCE((SELECT SUM(rl.applied_amount) FROM customer_payment_lines rl
    JOIN customer_payments rp ON rp.id = rl.customer_payment_id
   WHERE rl.customer_refund_id = ${a}.id AND rp.status <> 'voided'), 0))`;

// The customer's (and its related customers') refunds with an amount still due -- plus, when
// editing, the ones this payment already applies to, so the form can show and reduce them.
async function openRefundLines(customerId, paymentId = 0) {
  if (!(await refundsReady())) return [];
  const [rows] = await pool.query(
    `SELECT cr.id AS customer_refund_id, cr.customer_refund_no, cr.date_created, cr.refund_amount,
            ${refundDueSql('cr')} AS amount_due, c.name AS customer_name,
            COALESCE(mine.applied_amount, 0) AS applied_by_this_payment
       FROM customer_refunds cr
       LEFT JOIN customers c ON c.id = cr.customer_id
       LEFT JOIN (SELECT customer_refund_id, SUM(applied_amount) AS applied_amount FROM customer_payment_lines
                   WHERE customer_payment_id = ? AND customer_refund_id IS NOT NULL GROUP BY customer_refund_id) mine
              ON mine.customer_refund_id = cr.id
      WHERE cr.customer_id IN (?) AND cr.status <> 'voided'
        AND (${refundDueSql('cr')} > 0.005 OR mine.customer_refund_id IS NOT NULL)
      ORDER BY (cr.customer_id = ?) DESC, cr.id DESC`,
    [Number(paymentId) || 0, await payableCustomerIds(customerId), Number(customerId)]);
  return rows;
}

// Checks refund lines against what each refund still has due (as it stands -- an edit has already
// removed this payment's own lines) and that each is this customer's or a related customer's.
async function checkRefundLines(conn, lines, customerId) {
  if (!lines.length) return;
  if (!(await refundsReady(conn))) throw Object.assign(new Error('Applying to Customer Refunds is not set up yet.'), { status: 409 });
  const ids = (await payableCustomerIds(customerId, conn)).map(Number);
  for (const l of lines) {
    const [[cr]] = await conn.query(
      `SELECT cr.customer_refund_no, cr.customer_id, cr.status, ${refundDueSql('cr')} AS due FROM customer_refunds cr WHERE cr.id = ?`,
      [l.customer_refund_id]);
    if (!cr) throw Object.assign(new Error('One of the selected refunds is no longer valid.'), { status: 400 });
    if (cr.status === 'voided') throw Object.assign(new Error(`${cr.customer_refund_no} is void.`), { status: 409 });
    if (!ids.includes(Number(cr.customer_id))) {
      throw Object.assign(new Error(`${cr.customer_refund_no} is not this customer's, or a customer on its Relationships.`), { status: 400 });
    }
    if (Number(l.applied_amount) > Number(cr.due) + 0.005) {
      throw Object.assign(new Error(`Applied Amount (${l.applied_amount}) exceeds ${cr.customer_refund_no}'s remaining Amount Due (${Number(cr.due).toFixed(2)}).`), { status: 409 });
    }
  }
}

// Powers the Customer Payment modal. Every one of this customer's still-open invoices is
// offered in the APPLY tab -- not just the one the button was pressed from -- because a
// single payment routinely settles several at once; the source invoice is flagged so the
// form can tick it by default.
router.get('/for-invoice/:invoiceId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[si]] = await pool.query(
      // An invoice raised from an Estimate has no Sales Order, so the customer comes from
      // whichever source it has. An INNER JOIN here made the payment form fail to load at all
      // for those invoices -- they could be raised but never collected.
      `SELECT si.id AS sales_invoice_id, si.invoice_no, si.office_location_id, si.department_id, si.memo,
              ${dueSql('si')} AS amount_due, COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id) AS customer_id, c.name AS customer_name,
              loc.location_name AS office_location_name, d.name AS department_name
       FROM sales_invoices si
       LEFT JOIN sales_orders so ON so.id = si.sales_order_id
       LEFT JOIN estimates e ON e.id = si.estimate_id
       LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id
       LEFT JOIN customers c ON c.id = COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id)
       LEFT JOIN locations loc ON loc.id = si.office_location_id
       LEFT JOIN departments d ON d.id = si.department_id
       WHERE si.id = ?`,
      [req.params.invoiceId]
    );
    if (!si) return res.status(404).json({ error: 'Not found' });

    const [applyLines] = await pool.query(
      // Same reason: an estimate-sourced invoice belongs in this customer's open items too,
      // otherwise a payment settling several invoices at once would silently skip it.
      `SELECT si2.id AS sales_invoice_id, si2.invoice_no, si2.date_created, si2.gross_amount, ${dueSql('si2')} AS amount_due,
              c.name AS customer_name
       FROM sales_invoices si2
       LEFT JOIN sales_orders so2 ON so2.id = si2.sales_order_id
       LEFT JOIN estimates e2 ON e2.id = si2.estimate_id
       LEFT JOIN non_standard_sales_orders ns2 ON ns2.id = si2.nsso_id
       LEFT JOIN customers c ON c.id = COALESCE(si2.customer_id, so2.customer_id, e2.customer_id, ns2.customer_id)
       WHERE COALESCE(si2.customer_id, so2.customer_id, e2.customer_id, ns2.customer_id) IN (?) AND si2.status != 'cancelled' AND ${dueSql('si2')} > 0.005
       ORDER BY (COALESCE(si2.customer_id, so2.customer_id, e2.customer_id, ns2.customer_id) = ?) DESC, si2.id DESC`,
      // This customer's open invoices, and its related customers' (lib/customerRelations.js).
      [await payableCustomerIds(si.customer_id), si.customer_id]
    );

    const [creditLines] = await pool.query(
      `SELECT id AS credit_memo_id, credit_memo_no, date_created, gross_amount, applied_amount,
              (gross_amount - applied_amount) AS remaining
       FROM credit_memos
       WHERE customer_id = ? AND status = 'open' AND applied_amount < gross_amount
       ORDER BY id DESC`,
      [si.customer_id]
    );

    res.json({
      ...si, creator_location: await resolveDefaultLocation(req.user.id), apply_lines: applyLines, credit_lines: creditLines,
      refund_lines: await openRefundLines(si.customer_id),
    });
  } catch (err) {
    next(err);
  }
});

// The same payload as /for-invoice, for a payment raised from the Customer Payments list rather
// than from one invoice's Accept Payment button. Nothing is pre-selected because nothing singled
// an invoice out -- the customer handed over money and the person entering it decides what it
// settles.
//
// Deliberately the SAME SHAPE, so one modal serves both ways in: apply_lines are all this
// customer's still-open invoices, credit_lines their open credit memos. sales_invoice_id and
// amount_due are the two fields that only make sense when an invoice started it, and they are
// absent here rather than faked.
//
// Declared above `/:id` -- Express matches in the order routes are registered, so a literal
// segment has to come first or `/:id` swallows it.
// Who can be named as having issued the receipt, for the "Issued By" picker on the payment form.
//
// The form used to read the full /users list for this, which is gated on the USERS ADMIN PAGE.
// That is the wrong gate: it meant anyone allowed to take a customer's money also had to be
// allowed to administer user accounts, and Accounting quite reasonably is not. The whole form
// died on that one 403 -- the fetches run in a Promise.all, so a single refusal takes the lot.
//
// Gated by the page it serves, like every other endpoint here, and it returns NAMES ONLY: the
// same display names already printed on every document in the system, not the account records
// /users hands to the admin screens.
router.get('/meta/issuers', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, display_name FROM users WHERE is_active = 1 ORDER BY display_name');
    res.json(rows);
  } catch (err) { next(err); }
});

// The Add Customer Payment button's customer picker. It used to load /customers -- every column of
// all 35,000 customers, 24 MB over the wire, so the picker sat on "No results" while it arrived --
// and that route also wants View on the Customers master list, which a cashier need not have. This
// is the three fields the picker shows, about 2 MB, under this page's own permission.
router.get('/meta/customers', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    // list_address: the same address the Customers list shows (default address, else the
    // customer's own Address / Bill To), so the picker can tell same-named customers apart.
    const [rows] = await pool.query(
      `SELECT c.id, c.customer_code, c.name,
              COALESCE((SELECT ca.address_line FROM customer_addresses ca WHERE ca.customer_id = c.id ORDER BY ca.is_default DESC, ca.id LIMIT 1),
                       NULLIF(c.address, ''), NULLIF(c.bill_to_address, '')) AS list_address
         FROM customers c ORDER BY c.name`);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/for-customer/:customerId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[customer]] = await pool.query(
      'SELECT id AS customer_id, name AS customer_name FROM customers WHERE id = ?', [req.params.customerId]);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const [applyLines] = await pool.query(
      // Reached from Customer Payments' own New button rather than from an invoice, and it has
      // to show the same open items the invoice-sourced form does -- estimate-sourced included.
      // `payment_id` puts this into EDIT mode. An invoice a payment already settled in full has
      // no Amount Due left, so the plain "open items" list would not offer it and the edit form
      // could not show -- let alone reduce -- what the payment is currently applying to it. The
      // invoices this payment settled are therefore included regardless of their balance, and
      // each row carries what this payment already draws from it, so the form can work out how
      // much is really available: amount_due plus its own existing application.
      // An invoice belongs to the customer it is BILLED to (si.customer_id) before its order's -- the
      // source bills some orders to another company (INV-81555..81558: ordered by MACTAN SEASCAPES,
      // billed to and paid by FILINVEST HOSPITALITY, CPAY-998), and those were missing here (2026-10-19).
      `SELECT si.id AS sales_invoice_id, si.invoice_no, si.bs_si_no, si.date_created, si.gross_amount, ${dueSql('si')} AS amount_due,
              c.name AS customer_name,
              COALESCE(mine.applied_amount, 0) AS applied_by_this_payment
         FROM sales_invoices si
         LEFT JOIN sales_orders so ON so.id = si.sales_order_id
         LEFT JOIN estimates e ON e.id = si.estimate_id
         LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id
         LEFT JOIN customers c ON c.id = COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id)
         LEFT JOIN customer_payment_lines mine
                ON mine.sales_invoice_id = si.id AND mine.customer_payment_id = ?
        WHERE COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id) IN (?) AND si.status != 'cancelled'
          AND (${dueSql('si')} > 0.005 OR mine.id IS NOT NULL)
        ORDER BY (COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id) = ?) DESC, si.id DESC`,
      // Its own invoices first, then those of the customers on its Relationships tab
      // (lib/customerRelations.js) -- a payment from this customer may settle theirs too.
      [req.query.payment_id || 0, await payableCustomerIds(req.params.customerId), Number(req.params.customerId)],
    );

    const [creditLines] = await pool.query(
      // Same reasoning as the invoices above: a credit this payment has already drawn to zero
      // still has to be offered, or an edit could not reduce its own draw on it.
      `SELECT cm.id AS credit_memo_id, cm.credit_memo_no, cm.date_created, cm.gross_amount, cm.applied_amount,
              (cm.gross_amount - cm.applied_amount) AS remaining,
              COALESCE(mine.applied_amount, 0) AS applied_by_this_payment
         FROM credit_memos cm
         LEFT JOIN customer_payment_lines mine
                ON mine.credit_memo_id = cm.id AND mine.customer_payment_id = ?
        WHERE cm.customer_id = ? AND cm.status = 'open'
          AND (cm.applied_amount < cm.gross_amount OR mine.id IS NOT NULL)
        ORDER BY cm.id DESC`,
      [req.query.payment_id || 0, req.params.customerId],
    );

    res.json({
      ...customer,
      office_location_id: null,
      department_id: null,
      memo: null,
      creator_location: await resolveDefaultLocation(req.user.id),
      apply_lines: applyLines,
      credit_lines: creditLines,
      refund_lines: await openRefundLines(req.params.customerId, req.query.payment_id),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/by-invoice/:invoiceId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT cp.id, cp.customer_payment_no, cp.date_created, cpl.applied_amount, cp.status
       FROM customer_payments cp
       JOIN customer_payment_lines cpl ON cpl.customer_payment_id = cp.id
       WHERE cpl.sales_invoice_id = ? ORDER BY cp.id DESC`,
      [req.params.invoiceId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// PAGED AT THE DATABASE, not in the browser. This list used to select every row and let the page
// slice ten out of it: 130,000 payments, 34.5 MB of JSON, several seconds of spinner, to draw a
// table ten rows tall. The count grows with every receipt the company writes, so the page got
// slower every day it was used.
//
// The response shape is { rows, total, page, page_size } -- the same shape the other paged lists
// in this codebase return -- because the footer still has to say how many pages there are, and
// that number no longer comes from rows.length.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.page_size) || DEFAULT_PAGE_SIZE));
    const { search, where, params } = listFilter(req.query);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // The COUNT only joins customers when the search needs it. That join is the whole cost of
    // counting: matching 130,000 payments to 21,000 customers took 734ms on a warm clone, and
    // every unfiltered page load paid it for a number that does not depend on the join at all.
    // With the join dropped the count is read straight off the payments table.
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM customer_payments cp
       ${search ? 'LEFT JOIN customers c ON c.id = cp.customer_id' : ''}
       ${whereSql}`,
      params
    );

    const people = await peopleSql();
    const [rows] = await pool.query(
      `SELECT cp.id, cp.customer_payment_no, cp.date_created, cp.or_no, cp.receipt_type, cp.payment_amount, cp.applied_amount,
              cp.unapplied_amount, cp.status, cp.customer_id, c.name AS customer_name, pm.name AS payment_method_name,
              d.name AS department_name, loc.location_name AS office_location_name,
              ${people.prepared} AS prepared_by_name, ${people.issued} AS issued_by_name
       FROM customer_payments cp
       LEFT JOIN customers c ON c.id = cp.customer_id
       LEFT JOIN payment_methods pm ON pm.id = cp.payment_method_id
       LEFT JOIN departments d ON d.id = cp.department_id
       LEFT JOIN locations loc ON loc.id = cp.office_location_id
       LEFT JOIN users u ON u.id = cp.created_by_user_id
       LEFT JOIN users iu ON iu.id = cp.issued_by_user_id
       ${whereSql}
       -- Latest payment date first, so today's are at the top (asked 2026-10-07). By id alone,
       -- migrated payments -- whose ids do not follow their dates -- sat above current ones.
       -- idx_customer_payments_date_created serves this (InnoDB appends id to the index).
       ORDER BY cp.date_created DESC, cp.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    res.json({ rows, total, page, page_size: pageSize });
  } catch (err) {
    next(err);
  }
});

// The list's filters as SQL, shared by the list and the Unapplied export so a download is always
// exactly what the screen was filtered to.
function listFilter(query) {
  const { search, status, department_id: departmentId, office_location_id: locationId } = query;
  const dateFrom = asDate(query.date_from);
  const dateTo = asDate(query.date_to);
  const where = [];
  { const cw = companyWhere('cp.office_location_id'); if (cw) where.push(cw); } // topbar company switcher
  const params = [];
  {
    // Unapplied / Applied (asked 2026-10-05) filter on how much of the payment is still unapplied,
    // not on its deposit status: Unapplied has money not yet put against an invoice, Applied has
    // all of it applied. A voided payment is neither.
    if (status === 'unapplied') where.push('cp.unapplied_amount > 0.005', "cp.status <> 'voided'");
    else if (status === 'applied') where.push('COALESCE(cp.unapplied_amount, 0) <= 0.005', "cp.status <> 'voided'");
    else if (status) { where.push('cp.status = ?'); params.push(status); }
    if (departmentId) { where.push('cp.department_id = ?'); params.push(departmentId); }
    // Location, not just department. Every one of the 130,000 imported payments carries an office
    // location and all but two carry no department at all, so department alone would be a filter
    // that returns nothing for the entire history. Payments raised through the form do set a
    // department, so that filter earns its place going forward -- this one works on both.
    if (locationId) { where.push('cp.office_location_id = ?'); params.push(locationId); }
    // Both ends inclusive, and each usable without the other -- "everything from March" and
    // "everything up to year end" are both things people ask for. date_created is a DATE, so
    // there is no end-of-day boundary to get wrong here.
    if (dateFrom) { where.push('cp.date_created >= ?'); params.push(dateFrom); }
    if (dateTo) { where.push('cp.date_created <= ?'); params.push(dateTo); }
    if (search) {
      // A search that reads as an amount ("9350", "135,044.64", "P1,023.75") also finds the payments
      // whose Total Amount is exactly that (asked 2026-11-17).
      const asAmount = String(search).replace(/[₱P,\s]/gi, '');
      const amount = /^\d+(\.\d{1,2})?$/.test(asAmount) ? Number(asAmount) : null;
      where.push(`(cp.customer_payment_no LIKE ? OR cp.or_no LIKE ? OR cp.si_bs_no LIKE ? OR c.name LIKE ?${amount != null ? ' OR cp.payment_amount = ?' : ''})`);
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
      if (amount != null) params.push(amount);
    }
  }
  return { search, where, params };
}

// A Provisional Receipt's number goes in its own PR # column, not with the OR / CR numbers
// (asked 2026-10-24): all three are kept in or_no, told apart by receipt_type.
const receiptNos = (r) => (/provisional/i.test(r.receipt_type || '')
  ? { or_no: '', pr_no: r.or_no || '' } : { or_no: r.or_no || '', pr_no: '' });

// Extract: EVERY payment under the list's current filters, as a workbook -- the whole list, where
// Extract Unapplied is only the part with money still on account. Same listFilter as the list, so
// the file holds exactly what the screen is filtered to, voids included when Status is ALL.
// Written as a stream: with no filter it is the whole table, ~130,000 rows.
// Registered before /:id, which would otherwise take "export" as a payment id.
router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { where, params } = listFilter(req.query);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT cp.customer_payment_no, cp.date_created, c.name AS customer_name, loc.location_name,
              d.name AS department_name, cp.receipt_type, cp.or_no, pm.name AS payment_method_name, cp.payment_amount,
              cp.applied_amount, cp.unapplied_amount, cp.status, cp.memo
       FROM customer_payments cp
       LEFT JOIN customers c ON c.id = cp.customer_id
       LEFT JOIN payment_methods pm ON pm.id = cp.payment_method_id
       LEFT JOIN departments d ON d.id = cp.department_id
       LEFT JOIN locations loc ON loc.id = cp.office_location_id
       ${whereSql}
       ORDER BY cp.date_created DESC, cp.id DESC`,
      params
    );

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="customer-payments.xlsx"');
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
    const ws = wb.addWorksheet('Customer Payments', { views: [{ state: 'frozen', ySplit: 1 }] });
    const money = { numFmt: '#,##0.00' };
    // The list's columns, in its order, plus Memo.
    ws.columns = [
      { header: 'Payment #', key: 'no', width: 18 },
      { header: 'Date Created', key: 'date', width: 13 },
      { header: 'Customer', key: 'customer', width: 38 },
      { header: 'Location', key: 'location', width: 22 },
      { header: 'Department', key: 'department', width: 20 },
      { header: 'OR / CR #', key: 'or_no', width: 14 },
      { header: 'PR #', key: 'pr_no', width: 14 },
      { header: 'Payment Method', key: 'method', width: 18 },
      { header: 'Payment Amount', key: 'payment', width: 16, style: money },
      { header: 'Applied Amount', key: 'applied', width: 16, style: money },
      { header: 'Unapplied Amount', key: 'unapplied', width: 17, style: money },
      { header: 'Status', key: 'status', width: 14 },
      { header: 'Memo', key: 'memo', width: 40 },
    ];
    ws.autoFilter = 'A1:M1';
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).commit();

    const STATUS = { not_deposited: 'Not Deposited', deposited: 'Deposited', voided: 'Void' };
    const day = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : '');
    for (const r of rows) {
      ws.addRow({
        no: r.customer_payment_no, date: day(r.date_created),
        customer: r.customer_name || '', location: r.location_name || '', department: r.department_name || '',
        ...receiptNos(r), method: r.payment_method_name || '',
        // Numbers, not preformatted strings, so the columns can be totalled.
        payment: Number(r.payment_amount || 0), applied: Number(r.applied_amount || 0),
        unapplied: Number(r.unapplied_amount || 0),
        status: STATUS[r.status] || r.status, memo: r.memo || '',
      }).commit();
    }
    ws.commit();
    await wb.commit();
  } catch (err) {
    // Once streaming has begun the status line is gone; cut the download short so a partial
    // file cannot pass for a complete one.
    if (res.headersSent) { res.destroy(err); return; }
    next(err);
  }
});

// Every payment with money still sitting unapplied, as a workbook -- the list's current filters
// (Location included) plus "unapplied above zero". Voided payments are left out even when the
// Status filter is ALL: a void holds no money on account whatever its unapplied column says.
// Registered before /:id, which would otherwise take "export-unapplied" as a payment id.
router.get('/export-unapplied', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { where, params } = listFilter(req.query);
    where.push('cp.unapplied_amount > 0.005', "cp.status <> 'voided'");
    const [rows] = await pool.query(
      `SELECT cp.customer_payment_no, cp.date_created, c.name AS customer_name, loc.location_name,
              d.name AS department_name, cp.receipt_type, cp.or_no, pm.name AS payment_method_name, cp.payment_amount,
              cp.applied_amount, cp.unapplied_amount, cp.status, cp.memo
       FROM customer_payments cp
       LEFT JOIN customers c ON c.id = cp.customer_id
       LEFT JOIN payment_methods pm ON pm.id = cp.payment_method_id
       LEFT JOIN departments d ON d.id = cp.department_id
       LEFT JOIN locations loc ON loc.id = cp.office_location_id
       WHERE ${where.join(' AND ')}
       ORDER BY loc.location_name, cp.date_created, cp.id`,
      params
    );

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Unapplied Payments');
    ws.columns = [
      { header: 'Payment #', key: 'no', width: 16 },
      { header: 'Date Created', key: 'date', width: 13 },
      { header: 'Customer', key: 'customer', width: 38 },
      { header: 'Location', key: 'location', width: 22 },
      { header: 'Department', key: 'department', width: 20 },
      { header: 'OR / CR #', key: 'or_no', width: 14 },
      { header: 'PR #', key: 'pr_no', width: 14 },
      { header: 'Payment Method', key: 'method', width: 18 },
      { header: 'Payment Amount', key: 'payment', width: 16 },
      { header: 'Applied Amount', key: 'applied', width: 16 },
      { header: 'Unapplied Amount', key: 'unapplied', width: 17 },
      { header: 'Status', key: 'status', width: 14 },
      { header: 'Memo', key: 'memo', width: 40 },
    ];
    ws.getRow(1).font = { bold: true };
    const STATUS = { not_deposited: 'Not Deposited', deposited: 'Deposited' };
    for (const r of rows) {
      ws.addRow({
        no: r.customer_payment_no, date: r.date_created ? String(r.date_created instanceof Date ? r.date_created.toISOString() : r.date_created).slice(0, 10) : '',
        customer: r.customer_name || '', location: r.location_name || '', department: r.department_name || '',
        ...receiptNos(r), method: r.payment_method_name || '',
        // Numbers with a display format, not preformatted strings, so the columns can be totalled.
        payment: Number(r.payment_amount || 0), applied: Number(r.applied_amount || 0), unapplied: Number(r.unapplied_amount || 0),
        status: STATUS[r.status] || r.status, memo: r.memo || '',
      });
    }
    ['payment', 'applied', 'unapplied'].forEach((k) => { ws.getColumn(k).numFmt = '#,##0.00'; });
    const totalRow = ws.addRow({ customer: `TOTAL (${rows.length} payment${rows.length === 1 ? '' : 's'})`,
      unapplied: rows.reduce((s, r) => s + Number(r.unapplied_amount || 0), 0) });
    totalRow.font = { bold: true };
    ws.autoFilter = { from: 'A1', to: `M${rows.length + 1}` };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="unapplied-customer-payments.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const people = await peopleSql();
    const [[cp]] = await pool.query(
      `SELECT cp.*, c.name AS customer_name, d.name AS department_name,
              loc.location_name AS office_location_name, pm.name AS payment_method_name,
              dep.account_code AS deposit_account_code, dep.account_name AS deposit_account_name,
              -- The T1S user when there is one; a migrated payment has only the source's names.
              ${people.issued} AS issued_by_name, ${people.prepared} AS created_by_name
       FROM customer_payments cp
       LEFT JOIN customers c ON c.id = cp.customer_id
       LEFT JOIN departments d ON d.id = cp.department_id
       LEFT JOIN locations loc ON loc.id = cp.office_location_id
       LEFT JOIN payment_methods pm ON pm.id = cp.payment_method_id
       LEFT JOIN chart_of_accounts dep ON dep.id = cp.deposit_account_id
       LEFT JOIN users iu ON iu.id = cp.issued_by_user_id
       LEFT JOIN users u ON u.id = cp.created_by_user_id
       WHERE cp.id = ?`,
      [req.params.id]
    );
    if (!cp) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT cpl.*, si.invoice_no, si.date_created AS invoice_date, si.gross_amount AS invoice_gross,
              cm.credit_memo_no${(await refundsReady()) ? ', rf.customer_refund_no, rf.date_created AS refund_date, rf.refund_amount' : ''}
       FROM customer_payment_lines cpl
       LEFT JOIN sales_invoices si ON si.id = cpl.sales_invoice_id
       LEFT JOIN credit_memos cm ON cm.id = cpl.credit_memo_id
       ${(await refundsReady()) ? 'LEFT JOIN customer_refunds rf ON rf.id = cpl.customer_refund_id' : ''}
       WHERE cpl.customer_payment_id = ?`,
      [req.params.id]
    );

    const glImpact = await computeCustomerPaymentGl(cp, lines);
    res.json({ ...cp, lines, gl_impact: glImpact });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'CustomerPayment' AND a.auditable_id = ?
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
      customer_id: customerId, date_created: dateCreated, department_id: departmentId,
      office_location_id: officeLocationId, ar_account_id: arAccountId, deposit_account_id: depositAccountId,
      receipt_type: receiptType, or_no: orNo, si_bs_no: siBsNo, payment_type: paymentType, issued_by_user_id: issuedByUserId,
      payment_method_id: paymentMethodId, payment_amount: paymentAmount, memo,
      // How the money actually arrived. Which of these the form collects depends on the method:
      // a reference for GCASH/Maya/Card/Online Deposit, the cheque trio for CHECK, neither for
      // cash. Stored as sent -- the form decides what to ask for off the payment_methods master
      // list, and re-deciding it here would mean two places to keep in step with that list.
      reference_no: referenceNo, bank_name: bankName, cheque_no: chequeNo, cheque_date: chequeDate,
      apply_lines: applyLines, credit_lines: creditLines, refund_lines: refundLines,
    } = req.body;

    if (!customerId) return res.status(400).json({ error: 'Customer is required.' });
    const deptError = headerDepartmentError(departmentId);
    if (deptError) return res.status(400).json({ error: deptError });
    const missing = await missingRequired(conn, req.body);
    if (missing) return res.status(400).json({ error: `${missing} is required.` });
    // Office Location is where the payment was TAKEN: the creating user's default location (the
    // same rule an Estimate's Office Location opens with). The form sends it; this covers a caller
    // that does not.
    const locationId = officeLocationId || (await resolveDefaultLocation(req.user.id))?.id || null;

    await assertPeriodOpen(dateCreated, 'ar', conn);

    // Shared with the edit path so the two can never disagree about what was applied, what was
    // received, and what is left on account.
    const { submittedApply, submittedCredits, submittedRefunds, appliedTotal, received, unapplied } =
      await prepareApplication(conn, { applyLines, creditLines, refundLines, paymentAmount, customerId });

    await conn.beginTransaction();

    for (const l of submittedApply) {
      await applyToInvoice(conn, l.sales_invoice_id, Number(l.applied_amount));
    }
    for (const l of submittedCredits) {
      await conn.query('UPDATE credit_memos SET applied_amount = applied_amount + ? WHERE id = ?', [Number(l.applied_amount), l.credit_memo_id]);
    }

    const [result] = await conn.query(
      `INSERT INTO customer_payments
         (customer_payment_no, date_created, customer_id, department_id, office_location_id, ar_account_id,
          deposit_account_id, receipt_type, or_no, payment_type, issued_by_user_id, payment_method_id,
          payment_amount, applied_amount, unapplied_amount, memo, created_by_user_id,
          reference_no, bank_name, cheque_no, cheque_date, si_bs_no)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        dateCreated || new Date().toISOString().slice(0, 10), customerId, departmentId || null,
        locationId, arAccountId || null, depositAccountId || null, receiptType || null,
        orNo || null, paymentType || null, issuedByUserId || req.user.id, paymentMethodId || null,
        received, appliedTotal, unapplied, memo || null, req.user.id,
        referenceNo || null, bankName || null, chequeNo || null, chequeDate || null, siBsNo || null,
      ]
    );
    const paymentId = result.insertId;
    const paymentNo = await assignDocNo(conn, { table: 'customer_payments', column: 'customer_payment_no', prefix: 'CPAY-', id: paymentId });

    for (const l of submittedApply) {
      await conn.query(
        'INSERT INTO customer_payment_lines (customer_payment_id, sales_invoice_id, applied_amount) VALUES (?, ?, ?)',
        [paymentId, l.sales_invoice_id, l.applied_amount]
      );
    }
    for (const l of submittedCredits) {
      await conn.query(
        'INSERT INTO customer_payment_lines (customer_payment_id, credit_memo_id, applied_amount) VALUES (?, ?, ?)',
        [paymentId, l.credit_memo_id, l.applied_amount]
      );
    }
    for (const l of submittedRefunds) {
      await conn.query(
        'INSERT INTO customer_payment_lines (customer_payment_id, customer_refund_id, applied_amount) VALUES (?, ?, ?)',
        [paymentId, l.customer_refund_id, l.applied_amount]);
    }

    await logAudit(conn, { paymentId, userId: req.user.id, eventType: 'Created', fieldName: 'customer_payment_no', newValue: paymentNo });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM customer_payments WHERE id = ?', [paymentId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    conn.release();
  }
});

// Office Location, editable on its own (asked 2026-10-03) -- also once the payment is deposited,
// when the full Edit is locked: where a receipt was taken moves no money on any invoice, deposit
// or account, so correcting it needs no void-and-re-key. Voided payments stay as they are.
router.get('/meta/locations', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT id, location_name FROM locations WHERE is_active = 1 ORDER BY location_name');
    res.json(rows);
  } catch (err) { next(err); }
});

router.put('/:id/office-location', requireAuth, requireOpenPeriod('customer_payments', 'ar'), requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const locationId = Number(req.body.office_location_id) || null;
    const [[cp]] = await conn.query(
      `SELECT cp.id, cp.status, cp.office_location_id, l.location_name FROM customer_payments cp
         LEFT JOIN locations l ON l.id = cp.office_location_id WHERE cp.id = ?`, [req.params.id]);
    if (!cp) return res.status(404).json({ error: 'Not found' });
    if (cp.status === 'voided') return res.status(409).json({ error: 'A voided Customer Payment cannot be edited.' });
    let newName = null;
    if (locationId) {
      const [[loc]] = await conn.query('SELECT location_name FROM locations WHERE id = ?', [locationId]);
      if (!loc) return res.status(400).json({ error: 'Choose a valid Office Location.' });
      newName = loc.location_name;
    }
    await conn.beginTransaction();
    await conn.query('UPDATE customer_payments SET office_location_id = ? WHERE id = ?', [locationId, cp.id]);
    await logAudit(conn, { paymentId: cp.id, userId: req.user.id, eventType: 'Updated', fieldName: 'office_location', oldValue: cp.location_name, newValue: newName });
    await conn.commit();
    res.json({ office_location_id: locationId, office_location_name: newName });
  } catch (err) {
    await conn.rollback().catch(() => {});
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id/void', requireAuth, requirePermission(ROUTE, 'can_void'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[cp]] = await conn.query('SELECT status, date_created FROM customer_payments WHERE id = ?', [req.params.id]);
    if (cp) await assertPeriodOpen(cp.date_created, 'ar', conn);
    if (!cp) return res.status(404).json({ error: 'Not found' });
    if (cp.status === 'voided') return res.status(409).json({ error: 'This Customer Payment is already voided.' });
    const priorStatus = cp.status;

    const [lines] = await conn.query(
      'SELECT sales_invoice_id, credit_memo_id, applied_amount FROM customer_payment_lines WHERE customer_payment_id = ?',
      [req.params.id]
    );

    await conn.beginTransaction();
    for (const l of lines) {
      if (l.sales_invoice_id) await reverseInvoiceApplication(conn, l.sales_invoice_id, Number(l.applied_amount));
      if (l.credit_memo_id) {
        await conn.query('UPDATE credit_memos SET applied_amount = GREATEST(applied_amount - ?, 0) WHERE id = ?', [Number(l.applied_amount), l.credit_memo_id]);
      }
    }
    await conn.query("UPDATE customer_payments SET status = 'voided', voided_by_user_id = ?, voided_at = NOW() WHERE id = ?", [req.user.id, req.params.id]);
    await logAudit(conn, { paymentId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: priorStatus, newValue: 'voided' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM customer_payments WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Apply to Invoice (asked 2026-10-03): put a payment's UNAPPLIED balance against the customer's
// open invoices -- also once it is deposited, which locks Edit. It only ADDS applications; nothing
// on the payment itself changes (date, amount, OR #, Department, Issued By...). Applying through
// the full Edit form re-saved every header field and cleared the Department and Issued By that a
// migrated payment carries only as source names.
//
// Ledger: a payment made in T1S posts its unapplied part to 23000 Customer Deposits on its own
// date, and applying moves that to Accounts Receivable on the SAME date -- so when the payment
// posts at all, its period must be open. A migrated payment's unapplied part posts nothing here.
router.put('/:id/apply', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[cp]] = await conn.query(
      'SELECT id, customer_id, status, date_created, unapplied_amount, applied_amount, deposit_account_id, created_by_user_id FROM customer_payments WHERE id = ?',
      [req.params.id]);
    if (!cp) return res.status(404).json({ error: 'Not found' });
    if (cp.status === 'voided') return res.status(409).json({ error: 'A voided Customer Payment cannot be applied.' });

    const raw = Array.isArray(req.body?.lines) ? req.body.lines : [];
    const lines = raw
      .map((l) => ({ sales_invoice_id: Number(l.sales_invoice_id) || 0, amount: Number(Number(l.applied_amount).toFixed(2)) }))
      .filter((l) => l.sales_invoice_id && l.amount > 0);
    // Customer Refunds too (2026-11-05): a line with customer_refund_id instead of an invoice.
    const refundById = new Map();
    for (const l of raw) {
      const rid = Number(l.customer_refund_id) || 0;
      const amt = Number(Number(l.applied_amount).toFixed(2));
      if (rid && amt > 0) refundById.set(rid, Number(((refundById.get(rid) || 0) + amt).toFixed(2)));
    }
    const refundLines = [...refundById].map(([rid, amt]) => ({ customer_refund_id: rid, applied_amount: amt }));
    if (!lines.length && !refundLines.length) return res.status(400).json({ error: 'Enter an amount to apply on at least one invoice or refund.' });
    const total = Number((lines.reduce((t, l) => t + l.amount, 0) + refundLines.reduce((t, l) => t + l.applied_amount, 0)).toFixed(2));
    const unapplied = Number(cp.unapplied_amount || 0);
    if (total > unapplied + 0.005) {
      return res.status(409).json({ error: `Applying ${total.toFixed(2)} is more than this payment's unapplied ${unapplied.toFixed(2)}.` });
    }
    if (cp.created_by_user_id || cp.deposit_account_id) await assertPeriodOpen(cp.date_created, 'ar', conn);

    // Only this customer's invoices -- or those of a customer on its Relationships tab
    // (lib/customerRelations.js).
    if (lines.length) {
      const [owned] = await conn.query(
        `SELECT si.id FROM sales_invoices si
           LEFT JOIN sales_orders so ON so.id = si.sales_order_id
           LEFT JOIN estimates e ON e.id = si.estimate_id
           LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id
          WHERE si.id IN (?) AND COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id) IN (?)`,
        [lines.map((l) => l.sales_invoice_id), await payableCustomerIds(cp.customer_id, conn)]);
      if (owned.length !== new Set(lines.map((l) => l.sales_invoice_id)).size) {
        return res.status(400).json({ error: 'Every invoice must belong to this payment’s customer, or a customer on its Relationships.' });
      }
    }
    await checkRefundLines(conn, refundLines, cp.customer_id);

    await conn.beginTransaction();
    for (const l of refundLines) {
      const [[mine]] = await conn.query(
        'SELECT id FROM customer_payment_lines WHERE customer_payment_id = ? AND customer_refund_id = ? LIMIT 1', [cp.id, l.customer_refund_id]);
      if (mine) await conn.query('UPDATE customer_payment_lines SET applied_amount = applied_amount + ? WHERE id = ?', [l.applied_amount, mine.id]);
      else await conn.query('INSERT INTO customer_payment_lines (customer_payment_id, customer_refund_id, applied_amount) VALUES (?, ?, ?)', [cp.id, l.customer_refund_id, l.applied_amount]);
    }
    for (const l of lines) {
      await applyToInvoice(conn, l.sales_invoice_id, l.amount);
      const [[mine]] = await conn.query(
        'SELECT id FROM customer_payment_lines WHERE customer_payment_id = ? AND sales_invoice_id = ? LIMIT 1', [cp.id, l.sales_invoice_id]);
      if (mine) await conn.query('UPDATE customer_payment_lines SET applied_amount = applied_amount + ? WHERE id = ?', [l.amount, mine.id]);
      else await conn.query('INSERT INTO customer_payment_lines (customer_payment_id, sales_invoice_id, applied_amount) VALUES (?, ?, ?)', [cp.id, l.sales_invoice_id, l.amount]);
    }
    await conn.query(
      'UPDATE customer_payments SET applied_amount = applied_amount + ?, unapplied_amount = GREATEST(unapplied_amount - ?, 0) WHERE id = ?',
      [total, total, cp.id]);
    await logAudit(conn, {
      paymentId: cp.id, userId: req.user.id, eventType: 'Updated', fieldName: 'applied to invoice',
      oldValue: unapplied.toFixed(2),
      newValue: `applied ${total.toFixed(2)} to ${[lines.length && `${lines.length} invoice(s)`, refundLines.length && `${refundLines.length} refund(s)`].filter(Boolean).join(' and ')}`,
    });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM customer_payments WHERE id = ?', [cp.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    conn.release();
  }
});

// Unapply (asked 2026-10-05): take an invoice -- or part of what was applied to it -- back off a
// payment, the reverse of Apply above, and like it allowed once the payment is deposited, when Edit
// is locked. Voiding was the only way before, and voiding a deposited receipt leaves the deposit
// counting money the payment no longer claims. Nothing about the receipt changes: the amount
// received, the deposit and the OR stay; the invoice's balance comes back and the amount returns to
// the payment's Unapplied balance (Customer Deposits in its ledger, which is derived on read).
router.put('/:id/unapply', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[cp]] = await conn.query(
      'SELECT id, status, date_created, unapplied_amount, deposit_account_id, created_by_user_id FROM customer_payments WHERE id = ?',
      [req.params.id]);
    if (!cp) return res.status(404).json({ error: 'Not found' });
    if (cp.status === 'voided') return res.status(409).json({ error: 'A voided Customer Payment cannot be unapplied.' });

    // A Customer Refund (2026-11-05): only this payment's line for it changes -- the refund's amount
    // due is derived from the lines, so it comes back on its own.
    const refundUn = (Array.isArray(req.body?.lines) ? req.body.lines : [])
      .map((l) => ({ customer_refund_id: Number(l.customer_refund_id) || 0, amount: Number(Number(l.amount).toFixed(2)) }))
      .filter((l) => l.customer_refund_id && l.amount > 0);
    if (refundUn.length) {
      if (!(await refundsReady(conn))) return res.status(409).json({ error: 'Applying to Customer Refunds is not set up yet.' });
      const [rmine] = await conn.query(
        'SELECT id, customer_refund_id, applied_amount FROM customer_payment_lines WHERE customer_payment_id = ? AND customer_refund_id IN (?)',
        [cp.id, refundUn.map((l) => l.customer_refund_id)]);
      for (const l of refundUn) {
        const applied = rmine.filter((m) => Number(m.customer_refund_id) === l.customer_refund_id).reduce((t, m) => t + Number(m.applied_amount), 0);
        if (l.amount > applied + 0.005) return res.status(409).json({ error: `Only ${applied.toFixed(2)} of this payment is applied to that refund.` });
      }
      if (cp.created_by_user_id || cp.deposit_account_id) await assertPeriodOpen(cp.date_created, 'ar', conn);
      await conn.beginTransaction();
      let rtotal = 0;
      for (const l of refundUn) {
        let left = l.amount;
        for (const m of rmine.filter((x) => Number(x.customer_refund_id) === l.customer_refund_id)) {
          if (left <= 0.005) break;
          const cut = Math.min(Number(m.applied_amount), left);
          const rest = Number((Number(m.applied_amount) - cut).toFixed(2));
          if (rest <= 0.005) await conn.query('DELETE FROM customer_payment_lines WHERE id = ?', [m.id]);
          else await conn.query('UPDATE customer_payment_lines SET applied_amount = ? WHERE id = ?', [rest, m.id]);
          left = Number((left - cut).toFixed(2));
        }
        rtotal += l.amount;
      }
      rtotal = Number(rtotal.toFixed(2));
      await conn.query(
        'UPDATE customer_payments SET applied_amount = GREATEST(applied_amount - ?, 0), unapplied_amount = unapplied_amount + ? WHERE id = ?',
        [rtotal, rtotal, cp.id]);
      const [rnos] = await conn.query('SELECT customer_refund_no FROM customer_refunds WHERE id IN (?)', [refundUn.map((l) => l.customer_refund_id)]);
      await logAudit(conn, {
        paymentId: cp.id, userId: req.user.id, eventType: 'Updated', fieldName: 'unapplied from refund',
        oldValue: Number(cp.unapplied_amount || 0).toFixed(2), newValue: `unapplied ${rtotal.toFixed(2)} from ${rnos.map((x) => x.customer_refund_no).join(', ')}`,
      });
      await conn.commit();
      const [[rrow]] = await pool.query('SELECT * FROM customer_payments WHERE id = ?', [cp.id]);
      return res.json(rrow);
    }

    const lines = (Array.isArray(req.body?.lines) ? req.body.lines : [])
      .map((l) => ({ sales_invoice_id: Number(l.sales_invoice_id), amount: Number(Number(l.amount).toFixed(2)) }))
      .filter((l) => l.sales_invoice_id && l.amount > 0);
    if (!lines.length) return res.status(400).json({ error: 'Enter an amount to unapply on at least one invoice.' });

    const [mine] = await conn.query(
      'SELECT id, sales_invoice_id, applied_amount FROM customer_payment_lines WHERE customer_payment_id = ? AND sales_invoice_id IN (?)',
      [cp.id, lines.map((l) => l.sales_invoice_id)]);
    for (const l of lines) {
      const applied = mine.filter((m) => Number(m.sales_invoice_id) === l.sales_invoice_id)
        .reduce((t, m) => t + Number(m.applied_amount), 0);
      if (l.amount > applied + 0.005) {
        return res.status(409).json({ error: `Only ${applied.toFixed(2)} of this payment is applied to that invoice.` });
      }
    }
    if (cp.created_by_user_id || cp.deposit_account_id) await assertPeriodOpen(cp.date_created, 'ar', conn);

    await conn.beginTransaction();
    let total = 0;
    for (const l of lines) {
      await reverseInvoiceApplication(conn, l.sales_invoice_id, l.amount);
      // Taken off this payment's line(s) for the invoice, emptying (and removing) them in order.
      let left = l.amount;
      for (const m of mine.filter((x) => Number(x.sales_invoice_id) === l.sales_invoice_id)) {
        if (left <= 0.005) break;
        const cut = Math.min(Number(m.applied_amount), left);
        const rest = Number((Number(m.applied_amount) - cut).toFixed(2));
        if (rest <= 0.005) await conn.query('DELETE FROM customer_payment_lines WHERE id = ?', [m.id]);
        else await conn.query('UPDATE customer_payment_lines SET applied_amount = ? WHERE id = ?', [rest, m.id]);
        left = Number((left - cut).toFixed(2));
      }
      total += l.amount;
    }
    total = Number(total.toFixed(2));
    await conn.query(
      'UPDATE customer_payments SET applied_amount = GREATEST(applied_amount - ?, 0), unapplied_amount = unapplied_amount + ? WHERE id = ?',
      [total, total, cp.id]);
    const [nos] = await conn.query('SELECT invoice_no FROM sales_invoices WHERE id IN (?)', [lines.map((l) => l.sales_invoice_id)]);
    await logAudit(conn, {
      paymentId: cp.id, userId: req.user.id, eventType: 'Updated', fieldName: 'unapplied from invoice',
      oldValue: Number(cp.unapplied_amount || 0).toFixed(2), newValue: `unapplied ${total.toFixed(2)} from ${nos.map((x) => x.invoice_no).join(', ')}`,
    });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM customer_payments WHERE id = ?', [cp.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    conn.release();
  }
});

// Editing a payment that has not been deposited yet.
//
// WHY ONLY UNTIL IT IS DEPOSITED. A deposit sweeps the receipt into the bank and becomes the
// thing a bank statement is reconciled against; changing the amount underneath it would put the
// deposit and the bank out of step with nothing recording that it happened. Up to that point the
// receipt is still just a record of cash in the drawer, and correcting a mistyped amount or a
// wrong invoice is ordinary work -- which previously meant voiding and re-keying the whole thing,
// leaving a void in the ledger for what was really a typo.
//
// Applying a payment moves money on the invoices it settles, so an edit has to UNDO the old
// application before laying down the new one. Both happen in one transaction: a failure halfway
// would otherwise leave invoices credited for a payment that no longer claims them.
//
// No GL to unwind -- computeCustomerPaymentGl derives the entries on read rather than storing
// them, so the new figures are reflected the moment they are saved.
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[cp]] = await conn.query(
      'SELECT id, status, date_created, customer_id FROM customer_payments WHERE id = ?', [req.params.id],
    );
    if (!cp) return res.status(404).json({ error: 'Not found' });
    if (cp.status === 'voided') {
      return res.status(409).json({ error: 'A voided Customer Payment cannot be edited.' });
    }
    if (cp.status !== 'not_deposited') {
      return res.status(409).json({
        error: 'This payment has been deposited and can no longer be edited. Void it and re-enter if it is wrong.',
      });
    }

    const {
      date_created: dateCreated, department_id: departmentId, office_location_id: officeLocationId,
      ar_account_id: arAccountId, deposit_account_id: depositAccountId, receipt_type: receiptType,
      or_no: orNo, si_bs_no: siBsNo, payment_type: paymentType, issued_by_user_id: issuedByUserId,
      payment_method_id: paymentMethodId, payment_amount: paymentAmount, memo,
      reference_no: referenceNo, bank_name: bankName, cheque_no: chequeNo, cheque_date: chequeDate,
      apply_lines: applyLines, credit_lines: creditLines, refund_lines: refundLines,
    } = req.body;
    const deptError = headerDepartmentError(departmentId);
    if (deptError) return res.status(400).json({ error: deptError });
    const missing = await missingRequired(conn, req.body);
    if (missing) return res.status(400).json({ error: `${missing} is required.` });

    // Both periods: the one it sits in now and the one it is being moved to. Moving a receipt
    // out of a closed month is as much a change to that month as posting into one.
    await assertPeriodOpen(cp.date_created, 'ar', conn);
    if (dateCreated) await assertPeriodOpen(dateCreated, 'ar', conn);

    const [existing] = await conn.query(
      'SELECT sales_invoice_id, credit_memo_id, applied_amount FROM customer_payment_lines WHERE customer_payment_id = ?',
      [req.params.id],
    );
    await conn.beginTransaction();

    // Undo first, so the new application is checked against invoices and credits in the state
    // they would be in if this payment had never existed. Validating before the reversal would
    // reject re-saving an unchanged payment, because the invoice it settles no longer has the
    // balance it is settling.
    for (const l of existing) {
      if (l.sales_invoice_id) await reverseInvoiceApplication(conn, l.sales_invoice_id, Number(l.applied_amount));
      if (l.credit_memo_id) {
        await conn.query(
          'UPDATE credit_memos SET applied_amount = GREATEST(applied_amount - ?, 0) WHERE id = ?',
          [Number(l.applied_amount), l.credit_memo_id],
        );
      }
    }
    await conn.query('DELETE FROM customer_payment_lines WHERE customer_payment_id = ?', [req.params.id]);

    const { submittedApply, submittedCredits, submittedRefunds, appliedTotal, received, unapplied } =
      await prepareApplication(conn, { applyLines, creditLines, refundLines, paymentAmount, customerId: cp.customer_id });

    for (const l of submittedRefunds) {
      await conn.query(
        'INSERT INTO customer_payment_lines (customer_payment_id, customer_refund_id, applied_amount) VALUES (?, ?, ?)',
        [req.params.id, l.customer_refund_id, l.applied_amount]);
    }
    for (const l of submittedApply) {
      await applyToInvoice(conn, l.sales_invoice_id, Number(l.applied_amount));
      await conn.query(
        'INSERT INTO customer_payment_lines (customer_payment_id, sales_invoice_id, applied_amount) VALUES (?, ?, ?)',
        [req.params.id, l.sales_invoice_id, l.applied_amount],
      );
    }
    for (const l of submittedCredits) {
      await conn.query('UPDATE credit_memos SET applied_amount = applied_amount + ? WHERE id = ?', [Number(l.applied_amount), l.credit_memo_id]);
      await conn.query(
        'INSERT INTO customer_payment_lines (customer_payment_id, credit_memo_id, applied_amount) VALUES (?, ?, ?)',
        [req.params.id, l.credit_memo_id, l.applied_amount],
      );
    }

    await conn.query(
      `UPDATE customer_payments SET
         -- Department and Issued By keep what the payment has when the form sends none, as Office
         -- Location does below: an apply-only save must not clear them (2026-10-03).
         date_created = ?, department_id = COALESCE(?, department_id),
         -- Kept when the form sends none: it is where the payment was taken, fixed at creation.
         -- Writing the null through wiped it on every edit opened from the customer list.
         office_location_id = COALESCE(?, office_location_id), ar_account_id = ?,
         deposit_account_id = ?, receipt_type = ?, or_no = ?, payment_type = ?,
         issued_by_user_id = COALESCE(?, issued_by_user_id), payment_method_id = ?, payment_amount = ?, applied_amount = ?,
         unapplied_amount = ?, memo = ?, reference_no = ?, bank_name = ?, cheque_no = ?, cheque_date = ?, si_bs_no = ?
       WHERE id = ?`,
      [
        dateCreated || cp.date_created, departmentId || null, officeLocationId || null,
        arAccountId || null, depositAccountId || null, receiptType || null, orNo || null,
        paymentType || null, issuedByUserId || null, paymentMethodId || null,
        received, appliedTotal, unapplied, memo || null,
        referenceNo || null, bankName || null, chequeNo || null, chequeDate || null, siBsNo || null,
        req.params.id,
      ],
    );

    await logAudit(conn, { paymentId: req.params.id, userId: req.user.id, eventType: 'Updated' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM customer_payments WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
