const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

// Treasury > Collection Report with Aging (asked 2026-10-09). The Customer Payments in a date
// range, one row per invoice each payment settled, with how old the invoice was when the money
// came in -- so Treasury can see what was collected inside 30 days and what was chased for months.
//
//   Age at Collection   payment date - invoice date.
//   Days Past Due       payment date - invoice due date; 0 or less means collected on time.
//
// Aging is on DAYS PAST DUE (2026-10-09): Current (paid by the due date), 1-30, 31-60, 61-90 and Over 90
// days late. An invoice with no due date ages from its own date instead.
//
// ADVANCES (2026-10-12). Money a payment has not applied to any invoice -- a down payment taken in
// September for an invoice raised in October -- is a row of its own, Aging "Advance / No invoice
// yet", Invoice # blank, so a month's total is the cash that came in that month. Once the payment is
// applied the amount moves onto that invoice's row. Unapplied = payment amount - what its lines
// apply to invoices.
//
// DATE BY. Payment date (default), or Applied date: when the money met the invoice, taken as the
// LATER of the payment date and the invoice date -- an advance cannot be applied before its invoice
// exists. Not customer_payment_lines.created_at: the import stamped 9,668 of 2026's lines with the
// day it ran (2026-10-03). An advance not yet applied has no applied date and is dated by payment.
//
// CREDIT MEMOS (2026-10-21). A credit memo applied to an invoice settles it as a payment does -- most
// are the customer's creditable withholding tax -- so each application is a row too, dated by the
// memo (Type "Credit Memo"; CM # in the CPAY # column, no OR #). WRITE-OFFS are not: a memo booked
// to Bad Debts Expense, one with a WRITE OFF / BAD DEBTS line, or one whose memo says it writes off
// the account forgave the money, nobody collected it. Collection Incentive asks without them
// (credit_memos: '0') -- it pays on what Treasury actually received.
//
// Its own permission page, like the Disbursement Report: reading collections across customers is
// Treasury's question, not the same right as raising a Customer Payment.
const ROUTE = '/treasury/collection-aging';

// Voided payments never collected anything. Lines applying a credit memo rather than an invoice
// are not collections either.
//
// CPAY-INV-#### rows are not receipts: db/generate-invoice-payments.js wrote one per already-paid
// imported invoice so the module had history; no money arrived on that day (see
// routes/collectionForecast.js REAL_PAYMENT). Left out unless asked for, or every imported invoice
// would read as collected on whatever day the generator chose.
const REAL_PAYMENT = "cp.customer_payment_no NOT LIKE 'CPAY-INV-%'";

const BUCKETS = [
  { key: 'current', label: 'Current', min: -Infinity, max: 0 },
  { key: '1-30', label: '1-30', min: 1, max: 30 },
  { key: '31-60', label: '31-60', min: 31, max: 60 },
  { key: '61-90', label: '61-90', min: 61, max: 90 },
  { key: '90+', label: 'Over 90', min: 91, max: Infinity },
];
const ADVANCE = { key: 'advance', label: 'Advances from Customers' }; // renamed 2026-10-14
const ALL_BUCKETS = [...BUCKETS, ADVANCE];
const bucketOf = (age) => (age == null ? null : BUCKETS.find((b) => age >= b.min && age <= b.max).key);

// Dates as plain YYYY-MM-DD text, as the Disbursement Report writes them (no timezone drift).
const day = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : '');

const isIsoDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
function range(query) {
  const today = new Date().toISOString().slice(0, 10);
  const from = isIsoDate(query.from) ? query.from : today;
  const to = isIsoDate(query.to) ? query.to : today;
  return from <= to ? { from, to } : { from: to, to: from };
}

async function fetchRows(query) {
  const { from, to } = range(query);
  const byApplied = query.date_by === 'applied';
  // What both queries share: the payment's own filters.
  const where = ["cp.status <> 'voided'"];
  const params = [];
  if (query.include_generated !== '1') where.push(REAL_PAYMENT);
  if (Number(query.customer_id) > 0) { where.push('cp.customer_id = ?'); params.push(Number(query.customer_id)); }
  // Location of the Customer Payment (2026-10-09; the page starts on Head Office). A payment with no
  // location counts as Head Office's, as the dashboard's Head Office Collection card reads it.
  if (Number(query.location_id) > 0) {
    const [[loc]] = await pool.query('SELECT location_name FROM locations WHERE id = ?', [Number(query.location_id)]);
    const isHeadOffice = /^head office/i.test(String(loc?.location_name || '').trim());
    where.push(isHeadOffice ? '(cp.office_location_id = ? OR cp.office_location_id IS NULL)' : 'cp.office_location_id = ?');
    params.push(Number(query.location_id));
  }
  const like = query.search ? `%${query.search}%` : null;

  // Invoice rows: one per invoice a payment applied to.
  const invWhere = [...where, 'cpl.sales_invoice_id IS NOT NULL',
    byApplied ? 'GREATEST(cp.date_created, si.date_created) BETWEEN ? AND ?' : 'cp.date_created BETWEEN ? AND ?'];
  const invParams = [...params, from, to];
  if (like) {
    invWhere.push('(cp.customer_payment_no LIKE ? OR si.invoice_no LIKE ? OR cp.or_no LIKE ? OR c.name LIKE ?)');
    invParams.push(like, like, like, like);
  }
  const [rows] = await pool.query(
    `SELECT cp.id AS payment_id, cp.customer_payment_no, cp.date_created AS payment_date, cp.or_no, cp.receipt_type,
            c.name AS customer_name, si.id AS invoice_id, si.invoice_no, si.date_created AS invoice_date,
            si.date_due, si.term, cpl.applied_amount,
            GREATEST(cp.date_created, si.date_created) AS applied_date,
            DATEDIFF(cp.date_created, si.date_created) AS age_days,
            DATEDIFF(cp.date_created, si.date_due) AS days_past_due
       FROM customer_payment_lines cpl
       JOIN customer_payments cp ON cp.id = cpl.customer_payment_id
       JOIN sales_invoices si ON si.id = cpl.sales_invoice_id
       LEFT JOIN customers c ON c.id = cp.customer_id
      WHERE ${invWhere.join(' AND ')}`,
    invParams,
  );

  // Advance rows: what each payment in range has not applied to an invoice, dated by payment.
  const advWhere = [...where, 'cp.date_created BETWEEN ? AND ?'];
  const advParams = [...params, from, to];
  if (like) {
    advWhere.push('(cp.customer_payment_no LIKE ? OR cp.or_no LIKE ? OR c.name LIKE ?)');
    advParams.push(like, like, like);
  }
  const [adv] = await pool.query(
    `SELECT * FROM (
       SELECT cp.id AS payment_id, cp.customer_payment_no, cp.date_created AS payment_date, cp.or_no, cp.receipt_type,
              c.name AS customer_name,
              ROUND(cp.payment_amount - COALESCE((SELECT SUM(l.applied_amount) FROM customer_payment_lines l
                                                   WHERE l.customer_payment_id = cp.id AND l.sales_invoice_id IS NOT NULL), 0), 2) AS unapplied
         FROM customer_payments cp
         LEFT JOIN customers c ON c.id = cp.customer_id
        WHERE ${advWhere.join(' AND ')}
     ) x WHERE x.unapplied > 0.005`,
    advParams,
  );

  // Credit memo rows: one per invoice a (not voided, not write-off) credit memo was applied to.
  let memoRows = [];
  if (query.credit_memos !== '0') {
    const cmWhere = ["cm.status <> 'voided'", 'cm.voided_at IS NULL', 'cma.sales_invoice_id IS NOT NULL', 'cma.applied_amount > 0',
      `NOT (COALESCE(sa.account_name, '') LIKE '%bad debt%'
        OR COALESCE(cm.memo, '') LIKE '%write%off%' OR COALESCE(cm.memo, '') LIKE '%written off%'
        OR EXISTS (SELECT 1 FROM credit_memo_lines wl WHERE wl.credit_memo_id = cm.id
                    AND (wl.item_name LIKE '%write%off%' OR wl.item_name LIKE '%bad debt%')))`,
      byApplied ? 'GREATEST(cm.date_created, si.date_created) BETWEEN ? AND ?' : 'cm.date_created BETWEEN ? AND ?'];
    const cmParams = [from, to];
    if (Number(query.customer_id) > 0) { cmWhere.push('cm.customer_id = ?'); cmParams.push(Number(query.customer_id)); }
    if (Number(query.location_id) > 0) {
      const [[loc]] = await pool.query('SELECT location_name FROM locations WHERE id = ?', [Number(query.location_id)]);
      const isHeadOffice = /^head office/i.test(String(loc?.location_name || '').trim());
      cmWhere.push(isHeadOffice ? '(cm.office_location_id = ? OR cm.office_location_id IS NULL)' : 'cm.office_location_id = ?');
      cmParams.push(Number(query.location_id));
    }
    if (like) {
      cmWhere.push('(cm.credit_memo_no LIKE ? OR si.invoice_no LIKE ? OR c.name LIKE ?)');
      cmParams.push(like, like, like);
    }
    const [cms] = await pool.query(
      `SELECT cm.id AS credit_memo_id, cm.credit_memo_no, cm.date_created AS payment_date,
              c.name AS customer_name, si.id AS invoice_id, si.invoice_no, si.date_created AS invoice_date,
              si.date_due, si.term, cma.applied_amount,
              GREATEST(cm.date_created, si.date_created) AS applied_date,
              DATEDIFF(cm.date_created, si.date_created) AS age_days,
              DATEDIFF(cm.date_created, si.date_due) AS days_past_due
         FROM credit_memo_applications cma
         JOIN credit_memos cm ON cm.id = cma.credit_memo_id
         JOIN sales_invoices si ON si.id = cma.sales_invoice_id
         LEFT JOIN customers c ON c.id = cm.customer_id
         LEFT JOIN chart_of_accounts sa ON sa.id = cm.source_account_id
        WHERE ${cmWhere.join(' AND ')}`,
      cmParams,
    );
    memoRows = cms.map((r) => ({
      source: 'credit_memo', payment_id: null, credit_memo_id: r.credit_memo_id, customer_payment_no: r.credit_memo_no,
      payment_date: r.payment_date, or_no: null, customer_name: r.customer_name, invoice_id: r.invoice_id,
      invoice_no: r.invoice_no, invoice_date: r.invoice_date, date_due: r.date_due, term: r.term, applied_date: r.applied_date,
      age_days: r.age_days == null ? null : Number(r.age_days),
      days_past_due: r.days_past_due == null ? null : Number(r.days_past_due),
      applied_amount: Number(r.applied_amount || 0),
      bucket: bucketOf(r.days_past_due != null ? Number(r.days_past_due) : (r.age_days == null ? null : Number(r.age_days))),
    }));
  }

  const invoiceRows = rows.map((r) => ({
    source: 'payment',
    ...r,
    age_days: r.age_days == null ? null : Number(r.age_days),
    days_past_due: r.days_past_due == null ? null : Number(r.days_past_due),
    applied_amount: Number(r.applied_amount || 0),
    bucket: bucketOf(r.days_past_due != null ? Number(r.days_past_due) : (r.age_days == null ? null : Number(r.age_days))),
  }));
  const advanceRows = adv.map((r) => ({
    source: 'payment', payment_id: r.payment_id, customer_payment_no: r.customer_payment_no, payment_date: r.payment_date, or_no: r.or_no, receipt_type: r.receipt_type,
    customer_name: r.customer_name, invoice_id: null, invoice_no: null, invoice_date: null, date_due: null, term: null,
    applied_date: null, age_days: null, days_past_due: null, applied_amount: Number(r.unapplied || 0), bucket: ADVANCE.key,
  }));
  // In date order (applied date when dating by it), a payment's invoices together, its advance last.
  const sortDay = (r) => day(byApplied ? (r.applied_date || r.payment_date) : r.payment_date);
  let out = [...invoiceRows, ...memoRows, ...advanceRows].sort((a, b) => sortDay(a).localeCompare(sortDay(b))
    || String(a.customer_payment_no).localeCompare(String(b.customer_payment_no))
    || String(a.invoice_no || '￿').localeCompare(String(b.invoice_no || '￿')));
  // The summary is over the whole range; the bucket filter only narrows the rows listed.
  const summary = ALL_BUCKETS.map((b) => {
    const inB = out.filter((r) => r.bucket === b.key);
    // Credit memos kept apart too (2026-10-21) -- "so we know how much CM".
    const cm = inB.filter((r) => r.source === 'credit_memo');
    const cmAmount = cm.reduce((s, r) => s + r.applied_amount, 0);
    const amount = inB.reduce((s, r) => s + r.applied_amount, 0);
    return { key: b.key, label: b.label, count: inB.length, amount, cm_count: cm.length, cm_amount: cmAmount, payment_amount: amount - cmAmount };
  });
  if (ALL_BUCKETS.some((b) => b.key === query.bucket)) out = out.filter((r) => r.bucket === query.bucket);
  return { from, to, date_by: byApplied ? 'applied' : 'payment', rows: out, summary };
}

router.get('/customers', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.id, c.name FROM customers c
        WHERE c.id IN (SELECT DISTINCT customer_id FROM customer_payments WHERE status <> 'voided')
        ORDER BY c.name`);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const data = await fetchRows(req.query);
    res.json({ ...data, total_amount: data.rows.reduce((s, r) => s + r.applied_amount, 0) });
  } catch (err) { next(err); }
});

const bucketLabel = (k) => (ALL_BUCKETS.find((b) => b.key === k) || {}).label || '';

router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { from, to, rows } = await fetchRows(req.query);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Collection Aging');
    ws.columns = [
      { header: 'Type', key: 'type', width: 12 },
      { header: 'CPAY / CM #', key: 'cpay', width: 16 },
      { header: 'Payment Date', key: 'payment_date', width: 13 },
      { header: 'OR / CR #', key: 'or_no', width: 12 },
      { header: 'PR #', key: 'pr_no', width: 12 },
      { header: 'Applied Date', key: 'applied_date', width: 13 },
      { header: 'Invoice #', key: 'invoice_no', width: 15 },
      { header: 'Invoice Date', key: 'invoice_date', width: 13 },
      { header: 'Invoice Due Date', key: 'date_due', width: 15 },
      { header: 'Term', key: 'term', width: 12 },
      { header: 'Customer', key: 'customer', width: 38 },
      { header: 'Age at Collection (days)', key: 'age', width: 14 },
      { header: 'Days Past Due', key: 'past_due', width: 12 },
      { header: 'Aging', key: 'bucket', width: 22 },
      { header: 'Amount Collected', key: 'amount', width: 16 },
    ];
    ws.getRow(1).font = { bold: true };
    rows.forEach((r) => ws.addRow({
      type: r.source === 'credit_memo' ? 'Credit Memo' : 'Payment', cpay: r.customer_payment_no, payment_date: day(r.payment_date),
      // A Provisional Receipt's number in its own PR # column (2026-10-24), apart from OR / CR numbers.
      ...(/provisional/i.test(r.receipt_type || '') ? { or_no: '', pr_no: r.or_no || '' } : { or_no: r.or_no || '', pr_no: '' }),
      applied_date: day(r.applied_date), customer: r.customer_name || '', invoice_no: r.invoice_no || '',
      invoice_date: day(r.invoice_date), date_due: day(r.date_due), term: r.term || '', age: r.age_days,
      past_due: r.days_past_due, bucket: bucketLabel(r.bucket), amount: r.applied_amount,
    }));
    ws.getColumn('amount').numFmt = '#,##0.00';
    ws.autoFilter = { from: 'A1', to: `O${rows.length + 1}` };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="collection-aging-${from}-to-${to}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

module.exports = router;
// Treasury > Collection Incentive counts collections exactly as this report does.
module.exports.fetchCollections = fetchRows;
module.exports.COLLECTION_BUCKETS = ALL_BUCKETS;
