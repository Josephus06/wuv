const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { sendXlsx, day } = require('../lib/xlsxExport');

const router = express.Router();
const ROUTE = '/receiving-reports';
const PO_ROUTE = '/purchase-orders';

// Purchasing > Receiving Report -- every RR across all Purchase Orders.
//
// The documents themselves are created and viewed through the PO that produced them
// (POST /purchase-orders/:id/receipts). What was missing was a way to see them as a
// transaction list, so this module is read-only: it lists and opens, it never creates.
//
// Receiving Reports have no status column of their own, and the parent PO's receipt_status
// cannot stand in for one: import-purchasing-related.js inserts receipt rows without
// re-deriving it, so 19,100 of the 19,103 POs that have receipts still read 'not_received'.
// Only the handful received through the app are correct. The list therefore reports the
// receipt's own line count and received quantity, which are true for every row.

// A user reaches a receipt either from this module or by clicking through a Purchase Order,
// so either permission opens it. Written as one query rather than by chaining
// requirePermission twice: that middleware answers a refusal with res.status(403) instead of
// next(err), so a second check placed after it would never run.
async function requireReceiptView(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT p.route FROM user_page_permissions upp
         JOIN pages p ON p.id = upp.page_id
        WHERE upp.user_id = ? AND upp.can_view = TRUE AND p.route IN (?, ?)`,
      [req.user.id, ROUTE, PO_ROUTE]
    );
    if (!rows.length) {
      return res.status(403).json({ error: 'You do not have permission to perform this action' });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

// The Location / Department / Item filters' choices (2026-10-13): only what appears on receipts --
// the location a line was received into, the department on the PO line it received, the item.
router.get('/filter-options', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [locations] = await pool.query(
      `SELECT l.id, l.location_name AS name FROM locations l
        WHERE l.id IN (SELECT DISTINCT location_id FROM purchase_order_receipt_lines WHERE location_id IS NOT NULL)
        ORDER BY l.location_name`);
    const [departments] = await pool.query(
      `SELECT d.id, d.name FROM departments d
        WHERE d.id IN (SELECT DISTINCT pol.department_id FROM purchase_order_receipt_lines rl
                         JOIN purchase_order_lines pol ON pol.id = rl.purchase_order_line_id WHERE pol.department_id IS NOT NULL)
        ORDER BY d.name`);
    res.json({ locations, departments });
  } catch (err) { next(err); }
});

// Item picker search: received items whose code or name matches, at most 50.
router.get('/items', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const [rows] = await pool.query(
      `SELECT i.id, i.item_code, i.display_name FROM inventories i
        WHERE i.id IN (SELECT DISTINCT item_id FROM purchase_order_receipt_lines WHERE item_id IS NOT NULL)
          ${q ? 'AND (i.item_code LIKE ? OR i.display_name LIKE ?)' : ''}
        ORDER BY i.display_name LIMIT 50`, q ? [`%${q}%`, `%${q}%`] : []);
    res.json(rows);
  } catch (err) { next(err); }
});

// The list is ONE ROW PER LINE RECEIVED (asked 2026-11-11, the source's Received Purchase Orders
// screen): RR #, RR Date, Ref #, PO #, PO Date, supplier, memo, item, type, description, qty, units,
// rate, discount, amount, department, location. Its filters as SQL -- shared by the list and its
// Extract. Location / Department / Item narrow the lines themselves, not just the receipts.
function listFilter(req) {
  const { search, supplier_id: supplierId } = req.query;
  // Date: As of (up to that day) or a From-To period (2026-10-13). from/to alone still work.
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  let { from, to } = req.query;
  if (req.query.date_mode === 'as_of') { from = null; to = req.query.as_of; }
  if (from && !ISO.test(from)) from = null;
  if (to && !ISO.test(to)) to = null;
  const where = [];
  const params = [];
  if (search) {
    where.push(`(r.receipt_no LIKE ? OR po.po_no LIKE ? OR s.name LIKE ? OR r.ref_no LIKE ? OR r.memo LIKE ?
                 OR i.display_name LIKE ? OR i.item_code LIKE ? OR pol.purchase_description LIKE ?)`);
    const like = `%${search}%`;
    params.push(like, like, like, like, like, like, like, like);
  }
  // Inclusive of the end date: date_created is a DATE, so a plain <= is what a user means
  // by "to 31 Aug".
  if (from) { where.push('r.date_created >= ?'); params.push(from); }
  if (to) { where.push('r.date_created <= ?'); params.push(to); }
  if (supplierId) { where.push('po.supplier_id = ?'); params.push(supplierId); }
  if (Number(req.query.location_id) > 0) { where.push('rl.location_id = ?'); params.push(Number(req.query.location_id)); }
  if (Number(req.query.department_id) > 0) { where.push('pol.department_id = ?'); params.push(Number(req.query.department_id)); }
  if (Number(req.query.item_id) > 0) { where.push('rl.item_id = ?'); params.push(Number(req.query.item_id)); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return { whereSql, params };
}

const LINE_FROM = `
         FROM purchase_order_receipt_lines rl
         JOIN purchase_order_receipts r ON r.id = rl.purchase_order_receipt_id
         JOIN purchase_orders po ON po.id = r.purchase_order_id
         LEFT JOIN suppliers s ON s.id = po.supplier_id
         LEFT JOIN purchase_order_lines pol ON pol.id = rl.purchase_order_line_id
         LEFT JOIN inventories i ON i.id = rl.item_id
         LEFT JOIN departments d ON d.id = pol.department_id
         LEFT JOIN locations loc ON loc.id = rl.location_id`;

// Amount is the line's net of VAT (qty x rate less discount), as the source's column reads.
const LIST_SELECT = `SELECT rl.id AS line_id, r.id, r.receipt_no, r.date_created, r.ref_no, r.memo,
              po.id AS purchase_order_id, po.po_no, po.date_created AS po_date,
              po.supplier_id, s.name AS supplier_name,
              i.item_code, i.display_name AS item_name, i.item_type,
              COALESCE(pol.purchase_description, i.display_name) AS description,
              rl.qty_received, COALESCE(pol.purchase_unit, pol.unit_title) AS units, rl.rate,
              rl.disc_percent, rl.disc_amount, rl.net_of_tax, rl.tax_amount, rl.ext_price,
              d.name AS department_name, loc.location_name
       ${LINE_FROM}`;

// Type as the source writes it: Inventory / Non-Inventory / JIT / Service ...
const typeLabel = (t) => (String(t || '').toUpperCase() === 'INVENTORY' ? 'Inventory' : t || '');

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const { whereSql, params } = listFilter(req);
    const [rows] = await pool.query(
      `${LIST_SELECT} ${whereSql} ORDER BY r.date_created DESC, r.id DESC, rl.id LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[totals]] = await pool.query(
      `SELECT COUNT(*) AS total, COUNT(DISTINCT r.id) AS receipts, COALESCE(SUM(rl.net_of_tax), 0) AS total_amount
       ${LINE_FROM} ${whereSql}`,
      params
    );
    res.json({
      rows: rows.map((r) => ({ ...r, item_type: typeLabel(r.item_type) })),
      total: totals.total, receipts: totals.receipts, total_amount: totals.total_amount, limit, offset,
    });
  } catch (err) {
    next(err);
  }
});

// Extract (asked 2026-11-05; per line since 2026-11-11): every line under the list's filters.
// Registered before /:id.
router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { whereSql, params } = listFilter(req);
    const [rows] = await pool.query(`${LIST_SELECT} ${whereSql} ORDER BY r.date_created DESC, r.id DESC, rl.id`, params);
    await sendXlsx(res, {
      filename: 'receiving-reports.xlsx',
      sheet: 'Receiving Reports',
      columns: [
        { header: 'RR #', key: 'rr', width: 12 },
        { header: 'RR Date', key: 'date', width: 12 },
        { header: 'Ref #', key: 'ref', width: 18 },
        { header: 'PO #', key: 'po', width: 12 },
        { header: 'PO Date', key: 'po_date', width: 12 },
        { header: 'Name', key: 'supplier', width: 36 },
        { header: 'Memo', key: 'memo', width: 36 },
        { header: 'Item', key: 'item', width: 36 },
        { header: 'Type', key: 'type', width: 14 },
        { header: 'Description', key: 'description', width: 36 },
        { header: 'Qty', key: 'qty', width: 10, numFmt: '#,##0.####' },
        { header: 'Units', key: 'units', width: 8 },
        { header: 'Rate', key: 'rate', width: 12, numFmt: '#,##0.00##' },
        { header: 'Discount', key: 'disc', width: 10, numFmt: '#,##0.##' },
        { header: 'Amount', key: 'amount', width: 14, money: true },
        { header: 'Department', key: 'department', width: 18 },
        { header: 'Location', key: 'location', width: 20 },
      ],
      rows: rows.map((r) => ({
        rr: r.receipt_no, date: day(r.date_created), ref: r.ref_no || '', po: r.po_no || '', po_date: day(r.po_date),
        supplier: r.supplier_name || '', memo: r.memo || '', item: r.item_name || '', type: typeLabel(r.item_type),
        description: r.description || '', qty: Number(r.qty_received || 0), units: r.units || '', rate: Number(r.rate || 0),
        disc: Number(r.disc_percent) ? Number(r.disc_percent) : null, amount: Number(r.net_of_tax || 0),
        department: r.department_name || '', location: r.location_name || '',
      })),
    });
  } catch (err) {
    if (res.headersSent) { res.destroy(err); return; }
    next(err);
  }
});

// Same payload as GET /purchase-orders/receipts/:receiptId, so the existing detail view can
// read from whichever module the user came in through.
router.get('/:id', requireAuth, requireReceiptView, async (req, res, next) => {
  try {
    const [[receipt]] = await pool.query(
      `SELECT r.*, po.id AS purchase_order_id, po.po_no, po.receipt_status,
              po.supplier_id, s.name AS supplier_name, u.display_name AS created_by_name
         FROM purchase_order_receipts r
         JOIN purchase_orders po ON po.id = r.purchase_order_id
         LEFT JOIN suppliers s ON s.id = po.supplier_id
         LEFT JOIN users u ON u.id = r.created_by_user_id
        WHERE r.id = ?`,
      [req.params.id]
    );
    if (!receipt) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      // Department comes from the PURCHASE ORDER LINE, not from the receipt. A receipt line holds
      // no department of its own -- there is no column for one -- and that is the right shape: a
      // delivery is made against an order that is already charged to a department, so reading it
      // through the link means the two can never disagree.
      `SELECT rl.*, i.item_code, i.display_name AS item_name, loc.location_name, t.code AS tax_code,
              d.name AS department_name
         FROM purchase_order_receipt_lines rl
         LEFT JOIN inventories i ON i.id = rl.item_id
         LEFT JOIN locations loc ON loc.id = rl.location_id
         LEFT JOIN taxes t ON t.id = rl.tax_code_id
         LEFT JOIN purchase_order_lines pol ON pol.id = rl.purchase_order_line_id
         LEFT JOIN departments d ON d.id = pol.department_id
        WHERE rl.purchase_order_receipt_id = ?`,
      [req.params.id]
    );

    res.json({ ...receipt, lines });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
