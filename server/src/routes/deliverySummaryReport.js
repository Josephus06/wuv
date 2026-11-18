const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

// Month-end: how many deliveries went out by each method, and what the outside couriers cost.
//
// Its own page rather than Sales Orders' scope, because what a delivery cost is accounting's
// business -- this can be granted to whoever reconciles the Lalamove statement without opening
// it to everyone who raises a delivery.
const ROUTE = '/reports/delivery-summary';

// Cancelled deliveries are excluded throughout. They never went anywhere, so counting them would
// overstate the month and any fare attached to one is a mistake rather than a cost.
const NOT_CANCELLED = "(del.status IS NULL OR del.status <> 'cancelled')";

function monthBounds(query) {
  const { from, to } = query;
  if (from && to) return { from, to };
  // Default to the month just gone, which is what "month end" means in practice -- you run this
  // in early October for September.
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { from: iso(first), to: iso(last) };
}

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { from, to } = monthBounds(req.query);

    // LEFT JOIN from the method side, so a method with no deliveries this month still reports a
    // zero rather than vanishing. A row that disappears reads as "I forgot to check" -- a zero
    // reads as "we did not use Lalamove in September", which is the actual finding.
    const [byMethod] = await pool.query(
      `SELECT m.id AS delivery_method_id, m.name AS delivery_method_name, m.is_third_party,
              COUNT(del.id) AS delivery_count,
              COALESCE(SUM(del.delivery_cost), 0) AS total_cost,
              SUM(CASE WHEN del.id IS NOT NULL AND del.delivery_cost IS NULL THEN 1 ELSE 0 END) AS missing_cost_count,
              COALESCE(SUM(ln.qty), 0) AS total_qty
         FROM delivery_methods m
         LEFT JOIN item_deliveries del
                ON del.delivery_method_id = m.id
               AND del.date_created BETWEEN ? AND ?
               AND ${NOT_CANCELLED}
         LEFT JOIN (SELECT item_delivery_id, SUM(qty_delivered) AS qty
                      FROM item_delivery_lines GROUP BY item_delivery_id) ln
                ON ln.item_delivery_id = del.id
        WHERE m.is_active = TRUE
        GROUP BY m.id, m.name, m.is_third_party
        ORDER BY m.sort_order, m.name`,
      [from, to],
    );

    // The deliveries nobody recorded a method for. Reported as its own line, never merged into
    // In-house: ~75k historical deliveries predate this feature and guessing at them would be
    // inventing history. A large number here means the month's figures are not yet trustworthy,
    // which is worth seeing rather than hiding.
    const [[unspecified]] = await pool.query(
      `SELECT COUNT(del.id) AS delivery_count, COALESCE(SUM(ln.qty), 0) AS total_qty
         FROM item_deliveries del
         LEFT JOIN (SELECT item_delivery_id, SUM(qty_delivered) AS qty
                      FROM item_delivery_lines GROUP BY item_delivery_id) ln
                ON ln.item_delivery_id = del.id
        WHERE del.delivery_method_id IS NULL
          AND del.date_created BETWEEN ? AND ?
          AND ${NOT_CANCELLED}`,
      [from, to],
    );

    const rows = byMethod.map((r) => ({
      delivery_method_id: r.delivery_method_id,
      delivery_method_name: r.delivery_method_name,
      is_third_party: !!r.is_third_party,
      delivery_count: Number(r.delivery_count),
      total_qty: Number(r.total_qty),
      total_cost: Number(r.total_cost),
      missing_cost_count: Number(r.missing_cost_count),
    }));
    rows.push({
      delivery_method_id: null,
      delivery_method_name: 'Not specified',
      is_third_party: false,
      delivery_count: Number(unspecified.delivery_count),
      total_qty: Number(unspecified.total_qty),
      total_cost: 0,
      missing_cost_count: Number(unspecified.delivery_count),
    });

    const totals = rows.reduce((a, r) => ({
      delivery_count: a.delivery_count + r.delivery_count,
      total_qty: a.total_qty + r.total_qty,
      total_cost: a.total_cost + r.total_cost,
      missing_cost_count: a.missing_cost_count + r.missing_cost_count,
    }), { delivery_count: 0, total_qty: 0, total_cost: 0, missing_cost_count: 0 });

    // The backing detail, so a courier's invoice can be checked line by line against it. Capped:
    // a wide date range over 75k deliveries would otherwise build a response nothing can render.
    const detailLimit = Math.min(5000, Math.max(1, Number(req.query.detail_limit) || 1000));
    const [detail] = await pool.query(
      `SELECT del.id, del.delivery_no, del.date_created, del.delivery_cost, del.delivery_reference,
              COALESCE(dm.name, 'Not specified') AS delivery_method_name,
              so.sales_order_no, c.id AS customer_id, c.name AS customer_name,
              COALESCE(ln.qty, 0) AS total_qty
         FROM item_deliveries del
         JOIN sales_orders so ON so.id = del.sales_order_id
         LEFT JOIN customers c ON c.id = so.customer_id
         LEFT JOIN delivery_methods dm ON dm.id = del.delivery_method_id
         LEFT JOIN (SELECT item_delivery_id, SUM(qty_delivered) AS qty
                      FROM item_delivery_lines GROUP BY item_delivery_id) ln
                ON ln.item_delivery_id = del.id
        WHERE del.date_created BETWEEN ? AND ?
          AND ${NOT_CANCELLED}
        ORDER BY del.date_created DESC, del.id DESC
        LIMIT ?`,
      [from, to, detailLimit],
    );

    if (String(req.query.format || '').toLowerCase() === 'csv') {
      const lines = [];
      lines.push(`Delivery Summary,${from} to ${to}`);
      lines.push('');
      lines.push(['Method', 'Third party', 'Deliveries', 'Qty delivered', 'Total cost', 'Missing cost'].join(','));
      for (const r of rows) {
        lines.push([
          csvCell(r.delivery_method_name), r.is_third_party ? 'Yes' : 'No',
          r.delivery_count, r.total_qty, r.total_cost.toFixed(2), r.missing_cost_count,
        ].join(','));
      }
      lines.push(['TOTAL', '', totals.delivery_count, totals.total_qty,
        totals.total_cost.toFixed(2), totals.missing_cost_count].join(','));
      lines.push('');
      lines.push(['Delivery No', 'Date', 'Method', 'Reference', 'Sales Order', 'Customer', 'Qty', 'Cost'].join(','));
      for (const d of detail) {
        lines.push([
          csvCell(d.delivery_no),
          d.date_created instanceof Date ? d.date_created.toISOString().slice(0, 10) : csvCell(d.date_created),
          csvCell(d.delivery_method_name), csvCell(d.delivery_reference),
          csvCell(d.sales_order_no), csvCell(d.customer_name),
          Number(d.total_qty), d.delivery_cost == null ? '' : Number(d.delivery_cost).toFixed(2),
        ].join(','));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="delivery-summary-${from}-to-${to}.csv"`);
      return res.send(lines.join('\n'));
    }

    return res.json({
      from, to, rows, totals, detail, detail_limit: detailLimit, detail_truncated: detail.length >= detailLimit,
    });
  } catch (err) { return next(err); }
});

module.exports = router;
