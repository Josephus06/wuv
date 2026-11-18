const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ROUTE = '/treasury/collection-forecast';

// Treasury > Collection Forecast. Treasury puts a date on an open invoice saying when they
// expect to collect it, then reads the month back as a calendar of who owes what and when.
//
// WHAT COUNTS AS OPEN: amount_due > 0 and not cancelled -- what the Invoice screen itself calls
// outstanding. AR Aging answers a deliberately different question (it rebuilds balances from
// documents and so also counts 1,363 invoices marked paid with nothing recorded behind them);
// putting those on a collection worklist would have Treasury chasing invoices their own screen
// calls Paid In Full. See lib/arAging.js for why that report is right to differ.
const OPEN_INVOICE = 'si.amount_due > 0 AND si.cancelled_at IS NULL';
// WHOSE INVOICE: the customer it was billed to (sales_invoices.customer_id) first, and only then
// its Sales Order's / Estimate's / NSSO's -- an invoice can be billed to someone other than the
// order's customer (INV-81555..81558: Filinvest, for Mactan Seascapes orders), and AR Aging already
// files it under the billed-to customer (2026-10-08).
// What is still to be COLLECTED, on the gross (VAT-inclusive) amount the customer pays: the stored
// amount_due is Gross - EWT less payments, so the EWT is added back (asked 2026-10-02; the Invoice
// screen's Amount Due reads the same way).
const DUE_GROSS = '(si.amount_due + COALESCE(si.ewt_amount, 0))';

// A RECEIPT, as opposed to a bookkeeping reconstruction.
//
// customer_payments holds two different things. 59,206 PAY-#### rows are real payment headers
// imported from the live system, 56,424 of them carrying an OR number. The other 72,456 are
// CPAY-INV-#### rows that db/generate-invoice-payments.js wrote -- one per already-paid imported
// invoice, so the Customer Payments module had data and a paid invoice showed a settlement in
// Related Records. Its own header says the numbers and the grouping are synthetic. None has an
// OR number, because no receipt was ever issued.
//
// They must not count as collections. On 2026-09-04 they were 1,727,800.23 of the 2,082,536.69
// the calendar first reported -- including the whole of one customer's 1,550,572.50, which is
// what exposed this: money shown as collected on a day nobody collected it.
//
// Matched on the number prefix, which is what the generator documents. Matching on "has no OR"
// instead would throw away the 2,782 real payments that carry no OR number.
const REAL_PAYMENT = "cp.customer_payment_no NOT LIKE 'CPAY-INV-%'";

const clampPage = (v) => Math.max(1, Number(v) || 1);
const clampLimit = (v) => Math.min(200, Math.max(1, Number(v) || 25));
const isIsoDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// ---- the worklist: open invoices to plan ----
//
// Filterable by customer, which is the way Treasury actually works -- you ring one customer and
// settle every invoice of theirs in one call, rather than working down a mixed list.
router.get('/open', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, customer_id: customerId, forecast } = req.query;
    const where = [OPEN_INVOICE];
    const params = [];

    if (customerId) { where.push('c.id = ?'); params.push(customerId); }
    // Which half of the worklist to show: what still needs planning, or what has been planned.
    if (forecast === 'unset') where.push('si.collection_forecast_date IS NULL');
    if (forecast === 'set') where.push('si.collection_forecast_date IS NOT NULL');
    if (search) {
      // BS/SI # is the pre-printed form's serial -- the number on the paper the customer holds.
      where.push('(si.invoice_no LIKE ? OR c.name LIKE ? OR si.po_no LIKE ? OR si.bs_si_no LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }

    const baseFrom = `FROM sales_invoices si
       LEFT JOIN sales_orders so ON so.id = si.sales_order_id
       LEFT JOIN estimates e ON e.id = si.estimate_id
       LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id
       JOIN customers c ON c.id = COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id)
       LEFT JOIN users fu ON fu.id = si.collection_forecast_set_by_user_id`;
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [[totals]] = await pool.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(${DUE_GROSS}), 0) AS outstanding ${baseFrom} ${whereSql}`,
      params,
    );
    const page = clampPage(req.query.page);
    const limit = clampLimit(req.query.limit);
    const [rows] = await pool.query(
      `SELECT si.id, si.invoice_no, si.bs_si_no, si.date_created, si.date_due, si.po_no,
              si.gross_amount, ${DUE_GROSS} AS amount_due, si.status,
              si.collection_forecast_date, si.collection_forecast_set_at,
              fu.display_name AS collection_forecast_set_by,
              c.id AS customer_id, c.name AS customer_name
       ${baseFrom} ${whereSql}
       ORDER BY si.date_due IS NULL, si.date_due ASC, si.id ASC
       LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit],
    );
    return res.json({
      rows,
      total: Number(totals.total) || 0,
      outstanding: Number(totals.outstanding) || 0,
      page,
      limit,
    });
  } catch (err) {
    return next(err);
  }
});

// The customers who have anything open, for the filter. Only those with open invoices: a picker
// listing all 21,718 customers when 300-odd owe anything is a list nobody can use.
router.get('/customers', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.id, c.name, COUNT(*) AS open_invoices, COALESCE(SUM(${DUE_GROSS}), 0) AS outstanding
         FROM sales_invoices si
         LEFT JOIN sales_orders so ON so.id = si.sales_order_id
         LEFT JOIN estimates e ON e.id = si.estimate_id
         LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id
         JOIN customers c ON c.id = COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id)
        WHERE ${OPEN_INVOICE}
        GROUP BY c.id, c.name
        ORDER BY c.name`,
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// ---- setting the forecast, in bulk ----
//
// Bulk because that is the actual task: one call to a customer settles when every one of their
// open invoices is expected, and setting them one at a time would be the same decision typed
// ten times. A null date clears the forecast, which is how a plan gets withdrawn.
router.put('/', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { invoice_ids: invoiceIds, forecast_date: forecastDate } = req.body;
    if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
      return res.status(400).json({ error: 'Select at least one invoice.' });
    }
    if (forecastDate !== null && forecastDate !== '' && !isIsoDate(forecastDate)) {
      return res.status(400).json({ error: 'Enter a valid forecast date.' });
    }
    const date = forecastDate === '' ? null : forecastDate;

    // Only ever open invoices. Without this an id for a settled or cancelled invoice -- stale
    // because someone else collected it while this list sat open -- would still be stamped with
    // a collection date, putting money on the calendar that has already arrived.
    const [result] = await pool.query(
      `UPDATE sales_invoices si
          SET si.collection_forecast_date = ?,
              si.collection_forecast_set_by_user_id = ?,
              si.collection_forecast_set_at = ?
        WHERE si.id IN (?) AND ${OPEN_INVOICE}`,
      [date, date ? req.user.id : null, date ? new Date() : null, invoiceIds],
    );
    return res.json({
      updated: result.affectedRows,
      // Said plainly rather than swallowed: the caller asked for n and got fewer, and the
      // difference is invoices that stopped being open since the list was drawn.
      skipped: invoiceIds.length - result.affectedRows,
      forecast_date: date,
    });
  } catch (err) {
    return next(err);
  }
});

// ---- the calendar: a month of expected collections ----
//
// Grouped by DAY then by CUSTOMER, because the question the calendar answers is "who is paying
// us on the 23rd and how much", not "which invoice numbers". Each customer carries its invoice
// count and total so the day reads at a glance, and the invoices themselves ride along so the
// day popup can expand a customer without another request per row.
router.get('/calendar', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || ''))
      ? req.query.month
      : new Date().toISOString().slice(0, 7);
    const start = `${month}-01`;
    // Last day of the month, worked out by asking for day 0 of the next one.
    const [y, m] = month.split('-').map(Number);
    const endDate = new Date(y, m, 0);
    const end = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;

    const { customer_id: customerId } = req.query;
    const where = [OPEN_INVOICE, 'si.collection_forecast_date BETWEEN ? AND ?'];
    const params = [start, end];
    if (customerId) { where.push('c.id = ?'); params.push(customerId); }

    const [rows] = await pool.query(
      `SELECT si.id, si.invoice_no, si.date_created, si.date_due, ${DUE_GROSS} AS amount_due,
              si.collection_forecast_date, c.id AS customer_id, c.name AS customer_name
         FROM sales_invoices si
         LEFT JOIN sales_orders so ON so.id = si.sales_order_id
         LEFT JOIN estimates e ON e.id = si.estimate_id
         LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id
         JOIN customers c ON c.id = COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id)
        WHERE ${where.join(' AND ')}
        ORDER BY c.name, si.date_due IS NULL, si.date_due, si.id`,
      params,
    );

    // ACTUAL COLLECTION: the receipts actually taken on each day, which is what the forecast is
    // a prediction of. Deliberately EVERY receipt taken that day, not only those against invoices
    // forecast for it -- the figure answers "did the money we expected arrive", and money that
    // arrived unforecast is exactly what a number restricted to the plan would hide. Voided
    // payments are excluded, because a reversed receipt never was a collection, and so are the
    // reconstructed CPAY-INV-#### rows -- see REAL_PAYMENT above.
    //
    // HEAD OFFICE ONLY. Treasury collects at Head Office; a receipt taken at a branch is that
    // branch's, and counting it here would credit the forecast with money Treasury never
    // handled. Matched on the location's NAME rather than a hardcoded id, because ids differ
    // between the environments this runs in -- the office and cloud databases mint them from
    // different auto_increment offsets.
    const payWhere = [
      'cp.date_created BETWEEN ? AND ?',
      'cp.voided_at IS NULL',
      REAL_PAYMENT,
      "loc.location_name = 'Head Office'",
    ];
    const payParams = [start, end];
    if (customerId) { payWhere.push('cp.customer_id = ?'); payParams.push(customerId); }
    const [payments] = await pool.query(
      `SELECT cp.date_created AS day, c.id AS customer_id, c.name AS customer_name,
              COUNT(*) AS payment_count, COALESCE(SUM(cp.payment_amount), 0) AS collected
         FROM customer_payments cp
         JOIN customers c ON c.id = cp.customer_id
         JOIN locations loc ON loc.id = cp.office_location_id
        WHERE ${payWhere.join(' AND ')}
        GROUP BY cp.date_created, c.id, c.name`,
      payParams,
    );

    // Shaped here rather than in the client so the calendar and its popup can never disagree
    // about a day's total -- they read the same numbers.
    const days = new Map();
    const groupFor = (key, customerId2, customerName) => {
      if (!days.has(key)) days.set(key, new Map());
      const byCustomer = days.get(key);
      if (!byCustomer.has(customerId2)) {
        byCustomer.set(customerId2, {
          customerId: customerId2,
          customerName,
          invoiceCount: 0,
          total: 0,
          collected: 0,
          paymentCount: 0,
          invoices: [],
        });
      }
      return byCustomer.get(customerId2);
    };

    for (const r of rows) {
      const key = String(r.collection_forecast_date).slice(0, 10);
      const group = groupFor(key, r.customer_id, r.customer_name);
      group.invoiceCount += 1;
      group.total += Number(r.amount_due) || 0;
      group.invoices.push({
        id: r.id,
        invoiceNo: r.invoice_no,
        dateCreated: String(r.date_created).slice(0, 10),
        dateDue: r.date_due ? String(r.date_due).slice(0, 10) : null,
        amountDue: Number(r.amount_due) || 0,
      });
    }

    // A day can carry collections without a forecast -- money arrived that nobody planned for --
    // and that day has to appear on the calendar, or the actual figure would be invisible
    // precisely where it is most worth seeing.
    for (const p of payments) {
      const key = String(p.day).slice(0, 10);
      const group = groupFor(key, p.customer_id, p.customer_name);
      group.collected += Number(p.collected) || 0;
      group.paymentCount += Number(p.payment_count) || 0;
    }

    const calendar = [...days.entries()]
      .map(([day, byCustomer]) => {
        // Ordered by whichever figure the customer is bigger on, so a large unforecast
        // collection is not buried under small forecasts.
        const customers = [...byCustomer.values()]
          .sort((a, b) => Math.max(b.total, b.collected) - Math.max(a.total, a.collected));
        return {
          day,
          customers,
          invoiceCount: customers.reduce((s, x) => s + x.invoiceCount, 0),
          total: customers.reduce((s, x) => s + x.total, 0),
          collected: customers.reduce((s, x) => s + x.collected, 0),
          paymentCount: customers.reduce((s, x) => s + x.paymentCount, 0),
        };
      })
      .sort((a, b) => a.day.localeCompare(b.day));

    return res.json({
      month,
      calendar,
      invoiceCount: rows.length,
      total: calendar.reduce((s, d) => s + d.total, 0),
      collected: calendar.reduce((s, d) => s + d.collected, 0),
      paymentCount: calendar.reduce((s, d) => s + d.paymentCount, 0),
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
