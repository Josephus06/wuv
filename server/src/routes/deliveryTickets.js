const express = require('express');
const pool = require('../db');
const { assignDocNo } = require('../lib/docNumber');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { assertPeriodOpen } = require('../lib/accountingPeriod');
const { computeSalesOrderStatus, openDtQtySql, invoicedOrTicketedSql } = require('../lib/salesOrderStatus');
const { computeDeliveryTicketGl } = require('../lib/glImpact');

const { getSalesRepEmployeeScope } = require('../lib/salesVisibility');
const { postReversalJournal, listReversalJournals } = require('../lib/reversalJournal');
const { sendXlsx, day } = require('../lib/xlsxExport');
const { headerDepartmentError } = require('../lib/requireDepartment');

const router = express.Router();
// Like Sales Invoices (and unlike Item Fulfillment/Receipt, which borrow their parent's
// scope), a Delivery Ticket has its own detail screen reached by its own URL, so it gets
// a real page entry rather than a borrowed one. Registered by
// src/db/create-delivery-tickets.js, which also grants admins full access.
const ROUTE = '/delivery-tickets';

// The order's status, recomputed whenever a ticket is raised, edited or voided: quantity on an open
// ticket counts as billed (lib/salesOrderStatus.js openDtQtySql), so the order leaves Pending
// Billing when its delivered quantity is all on tickets, and returns to it when one is voided.
// A cancelled order is left as it is.
async function refreshSalesOrderStatus(conn, salesOrderId) {
  if (!salesOrderId) return;
  const [[so]] = await conn.query('SELECT status FROM sales_orders WHERE id = ?', [salesOrderId]);
  if (!so || so.status === 'cancelled') return;
  const [lines] = await conn.query(
    `SELECT sol.job_order_id, sol.quantity, jo.quantity_built, jo.quantity_inspected, jo.quantity_delivered, ${invoicedOrTicketedSql('jo')}
       FROM sales_order_lines sol LEFT JOIN job_orders jo ON jo.id = sol.job_order_id WHERE sol.sales_order_id = ?`,
    [salesOrderId]
  );
  await conn.query('UPDATE sales_orders SET status = ?, updated_at = NOW() WHERE id = ?', [computeSalesOrderStatus(lines), salesOrderId]);
}

async function logAudit(conn, { ticketId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('DeliveryTicket', ?, ?, ?, ?, ?, ?)`,
    [ticketId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// Every figure on a line derives from four inputs the create form lets you edit per row
// (qty, price/unit, disc %, tax rate). Recomputed server-side from those rather than
// trusting the client's arithmetic -- the browser's numbers are a preview, this is the
// record. Disc./Unit and Disc. Price/Unit are the two per-unit columns the real DT view
// shows alongside the absolute discount amount.
function computeLineAmounts({ quantity, pricePerUnit, discPercent, taxRate }) {
  const qty = Number(quantity || 0);
  const price = Number(pricePerUnit || 0);
  const pct = Number(discPercent || 0);
  const subtotal = Number((price * qty).toFixed(2));
  const discAmount = Number((subtotal * (pct / 100)).toFixed(2));
  const discPerUnit = Number((price * (pct / 100)).toFixed(4));
  const discPricePerUnit = Number((price - discPerUnit).toFixed(4));
  const netOfTax = Number((subtotal - discAmount).toFixed(2));
  const taxAmount = Number((netOfTax * (Number(taxRate || 0) / 100)).toFixed(2));
  const grossAmount = Number((netOfTax + taxAmount).toFixed(2));
  return {
    subtotal, disc_amount: discAmount, disc_per_unit: discPerUnit, disc_price_per_unit: discPricePerUnit,
    net_of_tax: netOfTax, tax_amount: taxAmount, gross_amount: grossAmount,
  };
}

// A WHOLE Sales Order line (its full ordered qty, nothing invoiced on it yet) at the order's own
// price and discount is ticketed at the order line's stored amounts, not re-priced: those need not
// equal price x disc% (SO-72396's lines carry a typed 439.00 discount against the formula's
// 438.99, so re-pricing made its ticket 8,470.05 on an 8,470.01 order). Gross is Net + Tax.
// Returns null when the line is partial or changed, and the formula applies.
function wholeSoLineAmounts(sol, quantity, pricePerUnit, discPercent) {
  if (!sol || sol.net_of_tax == null || sol.subtotal == null) return null;
  if (Number(sol.quantity_invoiced || 0) !== 0) return null;
  if (Math.abs(Number(sol.quantity) - Number(quantity)) > 1e-9) return null;
  if (Math.abs(Number(sol.price_per_unit) - Number(pricePerUnit)) > 1e-9) return null;
  if (Math.abs(Number(sol.disc_percent || 0) - Number(discPercent || 0)) > 1e-9) return null;
  const net = Number(sol.net_of_tax); const tax = Number(sol.tax_amount || 0);
  return {
    subtotal: Number(sol.subtotal), disc_amount: Number(sol.disc_amount || 0),
    net_of_tax: net, tax_amount: tax, gross_amount: Number((net + tax).toFixed(2)),
  };
}

// Powers the Create DT form. Same eligibility as Create SI -- SO lines whose JO has been
// delivered but not yet fully invoiced -- so the DT button opens onto the same rows the
// Bill dropdown already gates on, each prefilled with its still-unbilled qty.
router.get('/for-sales-order/:salesOrderId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[so]] = await pool.query(
      `SELECT so.id, so.sales_order_no, so.credit_term, so.sales_rep_id, so.office_location_id,
              so.contact_email, so.contact_title, so.contact_phone,
              -- The order's "PO #" (the customer's confirmation ref) prefills the ticket's PO #.
              so.order_confirmation_ref AS po_no,
              c.name AS customer_name, c.tin AS customer_tin,
              cc.contact_name,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              loc.location_name AS office_location_name
       FROM sales_orders so
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN customer_contacts cc ON cc.id = so.contact_person_id
       LEFT JOIN employees sr ON sr.id = so.sales_rep_id
       LEFT JOIN locations loc ON loc.id = so.office_location_id
       WHERE so.id = ?`,
      [req.params.salesOrderId]
    );
    if (!so) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT sol.id AS sales_order_line_id, sol.job_order_id, jo.job_order_no,
              jt.display_name AS item_name, sol.description,
              sol.job_location_id AS location_id, loc.location_name,
              sol.units, sol.uom AS unit_title, sol.price_per_unit, sol.disc_percent,
              sol.tax_code_id, t.code AS tax_code, t.rate AS tax_rate,
              sol.quantity AS ordered_quantity, sol.subtotal, sol.disc_amount, sol.net_of_tax, sol.tax_amount,
              -- what is already on another open ticket is not offered again: see openDtQtySql.
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

    const prefilled = lines.map((l) => {
      const quantity = Number(l.quantity_delivered) - Number(l.quantity_invoiced);
      const formula = computeLineAmounts({
        quantity, pricePerUnit: l.price_per_unit, discPercent: l.disc_percent, taxRate: l.tax_rate,
      });
      const whole = wholeSoLineAmounts({ ...l, quantity: l.ordered_quantity }, quantity, l.price_per_unit, l.disc_percent);
      return {
        ...l,
        quantity,
        ...formula,
        ...(whole || {}),
        // What the form shows while Qty / Price / Disc.% stay as prefilled (see lineAmounts there).
        so_amounts: whole ? { quantity, price_per_unit: l.price_per_unit, disc_percent: l.disc_percent, ...whole } : null,
      };
    });

    res.json({ ...so, lines: prefilled });
  } catch (err) {
    next(err);
  }
});

// The list's filters, shared with its Excel extract so the file holds exactly what the list shows.
async function listFilter(req) {
  const { search, status, date_from: dateFrom, as_of: asOf } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('dt.status = ?'); params.push(status); }
  // Period From / As of Date: inclusive bounds on Date Created.
  if (dateFrom) { where.push('dt.date_created >= ?'); params.push(String(dateFrom).slice(0, 10)); }
  if (asOf) { where.push('dt.date_created <= ?'); params.push(String(asOf).slice(0, 10)); }
  // An Account Officer sees only their own delivery tickets; a Supervisor sees theirs plus their
  // reports'. Same rule Estimates and Sales Orders already apply -- see lib/salesVisibility.js,
  // which returns null (and so changes nothing) for every account that is neither.
  const salesScope = await getSalesRepEmployeeScope(req.user.id, ROUTE);
  if (salesScope) { where.push('dt.sales_rep_id IN (?)'); params.push(salesScope); }
  if (search) {
    where.push('(dt.dt_no LIKE ? OR so.sales_order_no LIKE ? OR c.name LIKE ? OR dt.po_no LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

const LIST_SELECT = `SELECT dt.id, dt.dt_no, dt.date_created, dt.date_due, dt.term, dt.po_no, dt.memo, dt.status,
              dt.net_of_tax, dt.tax_amount, dt.gross_amount, dt.amount_due,
              so.sales_order_no, c.name AS customer_name, so.customer_id,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              loc.location_name AS office_location_name, d.name AS department_name,
              si.id AS sales_invoice_id, si.invoice_no
       FROM delivery_tickets dt
       JOIN sales_orders so ON so.id = dt.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN employees sr ON sr.id = dt.sales_rep_id
       LEFT JOIN locations loc ON loc.id = dt.office_location_id
       LEFT JOIN departments d ON d.id = dt.department_id
       LEFT JOIN sales_invoices si ON si.delivery_ticket_id = dt.id AND si.status != 'cancelled'`;

// Flat list with a Status filter, same shape as Saved Invoices -- no status tabs, since
// a ticket only ever sits in one of three states.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, page = '1', limit = '10' } = req.query;
    const { whereSql, params } = await listFilter(req);

    // PAGINATED SERVER-SIDE. This used to return every delivery ticket with no LIMIT while the
    // page showed ten at a time and sliced the rest away in the browser -- 2.6 MB down the wire
    // to render 10 rows, growing with every ticket raised. Same shape as the Sales Orders list
    // ({ rows, total, page, limit }), which already did this correctly.
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 10));
    const offset = (pageNum - 1) * limitNum;

    // The count carries only the joins its own filters actually reference. sales_orders stays
    // because it is an INNER join and so decides which tickets are in the list at all (26 have
    // no matching sales order and are excluded, exactly as before); customers comes in only for
    // the search. employees, locations and departments are LEFT joins nothing filters on, so
    // dragging them through a count over every row is pure cost.
    //
    // sales_invoices is deliberately NOT here: it is a LEFT join that would multiply a ticket
    // carrying two live invoices, and `total` must be a count of tickets. None do today, but
    // nothing constrains that, and an inflated total silently breaks paging.
    const countFrom = `FROM delivery_tickets dt
       JOIN sales_orders so ON so.id = dt.sales_order_id
       ${search ? 'LEFT JOIN customers c ON c.id = so.customer_id' : ''}`;
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total ${countFrom} ${whereSql}`, params
    );

    const [rows] = await pool.query(
      `${LIST_SELECT}
       ${whereSql}
       ORDER BY dt.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );
    res.json({ rows, total, page: pageNum, limit: limitNum });
  } catch (err) {
    next(err);
  }
});

// Extract: every ticket under the list's current filters, as a workbook. Registered before /:id.
router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { whereSql, params } = await listFilter(req);
    const [rows] = await pool.query(`${LIST_SELECT} ${whereSql} ORDER BY dt.id DESC`, params);
    const STATUS = { open: 'Open', converted: 'Converted', void: 'Void' };
    await sendXlsx(res, {
      filename: 'delivery-tickets.xlsx',
      sheet: 'Delivery Tickets',
      columns: [
        { header: 'DT #', key: 'dt_no', width: 14 },
        { header: 'SO #', key: 'so_no', width: 14 },
        { header: 'Date Created', key: 'date_created', width: 12 },
        { header: 'Date Due', key: 'date_due', width: 12 },
        { header: 'Office Location', key: 'location', width: 20 },
        { header: 'Customer', key: 'customer', width: 38 },
        { header: 'Sales Rep', key: 'sales_rep', width: 24 },
        { header: 'Department', key: 'department', width: 22 },
        { header: 'Net of Tax', key: 'net', width: 15, money: true },
        { header: 'Tax Amount', key: 'tax', width: 14, money: true },
        { header: 'Gross Amount', key: 'gross', width: 15, money: true },
        { header: 'Term', key: 'term', width: 12 },
        { header: 'PO #', key: 'po_no', width: 16 },
        { header: 'Invoice', key: 'invoice', width: 14 },
        { header: 'Status', key: 'status', width: 11 },
        { header: 'Memo', key: 'memo', width: 50 },
      ],
      rows: rows.map((r) => ({
        dt_no: r.dt_no, so_no: r.sales_order_no || '', date_created: day(r.date_created), date_due: day(r.date_due),
        location: r.office_location_name || '', customer: r.customer_name || '', sales_rep: r.sales_rep_name || '',
        department: r.department_name || '', net: Number(r.net_of_tax || 0), tax: Number(r.tax_amount || 0),
        gross: Number(r.gross_amount || 0), term: r.term || '', po_no: r.po_no || '', invoice: r.invoice_no || '',
        status: STATUS[r.status] || r.status, memo: r.memo || '',
      })),
    });
  } catch (err) {
    if (res.headersSent) { res.destroy(err); return; }
    next(err);
  }
});

router.get('/by-sales-order/:salesOrderId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, dt_no, date_created, gross_amount, status FROM delivery_tickets WHERE sales_order_id = ? ORDER BY id DESC',
      [req.params.salesOrderId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[dt]] = await pool.query(
      `SELECT dt.*, so.sales_order_no, so.contact_email, so.contact_title, so.contact_phone,
              c.name AS customer_name, so.customer_id, c.tin AS customer_tin, cc.contact_name,
              -- For the printed ticket's Address and Business Style lines: the customer's default
              -- address on file, else any, else the free-text one on the customer record.
              COALESCE(
                (SELECT ca.address_line FROM customer_addresses ca
                  WHERE ca.customer_id = c.id ORDER BY ca.is_default DESC, ca.id LIMIT 1),
                c.address
              ) AS customer_address,
              (SELECT bs.name FROM business_styles bs WHERE bs.id = c.business_style_id) AS business_style,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              loc.location_name AS office_location_name, d.name AS department_name,
              u.display_name AS created_by_name
       FROM delivery_tickets dt
       JOIN sales_orders so ON so.id = dt.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN customer_contacts cc ON cc.id = so.contact_person_id
       LEFT JOIN employees sr ON sr.id = dt.sales_rep_id
       LEFT JOIN locations loc ON loc.id = dt.office_location_id
       LEFT JOIN departments d ON d.id = dt.department_id
       LEFT JOIN users u ON u.id = dt.created_by_user_id
       WHERE dt.id = ?`,
      [req.params.id]
    );
    if (!dt) return res.status(404).json({ error: 'Not found' });
    // Defence in depth for the list filter above: hiding a document from the list while still
    // serving it to anyone who types its id is not a restriction. See lib/salesVisibility.js.
    const salesScope = await getSalesRepEmployeeScope(req.user.id, ROUTE);
    if (salesScope && !salesScope.includes(dt.sales_rep_id)) {
      return res.status(404).json({ error: 'Not found' });
    }

    const [lines] = await pool.query(
      `SELECT dtl.*, jo.job_order_no, loc.location_name
       FROM delivery_ticket_lines dtl
       LEFT JOIN job_orders jo ON jo.id = dtl.job_order_id
       LEFT JOIN locations loc ON loc.id = dtl.location_id
       WHERE dtl.delivery_ticket_id = ? ORDER BY dtl.line_no`,
      [req.params.id]
    );

    const glImpact = await computeDeliveryTicketGl(dt, lines);
    const reversalJournals = await listReversalJournals(pool, 'delivery_ticket', dt.id);
    res.json({ ...dt, lines, gl_impact: glImpact, reversal_journals: reversalJournals });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'DeliveryTicket' AND a.auditable_id = ?
       ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Saving a DT deliberately does NOT advance job_orders.quantity_invoiced the way saving a
// Sales Invoice does. The ticket posts to AR Trade - *Unbilled*: the goods have gone and
// the sale is recognised, but nothing has been billed yet, so the SO's lines must stay
// eligible for the invoice that follows. See the DT's own Bill button in the real system,
// which is what actually bills it (not modelled here yet).
// The lines of a Delivery Ticket, priced and identified -- shared by create and edit so an edited
// ticket is built exactly as a new one is. SO-backed lines take their identity and tax from the
// order line, never from the request; ad-hoc lines carry only what the form collected.
// `existing` (edit only): the ticket's saved lines. A submitted line that names one of them by
// `id` and leaves its Qty, Price/Unit, Disc.% and tax code as they were keeps its stored amounts
// rather than being re-priced. Those amounts came from the Sales Order, which spreads a discount
// so each line nets to a round unit price (DT-6506: 439.01 off 1,814.00 at 24.2%, not 438.99);
// re-pricing every line on an edit moved the ticket's total by centavos nobody had touched.
async function prepareTicketLines(conn, salesOrderId, lines, existing = []) {
  const savedById = new Map(existing.map((l) => [Number(l.id), l]));
  const submitted = (Array.isArray(lines) ? lines : []).filter((l) => Number(l.quantity) > 0);
  if (!submitted.length) throw Object.assign(new Error('Include at least one item.'), { status: 400 });

  // A line either comes from an SO line or was added ad-hoc via "Add Item". SO-backed
  // lines have their identifying fields taken from the order rather than the request,
  // so a tampered payload can't re-point a line at another order's JO. Ad-hoc lines
  // carry only what the form collected.
  const soLineIds = submitted.map((l) => Number(l.sales_order_line_id)).filter(Boolean);
  const soLineById = new Map();
  if (soLineIds.length) {
    const [rows] = await conn.query(
      `SELECT sol.id, sol.job_order_id, sol.description, sol.job_location_id, sol.units, sol.uom,
              sol.tax_code_id, jt.display_name AS item_name, t.code AS tax_code, t.rate AS tax_rate,
              sol.quantity, sol.price_per_unit, sol.disc_percent, sol.subtotal, sol.disc_amount,
              sol.net_of_tax, sol.tax_amount, jo.quantity_invoiced
       FROM sales_order_lines sol
       LEFT JOIN job_orders jo ON jo.id = sol.job_order_id
       LEFT JOIN job_types jt ON jt.id = sol.job_type_id
       LEFT JOIN taxes t ON t.id = sol.tax_code_id
       WHERE sol.sales_order_id = ? AND sol.id IN (?)`,
      [salesOrderId, soLineIds]
    );
    rows.forEach((r) => soLineById.set(r.id, r));
    if (rows.length !== new Set(soLineIds).size) {
      throw Object.assign(new Error('One of the selected items no longer belongs to this Sales Order.'), { status: 400 });
    }
  }

  // An ad-hoc line names its own tax code; resolve its rate the same way rather than
  // assuming the order's.
  // Every code a line names, ad-hoc or not: an order line with no tax code of its own falls back to
  // the line's (see below).
  const adhocTaxCodes = [...new Set(submitted.filter((l) => l.tax_code).map((l) => l.tax_code))];
  const taxByCode = new Map();
  if (adhocTaxCodes.length) {
    const [rows] = await conn.query('SELECT code, rate FROM taxes WHERE code IN (?)', [adhocTaxCodes]);
    rows.forEach((r) => taxByCode.set(r.code, r));
  }

  const prepared = submitted.map((l, idx) => {
    const src = l.sales_order_line_id ? soLineById.get(Number(l.sales_order_line_id)) : null;
    // The order line's tax when it has one. Many migrated order lines have none, and their tickets
    // carry the source's own codes (VAT_PH:VATIN-12) that the taxes table does not hold -- re-pricing
    // DT-6299 dropped its 12% VAT. So: the line's code, its rate from the table, else the rate the
    // form sent (read off the code or the stored VAT / net), else 0.
    const sentRate = Number(l.tax_rate);
    const fallbackRate = taxByCode.get(l.tax_code)?.rate ?? (Number.isFinite(sentRate) && sentRate >= 0 && sentRate <= 100 ? sentRate : 0);
    const taxCode = src && src.tax_code ? src.tax_code : (l.tax_code || null);
    const taxRate = src && src.tax_code ? src.tax_rate : fallbackRate;
    const pricePerUnit = Number(l.price_per_unit || 0);
    const discPercent = Number(l.disc_percent || 0);
    const quantity = Number(l.quantity);
    const saved = l.id ? savedById.get(Number(l.id)) : null;
    const unchanged = saved
      && Math.abs(Number(saved.quantity) - quantity) < 1e-9
      && Math.abs(Number(saved.price_per_unit) - pricePerUnit) < 1e-9
      && Math.abs(Number(saved.disc_percent) - discPercent) < 1e-9
      && (saved.tax_code || null) === (l.tax_code || null);
    const amounts = unchanged
      ? {
        subtotal: Number(saved.subtotal), disc_amount: Number(saved.disc_amount), disc_per_unit: Number(saved.disc_per_unit),
        disc_price_per_unit: Number(saved.disc_price_per_unit), net_of_tax: Number(saved.net_of_tax),
        tax_amount: Number(saved.tax_amount), gross_amount: Number(saved.gross_amount),
      }
      : (() => {
        const formula = computeLineAmounts({ quantity, pricePerUnit, discPercent, taxRate });
        const whole = src ? wholeSoLineAmounts(src, quantity, pricePerUnit, discPercent) : null;
        return whole ? { ...formula, ...whole } : formula;
      })();
    return {
      line_no: idx + 1,
      sales_order_line_id: src ? src.id : null,
      job_order_id: src ? src.job_order_id : null,
      item_id: l.item_id || null,
      item_name: src ? src.item_name : (l.item_name || null),
      // Description stays editable even on an SO-backed line -- the real form lets you
      // retype it (that is how "DELIVERY FEE" ends up on a MOBILIZATION line).
      description: l.description ?? (src ? src.description : null),
      location_id: l.location_id || (src ? src.job_location_id : null),
      quantity,
      units: l.units ?? (src ? src.units : null),
      unit_title: l.unit_title ?? (src ? src.uom : null),
      price_per_unit: pricePerUnit,
      disc_percent: discPercent,
      tax_code: taxCode,
      ...amounts,
    };
  });

  return prepared;
}

router.post('/', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const {
      sales_order_id: salesOrderId, date_created: dateCreated, date_due: dateDue, term, po_no: poNo,
      sales_rep_id: salesRepId, office_location_id: officeLocationId, department_id: departmentId,
      memo, lines,
    } = req.body;
    if (!salesOrderId) return res.status(400).json({ error: 'Sales Order is required.' });
    const deptError = headerDepartmentError(departmentId);
    if (deptError) return res.status(400).json({ error: deptError });

    const [[so]] = await conn.query('SELECT id FROM sales_orders WHERE id = ?', [salesOrderId]);
    if (!so) return res.status(404).json({ error: 'Sales Order not found.' });

    const prepared = await prepareTicketLines(conn, salesOrderId, lines);
    const sum = (key) => Number(prepared.reduce((s, l) => s + Number(l[key] || 0), 0).toFixed(2));
    const subtotal = sum('subtotal');
    const discountAmount = sum('disc_amount');
    const netOfTax = sum('net_of_tax');
    const taxAmount = sum('tax_amount');
    const grossAmount = sum('gross_amount');
    await assertPeriodOpen(dateCreated, 'ar', conn);

    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO delivery_tickets
         (dt_no, sales_order_id, date_created, date_due, term, po_no, sales_rep_id, office_location_id,
          department_id, memo, subtotal, discount_amount, net_of_tax, tax_amount, gross_amount, amount_due,
          created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        salesOrderId, dateCreated || new Date().toISOString().slice(0, 10), dateDue || null, term || null,
        poNo || null, salesRepId || null, officeLocationId || null, departmentId || null, memo || null,
        subtotal, discountAmount, netOfTax, taxAmount, grossAmount, grossAmount, req.user.id,
      ]
    );
    const ticketId = result.insertId;
    // Its own DT-# sequence -- a Delivery Ticket is not an Invoice and never borrows the
    // INV-# series (confirmed against the real system's DT-1316).
    const dtNo = await assignDocNo(conn, { table: 'delivery_tickets', column: 'dt_no', prefix: 'DT-', id: ticketId });

    for (const l of prepared) {
      await conn.query(
        `INSERT INTO delivery_ticket_lines
           (delivery_ticket_id, line_no, sales_order_line_id, job_order_id, item_id, item_name, description,
            location_id, quantity, units, unit_title, price_per_unit, subtotal, disc_percent, disc_per_unit,
            disc_amount, disc_price_per_unit, net_of_tax, tax_code, tax_amount, gross_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ticketId, l.line_no, l.sales_order_line_id, l.job_order_id, l.item_id, l.item_name, l.description,
          l.location_id, l.quantity, l.units, l.unit_title, l.price_per_unit, l.subtotal, l.disc_percent,
          l.disc_per_unit, l.disc_amount, l.disc_price_per_unit, l.net_of_tax, l.tax_code, l.tax_amount,
          l.gross_amount,
        ]
      );
    }

    await logAudit(conn, { ticketId, userId: req.user.id, eventType: 'Created', fieldName: 'dt_no', newValue: dtNo });
    await refreshSalesOrderStatus(conn, salesOrderId);
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM delivery_tickets WHERE id = ?', [ticketId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    conn.release();
  }
});

// Edit a saved Delivery Ticket -- header and lines, the same form as create. Only while it is OPEN:
// a converted one has been superseded by the Sales Invoice raised from it (that invoice is what posts
// now, and is edited instead), and a void one is final. Nothing else hangs off a ticket's lines --
// saving never advanced the Sales Order's quantities and its GL entry is derived from the ticket --
// so the lines are rebuilt wholesale: a changed line priced exactly as on create, an untouched one
// keeping its stored amounts (see prepareTicketLines). Both the old and the new date
// must be in an open A/R period. Changed header figures are audit-logged.
const TICKET_HEADER = ['date_created', 'date_due', 'term', 'po_no', 'sales_rep_id', 'office_location_id', 'department_id', 'memo',
  'subtotal', 'discount_amount', 'net_of_tax', 'tax_amount', 'gross_amount'];
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[dt]] = await conn.query('SELECT * FROM delivery_tickets WHERE id = ?', [req.params.id]);
    if (!dt) return res.status(404).json({ error: 'Not found' });
    if (dt.status !== 'open') {
      return res.status(409).json({ error: dt.status === 'converted'
        ? 'This Delivery Ticket has been converted to a Sales Invoice -- edit the invoice instead.'
        : 'This Delivery Ticket is void and cannot be edited.' });
    }
    const b = req.body || {};
    const deptError = headerDepartmentError(b.department_id);
    if (deptError) return res.status(400).json({ error: deptError });
    const day = (v) => (v ? String(v).slice(0, 10) : null);
    const oldDate = day(dt.date_created instanceof Date ? dt.date_created.toISOString() : dt.date_created);
    const newDate = day(b.date_created) || oldDate;
    await assertPeriodOpen(oldDate, 'ar', conn);
    if (newDate !== oldDate) await assertPeriodOpen(newDate, 'ar', conn);

    const [savedLines] = await conn.query('SELECT * FROM delivery_ticket_lines WHERE delivery_ticket_id = ?', [dt.id]);
    const prepared = await prepareTicketLines(conn, dt.sales_order_id, b.lines, savedLines);
    const sum = (key) => Number(prepared.reduce((s2, l) => s2 + Number(l[key] || 0), 0).toFixed(2));
    const next = {
      date_created: newDate, date_due: day(b.date_due), term: b.term || null, po_no: b.po_no || null,
      sales_rep_id: Number(b.sales_rep_id) || null, office_location_id: Number(b.office_location_id) || null,
      department_id: Number(b.department_id) || null, memo: b.memo || null,
      subtotal: sum('subtotal'), discount_amount: sum('disc_amount'), net_of_tax: sum('net_of_tax'),
      tax_amount: sum('tax_amount'), gross_amount: sum('gross_amount'),
    };

    await conn.beginTransaction();
    await conn.query(
      `UPDATE delivery_tickets SET ${TICKET_HEADER.map((k) => `${k} = ?`).join(', ')}, amount_due = ? WHERE id = ? AND status = 'open'`,
      [...TICKET_HEADER.map((k) => next[k]), next.gross_amount, dt.id]);
    await conn.query('DELETE FROM delivery_ticket_lines WHERE delivery_ticket_id = ?', [dt.id]);
    for (const l of prepared) {
      await conn.query(
        `INSERT INTO delivery_ticket_lines
           (delivery_ticket_id, line_no, sales_order_line_id, job_order_id, item_id, item_name, description,
            location_id, quantity, units, unit_title, price_per_unit, subtotal, disc_percent, disc_per_unit,
            disc_amount, disc_price_per_unit, net_of_tax, tax_code, tax_amount, gross_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [dt.id, l.line_no, l.sales_order_line_id, l.job_order_id, l.item_id, l.item_name, l.description,
          l.location_id, l.quantity, l.units, l.unit_title, l.price_per_unit, l.subtotal, l.disc_percent,
          l.disc_per_unit, l.disc_amount, l.disc_price_per_unit, l.net_of_tax, l.tax_code, l.tax_amount, l.gross_amount]);
    }
    const show = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);
    for (const k of TICKET_HEADER) {
      const before = show(dt[k]); const after = next[k];
      const same = (before == null && after == null) || String(before ?? '') === String(after ?? '')
        || (typeof after === 'number' && Math.abs(Number(before) - after) < 0.005);
      if (!same) await logAudit(conn, { ticketId: dt.id, userId: req.user.id, eventType: 'Updated', fieldName: k, oldValue: before, newValue: after });
    }
    await logAudit(conn, { ticketId: dt.id, userId: req.user.id, eventType: 'Updated', fieldName: 'lines', newValue: `${prepared.length} line(s)` });
    await refreshSalesOrderStatus(conn, dt.sales_order_id);
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM delivery_tickets WHERE id = ?', [dt.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    conn.release();
  }
});

// Void, not delete -- the real screen's own terminal action. Nothing to reverse on the
// Sales Order because saving never advanced quantity_invoiced in the first place; voiding
// simply stops the ticket posting to the GL (see getPostedGlLines' status filter).
router.put('/:id/void', requireAuth, requirePermission(ROUTE, 'can_void'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[dt]] = await conn.query('SELECT status, date_created FROM delivery_tickets WHERE id = ?', [req.params.id]);
    if (dt) await assertPeriodOpen(dt.date_created, 'ar', conn);
    if (!dt) return res.status(404).json({ error: 'Not found' });
    if (dt.status === 'void') return res.status(409).json({ error: 'This Delivery Ticket is already void.' });

    await conn.beginTransaction();
    await conn.query(
      "UPDATE delivery_tickets SET status = 'void', voided_by_user_id = ?, voided_at = NOW() WHERE id = ?",
      [req.user.id, req.params.id]
    );
    // A void ticket keeps posting its original entry (lib/glImpact.js takes 'open' and 'void'
    // now); the reversal is what withdraws it, in today's period rather than the ticket's own.
    // Note this is only reached from 'open' -- a 'converted' ticket is not posting in the first
    // place, because the Sales Invoice raised from it posts the same revenue.
    const [[fullDt]] = await conn.query(
      `SELECT dt.*, so.office_location_id FROM delivery_tickets dt
       JOIN sales_orders so ON so.id = dt.sales_order_id WHERE dt.id = ?`, [req.params.id]);
    const [dtLines] = await conn.query('SELECT * FROM delivery_ticket_lines WHERE delivery_ticket_id = ?', [req.params.id]);
    const reversal = await postReversalJournal(conn, {
      sourceType: 'delivery_ticket', sourceId: Number(req.params.id), sourceNo: fullDt.dt_no,
      glRows: await computeDeliveryTicketGl(fullDt, dtLines),
      documentDate: fullDt.date_created, voidedAt: new Date(),
      reason: req.body?.reason || null, userId: req.user.id, locationId: fullDt.office_location_id || null,
    });
    // 'Cancelled', not 'Voided' -- audit_logs.event_type is a fixed enum and this is the
    // value Sales Invoice's own void already writes. The screen calls it Void; the audit
    // vocabulary is shared across every module and isn't worth widening for a synonym.
    await logAudit(conn, {
      ticketId: req.params.id, userId: req.user.id, eventType: 'Cancelled',
      fieldName: 'status', oldValue: dt.status, newValue: 'void',
    });
    if (reversal) {
      await logAudit(conn, {
        ticketId: req.params.id, userId: req.user.id, eventType: 'Created',
        fieldName: 'reversal_journal_no', newValue: reversal.journalNo,
      });
    }
    await refreshSalesOrderStatus(conn, fullDt.sales_order_id);
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM delivery_tickets WHERE id = ?', [req.params.id]);
    res.json({ ...row, reversal_journal_no: reversal?.journalNo || null });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
