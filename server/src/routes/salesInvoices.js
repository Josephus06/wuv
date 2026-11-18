const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db');
const { grossDueSql } = require('../lib/invoiceDue');
const { assignDocNo } = require('../lib/docNumber');
const { requireAuth, requirePermission, userCan, isSystemAdmin } = require('../middleware/auth');
const { assertPeriodOpen } = require('../lib/accountingPeriod');
const { computeSalesOrderStatus, invoicedOrTicketedSql, openDtQtySql } = require('../lib/salesOrderStatus');
const { recomputeNssoStatus } = require('../lib/nssoStatus');
const { computeSalesInvoiceGl } = require('../lib/glImpact');

const { getSalesRepEmployeeScope } = require('../lib/salesVisibility');
const { whyNotBillable } = require('../lib/estimateBilling');
const { isHeadOfficeUser } = require('../lib/userLocation');
const { postReversalJournal, mirror, listReversalJournals } = require('../lib/reversalJournal');
const { headerDepartmentError } = require('../lib/requireDepartment');

// An invoice with nothing to collect -- a fully discounted order or JO, gross and amount due both
// zero -- is Paid in Full the moment it exists, not Open (asked 2026-10-26, INV-84790). Called after
// every create and edit; only an Open invoice is touched, never a voided one. db/settle-zero-invoices.js
// settles those already saved.
async function settleZeroInvoice(conn, invoiceId) {
  await conn.query(
    `UPDATE sales_invoices SET status = 'paid_in_full'
      WHERE id = ? AND status = 'saved' AND ABS(COALESCE(gross_amount, 0)) <= 0.005 AND ABS(COALESCE(amount_due, 0)) <= 0.005`,
    [invoiceId]);
}

const router = express.Router();
// Unlike Item Fulfillment/Receipt/Quality Inspection/Item Delivery (all reached only by
// drilling into a parent record and reusing its permission scope), Sales Invoices also
// get their own standalone "Saved Invoices" list page -- so this is a real page entry
// (route '/sales-invoices'), not a borrowed scope.
const ROUTE = '/sales-invoices';

// GL Impact computation lives in server/src/lib/glImpact.js (computeSalesInvoiceGl),
// shared with the Reports engine so the reports can never drift from what this tab shows.
const computeGlImpact = computeSalesInvoiceGl;

async function logAudit(conn, { invoiceId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('SalesInvoice', ?, ?, ?, ?, ?, ?)`,
    [invoiceId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// The list's filters as SQL, shared by the list and the Excel extract so a download always holds
// exactly the invoices the screen is filtered to -- including the Account Officer / Supervisor
// scope, so an extract can never reach invoices the list would not show that person.
// An invoice is a Sales/Service Invoice (SI) or a Delivery Receipt (DR). A DR is not a
// BIR-registered sales invoice: the BIR Sales Report leaves it out and it prints on plain paper
// only. Anything else that arrives -- the source system's old 'bs' Billing Statement included --
// is an SI, since the Service Invoice replaced the billing statement. See db/add-invoice-type.js.
const normaliseInvoiceType = (v) => (String(v || '').trim().toUpperCase() === 'DR' ? 'DR' : 'SI');

async function listFilter(query, userId) {
  const {
    search, status, customer_id: customerId, sales_rep_id: salesRepId,
    from, to, department_id: departmentId, type, location_id: locationId,
  } = query;
  const where = [];
  const params = [];
  if (status) { where.push('si.status = ?'); params.push(status); }
  // SI or DR -- see normaliseInvoiceType.
  if (type) { where.push('si.invoice_type = ?'); params.push(normaliseInvoiceType(type)); }
  // An invoice has exactly one source -- a Sales Order, an Estimate or a Non-Standard Sales Order --
  // so the customer is whichever of the three it actually has. Same COALESCE everywhere the
  // customer is read below.
  if (customerId) { where.push('COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id) = ?'); params.push(customerId); }
  if (salesRepId) { where.push('si.sales_rep_id = ?'); params.push(salesRepId); }
  // Date Created, inclusive at both ends, and either end usable on its own -- "everything since
  // March" is as ordinary a question as a closed month. Compared as plain dates because the
  // column is a DATE: no time component to push a row past midnight and out of its own range.
  // idx_sales_invoices_date_created already covers this.
  if (from) { where.push('si.date_created >= ?'); params.push(from); }
  if (to) { where.push('si.date_created <= ?'); params.push(to); }
  // The invoice's OWN department (si.department_id), not the Sales Order's. They are usually the
  // same, but the invoice carries its own because billing can be charged elsewhere -- and it is
  // si.department_id the list column already displays, so filtering on anything else would
  // return rows whose Department cell disagreed with the filter that found them.
  //
  // 19,089 of 74,280 invoices carry no department at all. Those match no department filter, which
  // is correct -- they are unassigned, not assigned to everyone -- and they are all still there
  // under --ALL--.
  if (departmentId) { where.push('si.department_id = ?'); params.push(departmentId); }
  // The invoice's Office Location -- the column the list shows -- so a branch's invoices read off together.
  if (locationId) { where.push('si.office_location_id = ?'); params.push(locationId); }
  // An Account Officer sees only their own invoices; a Supervisor sees theirs plus their
  // reports'. Same rule Estimates and Sales Orders already apply -- see lib/salesVisibility.js,
  // which returns null (and so changes nothing) for every account that is neither.
  const salesScope = await getSalesRepEmployeeScope(userId, ROUTE);
  if (salesScope) { where.push('si.sales_rep_id IN (?)'); params.push(salesScope); }
  if (search) {
    // BS/SI # is the number printed on the paper the customer holds -- the one most often quoted.
    where.push('(si.invoice_no LIKE ? OR si.bs_si_no LIKE ? OR si.po_no LIKE ? OR so.sales_order_no LIKE ? OR e.estimate_no LIKE ? OR ns.nsso_no LIKE ? OR c.name LIKE ?)');
    params.push(...Array(7).fill(`%${search}%`));
  }
  return { where, params };
}

// Mirrors the real system's "Saved Invoices" list -- flat (no status tabs, just a
// Status filter), same pattern as Assembly Builds' list.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { page = '1', limit = '10' } = req.query;
    const { where, params } = await listFilter(req.query, req.user.id);
    const { search, customer_id: customerId } = req.query;
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // PAGINATED SERVER-SIDE. This used to return every invoice with no LIMIT -- 73,202 rows and
    // 30.6 MB measured on production -- while the page showed ten and sliced the rest away in
    // the browser. About 2 s of that was the server and ~9 s the transfer, before the browser
    // then parsed 30 MB of JSON to render 10 rows. Same shape as the Sales Orders list.
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 10));
    const offset = (pageNum - 1) * limitNum;

    // The count carries only the joins its own filters reference. sales_orders and estimates are
    // both LEFT joins now and neither decides membership -- an invoice has exactly one of the two,
    // and an INNER join on sales_orders would have hidden every estimate-sourced invoice from the
    // list entirely. customers comes in for the search and the customer filter; employees,
    // locations and departments are LEFT joins nothing filters on.
    const needsSource = Boolean(search || customerId);
    const countFrom = `FROM sales_invoices si
       LEFT JOIN sales_orders so ON so.id = si.sales_order_id
       LEFT JOIN estimates e ON e.id = si.estimate_id
       LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id
       ${needsSource ? 'LEFT JOIN customers c ON c.id = COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id)' : ''}`;
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total ${countFrom} ${whereSql}`, params
    );

    const [rows] = await pool.query(
      `SELECT si.id, si.invoice_no, si.date_created, si.date_due, si.net_of_tax, si.tax_amount,
              si.gross_amount,
              -- Amount Due on gross, as the invoice view shows it: the stored balance (Gross - EWT -
              -- payments) plus EWT while open, 0 once settled.
              ${grossDueSql('si')} AS amount_due,
              si.bs_si_no, si.term, si.status, si.memo, si.invoice_type, si.logistics_received_date,
              dt.dt_no, dt.date_created AS dt_date_created,
              COALESCE(so.sales_order_no, ns.nsso_no) AS sales_order_no, e.estimate_no, c.name AS customer_name,
              COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id) AS customer_id,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              loc.location_name AS office_location_name, d.name AS department_name
       FROM sales_invoices si
       LEFT JOIN sales_orders so ON so.id = si.sales_order_id
       LEFT JOIN estimates e ON e.id = si.estimate_id
       LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id
       LEFT JOIN customers c ON c.id = COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id)
       LEFT JOIN employees sr ON sr.id = si.sales_rep_id
       LEFT JOIN locations loc ON loc.id = si.office_location_id
       LEFT JOIN departments d ON d.id = si.department_id
       -- The Delivery Ticket it billed, if any (2026-10-30: DT # and its date on the list).
       LEFT JOIN delivery_tickets dt ON dt.id = si.delivery_ticket_id
       ${whereSql}
       ORDER BY si.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );
    res.json({ rows, total, page: pageNum, limit: limitNum });
  } catch (err) {
    next(err);
  }
});

// Extract: every invoice under the list's current filters, as a workbook. Gated on can_view like
// the list itself -- whoever can see the invoices can take them away in Excel. Written as a stream
// rather than built in memory: with no filter it is the whole table, ~74,000 rows.
router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { where, params } = await listFilter(req.query, req.user.id);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT si.invoice_no, si.date_created, si.date_due, si.net_of_tax, si.tax_amount,
              si.gross_amount,
              -- Amount Due on gross, as the invoice view shows it: the stored balance (Gross - EWT -
              -- payments) plus EWT while open, 0 once settled.
              ${grossDueSql('si')} AS amount_due,
              si.bs_si_no, si.term, si.status, si.memo, si.invoice_type, si.logistics_received_date,
              dt.dt_no, dt.date_created AS dt_date_created,
              COALESCE(so.sales_order_no, ns.nsso_no) AS sales_order_no, e.estimate_no, c.name AS customer_name,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              loc.location_name AS office_location_name, d.name AS department_name
       FROM sales_invoices si
       LEFT JOIN sales_orders so ON so.id = si.sales_order_id
       LEFT JOIN estimates e ON e.id = si.estimate_id
       LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id
       LEFT JOIN customers c ON c.id = COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id)
       LEFT JOIN employees sr ON sr.id = si.sales_rep_id
       LEFT JOIN locations loc ON loc.id = si.office_location_id
       LEFT JOIN departments d ON d.id = si.department_id
       -- The Delivery Ticket it billed, if any (2026-10-30: DT # and its date on the list).
       LEFT JOIN delivery_tickets dt ON dt.id = si.delivery_ticket_id
       ${whereSql}
       ORDER BY si.id DESC`,
      params
    );

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="sales-invoices.xlsx"');
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
    const ws = wb.addWorksheet('Sales Invoices', { views: [{ state: 'frozen', ySplit: 1 }] });
    // Same columns, in the same order, as the Saved Invoices table.
    const money = { numFmt: '#,##0.00' };
    ws.columns = [
      { header: 'Invoice #', key: 'invoice_no', width: 16 },
      { header: 'SO #', key: 'so', width: 14 },
      { header: 'Date Created', key: 'date_created', width: 13 },
      { header: 'Date Due', key: 'date_due', width: 13 },
      { header: 'No. of days overdue', key: 'overdue', width: 12 },
      { header: 'DT #', key: 'dt_no', width: 14 },
      { header: 'DT Date Created', key: 'dt_date', width: 15 },
      { header: 'Office Location', key: 'location', width: 22 },
      { header: 'Customer', key: 'customer', width: 38 },
      { header: 'Sales Rep', key: 'rep', width: 24 },
      { header: 'Department', key: 'department', width: 20 },
      { header: 'Net of Tax', key: 'net', width: 15, style: money },
      { header: 'Tax Amount', key: 'tax', width: 14, style: money },
      { header: 'Gross Amount', key: 'gross', width: 15, style: money },
      { header: 'Amount Due', key: 'due', width: 15, style: money },
      { header: 'Type', key: 'type', width: 6 },
      { header: 'BS/SI #', key: 'bs_si', width: 14 },
      { header: 'Term', key: 'term', width: 14 },
      { header: 'Received by Logistics', key: 'logistics', width: 18 },
      { header: 'Status', key: 'status', width: 10 },
      { header: 'Memo', key: 'memo', width: 40 },
    ];
    ws.autoFilter = 'A1:U1';
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).commit();

    // Dates as the plain YYYY-MM-DD the columns hold, so Excel can sort and filter them.
    const day = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : '');
    const STATUS = { saved: 'Open', cancelled: 'Void' };
    // No. of days overdue, as on the list: days from Date Due to the cut-off -- the Date To filter,
    // or Philippine today without one. Negative while not yet due. Blank for a Void invoice or one
    // with no Amount Due left.
    const cutOff = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || ''))
      ? req.query.to : new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const asOf = Date.parse(cutOff);
    const overdue = (r) => {
      const due = day(r.date_due);
      if (!due || r.status === 'cancelled' || !(Number(r.amount_due) > 0)) return '';
      return Math.round((asOf - Date.parse(due)) / 86400000);
    };
    for (const r of rows) {
      ws.addRow({
        invoice_no: r.invoice_no, so: r.sales_order_no || r.estimate_no || '',
        date_created: day(r.date_created), date_due: day(r.date_due), overdue: overdue(r),
        dt_no: r.dt_no || '', dt_date: day(r.dt_date_created),
        location: r.office_location_name || '', customer: r.customer_name || '',
        rep: r.sales_rep_name || '', department: r.department_name || '',
        // Numbers, not preformatted strings, so the columns can be totalled.
        net: Number(r.net_of_tax || 0), tax: Number(r.tax_amount || 0),
        gross: Number(r.gross_amount || 0), due: Number(r.amount_due || 0),
        type: r.invoice_type || 'SI', bs_si: r.bs_si_no || '', term: r.term || '',
        logistics: day(r.logistics_received_date),
        status: STATUS[r.status] || r.status, memo: r.memo || '',
      }).commit();
    }
    ws.commit();
    await wb.commit();
  } catch (err) {
    // Once the workbook has started streaming the status line is gone; all that is left is to
    // cut the download short so it cannot be mistaken for a complete file.
    if (res.headersSent) { res.destroy(err); return; }
    next(err);
  }
});

// Every line's price_per_unit/disc_percent/tax rate are fixed per-unit rates set once on
// the Sales Order line -- so billing only part of a line (Delivered minus already-Invoiced,
// which can be less than the line's full ordered Qty when its JO isn't fully built/QI'd
// yet) means recomputing Subtotal/Disc Amt/Net of Tax/Tax Amt/Gross Amt from that billable
// qty, not copying the full-line totals that were computed against the *ordered* qty.
function computeBillableLineAmounts({ pricePerUnit, discPercent, taxRate, billableQty }) {
  const subtotal = Number((Number(pricePerUnit || 0) * billableQty).toFixed(2));
  const discAmount = Number((subtotal * (Number(discPercent || 0) / 100)).toFixed(2));
  const netOfTax = Number((subtotal - discAmount).toFixed(2));
  const taxAmount = Number((netOfTax * (Number(taxRate || 0) / 100)).toFixed(2));
  const grossAmount = Number((netOfTax + taxAmount).toFixed(2));
  return { subtotal, disc_amount: discAmount, net_of_tax: netOfTax, tax_amount: taxAmount, gross_amount: grossAmount };
}

// ...except when the invoice bills the WHOLE order line in one go (nothing invoiced on it yet, the
// full ordered qty billable now). Then the order line's own stored amounts are billed, as on the
// order. Those need not equal price x disc%: SO-72396 lines carry a 439.00 discount typed onto the
// order against the 438.99 the formula gives, so re-pricing billed 8,470.05 on an 8,470.01 order.
// Gross is Net + Tax, as everywhere else on an invoice.
function soLineBillableAmounts(line, orderedQty, billableQty) {
  const whole = Number(line.quantity_invoiced || 0) === 0
    && Math.abs(Number(orderedQty) - billableQty) < 1e-9
    && line.net_of_tax != null && line.subtotal != null;
  if (!whole) {
    return computeBillableLineAmounts({
      pricePerUnit: line.price_per_unit, discPercent: line.disc_percent, taxRate: line.tax_rate, billableQty,
    });
  }
  const net = Number(line.net_of_tax); const tax = Number(line.tax_amount || 0);
  return {
    subtotal: Number(line.subtotal), disc_amount: Number(line.disc_amount || 0), net_of_tax: net,
    tax_amount: tax, gross_amount: Number((net + tax).toFixed(2)),
  };
}

// The Create SI form lets the biller change a line's Price/Unit before saving (requested
// 2026-10-01). It sends `price_overrides: { <source line id>: price }` for the lines it changed;
// every other figure on the line is then recomputed from that price by the helper above, so the
// form can never post a total the server did not work out itself. Returns null when the line
// was not changed. A negative or non-numeric price is refused rather than ignored.
function priceOverrideFor(body, lineId) {
  const raw = body?.price_overrides?.[lineId];
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    const err = new Error('Price/Unit must be a number of zero or more.');
    err.status = 400;
    throw err;
  }
  return n;
}

// The quantity to bill on a Sales Order line when the person billing chose less than all of it --
// partial invoicing, one unit of a line of 5 (asked 2026-10-24). null = bill all that is billable.
function qtyOverrideFor(body, lineId, billable, lineNo) {
  const raw = body?.qty_overrides?.[lineId];
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > billable + 1e-9) {
    const err = new Error(`Line ${lineNo}: the quantity to invoice must be more than 0 and at most ${billable}.`);
    err.status = 400;
    throw err;
  }
  return n;
}

// A line billed at a changed price: its own Price/Unit, and Disc Price/Unit re-derived as Net of
// Tax / Qty, the same pair the Estimate keeps.
// A Delivery Ticket line's tax rate. Most ticket lines carry the source's own code
// ('VAT_PH:VATIN-12') that the taxes table, holding only 'VAT12', does not match -- so the plain
// lookup came back null and re-pricing a line on the Create SI form zeroed its 12% VAT. The table
// first, then the rate the code ends in, then the rate the line was actually billed at (tax / net).
function dtLineTaxRate(l) {
  if (l.tax_rate !== null && l.tax_rate !== undefined) return Number(l.tax_rate);
  const fromCode = String(l.tax_code || '').match(/-(\d+(?:\.\d+)?)$/);
  if (fromCode) return Number(fromCode[1]);
  const net = Number(l.net_of_tax || 0);
  return net > 0 ? Number(((Number(l.tax_amount || 0) / net) * 100).toFixed(4)) : 0;
}

// Converting a ticket untouched bills the ticket's OWN totals. Its header was carried over from the
// source, which totals unrounded line amounts, so summing the rounded lines lands a centavo off
// (DT-6494: 7,622.05 on the ticket, 7,622.06 on the invoice). Once a price is changed there is no
// such total to keep, and the lines are summed.
const DT_TOTAL_KEYS = ['subtotal', 'discount_amount', 'net_of_tax', 'tax_amount', 'gross_amount'];
function dtHeaderTotals(dt) {
  return DT_TOTAL_KEYS.every((k) => dt[k] !== null && dt[k] !== undefined)
    ? Object.fromEntries(DT_TOTAL_KEYS.map((k) => [k, Number(dt[k])]))
    : null;
}

function repricedLine(line, price, amounts, qty) {
  return {
    price_per_unit: price,
    disc_price_per_unit: qty ? Number((amounts.net_of_tax / qty).toFixed(4)) : line.disc_price_per_unit,
    ...amounts,
  };
}

// Powers the Create SI form -- only SO lines with a JO that's been delivered but not
// yet (fully) invoiced show up (quantity_delivered > quantity_invoiced), each one billed
// for exactly the still-uninvoiced delivered qty (which can be less than the line's full
// ordered Qty), with Subtotal/Disc/Net/Tax/Gross recomputed against that qty.
router.get('/for-sales-order/:salesOrderId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[so]] = await pool.query(
      `SELECT so.id, so.sales_order_no, so.credit_term, so.sales_rep_id, so.office_location_id, so.shipping_address,
              -- The order's "PO #" (the customer's confirmation ref) prefills the invoice's PO #.
              so.order_confirmation_ref AS po_no,
              c.name AS customer_name,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              loc.location_name AS office_location_name,
              -- The order's SALES DIVISION, which is what an invoice's Department is filled from.
              -- Sent by name as well as by id: divisions and departments are separate tables with
              -- separate id spaces that happen to agree for most rows, and where they disagree
              -- the id is wrong -- sales division 1 "Support" is department 1 "Production -  CNC",
              -- which is how 4 invoices came to be filed under CNC. The form matches on the name.
              so.sales_division_id, sd.name AS sales_division_name,
              -- The customer's agreed payment term, as the fallback for an order carrying no
              -- credit term of its own -- which SO-163551 and plenty of others do not.
              pt.term_name AS customer_term
       FROM sales_orders so
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN employees sr ON sr.id = so.sales_rep_id
       LEFT JOIN locations loc ON loc.id = so.office_location_id
       LEFT JOIN sales_divisions sd ON sd.id = so.sales_division_id
       LEFT JOIN payment_terms pt ON pt.id = c.payment_term_id
       WHERE so.id = ?`,
      [req.params.salesOrderId]
    );
    if (!so) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT sol.id AS sales_order_line_id, sol.job_order_id, jo.job_order_no, jt.display_name AS item_name,
              sol.description, sol.job_location_id, loc.location_name AS job_location_name,
              sol.quantity AS ordered_quantity, sol.units, sol.price_per_unit, sol.disc_percent,
              sol.disc_price_per_unit, t.code AS tax_code, t.rate AS tax_rate,
              sol.subtotal, sol.disc_amount, sol.net_of_tax, sol.tax_amount,
              -- quantity on an open Delivery Ticket counts as billed: see openDtQtySql.
              jo.quantity_delivered, ${invoicedOrTicketedSql('jo')}
       FROM sales_order_lines sol
       JOIN job_orders jo ON jo.id = sol.job_order_id
       LEFT JOIN job_types jt ON jt.id = sol.job_type_id
       LEFT JOIN locations loc ON loc.id = sol.job_location_id
       LEFT JOIN taxes t ON t.id = sol.tax_code_id
       WHERE sol.sales_order_id = ? AND jo.quantity_delivered > jo.quantity_invoiced + ${openDtQtySql()}
       ORDER BY sol.line_no`,
      [req.params.salesOrderId]
    );

    const billableLines = lines.map((l) => {
      const billableQty = Number(l.quantity_delivered) - Number(l.quantity_invoiced);
      return {
        ...l,
        quantity: billableQty,
        ...soLineBillableAmounts(l, l.ordered_quantity, billableQty),
      };
    });

    res.json({ ...so, lines: billableLines });
  } catch (err) {
    next(err);
  }
});

// Powers Create SI from a Non-Standard Sales Order -- billed exactly like a Sales Order: each line
// whose Job Order has been delivered but not yet (fully) invoiced, for that remaining quantity,
// with Subtotal/Disc/Net/Tax/Gross recomputed against it. The NSSO line's Job Order is
// created_job_order_id. Returned under the same field names the Sales Order form reads.
router.get('/for-nsso/:nssoId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[ns]] = await pool.query(
      `SELECT ns.id, ns.nsso_no, ns.status, ns.sales_rep_id, ns.office_location_id, ns.shipping_address,
              c.name AS customer_name,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              loc.location_name AS office_location_name,
              ns.sales_division_id, sd.name AS sales_division_name,
              pt.term_name AS customer_term
       FROM non_standard_sales_orders ns
       LEFT JOIN customers c ON c.id = ns.customer_id
       LEFT JOIN employees sr ON sr.id = ns.sales_rep_id
       LEFT JOIN locations loc ON loc.id = ns.office_location_id
       LEFT JOIN sales_divisions sd ON sd.id = ns.sales_division_id
       LEFT JOIN payment_terms pt ON pt.id = c.payment_term_id
       WHERE ns.id = ?`,
      [req.params.nssoId]
    );
    if (!ns) return res.status(404).json({ error: 'Not found' });
    if (ns.status === 'cancelled') return res.status(409).json({ error: 'This NSSO is cancelled.' });

    const [lines] = await pool.query(
      `SELECT l.id AS nsso_line_id, l.created_job_order_id AS job_order_id, jo.job_order_no, jt.display_name AS item_name,
              l.description, l.job_location_id, loc.location_name AS job_location_name,
              l.quantity AS ordered_quantity, l.units, l.price_per_unit, l.disc_percent,
              t.code AS tax_code, t.rate AS tax_rate,
              jo.quantity_delivered, jo.quantity_invoiced
       FROM non_standard_sales_order_lines l
       JOIN job_orders jo ON jo.id = l.created_job_order_id
       LEFT JOIN job_types jt ON jt.id = l.job_type_id
       LEFT JOIN locations loc ON loc.id = l.job_location_id
       LEFT JOIN taxes t ON t.id = l.tax_code_id
       WHERE l.nsso_id = ? AND jo.quantity_delivered > jo.quantity_invoiced
       ORDER BY l.line_no`,
      [req.params.nssoId]
    );

    const billableLines = lines.map((l) => {
      const billableQty = Number(l.quantity_delivered) - Number(l.quantity_invoiced);
      return {
        ...l,
        quantity: billableQty,
        ...computeBillableLineAmounts({
          pricePerUnit: l.price_per_unit, discPercent: l.disc_percent, taxRate: l.tax_rate, billableQty,
        }),
      };
    });

    res.json({ ...ns, nsso_id: ns.id, sales_order_no: ns.nsso_no, lines: billableLines });
  } catch (err) {
    next(err);
  }
});

router.get('/by-nsso/:nssoId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, invoice_no, date_created, gross_amount, status FROM sales_invoices WHERE nsso_id = ? ORDER BY id DESC',
      [req.params.nssoId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Powers Create SI when it was raised straight from the invoice list against an Estimate, with no
// Sales Order behind it at all.
//
// Nothing is netted off here, unlike the Sales Order path: there are no Job Orders yet, so there
// is no delivered-minus-invoiced gap to bill. The Estimate's own lines ARE the invoice, and their
// stored money columns are used as they stand -- they were priced and approved on the Estimate,
// and recomputing them would quietly restate an approved figure.
//
// The JO # column is empty only while there is genuinely no Job Order. Once an Estimate has been
// converted, its lines DO have one -- sales_order_lines.estimate_job_order_id points straight back
// here -- and 3,515 of the 4,721 estimate lines resolve to one. Showing a dash for those was
// wrong: it read as "this work has no Job Order" when the truth was "this form never looked".
router.get('/for-estimate/:estimateId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[est]] = await pool.query(
      `SELECT e.id AS estimate_id, e.estimate_no, e.credit_term, e.sales_rep_id, e.office_location_id,
              e.shipping_address, e.memo, e.sales_order_id, e.status,
              c.name AS customer_name,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              loc.location_name AS office_location_name,
              so.sales_order_no
       FROM estimates e
       LEFT JOIN customers c ON c.id = e.customer_id
       LEFT JOIN employees sr ON sr.id = e.sales_rep_id
       LEFT JOIN locations loc ON loc.id = e.office_location_id
       LEFT JOIN sales_orders so ON so.id = e.sales_order_id
       WHERE e.id = ?`,
      [req.params.estimateId]
    );
    if (!est) return res.status(404).json({ error: 'Not found' });

    // Same visibility rule the estimate list applies -- an Account Officer cannot invoice an
    // estimate they are not allowed to see.
    const salesScope = await getSalesRepEmployeeScope(req.user.id, ROUTE);
    if (salesScope && !salesScope.includes(est.sales_rep_id)) {
      return res.status(404).json({ error: 'Not found' });
    }

    // Only a supervisor-approved estimate may be billed. Refused here as well as on save, so an
    // ineligible estimate reached by any route than the picker says why instead of quietly
    // opening a form that cannot be saved.
    const blocked = whyNotBillable(est);
    if (blocked) return res.status(409).json({ error: blocked });

    const [lines] = await pool.query(
      `SELECT ejo.id AS estimate_job_order_id, ejo.job_type_id, jt.display_name AS item_name,
              ejo.description, ejo.job_location_id, loc.location_name AS job_location_name,
              ejo.quantity, ejo.units, ejo.price_per_unit, ejo.disc_percent, ejo.disc_price_per_unit,
              ejo.subtotal, ejo.disc_amount, ejo.net_of_tax, ejo.tax_amount, ejo.gross_amount,
              t.code AS tax_code, ejo.nstdjo_no,
              jo.id AS job_order_id, jo.job_order_no,
              jo.quantity_delivered, jo.quantity_invoiced
       FROM estimate_job_orders ejo
       LEFT JOIN job_types jt ON jt.id = ejo.job_type_id
       LEFT JOIN locations loc ON loc.id = ejo.job_location_id
       LEFT JOIN taxes t ON t.id = ejo.tax_code_id
       LEFT JOIN sales_order_lines sol ON sol.estimate_job_order_id = ejo.id
       LEFT JOIN job_orders jo ON jo.id = sol.job_order_id
       WHERE ejo.estimate_id = ?
       ORDER BY ejo.line_no`,
      [req.params.estimateId]
    );

    // Already invoiced off this Estimate. Not a block -- part-billing an estimate across several
    // invoices is legitimate -- but the form says so, because nothing else would.
    const [[prior]] = await pool.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(gross_amount), 0) AS billed
         FROM sales_invoices WHERE estimate_id = ? AND status <> 'cancelled'`,
      [req.params.estimateId]
    );

    res.json({
      ...est,
      lines,
      prior_invoice_count: Number(prior.n),
      prior_invoiced_amount: Number(prior.billed),
    });
  } catch (err) {
    next(err);
  }
});

// Powers Create SI when it was reached from a Delivery Ticket's own Bill > SI button
// rather than from the Sales Order. The invoice bills exactly what the ticket says --
// its stored lines, ad-hoc "Add Item" charges included -- so nothing is recomputed from
// the Sales Order's delivered-vs-invoiced gap here. The ticket already decided the
// amounts; billing it is what makes them official.
router.get('/for-delivery-ticket/:deliveryTicketId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[dt]] = await pool.query(
      `SELECT dt.id AS delivery_ticket_id, dt.dt_no, dt.status, dt.sales_order_id, dt.term,
              -- The ticket's own PO #, else its Sales Order's (tickets raised before the order's PO #
              -- was carried onto them have none).
              COALESCE(NULLIF(dt.po_no, ''), so.order_confirmation_ref) AS po_no,
              dt.sales_rep_id, dt.office_location_id, dt.department_id, dt.memo,
              dt.subtotal, dt.discount_amount, dt.net_of_tax, dt.tax_amount, dt.gross_amount,
              so.sales_order_no, so.shipping_address, so.credit_term,
              c.name AS customer_name,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              loc.location_name AS office_location_name, d.name AS department_name
       FROM delivery_tickets dt
       JOIN sales_orders so ON so.id = dt.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN employees sr ON sr.id = dt.sales_rep_id
       LEFT JOIN locations loc ON loc.id = dt.office_location_id
       LEFT JOIN departments d ON d.id = dt.department_id
       WHERE dt.id = ?`,
      [req.params.deliveryTicketId]
    );
    if (!dt) return res.status(404).json({ error: 'Not found' });
    if (dt.status === 'void') return res.status(409).json({ error: 'This Delivery Ticket is void and cannot be billed.' });
    if (dt.status === 'converted') return res.status(409).json({ error: 'This Delivery Ticket has already been converted to an Invoice.' });

    const [lines] = await pool.query(
      `SELECT dtl.id AS delivery_ticket_line_id, dtl.sales_order_line_id, dtl.job_order_id, jo.job_order_no,
              dtl.item_name, dtl.description, dtl.location_id AS job_location_id, loc.location_name AS job_location_name,
              dtl.quantity, dtl.units, dtl.price_per_unit, dtl.subtotal, dtl.disc_percent, dtl.disc_amount,
              dtl.disc_price_per_unit, dtl.net_of_tax, dtl.tax_code, dtl.tax_amount,
              -- Net + Tax, as billDeliveryTicket saves it (see the note there).
              ROUND(dtl.net_of_tax + dtl.tax_amount, 2) AS gross_amount,
              (SELECT t.rate FROM taxes t WHERE t.code = dtl.tax_code LIMIT 1) AS tax_rate
       FROM delivery_ticket_lines dtl
       LEFT JOIN job_orders jo ON jo.id = dtl.job_order_id
       LEFT JOIN locations loc ON loc.id = dtl.location_id
       WHERE dtl.delivery_ticket_id = ? ORDER BY dtl.line_no`,
      [req.params.deliveryTicketId]
    );

    const { subtotal, discount_amount, net_of_tax, tax_amount, gross_amount, ...header } = dt;
    res.json({
      ...header, term: dt.term || dt.credit_term, ticket_totals: dtHeaderTotals(dt),
      lines: lines.map((l) => ({ ...l, tax_rate: dtLineTaxRate(l) })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/by-delivery-ticket/:deliveryTicketId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, invoice_no, date_created, gross_amount, status FROM sales_invoices WHERE delivery_ticket_id = ? ORDER BY id DESC',
      [req.params.deliveryTicketId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// The Sales Order's Related Records tab.
//
// A Sales-Order-path or Delivery-Ticket-path invoice lists as soon as it exists: it was raised
// against this order's own delivered-minus-invoiced quantities, so the order is where it came from.
//
// AN ESTIMATE-SOURCED INVOICE WAITS FOR THE WORK. It can be raised long before anything is made --
// an estimate is billable from pending_customer_approval, which is before the order and its job
// orders even exist -- so listing it the moment it is linked would put an invoice on the order for
// work the floor has not finished. It appears once every job order behind it is done.
//
// Done means production_stage IN ('completed','invoiced'), the same pair routes/production.js uses
// to mean "no longer open", not status = 'Completed': production_stage is the ladder the floor
// actually climbs, and 'invoiced' sits PAST 'completed' on it, so testing for completed alone would
// drop a job order again the moment it moved on.
//
// The job order is resolved two ways because the invoice line records it only when it existed at
// billing time: sil.job_order_id when the estimate was already converted, otherwise through the
// order line that shares the estimate line (sol.estimate_job_order_id). A line that resolves to no
// job order at all is not completed either, so it holds the invoice back -- deliberately, since
// that is a line nothing on this order is building.
//
// Gating the LIST rather than the link: sales_invoices.sales_order_id stays written, because the
// invoice does belong to the order -- AR, the invoice's own view and every report read it. What
// waits is only what this tab shows. That also makes it self-correcting: completing the job order
// is enough to surface the invoice, with nothing to re-run and nothing to backfill.
// The filter bar's Department options.
//
// Served from here, under THIS page's own can_view, rather than from /lookups/departments the way
// most pickers in this build are. 8 of the 40 users who can view invoices hold no permission on
// /lookups at all: for them that call answers 403 and the dropdown would sit silently empty on a
// page they are fully entitled to filter. Borrowing another page's scope to populate a control is
// how that happens -- see src/db/add-can-update-permission.js's sibling problem.
//
// Every department is offered, not just the ones already on an invoice: a DISTINCT over 74,280
// rows on an unindexed column costs more than the 29-row table, and a department with no invoices
// yet is a legitimate thing to ask about and get an empty list for.
// What the standalone (no-order) invoice form picks from: every active customer with its agreed
// term, the sellable items, and the tax codes. Served under this page's own can_view for the same
// reason /meta is -- a picker borrowing another page's scope sits empty for whoever lacks it.
router.get('/standalone-meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [customers] = await pool.query(
      `SELECT c.id, c.name, c.company_name, c.customer_code, c.tin, pt.term_name AS customer_term,
              (SELECT a.address_line FROM customer_addresses a WHERE a.customer_id = c.id
                ORDER BY (a.address_type = 'BILLING') DESC, a.is_default DESC, a.id LIMIT 1) AS address
         FROM customers c LEFT JOIN payment_terms pt ON pt.id = c.payment_term_id
        WHERE c.is_active = 1 ORDER BY c.name`
    );
    const [items] = await pool.query(
      `SELECT i.id, i.item_code, i.display_name, i.item_type, i.selling_price, u.code AS unit
         FROM inventories i LEFT JOIN units_of_measure u ON u.id = COALESCE(i.sales_unit_id, i.base_unit_id)
        WHERE i.is_active = 1 ORDER BY i.item_code`
    );
    const [taxes] = await pool.query('SELECT id, code, rate FROM taxes ORDER BY code');
    res.json({ customers, items, taxes });
  } catch (err) {
    next(err);
  }
});

router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [departments] = await pool.query('SELECT id, name FROM departments ORDER BY name');
    const [locations] = await pool.query('SELECT id, location_name AS name FROM locations ORDER BY location_name');
    res.json({ departments, locations });
  } catch (err) {
    next(err);
  }
});

router.get('/by-sales-order/:salesOrderId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT si.id, si.invoice_no, si.date_created, si.gross_amount, si.status, si.invoice_type
         FROM sales_invoices si
        WHERE si.sales_order_id = ?
          AND (si.estimate_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM sales_invoice_lines sil
                  LEFT JOIN sales_order_lines sol
                         ON sol.estimate_job_order_id = sil.estimate_job_order_id
                        AND sol.sales_order_id = si.sales_order_id
                  LEFT JOIN job_orders jo ON jo.id = COALESCE(sil.job_order_id, sol.job_order_id)
                 WHERE sil.sales_invoice_id = si.id
                   AND (jo.production_stage IS NULL OR jo.production_stage NOT IN ('completed', 'invoiced'))
              ))
        ORDER BY si.id DESC`,
      [req.params.salesOrderId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    // customer_tin / customer_address feed the pre-printed Billing Statement form, whose
    // header blanks sit above the line items. The address falls back to any address on file
    // when no BILLING one is flagged default, since most customers carry only one.
    const [[si]] = await pool.query(
      `SELECT si.*, so.sales_order_no, e.estimate_no, ns.nsso_no, c.name AS customer_name, c.id AS customer_link_id, dt.dt_no,
              ${grossDueSql('si')} AS gross_due,
              (SELECT u.display_name FROM users u WHERE u.id = si.logistics_received_by_user_id) AS logistics_received_by_name,
              c.tin AS customer_tin, c.company_name AS customer_company,
              c.bill_to_address AS customer_bill_to_address,
              -- The order behind the invoice for the printed "SO #": its own Sales Order, else the
              -- one its Estimate was converted to, else its Non-Standard SO.
              COALESCE(so.sales_order_no, eso.sales_order_no, ns.nsso_no) AS order_ref_no,
              COALESCE(
                (SELECT ca.address_line FROM customer_addresses ca
                  WHERE ca.customer_id = c.id AND ca.address_type = 'BILLING' AND ca.is_default = TRUE LIMIT 1),
                (SELECT ca.address_line FROM customer_addresses ca
                  WHERE ca.customer_id = c.id ORDER BY ca.is_default DESC, ca.id LIMIT 1)
              ) AS customer_address,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              loc.location_name AS office_location_name, d.name AS department_name,
              u.display_name AS created_by_name
       FROM sales_invoices si
       LEFT JOIN sales_orders so ON so.id = si.sales_order_id
       LEFT JOIN estimates e ON e.id = si.estimate_id
       LEFT JOIN sales_orders eso ON eso.id = e.sales_order_id
       LEFT JOIN delivery_tickets dt ON dt.id = si.delivery_ticket_id
       LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id
       LEFT JOIN customers c ON c.id = COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id)
       LEFT JOIN employees sr ON sr.id = si.sales_rep_id
       LEFT JOIN locations loc ON loc.id = si.office_location_id
       LEFT JOIN departments d ON d.id = si.department_id
       LEFT JOIN users u ON u.id = si.created_by_user_id
       WHERE si.id = ?`,
      [req.params.id]
    );
    if (!si) return res.status(404).json({ error: 'Not found' });
    // Defence in depth for the list filter above: hiding a document from the list while still
    // serving it to anyone who types its id is not a restriction. See lib/salesVisibility.js.
    const salesScope = await getSalesRepEmployeeScope(req.user.id, ROUTE);
    if (salesScope && !salesScope.includes(si.sales_rep_id)) {
      return res.status(404).json({ error: 'Not found' });
    }

    // item_code comes from the line's job type -- this ERP's product code, which the Type 2
    // invoice print has an Item Code column for. It is resolved through the job order first
    // and the sales-order line only as a fallback: sales_order_line_id is set on just 4 of
    // ~118,000 invoice lines, while job_order_id is set on ~88% of them.
    //
    // An estimate-sourced line has neither, which is why it carries its own job_type_id -- it is
    // the last resort here rather than the first, so nothing changes for the lines that already
    // resolve. job_order_no stays null on those lines and the JO # column reads empty, which is
    // the truth: no Job Order exists until the Estimate is converted.
    const [lines] = await pool.query(
      `SELECT sil.*, jo.job_order_no,
              COALESCE(jt.item_code, inv.item_code) AS item_code,
              COALESCE(jt.display_name, inv.display_name) AS item_name,
              inv.income_account_id
       FROM sales_invoice_lines sil
       LEFT JOIN job_orders jo ON jo.id = sil.job_order_id
       LEFT JOIN inventories inv ON inv.id = sil.item_id
       LEFT JOIN sales_order_lines sol ON sol.id = sil.sales_order_line_id
       LEFT JOIN job_types jt ON jt.id = COALESCE(jo.job_type_id, sol.job_type_id, sil.job_type_id)
       WHERE sil.sales_invoice_id = ?`,
      [req.params.id]
    );

    const glImpact = await computeGlImpact(si, lines);
    // Whether the header may be edited, answered here rather than guessed on the page -- see
    // whyNotEditable. `not_editable_reason` is what the disabled button says, so the reason a
    // user is given is the reason the server would give.
    const notEditable = await whyNotEditable(pool, si);
    const reversalJournals = si.status === 'cancelled' ? await listReversalJournals(pool, 'sales_invoice', si.id) : [];
    res.json({
      ...si, lines, gl_impact: glImpact, editable: !notEditable, not_editable_reason: notEditable,
      reversal_journals: reversalJournals,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'SalesInvoice' AND a.auditable_id = ?
       ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Bill > SI from a Delivery Ticket: the ticket was the provisional, unbilled recognition
// (it posts to AR Trade - Unbilled) and this is the official invoice that supersedes it.
// The ticket flips to 'converted', which is both the audit trail and what stops it
// posting to the GL a second time -- see getPostedGlLines, which only posts open tickets.
//
// Lines are copied verbatim from the ticket rather than recomputed: the ticket's amounts
// were already reviewed and saved, and its ad-hoc "Add Item" charges have no Sales Order
// line to recompute from at all. Only SO-backed lines advance job_orders.quantity_invoiced
// -- an ad-hoc delivery fee isn't part of any job's ordered quantity.
async function billDeliveryTicket(req, res, conn) {
  const {
    delivery_ticket_id: deliveryTicketId, date_created: dateCreated, date_due: dateDue, term,
    bs_si_no: bsSiNo, po_no: poNo, sales_rep_id: salesRepId, office_location_id: officeLocationId,
    department_id: departmentId, bill_to_address: billToAddress, memo,
    withholding_tax_pct: withholdingTaxPct,
  } = req.body;

  const [[dt]] = await conn.query(
    `SELECT id, sales_order_id, status, subtotal, discount_amount, net_of_tax, tax_amount, gross_amount
       FROM delivery_tickets WHERE id = ?`, [deliveryTicketId]
  );
  if (!dt) return res.status(404).json({ error: 'Delivery Ticket not found.' });
  if (dt.status === 'void') return res.status(409).json({ error: 'This Delivery Ticket is void and cannot be billed.' });
  if (dt.status === 'converted') return res.status(409).json({ error: 'This Delivery Ticket has already been converted to an Invoice.' });

  const [storedLines] = await conn.query(
    `SELECT dtl.*, (SELECT t.rate FROM taxes t WHERE t.code = dtl.tax_code LIMIT 1) AS tax_rate
       FROM delivery_ticket_lines dtl WHERE dtl.delivery_ticket_id = ? ORDER BY dtl.line_no`, [deliveryTicketId]
  );
  if (!storedLines.length) return res.status(400).json({ error: 'This Delivery Ticket has no items to bill.' });
  // The ticket's lines are billed as stored, except any whose Price/Unit the biller changed on the
  // form -- those are recomputed from the new price (see priceOverrideFor).
  // A line's Gross is billed as its Net + Tax. Tickets carried over from the source store a Gross
  // worked from the unrounded net (DT-6504 line 1: 5,854.95 + 702.59 stored as 6,557.55), so
  // adding those up made the invoice a centavo off the ticket's own total, which is Net + Tax.
  const lines = storedLines.map((l) => {
    const price = priceOverrideFor(req.body, l.id);
    if (price === null) return { ...l, gross_amount: Number((Number(l.net_of_tax || 0) + Number(l.tax_amount || 0)).toFixed(2)) };
    const amounts = computeBillableLineAmounts({
      pricePerUnit: price, discPercent: l.disc_percent, taxRate: dtLineTaxRate(l), billableQty: Number(l.quantity) || 0,
    });
    return { ...l, repriced: true, ...repricedLine(l, price, amounts, Number(l.quantity) || 0) };
  });

  const sum = (key) => Number(lines.reduce((s, l) => s + Number(l[key] || 0), 0).toFixed(2));
  const ticketTotals = lines.some((l) => l.repriced) ? null : dtHeaderTotals(dt);
  const subtotal = ticketTotals ? ticketTotals.subtotal : sum('subtotal');
  const discountAmount = ticketTotals ? ticketTotals.discount_amount : sum('disc_amount');
  const netOfTax = ticketTotals ? ticketTotals.net_of_tax : sum('net_of_tax');
  const taxAmount = ticketTotals ? ticketTotals.tax_amount : sum('tax_amount');
  const grossAmount = ticketTotals ? ticketTotals.gross_amount : sum('gross_amount');
  const ewtAmount = Number((netOfTax * (Number(withholdingTaxPct || 0) / 100)).toFixed(2));
  const amountDue = Number((grossAmount - ewtAmount).toFixed(2));
  await assertPeriodOpen(dateCreated, 'ar', conn);

  await conn.beginTransaction();
  const [result] = await conn.query(
    `INSERT INTO sales_invoices
       (invoice_no, invoice_type, sales_order_id, delivery_ticket_id, date_created, date_due, term, bs_si_no, po_no,
        sales_rep_id, office_location_id, department_id, bill_to_address, memo, withholding_tax_pct,
        subtotal, discount_amount, net_of_tax, ewt_amount, tax_amount, gross_amount, amount_due, created_by_user_id)
     VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      // SI or DR -- a ticket converts to either, picked on its Bill menu.
      normaliseInvoiceType(req.body.invoice_type), dt.sales_order_id, deliveryTicketId, dateCreated || new Date().toISOString().slice(0, 10), dateDue || null,
      term || null, bsSiNo || null, poNo || null, salesRepId || null, officeLocationId || null, departmentId || null,
      billToAddress || null, memo || null, withholdingTaxPct || 0, subtotal, discountAmount, netOfTax,
      ewtAmount, taxAmount, grossAmount, amountDue, req.user.id,
    ]
  );
  const invoiceId = result.insertId;
  const invoiceNo = await assignDocNo(conn, { table: 'sales_invoices', column: 'invoice_no', prefix: 'INV-', id: invoiceId });
  await settleZeroInvoice(conn, invoiceId);

  for (const l of lines) {
    await conn.query(
      `INSERT INTO sales_invoice_lines
         (sales_invoice_id, sales_order_line_id, job_order_id, description, job_location_id, quantity, units,
          price_per_unit, subtotal, disc_percent, disc_amount, disc_price_per_unit, net_of_tax, tax_code,
          tax_amount, gross_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invoiceId, l.sales_order_line_id, l.job_order_id, l.description, l.location_id, l.quantity, l.units,
        l.price_per_unit, l.subtotal, l.disc_percent, l.disc_amount, l.disc_price_per_unit, l.net_of_tax,
        l.tax_code, l.tax_amount, l.gross_amount,
      ]
    );
    if (l.job_order_id && l.sales_order_line_id) {
      await conn.query(
        'UPDATE job_orders SET quantity_invoiced = quantity_invoiced + ?, updated_at = NOW() WHERE id = ?',
        [l.quantity, l.job_order_id]
      );
    }
  }

  await conn.query(
    "UPDATE delivery_tickets SET status = 'converted' WHERE id = ?", [deliveryTicketId]
  );
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('DeliveryTicket', ?, 'Status Change', 'status', 'open', 'converted', ?)`,
    [deliveryTicketId, req.user.id]
  );

  const [freshLines] = await conn.query(
    `SELECT sol.job_order_id, sol.quantity, jo.quantity_built, jo.quantity_inspected, jo.quantity_delivered, ${invoicedOrTicketedSql('jo')}
     FROM sales_order_lines sol
     LEFT JOIN job_orders jo ON jo.id = sol.job_order_id WHERE sol.sales_order_id = ?`,
    [dt.sales_order_id]
  );
  const newSoStatus = computeSalesOrderStatus(freshLines);
  await conn.query('UPDATE sales_orders SET status = ?, updated_at = NOW() WHERE id = ?', [newSoStatus, dt.sales_order_id]);
  await logAudit(conn, { invoiceId, userId: req.user.id, eventType: 'Created', fieldName: 'invoice_no', newValue: invoiceNo });
  await conn.commit();

  const [[row]] = await pool.query('SELECT * FROM sales_invoices WHERE id = ?', [invoiceId]);
  return res.status(201).json(row);
}

// Saving is what actually marks each included SO line as billed -- every line's own
// quantity_delivered - quantity_invoiced gap gets caught up in one shot (the real form
// has no per-line "amount to invoice" input, just Delete to exclude a line entirely).
// Bills an Estimate directly. Reached from Create New on the invoice list, for work that is
// invoiced before it is ever converted into a Sales Order.
//
// What this deliberately does NOT do, against the Sales Order path:
//   - no delivered-minus-invoiced arithmetic: there are no Job Orders to have delivered anything
//   - no job_orders.quantity_invoiced update, for the same reason
//   - no Sales Order status recompute
// The Estimate's own line figures are written through as they stand, because they were priced and
// approved there. The invoice is still an INV-#, as every invoice in this build is.
//
// BUT IT DOES RECORD THE SALES ORDER, when the estimate has one. "Invoiced before it is ever
// converted" is the case this path was built for, not the only case it serves: an estimate is
// billable from pending_customer_approval AND from approved, and reaching approved is exactly
// what generates the Sales Order. So the common path here is an estimate that HAS an order, and
// writing sales_order_id NULL left those invoices off that order's Related Records entirely --
// invisible from the order they belong to. Two live invoices were in that state.
//
// Recording the link is all this does. The quantity accounting above stays untouched, so the
// order's own billed/delivered figures do not move; the invoice becomes findable from the order
// rather than counted by it. Findable, not yet listed: the order's Related Records tab holds an
// estimate-sourced invoice back until the job orders behind it are finished -- see the
// by-sales-order route above for that gate and why it lives there rather than here.
async function billEstimate(req, res, conn) {
  const {
    estimate_id: estimateId, date_created: dateCreated, date_due: dateDue, term, bs_si_no: bsSiNo,
    po_no: poNo, sales_rep_id: salesRepId, office_location_id: officeLocationId, department_id: departmentId,
    bill_to_address: billToAddress, memo, withholding_tax_pct: withholdingTaxPct,
    estimate_job_order_ids: submitted,
  } = req.body;

  const [[est]] = await conn.query(
    'SELECT id, estimate_no, sales_rep_id, status, sales_order_id FROM estimates WHERE id = ?', [estimateId]);
  if (!est) return res.status(404).json({ error: 'That Estimate no longer exists.' });

  // The same visibility rule as everywhere else: an Account Officer cannot bill an estimate they
  // are not allowed to see. Checked on the server because the picker being filtered is not a
  // restriction.
  const salesScope = await getSalesRepEmployeeScope(req.user.id, ROUTE);
  if (salesScope && !salesScope.includes(est.sales_rep_id)) {
    return res.status(404).json({ error: 'That Estimate no longer exists.' });
  }

  // THE decision point. A filtered picker and a refusing form are both conveniences; this is the
  // one an estimate cannot be billed around, including by a request that never went near the UI.
  // Re-read inside the request rather than trusted from when the form was opened -- an estimate
  // can be cancelled between opening Create SI and pressing Save.
  const blocked = whyNotBillable(est);
  if (blocked) return res.status(409).json({ error: blocked });

  const submittedIds = (Array.isArray(submitted) ? submitted : []).map(Number).filter(Boolean);
  if (!submittedIds.length) return res.status(400).json({ error: 'Include at least one item.' });

  // job_order_id comes along when the Estimate has been converted, so the saved invoice shows the
  // same JO # the form did. It is recorded, NOT billed: quantity_invoiced is left alone, because
  // that running total belongs to the Sales Order path and tracks delivered-versus-invoiced. An
  // estimate-sourced invoice has not delivered anything.
  const [lines] = await conn.query(
    `SELECT ejo.*, t.code AS tax_code, sol.job_order_id
       FROM estimate_job_orders ejo
       LEFT JOIN taxes t ON t.id = ejo.tax_code_id
       LEFT JOIN sales_order_lines sol ON sol.estimate_job_order_id = ejo.id
      WHERE ejo.estimate_id = ? AND ejo.id IN (?)`,
    [estimateId, submittedIds]
  );
  if (lines.length !== submittedIds.length) {
    return res.status(400).json({ error: 'One of the selected items is no longer on this Estimate.' });
  }

  const num = (v) => Number(v || 0);
  const subtotal = lines.reduce((s, l) => s + num(l.subtotal), 0);
  const discountAmount = lines.reduce((s, l) => s + num(l.disc_amount), 0);
  const netOfTax = lines.reduce((s, l) => s + num(l.net_of_tax), 0);
  const taxAmount = lines.reduce((s, l) => s + num(l.tax_amount), 0);
  const grossAmount = lines.reduce((s, l) => s + num(l.gross_amount), 0);
  const ewtAmount = netOfTax * (num(withholdingTaxPct) / 100);
  const amountDue = grossAmount - ewtAmount;
  await assertPeriodOpen(dateCreated, 'ar', conn);

  await conn.beginTransaction();
  const [result] = await conn.query(
    `INSERT INTO sales_invoices
       (invoice_no, sales_order_id, estimate_id, date_created, date_due, term, bs_si_no, po_no, sales_rep_id,
        office_location_id, department_id, bill_to_address, memo, withholding_tax_pct, subtotal,
        discount_amount, net_of_tax, ewt_amount, tax_amount, gross_amount, amount_due, created_by_user_id)
     VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      est.sales_order_id || null,
      estimateId, dateCreated || new Date().toISOString().slice(0, 10), dateDue || null, term || null,
      bsSiNo || null, poNo || null, salesRepId || null, officeLocationId || null, departmentId || null,
      billToAddress || null, memo || null, withholdingTaxPct || 0, subtotal, discountAmount, netOfTax,
      ewtAmount, taxAmount, grossAmount, amountDue, req.user.id,
    ]
  );
  const invoiceId = result.insertId;
  const invoiceNo = await assignDocNo(conn, { table: 'sales_invoices', column: 'invoice_no', prefix: 'INV-', id: invoiceId });
  await settleZeroInvoice(conn, invoiceId);

  for (const l of lines) {
    await conn.query(
      `INSERT INTO sales_invoice_lines
         (sales_invoice_id, sales_order_line_id, estimate_job_order_id, job_type_id, job_order_id, description,
          job_location_id, quantity, units, price_per_unit, subtotal, disc_percent, disc_amount,
          disc_price_per_unit, net_of_tax, tax_code, tax_amount, gross_amount)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invoiceId, l.id, l.job_type_id, l.job_order_id || null, l.description, l.job_location_id, l.quantity, l.units,
        l.price_per_unit, l.subtotal, l.disc_percent, l.disc_amount, l.disc_price_per_unit,
        l.net_of_tax, l.tax_code, l.tax_amount, l.gross_amount,
      ]
    );
  }

  await logAudit(conn, {
    invoiceId, userId: req.user.id, eventType: 'Created', fieldName: 'invoice_no', newValue: invoiceNo,
  });
  await logAudit(conn, {
    invoiceId, userId: req.user.id, eventType: 'Created', fieldName: 'estimate_id', newValue: est.estimate_no,
  });
  await conn.commit();

  const [[row]] = await pool.query('SELECT * FROM sales_invoices WHERE id = ?', [invoiceId]);
  return res.status(201).json(row);
}

// Billing a Non-Standard Sales Order. The Sales Order path below, line for line, over the NSSO's
// lines: each selected line's Job Order must have delivered-but-uninvoiced quantity, that
// remaining quantity is what is billed, and the Job Order's quantity_invoiced moves by it. The
// customer is the NSSO's -- the invoice records nsso_id and each line its nsso_line_id.
async function billNsso(req, res, conn) {
  const {
    nsso_id: nssoId, date_created: dateCreated, date_due: dateDue, term, bs_si_no: bsSiNo,
    po_no: poNo, sales_rep_id: salesRepId, office_location_id: officeLocationId, department_id: departmentId,
    bill_to_address: billToAddress, memo, withholding_tax_pct: withholdingTaxPct, nsso_line_ids: lineIds,
  } = req.body;

  const [[ns]] = await conn.query('SELECT id, nsso_no, status FROM non_standard_sales_orders WHERE id = ?', [nssoId]);
  if (!ns) return res.status(404).json({ error: 'Not found' });
  if (ns.status === 'cancelled') return res.status(409).json({ error: 'This NSSO is cancelled.' });

  const submittedIds = (Array.isArray(lineIds) ? lineIds : []).map(Number);
  if (!submittedIds.length) return res.status(400).json({ error: 'Include at least one item.' });

  const [rawLines] = await conn.query(
    `SELECT l.*, jo.id AS job_order_id, jo.quantity_delivered, jo.quantity_invoiced, t.rate AS tax_rate
     FROM non_standard_sales_order_lines l JOIN job_orders jo ON jo.id = l.created_job_order_id
     LEFT JOIN taxes t ON t.id = l.tax_code_id
     WHERE l.nsso_id = ? AND l.id IN (?)`,
    [nssoId, submittedIds]
  );
  if (rawLines.length !== submittedIds.length) return res.status(400).json({ error: 'One of the selected items is no longer eligible.' });
  for (const l of rawLines) {
    if (Number(l.quantity_delivered) <= Number(l.quantity_invoiced)) {
      return res.status(409).json({ error: `Line ${l.line_no} has nothing left to invoice.` });
    }
  }

  const lines = rawLines.map((l) => {
    const invoicedNow = Number(l.quantity_delivered) - Number(l.quantity_invoiced);
    const price = priceOverrideFor(req.body, l.id);
    const amounts = computeBillableLineAmounts({
      pricePerUnit: price ?? l.price_per_unit, discPercent: l.disc_percent, taxRate: l.tax_rate, billableQty: invoicedNow,
    });
    return {
      ...l,
      invoicedNow,
      ...(price === null ? amounts : repricedLine(l, price, amounts, invoicedNow)),
    };
  });

  const subtotal = lines.reduce((s, l) => s + Number(l.subtotal || 0), 0);
  const discountAmount = lines.reduce((s, l) => s + Number(l.disc_amount || 0), 0);
  const netOfTax = lines.reduce((s, l) => s + Number(l.net_of_tax || 0), 0);
  const taxAmount = lines.reduce((s, l) => s + Number(l.tax_amount || 0), 0);
  const grossAmount = lines.reduce((s, l) => s + Number(l.gross_amount || 0), 0);
  const ewtAmount = netOfTax * (Number(withholdingTaxPct || 0) / 100);
  const amountDue = grossAmount - ewtAmount;
  await assertPeriodOpen(dateCreated, 'ar', conn);

  await conn.beginTransaction();
  const [result] = await conn.query(
    `INSERT INTO sales_invoices
       (invoice_no, invoice_type, nsso_id, date_created, date_due, term, bs_si_no, po_no, sales_rep_id, office_location_id,
        department_id, bill_to_address, memo, withholding_tax_pct, subtotal, discount_amount, net_of_tax,
        ewt_amount, tax_amount, gross_amount, amount_due, created_by_user_id)
     VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      normaliseInvoiceType(req.body.invoice_type), nssoId, dateCreated || new Date().toISOString().slice(0, 10), dateDue || null, term || null,
      bsSiNo || null, poNo || null, salesRepId || null, officeLocationId || null, departmentId || null,
      billToAddress || null, memo || null, withholdingTaxPct || 0, subtotal, discountAmount, netOfTax,
      ewtAmount, taxAmount, grossAmount, amountDue, req.user.id,
    ]
  );
  const invoiceId = result.insertId;
  const invoiceNo = await assignDocNo(conn, { table: 'sales_invoices', column: 'invoice_no', prefix: 'INV-', id: invoiceId });
  await settleZeroInvoice(conn, invoiceId);

  for (const l of lines) {
    await conn.query(
      `INSERT INTO sales_invoice_lines
         (sales_invoice_id, nsso_line_id, job_type_id, job_order_id, description, job_location_id, quantity, units,
          price_per_unit, subtotal, disc_percent, disc_amount, disc_price_per_unit, net_of_tax, tax_code,
          tax_amount, gross_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT code FROM taxes WHERE id = ?), ?, ?)`,
      [
        invoiceId, l.id, l.job_type_id, l.job_order_id, l.description, l.job_location_id, l.invoicedNow, l.units,
        l.price_per_unit, l.subtotal, l.disc_percent, l.disc_amount,
        l.invoicedNow ? Number((Number(l.net_of_tax) / l.invoicedNow).toFixed(4)) : null, l.net_of_tax,
        l.tax_code_id, l.tax_amount, l.gross_amount,
      ]
    );
    await conn.query(
      'UPDATE job_orders SET quantity_invoiced = quantity_invoiced + ?, updated_at = NOW() WHERE id = ?',
      [l.invoicedNow, l.job_order_id]
    );
  }

  await recomputeNssoStatus(conn, nssoId);
  await logAudit(conn, { invoiceId, userId: req.user.id, eventType: 'Created', fieldName: 'invoice_no', newValue: invoiceNo });
  await logAudit(conn, { invoiceId, userId: req.user.id, eventType: 'Created', fieldName: 'nsso_id', newValue: ns.nsso_no });
  await conn.commit();

  const [[row]] = await pool.query('SELECT * FROM sales_invoices WHERE id = ?', [invoiceId]);
  return res.status(201).json(row);
}

// A standalone invoice names its customer itself and has no source document.
const isStandalone = (b) => Boolean(b && b.customer_id && !b.sales_order_id && !b.estimate_id && !b.nsso_id && !b.delivery_ticket_id);

// Billing a customer directly, with item lines and no order behind it -- the source raises its
// monthly rent this way (INV-83455: RENTAL, 1 LOT x 15,000, 8% withheld). Nothing is delivered
// against it and no Job Order moves, so the lines are exactly what was typed; the amounts are
// computed here from quantity, price, discount and the tax code's rate, never taken from the
// browser. The customer is recorded on the invoice itself (sales_invoices.customer_id).
async function billStandalone(req, res, conn) {
  const {
    customer_id: customerId, date_created: dateCreated, date_due: dateDue, term, bs_si_no: bsSiNo,
    po_no: poNo, sales_rep_id: salesRepId, office_location_id: officeLocationId, department_id: departmentId,
    bill_to_address: billToAddress, memo, withholding_tax_pct: withholdingTaxPct, lines: rawLines,
  } = req.body;

  const [[cust]] = await conn.query('SELECT id, name FROM customers WHERE id = ?', [customerId]);
  if (!cust) return res.status(400).json({ error: 'Choose a customer.' });

  const submitted = (Array.isArray(rawLines) ? rawLines : []).filter((l) => Number(l.quantity) > 0);
  if (!submitted.length) return res.status(400).json({ error: 'Add at least one item with a quantity.' });

  const itemIds = [...new Set(submitted.map((l) => Number(l.item_id)).filter(Boolean))];
  const [items] = itemIds.length
    ? await conn.query('SELECT id, item_code, display_name FROM inventories WHERE id IN (?)', [itemIds])
    : [[]];
  const itemById = new Map(items.map((i) => [i.id, i]));
  const [taxes] = await conn.query('SELECT id, code, rate FROM taxes');
  const taxById = new Map(taxes.map((t) => [t.id, t]));

  const lines = [];
  for (const l of submitted) {
    const item = l.item_id ? itemById.get(Number(l.item_id)) : null;
    if (l.item_id && !item) return res.status(400).json({ error: 'One of the items no longer exists.' });
    const description = String(l.description || '').trim() || (item ? item.display_name : '');
    if (!description) return res.status(400).json({ error: 'Every line needs an item or a description.' });
    const price = Number(l.price_per_unit);
    if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: `Enter a price for ${description}.` });
    const tax = l.tax_code_id ? taxById.get(Number(l.tax_code_id)) : null;
    const qty = Number(l.quantity);
    const amounts = computeBillableLineAmounts({
      pricePerUnit: price, discPercent: l.disc_percent, taxRate: tax ? tax.rate : 0, billableQty: qty,
    });
    lines.push({
      item_id: item ? item.id : null, description, quantity: qty, units: l.units || null, price_per_unit: price,
      disc_percent: Number(l.disc_percent || 0), tax_code: tax ? tax.code : null, ...amounts,
    });
  }

  const subtotal = lines.reduce((sum, l) => sum + l.subtotal, 0);
  const discountAmount = lines.reduce((sum, l) => sum + l.disc_amount, 0);
  const netOfTax = lines.reduce((sum, l) => sum + l.net_of_tax, 0);
  const taxAmount = lines.reduce((sum, l) => sum + l.tax_amount, 0);
  const grossAmount = lines.reduce((sum, l) => sum + l.gross_amount, 0);
  const ewtAmount = Number((netOfTax * (Number(withholdingTaxPct || 0) / 100)).toFixed(2));
  const amountDue = Number((grossAmount - ewtAmount).toFixed(2));
  await assertPeriodOpen(dateCreated, 'ar', conn);

  await conn.beginTransaction();
  const [result] = await conn.query(
    `INSERT INTO sales_invoices
       (invoice_no, invoice_type, customer_id, date_created, date_due, term, bs_si_no, po_no, sales_rep_id, office_location_id,
        department_id, bill_to_address, memo, withholding_tax_pct, subtotal, discount_amount, net_of_tax,
        ewt_amount, tax_amount, gross_amount, amount_due, created_by_user_id)
     VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      normaliseInvoiceType(req.body.invoice_type), cust.id, dateCreated || new Date().toISOString().slice(0, 10), dateDue || null, term || null,
      bsSiNo || null, poNo || null, salesRepId || null, officeLocationId || null, departmentId || null,
      billToAddress || null, memo || null, withholdingTaxPct || 0, subtotal, discountAmount, netOfTax,
      ewtAmount, taxAmount, grossAmount, amountDue, req.user.id,
    ]
  );
  const invoiceId = result.insertId;
  const invoiceNo = await assignDocNo(conn, { table: 'sales_invoices', column: 'invoice_no', prefix: 'INV-', id: invoiceId });
  await settleZeroInvoice(conn, invoiceId);

  for (const l of lines) {
    await conn.query(
      `INSERT INTO sales_invoice_lines
         (sales_invoice_id, item_id, description, quantity, units, price_per_unit, subtotal, disc_percent,
          disc_amount, disc_price_per_unit, net_of_tax, tax_code, tax_amount, gross_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invoiceId, l.item_id, l.description, l.quantity, l.units, l.price_per_unit, l.subtotal, l.disc_percent,
        l.disc_amount, l.quantity ? Number((l.net_of_tax / l.quantity).toFixed(4)) : null, l.net_of_tax,
        l.tax_code, l.tax_amount, l.gross_amount,
      ]
    );
  }

  await logAudit(conn, { invoiceId, userId: req.user.id, eventType: 'Created', fieldName: 'invoice_no', newValue: invoiceNo });
  await logAudit(conn, { invoiceId, userId: req.user.id, eventType: 'Created', fieldName: 'customer_id', newValue: cust.name });
  await conn.commit();

  const [[row]] = await pool.query('SELECT * FROM sales_invoices WHERE id = ?', [invoiceId]);
  return res.status(201).json(row);
}

// Which permission a create needs depends on what is being created.
//
// Raising an invoice against an Estimate is an ADD -- Create New on the invoice list, a new
// document off a document that is not itself changed by it. Billing a Sales Order or a Delivery
// Ticket is not: those move job_orders.quantity_invoiced, recompute the order's status, or flip a
// ticket to converted, which is amending work that already exists. So they keep requiring
// can_edit, and only the Estimate path answers to can_add.
//
// Nobody loses anything by this: every account currently holding can_edit on this page also holds
// can_add, so the button's audience only grows -- by the four Sales accounts that had can_add and
// no way to use it.
// ...EXCEPT outside Head Office, where BILLING IS THE REP'S OWN JOB.
//
// Those two actions assume a separation of duties that only exists at Head Office: someone raises
// the order, Accounting down the corridor turns it into an invoice. A branch has no Accounting
// desk. The rep who took the order is the person who bills it, so the permission that models "may
// this account hand work to Accounting" has nothing to say about them -- and it was refusing them
// on a rule written for an office they do not work in.
//
// So for a user whose default location is not Head Office, holding the Sales Invoices page at all
// (can_view) is enough to raise one. This is deliberately looser than can_add: the branch accounts
// carry view-only rows -- Roselyn Tundag, who this was reported from, has can_view and neither of
// the other two -- so asking for can_add would have changed the error message and nothing else.
// Head Office is untouched and still answers to can_add / can_edit as before.
//
// An account with NO default location at all counts as Head Office, i.e. the stricter side; see
// lib/userLocation.js. The location comes from the account, never from the request, so this cannot
// be steered by what gets posted.
async function requireInvoiceCreatePermission(req, res, next) {
  try {
    if (!(await isHeadOfficeUser(req.user.id))) {
      if (await userCan(req.user.id, ROUTE, 'can_view')) return next();
      return res.status(403).json({ error: 'You do not have permission to perform this action' });
    }
    const action = req.body?.estimate_id || isStandalone(req.body) ? 'can_add' : 'can_edit';
    if (await userCan(req.user.id, ROUTE, action)) return next();
    return res.status(403).json({ error: 'You do not have permission to perform this action' });
  } catch (err) {
    return next(err);
  }
}

router.post('/', requireAuth, requireInvoiceCreatePermission, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    // An invoice belongs to its order's office (asked 2026-11-17): billed from a Sales Order (or one of
    // its Delivery Tickets) it takes the Sales Order's Office Location, from an NSSO the NSSO's --
    // whatever the form sent. INV-83565 and nine more were raised from Branch - SM orders as Head Office.
    if (req.body && !req.body.estimate_id) {
      const [[parent]] = req.body.nsso_id
        ? await conn.query('SELECT office_location_id FROM non_standard_sales_orders WHERE id = ?', [req.body.nsso_id])
        : req.body.sales_order_id
          ? await conn.query('SELECT office_location_id FROM sales_orders WHERE id = ?', [req.body.sales_order_id])
          : [[null]];
      if (parent && parent.office_location_id) req.body.office_location_id = parent.office_location_id;
    }
    const {
      sales_order_id: salesOrderId, date_created: dateCreated, date_due: dateDue, term, bs_si_no: bsSiNo,
      po_no: poNo, sales_rep_id: salesRepId, office_location_id: officeLocationId, department_id: departmentId,
      bill_to_address: billToAddress, memo, withholding_tax_pct: withholdingTaxPct, sales_order_line_ids: lineIds,
    } = req.body;
    // Checked once here, ahead of the dispatch, because every billing path below (estimate, NSSO,
    // standalone, delivery ticket, sales order) reads the same department_id.
    const deptError = headerDepartmentError(departmentId);
    if (deptError) return res.status(400).json({ error: deptError });
    // An SI billed from a Sales Order or a Delivery Ticket carries its printed BS/SI serial (asked
    // 2026-11-10); a DR needs none. The Estimate, NSSO and standalone paths are unchanged.
    const fromSoOrTicket = !req.body.estimate_id && !req.body.nsso_id && (req.body.delivery_ticket_id || salesOrderId);
    if (fromSoOrTicket && req.body.invoice_type !== 'DR' && !String(bsSiNo || '').trim()) return res.status(400).json({ error: 'Enter the BS/SI #.' });

    // Each path below is AWAITED: a bare `return billX()` let its errors (a closed period) escape
    // the catch and crash the whole server, and released the connection while it was still in use.
    // Raising an invoice against an Estimate is its own path: no Sales Order, no Job Orders, and
    // so nothing to net off or to advance a status on. Checked before the Sales Order guard below,
    // which would otherwise reject it for the very thing that makes it what it is.
    if (req.body.estimate_id) {
      return await billEstimate(req, res, conn);
    }
    // A Non-Standard Sales Order bills like a Sales Order, from its own lines and Job Orders.
    if (req.body.nsso_id) {
      return await billNsso(req, res, conn);
    }
    // No order at all: a customer and item lines (monthly rent, one-off charges).
    if (isStandalone(req.body)) {
      return await billStandalone(req, res, conn);
    }

    if (!salesOrderId) return res.status(400).json({ error: 'Sales Order is required.' });

    // Billing a Delivery Ticket is a different path entirely: the ticket's own lines are
    // what get invoiced (its ad-hoc charges included), not the Sales Order's
    // delivered-but-unbilled gap. Handled in its own function to keep the two flows from
    // growing into each other.
    if (req.body.delivery_ticket_id) {
      return await billDeliveryTicket(req, res, conn);
    }

    const submittedIds = (Array.isArray(lineIds) ? lineIds : []).map(Number);
    if (!submittedIds.length) return res.status(400).json({ error: 'Include at least one item.' });

    const [rawLines] = await conn.query(
      `SELECT sol.*, jo.id AS job_order_id, jo.quantity_delivered, jo.quantity_invoiced, t.rate AS tax_rate,
              ${openDtQtySql()} AS open_dt_qty
       FROM sales_order_lines sol JOIN job_orders jo ON jo.id = sol.job_order_id
       LEFT JOIN taxes t ON t.id = sol.tax_code_id
       WHERE sol.sales_order_id = ? AND sol.id IN (?)`,
      [salesOrderId, submittedIds]
    );
    if (rawLines.length !== submittedIds.length) return res.status(400).json({ error: 'One of the selected items is no longer eligible.' });
    for (const l of rawLines) {
      // What sits on an open Delivery Ticket is billed when that ticket is converted, not here.
      if (Number(l.quantity_delivered) <= Number(l.quantity_invoiced) + Number(l.open_dt_qty)) {
        return res.status(409).json({ error: `Line ${l.line_no} has nothing left to invoice (check its open Delivery Tickets).` });
      }
    }

    // The delta caught up in *this* transaction -- not the line's full ordered qty -- is
    // what gets billed (a JO can be delivered short of its ordered qty while still fully
    // caught up on invoicing so far, e.g. Built=QI=Delivered=1 of an ordered qty=2), same
    // running-total discipline as Item Fulfillment/Receipt/Delivery. price_per_unit/
    // disc_percent/tax rate are fixed per-unit rates, so Subtotal/Disc/Net/Tax/Gross are
    // recomputed against that billable qty rather than copied from the line's full-Qty totals.
    const lines = rawLines.map((l) => {
      const billable = Number(l.quantity_delivered) - Number(l.quantity_invoiced) - Number(l.open_dt_qty);
      const invoicedNow = qtyOverrideFor(req.body, l.id, billable, l.line_no) ?? billable;
      const price = priceOverrideFor(req.body, l.id);
      if (price === null) return { ...l, invoicedNow, ...soLineBillableAmounts(l, l.quantity, invoicedNow) };
      const amounts = computeBillableLineAmounts({
        pricePerUnit: price, discPercent: l.disc_percent, taxRate: l.tax_rate, billableQty: invoicedNow,
      });
      return { ...l, invoicedNow, ...repricedLine(l, price, amounts, invoicedNow) };
    });

    const subtotal = lines.reduce((s, l) => s + Number(l.subtotal || 0), 0);
    const discountAmount = lines.reduce((s, l) => s + Number(l.disc_amount || 0), 0);
    const netOfTax = lines.reduce((s, l) => s + Number(l.net_of_tax || 0), 0);
    const taxAmount = lines.reduce((s, l) => s + Number(l.tax_amount || 0), 0);
    const grossAmount = lines.reduce((s, l) => s + Number(l.gross_amount || 0), 0);
    const ewtAmount = netOfTax * (Number(withholdingTaxPct || 0) / 100);
    const amountDue = grossAmount - ewtAmount;
    await assertPeriodOpen(dateCreated, 'ar', conn);

    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO sales_invoices
         (invoice_no, invoice_type, sales_order_id, date_created, date_due, term, bs_si_no, po_no, sales_rep_id, office_location_id,
          department_id, bill_to_address, memo, withholding_tax_pct, subtotal, discount_amount, net_of_tax,
          ewt_amount, tax_amount, gross_amount, amount_due, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        normaliseInvoiceType(req.body.invoice_type), salesOrderId, dateCreated || new Date().toISOString().slice(0, 10), dateDue || null, term || null,
        bsSiNo || null, poNo || null, salesRepId || null, officeLocationId || null, departmentId || null,
        billToAddress || null, memo || null, withholdingTaxPct || 0, subtotal, discountAmount, netOfTax,
        ewtAmount, taxAmount, grossAmount, amountDue, req.user.id,
      ]
    );
    const invoiceId = result.insertId;
    // The record itself is always an "Invoice" (INV-#), regardless of which Bill
    // dropdown option created it -- SI/BS/DR/DT is only ever its Type, not its number.
    const invoiceNo = await assignDocNo(conn, { table: 'sales_invoices', column: 'invoice_no', prefix: 'INV-', id: invoiceId });
    await settleZeroInvoice(conn, invoiceId);

    for (const l of lines) {
      await conn.query(
        `INSERT INTO sales_invoice_lines
           (sales_invoice_id, sales_order_line_id, job_order_id, description, job_location_id, quantity, units,
            price_per_unit, subtotal, disc_percent, disc_amount, disc_price_per_unit, net_of_tax, tax_code,
            tax_amount, gross_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT code FROM taxes WHERE id = ?), ?, ?)`,
        [
          invoiceId, l.id, l.job_order_id, l.description, l.job_location_id, l.invoicedNow, l.units,
          l.price_per_unit, l.subtotal, l.disc_percent, l.disc_amount, l.disc_price_per_unit, l.net_of_tax,
          l.tax_code_id, l.tax_amount, l.gross_amount,
        ]
      );
      await conn.query(
        'UPDATE job_orders SET quantity_invoiced = quantity_invoiced + ?, updated_at = NOW() WHERE id = ?',
        [l.invoicedNow, l.job_order_id]
      );
    }

    // A Sales Order's status is only ever as advanced as its *least* advanced line --
    // see computeSalesOrderStatus for the full hierarchy (an unstarted line elsewhere
    // pulls the whole order back to "In Process" even after this one's fully billed).
    const [freshLines] = await conn.query(
      `SELECT sol.job_order_id, sol.quantity, jo.quantity_built, jo.quantity_inspected, jo.quantity_delivered, ${invoicedOrTicketedSql('jo')}
       FROM sales_order_lines sol
       LEFT JOIN job_orders jo ON jo.id = sol.job_order_id WHERE sol.sales_order_id = ?`,
      [salesOrderId]
    );
    const newSoStatus = computeSalesOrderStatus(freshLines);
    await conn.query('UPDATE sales_orders SET status = ?, updated_at = NOW() WHERE id = ?', [newSoStatus, salesOrderId]);
    await logAudit(conn, { invoiceId, userId: req.user.id, eventType: 'Created', fieldName: 'invoice_no', newValue: invoiceNo });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM sales_invoices WHERE id = ?', [invoiceId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Editing an OPEN invoice -- the header only.
//
// WHY ONLY WHILE IT IS OPEN, AND ONLY WHILE NOTHING HAS SETTLED IT. A payment or a credit memo
// draws this invoice's Amount Due down and records itself against the id; moving the figure
// underneath one would leave the settlement claiming an amount the invoice no longer shows, with
// nothing recording that it happened. Same line the Customer Payment edit draws at its deposit.
// Past that point the correction is a void and a re-issue, which is what the Void button is for.
//
// WHY NOT THE LINES. The items come from delivered-but-unbilled quantities and billing them bumps
// job_orders.quantity_invoiced and re-derives the Sales Order's status. Re-opening that here would
// mean unwinding those running totals per line, and getting it wrong silently lets the same
// delivery be billed twice. The header is where the mistakes this is for actually live -- a
// mistyped PO number, the wrong term or due date, a missing BS/SI number, the wrong EWT rate --
// so lines, quantities and prices stay fixed and the totals below are recomputed, never re-summed.
//
// No GL to unwind: computeSalesInvoiceGl derives the entries on read, so a corrected figure shows
// in GL Impact the moment it is saved.
// Why this invoice cannot be edited, or null when it can. Shared by the detail read and the save
// so the button and the refusal cannot disagree: the page asks the same question the server will
// answer, rather than inferring it from the related-records lists -- which sit behind
// /customer-payments and /credit-memos permissions and come back empty for anyone without them,
// making an un-editable invoice look editable to exactly the people least able to tell.
async function whyNotEditable(conn, si) {
  if (si.status === 'cancelled') return 'A voided Invoice cannot be edited.';
  if (si.status !== 'saved') {
    return 'This Invoice is no longer open, so it can no longer be edited. Void it and re-issue if it is wrong.';
  }
  // Read off the settlement documents, not the status: the two disagree on plenty of migrated
  // rows -- see lib/arAging.js on invoices marked paid with nothing recording it.
  const [[settled]] = await conn.query(
    `SELECT
       COALESCE((SELECT SUM(l.applied_amount) FROM customer_payment_lines l
                   JOIN customer_payments cp ON cp.id = l.customer_payment_id
                  WHERE l.sales_invoice_id = ? AND cp.status <> 'voided'), 0) AS paid,
       COALESCE((SELECT SUM(ca.applied_amount) FROM credit_memo_applications ca
                   JOIN credit_memos cm ON cm.id = ca.credit_memo_id
                  WHERE ca.sales_invoice_id = ? AND cm.status <> 'voided'), 0) AS credited`,
    [si.id, si.id],
  );
  if (Number(settled.paid) + Number(settled.credited) > 0.005) {
    return 'A payment or credit memo has been applied to this Invoice, so it can no longer be edited. Void that first, or void this Invoice and re-issue it.';
  }
  return null;
}

const INVOICE_EDIT_FIELDS = [
  ['date_created', 'date_created'], ['date_due', 'date_due'], ['term', 'term'],
  ['bs_si_no', 'bs_si_no'], ['po_no', 'po_no'], ['sales_rep_id', 'sales_rep_id'],
  ['office_location_id', 'office_location_id'], ['department_id', 'department_id'],
  ['bill_to_address', 'bill_to_address'], ['memo', 'memo'],
  ['withholding_tax_pct', 'withholding_tax_pct'],
];

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[si]] = await conn.query('SELECT * FROM sales_invoices WHERE id = ?', [req.params.id]);
    if (!si) return res.status(404).json({ error: 'Not found' });
    const refusal = await whyNotEditable(conn, si);
    if (refusal) return res.status(409).json({ error: refusal });
    // Sales Rep, Office Location and Department come from the order the invoice bills; only a System
    // Admin changes them (asked 2026-10-24). Anyone else's edit keeps what the invoice has; one it
    // has none of can still be filled.
    if (!(await isSystemAdmin(req.user.id))) {
      for (const f of ['sales_rep_id', 'office_location_id', 'department_id']) if (si[f] != null) delete req.body[f];
    }
    // An edit leaves out fields it is not changing, so the department checked is the one the
    // invoice will have after this save.
    const deptError = headerDepartmentError(req.body.department_id === undefined ? si.department_id : req.body.department_id);
    if (deptError) return res.status(400).json({ error: deptError });

    // Both periods: the one it sits in now and the one it is being moved to. Moving an invoice out
    // of a closed month is as much a change to that month as posting into one.
    const newDate = req.body.date_created ? String(req.body.date_created).slice(0, 10) : si.date_created;
    await assertPeriodOpen(si.date_created, 'ar', conn);
    if (String(newDate) !== String(si.date_created).slice(0, 10)) await assertPeriodOpen(newDate, 'ar', conn);

    const pct = req.body.withholding_tax_pct === undefined || req.body.withholding_tax_pct === null || req.body.withholding_tax_pct === ''
      ? Number(si.withholding_tax_pct || 0) : Number(req.body.withholding_tax_pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return res.status(400).json({ error: 'Withholding Tax % must be between 0 and 100.' });
    }

    // ---- per-item edits ----
    //
    // Quantity is the dangerous one and the reason lines were left alone at first: billing a line
    // ADDED its qty to job_orders.quantity_invoiced, which is what decides how much of a delivery
    // is still billable and, through computeSalesOrderStatus, what the Sales Order's status says.
    // Editing the number on the invoice without moving that running total lets the same delivery
    // be billed twice. So a quantity change applies its DELTA to the job order, is capped at what
    // the job order has actually delivered, and re-derives the order's status afterwards -- the
    // same three steps the create path takes.
    //
    // Description, price and discount carry no such tie; they only re-price the line.
    const submittedLines = Array.isArray(req.body.lines) ? req.body.lines : [];
    const lineChanges = [];
    if (submittedLines.length) {
      const [existing] = await conn.query(
        `SELECT sil.*, jo.quantity_delivered, jo.quantity_invoiced,
                COALESCE(t1.rate, t2.rate, 0) AS tax_rate
           FROM sales_invoice_lines sil
           LEFT JOIN job_orders jo ON jo.id = sil.job_order_id
           LEFT JOIN sales_order_lines sol ON sol.id = sil.sales_order_line_id
           LEFT JOIN taxes t1 ON t1.id = sol.tax_code_id
           LEFT JOIN taxes t2 ON t2.code = sil.tax_code
          WHERE sil.sales_invoice_id = ?`,
        [req.params.id],
      );
      const byId = new Map(existing.map((l) => [Number(l.id), l]));
      // Tax Code is editable per line (asked 2026-10-07) -- one of the active codes, or none.
      const [taxRows] = await conn.query('SELECT code, rate FROM taxes WHERE is_active = 1');
      const taxByCode = new Map(taxRows.map((t) => [t.code, Number(t.rate || 0)]));

      for (const sub of submittedLines) {
        const cur = byId.get(Number(sub.id));
        if (!cur) return res.status(400).json({ error: 'One of the items is not on this Invoice.' });

        const oldQty = Number(cur.quantity || 0);
        const qty = sub.quantity === undefined || sub.quantity === null || sub.quantity === ''
          ? oldQty : Number(sub.quantity);
        if (!Number.isFinite(qty) || qty <= 0) {
          return res.status(400).json({ error: `Qty on ${cur.description || 'an item'} must be greater than 0.` });
        }
        // Headroom = what the job order delivered, less everything invoiced against it OTHER than
        // this line. Subtracting this line's own qty first is what lets an unchanged line re-save.
        if (cur.job_order_id) {
          const othersInvoiced = Number(cur.quantity_invoiced || 0) - oldQty;
          const available = Number(cur.quantity_delivered || 0) - othersInvoiced;
          if (qty > available + 1e-9) {
            return res.status(409).json({
              error: `Qty ${qty} on ${cur.description || 'an item'} exceeds what its job order has delivered and not yet billed (${available}).`,
            });
          }
        }

        const price = sub.price_per_unit === undefined || sub.price_per_unit === '' ? Number(cur.price_per_unit || 0) : Number(sub.price_per_unit);
        const disc = sub.disc_percent === undefined || sub.disc_percent === '' ? Number(cur.disc_percent || 0) : Number(sub.disc_percent);
        if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Unit Price cannot be negative.' });
        if (!Number.isFinite(disc) || disc < 0 || disc > 100) return res.status(400).json({ error: 'Discount % must be between 0 and 100.' });

        // THE RATE COMES FROM WHAT THE LINE WAS BILLED AT, not from the taxes table.
        //
        // sales_invoice_lines.tax_code holds the live system's code ('VAT_PH:VATIN-12'), while
        // the taxes table here has one row, coded 'VAT12'. So neither the code match nor the
        // sales_order_line's tax_code_id resolves for migrated lines -- sales_order_line_id is
        // itself unmapped on 121,008 of 121,012 lines -- and trusting that join zeroed the VAT
        // on every line it touched: a 1,568.00 invoice re-saved as 1,432.00 with its 12% gone.
        //
        // tax / net is the rate this line actually carries, exact for every rate in this data and
        // 0 for the zero-rated and exempt lines where there is nothing to recover. The table is
        // the fallback for a line with no net to divide by.
        //
        // A Tax Code CHANGED on the edit is the exception: the user is telling us the rate, so it
        // is that code's rate from the taxes table (no code = 0%).
        const taxCode = sub.tax_code === undefined ? cur.tax_code : (sub.tax_code || null);
        const taxCodeChanged = String(taxCode ?? '') !== String(cur.tax_code ?? '');
        if (taxCodeChanged && taxCode && !taxByCode.has(taxCode)) {
          return res.status(400).json({ error: `Tax Code ${taxCode} is not an active tax code.` });
        }
        const billedNet = Number(cur.net_of_tax || 0);
        const taxRate = taxCodeChanged
          ? (taxCode ? taxByCode.get(taxCode) : 0)
          : billedNet > 0
            ? (Number(cur.tax_amount || 0) / billedNet) * 100
            : Number(cur.tax_rate || 0);
        const amounts = computeBillableLineAmounts({
          pricePerUnit: price, discPercent: disc, taxRate, billableQty: qty,
        });
        // Tax Amount typed in by hand (asked 2026-10-07) -- e.g. to match a figure on the customer's
        // copy. It replaces the computed tax; Gross follows as Net + Tax.
        if (sub.tax_amount !== undefined && sub.tax_amount !== null && sub.tax_amount !== '') {
          const typedTax = Number(sub.tax_amount);
          if (!Number.isFinite(typedTax) || typedTax < 0) return res.status(400).json({ error: 'Tax Amount cannot be negative.' });
          amounts.tax_amount = Number(typedTax.toFixed(2));
          amounts.gross_amount = Number((Number(amounts.net_of_tax) + amounts.tax_amount).toFixed(2));
        }
        const description = sub.description === undefined ? cur.description : (sub.description || null);
        lineChanges.push({ cur, qty, price, disc, description, taxCode, amounts, qtyDelta: qty - oldQty });
      }
    }

    // ---- items removed (asked 2026-10-07: "add button to delete a JO line, the amount will change
    // automatically") ----
    // A removed line gives its qty back to its job order (quantity_invoiced), so the delivery is
    // billable again, and the totals are re-summed without it. Not on an invoice converted from a
    // Delivery Ticket: the ticket bills whole, and dropping a line here would leave its line billed
    // on the ticket -- that correction is void and re-issue. At least one item must remain.
    const removedIds = [...new Set((Array.isArray(req.body.removed_line_ids) ? req.body.removed_line_ids : [])
      .map(Number).filter(Boolean))];
    let removedLines = [];
    if (removedIds.length) {
      if (si.delivery_ticket_id) {
        return res.status(409).json({ error: 'This Invoice was billed from a Delivery Ticket, which bills whole. Void it and re-issue instead of removing an item.' });
      }
      [removedLines] = await conn.query(
        'SELECT id, job_order_id, quantity, description, gross_amount FROM sales_invoice_lines WHERE sales_invoice_id = ? AND id IN (?)',
        [req.params.id, removedIds],
      );
      if (removedLines.length !== removedIds.length) return res.status(400).json({ error: 'One of the removed items is not on this Invoice.' });
      const [[credited]] = await conn.query(
        `SELECT COUNT(*) AS n FROM credit_memo_lines l JOIN credit_memos cm ON cm.id = l.credit_memo_id
          WHERE l.sales_invoice_line_id IN (?) AND cm.status <> 'voided'`, [removedIds],
      );
      if (Number(credited.n)) return res.status(409).json({ error: 'A credit memo was raised against one of these items. Void the credit memo first.' });
      const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM sales_invoice_lines WHERE sales_invoice_id = ?', [req.params.id]);
      if (Number(n) - removedLines.length < 1) {
        return res.status(400).json({ error: 'An Invoice needs at least one item. Void it instead of removing them all.' });
      }
      // An edit to a line that is also being removed is moot.
      for (let i = lineChanges.length - 1; i >= 0; i -= 1) {
        if (removedIds.includes(Number(lineChanges[i].cur.id))) lineChanges.splice(i, 1);
      }
    }
    const removedSet = new Set(removedLines.map((l) => Number(l.id)));
    const linesMoved = lineChanges.length > 0 || removedLines.length > 0;

    // Header money, after the lines are known. With no line edits these stay the stored totals and
    // only EWT and Amount Due move; with line edits the five line-derived totals are re-summed
    // across every line -- the edited ones at their new amounts, the untouched ones as they stand,
    // the removed ones not at all.
    const money = { ...si };
    if (linesMoved) {
      const edited = new Map(lineChanges.map((c) => [Number(c.cur.id), c.amounts]));
      const [allLines] = await conn.query(
        'SELECT id, subtotal, disc_amount, net_of_tax, tax_amount, gross_amount FROM sales_invoice_lines WHERE sales_invoice_id = ?',
        [req.params.id],
      );
      const sum = (key) => allLines.filter((l) => !removedSet.has(Number(l.id))).reduce((s, l) => {
        const src = edited.get(Number(l.id)) || l;
        return s + Number(src[key] || 0);
      }, 0);
      money.subtotal = Number(sum('subtotal').toFixed(2));
      money.discount_amount = Number(sum('disc_amount').toFixed(2));
      money.net_of_tax = Number(sum('net_of_tax').toFixed(2));
      money.tax_amount = Number(sum('tax_amount').toFixed(2));
      money.gross_amount = Number(sum('gross_amount').toFixed(2));
    }
    const ewtAmount = Number((Number(money.net_of_tax || 0) * (pct / 100)).toFixed(2));
    const amountDue = Number((Number(money.gross_amount || 0) - ewtAmount).toFixed(2));

    const next = {};
    for (const [field, key] of INVOICE_EDIT_FIELDS) {
      if (req.body[key] === undefined) continue;
      const v = req.body[key];
      next[field] = v === '' ? null : v;
    }
    next.withholding_tax_pct = pct;
    next.ewt_amount = ewtAmount;
    next.amount_due = amountDue;
    if (linesMoved) {
      next.subtotal = money.subtotal;
      next.discount_amount = money.discount_amount;
      next.net_of_tax = money.net_of_tax;
      next.tax_amount = money.tax_amount;
      next.gross_amount = money.gross_amount;
    }

    await conn.beginTransaction();
    const cols = Object.keys(next);
    await conn.query(
      `UPDATE sales_invoices SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...cols.map((c) => next[c]), req.params.id],
    );
    await settleZeroInvoice(conn, req.params.id);

    // One audit row per field that actually moved -- an edit that changed the PO number should not
    // read as though it touched the whole invoice.
    const same = (a, b) => String(a ?? '') === String(b ?? '');
    for (const c of cols) {
      const before = c === 'date_created' || c === 'date_due'
        ? (si[c] ? String(si[c]).slice(0, 10) : null) : si[c];
      const after = c === 'date_created' || c === 'date_due'
        ? (next[c] ? String(next[c]).slice(0, 10) : null) : next[c];
      if (same(before, after)) continue;
      await logAudit(conn, {
        invoiceId: req.params.id, userId: req.user.id, eventType: 'Updated',
        fieldName: c, oldValue: before, newValue: after,
      });
    }

    // The lines themselves, and the job-order totals they move.
    const touchedJobOrders = new Set();
    for (const ch of lineChanges) {
      await conn.query(
        `UPDATE sales_invoice_lines
            SET description = ?, quantity = ?, price_per_unit = ?, subtotal = ?, disc_percent = ?,
                disc_amount = ?, disc_price_per_unit = ?, net_of_tax = ?, tax_code = ?, tax_amount = ?, gross_amount = ?
          WHERE id = ?`,
        [
          ch.description, ch.qty, ch.price, ch.amounts.subtotal, ch.disc,
          ch.amounts.disc_amount,
          // The discounted per-unit price the printed invoice shows, kept in step with the rest.
          Number((ch.price * (1 - ch.disc / 100)).toFixed(4)),
          ch.amounts.net_of_tax, ch.taxCode, ch.amounts.tax_amount, ch.amounts.gross_amount,
          ch.cur.id,
        ],
      );
      if (ch.qtyDelta && ch.cur.job_order_id) {
        // GREATEST, because the migrated data does not always agree with itself: plenty of job
        // orders carry quantity_invoiced 0 while an invoice line against them claims a billed
        // qty. Reducing such a line by the honest delta drove the running total NEGATIVE, which
        // is not a quantity and would read as headroom that does not exist. Clamped at zero, the
        // same way a voided customer payment unwinds an invoice's applied amount.
        await conn.query(
          'UPDATE job_orders SET quantity_invoiced = GREATEST(quantity_invoiced + ?, 0), updated_at = NOW() WHERE id = ?',
          [ch.qtyDelta, ch.cur.job_order_id],
        );
        touchedJobOrders.add(ch.cur.job_order_id);
      }
      for (const [field, before, after] of [
        ['description', ch.cur.description, ch.description],
        ['quantity', Number(ch.cur.quantity || 0), ch.qty],
        ['price_per_unit', Number(ch.cur.price_per_unit || 0), ch.price],
        ['disc_percent', Number(ch.cur.disc_percent || 0), ch.disc],
        ['tax_code', ch.cur.tax_code, ch.taxCode],
        ['tax_amount', Number(ch.cur.tax_amount || 0), Number(ch.amounts.tax_amount || 0)],
      ]) {
        if (String(before ?? '') === String(after ?? '')) continue;
        await logAudit(conn, {
          invoiceId: req.params.id, userId: req.user.id, eventType: 'Updated',
          fieldName: `line ${ch.cur.id} ${field}`, oldValue: before, newValue: after,
        });
      }
    }

    for (const rl of removedLines) {
      await conn.query('DELETE FROM sales_invoice_lines WHERE id = ?', [rl.id]);
      if (rl.job_order_id) {
        // Clamped at zero for the same reason as a qty decrease above.
        await conn.query(
          'UPDATE job_orders SET quantity_invoiced = GREATEST(quantity_invoiced - ?, 0), updated_at = NOW() WHERE id = ?',
          [Number(rl.quantity || 0), rl.job_order_id],
        );
        touchedJobOrders.add(rl.job_order_id);
      }
      await logAudit(conn, {
        invoiceId: req.params.id, userId: req.user.id, eventType: 'Updated',
        fieldName: `line ${rl.id} removed`, oldValue: `${rl.description || ''} (qty ${Number(rl.quantity || 0)}, ${Number(rl.gross_amount || 0).toFixed(2)})`, newValue: null,
      });
    }

    // A billed quantity changed, so what the Sales Order has left to bill changed with it. Derived
    // exactly as the create path does, from the job orders' own running totals.
    if (touchedJobOrders.size && si.sales_order_id) {
      const [freshLines] = await conn.query(
        `SELECT sol.job_order_id, sol.quantity, jo.quantity_built, jo.quantity_inspected,
                jo.quantity_delivered, ${invoicedOrTicketedSql('jo')}
           FROM sales_order_lines sol
           LEFT JOIN job_orders jo ON jo.id = sol.job_order_id
          WHERE sol.sales_order_id = ?`,
        [si.sales_order_id],
      );
      const soStatus = computeSalesOrderStatus(freshLines);
      await conn.query('UPDATE sales_orders SET status = ?, updated_at = NOW() WHERE id = ?', [soStatus, si.sales_order_id]);
    }

    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM sales_invoices WHERE id = ?', [req.params.id]);
    return res.json(row);
  } catch (err) {
    await conn.rollback();
    return next(err);
  } finally {
    conn.release();
  }
});

// What voiding this invoice will post: the Reversal Journal popup's GL IMPACT table, built by the
// same mirror() the void itself uses so the preview and the posting cannot differ. Every line takes
// the invoice's own department (its GL rows carry none) -- fixed, not chosen; see PUT /:id/cancel.
router.get('/:id/reversal-preview', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[si]] = await pool.query(
      `SELECT si.*, loc.location_name AS office_location_name, d.name AS department_name
         FROM sales_invoices si
         LEFT JOIN locations loc ON loc.id = si.office_location_id
         LEFT JOIN departments d ON d.id = si.department_id
        WHERE si.id = ?`, [req.params.id]
    );
    if (!si) return res.status(404).json({ error: 'Not found' });
    const [lines] = await pool.query('SELECT * FROM sales_invoice_lines WHERE sales_invoice_id = ?', [req.params.id]);
    const rows = mirror((await computeSalesInvoiceGl(si, lines))
      .map((r) => ({ ...r, department_id: si.department_id || null })));
    res.json({
      invoice_no: si.invoice_no,
      invoice_date: si.date_created,
      location: si.office_location_id ? { id: si.office_location_id, location_name: si.office_location_name } : null,
      department: si.department_id ? { id: si.department_id, name: si.department_name } : null,
      rows,
    });
  } catch (err) { next(err); }
});

// Received by Logistics (asked 2026-10-06): the day Logistics took the invoice, picked on a
// calendar, with who recorded it. can_update -- recording a hand-over advances the document, it
// does not edit it, so Logistics needs no edit rights on invoices. Can be corrected; each change
// is in the audit trail. Not on a voided invoice.
router.put('/:id/logistics-received', requireAuth, requirePermission(ROUTE, 'can_update'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const date = String(req.body?.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Choose the date Logistics received the invoice.' });
    const [[si]] = await conn.query('SELECT id, status, date_created, logistics_received_date FROM sales_invoices WHERE id = ?', [req.params.id]);
    if (!si) return res.status(404).json({ error: 'Not found' });
    if (si.status === 'cancelled') return res.status(409).json({ error: 'This invoice is voided.' });
    if (date < String(si.date_created).slice(0, 10)) return res.status(400).json({ error: 'Logistics cannot have received it before the invoice date.' });
    await conn.beginTransaction();
    await conn.query(
      'UPDATE sales_invoices SET logistics_received_date = ?, logistics_received_by_user_id = ? WHERE id = ?',
      [date, req.user.id, si.id],
    );
    await logAudit(conn, {
      invoiceId: si.id, userId: req.user.id, eventType: 'Updated', fieldName: 'logistics_received_date',
      oldValue: si.logistics_received_date ? String(si.logistics_received_date).slice(0, 10) : null, newValue: date,
    });
    await conn.commit();
    res.json({ logistics_received_date: date });
  } catch (err) {
    await conn.rollback().catch(() => {});
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id/cancel', requireAuth, requirePermission(ROUTE, 'can_void'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[si]] = await conn.query('SELECT status, sales_order_id, nsso_id, delivery_ticket_id, date_created FROM sales_invoices WHERE id = ?', [req.params.id]);
    if (si) await assertPeriodOpen(si.date_created, 'ar', conn);
    if (!si) return res.status(404).json({ error: 'Not found' });
    if (si.status === 'cancelled') return res.status(409).json({ error: 'This Sales Invoice is already cancelled.' });

    // The Reversal Journal popup's choices. All optional, so a caller that sends none still voids
    // exactly as before (dated today, at the invoice's location, departments as the GL has them).
    // A chosen date may not fall before the invoice it reverses, and its period must be open.
    const body = req.body || {};
    const reversalDateIn = /^\d{4}-\d{2}-\d{2}$/.test(String(body.reversal_date || '')) ? body.reversal_date : null;
    if (reversalDateIn) {
      if (reversalDateIn < String(si.date_created instanceof Date ? si.date_created.toISOString() : si.date_created).slice(0, 10)) {
        return res.status(400).json({ error: 'The reversal date cannot be before the invoice date.' });
      }
      await assertPeriodOpen(reversalDateIn, 'ar', conn);
    }

    const [lines] = await conn.query(
      'SELECT job_order_id, sales_order_line_id, estimate_job_order_id, quantity FROM sales_invoice_lines WHERE sales_invoice_id = ?',
      [req.params.id]
    );

    await conn.beginTransaction();
    for (const l of lines) {
      // Give back only what was taken. An estimate-sourced line carries a job_order_id for
      // reference -- so the invoice shows the JO # the work became -- but billing it never
      // advanced quantity_invoiced, so giving that quantity back here would credit a job order
      // for an invoice that never debited it.
      if (l.job_order_id && !l.estimate_job_order_id) {
        await conn.query('UPDATE job_orders SET quantity_invoiced = GREATEST(quantity_invoiced - ?, 0) WHERE id = ?', [l.quantity, l.job_order_id]);
      }
    }
    // Voiding an invoice raised off a Delivery Ticket releases that ticket back to open,
    // so it can be billed again rather than being stranded as 'converted' against an
    // invoice that no longer exists. Its GL posting resumes with it.
    if (si.delivery_ticket_id) {
      await conn.query("UPDATE delivery_tickets SET status = 'open' WHERE id = ? AND status = 'converted'", [si.delivery_ticket_id]);
      await conn.query(
        `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
         VALUES ('DeliveryTicket', ?, 'Status Change', 'status', 'converted', 'open', ?)`,
        [si.delivery_ticket_id, req.user.id]
      );
    }
    await conn.query(
      "UPDATE sales_invoices SET status = 'cancelled', cancelled_by_user_id = ?, cancelled_at = NOW() WHERE id = ?",
      [req.user.id, req.params.id]
    );
    // The invoice keeps posting its original entry (lib/glImpact.js no longer excludes a cancelled
    // one); this is what takes it back out, dated today rather than back in the invoice's own
    // period. Read the header and lines fresh so the reversal mirrors exactly what the GL Impact
    // tab shows for this invoice.
    const [[fullSi]] = await conn.query('SELECT * FROM sales_invoices WHERE id = ?', [req.params.id]);
    const [glLines] = await conn.query('SELECT * FROM sales_invoice_lines WHERE sales_invoice_id = ?', [req.params.id]);
    // Every line on the invoice's own department -- the reversal belongs to the same department as
    // the sale it cancels, so it is taken from the invoice, never chosen.
    const glRows = (await computeSalesInvoiceGl(fullSi, glLines))
      .map((r) => ({ ...r, department_id: fullSi.department_id || null }));
    const reversal = await postReversalJournal(conn, {
      sourceType: 'sales_invoice', sourceId: Number(req.params.id), sourceNo: fullSi.invoice_no,
      glRows, documentDate: fullSi.date_created, voidedAt: new Date(),
      reason: String(body.memo || body.reason || '').trim() || null, userId: req.user.id,
      locationId: body.location_id ? Number(body.location_id) : (fullSi.office_location_id || null),
      date: reversalDateIn,
    });
    if (si.nsso_id) await recomputeNssoStatus(conn, si.nsso_id);
    const [[so]] = si.sales_order_id ? await conn.query('SELECT status FROM sales_orders WHERE id = ?', [si.sales_order_id]) : [[null]];
    if (so && so.status !== 'cancelled') {
      const [freshLines] = await conn.query(
        `SELECT sol.job_order_id, sol.quantity, jo.quantity_built, jo.quantity_inspected, jo.quantity_delivered, ${invoicedOrTicketedSql('jo')}
         FROM sales_order_lines sol
         LEFT JOIN job_orders jo ON jo.id = sol.job_order_id WHERE sol.sales_order_id = ?`,
        [si.sales_order_id]
      );
      const newSoStatus = computeSalesOrderStatus(freshLines);
      if (newSoStatus !== so.status) {
        await conn.query('UPDATE sales_orders SET status = ?, updated_at = NOW() WHERE id = ?', [newSoStatus, si.sales_order_id]);
      }
    }
    await logAudit(conn, { invoiceId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: 'saved', newValue: 'cancelled' });
    if (reversal) {
      await logAudit(conn, {
        invoiceId: req.params.id, userId: req.user.id, eventType: 'Created',
        fieldName: 'reversal_journal_no', newValue: reversal.journalNo,
      });
    }
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM sales_invoices WHERE id = ?', [req.params.id]);
    res.json({ ...row, reversal_journal_no: reversal?.journalNo || null });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
