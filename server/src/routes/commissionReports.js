const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { sendXlsx, day } = require('../lib/xlsxExport');
const { grossDueSql } = require('../lib/invoiceDue');

// Accounting > Reports > Sales Orders (Commission) and Invoices (Commission) (asked 2026-10-22): the
// source system's two commission listings (#/commission-sales-orders, #/commission-invoices), column
// for column, filter for filter.
//
//   Sales Orders (Commission)  one row per Sales Order: its estimate, PO, location, sales division,
//                              customer, rep, preparer, amounts and status (+ cancellation date and
//                              reason when the status filter is Cancelled).
//   Invoices (Commission)      one row per invoice raised from a Sales Order -- with the delivery
//                              ticket it came from -- plus each delivery ticket not yet invoiced; the
//                              SO's own amounts beside them.
// Both: "As of" (up to a date) or "Period from" (between two), defaulting to as of today; GET only;
// ?format=xlsx for the download.
const router = express.Router();
const SO_ROUTE = '/reports/commission-sales-orders';
const INV_ROUTE = '/reports/commission-invoices';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
// filter = 'as of' | 'period from'; d1 / d2 = YYYY-MM-DD.
function dateWhere(col, filter, d1, d2) {
  if (filter === 'period from' && ISO.test(d1 || '') && ISO.test(d2 || '')) return { sql: `${col} BETWEEN ? AND ?`, params: [d1, d2] };
  if (ISO.test(d1 || '')) return { sql: `${col} <= ?`, params: [d1] };
  return null;
}
const page = (q) => Math.max(1, Number(q.page) || 1);
const limit = (q) => Math.min(200, Math.max(1, Number(q.limit) || 25));

const SO_STATUS_LABEL = {
  pending_for_jo: 'PENDING FOR JO', jo_in_process: 'JO IN-PROCESS', pending_delivery: 'PENDING DELIVERY',
  partially_delivered: 'PARTIALLY DELIVERED', pending_billing: 'PENDING BILLING',
  pending_billing_partially_delivered: 'PENDING BILLING / PARTIALLY DELIVERED', partially_billed: 'PARTIALLY BILLED',
  billed: 'BILLED', cancelled: 'CANCELLED',
};
const INV_STATUS = { OPEN: 'saved', 'PAID IN FULL': 'paid_in_full', VOID: 'cancelled' };
const INV_STATUS_LABEL = { saved: 'OPEN', paid_in_full: 'PAID IN FULL', cancelled: 'VOID' };

/* ------------------------------------------------------------------ Sales Orders (Commission) */

router.get('/sales-orders', requireAuth, requirePermission(SO_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const q = req.query;
    const where = []; const params = [];
    const dw = dateWhere('so.date_created', q.date_filter, q.from, q.to);
    if (dw) { where.push(dw.sql); params.push(...dw.params); }
    if (q.status) { where.push('so.status = ?'); params.push(q.status); }
    // Cancelled: the cancellation date can be narrowed too, as on the source.
    if (q.status === 'cancelled') {
      const cw = dateWhere('DATE(so.cancelled_at)', q.cancel_filter, q.cancel_from, q.cancel_to);
      if (cw) { where.push(cw.sql); params.push(...cw.params); }
    }
    if (q.sales_rep_id) { where.push('so.sales_rep_id = ?'); params.push(q.sales_rep_id); }
    if (q.location_id) { where.push('so.office_location_id = ?'); params.push(q.location_id); }
    if (q.sales_division_id) { where.push('so.sales_division_id = ?'); params.push(q.sales_division_id); }
    if (q.customer) { where.push('c.name LIKE ?'); params.push(`%${q.customer}%`); }
    if (q.search) {
      where.push(`(so.sales_order_no LIKE ? OR e.estimate_no LIKE ? OR so.ref_no LIKE ? OR so.order_confirmation_ref LIKE ?
               OR so.memo LIKE ? OR so.contract_description LIKE ? OR c.name LIKE ? OR loc.location_name LIKE ? OR sd.name LIKE ?)`);
      params.push(...Array(9).fill(`%${q.search}%`));
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const from = `FROM sales_orders so
       LEFT JOIN estimates e ON e.id = so.estimate_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN locations loc ON loc.id = so.office_location_id
       LEFT JOIN sales_divisions sd ON sd.id = so.sales_division_id
       LEFT JOIN employees sr ON sr.id = so.sales_rep_id
       LEFT JOIN employees pb ON pb.id = so.prepared_by_id
       LEFT JOIN reasons cr ON cr.id = so.cancel_reason_id`;
    const select = `SELECT so.id, e.estimate_no, e.date_created AS estimate_date, so.sales_order_no, so.ref_no,
              so.order_confirmation_ref AS po_no, so.date_created, loc.location_name, sd.name AS sales_division,
              so.customer_id, c.name AS customer_name, CONCAT_WS(' ', sr.first_name, sr.last_name) AS sales_rep,
              CONCAT_WS(' ', pb.first_name, pb.last_name) AS prepared_by,
              so.net_of_tax, so.tax_total AS tax_amount, so.total_amount, so.status,
              so.cancelled_at, CONCAT_WS(' -- ', cr.name, NULLIF(so.cancel_remarks, '')) AS cancel_reason`;
    const shape = (r) => ({ ...r, status_label: SO_STATUS_LABEL[r.status] || String(r.status || '').toUpperCase() });

    if (String(q.format).toLowerCase() === 'xlsx') {
      const [rows] = await pool.query(`${select} ${from} ${whereSql} ORDER BY so.date_created DESC, so.sales_order_no DESC`, params);
      const cancelled = q.status === 'cancelled';
      return sendXlsx(res, {
        filename: 'Sales-Order-Report.xlsx', sheet: 'Sales Orders (Commission)',
        columns: [
          { header: 'Est. No.', key: 'estimate_no', width: 14 }, { header: 'Est. Date', key: 'estimate_date', width: 12 },
          { header: 'Sale Order No.', key: 'sales_order_no', width: 14 }, { header: 'Ref No.', key: 'ref_no', width: 14 },
          { header: 'PO No.', key: 'po_no', width: 22 }, { header: 'Date', key: 'date_created', width: 12 },
          { header: 'Location', key: 'location_name', width: 18 }, { header: 'Sales Division', key: 'sales_division', width: 14 },
          { header: 'Customer', key: 'customer_name', width: 36 }, { header: 'Sales Rep.', key: 'sales_rep', width: 24 },
          { header: 'Prepared By', key: 'prepared_by', width: 24 },
          { header: 'Net of Tax', key: 'net_of_tax', width: 14, money: true }, { header: 'Tax Amount', key: 'tax_amount', width: 13, money: true },
          { header: 'Total Amount', key: 'total_amount', width: 14, money: true }, { header: 'Status', key: 'status_label', width: 22 },
          ...(cancelled ? [{ header: 'Cancellation Date', key: 'cancelled_at', width: 14 }, { header: 'Reason', key: 'cancel_reason', width: 30 }] : []),
        ],
        rows: rows.map(shape).map((r) => ({ ...r, estimate_date: day(r.estimate_date), date_created: day(r.date_created), cancelled_at: day(r.cancelled_at) })),
      });
    }
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} ${whereSql}`, params);
    const [rows] = await pool.query(`${select} ${from} ${whereSql} ORDER BY so.date_created DESC, so.sales_order_no DESC LIMIT ? OFFSET ?`,
      [...params, limit(q), (page(q) - 1) * limit(q)]);
    return res.json({ rows: rows.map(shape), total, page: page(q), limit: limit(q) });
  } catch (err) { return next(err); }
});

/* ------------------------------------------------------------------ Invoices (Commission) */

// Each invoice raised from a Sales Order (with its delivery ticket, if it came from one), and each
// delivery ticket of a Sales Order that no invoice has been raised from yet.
const INV_ROWS = `(
    SELECT si.sales_order_id AS so_id, si.id AS inv_id, si.delivery_ticket_id AS dt_id, si.date_created AS doc_date
      FROM sales_invoices si WHERE si.sales_order_id IS NOT NULL
    UNION ALL
    SELECT dt.sales_order_id, NULL, dt.id, dt.date_created
      FROM delivery_tickets dt
     WHERE dt.sales_order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sales_invoices x WHERE x.delivery_ticket_id = dt.id)
  ) r`;

router.get('/invoices', requireAuth, requirePermission(INV_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const q = req.query;
    const where = []; const params = [];
    const sw = dateWhere('so.date_created', q.so_date_filter, q.so_from, q.so_to);
    if (sw) { where.push(sw.sql); params.push(...sw.params); }
    const dw = dateWhere('r.doc_date', q.doc_date_filter, q.doc_from, q.doc_to);
    if (dw) { where.push(dw.sql); params.push(...dw.params); }
    // Type: BS (the Service / Sales Invoice) or DR (Delivery Receipt). A delivery ticket not yet
    // invoiced has no type, so it drops out while either is chosen.
    if (q.type === 'bs') where.push("si.invoice_type = 'SI'");
    if (q.type === 'dr') where.push("si.invoice_type = 'DR'");
    if (q.status && INV_STATUS[q.status]) { where.push('si.status = ?'); params.push(INV_STATUS[q.status]); }
    if (q.sales_rep_id) { where.push('COALESCE(si.sales_rep_id, dt.sales_rep_id, so.sales_rep_id) = ?'); params.push(q.sales_rep_id); }
    if (q.location_id) { where.push('COALESCE(si.office_location_id, dt.office_location_id, so.office_location_id) = ?'); params.push(q.location_id); }
    if (q.sales_division_id) { where.push('so.sales_division_id = ?'); params.push(q.sales_division_id); }
    if (q.customer) { where.push('c.name LIKE ?'); params.push(`%${q.customer}%`); }
    if (q.search) {
      where.push('(so.sales_order_no LIKE ? OR si.invoice_no LIKE ? OR si.bs_si_no LIKE ? OR dt.dt_no LIKE ? OR c.name LIKE ? OR si.po_no LIKE ?)');
      params.push(...Array(6).fill(`%${q.search}%`));
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const from = `FROM ${INV_ROWS}
       JOIN sales_orders so ON so.id = r.so_id
       LEFT JOIN sales_invoices si ON si.id = r.inv_id
       LEFT JOIN delivery_tickets dt ON dt.id = r.dt_id
       LEFT JOIN customers c ON c.id = COALESCE(si.customer_id, so.customer_id)
       LEFT JOIN employees sr ON sr.id = COALESCE(si.sales_rep_id, dt.sales_rep_id, so.sales_rep_id)
       LEFT JOIN sales_divisions sd ON sd.id = so.sales_division_id
       LEFT JOIN locations loc ON loc.id = COALESCE(si.office_location_id, dt.office_location_id, so.office_location_id)`;
    const select = `SELECT so.sales_order_no AS so_no, so.date_created AS so_date, so.net_of_tax AS so_net, so.tax_total AS so_tax,
              so.total_amount AS so_amount,
              dt.dt_no, dt.date_created AS dt_date, dt.gross_amount AS dt_amount, UPPER(dt.status) AS dt_status,
              c.id AS customer_id, c.name AS customer_name,
              si.id AS invoice_id, si.invoice_no, si.date_created AS invoice_date, si.net_of_tax AS invoice_net, si.tax_amount AS invoice_tax,
              si.gross_amount AS invoice_amount, IF(si.id IS NULL, NULL, ${grossDueSql('si')}) AS amount_due, si.status AS invoice_status,
              CONCAT_WS(' ', sr.first_name, sr.last_name) AS sales_rep, sd.name AS sales_division, loc.location_name`;
    const order = 'ORDER BY so.date_created DESC, so.sales_order_no DESC, r.doc_date, r.inv_id IS NULL, r.inv_id, r.dt_id';
    const shape = (r) => ({ ...r, status_label: r.invoice_status ? INV_STATUS_LABEL[r.invoice_status] || String(r.invoice_status).toUpperCase() : '' });

    if (String(q.format).toLowerCase() === 'xlsx') {
      const [rows] = await pool.query(`${select} ${from} ${whereSql} ${order}`, params);
      // The SO's own amounts once per order, as on screen -- so a column total counts each SO once.
      let prev = null;
      const out = rows.map(shape).map((r) => {
        const first = r.so_no !== prev; prev = r.so_no;
        return {
          ...r, so_date: day(r.so_date), dt_date: day(r.dt_date), invoice_date: day(r.invoice_date),
          so_net: first ? r.so_net : null, so_tax: first ? r.so_tax : null, so_amount: first ? r.so_amount : null,
        };
      });
      return sendXlsx(res, {
        filename: 'Invoice-Report.xlsx', sheet: 'Invoices (Commission)',
        columns: [
          { header: 'SO No.', key: 'so_no', width: 12 }, { header: 'SO Date', key: 'so_date', width: 12 },
          { header: 'SO Net of Tax Amount', key: 'so_net', width: 15, money: true }, { header: 'SO Tax Amount', key: 'so_tax', width: 13, money: true },
          { header: 'SO Amount', key: 'so_amount', width: 14, money: true },
          { header: 'DT No.', key: 'dt_no', width: 11 }, { header: 'DT Date', key: 'dt_date', width: 12 },
          { header: 'DT Amount', key: 'dt_amount', width: 13, money: true }, { header: 'DT Status', key: 'dt_status', width: 12 },
          { header: 'Customer', key: 'customer_name', width: 36 },
          { header: 'Invoice No.', key: 'invoice_no', width: 13 }, { header: 'Invoice Date', key: 'invoice_date', width: 12 },
          { header: 'Net of Tax', key: 'invoice_net', width: 14, money: true }, { header: 'Tax Amount', key: 'invoice_tax', width: 13, money: true },
          { header: 'Total Amount', key: 'invoice_amount', width: 14, money: true }, { header: 'Amount Due', key: 'amount_due', width: 14, money: true },
          { header: 'Sales Rep.', key: 'sales_rep', width: 24 }, { header: 'Sales Division', key: 'sales_division', width: 14 },
          { header: 'Location', key: 'location_name', width: 18 }, { header: 'Status', key: 'status_label', width: 13 },
        ],
        rows: out,
      });
    }
    // The count carries only the joins its filters read -- over every invoice it is most of the cost.
    const countFrom = `FROM ${INV_ROWS}
       JOIN sales_orders so ON so.id = r.so_id
       LEFT JOIN sales_invoices si ON si.id = r.inv_id
       LEFT JOIN delivery_tickets dt ON dt.id = r.dt_id
       ${q.customer || q.search ? 'LEFT JOIN customers c ON c.id = COALESCE(si.customer_id, so.customer_id)' : ''}`;
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${countFrom} ${whereSql}`, params);
    const [rows] = await pool.query(`${select} ${from} ${whereSql} ${order} LIMIT ? OFFSET ?`,
      [...params, limit(q), (page(q) - 1) * limit(q)]);
    return res.json({ rows: rows.map(shape), total, page: page(q), limit: limit(q) });
  } catch (err) { return next(err); }
});

module.exports = router;
