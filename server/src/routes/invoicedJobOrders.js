const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { sendXlsx, day } = require('../lib/xlsxExport');

// Accounting > Reports > Invoiced Job Orders (asked 2026-10-22): the source system's
// #/invoiced-job-orders, column for column -- one row per invoice line that bills a Job Order
// (standard JOs and NSJOs alike), with its invoice, Sales Order, JO and the line's own amounts.
//
// The filters are the source's, except that its SO Date is Invoice Date here (as asked). Date Created
// is the JO's, Need By Date the JO's delivery date. Each date is "As of" (up to a date) or "Period
// from" (between two); a date left blank does not filter. GET only; ?format=xlsx for the download.
//
// An invoice created from, or converted from, a Delivery Ticket shows the DT in the SO # column and
// the DT's date as SO Date, as the source does (asked 2026-10-22).
const router = express.Router();
const ROUTE = '/reports/invoiced-job-orders';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
function dateWhere(col, filter, d1, d2) {
  if (filter === 'period from' && ISO.test(d1 || '') && ISO.test(d2 || '')) return { sql: `${col} BETWEEN ? AND ?`, params: [d1, d2] };
  if (ISO.test(d1 || '')) return { sql: `${col} <= ?`, params: [d1] };
  return null;
}
const page = (q) => Math.max(1, Number(q.page) || 1);
const limit = (q) => Math.min(200, Math.max(1, Number(q.limit) || 25));

const STATUS = { OPEN: 'saved', 'PAID IN FULL': 'paid_in_full', VOID: 'cancelled' };
const STATUS_LABEL = { saved: 'OPEN', paid_in_full: 'PAID IN FULL', cancelled: 'VOID' };

// Each line's Sales Order is the SO's or, for a non-standard job, the NSSO's. The customer is the
// invoice's, else the order's: imported invoices mostly carry none of their own.
const FROM = `
    FROM sales_invoice_lines l
    JOIN sales_invoices si ON si.id = l.sales_invoice_id
    JOIN job_orders jo ON jo.id = l.job_order_id
    LEFT JOIN sales_orders so ON so.id = COALESCE(jo.sales_order_id, si.sales_order_id)
    LEFT JOIN non_standard_sales_orders ns ON ns.id = COALESCE(jo.nsso_id, si.nsso_id)
    LEFT JOIN sales_order_lines sol ON sol.id = COALESCE(jo.sales_order_line_id, l.sales_order_line_id)
    LEFT JOIN customers c ON c.id = COALESCE(si.customer_id, so.customer_id, ns.customer_id)
    LEFT JOIN employees sr ON sr.id = si.sales_rep_id
    LEFT JOIN locations ol ON ol.id = si.office_location_id
    LEFT JOIN locations jl ON jl.id = COALESCE(l.job_location_id, jo.job_location_id)
    LEFT JOIN departments d ON d.id = si.department_id
    LEFT JOIN delivery_tickets dt ON dt.id = si.delivery_ticket_id`;

const SELECT = `
  SELECT si.id AS invoice_id, si.invoice_no, si.date_created AS invoice_date,
         so.id AS so_id, ns.id AS nsso_id, dt.id AS dt_id,
         COALESCE(dt.dt_no, so.sales_order_no, ns.nsso_no) AS so_no,
         COALESCE(dt.date_created, so.date_created, ns.date_created) AS so_date,
         jo.id AS job_order_id, jo.job_order_no,
         CONCAT_WS(' ', sr.first_name, sr.last_name) AS sales_rep, sol.gp_rate,
         jo.delivery_date AS date_needed, ol.location_name AS office_location, jl.location_name AS location,
         c.id AS customer_id, c.name AS customer_name, l.description,
         COALESCE(so.contract_description, ns.contract_description) AS contract_description,
         l.quantity, l.price_per_unit AS rate, l.net_of_tax, l.tax_amount, l.gross_amount,
         si.status AS invoice_status, si.term, d.name AS department`;

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const q = req.query;
    const where = []; const params = [];
    for (const [col, f, a, b] of [
      ['si.date_created', q.invoice_date_filter, q.invoice_from, q.invoice_to],
      ['DATE(jo.created_at)', q.created_filter, q.created_from, q.created_to],
      ['jo.delivery_date', q.need_filter, q.need_from, q.need_to],
    ]) {
      const w = dateWhere(col, f, a, b);
      if (w) { where.push(w.sql); params.push(...w.params); }
    }
    if (q.status && STATUS[q.status]) { where.push('si.status = ?'); params.push(STATUS[q.status]); }
    if (q.sales_rep_id) { where.push('si.sales_rep_id = ?'); params.push(q.sales_rep_id); }
    if (q.sales_division_id) { where.push('COALESCE(so.sales_division_id, ns.sales_division_id) = ?'); params.push(q.sales_division_id); }
    if (q.location_id) { where.push('COALESCE(l.job_location_id, jo.job_location_id) = ?'); params.push(q.location_id); }
    if (q.office_location_id) { where.push('si.office_location_id = ?'); params.push(q.office_location_id); }
    if (q.customer) { where.push('c.name LIKE ?'); params.push(`%${q.customer}%`); }
    if (q.search) {
      where.push(`(si.invoice_no LIKE ? OR so.sales_order_no LIKE ? OR ns.nsso_no LIKE ? OR jo.job_order_no LIKE ?
                   OR c.name LIKE ? OR l.description LIKE ? OR so.contract_description LIKE ? OR dt.dt_no LIKE ?)`);
      params.push(...Array(8).fill(`%${q.search}%`));
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = 'ORDER BY si.date_created DESC, si.invoice_no DESC, l.id';
    const shape = (r) => ({ ...r, status_label: STATUS_LABEL[r.invoice_status] || String(r.invoice_status || '').toUpperCase() });

    if (String(q.format).toLowerCase() === 'xlsx') {
      const [rows] = await pool.query(`${SELECT} ${FROM} ${whereSql} ${order}`, params);
      return sendXlsx(res, {
        filename: 'Invoiced-Job-Orders-Report.xlsx', sheet: 'Invoiced Job Orders',
        columns: [
          { header: 'Invc #', key: 'invoice_no', width: 12 }, { header: 'Invc Date', key: 'invoice_date', width: 12 },
          { header: 'SO #', key: 'so_no', width: 14 }, { header: 'SO Date', key: 'so_date', width: 12 },
          { header: 'JO #', key: 'job_order_no', width: 18 }, { header: 'Sales Rep', key: 'sales_rep', width: 24 },
          { header: 'GP %', key: 'gp_rate', width: 8, numFmt: '0.00' }, { header: 'Date Needed', key: 'date_needed', width: 12 },
          { header: 'Office Location', key: 'office_location', width: 16 }, { header: 'Location', key: 'location', width: 16 },
          { header: 'Customer', key: 'customer_name', width: 34 }, { header: 'Description', key: 'description', width: 44 },
          { header: 'Contract Desc.', key: 'contract_description', width: 44 },
          { header: 'Qty', key: 'quantity', width: 10, money: true }, { header: 'Rate', key: 'rate', width: 12, money: true },
          { header: 'Net of Tax', key: 'net_of_tax', width: 14, money: true }, { header: 'Tax Amount', key: 'tax_amount', width: 12, money: true },
          { header: 'Gross Amount', key: 'gross_amount', width: 14, money: true }, { header: 'Status', key: 'status_label', width: 13 },
          { header: 'Term', key: 'term', width: 11 }, { header: 'Department', key: 'department', width: 16 },
        ],
        rows: rows.map(shape).map((r) => ({
          ...r, invoice_date: day(r.invoice_date), so_date: day(r.so_date), date_needed: day(r.date_needed),
          gp_rate: r.gp_rate == null ? null : Number(r.gp_rate),
        })),
      });
    }
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${FROM} ${whereSql}`, params);
    const [rows] = await pool.query(`${SELECT} ${FROM} ${whereSql} ${order} LIMIT ? OFFSET ?`,
      [...params, limit(q), (page(q) - 1) * limit(q)]);
    return res.json({ rows: rows.map(shape), total, page: page(q), limit: limit(q) });
  } catch (err) { return next(err); }
});

module.exports = router;
