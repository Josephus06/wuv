const express = require('express');
const mailer = require('../lib/mailer');
const { buildEstimateEmail } = require('../lib/estimateEmail');
const { buildEstimatePdf, estimatePdfFilename } = require('../lib/estimatePdf');
const pool = require('../db');
const { assertPeriodOpen, requireOpenPeriod } = require('../lib/accountingPeriod');
const { requireAuth, requirePermission, isSystemAdmin, userCan } = require('../middleware/auth');
const { sendArchived } = require('../lib/localArchive');
const { getSalesRepEmployeeScope } = require('../lib/salesVisibility');
const { isHeadOfficeUser } = require('../lib/userLocation');
const { BILLABLE_ESTIMATE_SQL } = require('../lib/estimateBilling');
const { headerDepartmentError } = require('../lib/requireDepartment');
const { lineLocation, MISSING_LOCATION } = require('../lib/processLocation');
const { sendEstimateXlsx } = require('../lib/estimateExtract');
const { sendXlsx, day } = require('../lib/xlsxExport');

const STATUS_LABELS = {
  for_csa_assignment: 'For CSA Assignment', pending_supervisor_approval: 'Pending Supervisor Approval',
  pending_customer_approval: 'Pending Customer Approval', approved: 'Approved', cancelled: 'Cancelled', disapproved: 'Disapproved',
};

const router = express.Router();

// THE HEADER TOTALS FOLLOW THE LINES.
//
// estimates.subtotal / discount_total / net_of_tax / tax_total / total_amount / est_gp_* were never
// recalculated in-app: a new estimate left them blank, and Replicate copied the SOURCE estimate's
// figures onto the copy. Change the copy's lines and the header kept the old total -- the Saved
// Estimates list (which reads the header) said 1,142,400.00 while the estimate's own page (which
// adds the lines) said 571,200.00 (EST-206902, 2026-10-07).
//
// So after every successful write to an estimate's header or lines, the header is restated from
// its lines with the same arithmetic as the estimate's own page (EstimateView's footer): each
// line's 2-decimal figures summed, tax as stored on the line, GP the sum of the lines' own GP.
// An estimate with no lines -- the imported ones
// carrying only a header -- is left exactly as it is.
async function refreshEstimateTotals(estimateId, q = pool) {
  const [lines] = await q.query(
    `SELECT jo.subtotal, jo.disc_amount, jo.tax_amount, jo.gp_amount, t.rate AS tax_rate,
            (SELECT COALESCE(SUM(p.total_cost), 0) FROM estimate_job_order_processes p WHERE p.estimate_job_order_id = jo.id) AS cost
       FROM estimate_job_orders jo LEFT JOIN taxes t ON t.id = jo.tax_code_id
      WHERE jo.estimate_id = ?`,
    [estimateId]
  );
  if (!lines.length) return;
  const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
  const r2 = (v) => Math.round(v * 100) / 100;
  const subtotal = r2(lines.reduce((s, l) => s + num(l.subtotal), 0));
  const discount = r2(lines.reduce((s, l) => s + num(l.disc_amount), 0));
  const net = r2(subtotal - discount);
  // Each line's stored Tax Amt, exactly as the estimate's own page (EstimateView) and the wizard's
  // footer add it -- the list has to quote the same figure the page does.
  const tax = r2(lines.reduce((s, l) => s + num(l.tax_amount), 0));
  const gp = lines.reduce((s, l) => s + (l.gp_amount != null ? num(l.gp_amount) : num(l.subtotal) - num(l.disc_amount) - num(l.cost)), 0);
  await q.query(
    `UPDATE estimates SET subtotal = ?, discount_total = ?, net_of_tax = ?, tax_total = ?, total_amount = ?,
            est_gp_amount = ?, est_gp_rate = ? WHERE id = ?`,
    [subtotal, discount, net, tax, r2(net + tax), Number(gp.toFixed(2)), net ? Number(((gp / net) * 100).toFixed(2)) : 0, estimateId]
  );
}

// Runs refreshEstimateTotals after any successful POST / PUT / DELETE on an estimate's header
// (/:id) or its lines and processes (/:id/job-orders/...), BEFORE the response is sent -- so the
// list the user goes back to already shows the new total. Done once here rather than at each of
// the routes that write a line, so a route added later cannot forget it.
router.use((req, res, next) => {
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return next();
  const m = req.path.match(/^\/(\d+)(?:\/job-orders(?:\/.*)?)?$/);
  if (!m) return next();
  const estimateId = Number(m[1]);
  const send = res.send.bind(res);
  let refreshed = false;
  res.send = (body) => {
    if (refreshed || res.statusCode >= 400) return send(body);
    refreshed = true;
    refreshEstimateTotals(estimateId)
      .catch((err) => console.error(`[estimates] totals refresh for ${estimateId}:`, err.message))
      .finally(() => send(body));
    return res;
  };
  return next();
});
const ROUTE = '/estimates';
// Its own page so assigning a rep to a website quote can be granted independently of estimate
// approval -- see src/db/add-estimate-csa-assignment.js.
const CSA_ROUTE = '/estimates-csa-assignment';

const HEADER_FIELDS = [
  'date_created', 'customer_id', 'contact_person_id', 'contact_email', 'contact_title', 'contact_phone',
  'blanket_po_id', 'blanket_po_memo', 'sales_rep_id', 'sales_division_id', 'office_location_id',
  'contract_description', 'memo', 'shipping_address', 'has_multiple_shipping', 'production_lead_time',
  'price_validity', 'order_confirmation_type', 'order_confirmation_ref', 'print_warranty', 'print_warranty_term', 'structure_warranty',
  'structure_warranty_term', 'electrical_warranty', 'electrical_warranty_term', 'prepared_by_id', 'approved_by_id',
  'credit_term', 'credit_limit', 'credit_balance', 'bill_to_contact_number', 'status',
  'subtotal', 'discount_total', 'net_of_tax', 'tax_total', 'total_amount', 'est_gp_rate', 'est_gp_amount',
];

const JOB_ORDER_FIELDS = [
  'nstdjo_no', 'nstdjo_id', 'job_type_id', 'job_location_id', 'description', 'quantity', 'units', 'price_per_unit', 'subtotal',
  'disc_percent', 'disc_per_unit', 'disc_amount', 'disc_price_per_unit', 'net_of_tax', 'tax_code_id', 'tax_amount',
  'gross_amount', 'length', 'width', 'height', 'uom', 'shipping', 'remarks', 'memo', 'delivery_date', 'delivery_time',
  'gp_rate', 'gp_amount',
  // Contingency: the buffer added on top of what the processes come to, kept as both the percent
  // and the amount because each is the other's mirror and only one of them was typed.
  'contingency_percent', 'contingency_amount',
];

const PROCESS_FIELDS = [
  'process_id', 'process_qty', 'process_uom', 'category', 'parts', 'item_id', 'location_id', 'length', 'width', 'uom', 'qty',
  'total', 'unit', 'process_price', 'process_disc_percent', 'process_disc_amount', 'disc_process_price',
  'material_price', 'material_disc_percent', 'material_disc_amount', 'disc_material_price', 'net_of_tax',
  'tax_code_id', 'tax_amount', 'gross_amount', 'shipping', 'remarks', 'memo', 'delivery_date', 'delivery_time',
  'gp_rate', 'process_cost', 'material_cost', 'total_cost', 'total_price',
];

// sales_order_lines mirrors estimate_job_orders minus nstdjo_no/disc_per_unit, which
// don't carry forward to the order snapshot.
//
// The contingency pair is dropped for a different reason: sales_order_lines has no columns for it
// and needs none. Contingency is how the job order's Subtotal was ARRIVED AT -- the amount is
// already inside it -- so the order snapshot carries the money without carrying the working. The
// percentage only means anything against the estimate's own process lines, which the order does
// not hold.
// nstdjo_id joins nstdjo_no on this exclusion list for the same reason: sales_order_lines has
// neither column, and the NSTDJO tag belongs to the Estimate rather than to the order it becomes.
const SALES_ORDER_LINE_FIELDS = JOB_ORDER_FIELDS.filter(
  (f) => !['nstdjo_no', 'nstdjo_id', 'disc_per_unit', 'contingency_percent', 'contingency_amount'].includes(f),
);

// The NSTDJO tag is a reference, so the NUMBER is written from the record rather than taken from
// the browser. The two can then never disagree, a mistyped or stale number cannot be stored, and
// clearing the tag clears both halves. Returns null when the id names nothing.
async function resolveNstdjoTag(body, conn) {
  if (!('nstdjo_id' in body) && !('nstdjo_no' in body)) return body;
  const id = body.nstdjo_id ? Number(body.nstdjo_id) : null;
  if (!id) return { ...body, nstdjo_id: null, nstdjo_no: null };
  const [[n]] = await conn.query('SELECT nstdjo_no FROM non_standard_job_orders WHERE id = ?', [id]);
  if (!n) return null;
  return { ...body, nstdjo_id: id, nstdjo_no: n.nstdjo_no };
}
const SALES_ORDER_HEADER_FIELDS = [
  'estimate_id', 'date_created', 'customer_id', 'contact_person_id', 'contact_email', 'contact_title', 'contact_phone',
  'blanket_po_id', 'blanket_po_memo', 'sales_rep_id', 'sales_division_id', 'office_location_id',
  'contract_description', 'memo', 'shipping_address', 'production_lead_time', 'price_validity',
  'order_confirmation_type', 'order_confirmation_ref', 'prepared_by_id', 'approved_by_id', 'credit_term', 'credit_limit', 'credit_balance',
  'bill_to_contact_number', 'subtotal', 'discount_total', 'net_of_tax', 'tax_total', 'total_amount',
  'est_gp_rate', 'est_gp_amount',
];

// Snapshots the estimate (header + job order lines) into a brand-new Sales Order --
// this is what the real system does the moment an estimate reaches final "Approved".
// It's a copy, not a live reference, so later edits/replications of the estimate don't
// retroactively change an order that's already been placed.
function n(v) { return v === null || v === undefined || v === '' ? 0 : Number(v); }

async function generateSalesOrderFromEstimate(conn, estimateId) {
  const [[est]] = await conn.query('SELECT * FROM estimates WHERE id = ?', [estimateId]);

  // The estimate's own header aggregate columns (subtotal/net_of_tax/total_amount/...)
  // are only ever populated if someone visited its Billing step and clicked
  // "Recalculate from Job Orders" -- they can be stale or blank. Recompute fresh from
  // the job order lines being copied, the same way EstimateView's totals footer does,
  // so the order's numbers are always trustworthy regardless of the estimate's own
  // bookkeeping state.
  const [jobOrders] = await conn.query(
    `SELECT jo.*, t.rate AS tax_rate
     FROM estimate_job_orders jo
     LEFT JOIN taxes t ON t.id = jo.tax_code_id
     WHERE jo.estimate_id = ? ORDER BY jo.line_no`,
    [estimateId]
  );
  // Totals to the centavo, as the sum of each LINE's own 2-decimal figures -- the estimate's own
  // footer adds them up the same way. Tax was worked here as Net x rate per line, unrounded, and
  // summed: EST-105221's lines carry 305.35 of VAT, the unrounded sum came to 305.358, and the
  // order read 2,850.01 against the estimate's 2,850.00 (2026-10-05). A line with no stored tax
  // still has it worked out, rounded to the centavo like a stored one.
  const r2 = (v) => Math.round(v * 100) / 100;
  const lineTax = (jo) => (jo.tax_amount != null && jo.tax_amount !== ''
    ? n(jo.tax_amount)
    : r2((n(jo.subtotal) - n(jo.disc_amount)) * (n(jo.tax_rate) / 100)));
  const subtotal = r2(jobOrders.reduce((s, jo) => s + n(jo.subtotal), 0));
  const discountTotal = r2(jobOrders.reduce((s, jo) => s + n(jo.disc_amount), 0));
  const netOfTax = r2(subtotal - discountTotal);
  const taxTotal = r2(jobOrders.reduce((s, jo) => s + lineTax(jo), 0));
  const totalAmount = r2(netOfTax + taxTotal);

  // GP is the SUM of the lines' own GP, as the Sales Order screen totals it. Not Net of Tax less
  // every process's Total Cost: a migrated estimate's process cost fields are the source's rates,
  // not costs, so that gave a margin no line shows (EST-203231: lines 62-74%, "overall" 48%). A
  // line with no stored GP still counts as its Net of Tax less its processes' cost.
  const [lineGp] = await conn.query(
    `SELECT jo.gp_amount, jo.subtotal, jo.disc_amount,
            (SELECT COALESCE(SUM(p.total_cost), 0) FROM estimate_job_order_processes p WHERE p.estimate_job_order_id = jo.id) AS cost
       FROM estimate_job_orders jo WHERE jo.estimate_id = ?`,
    [estimateId]
  );
  const gpAmount = lineGp.reduce((s, l) => s + (l.gp_amount != null ? n(l.gp_amount) : n(l.subtotal) - n(l.disc_amount) - n(l.cost)), 0);
  const gpRate = netOfTax ? (gpAmount / netOfTax) * 100 : 0;

  const computedTotals = {
    subtotal, discount_total: discountTotal, net_of_tax: netOfTax, tax_total: taxTotal, total_amount: totalAmount,
    est_gp_rate: Number(gpRate.toFixed(2)), est_gp_amount: Number(gpAmount.toFixed(2)),
  };
  // date_created is the ONE header field that must not be copied. Every other column here
  // is a snapshot of what the customer agreed to, but the order's date is a fact about the
  // order, not about the estimate: it is the day the order was placed. Copying it meant an
  // estimate raised in January and approved in September produced a September order dated
  // January -- which back-dates it out of its own month for anything reading date_created,
  // the as-of filter on the Sales Orders list included.
  //
  // Taken from the DATABASE clock (CURDATE()) rather than from JS. The row's created_at
  // already defaults to CURRENT_TIMESTAMP, so using the same clock keeps one row from
  // carrying two different ideas of today -- and it sidesteps the UTC slide that
  // `new Date().toISOString().slice(0, 10)` produces here, where local time is UTC+8 and
  // anything generated before 08:00 would be dated to the previous day.
  const soValues = SALES_ORDER_HEADER_FIELDS
    .filter((f) => f !== 'date_created')
    .map((f) => (
      f === 'estimate_id' ? estimateId : (computedTotals[f] !== undefined ? computedTotals[f] : est[f])
    ));
  const soPlaceholders = SALES_ORDER_HEADER_FIELDS
    .map((f) => (f === 'date_created' ? 'CURDATE()' : '?'))
    .join(', ');
  const tempNo = `TMP-SO-${Date.now()}`;
  const [result] = await conn.query(
    `INSERT INTO sales_orders (sales_order_no, ${SALES_ORDER_HEADER_FIELDS.join(', ')})
     VALUES (?, ${soPlaceholders})`,
    [tempNo, ...soValues]
  );
  const salesOrderId = result.insertId;
  await conn.query('UPDATE sales_orders SET sales_order_no = ? WHERE id = ?', [`SO-${60000 + salesOrderId}`, salesOrderId]);

  for (const jo of jobOrders) {
    const lineValues = SALES_ORDER_LINE_FIELDS.map((f) => jo[f]);
    // Carry the Admin/GM low-GP approval flag onto the SO line -- that's where the commission
    // report reads it, so an approved-below-GP line still counts toward passing-GP commission.
    await conn.query(
      `INSERT INTO sales_order_lines (sales_order_id, line_no, estimate_job_order_id, is_approved_low_gp, ${SALES_ORDER_LINE_FIELDS.join(', ')})
       VALUES (?, ?, ?, ?, ${SALES_ORDER_LINE_FIELDS.map(() => '?').join(', ')})`,
      [salesOrderId, jo.line_no, jo.id, jo.is_approved_low_gp ? 1 : 0, ...lineValues]
    );
  }

  await conn.query('UPDATE estimates SET sales_order_id = ? WHERE id = ?', [salesOrderId, estimateId]);

  // The estimate may already have been invoiced. It is billable from pending_customer_approval,
  // which is the stage BEFORE this one, so an invoice can exist before there is any order to hang
  // it on -- it was written with sales_order_id NULL because at the time that was the truth.
  // Now there is an order, and without this the invoice would stay off its Related Records for
  // good: nothing else ever revisits that column.
  //
  // Only the ones still unlinked, so this can never move an invoice off an order it already
  // names. The link is recorded, not counted -- see billEstimate in routes/salesInvoices.js for
  // why the order's own quantity figures stay out of it.
  await conn.query(
    'UPDATE sales_invoices SET sales_order_id = ? WHERE estimate_id = ? AND sales_order_id IS NULL',
    [salesOrderId, estimateId]
  );

  return salesOrderId;
}

function pick(body, fields) {
  return fields.map((f) => (body[f] === undefined ? null : body[f]));
}

// A process line's Process Location (2026-11-11): the one picked, else the process's Default
// Location, set into `values` (a pick() of PROCESS_FIELDS). False when the line has a process and
// still no location -- it cannot be saved.
async function fillProcessLocation(conn, values) {
  const at = PROCESS_FIELDS.indexOf('location_id');
  const processId = values[PROCESS_FIELDS.indexOf('process_id')];
  values[at] = await lineLocation(conn, processId, values[at] || null);
  return !processId || !!values[at];
}

async function logAudit(conn, { estimateId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('Estimate', ?, ?, ?, ?, ?, ?)`,
    [estimateId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// Who raised the estimate.
//
// There is no created_by column on estimates -- the record of it is the audit trail's own
// 'Created' row, written by POST / and by replicate, which is the same fact and costs no schema
// change (idx_auditable covers the lookup). The header row and its per-job-order children all
// carry the same user, so the first one by id answers it.
//
// Migrated history carries no 'Created' row at all, so those resolve to null -- and null is
// nobody, so no one picks up rights over an estimate whose author was never recorded.
async function getCreatorUserId(db, estimateId) {
  const [[row]] = await db.query(
    `SELECT set_by_user_id FROM audit_logs
      WHERE auditable_type = 'Estimate' AND auditable_id = ? AND event_type = 'Created'
      ORDER BY id LIMIT 1`,
    [estimateId]
  );
  return row?.set_by_user_id ?? null;
}

// MySQL returns BOOLEAN columns as 0/1, but callers often send back JS true/false for the
// same value (e.g. a checkbox round-tripped through the frontend) -- normalize both sides
// so that isn't misread as a change on every save.
function normalizeForDiff(v) {
  if (v === true || v === 1 || v === '1') return '1';
  if (v === false || v === 0 || v === '0') return '0';
  return String(v);
}

async function logFieldDiffs(conn, { estimateId, userId, fields, oldRow, newValues, prefix }) {
  for (const f of fields) {
    const oldVal = oldRow[f];
    const newVal = newValues[f];
    const oldStr = oldVal === null || oldVal === undefined ? null : String(oldVal);
    const newStr = newVal === null || newVal === undefined ? null : String(newVal);
    if (oldStr === newStr) continue;
    if (oldStr !== null && newStr !== null && normalizeForDiff(oldVal) === normalizeForDiff(newVal)) continue;
    await logAudit(conn, {
      estimateId, userId, eventType: 'Updated',
      fieldName: prefix ? `${prefix}.${f}` : f,
      oldValue: oldStr, newValue: newStr,
    });
  }
}

// --- Estimate header ---------------------------------------------------

const STATUS_VALUES = ['for_csa_assignment', 'pending_supervisor_approval', 'pending_customer_approval', 'approved', 'cancelled', 'disapproved'];
// The one status in which an estimate's content is still open to its editors. Before the
// supervisor signs it off the figures are a draft; after it (customer stage, approved) they have
// been agreed, and disapproved/cancelled estimates are closed. Outside this status only a System
// Admin may change it. The client applies the same rule to the Edit button.
const EDITABLE_STATUS = 'pending_supervisor_approval';

// Guards every route that changes an estimate's content -- the header PUT, its job orders, their
// processes and the shipping addresses. Checked on each of them, not just the header, because
// the lines are where the money is and each has its own endpoint.
//
// Attachments are deliberately left out: those are the order-confirmation documents (the
// customer's PO, conforme, proof of payment), which by their nature arrive at the customer stage.
async function requireEditableEstimate(req, res, next) {
  try {
    const [[row]] = await pool.query('SELECT status, date_created FROM estimates WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    // Not in a closed accounting period (Non-GL), whoever is asking (2026-10-12).
    await assertPeriodOpen(String(row.date_created || '').slice(0, 10), 'non_gl');
    if (row.status !== EDITABLE_STATUS && !(await isSystemAdmin(req.user.id))) {
      return res.status(403).json({
        error: 'This estimate can only be edited while it is Pending Supervisor Approval -- only a System Admin can edit it now.',
      });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

// The list's Total Amount -- the stored header total, or the job order lines' when it is blank (why:
// see the list route below). Shared by the list and its Extract.
const effectiveTotalSql = `CASE
        WHEN COALESCE(e.total_amount, 0) <> 0 THEN e.total_amount
        ELSE (SELECT COALESCE(SUM(jo.subtotal), 0) - COALESCE(SUM(jo.disc_amount), 0)
                     + COALESCE(SUM(jo.tax_amount), 0)
                FROM estimate_job_orders jo WHERE jo.estimate_id = e.id) END`;

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const {
      status, search, sales_rep_id: salesRepId, office_location_id: officeLocationId, as_of: asOf,
      customer_id: customerId, invoiceable, page = '1', limit = '10',
    } = req.query;

    // Filters other than status (used both for the list itself and for the tab
    // counts, so counts reflect the search/sales-rep/location/date filters currently
    // applied but still show how many rows fall in EACH status).
    const commonWhere = [];
    const commonParams = [];
    if (salesRepId) { commonWhere.push('e.sales_rep_id = ?'); commonParams.push(salesRepId); }
    if (officeLocationId) { commonWhere.push('e.office_location_id = ?'); commonParams.push(officeLocationId); }
    if (asOf) { commonWhere.push('e.date_created <= ?'); commonParams.push(asOf); }
    if (customerId) { commonWhere.push('e.customer_id = ?'); commonParams.push(customerId); }
    // Only estimates Create New on the invoice list may bill: approved by a supervisor, and
    // carrying line items. See lib/estimateBilling.js for why those two and nothing else.
    if (invoiceable === '1' || invoiceable === 'true') {
      commonWhere.push(BILLABLE_ESTIMATE_SQL);
    }
    if (search) {
      commonWhere.push('(e.estimate_no LIKE ? OR c.name LIKE ? OR e.contract_description LIKE ?)');
      commonParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    // Account Officers only ever see their own estimates; Supervisors see their own plus
    // their direct reports' -- everyone else (System Admin, non-sales roles) is unrestricted.
    const scope = await getSalesRepEmployeeScope(req.user.id, ROUTE);
    if (scope) { commonWhere.push('e.sales_rep_id IN (?)'); commonParams.push(scope); }

    const where = [...commonWhere];
    const params = [...commonParams];
    if (status && STATUS_VALUES.includes(status)) { where.push('e.status = ?'); params.push(status); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const commonWhereSql = commonWhere.length ? `WHERE ${commonWhere.join(' AND ')}` : '';

    const baseFrom = `FROM estimates e
       LEFT JOIN customers c ON c.id = e.customer_id
       LEFT JOIN employees sr ON sr.id = e.sales_rep_id
       LEFT JOIN employees pb ON pb.id = e.prepared_by_id
       LEFT JOIN locations loc ON loc.id = e.office_location_id`;

    // Extract (asked 2026-11-13): format=xlsx is every estimate under the list's filters and tab -- not
    // just the page -- as a workbook, with the columns the list shows.
    if (req.query.format === 'xlsx') {
      const [all] = await pool.query(
        `SELECT e.estimate_no, e.date_created, e.status, e.contract_description, c.name AS customer_name,
                CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
                CONCAT(pb.first_name, ' ', pb.last_name) AS prepared_by_name, loc.location_name,
                ${effectiveTotalSql} AS total
           ${baseFrom} ${whereSql}
          ORDER BY e.id DESC`, params);
      return await sendXlsx(res, {
        filename: 'estimates.xlsx',
        sheet: 'Estimates',
        columns: [
          { header: 'Estimate No', key: 'estimate_no', width: 14 },
          { header: 'Date Created', key: 'date', width: 13 },
          { header: 'Location', key: 'location_name', width: 18 },
          { header: 'Customer', key: 'customer_name', width: 40 },
          { header: 'Contract Description', key: 'contract_description', width: 60 },
          { header: 'Sales Rep.', key: 'sales_rep_name', width: 26 },
          { header: 'Prepared By', key: 'prepared_by_name', width: 26 },
          { header: 'Status', key: 'status_label', width: 26 },
          { header: 'Total Amount', key: 'total', width: 16 },
        ],
        rows: all.map((r) => ({
          ...r, date: day(r.date_created), status_label: STATUS_LABELS[r.status] || r.status || '',
          customer_name: r.customer_name || '', contract_description: r.contract_description || '',
          sales_rep_name: r.sales_rep_name || '', prepared_by_name: r.prepared_by_name || '', location_name: r.location_name || '',
          total: Number(r.total) || 0,
        })),
      });
    }

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${baseFrom} ${whereSql}`, params);

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 10));
    const offset = (pageNum - 1) * limitNum;

    // The money shown in the list comes from TWO places, because neither one covers every estimate:
    //
    //   68,852 estimates carry a header total and NO job order lines at all -- migrated history,
    //          where only the header came across. Computing from lines would show them all 0.00.
    //       26 estimates have real job order lines but a header total of 0, because the header
    //          aggregates are only written when someone opens the Billing step and clicks
    //          "Recalculate from Job Orders". These are the ones showing a blank 0.00 while
    //          holding anything from 324.00 to 25,303.00 in their lines.
    //
    // The stored header WINS whenever it is set, and the lines are only used to fill a blank. The
    // other way round is tempting -- lines look more like source data, and EstimateView's footer
    // already computes that way -- but it is wrong here: on 69 estimates the line sum comes to an
    // exact multiple of the header (2,872,694.31 against 5,745,388.62; 1,008,000 against
    // 3,024,000), which is duplicated lines, not a stale header. Preferring lines would restate
    // approved estimates at double their value. Filling a blank can only ever add information;
    // overriding a figure someone has already approved can destroy it.
    //
    // This changes exactly 26 rows out of 70,120. The 348 rows that the other rule would have
    // moved -- 263 of them by less than a centavo -- stay as they are.
    const effectiveTotal = effectiveTotalSql;

    const [rows] = await pool.query(
      `SELECT e.*, c.name AS customer_name, CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              CONCAT(pb.first_name, ' ', pb.last_name) AS prepared_by_name, loc.location_name,
              ${effectiveTotal} AS effective_total_amount
       ${baseFrom} ${whereSql}
       ORDER BY e.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    const [countRows] = await pool.query(
      `SELECT e.status, COUNT(*) AS count ${baseFrom} ${commonWhereSql} GROUP BY e.status`,
      commonParams
    );
    const counts = Object.fromEntries(STATUS_VALUES.map((s) => [s, 0]));
    countRows.forEach((r) => { if (counts[r.status] !== undefined) counts[r.status] = r.count; });

    res.json({ rows, total, page: pageNum, limit: limitNum, counts });
  } catch (err) {
    next(err);
  }
});

// The estimate as its page shows it: header, shipping addresses, job lines with their processes.
// Null when it does not exist or is outside the user's sales scope. Shared by GET /:id and its Extract.
async function loadEstimate(id, userId) {
  const [[estimate]] = await pool.query(
    `SELECT e.*, c.name AS customer_name, cc.contact_name,
            sd.name AS sales_division_name, loc.location_name AS office_location_name,
            bp.po_number AS blanket_po_no, so.sales_order_no, so.id AS linked_sales_order_id,
            CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
            CONCAT(pb.first_name, ' ', pb.last_name) AS prepared_by_name,
            CONCAT(ap.first_name, ' ', ap.last_name) AS approved_by_name
     FROM estimates e
     LEFT JOIN customers c ON c.id = e.customer_id
     LEFT JOIN customer_contacts cc ON cc.id = e.contact_person_id
     LEFT JOIN sales_divisions sd ON sd.id = e.sales_division_id
     LEFT JOIN locations loc ON loc.id = e.office_location_id
     LEFT JOIN blanket_pos bp ON bp.id = e.blanket_po_id
     LEFT JOIN employees sr ON sr.id = e.sales_rep_id
     LEFT JOIN employees pb ON pb.id = e.prepared_by_id
     LEFT JOIN employees ap ON ap.id = e.approved_by_id
     -- The estimate's own sales_order_id, or -- for the ~70,800 migrated estimates whose order
     -- points at them but which were never pointed back (2026-10-08, EST-107678 / SO-71152) --
     -- the order that names this estimate: the latest one not cancelled, else the latest.
     LEFT JOIN sales_orders so ON so.id = COALESCE(e.sales_order_id,
       (SELECT so2.id FROM sales_orders so2 WHERE so2.estimate_id = e.id
         ORDER BY (so2.status = 'cancelled'), so2.id DESC LIMIT 1))
     WHERE e.id = ?`,
    [id]
  );
  if (!estimate) return null;
  if (!estimate.sales_order_id && estimate.linked_sales_order_id) estimate.sales_order_id = estimate.linked_sales_order_id;
  delete estimate.linked_sales_order_id;
  // Defense in depth -- a scoped user (Account Officer/Supervisor) can't view someone
  // else's estimate just by guessing/pasting its URL, even though the list already
  // filters it out.
  const scope = await getSalesRepEmployeeScope(userId, ROUTE);
  if (scope && !scope.includes(estimate.sales_rep_id)) return null;

  const [shippingAddresses] = await pool.query('SELECT * FROM estimate_shipping_addresses WHERE estimate_id = ? ORDER BY id', [id]);
  const [jobOrders] = await pool.query(
    `SELECT jo.*, jt.display_name AS job_type_name, jt.gp_rate_head AS passing_gp_rate,
            loc.location_name AS job_location_name, t.code AS tax_code, t.rate AS tax_rate
     FROM estimate_job_orders jo
     LEFT JOIN job_types jt ON jt.id = jo.job_type_id
     LEFT JOIN locations loc ON loc.id = jo.job_location_id
     LEFT JOIN taxes t ON t.id = jo.tax_code_id
     WHERE jo.estimate_id = ? ORDER BY jo.line_no`,
    [id]
  );
  for (const jo of jobOrders) {
    // The two per-unit columns, both tax-exclusive and either side of the discount:
    //
    //   Price/Unit      = Subtotal   / Qty
    //   Disc Price/Unit = Net of Tax / Qty
    //
    // Derived on read rather than backfilled. They are pure functions of columns on the same
    // row, so a stored copy could only ever go stale, and this way every estimate answers the
    // same way whether it was raised today or last year -- Disc Price/Unit was NULL on all
    // 4,743 lines, and Price/Unit was stored as Gross / Qty, which included tax and so could
    // not be compared with the discounted figure printed beside it.
    //
    // Price/Unit x Qty is the Subtotal. Disc Price/Unit = Price/Unit - Disc Amt per piece =
    // Net of Tax / Qty, so Net of Tax = Qty x Disc Price/Unit (the user's rule, 2026-10-01;
    // matches the client's perUnitFor).
    //
    // Sales Orders and invoices converted from an estimate keep their OWN copies, taken at
    // conversion time; this changes what the estimate screen and the quotation print show, not
    // what any document downstream was built from.
    const qty = Number(jo.quantity) || 0;
    if (qty) {
      const sub = Number(jo.subtotal || 0);
      jo.price_per_unit = Number((sub / qty).toFixed(4));
      jo.disc_price_per_unit = Number((Number(jo.net_of_tax || 0) / qty).toFixed(4));
    }
    const [processes] = await pool.query(
      `SELECT p.*, pr.process_name, i.display_name AS item_name, i.item_type, loc.location_name
       FROM estimate_job_order_processes p
       LEFT JOIN processes pr ON pr.id = p.process_id
       LEFT JOIN inventories i ON i.id = p.item_id
       LEFT JOIN locations loc ON loc.id = p.location_id
       WHERE p.estimate_job_order_id = ? ORDER BY p.line_no`,
      [jo.id]
    );
    jo.processes = processes;
  }
  return { estimate, shippingAddresses, jobOrders };
}

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const loaded = await loadEstimate(req.params.id, req.user.id);
    if (!loaded) return res.status(404).json({ error: 'Not found' });
    const { estimate, shippingAddresses, jobOrders } = loaded;

    // Who raised it, so the view can offer the creator the one action that is theirs to take
    // (recording the customer's answer) without also handing them the Edit form.
    const createdByUserId = await getCreatorUserId(pool, req.params.id);

    // Whether the viewer supervises this estimate's rep, for the page's Approve / customer buttons.
    const isRepSup = await isRepSupervisor(req.user.id, estimate.id);

    // ?signatures=1 (the print page only): the drawn signatures of the Prepared By and Approved By
    // employees, through their user accounts -- the same rule as the PO print: the people the
    // estimate records, never whoever prints it; no signature on file leaves the line to sign by hand.
    const sig = {};
    if (req.query.signatures) {
      const empIds = [estimate.prepared_by_id, estimate.approved_by_id].filter(Boolean);
      if (empIds.length) {
        const [sigs] = await pool.query(
          'SELECT employee_id, signature_data FROM users WHERE employee_id IN (?) AND signature_data IS NOT NULL ORDER BY is_active DESC, id', [empIds]);
        const byEmp = new Map();
        for (const s of sigs) if (!byEmp.has(String(s.employee_id))) byEmp.set(String(s.employee_id), s.signature_data);
        sig.prepared_signature = byEmp.get(String(estimate.prepared_by_id)) || null;
        sig.approved_signature = byEmp.get(String(estimate.approved_by_id)) || null;
      }
    }
    // is_replica: the form asks a replica's lines for a new Job Location (as well as the Delivery Date
    // every estimate needs) before it moves past the job lines.
    const replica = await isReplica(pool, estimate.id);
    res.json({ ...estimate, ...sig, created_by_user_id: createdByUserId, is_rep_supervisor: isRepSup, is_replica: replica, shippingAddresses, jobOrders });
  } catch (err) {
    next(err);
  }
});

// Extract (2026-11-11): the estimate as an Excel sheet -- lib/estimateExtract.js has the layout.
router.get('/:id/extract', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const loaded = await loadEstimate(req.params.id, req.user.id);
    if (!loaded) return res.status(404).json({ error: 'Not found' });
    await sendEstimateXlsx(res, loaded);
  } catch (err) { next(err); }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'Estimate' AND a.auditable_id = ?
       ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Add a contact person without leaving the estimate form. Writes to customer_contacts, the
// same table Master Lists > Customer reads, so the contact becomes part of the customer's
// details -- mirrors POST /non-standard-job-orders/contacts. Gated on this page's Add or Edit
// (the form is used for both) rather than Customers can_edit: quoting a customer should not
// require rights to edit the customer master.
router.post('/contacts', requireAuth, async (req, res, next) => {
  try {
    if (!(await userCan(req.user.id, ROUTE, 'can_add')) && !(await userCan(req.user.id, ROUTE, 'can_edit'))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { customer_id: customerId, contact_name: contactName, title, email, phone } = req.body;
    if (!customerId) return res.status(400).json({ error: 'Select a customer first.' });
    if (!contactName || !contactName.trim()) return res.status(400).json({ error: 'Contact name is required.' });

    const [[customer]] = await pool.query('SELECT id FROM customers WHERE id = ?', [customerId]);
    if (!customer) return res.status(400).json({ error: 'Invalid customer.' });

    const [result] = await pool.query(
      `INSERT INTO customer_contacts (customer_id, contact_name, title, email, phone, is_primary)
       VALUES (?, ?, ?, ?, ?, FALSE)`,
      [customerId, contactName.trim(), title?.trim() || null, email?.trim() || null, phone?.trim() || null],
    );
    const [[row]] = await pool.query(
      'SELECT id, contact_name, title, email, phone, description FROM customer_contacts WHERE id = ?',
      [result.insertId],
    );
    res.status(201).json(row);
  } catch (err) { next(err); }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  // The Sales Division is the estimate's department, required on every user save. Replicate,
  // the live sync and website quote requests write estimates without passing through here.
  const deptError = headerDepartmentError(req.body.sales_division_id, 'Sales Division');
  if (deptError) return res.status(400).json({ error: deptError });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const values = pick(req.body, HEADER_FIELDS);
    // A brand-new estimate has not been approved by anyone; it starts at
    // pending_supervisor_approval and earns its approver by passing that stage.
    const newApprovedIdx = HEADER_FIELDS.indexOf('approved_by_id');
    if (newApprovedIdx >= 0) values[newApprovedIdx] = null;
    const tempNo = `TMP-${Date.now()}`;
    const [result] = await conn.query(
      `INSERT INTO estimates (estimate_no, ${HEADER_FIELDS.join(', ')}) VALUES (?, ${HEADER_FIELDS.map(() => '?').join(', ')})`,
      [req.body.estimate_no || tempNo, ...values]
    );
    const estimateId = result.insertId;
    if (!req.body.estimate_no) {
      await conn.query('UPDATE estimates SET estimate_no = ? WHERE id = ?', [`EST-${100000 + estimateId}`, estimateId]);
    }
    await logAudit(conn, { estimateId, userId: req.user.id, eventType: 'Created' });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM estimates WHERE id = ?', [estimateId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Estimate number already in use' });
    next(err);
  } finally {
    conn.release();
  }
});

// requireEditableEstimate is checked here as well as on the screen, because hiding the Edit
// button is a suggestion and this is a rule -- the edit form is one way in, the endpoint is the
// only one.
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), requireEditableEstimate, async (req, res, next) => {
  const deptError = headerDepartmentError(req.body.sales_division_id, 'Sales Division');
  if (deptError) return res.status(400).json({ error: deptError });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[oldRow]] = await conn.query('SELECT * FROM estimates WHERE id = ?', [req.params.id]);
    if (!oldRow) {
      await conn.rollback();
      return res.status(404).json({ error: 'Not found' });
    }
    const values = pick(req.body, HEADER_FIELDS);
    // APPROVED BY IS NEVER TAKEN FROM AN EDIT. It is written in exactly one place -- the
    // supervisor-approval transition in PUT /:id/status -- so an estimate can never name its own
    // approver, and a form that does not carry the field cannot silently blank the supervisor who
    // signed it off by round-tripping a null over it.
    const approvedIdx = HEADER_FIELDS.indexOf('approved_by_id');
    if (approvedIdx >= 0) values[approvedIdx] = oldRow.approved_by_id;
    // A NEWLY chosen Sales Rep must be an active employee. An inactive duplicate record (Vanessa
    // Garcia's #277, no login) was picked and her estimates vanished from her own account -- she is
    // seen through her active #69 (2026-10-08). An existing rep who has since left still re-saves.
    const repIdx = HEADER_FIELDS.indexOf('sales_rep_id');
    const newRep = repIdx >= 0 ? values[repIdx] : undefined;
    if (newRep && String(newRep) !== String(oldRow.sales_rep_id ?? '')) {
      const [[emp]] = await conn.query('SELECT is_active FROM employees WHERE id = ?', [newRep]);
      if (!emp || !Number(emp.is_active)) {
        await conn.rollback();
        return res.status(400).json({ error: 'That Sales Rep is an inactive employee record. Choose the active one.' });
      }
    }
    await conn.query(
      `UPDATE estimates SET ${HEADER_FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
      [...values, req.params.id]
    );
    const newValues = {};
    HEADER_FIELDS.forEach((f, i) => { newValues[f] = values[i]; });
    await logFieldDiffs(conn, { estimateId: req.params.id, userId: req.user.id, fields: HEADER_FIELDS, oldRow, newValues });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM estimates WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Clones an estimate's header, job orders, and process lines into a brand-new draft
// estimate (fresh estimate_no, today's date, status reset to the start of the
// approval flow) -- mirrors the real system's "Replicate" action for reusing a past
// estimate as the starting point for a new one instead of re-keying everything.
// Called from the Replicate button and from the chatbot, which is why the work lives in a
// function rather than only in the route handler: two implementations of this would drift.
// The replicator's own Sales Rep / Office Location / Sales Division, as a new estimate fills them
// (EstimateWizard): their employee, their default branch's location, and the sales division whose
// name matches their branch's department ignoring spaces, dashes and underscores ("Sales - 1" is
// "Sales-1"). A field with nothing to go on is left out, so the source's value stands.
async function replicatorDefaults(conn, userId) {
  const [[u]] = await conn.query(
    `SELECT u.employee_id, ub.location_id, d.name AS department_name
       FROM users u
       LEFT JOIN user_branches ub ON ub.user_id = u.id AND ub.is_default = TRUE
       LEFT JOIN departments d ON d.id = ub.department_id
      WHERE u.id = ?`, [userId]);
  const out = {};
  if (!u) return out;
  if (u.employee_id) out.sales_rep_id = u.employee_id;
  if (u.location_id) out.office_location_id = u.location_id;
  if (u.department_name) {
    const key = (v) => String(v || '').toLowerCase().replace(/[\s_-]+/g, '');
    const [divs] = await conn.query('SELECT id, name FROM sales_divisions');
    const match = divs.find((d) => key(d.name) === key(u.department_name));
    if (match) out.sales_division_id = match.id;
  }
  return out;
}

// opts.cancelSource -- "Cancel & Replicate" (asked 2026-10-08): the source is cancelled in the SAME
// transaction the copy is made in, so it is never one without the other.
// Either way the copy is the REPLICATOR's (asked 2026-10-13 for plain Replicate too): Sales Rep,
// Office Location and Sales Division are theirs (replicatorDefaults) and Prepared By is them. Where
// the replicator has nothing to go on for a field, the source's value stands.
// Made by Replicate / Cancel & Replicate: its 'Created' audit row names the estimate it came from.
async function isReplica(q, estimateId) {
  const [[row]] = await q.query(
    "SELECT 1 AS yes FROM audit_logs WHERE auditable_type = 'Estimate' AND auditable_id = ? AND field_name = 'replicated_from' LIMIT 1",
    [estimateId]);
  return !!row;
}

async function replicateEstimate(userId, sourceId, opts = {}) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[source]] = await conn.query('SELECT * FROM estimates WHERE id = ? FOR UPDATE', [sourceId]);
    if (!source) {
      await conn.rollback();
      const err = new Error('Not found');
      err.status = 404;
      throw err;
    }
    if (opts.cancelSource) {
      const refuse = (status, message) => { const err = new Error(message); err.status = status; throw err; };
      if (source.status === 'cancelled') refuse(409, `${source.estimate_no} is already cancelled -- use Replicate.`);
      // Cancelling the estimate behind a live Sales Order would leave the order pointing at a
      // cancelled estimate; the order has to be dealt with first.
      const [[liveSo]] = await conn.query(
        `SELECT sales_order_no FROM sales_orders
          WHERE (id = ? OR estimate_id = ?) AND (status IS NULL OR status <> 'cancelled') LIMIT 1`,
        [source.sales_order_id || 0, source.id]);
      if (liveSo) refuse(409, `${source.estimate_no} already has Sales Order ${liveSo.sales_order_no} -- cancel that first, or use Replicate.`);
    }
    const mine = await replicatorDefaults(conn, userId);
    // Prepared By is whoever made THIS estimate -- the person replicating, not the source's author
    // (asked 2026-10-03). Kept from the source only when the replicating account has no employee.
    const [[replicator]] = await conn.query('SELECT employee_id FROM users WHERE id = ?', [userId]);
    const headerValues = HEADER_FIELDS.map((f) => {
      if (f === 'date_created') return new Date().toISOString().slice(0, 10);
      if (f === 'status') return 'pending_supervisor_approval';
      if (f === 'prepared_by_id') return replicator?.employee_id || source.prepared_by_id;
      // Approved By is the supervisor who signed THIS estimate off out of pending_supervisor_
      // approval. A replica has not been approved by anyone -- it starts back at the beginning of
      // the flow -- so carrying the source's approver across would put a supervisor's name on an
      // estimate they have never seen, which is the one thing that field must never say.
      if (f === 'approved_by_id') return null;
      if (f in mine) return mine[f];
      return source[f];
    });
    const tempNo = `TMP-${Date.now()}`;
    const [result] = await conn.query(
      `INSERT INTO estimates (estimate_no, ${HEADER_FIELDS.join(', ')}) VALUES (?, ${HEADER_FIELDS.map(() => '?').join(', ')})`,
      [tempNo, ...headerValues]
    );
    const newEstimateId = result.insertId;
    await conn.query('UPDATE estimates SET estimate_no = ? WHERE id = ?', [`EST-${100000 + newEstimateId}`, newEstimateId]);

    const [jobOrders] = await conn.query('SELECT * FROM estimate_job_orders WHERE estimate_id = ? ORDER BY line_no', [sourceId]);
    // Source lines with no processes come across empty. Said back to the person replicating, since
    // an estimate imported from the source can lack them until back-filled (EST-104541 -> EST-210521,
    // 2026-10-14: copied a minute before its processes were filled in, so the copy had none).
    const linesWithoutProcesses = [];
    // A replica is a new job: the old one's DELIVERY DATE and JOB LOCATION are not its own (asked
    // 2026-11-09), so they start blank -- on every line and the processes' dates -- and have to be
    // filled in again before the estimate goes past the job lines (step 2) or is approved.
    const NOT_COPIED = new Set(['delivery_date', 'job_location_id']);
    for (const jo of jobOrders) {
      const joValues = JOB_ORDER_FIELDS.map((f) => (NOT_COPIED.has(f) ? null : jo[f]));
      const [joResult] = await conn.query(
        `INSERT INTO estimate_job_orders (estimate_id, line_no, ${JOB_ORDER_FIELDS.join(', ')})
         VALUES (?, ?, ${JOB_ORDER_FIELDS.map(() => '?').join(', ')})`,
        [newEstimateId, jo.line_no, ...joValues]
      );
      const [processes] = await conn.query('SELECT * FROM estimate_job_order_processes WHERE estimate_job_order_id = ? ORDER BY line_no', [jo.id]);
      if (!processes.length) linesWithoutProcesses.push(jo.line_no);
      for (const proc of processes) {
        const procValues = PROCESS_FIELDS.map((f) => (f === 'delivery_date' ? null : proc[f]));
        await conn.query(
          `INSERT INTO estimate_job_order_processes (estimate_job_order_id, line_no, ${PROCESS_FIELDS.join(', ')})
           VALUES (?, ?, ${PROCESS_FIELDS.map(() => '?').join(', ')})`,
          [joResult.insertId, proc.line_no, ...procValues]
        );
      }
    }

    await logAudit(conn, {
      estimateId: newEstimateId, userId, eventType: 'Created',
      fieldName: 'replicated_from', newValue: source.estimate_no,
    });
    if (opts.cancelSource) {
      const newNo = `EST-${100000 + newEstimateId}`;
      await conn.query("UPDATE estimates SET status = 'cancelled', updated_at = NOW() WHERE id = ?", [source.id]);
      await logAudit(conn, {
        estimateId: source.id, userId, eventType: 'Status Change',
        fieldName: 'status', oldValue: source.status, newValue: 'cancelled',
      });
      await logAudit(conn, {
        estimateId: source.id, userId, eventType: 'Cancelled',
        fieldName: 'replaced_by', newValue: newNo,
      });
    }
    await conn.commit();
    // The copied header totals are the SOURCE's; the copy's lines are what count from here on.
    await refreshEstimateTotals(newEstimateId);
    const [[row]] = await pool.query('SELECT * FROM estimates WHERE id = ?', [newEstimateId]);
    // replicated_from and the line count ride along for the chatbot, which has to describe
    // what it just did in a sentence. The button ignores them.
    return { ...row, replicated_from: source.estimate_no, job_orders: jobOrders.length, lines_without_processes: linesWithoutProcesses };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

router.post('/:id/replicate', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    res.status(201).json(await replicateEstimate(req.user.id, req.params.id));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Cancel & Replicate: cancels this estimate and makes a new one from it, as the person doing it
// (see replicateEstimate's cancelSource). Needs both halves' rights -- Add to replicate, Edit to
// cancel -- and the same scope as a status change.
router.post('/:id/cancel-and-replicate', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    if (await isOutOfScope(req.user.id, req.params.id)) return res.status(404).json({ error: 'Not found' });
    if (!(await userCan(req.user.id, ROUTE, 'can_edit'))) {
      return res.status(403).json({ error: 'Cancelling an estimate needs Edit rights on Estimates.' });
    }
    res.status(201).json(await replicateEstimate(req.user.id, req.params.id, { cancelSource: true }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Lines for the approval modal: each estimate job line with its GP rate vs the job type's passing
// rate (gp_rate_head), whether it passed, and whether it's already been low-GP-approved. Also tells
// the client whether this user (Admin / General Manager) may tick below-GP lines.
router.get('/:id/approval-lines', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [lines] = await pool.query(
      `SELECT ejo.id, ejo.line_no, jt.display_name AS job_type_name, ejo.description, ejo.quantity, ejo.units,
              ejo.price_per_unit, ejo.subtotal, ejo.disc_amount, ejo.disc_price_per_unit, ejo.net_of_tax,
              t.code AS tax_code, ejo.gross_amount, ejo.length, ejo.width, ejo.height, ejo.uom,
              ejo.gp_rate, jt.gp_rate_head AS passing_gp_rate, ejo.is_approved_low_gp
       FROM estimate_job_orders ejo
       LEFT JOIN job_types jt ON jt.id = ejo.job_type_id
       LEFT JOIN taxes t ON t.id = ejo.tax_code_id
       WHERE ejo.estimate_id = ? ORDER BY ejo.line_no`,
      [req.params.id]
    );
    for (const l of lines) {
      // A line passes when its GP rate meets the job type's passing threshold (when both are known).
      l.passed = l.passing_gp_rate != null && l.gp_rate != null && Number(l.gp_rate) >= Number(l.passing_gp_rate);
    }
    const [[u]] = await pool.query('SELECT account_type FROM users WHERE id = ?', [req.user.id]);
    const canApproveLowGp = ['System Admin', 'General Manager'].includes(u?.account_type);
    res.json({ lines, can_approve_low_gp: canApproveLowGp });
  } catch (err) { next(err); }
});

// May this user act on this estimate as if it were their own?
//
// TWO WAYS TO BE THE OWNER OF THE ACT. The obvious one is having raised it. The other is being
// outside Head Office: the branches work one another's jobs, cover the same counter and answer
// the same walk-in customer, so the rep who happens to be in when the customer rings back is the
// one who has the answer to record -- and that is rarely the rep who typed the estimate. Roselyn
// at Branch - Ayala could not record the customer's approval on an estimate Alessa raised at
// Branch - SM, which is the whole job of a branch.
//
// "...and the transaction is not Head Office" is enforced by the visibility scope, not repeated
// here: getSalesRepEmployeeScope already hands a branch account nothing but branch transactions
// (lib/salesVisibility.js), and every caller below checks it. One definition of whose
// transaction this is, rather than a second one drifting alongside it.
//
// Not the office_location_id stamped on the document -- that column reads Head Office on all but
// a handful of rows, the 29,081 estimates belonging to the branch accounts included, so it would
// refuse a branch user their own branch's work.
//
// AND THE ESTIMATE'S OWN SALES REP. Estimates migrated from the source carry no "Created" audit
// line, so for them the creator is unknown -- and a Head Office rep (Arjie, EST-109619) lost the
// customer-answer buttons on every estimate of his that came over, while keeping them on the ones
// he had raised in T1S. The sales rep named on the estimate is who it belongs to either way.
// A supervisor of the estimate's sales rep -- the same Users > Supervisors list that decides which
// transactions a supervisor sees (lib/salesVisibility.js). A sales supervisor approves their team's
// estimates and records the customer's answer on them, as the rep would (asked for 2026-10-02).
async function isRepSupervisor(userId, estimateId) {
  const [[row]] = await pool.query(
    `SELECT 1 AS yes FROM estimates e
       JOIN users ru ON ru.employee_id = e.sales_rep_id
       JOIN user_supervisors us ON us.user_id = ru.id AND us.supervisor_id = ?
      WHERE e.id = ? LIMIT 1`, [userId, estimateId]);
  return !!row;
}

async function mayActAsOwner(userId, estimateId) {
  if (await isRepSupervisor(userId, estimateId)) return true;
  const creatorId = await getCreatorUserId(pool, estimateId);
  if (creatorId != null && Number(creatorId) === Number(userId)) return true;
  const [[rep]] = await pool.query(
    'SELECT 1 AS yes FROM estimates e JOIN users u ON u.id = ? WHERE e.id = ? AND u.employee_id IS NOT NULL AND e.sales_rep_id = u.employee_id',
    [userId, estimateId]);
  if (rep) return true;
  return !(await isHeadOfficeUser(userId));
}

// Refuses an estimate this user cannot see, so an action can never reach further than the list
// does. The detail view and the email route already answer 404 the same way; this endpoint never
// asked, which mattered little while it wanted can_edit and matters now that can_update opens it.
async function isOutOfScope(userId, estimateId) {
  const scope = await getSalesRepEmployeeScope(userId, ROUTE);
  if (!scope) return false;
  const [[row]] = await pool.query('SELECT sales_rep_id FROM estimates WHERE id = ?', [estimateId]);
  return !scope.includes(row?.sales_rep_id);
}

// Who may move an estimate along the workflow from the read-only view.
//
// can_edit is the general key, but it is the wrong one for the last step. Reaching
// pending_customer_approval takes Edit away from everyone but a System Admin (see PUT /:id), and
// the person waiting on the customer's answer is usually the rep who RAISED the estimate -- no
// approval rights of their own, and by then no edit rights either. They were the only one who
// could get the answer and the only one who could not record it.
//
// So: can_update, from whoever owns the ACT (mayActAsOwner above), for the customer step alone.
// can_update is exactly this right -- advance the transaction, do not rewrite it
// (src/db/add-can-update-permission.js).
//
// BOTH ANSWERS, not just yes. What is being recorded at pending_customer_approval is what the
// CUSTOMER said, and a customer who says no is as much an answer as one who says yes -- letting
// someone record only the approval would leave the refusal stuck with whoever holds can_edit,
// which at this stage is a System Admin and nobody else. Cancelling still wants can_edit, and so
// does every move out of the supervisor stage; the supervisor gate below is untouched, so
// approving out of pending_supervisor_approval still needs Can Approve Sales Estimate.
const CUSTOMER_ANSWERS = ['approved', 'disapproved'];

async function requireStatusChange(req, res, next) {
  try {
    if (await isOutOfScope(req.user.id, req.params.id)) return res.status(404).json({ error: 'Not found' });
    if (await userCan(req.user.id, ROUTE, 'can_edit')) return next();
    // Their rep's supervisor: approve / disapprove out of the supervisor stage, and record the
    // customer's answer -- without needing Edit on Estimates for it.
    if (['pending_customer_approval', ...CUSTOMER_ANSWERS].includes(req.body.status) && await isRepSupervisor(req.user.id, req.params.id)) {
      const [[cur]] = await pool.query('SELECT status FROM estimates WHERE id = ?', [req.params.id]);
      if (['pending_supervisor_approval', 'pending_customer_approval'].includes(cur?.status)) return next();
    }
    if (CUSTOMER_ANSWERS.includes(req.body.status) && await userCan(req.user.id, ROUTE, 'can_update')) {
      const [[row]] = await pool.query('SELECT status FROM estimates WHERE id = ?', [req.params.id]);
      if (row?.status === 'pending_customer_approval' && await mayActAsOwner(req.user.id, req.params.id)) {
        return next();
      }
    }
    return res.status(403).json({ error: 'You do not have permission to perform this action' });
  } catch (err) {
    next(err);
  }
}

// Dedicated status-only update for the Approve/Disapprove actions on the read-only
// view -- a plain field update rather than routing through the full-header PUT, which
// expects every HEADER_FIELDS value re-sent in the exact shape the DB column wants
// (e.g. date_created as a bare date, not the ISO datetime GET returns it as).
router.put('/:id/status', requireAuth, requireStatusChange, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[oldRow]] = await conn.query('SELECT status, sales_order_id, credit_term, sales_division_id FROM estimates WHERE id = ?', [req.params.id]);
    if (!oldRow) {
      await conn.rollback();
      return res.status(404).json({ error: 'Not found' });
    }
    if (!STATUS_VALUES.includes(req.body.status)) {
      await conn.rollback();
      return res.status(400).json({ error: 'Invalid status' });
    }
    // CREDIT TERM IS REQUIRED before an estimate can be approved. Everything downstream is built
    // on it: the Sales Order inherits it, the Invoice fills its Term from it, and the invoice's
    // Date Due is the term's No. of Days counted from the invoice date. Without one the chain
    // has nothing to work from -- which is how invoices came to be dated a flat 30 days out
    // regardless of what was actually agreed.
    //
    // The wizard asks for it on step 3 and refuses to move past without it, but the estimate row
    // is created back on step 1, so it cannot be a NOT NULL column or required on POST. This is
    // the point it can be insisted on without breaking the way the form is filled in.
    //
    // Forward moves only. Cancelling or disapproving an estimate that never got a term has to
    // stay possible, or a half-finished one could never be closed.
    const NEEDS_CREDIT_TERM = ['pending_customer_approval', 'approved'];
    if (NEEDS_CREDIT_TERM.includes(req.body.status) && !String(oldRow.credit_term || '').trim()) {
      await conn.rollback();
      return res.status(400).json({ error: 'Credit Term is required before this estimate can be approved.' });
    }
    // Same for the Sales Division (sales group): its Sales Order copies it, and every sales report,
    // the dashboard breakdown and SBU scoping read it. Eleven estimates went through without one in
    // the first days after go-live and their orders showed as "(no group)".
    // Asked when it leaves Pending Supervisor Approval -- the last stage the rep can still edit it.
    if (req.body.status === 'pending_customer_approval' && !oldRow.sales_division_id) {
      await conn.rollback();
      return res.status(400).json({ error: 'Sales Division is required before this estimate can be approved. Edit the estimate and pick its sales group.' });
    }
    // EVERY JOB LINE NEEDS A DELIVERY DATE AND TIME before the estimate can be approved. They are
    // what the customer is being promised, and everything downstream is built on them: the Sales
    // Order line and the Job Order both carry them through to Production's schedule.
    //
    // Insisted on here rather than as NOT NULL columns or on POST, for the same reason as the
    // credit term above -- the lines are added one at a time while the estimate is still being
    // built, so a line cannot be required to be complete the moment it is created.
    if (NEEDS_CREDIT_TERM.includes(req.body.status)) {
      const [incomplete] = await conn.query(
        `SELECT line_no, description, delivery_date IS NULL AS no_date, delivery_time IS NULL AS no_time
           FROM estimate_job_orders
          WHERE estimate_id = ? AND (delivery_date IS NULL OR delivery_time IS NULL)
          ORDER BY line_no`,
        [req.params.id],
      );
      if (incomplete.length) {
        await conn.rollback();
        // Name the lines and say which half is missing: "fill in the delivery details" on a
        // twelve-line estimate is a hunt.
        const detail = incomplete.slice(0, 5).map((l) => {
          const missing = l.no_date && l.no_time ? 'date and time' : (l.no_date ? 'date' : 'time');
          return `line ${l.line_no}${l.description ? ` (${String(l.description).slice(0, 40)})` : ''} — no delivery ${missing}`;
        }).join('; ');
        return res.status(400).json({
          error: `Delivery Date and Delivery Time are required on every job line before this estimate can be approved. ${detail}${incomplete.length > 5 ? `; and ${incomplete.length - 5} more` : ''}.`,
        });
      }
      // A REPLICATED estimate starts with no Job Location on its lines (replicateEstimate) and must
      // have it filled in again (asked 2026-11-09). Older estimates are not held to it: imported ones
      // can lack it, and refusing them now would stop approvals already under way.
      if (await isReplica(conn, req.params.id)) {
        const [noLoc] = await conn.query(
          `SELECT line_no, description FROM estimate_job_orders WHERE estimate_id = ? AND job_location_id IS NULL ORDER BY line_no`,
          [req.params.id]);
        if (noLoc.length) {
          await conn.rollback();
          const detail = noLoc.slice(0, 5).map((l) => `line ${l.line_no}${l.description ? ` (${String(l.description).slice(0, 40)})` : ''}`).join('; ');
          return res.status(400).json({
            error: `This estimate is a replica -- put the new Job Location on every job line before it can be approved: ${detail}${noLoc.length > 5 ? `; and ${noLoc.length - 5} more` : ''}.`,
          });
        }
      }
      // Process Location on every process line (asked 2026-11-11) -- the job order takes it over.
      // A line saved before the column existed gets its process's Default Location here; one whose
      // process has none must be picked on the line first.
      await conn.query(
        `UPDATE estimate_job_order_processes p JOIN estimate_job_orders jo ON jo.id = p.estimate_job_order_id
           JOIN processes pr ON pr.id = p.process_id
            SET p.location_id = pr.default_location_id
          WHERE jo.estimate_id = ? AND p.location_id IS NULL AND pr.default_location_id IS NOT NULL`,
        [req.params.id]);
      const [noProcLoc] = await conn.query(
        `SELECT jo.line_no, p.line_no AS proc_no, pr.process_name
           FROM estimate_job_order_processes p JOIN estimate_job_orders jo ON jo.id = p.estimate_job_order_id
           LEFT JOIN processes pr ON pr.id = p.process_id
          WHERE jo.estimate_id = ? AND p.process_id IS NOT NULL AND p.location_id IS NULL
          ORDER BY jo.line_no, p.line_no`,
        [req.params.id]);
      if (noProcLoc.length) {
        await conn.rollback();
        const detail = noProcLoc.slice(0, 5).map((l) => `line ${l.line_no} process ${l.proc_no}${l.process_name ? ` (${l.process_name})` : ''}`).join('; ');
        return res.status(400).json({
          error: `Process Location is required on every process line before this estimate can be approved: ${detail}${noProcLoc.length > 5 ? `; and ${noProcLoc.length - 5} more` : ''}.`,
        });
      }
      // Tax Code on every job line (asked 2026-10-20): the Sales Order and the invoice take their
      // tax from it, and a line without one bills as untaxed.
      const [noTax] = await conn.query(
        // A code pointing at no tax row counts as none -- the line would bill untaxed either way.
        `SELECT jo.line_no, jo.description FROM estimate_job_orders jo LEFT JOIN taxes t ON t.id = jo.tax_code_id
          WHERE jo.estimate_id = ? AND t.id IS NULL ORDER BY jo.line_no`,
        [req.params.id]);
      if (noTax.length) {
        await conn.rollback();
        const detail = noTax.slice(0, 5).map((l) => `line ${l.line_no}${l.description ? ` (${String(l.description).slice(0, 40)})` : ''}`).join('; ');
        return res.status(400).json({
          error: `Tax Code is required on every job line before this estimate can be approved: ${detail}${noTax.length > 5 ? `; and ${noTax.length - 5} more` : ''}.`,
        });
      }
    }
    // Approving out of the initial "pending supervisor approval" stage requires the
    // Can Approve Sales Estimate flag from the user's Account Type settings -- checked
    // fresh against the DB rather than trusting the JWT, since that flag can change
    // after the token was issued.
    if (oldRow.status === 'pending_supervisor_approval' && req.body.status === 'pending_customer_approval') {
      const [[approver]] = await conn.query('SELECT can_approve_sales_estimate FROM users WHERE id = ?', [req.user.id]);
      // ...or the supervisor of this estimate's sales rep, who approves their own team's work.
      if (!approver?.can_approve_sales_estimate && !(await isRepSupervisor(req.user.id, req.params.id))) {
        await conn.rollback();
        return res.status(403).json({ error: 'You are not allowed to approve estimates' });
      }
    }
    // Approved By is no longer a manually-picked field (nobody knows who'll approve an
    // estimate at creation time) -- it's set here, to the SUPERVISOR who signs it off out of
    // pending_supervisor_approval. Not to whoever later records the customer's answer: that
    // person is entering what the customer said, not approving the estimate themselves.
    if (oldRow.status === 'pending_supervisor_approval' && req.body.status === 'pending_customer_approval') {
      const [[approvingUser]] = await conn.query('SELECT employee_id FROM users WHERE id = ?', [req.user.id]);
      if (approvingUser?.employee_id) {
        await conn.query('UPDATE estimates SET approved_by_id = ? WHERE id = ?', [approvingUser.employee_id, req.params.id]);
      }
    }
    // Low-GP override: only an Admin or General Manager may approve individual below-GP job lines
    // so they still count toward commission. The checked estimate-line ids arrive as
    // approved_low_gp_line_ids; anyone else sending them is rejected outright.
    // Only at the SUPERVISOR stage (2026-10-03): recording the customer's answer is the owner's
    // act, and a low-GP estimate must not stop them -- the GP was already the supervisor's call.
    // The form also re-sent the lines already approved then, which refused every non-Admin owner.
    let lowGpIds = oldRow.status !== 'pending_supervisor_approval' ? []
      : [...new Set((Array.isArray(req.body.approved_low_gp_line_ids) ? req.body.approved_low_gp_line_ids : []).map(Number).filter(Boolean))];
    if (lowGpIds.length) {
      // Lines approved earlier are no new decision; only the rest need an Admin / GM.
      const [done] = await conn.query(
        'SELECT id FROM estimate_job_orders WHERE estimate_id = ? AND id IN (?) AND is_approved_low_gp = 1', [req.params.id, lowGpIds]);
      const doneIds = new Set(done.map((r) => Number(r.id)));
      lowGpIds = lowGpIds.filter((x) => !doneIds.has(x));
    }
    if (lowGpIds.length) {
      const [[u]] = await conn.query('SELECT account_type FROM users WHERE id = ?', [req.user.id]);
      if (!['System Admin', 'General Manager'].includes(u?.account_type)) {
        await conn.rollback();
        return res.status(403).json({ error: 'Only an Admin or General Manager can approve below-GP job lines.' });
      }
      await conn.query('UPDATE estimate_job_orders SET is_approved_low_gp = 1 WHERE estimate_id = ? AND id IN (?)', [req.params.id, lowGpIds]);
    }

    await conn.query('UPDATE estimates SET status = ?, updated_at = NOW() WHERE id = ?', [req.body.status, req.params.id]);
    await logAudit(conn, {
      estimateId: req.params.id, userId: req.user.id, eventType: 'Updated',
      fieldName: 'status', oldValue: oldRow.status, newValue: req.body.status,
    });
    // Reaching the final "Approved" status is what generates the Sales Order in the
    // real system -- copied as a snapshot (not a live reference) since the estimate can
    // still be edited/replicated afterward independently of the order already placed.
    if (req.body.status === 'approved' && !oldRow.sales_order_id) {
      const salesOrderId = await generateSalesOrderFromEstimate(conn, req.params.id);
      await logAudit(conn, {
        estimateId: req.params.id, userId: req.user.id, eventType: 'Updated',
        fieldName: 'sales_order_id', oldValue: null, newValue: String(salesOrderId),
      });
    }
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM estimates WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), requireOpenPeriod('estimates', 'non_gl'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [jobOrders] = await conn.query('SELECT id FROM estimate_job_orders WHERE estimate_id = ?', [req.params.id]);
    for (const jo of jobOrders) {
      await conn.query('DELETE FROM estimate_job_order_processes WHERE estimate_job_order_id = ?', [jo.id]);
    }
    await conn.query('DELETE FROM estimate_job_orders WHERE estimate_id = ?', [req.params.id]);
    await conn.query('DELETE FROM estimate_shipping_addresses WHERE estimate_id = ?', [req.params.id]);
    await conn.query('DELETE FROM estimates WHERE id = ?', [req.params.id]);
    await conn.commit();
    res.status(204).send();
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// --- Shipping addresses --------------------------------------------------

router.post('/:id/shipping-addresses', requireAuth, requirePermission(ROUTE, 'can_edit'), requireEditableEstimate, async (req, res, next) => {
  try {
    const [result] = await pool.query(
      'INSERT INTO estimate_shipping_addresses (estimate_id, address) VALUES (?, ?)',
      [req.params.id, req.body.address]
    );
    const [[row]] = await pool.query('SELECT * FROM estimate_shipping_addresses WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/shipping-addresses/:addressId', requireAuth, requirePermission(ROUTE, 'can_edit'), requireEditableEstimate, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM estimate_shipping_addresses WHERE id = ? AND estimate_id = ?', [req.params.addressId, req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// --- Job orders ------------------------------------------------------------

router.post('/:id/job-orders', requireAuth, requirePermission(ROUTE, 'can_edit'), requireEditableEstimate, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[{ nextLine }]] = await conn.query(
      'SELECT COALESCE(MAX(line_no), 0) + 1 AS nextLine FROM estimate_job_orders WHERE estimate_id = ?',
      [req.params.id]
    );
    const body = await resolveNstdjoTag(req.body, conn);
    if (!body) {
      await conn.rollback();
      return res.status(400).json({ error: 'That Non-Standard Job Order no longer exists.' });
    }
    const values = pick(body, JOB_ORDER_FIELDS);
    const [result] = await conn.query(
      `INSERT INTO estimate_job_orders (estimate_id, line_no, ${JOB_ORDER_FIELDS.join(', ')})
       VALUES (?, ?, ${JOB_ORDER_FIELDS.map(() => '?').join(', ')})`,
      [req.params.id, nextLine, ...values]
    );
    await logAudit(conn, { estimateId: req.params.id, userId: req.user.id, eventType: 'Created', fieldName: `job_order[${nextLine}]` });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM estimate_job_orders WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id/job-orders/:joId', requireAuth, requirePermission(ROUTE, 'can_edit'), requireEditableEstimate, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[oldRow]] = await conn.query('SELECT * FROM estimate_job_orders WHERE id = ? AND estimate_id = ?', [req.params.joId, req.params.id]);
    if (!oldRow) {
      await conn.rollback();
      return res.status(404).json({ error: 'Not found' });
    }
    const body = await resolveNstdjoTag(req.body, conn);
    if (!body) {
      await conn.rollback();
      return res.status(400).json({ error: 'That Non-Standard Job Order no longer exists.' });
    }
    const values = pick(body, JOB_ORDER_FIELDS);
    await conn.query(
      `UPDATE estimate_job_orders SET ${JOB_ORDER_FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
      [...values, req.params.joId]
    );
    const newValues = {};
    JOB_ORDER_FIELDS.forEach((f, i) => { newValues[f] = values[i]; });
    await logFieldDiffs(conn, {
      estimateId: req.params.id, userId: req.user.id, fields: JOB_ORDER_FIELDS, oldRow, newValues,
      prefix: `job_order[${oldRow.line_no}]`,
    });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM estimate_job_orders WHERE id = ?', [req.params.joId]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Copy a job line, with every one of its processes, as the next line of the same estimate -- the
// "Copy" button beside a line, for an estimate whose items differ only slightly.
router.post('/:id/job-orders/:joId/duplicate', requireAuth, requirePermission(ROUTE, 'can_edit'), requireEditableEstimate, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[jo]] = await conn.query('SELECT * FROM estimate_job_orders WHERE id = ? AND estimate_id = ?', [req.params.joId, req.params.id]);
    if (!jo) {
      await conn.rollback();
      return res.status(404).json({ error: 'Not found' });
    }
    const [[{ nextLine }]] = await conn.query(
      'SELECT COALESCE(MAX(line_no), 0) + 1 AS nextLine FROM estimate_job_orders WHERE estimate_id = ?',
      [req.params.id]
    );
    const [result] = await conn.query(
      `INSERT INTO estimate_job_orders (estimate_id, line_no, ${JOB_ORDER_FIELDS.join(', ')})
       VALUES (?, ?, ${JOB_ORDER_FIELDS.map(() => '?').join(', ')})`,
      [req.params.id, nextLine, ...JOB_ORDER_FIELDS.map((f) => jo[f])]
    );
    const [processes] = await conn.query('SELECT * FROM estimate_job_order_processes WHERE estimate_job_order_id = ? ORDER BY line_no', [jo.id]);
    for (const proc of processes) {
      await conn.query(
        `INSERT INTO estimate_job_order_processes (estimate_job_order_id, line_no, ${PROCESS_FIELDS.join(', ')})
         VALUES (?, ?, ${PROCESS_FIELDS.map(() => '?').join(', ')})`,
        [result.insertId, proc.line_no, ...PROCESS_FIELDS.map((f) => proc[f])]
      );
    }
    await logAudit(conn, {
      estimateId: req.params.id, userId: req.user.id, eventType: 'Created',
      fieldName: `job_order[${nextLine}]`, newValue: `copied from line ${jo.line_no}`,
    });
    await conn.commit();
    res.status(201).json({ id: result.insertId, line_no: nextLine });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.delete('/:id/job-orders/:joId', requireAuth, requirePermission(ROUTE, 'can_edit'), requireEditableEstimate, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[jo]] = await conn.query('SELECT * FROM estimate_job_orders WHERE id = ? AND estimate_id = ?', [req.params.joId, req.params.id]);
    if (!jo) {
      await conn.rollback();
      return res.status(404).json({ error: 'Not found' });
    }
    await conn.query('DELETE FROM estimate_job_order_processes WHERE estimate_job_order_id = ?', [req.params.joId]);
    await conn.query('DELETE FROM estimate_job_orders WHERE id = ?', [req.params.joId]);
    await logAudit(conn, { estimateId: req.params.id, userId: req.user.id, eventType: 'Deleted', fieldName: `job_order[${jo.line_no}]` });
    await closeLineGaps(conn, 'estimate_job_orders', 'estimate_id', req.params.id);
    await conn.commit();
    res.status(204).send();
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// --- Reordering (the ▲ ▼ arrows on the estimate form) ------------------------
//
// The form sends the ids in their new order and line_no is renumbered 1..n to match. Every id must
// belong to the parent named in the URL, and all of them must be sent, so a stale form cannot leave
// two lines sharing a number.
// After a delete, close the gap: what is left is numbered 1..n in its existing order, so deleting
// line 3 of 4 leaves 1, 2, 3 rather than 1, 2, 4 (asked 2026-10-06).
async function closeLineGaps(conn, table, parentCol, parentId) {
  const [rows] = await conn.query(`SELECT id FROM ${table} WHERE ${parentCol} = ? ORDER BY line_no, id`, [parentId]);
  for (let i = 0; i < rows.length; i++) {
    await conn.query(`UPDATE ${table} SET line_no = ? WHERE id = ? AND line_no <> ?`, [i + 1, rows[i].id, i + 1]);
  }
}

async function renumber(conn, table, parentCol, parentId, ids) {
  const [rows] = await conn.query(`SELECT id FROM ${table} WHERE ${parentCol} = ?`, [parentId]);
  const have = new Set(rows.map((r) => Number(r.id)));
  const want = (Array.isArray(ids) ? ids : []).map(Number);
  if (want.length !== have.size || new Set(want).size !== want.length || !want.every((id) => have.has(id))) {
    return false;
  }
  for (let i = 0; i < want.length; i++) {
    await conn.query(`UPDATE ${table} SET line_no = ? WHERE id = ?`, [i + 1, want[i]]);
  }
  return true;
}

router.post('/:id/job-orders/reorder', requireAuth, requirePermission(ROUTE, 'can_edit'), requireEditableEstimate, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (!await renumber(conn, 'estimate_job_orders', 'estimate_id', req.params.id, req.body.ids)) {
      await conn.rollback();
      return res.status(409).json({ error: 'The lines changed since this form was opened. Reload and try again.' });
    }
    await logAudit(conn, { estimateId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'job_order order' });
    await conn.commit();
    res.status(204).send();
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.post('/:id/job-orders/:joId/processes/reorder', requireAuth, requirePermission(ROUTE, 'can_edit'), requireEditableEstimate, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[jo]] = await conn.query('SELECT line_no FROM estimate_job_orders WHERE id = ? AND estimate_id = ?', [req.params.joId, req.params.id]);
    if (!jo || !await renumber(conn, 'estimate_job_order_processes', 'estimate_job_order_id', req.params.joId, req.body.ids)) {
      await conn.rollback();
      return res.status(409).json({ error: 'The process lines changed since this form was opened. Reload and try again.' });
    }
    await logAudit(conn, { estimateId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: `job_order[${jo.line_no}] process order` });
    await conn.commit();
    res.status(204).send();
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// --- Job order processes ----------------------------------------------------

router.post('/:id/job-orders/:joId/processes', requireAuth, requirePermission(ROUTE, 'can_edit'), requireEditableEstimate, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[jo]] = await conn.query('SELECT line_no FROM estimate_job_orders WHERE id = ? AND estimate_id = ?', [req.params.joId, req.params.id]);
    if (!jo) {
      await conn.rollback();
      return res.status(404).json({ error: 'Job order not found' });
    }
    const [[{ nextLine }]] = await conn.query(
      'SELECT COALESCE(MAX(line_no), 0) + 1 AS nextLine FROM estimate_job_order_processes WHERE estimate_job_order_id = ?',
      [req.params.joId]
    );
    const values = pick(req.body, PROCESS_FIELDS);
    if (!await fillProcessLocation(conn, values)) { await conn.rollback(); return res.status(400).json({ error: MISSING_LOCATION }); }
    const [result] = await conn.query(
      `INSERT INTO estimate_job_order_processes (estimate_job_order_id, line_no, ${PROCESS_FIELDS.join(', ')})
       VALUES (?, ?, ${PROCESS_FIELDS.map(() => '?').join(', ')})`,
      [req.params.joId, nextLine, ...values]
    );
    await logAudit(conn, {
      estimateId: req.params.id, userId: req.user.id, eventType: 'Created',
      fieldName: `job_order[${jo.line_no}].process[${nextLine}]`,
    });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM estimate_job_order_processes WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id/job-orders/:joId/processes/:procId', requireAuth, requirePermission(ROUTE, 'can_edit'), requireEditableEstimate, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[jo]] = await conn.query('SELECT line_no FROM estimate_job_orders WHERE id = ? AND estimate_id = ?', [req.params.joId, req.params.id]);
    const [[oldRow]] = await conn.query(
      'SELECT * FROM estimate_job_order_processes WHERE id = ? AND estimate_job_order_id = ?',
      [req.params.procId, req.params.joId]
    );
    if (!jo || !oldRow) {
      await conn.rollback();
      return res.status(404).json({ error: 'Not found' });
    }
    const values = pick(req.body, PROCESS_FIELDS);
    if (!await fillProcessLocation(conn, values)) { await conn.rollback(); return res.status(400).json({ error: MISSING_LOCATION }); }
    await conn.query(
      `UPDATE estimate_job_order_processes SET ${PROCESS_FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
      [...values, req.params.procId]
    );
    const newValues = {};
    PROCESS_FIELDS.forEach((f, i) => { newValues[f] = values[i]; });
    await logFieldDiffs(conn, {
      estimateId: req.params.id, userId: req.user.id, fields: PROCESS_FIELDS, oldRow, newValues,
      prefix: `job_order[${jo.line_no}].process[${oldRow.line_no}]`,
    });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM estimate_job_order_processes WHERE id = ?', [req.params.procId]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.delete('/:id/job-orders/:joId/processes/:procId', requireAuth, requirePermission(ROUTE, 'can_edit'), requireEditableEstimate, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[jo]] = await conn.query('SELECT line_no FROM estimate_job_orders WHERE id = ? AND estimate_id = ?', [req.params.joId, req.params.id]);
    const [[proc]] = await conn.query(
      'SELECT line_no FROM estimate_job_order_processes WHERE id = ? AND estimate_job_order_id = ?',
      [req.params.procId, req.params.joId]
    );
    if (!jo || !proc) {
      await conn.rollback();
      return res.status(404).json({ error: 'Not found' });
    }
    await conn.query('DELETE FROM estimate_job_order_processes WHERE id = ?', [req.params.procId]);
    await closeLineGaps(conn, 'estimate_job_order_processes', 'estimate_job_order_id', req.params.joId);
    await logAudit(conn, {
      estimateId: req.params.id, userId: req.user.id, eventType: 'Deleted',
      fieldName: `job_order[${jo.line_no}].process[${proc.line_no}]`,
    });
    await conn.commit();
    res.status(204).send();
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// The "Print Selected" tick on a process line (2026-10-28; db/add-estimate-print-selected.js): which
// lines' items the "Print with Selected Items" quotations list. It changes only what is printed, so
// it is open at any status -- an approved estimate is printed most -- to anyone who can edit or
// print estimates. Kept out of PROCESS_FIELDS so saving a line on the form never resets it.
router.put('/:id/job-orders/:joId/processes/:procId/print-selected', requireAuth, async (req, res, next) => {
  try {
    if (!(await userCan(req.user.id, ROUTE, 'can_edit')) && !(await userCan(req.user.id, ROUTE, 'can_print')) && !(await isSystemAdmin(req.user.id))) {
      return res.status(403).json({ error: 'You do not have permission to change what this estimate prints.' });
    }
    const [r] = await pool.query(
      `UPDATE estimate_job_order_processes p JOIN estimate_job_orders jo ON jo.id = p.estimate_job_order_id
          SET p.print_selected = ? WHERE p.id = ? AND jo.id = ? AND jo.estimate_id = ?`,
      [req.body?.selected ? 1 : 0, req.params.procId, req.params.joId, req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.json({ print_selected: req.body?.selected ? 1 : 0 });
  } catch (err) { next(err); }
});

// Assign a sales rep to an estimate waiting in For CSA Assignment, and move it on.
//
// A quote raised on the customer-facing website has no sales rep -- nobody took the enquiry --
// so it cannot start at Pending Customer Approval: there would be nobody to send it to or chase
// it. Assigning the rep IS the transition; the estimate becomes Pending Customer Approval in the
// same step, so an assigned estimate can never be left sitting in the queue.
//
// Gated on can_approve for /estimates-csa-assignment rather than /estimates, so handing work out
// can be granted to the Marketing Manager alone without also giving them approval over every
// other estimate in the system.
router.put('/:id/assign-csa', requireAuth, requirePermission(CSA_ROUTE, 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const salesRepId = Number(req.body?.sales_rep_id) || null;
    if (!salesRepId) return res.status(400).json({ error: 'Select a sales rep to assign.' });

    const [[est]] = await conn.query('SELECT id, estimate_no, status, sales_division_id FROM estimates WHERE id = ?', [req.params.id]);
    if (!est) return res.status(404).json({ error: 'Not found' });
    if (est.status !== 'for_csa_assignment') {
      return res.status(409).json({ error: `${est.estimate_no} is not awaiting CSA assignment (it is ${est.status.replace(/_/g, ' ')}).` });
    }

    const [[rep]] = await conn.query('SELECT id FROM employees WHERE id = ?', [salesRepId]);
    if (!rep) return res.status(400).json({ error: 'That sales rep no longer exists.' });

    await conn.beginTransaction();
    await conn.query(
      `UPDATE estimates
          SET sales_rep_id = ?, prepared_by_id = COALESCE(prepared_by_id, ?),
              status = 'pending_customer_approval',
              csa_assigned_by_user_id = ?, csa_assigned_at = NOW()
        WHERE id = ?`,
      [salesRepId, salesRepId, req.user.id, req.params.id]
    );
    await conn.commit();

    const [[row]] = await pool.query(
      `SELECT e.id, e.estimate_no, e.status, e.sales_rep_id,
              CONCAT(emp.first_name, ' ', emp.last_name) AS sales_rep_name, e.csa_assigned_at
         FROM estimates e LEFT JOIN employees emp ON emp.id = e.sales_rep_id
        WHERE e.id = ?`, [req.params.id]
    );
    return res.json(row);
  } catch (err) {
    await conn.rollback();
    return next(err);
  } finally {
    conn.release();
  }
});

// ---------------------------------------------------------------------------------
// Order-confirmation documents: the PO, conforme or proof of payment behind the
// confirmation type on the header. Optional -- an estimate is perfectly valid with none.
//
// PDFs and images only, unlike the job-order attachments this mirrors: this is a scan of a
// commercial document, and accepting spreadsheets or archives here invites the estimate to
// become a general file dump.
// ---------------------------------------------------------------------------------
const ESTIMATE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const ESTIMATE_ATTACHMENT_TYPES = /^(application\/pdf|image\/(png|jpe?g|gif|webp|bmp|tiff))$/i;

router.get('/:id/attachments', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.id, a.file_name, a.mime_type, a.size_bytes, a.created_at, a.archived_at, u.display_name AS uploaded_by_name
         FROM estimate_attachments a
         LEFT JOIN users u ON u.id = a.uploaded_by_user_id
        WHERE a.estimate_id = ? ORDER BY a.id`,
      [req.params.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/:id/attachments', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [[est]] = await pool.query('SELECT id FROM estimates WHERE id = ?', [req.params.id]);
    if (!est) return res.status(404).json({ error: 'Estimate not found.' });

    const { file_name: fileName, data, mime_type: mimeType } = req.body || {};
    if (!fileName || !data) return res.status(400).json({ error: 'file_name and data are required.' });
    if (!ESTIMATE_ATTACHMENT_TYPES.test(String(mimeType || ''))) {
      return res.status(400).json({ error: 'Only a PDF or an image can be attached.' });
    }

    // Accepts a bare base64 string or a full data: URL, since the browser's FileReader hands
    // back the latter.
    const base64 = String(data).includes(',') ? String(data).split(',').pop() : String(data);
    let buf;
    try {
      buf = Buffer.from(base64, 'base64');
    } catch {
      return res.status(400).json({ error: 'data is not valid base64.' });
    }
    if (!buf.length) return res.status(400).json({ error: 'That file is empty.' });
    if (buf.length > ESTIMATE_ATTACHMENT_MAX_BYTES) {
      return res.status(413).json({ error: `Attachments must be ${ESTIMATE_ATTACHMENT_MAX_BYTES / 1024 / 1024}MB or smaller.` });
    }

    const [result] = await pool.query(
      `INSERT INTO estimate_attachments (estimate_id, file_name, mime_type, size_bytes, file_data, uploaded_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.params.id, String(fileName).slice(0, 255), String(mimeType).slice(0, 100), buf.length, buf, req.user.id],
    );
    const [[row]] = await pool.query(
      'SELECT id, file_name, mime_type, size_bytes, created_at FROM estimate_attachments WHERE id = ?',
      [result.insertId],
    );
    res.status(201).json(row);
  } catch (err) { next(err); }
});

router.get('/:id/attachments/:attachmentId/file', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[row]] = await pool.query(
      'SELECT file_name, mime_type, archive_path, file_data FROM estimate_attachments WHERE id = ? AND estimate_id = ?',
      [req.params.attachmentId, req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    // Moved to the office archive drive (db/archive-attachments.js): served from there.
    if (row.archive_path) return sendArchived(req, res, row);
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    // Both types here render in a browser tab, which is what someone checking a PO wants.
    res.setHeader('Content-Disposition', `inline; filename="${row.file_name.replace(/"/g, '')}"`);
    res.send(row.file_data);
  } catch (err) { next(err); }
});

router.delete('/:id/attachments/:attachmentId', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [result] = await pool.query(
      'DELETE FROM estimate_attachments WHERE id = ? AND estimate_id = ?',
      [req.params.attachmentId, req.params.id],
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});


// ---------------------------------------------------------------------------------------
// Send the estimate to the customer
// ---------------------------------------------------------------------------------------
//
// An estimate sitting in Pending Customer Approval is waiting on somebody outside the company to
// look at it, and until now getting it to them happened outside the system entirely -- printed,
// or retyped into a mail client. This closes that gap and, just as importantly, writes down that
// it happened.
//
// WHO IT GOES TO. Only 45 of 69,466 estimates carry a contact_email, so the address is usually
// not on the estimate. It falls back to the linked contact person's address, and the sender can
// override it outright -- 29 of the 47 estimates currently awaiting approval have no address on
// file anywhere, and refusing to send those would make the button useless exactly where it is
// most needed. The address used is echoed back and recorded, so what was typed is never a guess
// afterwards.
//
// WHAT IT SHOWS. The job lines and their amounts, not the process and material breakdown beneath
// them. That breakdown is our costing and carries our margin; it is not the customer's business
// and must not leave the building by accident.
router.get('/:id/email-recipient', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[row]] = await pool.query(
      `SELECT e.id, e.estimate_no, e.status, e.contact_email, e.sent_to_customer_at, e.sent_to_customer_email,
              cc.email AS contact_email_on_file, cc.contact_name, c.name AS customer_name,
              su.display_name AS sent_by_name,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              COALESCE(NULLIF(ru.email, ''), NULLIF(sr.email, '')) AS sales_rep_email
         FROM estimates e
         LEFT JOIN customer_contacts cc ON cc.id = e.contact_person_id
         LEFT JOIN customers c ON c.id = e.customer_id
         LEFT JOIN users su ON su.id = e.sent_to_customer_by_user_id
         LEFT JOIN employees sr ON sr.id = e.sales_rep_id
         LEFT JOIN users ru ON ru.employee_id = e.sales_rep_id AND ru.is_active = TRUE
        WHERE e.id = ?`,
      [req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    // Last sent wins as the suggestion: if somebody corrected the address once, that correction
    // is a better guess than the stale one still sitting on the record.
    const suggested = row.sent_to_customer_email || row.contact_email || row.contact_email_on_file || '';
    res.json({
      suggested,
      // Phrased to read after the word 'from' in the label, rather than as bare nouns that
      // need an article bolted on -- which is how 'from the this estimate' happened.
      source: row.sent_to_customer_email ? 'the address last used'
        : row.contact_email ? 'this estimate'
          : row.contact_email_on_file ? 'the contact record' : null,
      contactName: row.contact_name,
      customerName: row.customer_name,
      sentAt: row.sent_to_customer_at,
      sentTo: row.sent_to_customer_email,
      sentByName: row.sent_by_name,
      // Shown before sending, because "who will the customer think sent this, and where does
      // their reply land" is the thing people most want to check and cannot otherwise see.
      sendAsName: row.sales_rep_email ? row.sales_rep_name : null,
      replyTo: row.sales_rep_email || null,
      // Surfaced so the button can explain itself instead of failing when pressed.
      mailConfigured: mailer.isConfigured(),
      mailProblem: mailer.isConfigured() ? null : mailer.missingReason(),
    });
  } catch (err) { next(err); }
});

// Sending the quotation out is part of chasing the answer, so it opens to whoever owns that act
// -- the same rule the Approve/Disapprove step uses. Without this the branch rep could record the
// customer's decision but not send them the quotation to decide on, which is half a job. The
// handler's own scope check below still refuses an estimate they cannot see.
async function requireEmailSend(req, res, next) {
  try {
    if (await userCan(req.user.id, ROUTE, 'can_edit')) return next();
    if (await userCan(req.user.id, ROUTE, 'can_update') && await mayActAsOwner(req.user.id, req.params.id)) {
      return next();
    }
    return res.status(403).json({ error: 'You do not have permission to perform this action' });
  } catch (err) {
    next(err);
  }
}

router.post('/:id/email', requireAuth, requireEmailSend, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    // Checked before the work rather than after: building the message and then discovering there
    // is no mail server wastes the user's time and reads like a bug.
    if (!mailer.isConfigured()) {
      return res.status(503).json({ error: `Email is not set up on this server -- ${mailer.missingReason()}.` });
    }

    const [[est]] = await conn.query(
      // prepared_by / approved_by are here for the attached PDF's signature blocks -- the print
      // report shows them, so the attachment has to as well or it is a different document.
      `SELECT e.*, c.name AS customer_name, cc.contact_name AS contact_person_name, cc.email AS contact_email_on_file,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              CONCAT(pb.first_name, ' ', pb.last_name) AS prepared_by_name,
              CONCAT(ap.first_name, ' ', ap.last_name) AS approved_by_name,
              -- The rep is an employee; their address lives on the user account linked to that
              -- employee, with the employee record itself as a fallback for reps who have an
              -- address on file but no login.
              COALESCE(NULLIF(ru.email, ''), NULLIF(sr.email, '')) AS sales_rep_email
         FROM estimates e
         LEFT JOIN customers c ON c.id = e.customer_id
         LEFT JOIN customer_contacts cc ON cc.id = e.contact_person_id
         LEFT JOIN employees sr ON sr.id = e.sales_rep_id
         LEFT JOIN employees pb ON pb.id = e.prepared_by_id
         LEFT JOIN employees ap ON ap.id = e.approved_by_id
         LEFT JOIN users ru ON ru.employee_id = e.sales_rep_id AND ru.is_active = TRUE
        WHERE e.id = ?`,
      [req.params.id],
    );
    if (!est) return res.status(404).json({ error: 'Not found' });

    // Same scoping the detail view applies -- an account officer cannot email out somebody
    // else's estimate by posting to its id.
    const scope = await getSalesRepEmployeeScope(req.user.id, ROUTE);
    if (scope && !scope.includes(est.sales_rep_id)) return res.status(404).json({ error: 'Not found' });

    if (est.status !== 'pending_customer_approval') {
      return res.status(409).json({
        error: 'Only an estimate awaiting customer approval can be sent to the customer.',
      });
    }

    const to = String(req.body?.email || est.contact_email || est.contact_email_on_file || '').trim();
    if (!to) {
      return res.status(400).json({ error: 'There is no email address for this customer. Enter one to send it to.' });
    }
    // Deliberately permissive -- enough to catch a typo like a missing @ or a stray space, not an
    // attempt to adjudicate RFC 5322. Rejecting a valid unusual address would be the worse error.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return res.status(400).json({ error: `"${to}" does not look like an email address.` });
    }

    const [jobOrders] = await conn.query(
      // disc_amount and tax_amount come along because the email totals its own figures from the
      // lines rather than reading the estimate header -- see buildEstimateEmail for why.
      //
      // The size, unit price and tax rate are for the attached PDF, which reproduces the full
      // Price Quotation and needs every column the printed one carries. The processes under each
      // line are still not read: that is our costing, and it does not leave the building.
      `SELECT jo.description, jo.quantity, jo.units, jo.subtotal, jo.disc_amount, jo.tax_amount,
              jo.gross_amount, jo.length, jo.width, jo.height, jo.uom, jo.price_per_unit,
              jo.disc_percent, jo.disc_price_per_unit, t.rate AS tax_rate,
              jt.display_name AS job_type
         FROM estimate_job_orders jo
         LEFT JOIN job_types jt ON jt.id = jo.job_type_id
         LEFT JOIN taxes t ON t.id = jo.tax_code_id
        WHERE jo.estimate_id = ? ORDER BY jo.line_no`,
      [req.params.id],
    );

    // Replies go to the sales rep who owns the estimate, not to the SMTP account -- a customer
    // answering "yes please" should land with the person who can act on it.
    const [[me]] = await conn.query('SELECT display_name, email FROM users WHERE id = ?', [req.user.id]);

    // WHO THE CUSTOMER HEARS FROM. The estimate's sales rep owns the relationship, and they are
    // frequently not the person pressing the button -- a CSA or a manager may send on their
    // behalf. So the rep is preferred, and only if they have no address on file does it fall
    // back to whoever is sending.
    //
    // The name and the address are resolved TOGETHER and never mixed. Taking the name from the
    // rep and the address from the sender produced a signature reading one person's name over
    // another person's email, and replies going to someone the customer was never introduced to.
    const rep = est.sales_rep_email
      ? { name: est.sales_rep_name, email: est.sales_rep_email }
      : { name: me?.display_name, email: me?.email };

    const { subject, html, text } = buildEstimateEmail(est, jobOrders, {
      senderName: rep.name,
      senderEmail: rep.email,
      note: String(req.body?.note || '').trim() || null,
    });

    // THE QUOTATION ITSELF, ATTACHED. The body is a readable summary; the PDF is the document --
    // the same Price Quotation the Print button produces, which is what a customer forwards to
    // their own approver, prints, signs and sends back. A body-only email left them retyping it.
    //
    // A PDF THAT WILL NOT BUILD DOES NOT STOP THE SEND. The lines and totals are in the body
    // regardless, so the customer still gets a usable quotation, and holding the whole email
    // hostage to a layout bug helps nobody. What must not happen is the sender being told it went
    // with an attachment when it did not -- so the failure is reported back and shown to them.
    let attachments;
    let pdfProblem = null;
    try {
      attachments = [{
        filename: estimatePdfFilename(est),
        content: await buildEstimatePdf(est, jobOrders),
        contentType: 'application/pdf',
      }];
    } catch (pdfErr) {
      pdfProblem = pdfErr.message || 'The quotation PDF could not be generated.';
      console.error(`estimate ${req.params.id}: quotation PDF failed --`, pdfErr);
    }

    // The From address stays the company mailbox -- see mailer.fromHeader for why it cannot be
    // the rep's own -- but carries the rep's name, and replies are routed to the rep.
    const sent = await mailer.send({
      to, subject, html, text, attachments, replyTo: rep.email || undefined, fromName: rep.name,
    });
    if (!sent.ok) return res.status(502).json({ error: `The mail server refused it: ${sent.error}` });

    // Only written once the send actually succeeded. Recording an attempt as a send is how a
    // system ends up confidently telling someone a customer was contacted when they were not.
    await conn.beginTransaction();
    await conn.query(
      `UPDATE estimates SET sent_to_customer_at = NOW(), sent_to_customer_email = ?,
              sent_to_customer_by_user_id = ?, updated_at = NOW() WHERE id = ?`,
      [to.slice(0, 255), req.user.id, req.params.id],
    );
    // ONCE THE MESSAGE HAS GONE, THE RECORD OF IT MUST SURVIVE. Sending is not undoable. If
    // anything after this point fails and takes the record down with it, the system forgets the
    // customer was contacted and the next person sends a second copy -- the same failure as
    // recording an unsent message, but in the direction that actually reaches the customer.
    try {
      // 'Updated', not 'Emailed': audit_logs.event_type is an ENUM of seven values and does not
      // include the latter, so MySQL rejected the row and rolled back an email that had already
      // left. field_name and the values carry what actually happened.
      await logAudit(conn, {
        estimateId: req.params.id, userId: req.user.id, eventType: 'Updated',
        fieldName: 'sent_to_customer_email', oldValue: est.sent_to_customer_email, newValue: to,
      });
    } catch (auditErr) {
      // A missing audit line is a small loss. Throwing away the fact that a customer was emailed,
      // because the note about it would not save, is a much bigger one.
      console.error(`estimate ${req.params.id}: emailed to ${to}, audit entry failed --`, auditErr.message);
    }
    await conn.commit();

    res.json({
      ok: true, sentTo: to, sentAt: new Date().toISOString(), lines: jobOrders.length,
      sentAs: rep.name, replyTo: rep.email,
      attachedPdf: attachments ? attachments[0].filename : null,
      pdfProblem,
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally { conn.release(); }
});

// Exposed for scripts (a one-off restatement of headers that drifted before this existed).
router.refreshEstimateTotals = refreshEstimateTotals;
module.exports = router;
// Exported so the chatbot raises a copy through exactly this code path.
module.exports.replicateEstimate = replicateEstimate;
module.exports.refreshEstimateTotals = refreshEstimateTotals;
