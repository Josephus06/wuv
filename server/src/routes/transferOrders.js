const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, userCan, isSystemAdmin } = require('../middleware/auth');
const { computeTransitGl } = require('../lib/glImpact');
const { isNonStockItem } = require('../lib/itemTypes');
const { assertPeriodOpen } = require('../lib/accountingPeriod');
const { deriveOnHand } = require('../lib/stockLedger');
const { insertNumbered } = require('../lib/docNumber');
const { computeTOStatus } = require('../lib/transferTotals');
const { sendXlsx, day } = require('../lib/xlsxExport');

const router = express.Router();
const ROUTE = '/transfer-orders';

// Item Fulfillment and Item Receipt have their own permission pages -- they are separate jobs
// done by different warehouses, and used to ride on the Transfer Order's can_approve, so one
// switch governed both fulfilling and receiving. See db/add-fulfillment-receipt-pages.js.
//
// The rule below is that an endpoint is gated by the PAGE IT SERVES, not by the entity it
// returns. So the fulfillment list shown inside a Transfer Order stays on ROUTE: revoking Item
// Fulfillment access should not blank out a panel in the middle of the Transfer Order screen.
const FULFILLMENT_ROUTE = '/item-fulfillments';
const RECEIPT_ROUTE = '/item-receipts';

// qty_on_hand is NOT read from the line's own column (a creation-time snapshot) nor from
// inventory_locations (21 rows for 8,346 item/location pairs, none agreeing with the Bin Card).
// withLiveOnHand overwrites it with the Bin Card's closing balance at the Withdraw From location.
// Unit Used says which of the item's own two units this line is asking for -- the warehouse hands
// over a whole ROLL rather than cutting 24 square feet off it -- and `unit` is rewritten to match
// whenever somebody picks. Both units come back with every line so the screen can name the two
// options, and `unit_used_resolved` is what the dropdown shows selected.
//
// A NULL unit_used means nobody has chosen, which is true of every line that predates the toggle.
// It is resolved for DISPLAY only, never written: 'base' where the stored unit IS the item's base
// unit, 'stock' otherwise -- the same reading stockLedger.js's toBase has always applied to these
// lines, and the one that suits the 18,756 rows holding a legacy composite ('ROLL-SQFT-738').
// Nothing on screen moves until a person picks, because the Unit column still prints `l.unit`.
const UNIT_USED_RESOLVED = `
  CASE WHEN LOWER(l.unit_used) IN ('base', 'baseunit') THEN 'base'
       WHEN LOWER(l.unit_used) IN ('stock', 'stockunit') THEN 'stock'
       WHEN bu.id IS NOT NULL AND UPPER(l.unit) IN (UPPER(bu.title), UPPER(bu.code)) THEN 'base'
       ELSE 'stock' END`;

const LINE_SELECT = `
  SELECT l.*, i.item_code, i.display_name AS item_name, i.item_type,
         jo.job_order_no, t.withdraw_from_location_id, i.conversion_factor,
         bu.title AS base_unit_title, su.title AS stock_unit_title,
         ${UNIT_USED_RESOLVED} AS unit_used_resolved
  FROM transfer_order_lines l
  JOIN transfer_orders t ON t.id = l.transfer_order_id
  LEFT JOIN inventories i ON i.id = l.item_id
  LEFT JOIN units_of_measure bu ON bu.id = i.base_unit_id
  LEFT JOIN units_of_measure su ON su.id = i.stock_unit_id
  LEFT JOIN job_orders jo ON jo.id = l.job_order_id
`;

// Qty on Hand for each line: what the Withdraw From location holds, by the same deriveOnHand the
// Bin Card, Reallocate and Production use, so this column cannot disagree with them. deriveOnHand
// answers in Base Unit; a line asking in its Stock Unit ("1 ROLL") is shown on hand in rolls too,
// or 1 would sit beside a figure hundreds of times larger in a different unit.
async function withLiveOnHand(db, lines) {
  const itemIds = lines.map((l) => l.item_id).filter((id) => id != null);
  if (!itemIds.length) return lines;
  const byPair = await deriveOnHand(db, itemIds);
  for (const l of lines) {
    const base = Number(byPair.get(`${l.item_id}|${l.withdraw_from_location_id}`) || 0);
    const factor = Number(l.conversion_factor) > 0 ? Number(l.conversion_factor) : 1;
    l.qty_on_hand = l.unit_used_resolved === 'stock' && l.stock_unit_title ? base / factor : base;
  }
  return lines;
}

// Spelling follows inventory_adjustment_lines.unit_used, whose migrated rows hold 'StockUnit' /
// 'BaseUnit' beside this app's own 'stock' / 'base'. Nothing migrated into the transfer order
// column, but folding both here means a bare `=== 'stock'` can never creep in and mis-read a row,
// which is the defect that cost inventoryAdjustments.js two rounds of fixes.
const unitUsedIsBase = (v) => ['base', 'baseunit'].includes(String(v || '').trim().toLowerCase());
const normaliseUnitUsed = (v) => (unitUsedIsBase(v) ? 'base' : 'stock');

// The Unit a line shows once Unit Used is chosen: that item's own Stock Unit or Base Unit, by
// title ('Square Foot'), which is the spelling this app has always written. An item with no Stock
// Unit of its own falls back to its Base Unit -- 958 lines are against such an item.
async function unitTitleFor(db, itemId, unitUsed) {
  const [[u]] = await db.query(
    `SELECT bu.title AS base_title, su.title AS stock_title
       FROM inventories i
       LEFT JOIN units_of_measure bu ON bu.id = i.base_unit_id
       LEFT JOIN units_of_measure su ON su.id = i.stock_unit_id
      WHERE i.id = ?`,
    [itemId]
  );
  if (!u) return null;
  return unitUsedIsBase(unitUsed) ? u.base_title : (u.stock_title || u.base_title);
}

async function logAudit(conn, { toId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('TransferOrder', ?, ?, ?, ?, ?, ?)`,
    [toId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// Status is derived from the lines' running totals -- see lib/transferTotals.js.

const OPEN_TO_STATUSES = ['pending_fulfillment', 'partially_fulfilled', 'pending_receipt_partially_fulfilled'];
// Not fulfilled, or partially fulfilled -- what can still be cancelled (2026-10-19).
const CANCELLABLE_TO_STATUSES = ['pending_fulfillment', 'partially_fulfilled', 'pending_receipt_partially_fulfilled'];

// GL Impact for Item Fulfillment / Item Receipt -- the real system's sandbox (GL Impact
// tab, `transaction_transactionledgerentries`) posts these as a two-step stock move
// through a fixed "Inventory In Transit" clearing account (15900), not a direct
// inventory-to-inventory entry: Item Fulfillment credits the item's own inventory asset
// account and debits the clearing account (stock leaves Withdraw From immediately);
// Item Receipt is the exact mirror, debiting the item's asset account and crediting the
// same clearing account (stock lands at Transfer To). Both legs use the same item, so
// they reference the same `inventories.asset_account_id` -- confirmed against two real
// paired examples (IF-9252/qty 1 ROLL crediting "Raw Materials Inventory - LFP", and
// IR-9296/qty 24 SHT debiting "Raw Materials Inventory - Dpod" -- different items,
// different accounts, but each internally consistent with its own item).
// `qtyField`/`assetIsDebit` let one function serve both (Fulfillment: qty_fulfilled,
// asset account credited; Receipt: qty_received, asset account debited).
//
// GL Impact computation itself lives in server/src/lib/glImpact.js (computeTransitGl),
// shared with the Reports engine so the reports can never drift from what this tab shows.
const computeTransitGlImpact = computeTransitGl;

router.get('/status-counts', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT status, COUNT(*) AS count FROM transfer_orders GROUP BY status');
    const counts = {};
    rows.forEach((r) => { counts[r.status] = r.count; });
    res.json(counts);
  } catch (err) {
    next(err);
  }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, status } = req.query;
    const where = [];
    const params = [];
    if (status) { where.push('t.status = ?'); params.push(status); }
    if (search) {
      where.push('(t.to_no LIKE ? OR jo.job_order_no LIKE ? OR t.memo LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (req.query.withdraw_from) { where.push('t.withdraw_from_location_id = ?'); params.push(req.query.withdraw_from); }
    if (req.query.transfer_to) { where.push('t.transfer_to_location_id = ?'); params.push(req.query.transfer_to); }
    // Date Created and Delivery Date (date_needed), each "As of" a day (on or before it) or a
    // "Period from" one day to another -- the old system's two filters. A bound left blank is no
    // bound, so an As of filter only ever sends the _to side.
    const dateRange = (column, from, to) => {
      if (from) { where.push(`${column} >= ?`); params.push(from); }
      if (to) { where.push(`${column} <= ?`); params.push(to); }
    };
    dateRange('t.date_created', req.query.created_from, req.query.created_to);
    dateRange('t.date_needed', req.query.needed_from, req.query.needed_to);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT t.*, wf.location_name AS withdraw_from_name, tt.location_name AS transfer_to_name,
              jo.job_order_no, CONCAT(e.first_name, ' ', e.last_name) AS requestor_name
       FROM transfer_orders t
       LEFT JOIN locations wf ON wf.id = t.withdraw_from_location_id
       LEFT JOIN locations tt ON tt.id = t.transfer_to_location_id
       LEFT JOIN job_orders jo ON jo.id = t.job_order_id
       LEFT JOIN employees e ON e.id = t.requestor_id
       ${whereSql}
       ORDER BY t.id DESC`,
      params
    );
    // format=xlsx (asked 2026-11-09): the same rows -- the open tab and every filter -- as a workbook.
    if (req.query.format === 'xlsx') {
      const STATUS_LABELS = {
        pending_fulfillment: 'Pending Fulfillment', partially_fulfilled: 'Partially Fulfilled', pending_receipt: 'Pending Receipt',
        pending_receipt_partially_fulfilled: 'Pending Receipt / Partially Fulfilled', received: 'Received', cancelled: 'Cancelled',
      };
      await sendXlsx(res, {
        filename: 'transfer-orders.xlsx',
        sheet: 'Transfer Orders',
        columns: [
          { header: 'TO No.', key: 'to_no', width: 14 },
          { header: 'Date Created', key: 'created', width: 13 },
          { header: 'Date Needed', key: 'needed', width: 13 },
          { header: 'Withdraw From', key: 'withdraw_from_name', width: 24 },
          { header: 'Transfer To', key: 'transfer_to_name', width: 24 },
          { header: 'Job Order', key: 'job_order_no', width: 18 },
          { header: 'Requestor', key: 'requestor_name', width: 26 },
          { header: 'Memo', key: 'memo', width: 50 },
          { header: 'Status', key: 'status_label', width: 22 },
        ],
        rows: rows.map((r) => ({
          to_no: r.to_no, created: day(r.date_created), needed: day(r.date_needed),
          withdraw_from_name: r.withdraw_from_name || '', transfer_to_name: r.transfer_to_name || '',
          job_order_no: r.job_order_no || '', requestor_name: r.requestor_name || '', memo: r.memo || '',
          status_label: STATUS_LABELS[r.status] || r.status || '',
        })),
      });
      return;
    }
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Global Item Fulfillment / Item Receipt lists -- reached from their own Inventory nav
// entries rather than only nested under one Transfer Order's Related Records tab.
// Registered here, before GET /:id, since that route's `:id` param would otherwise
// swallow a literal `/item-fulfillments` or `/item-receipts` request first (both are a
// single path segment, same shape as `:id` -- Express matches whichever route was
// registered first).
function locationRequestorFilters(where, params, query, toAlias) {
  const { withdraw_from: withdrawFrom, transfer_to: transferTo, requestor_id: requestorId, as_of: asOf } = query;
  if (withdrawFrom) { where.push(`${toAlias}.withdraw_from_location_id = ?`); params.push(withdrawFrom); }
  if (transferTo) { where.push(`${toAlias}.transfer_to_location_id = ?`); params.push(transferTo); }
  if (requestorId) { where.push(`${toAlias}.requestor_id = ?`); params.push(requestorId); }
  return asOf;
}

// Date From / Date To on the saved fulfilment and receipt lists (2026-10-09); either may be left out.
const YMD = /^\d{4}-\d{2}-\d{2}$/;
function dateRangeFilter(where, params, query, column) {
  const { date_from: from, date_to: to } = query;
  if (from && YMD.test(from)) { where.push(`${column} >= ?`); params.push(from); }
  if (to && YMD.test(to)) { where.push(`${column} <= ?`); params.push(to); }
}

// Paginated: this list holds 41,001 fulfilments after the transfer-order migration, and it
// used to return every one of them, with a second query fanning out to all their lines to
// derive a status.
router.get('/item-fulfillments', requireAuth, requirePermission(FULFILLMENT_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, page = '1', limit = '10' } = req.query;
    const xlsx = req.query.format === 'xlsx';
    const where = [];
    const params = [];
    const asOf = locationRequestorFilters(where, params, req.query, 't');
    if (asOf) { where.push('f.date_created <= ?'); params.push(asOf); }
    dateRangeFilter(where, params, req.query, 'f.date_created');
    // One row per item fulfilled, with the same columns as the Saved Item Receipts list
    // (asked 2026-11-11): the search also reaches the item, its description and the job order.
    if (search) {
      where.push('(f.fulfillment_no LIKE ? OR t.to_no LIKE ? OR i.item_code LIKE ? OR i.display_name LIKE ? OR jo.job_order_no LIKE ?)');
      for (let n = 0; n < 5; n += 1) params.push(`%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const baseFrom = `FROM item_fulfillment_lines fl
       JOIN item_fulfillments f ON f.id = fl.item_fulfillment_id
       JOIN transfer_orders t ON t.id = f.transfer_order_id
       LEFT JOIN transfer_order_lines tol ON tol.id = fl.transfer_order_line_id
       LEFT JOIN inventories i ON i.id = fl.item_id
       LEFT JOIN job_orders jo ON jo.id = COALESCE(tol.job_order_id, t.job_order_id)`;
    // The count needs the item / job order joins only when the search reads them.
    const countFrom = search ? baseFrom : `FROM item_fulfillment_lines fl
       JOIN item_fulfillments f ON f.id = fl.item_fulfillment_id
       JOIN transfer_orders t ON t.id = f.transfer_order_id`;
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${countFrom} ${whereSql}`, params);

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 10));
    const offset = (pageNum - 1) * limitNum;

    const [rows] = await pool.query(
      `SELECT f.id, fl.id AS line_id, f.fulfillment_no, f.date_created, t.to_no, t.date_created AS to_date,
              -- The TO's memo says which job it is for; the fulfilment's own when the TO has none.
              COALESCE(NULLIF(t.memo, ''), f.memo) AS memo, jo.job_order_no,
              i.item_code, i.display_name AS item_name, fl.qty_fulfilled, COALESCE(NULLIF(tol.unit, ''), tol.uom) AS units,
              wf.location_name AS withdraw_from_name, tt.location_name AS transfer_to_name,
              CONCAT(e.first_name, ' ', e.last_name) AS requestor_name
       ${baseFrom}
       LEFT JOIN locations wf ON wf.id = t.withdraw_from_location_id
       LEFT JOIN locations tt ON tt.id = t.transfer_to_location_id
       LEFT JOIN employees e ON e.id = t.requestor_id
       ${whereSql}
       ORDER BY fl.item_fulfillment_id DESC, fl.id
       ${xlsx ? '' : 'LIMIT ? OFFSET ?'}`,
      xlsx ? params : [...params, limitNum, offset]
    );
    if (xlsx) {
      await sendXlsx(res, {
        filename: 'item-fulfillments.xlsx',
        sheet: 'Item Fulfillments',
        columns: [
          { header: 'IF #', key: 'fulfillment_no', width: 14 },
          { header: 'IF Date', key: 'date', width: 12 },
          { header: 'TO #', key: 'to_no', width: 14 },
          { header: 'TO Date', key: 'to_day', width: 12 },
          { header: 'JO #', key: 'job_order_no', width: 18 },
          { header: 'Memo', key: 'memo', width: 44 },
          { header: 'Item', key: 'item_code', width: 36 },
          { header: 'Description', key: 'item_name', width: 36 },
          { header: 'Qty', key: 'qty', width: 10 },
          { header: 'Units', key: 'units', width: 8 },
          { header: 'From Location', key: 'withdraw_from_name', width: 22 },
          { header: 'To Location', key: 'transfer_to_name', width: 22 },
          { header: 'Requestor', key: 'requestor_name', width: 24 },
        ],
        rows: rows.map((r) => ({
          ...r, date: day(r.date_created), to_day: day(r.to_date), memo: r.memo || '', job_order_no: r.job_order_no || '',
          item_code: r.item_code || '', item_name: r.item_name || '', qty: r.qty_fulfilled == null ? '' : Number(r.qty_fulfilled), units: r.units || '',
          requestor_name: r.requestor_name || '',
        })),
      });
      return;
    }
    res.json({ rows, total, page: pageNum, limit: limitNum });
  } catch (err) {
    next(err);
  }
});

// Paginated for the same reason as the fulfilments list above: 40,584 receipts.
router.get('/item-receipts', requireAuth, requirePermission(RECEIPT_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, page = '1', limit = '10' } = req.query;
    const xlsx = req.query.format === 'xlsx';
    const where = [];
    const params = [];
    const asOf = locationRequestorFilters(where, params, req.query, 't');
    if (asOf) { where.push('r.date_created <= ?'); params.push(asOf); }
    dateRangeFilter(where, params, req.query, 'r.date_created');
    // One row per item received (asked 2026-11-10, as the old system lists them): the search also
    // reaches the item, its description and the job order.
    if (search) {
      where.push('(r.receipt_no LIKE ? OR t.to_no LIKE ? OR f.fulfillment_no LIKE ? OR i.item_code LIKE ? OR i.display_name LIKE ? OR jo.job_order_no LIKE ?)');
      for (let n = 0; n < 6; n += 1) params.push(`%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const baseFrom = `FROM item_receipt_lines rl
       JOIN item_receipts r ON r.id = rl.item_receipt_id
       JOIN transfer_orders t ON t.id = r.transfer_order_id
       JOIN item_fulfillments f ON f.id = r.item_fulfillment_id
       LEFT JOIN transfer_order_lines tol ON tol.id = rl.transfer_order_line_id
       LEFT JOIN inventories i ON i.id = rl.item_id
       LEFT JOIN job_orders jo ON jo.id = COALESCE(tol.job_order_id, t.job_order_id)`;
    // The count needs the item / job order joins only when the search reads them.
    const countFrom = search ? baseFrom : `FROM item_receipt_lines rl
       JOIN item_receipts r ON r.id = rl.item_receipt_id
       JOIN transfer_orders t ON t.id = r.transfer_order_id
       JOIN item_fulfillments f ON f.id = r.item_fulfillment_id`;
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${countFrom} ${whereSql}`, params);

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 10));
    const offset = (pageNum - 1) * limitNum;

    const [rows] = await pool.query(
      `SELECT r.id, rl.id AS line_id, r.receipt_no, r.date_created, t.to_no, t.date_created AS to_date, f.fulfillment_no,
              -- The TO's memo says which job it is for; the receipt's own when the TO has none.
              COALESCE(NULLIF(t.memo, ''), r.memo) AS memo, jo.job_order_no,
              i.item_code, i.display_name AS item_name, rl.qty_received, COALESCE(NULLIF(tol.unit, ''), tol.uom) AS units,
              wf.location_name AS withdraw_from_name, tt.location_name AS transfer_to_name,
              CONCAT(e.first_name, ' ', e.last_name) AS requestor_name
       ${baseFrom}
       LEFT JOIN locations wf ON wf.id = t.withdraw_from_location_id
       LEFT JOIN locations tt ON tt.id = t.transfer_to_location_id
       LEFT JOIN employees e ON e.id = t.requestor_id
       ${whereSql}
       ORDER BY rl.item_receipt_id DESC, rl.id
       ${xlsx ? '' : 'LIMIT ? OFFSET ?'}`,
      xlsx ? params : [...params, limitNum, offset]
    );
    if (xlsx) {
      await sendXlsx(res, {
        filename: 'item-receipts.xlsx',
        sheet: 'Item Receipts',
        columns: [
          { header: 'IR #', key: 'receipt_no', width: 14 },
          { header: 'IR Date', key: 'date', width: 12 },
          { header: 'TO #', key: 'to_no', width: 14 },
          { header: 'TO Date', key: 'to_day', width: 12 },
          { header: 'IF #', key: 'fulfillment_no', width: 14 },
          { header: 'JO #', key: 'job_order_no', width: 18 },
          { header: 'Memo', key: 'memo', width: 44 },
          { header: 'Item', key: 'item_code', width: 36 },
          { header: 'Description', key: 'item_name', width: 36 },
          { header: 'Qty', key: 'qty', width: 10 },
          { header: 'Units', key: 'units', width: 8 },
          { header: 'From Location', key: 'withdraw_from_name', width: 22 },
          { header: 'To Location', key: 'transfer_to_name', width: 22 },
          { header: 'Requestor', key: 'requestor_name', width: 24 },
        ],
        rows: rows.map((r) => ({
          ...r, date: day(r.date_created), to_day: day(r.to_date), memo: r.memo || '', job_order_no: r.job_order_no || '',
          item_code: r.item_code || '', item_name: r.item_name || '', qty: r.qty_received == null ? '' : Number(r.qty_received), units: r.units || '',
          requestor_name: r.requestor_name || '',
        })),
      });
      return;
    }
    res.json({ rows, total, page: pageNum, limit: limitNum });
  } catch (err) {
    next(err);
  }
});

// The Add/Update form's pickers -- Requestor and Add Material -- under this page's own permission.
// The form used to read GET /employees and GET /inventory, which answer only to the Employees and
// Inventory pages: a storekeeper granted Transfer Orders but not those (Dave Delerio) had the form
// fail to load at all, so could not raise a TO. Only the fields the form shows are sent.
router.get('/form-meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [employees] = await pool.query(
      `SELECT e.id, e.first_name, e.last_name, e.position_title FROM employees e ORDER BY e.id DESC`
    );
    // Active items only, as the shared item picker serves them for data entry.
    const [items] = await pool.query(
      `SELECT i.id, i.item_code, i.display_name, u.title AS base_unit_title, su.title AS stock_unit_title
         FROM inventories i
         LEFT JOIN units_of_measure u ON u.id = i.base_unit_id
         LEFT JOIN units_of_measure su ON su.id = i.stock_unit_id
        WHERE i.is_active = 1
        ORDER BY i.id DESC`
    );
    res.json({ employees, items });
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[row]] = await pool.query(
      `SELECT t.*, wf.location_name AS withdraw_from_name, tt.location_name AS transfer_to_name,
              jo.job_order_no, CONCAT(e.first_name, ' ', e.last_name) AS requestor_name,
              cu.display_name AS created_by_name, fu.display_name AS fulfilled_by_name
       FROM transfer_orders t
       LEFT JOIN locations wf ON wf.id = t.withdraw_from_location_id
       LEFT JOIN locations tt ON tt.id = t.transfer_to_location_id
       LEFT JOIN job_orders jo ON jo.id = t.job_order_id
       LEFT JOIN employees e ON e.id = t.requestor_id
       LEFT JOIN users cu ON cu.id = t.created_by_user_id
       LEFT JOIN users fu ON fu.id = t.fulfilled_by_user_id
       WHERE t.id = ?`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(`${LINE_SELECT} WHERE l.transfer_order_id = ? ORDER BY l.line_no`, [req.params.id]);
    res.json({ ...row, lines: await withLiveOnHand(pool, lines) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/item-fulfillments', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [fulfillments] = await pool.query(
      `SELECT f.*, u.display_name AS created_by_name FROM item_fulfillments f
       LEFT JOIN users u ON u.id = f.created_by_user_id
       WHERE f.transfer_order_id = ? ORDER BY f.id DESC`,
      [req.params.id]
    );
    for (const f of fulfillments) {
      const [lines] = await pool.query(
        `SELECT ifl.*, i.item_code, i.display_name AS item_name
         FROM item_fulfillment_lines ifl LEFT JOIN inventories i ON i.id = ifl.item_id
         WHERE ifl.item_fulfillment_id = ?`,
        [f.id]
      );
      f.lines = lines;
      f.status = lines.every((l) => Number(l.received || 0) >= Number(l.qty_fulfilled || 0)) ? 'CLOSED' : 'OPEN';
    }
    res.json(fulfillments);
  } catch (err) {
    next(err);
  }
});

// Item Fulfillment's own detail view -- reached from a Transfer Order's Related Records
// tab, or from the Receive picker. Qty On Hand here is the *destination's* (Transfer
// To's), not Withdraw From's, since this document's own numbers (Fulfill/Received) are
// about what's landed (or about to land) there -- matches how Item Receipt's view shows
// the identical figure for the same items.
router.get('/item-fulfillments/:fulfillmentId', requireAuth, requirePermission(FULFILLMENT_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[f]] = await pool.query(
      `SELECT f.*, u.display_name AS created_by_name,
              t.to_no, t.date_created AS to_date_created, t.transfer_to_location_id,
              wf.location_name AS withdraw_from_name, tt.location_name AS transfer_to_name,
              CONCAT(e.first_name, ' ', e.last_name) AS requestor_name
       FROM item_fulfillments f
       JOIN transfer_orders t ON t.id = f.transfer_order_id
       LEFT JOIN locations wf ON wf.id = t.withdraw_from_location_id
       LEFT JOIN locations tt ON tt.id = t.transfer_to_location_id
       LEFT JOIN employees e ON e.id = t.requestor_id
       LEFT JOIN users u ON u.id = f.created_by_user_id
       WHERE f.id = ?`,
      [req.params.fulfillmentId]
    );
    if (!f) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT ifl.*, tol.uom, tol.unit, i.item_code, i.display_name AS item_name, i.average_cost, i.asset_account_id, il.qty_on_hand
       FROM item_fulfillment_lines ifl
       LEFT JOIN transfer_order_lines tol ON tol.id = ifl.transfer_order_line_id
       LEFT JOIN inventories i ON i.id = ifl.item_id
       LEFT JOIN inventory_locations il ON il.inventory_id = ifl.item_id AND il.location_id = ?
       WHERE ifl.item_fulfillment_id = ?`,
      [f.transfer_to_location_id, req.params.fulfillmentId]
    );
    const status = lines.every((l) => Number(l.received || 0) >= Number(l.qty_fulfilled || 0)) ? 'CLOSED' : 'OPEN';
    const totalAmount = lines.reduce((s, l) => s + Number(l.qty_fulfilled) * Number(l.average_cost || 0), 0);
    const glImpact = await computeTransitGlImpact(lines, { qtyField: 'qty_fulfilled', assetIsDebit: false });

    res.json({ ...f, status, total_amount: totalAmount, gl_impact: glImpact, lines });
  } catch (err) {
    next(err);
  }
});

// Serves the Related Records panel on the Item Fulfillment view, so it is gated on the
// fulfillment's own can_view rather than the receipt's -- same reasoning as the TO panel above.
router.get('/item-fulfillments/:fulfillmentId/item-receipts', requireAuth, requirePermission(FULFILLMENT_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT r.*, u.display_name AS created_by_name FROM item_receipts r
       LEFT JOIN users u ON u.id = r.created_by_user_id
       WHERE r.item_fulfillment_id = ? ORDER BY r.id DESC`,
      [req.params.fulfillmentId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Item Receipt is the other half of the two-step stock move Item Fulfillment starts --
// saving one is what actually lands stock at Transfer To. Always raised against one
// specific Item Fulfillment batch (never the Transfer Order directly), since a line can
// be fulfilled across several batches and each is received independently.
router.post('/item-fulfillments/:fulfillmentId/item-receipts', requireAuth, requirePermission(RECEIPT_ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[f]] = await conn.query(
      `SELECT f.transfer_order_id, f.date_created, t.transfer_to_location_id, t.status FROM item_fulfillments f
       JOIN transfer_orders t ON t.id = f.transfer_order_id WHERE f.id = ?`,
      [req.params.fulfillmentId]
    );
    // Receiving lands stock at the destination -- block it if the fulfillment's period is shut.
    if (f) await assertPeriodOpen([f.date_created, req.body.date_created], 'non_gl', conn);
    if (!f) return res.status(404).json({ error: 'Not found' });
    if (f.status === 'cancelled') return res.status(409).json({ error: 'This transfer order has been cancelled.' });

    const { date_created: dateCreated, memo, lines } = req.body;
    const submitted = (Array.isArray(lines) ? lines : []).filter((l) => Number(l.qty_to_receive) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Enter a Qty to Receive for at least one item.' });

    const [ifLines] = await conn.query(
      `SELECT ifl.*, i.item_code, i.item_type FROM item_fulfillment_lines ifl
       LEFT JOIN inventories i ON i.id = ifl.item_id WHERE ifl.item_fulfillment_id = ?`,
      [req.params.fulfillmentId]
    );
    const byId = new Map(ifLines.map((l) => [l.id, l]));

    for (const s of submitted) {
      const line = byId.get(Number(s.item_fulfillment_line_id));
      if (!line) return res.status(400).json({ error: 'Unknown line.' });
      const remaining = Number(line.qty_fulfilled) - Number(line.received || 0);
      const qtyToReceive = Number(s.qty_to_receive);
      if (qtyToReceive > remaining) {
        return res.status(409).json({ error: `Qty to Receive for ${line.item_code} exceeds what's still outstanding on this fulfillment (${remaining}).` });
      }
    }

    await conn.beginTransaction();
    const { id: receiptId } = await insertNumbered(conn, {
      table: 'item_receipts',
      column: 'receipt_no',
      prefix: 'IR-',
      run: (no) => conn.query(
        `INSERT INTO item_receipts (receipt_no, transfer_order_id, item_fulfillment_id, date_created, memo, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [no, f.transfer_order_id, req.params.fulfillmentId, dateCreated || new Date().toISOString().slice(0, 10), memo || null, req.user.id]
      ),
    });

    for (const s of submitted) {
      const line = byId.get(Number(s.item_fulfillment_line_id));
      const qtyToReceive = Number(s.qty_to_receive);

      // Mirror of the fulfillment leg: a Service line lands no stock at Transfer To,
      // so don't create an inventory_locations row for it (this INSERT..ON DUPLICATE KEY
      // would otherwise conjure one from nothing).
      if (!isNonStockItem(line.item_type)) {
        await conn.query(
          `INSERT INTO inventory_locations (inventory_id, location_id, qty_on_hand)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE qty_on_hand = qty_on_hand + VALUES(qty_on_hand)`,
          [line.item_id, f.transfer_to_location_id, qtyToReceive]
        );
      }
      await conn.query('UPDATE item_fulfillment_lines SET received = received + ? WHERE id = ?', [qtyToReceive, line.id]);
      await conn.query('UPDATE transfer_order_lines SET received = received + ? WHERE id = ?', [qtyToReceive, line.transfer_order_line_id]);
      await conn.query(
        `INSERT INTO item_receipt_lines (item_receipt_id, transfer_order_line_id, item_fulfillment_line_id, item_id, qty_received, memo)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [receiptId, line.transfer_order_line_id, line.id, line.item_id, qtyToReceive, s.memo || null]
      );
    }

    const [freshLines] = await conn.query(
      'SELECT qty, adjusted_qty, fulfilled, received FROM transfer_order_lines WHERE transfer_order_id = ?',
      [f.transfer_order_id]
    );
    const newStatus = computeTOStatus(freshLines);
    await conn.query('UPDATE transfer_orders SET status = ?, updated_at = NOW() WHERE id = ?', [newStatus, f.transfer_order_id]);
    await logAudit(conn, { toId: f.transfer_order_id, userId: req.user.id, eventType: 'Status Change', fieldName: 'status', newValue: newStatus });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM item_receipts WHERE id = ?', [receiptId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Item Receipt's own detail view. "Fulfill"/"Received" on each line reflect the parent
// Item Fulfillment line's running totals (not just this one receipt's own qty), so the
// document reads as a status snapshot, not just a transaction amount -- matching how the
// real screen shows the exact same figures here as on the Item Fulfillment it closes.
router.get('/item-receipts/:receiptId', requireAuth, requirePermission(RECEIPT_ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[r]] = await pool.query(
      `SELECT r.*, u.display_name AS created_by_name,
              t.to_no, t.date_created AS to_date_created, t.transfer_to_location_id,
              wf.location_name AS withdraw_from_name, tt.location_name AS transfer_to_name,
              CONCAT(e.first_name, ' ', e.last_name) AS requestor_name,
              f.fulfillment_no, f.date_created AS if_date_created
       FROM item_receipts r
       JOIN transfer_orders t ON t.id = r.transfer_order_id
       JOIN item_fulfillments f ON f.id = r.item_fulfillment_id
       LEFT JOIN locations wf ON wf.id = t.withdraw_from_location_id
       LEFT JOIN locations tt ON tt.id = t.transfer_to_location_id
       LEFT JOIN employees e ON e.id = t.requestor_id
       LEFT JOIN users u ON u.id = r.created_by_user_id
       WHERE r.id = ?`,
      [req.params.receiptId]
    );
    if (!r) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT rl.item_id, rl.qty_received, rl.memo, tol.uom, tol.unit,
              i.item_code, i.display_name AS item_name, i.average_cost, i.asset_account_id,
              il.qty_on_hand, ifl.qty_fulfilled, ifl.received
       FROM item_receipt_lines rl
       LEFT JOIN transfer_order_lines tol ON tol.id = rl.transfer_order_line_id
       LEFT JOIN inventories i ON i.id = rl.item_id
       LEFT JOIN inventory_locations il ON il.inventory_id = rl.item_id AND il.location_id = ?
       LEFT JOIN item_fulfillment_lines ifl ON ifl.id = rl.item_fulfillment_line_id
       WHERE rl.item_receipt_id = ?`,
      [r.transfer_to_location_id, req.params.receiptId]
    );
    const totalAmount = lines.reduce((s, l) => s + Number(l.qty_received) * Number(l.average_cost || 0), 0);
    const glImpact = await computeTransitGlImpact(lines, { qtyField: 'qty_received', assetIsDebit: true });

    res.json({ ...r, total_amount: totalAmount, gl_impact: glImpact, lines });
  } catch (err) {
    next(err);
  }
});

// Reallocate is how a warehouse controller decides which of several *competing* pending
// Transfer Order lines -- all wanting the same item out of the same location -- actually
// gets a claim on the shared on-hand pool. Committed only ever moves through here, never
// through fulfillment itself (see POST /:id/item-fulfillments, which caps Qty to Fulfill
// at a line's own committed balance) -- so a freshly-raised TO sits at Committed 0,
// unfulfillable, until it's been reallocated some stock.
router.get('/lines/:lineId/reallocate', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[line]] = await pool.query(
      `SELECT tol.item_id, t.withdraw_from_location_id, i.item_type FROM transfer_order_lines tol
       JOIN transfer_orders t ON t.id = tol.transfer_order_id
       LEFT JOIN inventories i ON i.id = tol.item_id WHERE tol.id = ?`,
      [req.params.lineId]
    );
    if (!line) return res.status(404).json({ error: 'Not found' });
    if (isNonStockItem(line.item_type)) {
      return res.status(409).json({ error: 'This is a Service item -- it holds no stock, so there is nothing to reallocate. It can be fulfilled directly.' });
    }

    const [[item]] = await pool.query(
      `SELECT i.id, i.item_code, i.display_name, i.conversion_factor,
              su.title AS stock_unit_title, bu.title AS base_unit_title
         FROM inventories i
         LEFT JOIN units_of_measure su ON su.id = i.stock_unit_id
         LEFT JOIN units_of_measure bu ON bu.id = i.base_unit_id
        WHERE i.id = ?`,
      [line.item_id]
    );
    const [[location]] = await pool.query('SELECT id, location_name FROM locations WHERE id = ?', [line.withdraw_from_location_id]);
    // On Hand comes from the MOVEMENT LEDGER, not inventory_locations.
    //
    // That snapshot table holds 21 rows for 8,346 item/location pairs the ledger knows about, and
    // not one of them agrees with it. For this item at Warehouse - Central it read 160 while the
    // Bin Card showed 447.999 -- the 160 being whatever the last approved adjustment happened to
    // set it to. Reallocating against a figure the Bin Card contradicts is how someone commits
    // stock that is not there, or refuses to commit stock that is.
    //
    // deriveOnHand anchors exactly as the Bin Card does (the source system's Beginning Balance plus
    // the movements since), so this screen and that report cannot disagree.
    //
    // qty_committed is not in the ledger either (a commitment is a promise, not a movement); it is
    // summed from the candidate lines below.
    const onHandByPair = await deriveOnHand(pool, [line.item_id]);
    const qtyOnHandBase = Number(onHandByPair.get(`${line.item_id}|${line.withdraw_from_location_id}`) || 0);

    const [candidates] = await pool.query(
      `SELECT tol.id AS transfer_order_line_id, tol.qty, tol.adjusted_qty, tol.fulfilled, tol.committed, tol.uom, tol.unit,
              t.id AS to_id, t.to_no, t.date_created AS order_date, t.date_needed
       FROM transfer_order_lines tol
       JOIN transfer_orders t ON t.id = tol.transfer_order_id
       WHERE tol.item_id = ? AND t.withdraw_from_location_id = ? AND t.status IN (?)
       ORDER BY t.date_created ASC, t.id ASC`,
      [line.item_id, line.withdraw_from_location_id, OPEN_TO_STATUSES]
    );

    // Both figures are in BASE units; the conversion factor goes with them so the screen can show
    // the Stock Unit column as something other than a copy of the Base Unit one, which is what it
    // had been displaying.
    res.json({
      item, location,
      qty_on_hand: qtyOnHandBase,
      // The open lines' own commitments -- what Submit totals against on hand. The inventory_locations
      // snapshot has no row for most pairs, so it showed 0 committed beside three orders holding 3.
      qty_committed: Number(candidates.reduce((s, c) => s + Number(c.committed || 0), 0).toFixed(4)),
      conversion_factor: Number(item?.conversion_factor) || 1,
      stock_unit_title: item?.stock_unit_title || null,
      base_unit_title: item?.base_unit_title || null,
      triggering_line_id: Number(req.params.lineId),
      candidates,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/lines/:lineId/reallocate', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[line]] = await conn.query(
      `SELECT tol.item_id, t.date_created, t.withdraw_from_location_id, i.item_type FROM transfer_order_lines tol
       JOIN transfer_orders t ON t.id = tol.transfer_order_id
       LEFT JOIN inventories i ON i.id = tol.item_id WHERE tol.id = ?`,
      [req.params.lineId]
    );
    if (!line) return res.status(404).json({ error: 'Not found' });
    await assertPeriodOpen(line.date_created, 'non_gl', conn);
    if (isNonStockItem(line.item_type)) {
      return res.status(409).json({ error: 'This is a Service item -- it holds no stock, so there is nothing to reallocate. It can be fulfilled directly.' });
    }

    const submitted = (Array.isArray(req.body.lines) ? req.body.lines : []).filter((l) => l.transfer_order_line_id);
    if (!submitted.length) return res.status(400).json({ error: 'Select at least one order to commit qty to.' });

    // Every submitted line must genuinely belong to this same item+location pool --
    // otherwise stock earmarked for one item could get reassigned to an unrelated one.
    // Newest first: the order the release below takes stock back in.
    const [poolLines] = await conn.query(
      `SELECT tol.id, tol.qty, tol.adjusted_qty, tol.committed, tol.fulfilled, t.to_no FROM transfer_order_lines tol
       JOIN transfer_orders t ON t.id = tol.transfer_order_id
       WHERE tol.item_id = ? AND t.withdraw_from_location_id = ? AND t.status IN (?)
       ORDER BY t.date_created DESC, t.id DESC, tol.id DESC`,
      [line.item_id, line.withdraw_from_location_id, OPEN_TO_STATUSES]
    );
    const poolById = new Map(poolLines.map((l) => [l.id, l]));

    for (const s of submitted) {
      const target = poolById.get(Number(s.transfer_order_line_id));
      if (!target) return res.status(400).json({ error: 'One of the selected orders is no longer eligible.' });
      const committedQty = Number(s.committed);
      // Capped at what the line has LEFT to fulfil, not at what it originally ordered. Reserving
      // against the full ordered qty let stock be committed that could never be shipped: this
      // line ordered 3,817.0233 with 192 already gone, so a reservation of 3,626 sat 0.9767 above
      // the 3,625.0233 still outstanding and fulfilment refused it every time -- a dead end, since
      // Reallocate was the screen that had just accepted it.
      const cap = Number(target.adjusted_qty ?? target.qty) - Number(target.fulfilled || 0);
      if (!(committedQty >= 0) || committedQty > cap) {
        return res.status(409).json({ error: `Committed qty can't exceed what that order still has to fulfill (${cap}).` });
      }
    }

    // Derived from the ledger, exactly as the GET above derives the figure it SHOWS. When this
    // check read inventory_locations instead, the screen offered 3,756 square feet on hand and
    // then refused a commitment of 3,626 for exceeding 3,500 -- the stale snapshot -- which reads
    // as the form calling itself a liar. Whatever the user is shown has to be what they are held
    // to.
    const onHandByPair = await deriveOnHand(conn, [line.item_id]);
    const onHand = Number(onHandByPair.get(`${line.item_id}|${line.withdraw_from_location_id}`) || 0);

    const submittedById = new Map(submitted.map((s) => [Number(s.transfer_order_line_id), Number(s.committed)]));
    const round4 = (n) => Number(n.toFixed(4));
    // The ticked orders alone may not ask for more than is on hand -- nothing can be freed for that.
    const tickedTotal = round4([...submittedById.values()].reduce((s, q) => s + q, 0));
    if (tickedTotal > onHand) {
      return res.status(409).json({ error: `The ticked orders ask for ${tickedTotal}, more than is on hand at this location (${onHand}).` });
    }
    // Reallocating MOVES a commitment (asked 2026-10-05): what the ticked orders need beyond the stock
    // still free is taken back from the unticked orders holding it, newest order first, so the oldest
    // keep their place in line. Unticked orders are otherwise left as they are.
    let newTotal = round4(poolLines.reduce((s, l) => s + (submittedById.has(l.id) ? submittedById.get(l.id) : Number(l.committed || 0)), 0));
    const released = [];
    for (const l of poolLines) {
      if (newTotal <= onHand) break;
      if (submittedById.has(l.id) || !(Number(l.committed) > 0)) continue;
      const take = Math.min(Number(l.committed), round4(newTotal - onHand));
      released.push({ id: l.id, to_no: l.to_no, from: Number(l.committed), to: round4(Number(l.committed) - take) });
      newTotal = round4(newTotal - take);
    }

    await conn.beginTransaction();
    for (const [lineId, committedQty] of submittedById) {
      await conn.query('UPDATE transfer_order_lines SET committed = ? WHERE id = ?', [committedQty, lineId]);
    }
    for (const r of released) {
      await conn.query('UPDATE transfer_order_lines SET committed = ? WHERE id = ?', [r.to, r.id]);
    }
    await conn.query(
      `INSERT INTO inventory_locations (inventory_id, location_id, qty_committed)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE qty_committed = VALUES(qty_committed)`,
      [line.item_id, line.withdraw_from_location_id, newTotal]
    );
    await conn.commit();

    res.json({ ok: true, qty_committed: newTotal, released: released.map(({ to_no, from, to }) => ({ to_no, from, to })) });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'TransferOrder' AND a.auditable_id = ?
       ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// The next document number, taken from the numbers actually in use -- same shape as nextReworkNo
// in lib/reworkJobOrder.js.
//
// All three documents in this file used to be numbered <PREFIX>-<insertId>, which quietly assumes
// a row's number equals its row id. That is true of a database this app filled itself, and of no
// other. On production, 38,185 of 38,190 transfer orders, 40,994 of 41,001 fulfilments and 40,578
// of 40,584 receipts were imported carrying their original numbers while their ids were
// reassigned -- so TO-38206 belongs to row 23463. Once AUTO_INCREMENT climbed into the range those
// imported numbers occupy, every create became a coin toss, and "Duplicate entry 'TO-38206' for
// key 'transfer_orders.to_no'" is that coin landing badly. Fulfilments and receipts were the same
// bug a few hundred rows behind: their next ids were already inside their used ranges.
// Read on the POOL, not on the caller's connection, and deliberately so.
//
// The caller is inside a transaction, and InnoDB's default REPEATABLE READ pins that transaction
// to the snapshot of its first read. So when two creates race, the loser's retry re-reads its own
// stale snapshot, cannot see the row the winner just committed, computes the same number again,
// and fails on every attempt. A separate autocommit connection sees the current committed state,
// which is what "the next free number" has to mean.
// Both helpers now live in lib/docNumber.js. Purchase orders turned out to have exactly this
// collision -- PO-19571 held by row 438, with 498 more queued behind it -- so the fix is shared
// rather than copied a second time.

// Insert a row whose document number has to be unique, and write that number in the INSERT
// itself.
//
// The old two-step inserted '' and then UPDATEd the number in. These columns are UNIQUE, so two
// people creating at the same moment collided on the empty string before either had a number at
// all. Reading the maximum and inserting still is not atomic, so a clash is retried rather than
// prevented: the loser simply takes the next number. A duplicate-key error does not abort a MySQL
// transaction, so the retry is safe inside the caller's.

// Creates the TO header plus one line per material passed in `lines` -- this is how the
// Production module's "Create TO" button (only shown when a Job Order has short
// materials) pre-fills the form with exactly the items that are actually short, in one
// request, rather than requiring the user to add each line by hand afterward.
router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const {
      date_created: dateCreated, date_needed: dateNeeded,
      withdraw_from_location_id: withdrawFromId, transfer_to_location_id: transferToId,
      requestor_id: requestorId, job_order_id: jobOrderId, memo, lines,
    } = req.body;
    if (!withdrawFromId || !transferToId) {
      return res.status(400).json({ error: 'Withdraw From and Transfer To locations are required.' });
    }
    await assertPeriodOpen(dateCreated, 'non_gl', conn);

    // The Requestor is the person raising it unless the form says otherwise -- the form defaults
    // it the same way, this covers a caller that leaves it out.
    let requestor = requestorId || null;
    if (!requestor) {
      const [[me]] = await conn.query('SELECT employee_id FROM users WHERE id = ?', [req.user.id]);
      requestor = me?.employee_id || null;
    }

    await conn.beginTransaction();

    const { id: toId, no: toNo } = await insertNumbered(conn, {
      table: 'transfer_orders',
      column: 'to_no',
      prefix: 'TO-',
      run: (no) => conn.query(
        `INSERT INTO transfer_orders
           (to_no, date_created, date_needed, withdraw_from_location_id, transfer_to_location_id, requestor_id, job_order_id, memo, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [no, dateCreated || new Date().toISOString().slice(0, 10), dateNeeded || null, withdrawFromId, transferToId, requestor, jobOrderId || null, memo || null, req.user.id]
      ),
    });
    await logAudit(conn, { toId, userId: req.user.id, eventType: 'Created', fieldName: 'to_no', newValue: toNo });

    // The stored qty_on_hand is a creation-time record in Base Unit, taken from the Bin Card
    // figure rather than the inventory_locations table it used to copy.
    const lineList = Array.isArray(lines) ? lines : [];
    const onHandAtCreate = await deriveOnHand(conn, lineList.map((l) => l.item_id).filter(Boolean));
    let lineNo = 1;
    for (const line of lineList) {
      if (!line.item_id || !line.qty) continue;
      const stock = { qty_on_hand: onHandAtCreate.get(`${line.item_id}|${withdrawFromId}`) };
      const [[{ toCount }]] = await conn.query(
        'SELECT COUNT(*) + 1 AS toCount FROM transfer_order_lines WHERE job_order_process_id = ?',
        [line.job_order_process_id || 0]
      );
      // Unit Used, when the Add form chose one, is resolved exactly as POST /:id/lines does it, so a
      // material added before the first save ends up the same as one added after.
      const unitUsed = line.unit_used == null || line.unit_used === '' ? null : normaliseUnitUsed(line.unit_used);
      const unitTitle = unitUsed ? await unitTitleFor(conn, line.item_id, unitUsed) : (line.unit || null);
      await conn.query(
        `INSERT INTO transfer_order_lines
           (transfer_order_id, line_no, item_id, job_order_id, job_order_process_id, to_count, qty, uom, unit, unit_used, back_ordered, committed, qty_on_hand, memo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          toId, lineNo++, line.item_id, jobOrderId || null, line.job_order_process_id || null,
          line.job_order_process_id ? toCount : 1, line.qty, line.uom || null, unitTitle, unitUsed,
          line.back_ordered || 0, line.committed || 0, Number(stock?.qty_on_hand || 0), line.memo || null,
        ]
      );
    }
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM transfer_orders WHERE id = ?', [toId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Editing a TO's header and materials: can_edit on Transfer Orders, OR the person who created it
// (with can_add) while nothing is fulfilled yet. Raising a TO includes filling in its materials --
// without this, someone who may create TOs but not edit others' (Joel Taboada, 2026-10-01) could
// save the header but never add a single material to it.
// Editing a Transfer Order -- its header and its lines -- is a System Admin's alone, at any status
// (asked 2026-10-19; until then Can Edit, or its creator, edited one still Pending Fulfillment).
// ...except its own requestor (2026-10-19): the person who raised it, or the employee named as its
// Requestor, may edit it while it is still Pending Fulfillment -- nothing has moved yet.
async function isOwnPendingTo(userId, toId) {
  const [[t]] = await pool.query('SELECT created_by_user_id, requestor_id, status FROM transfer_orders WHERE id = ?', [toId]);
  if (!t || t.status !== 'pending_fulfillment') return false;
  if (Number(t.created_by_user_id) === Number(userId)) return true;
  if (!t.requestor_id) return false;
  const [[u]] = await pool.query('SELECT employee_id FROM users WHERE id = ?', [userId]);
  return !!u?.employee_id && Number(u.employee_id) === Number(t.requestor_id);
}
async function requireToEdit(req, res, next) {
  try {
    if (await isSystemAdmin(req.user.id)) return next();
    if (await userCan(req.user.id, ROUTE, 'can_view') && await isOwnPendingTo(req.user.id, req.params.id)) return next();
    return res.status(403).json({ error: 'Only a System Admin can edit a transfer order -- or its requestor, while it is still Pending Fulfillment.' });
  } catch (err) { return next(err); }
}

// The warehouse's two fields on a line -- Unit Used and Adjusted Qty -- are part of fulfilling, not
// editing the order (2026-10-19: Jumar Gidacan lost them when editing went System Admin only). Anyone
// with Can Edit on Transfer Orders or Can Add on Item Fulfillments may change those two, and only
// those, while it is still Pending Fulfillment -- once anything is fulfilled, a System Admin only.
const WAREHOUSE_LINE_FIELDS = ['unit_used', 'adjusted_qty'];
async function requireToLineEdit(req, res, next) {
  try {
    if (await isSystemAdmin(req.user.id)) return next();
    // Its requestor, while Pending Fulfillment, edits any field of its lines (requireToEdit).
    if (await userCan(req.user.id, ROUTE, 'can_view') && await isOwnPendingTo(req.user.id, req.params.id)) return next();
    const keys = Object.keys(req.body || {}).filter((k) => req.body[k] !== undefined);
    const warehouseOnly = keys.length > 0 && keys.every((k) => WAREHOUSE_LINE_FIELDS.includes(k));
    if (warehouseOnly && (await userCan(req.user.id, ROUTE, 'can_edit') || await userCan(req.user.id, FULFILLMENT_ROUTE, 'can_add'))) {
      const [[t]] = await pool.query('SELECT status FROM transfer_orders WHERE id = ?', [req.params.id]);
      if (t && t.status === 'pending_fulfillment') return next();
      return res.status(409).json({ error: 'This transfer order has been fulfilled already -- only a System Admin can change it now.' });
    }
    return res.status(403).json({ error: 'Only a System Admin can edit a transfer order -- Unit Used and Adjusted Qty excepted.' });
  } catch (err) { return next(err); }
}

router.put('/:id', requireAuth, requireToEdit, async (req, res, next) => {
  try {
    const [[t]] = await pool.query('SELECT status, date_created, withdraw_from_location_id, transfer_to_location_id FROM transfer_orders WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Not found' });

    const {
      date_created: dateCreated, date_needed: dateNeeded,
      withdraw_from_location_id: withdrawFromId, transfer_to_location_id: transferToId,
      requestor_id: requestorId, memo,
    } = req.body;
    // Once anything is fulfilled the stock has moved out of Withdraw From toward Transfer To, so the
    // two locations stay as they are; a System Admin edits the rest.
    if (t.status !== 'pending_fulfillment'
      && (Number(withdrawFromId) !== Number(t.withdraw_from_location_id) || Number(transferToId) !== Number(t.transfer_to_location_id))) {
      return res.status(409).json({ error: 'Withdraw From and Transfer To cannot change once the transfer order has been fulfilled.' });
    }
    // Both dates: you can't edit out of a closed period, nor move a document into one.
    await assertPeriodOpen([t.date_created, dateCreated], 'non_gl');
    await pool.query(
      `UPDATE transfer_orders SET date_created = ?, date_needed = ?, withdraw_from_location_id = ?,
              transfer_to_location_id = ?, requestor_id = ?, memo = ?, updated_at = NOW() WHERE id = ?`,
      [dateCreated, dateNeeded || null, withdrawFromId, transferToId, requestorId || null, memo || null, req.params.id]
    );
    const [[row]] = await pool.query('SELECT * FROM transfer_orders WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/lines', requireAuth, requireToEdit, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[t]] = await conn.query('SELECT status, date_created, withdraw_from_location_id, job_order_id FROM transfer_orders WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Not found' });
    await assertPeriodOpen(t.date_created, 'non_gl', conn);

    const { item_id: itemId, qty, uom, unit, unit_used: unitUsedIn, memo } = req.body;
    if (!itemId || !qty) return res.status(400).json({ error: 'Item and Qty are required.' });

    await conn.beginTransaction();
    // Only stored when the caller actually chose one. Left NULL the line keeps whatever unit it
    // was added with (Add Material sends the base unit) and the screen resolves the dropdown from
    // that -- see UNIT_USED_RESOLVED.
    const unitUsed = unitUsedIn == null || unitUsedIn === '' ? null : normaliseUnitUsed(unitUsedIn);
    const unitTitle = unitUsed ? await unitTitleFor(conn, itemId, unitUsed) : (unit || null);
    const onHandAtAdd = await deriveOnHand(conn, [itemId]);
    const stock = { qty_on_hand: onHandAtAdd.get(`${itemId}|${t.withdraw_from_location_id}`) };
    const [[{ nextLine }]] = await conn.query(
      'SELECT COALESCE(MAX(line_no), 0) + 1 AS nextLine FROM transfer_order_lines WHERE transfer_order_id = ?',
      [req.params.id]
    );
    const [result] = await conn.query(
      `INSERT INTO transfer_order_lines (transfer_order_id, line_no, item_id, job_order_id, qty, uom, unit, unit_used, qty_on_hand, memo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.params.id, nextLine, itemId, t.job_order_id, qty, uom || null, unitTitle, unitUsed, Number(stock?.qty_on_hand || 0), memo || null]
    );
    await conn.commit();

    const [[row]] = await pool.query(`${LINE_SELECT} WHERE l.id = ?`, [result.insertId]);
    await withLiveOnHand(pool, [row]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id/lines/:lineId', requireAuth, requireToLineEdit, async (req, res, next) => {
  try {
    const [[t]] = await pool.query('SELECT status, date_created FROM transfer_orders WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Not found' });
    await assertPeriodOpen(t.date_created, 'non_gl');

    const [[line]] = await pool.query(
      'SELECT item_id, qty, adjusted_qty, unit, unit_used, memo, fulfilled FROM transfer_order_lines WHERE id = ? AND transfer_order_id = ?',
      [req.params.lineId, req.params.id]
    );
    if (!line) return res.status(404).json({ error: 'Line not found' });

    // Only fields actually present in the request change; everything else keeps what is stored.
    // The screens commit one field at a time -- Unit Used fires on change, Qty and Memo on blur --
    // so treating an absent field as "reset it" let a Unit Used pick a moment earlier be wiped by
    // the blur that followed it. Same reasoning as inventoryAdjustments.js's PUT.
    const has = (k) => req.body[k] !== undefined;
    const qty = has('qty') ? req.body.qty : line.qty;
    const adjustedQty = has('adjusted_qty')
      ? (req.body.adjusted_qty === '' || req.body.adjusted_qty === null ? null : req.body.adjusted_qty)
      : line.adjusted_qty;
    const memo = has('memo') ? (req.body.memo || null) : line.memo;
    // What has already been fulfilled off this line cannot be un-asked for.
    const target = adjustedQty != null && adjustedQty !== '' ? Number(adjustedQty) : Number(qty);
    if (Number(line.fulfilled || 0) > 0 && target < Number(line.fulfilled) - 1e-9) {
      return res.status(409).json({ error: `This line has ${Number(line.fulfilled)} fulfilled already; its quantity cannot go below that.` });
    }

    // Picking a unit is what rewrites `unit`; it is never recomputed from a stored unit_used,
    // so the 65,933 lines that predate the toggle keep the unit they were migrated with even
    // while some other field on them is edited.
    let unitUsed = line.unit_used;
    let unit = line.unit;
    if (has('unit_used') && req.body.unit_used !== null && req.body.unit_used !== '') {
      unitUsed = normaliseUnitUsed(req.body.unit_used);
      unit = (await unitTitleFor(pool, line.item_id, unitUsed)) ?? line.unit;
    }

    await pool.query(
      'UPDATE transfer_order_lines SET qty = ?, adjusted_qty = ?, memo = ?, unit = ?, unit_used = ? WHERE id = ? AND transfer_order_id = ?',
      [qty, adjustedQty, memo, unit, unitUsed, req.params.lineId, req.params.id]
    );
    const [[row]] = await pool.query(`${LINE_SELECT} WHERE l.id = ?`, [req.params.lineId]);
    if (!row) return res.status(404).json({ error: 'Line not found' });
    await withLiveOnHand(pool, [row]);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/lines/:lineId', requireAuth, requireToEdit, async (req, res, next) => {
  try {
    const [[t]] = await pool.query('SELECT status, date_created FROM transfer_orders WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Not found' });
    await assertPeriodOpen(t.date_created, 'non_gl');

    const [[dl]] = await pool.query('SELECT fulfilled FROM transfer_order_lines WHERE id = ? AND transfer_order_id = ?', [req.params.lineId, req.params.id]);
    if (dl && Number(dl.fulfilled || 0) > 0) return res.status(409).json({ error: 'This line has already been fulfilled, so it cannot be removed.' });
    await pool.query('DELETE FROM transfer_order_lines WHERE id = ? AND transfer_order_id = ?', [req.params.lineId, req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Item Fulfillment is its own transaction, raised against a Transfer Order -- mirrors
// the real system's two-step stock move: saving this only pulls stock out of Withdraw
// From, right now. Landing it at Transfer To is a separate later step (Item Receipt)
// that this build doesn't model, so nothing here ever touches the destination's
// qty_on_hand. Each line can be partially fulfilled across multiple Item Fulfillment
// transactions -- `fulfilled` is a running total capped at that line's own qty (or
// Adjusted Qty, if the requestor tweaked it). The Transfer Order only flips to
// "fulfilled" once every line's running total has caught all the way up.
router.post('/:id/item-fulfillments', requireAuth, requirePermission(FULFILLMENT_ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[t]] = await conn.query(
      'SELECT status, withdraw_from_location_id FROM transfer_orders WHERE id = ?',
      [req.params.id]
    );
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (!OPEN_TO_STATUSES.includes(t.status)) return res.status(409).json({ error: 'This transfer order has nothing left to fulfill.' });

    const { date_created: dateCreated, memo, lines } = req.body;
    const submitted = (Array.isArray(lines) ? lines : []).filter((l) => Number(l.qty_to_fulfill) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Enter a Qty to Fulfill for at least one item.' });
    // Fulfilling releases stock from the source location.
    await assertPeriodOpen(dateCreated, 'non_gl', conn);

    const [toLines] = await conn.query(
      `SELECT tol.*, i.item_code, i.item_type FROM transfer_order_lines tol
       LEFT JOIN inventories i ON i.id = tol.item_id WHERE tol.transfer_order_id = ?`,
      [req.params.id]
    );
    const byId = new Map(toLines.map((l) => [l.id, l]));

    // Validate everything before writing anything -- same discipline as Assembly Build.
    for (const s of submitted) {
      const line = byId.get(Number(s.transfer_order_line_id));
      if (!line) return res.status(400).json({ error: 'Unknown line.' });
      const target = Number(line.adjusted_qty ?? line.qty);
      const remaining = target - Number(line.fulfilled || 0);
      const qtyToFulfill = Number(s.qty_to_fulfill);
      if (qtyToFulfill > remaining) {
        return res.status(409).json({ error: `Qty to Fulfill for ${line.item_code} exceeds the remaining balance (${remaining}).` });
      }
      // Both remaining gates below are about physical stock, so neither applies to a
      // Service line -- there is no material to reserve and none to draw down, so its
      // only real limit is the remaining balance checked above. Gating it on Committed
      // would strand it forever: Reallocate hands out a location's on-hand pool, and a
      // Service item has no on-hand anywhere to hand out. See lib/itemTypes.js.
      if (isNonStockItem(line.item_type)) continue;

      // Committed, not raw on-hand, is what actually gates fulfillment -- it's this
      // line's reserved share of a pool that other pending Transfer Order lines may
      // also be claiming (see /lines/:lineId/reallocate). A freshly-raised line sits at
      // Committed 0 until someone reallocates stock to it.
      // `committed` is what is still reserved and unshipped -- it is decremented as each
      // fulfilment goes out -- so it IS the cap, with no further subtraction. Taking
      // `committed - fulfilled` double-counted any reservation made after a partial shipment:
      // TO-38243's acrylic was ordered 1,965.2871, shipped 192, then re-reserved at 1,773.2871
      // (the remainder), and the old arithmetic offered only 1,581.2871 of it.
      //
      // Over-fulfilment is still impossible: the ordered-balance gate above caps this at
      // qty - fulfilled regardless of what `committed` says, which also covers legacy rows left
      // holding a reservation that was never decremented.
      const committedRemaining = Number(line.committed || 0);
      if (qtyToFulfill > committedRemaining) {
        return res.status(409).json({ error: `Qty to Fulfill for ${line.item_code} exceeds its committed qty (${committedRemaining} available) -- reallocate stock to this order first.` });
      }
      // From the ledger, because Reallocate now hands out commitments against the ledger figure.
      // Left on inventory_locations this gate would have contradicted the one before it: stock
      // could be committed to a line up to the real balance and then refused at fulfilment for
      // exceeding the stale snapshot, with no way forward from either screen.
      const onHandByPair = await deriveOnHand(conn, [line.item_id]);
      const available = Number(onHandByPair.get(`${line.item_id}|${t.withdraw_from_location_id}`) || 0);
      if (qtyToFulfill > available) {
        return res.status(409).json({ error: `Qty to Fulfill for ${line.item_code} exceeds what's on hand at the withdraw-from location (${available}).` });
      }
    }

    await conn.beginTransaction();
    const { id: fulfillmentId, no: fulfillmentNo } = await insertNumbered(conn, {
      table: 'item_fulfillments',
      column: 'fulfillment_no',
      prefix: 'IF-',
      run: (no) => conn.query(
        `INSERT INTO item_fulfillments (fulfillment_no, transfer_order_id, date_created, memo, created_by_user_id)
         VALUES (?, ?, ?, ?, ?)`,
        [no, req.params.id, dateCreated || new Date().toISOString().slice(0, 10), memo || null, req.user.id]
      ),
    });

    for (const s of submitted) {
      const line = byId.get(Number(s.transfer_order_line_id));
      const qtyToFulfill = Number(s.qty_to_fulfill);

      // A Service line still records what was fulfilled, but moves no stock -- there is
      // no qty_on_hand row to draw down, and creating one would invent a stock balance
      // for something that was never physical.
      if (!isNonStockItem(line.item_type)) {
        await conn.query(
          'UPDATE inventory_locations SET qty_on_hand = qty_on_hand - ? WHERE inventory_id = ? AND location_id = ?',
          [qtyToFulfill, line.item_id, t.withdraw_from_location_id]
        );
        // Shipping a reservation CONSUMES it, so the location's reserved pool frees up by the
        // same amount. Without this the pool stayed reserved against stock that had already
        // left the building, and every later reallocation of that item started from an
        // overstated committed figure.
        await conn.query(
          `UPDATE inventory_locations SET qty_committed = GREATEST(COALESCE(qty_committed, 0) - ?, 0)
            WHERE inventory_id = ? AND location_id = ?`,
          [qtyToFulfill, line.item_id, t.withdraw_from_location_id]
        );
      }
      // committed comes DOWN as fulfilled goes up: it is the quantity still reserved and not yet
      // shipped, which is what "Committed" means on the Transfer Order and on Reallocate Items.
      // It used to be left alone, so a line that had been fully shipped still showed its original
      // reservation and the fulfilment cap had to subtract `fulfilled` from it -- which then
      // under-counted any reservation made AFTER a partial shipment, because that figure was
      // already net of it. GREATEST keeps a legacy row that was never decremented from going
      // negative.
      await conn.query(
        'UPDATE transfer_order_lines SET fulfilled = fulfilled + ?, committed = GREATEST(committed - ?, 0) WHERE id = ?',
        [qtyToFulfill, qtyToFulfill, line.id]
      );
      await conn.query(
        `INSERT INTO item_fulfillment_lines (item_fulfillment_id, transfer_order_line_id, item_id, qty_fulfilled, memo)
         VALUES (?, ?, ?, ?, ?)`,
        [fulfillmentId, line.id, line.item_id, qtyToFulfill, s.memo || null]
      );
    }

    const [freshLines] = await conn.query(
      'SELECT qty, adjusted_qty, fulfilled, received FROM transfer_order_lines WHERE transfer_order_id = ?',
      [req.params.id]
    );
    const newStatus = computeTOStatus(freshLines);
    await conn.query(
      'UPDATE transfer_orders SET status = ?, fulfilled_by_user_id = ?, fulfilled_at = NOW(), updated_at = NOW() WHERE id = ?',
      [newStatus, req.user.id, req.params.id]
    );
    await logAudit(conn, { toId: req.params.id, userId: req.user.id, eventType: 'Status Change', fieldName: 'status', newValue: newStatus });
    await logAudit(conn, { toId: req.params.id, userId: req.user.id, eventType: 'Created', fieldName: 'fulfillment_no', newValue: fulfillmentNo });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM item_fulfillments WHERE id = ?', [fulfillmentId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Cancelling (2026-10-19): a TO not yet fulfilled or only partially fulfilled (CANCELLABLE_TO_STATUSES),
// by whoever raised it -- everyone may cancel their own -- anyone with Can Edit on Transfer Orders, or
// a System Admin. Fully fulfilled, received or cancelled: no.
router.put('/:id/cancel', requireAuth, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[t]] = await conn.query('SELECT status, date_created, created_by_user_id FROM transfer_orders WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Not found' });
    // Cancellable while nothing, or only part, has been fulfilled (asked 2026-10-19) -- by the person
    // who raised it, anyone with Can Edit, or a System Admin. Fully fulfilled, received or already
    // cancelled: no.
    if (!CANCELLABLE_TO_STATUSES.includes(t.status)) {
      const why = { pending_receipt: 'fully fulfilled', received: 'received', cancelled: 'cancelled' }[t.status] || t.status;
      return res.status(409).json({ error: `This transfer order is already ${why} -- only one not yet fulfilled, or partially fulfilled, can be cancelled.` });
    }
    const own = Number(t.created_by_user_id) === Number(req.user.id);
    if (!own && !(await userCan(req.user.id, ROUTE, 'can_edit')) && !(await isSystemAdmin(req.user.id))) {
      return res.status(403).json({ error: 'Only the person who raised this transfer order, or someone with Can Edit, can cancel it.' });
    }
    await assertPeriodOpen(t.date_created, 'non_gl', conn);

    await conn.beginTransaction();
    await conn.query("UPDATE transfer_orders SET status = 'cancelled', updated_at = NOW() WHERE id = ?", [req.params.id]);
    await logAudit(conn, { toId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: t.status, newValue: 'cancelled' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM transfer_orders WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[t]] = await conn.query('SELECT status, date_created FROM transfer_orders WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Not found' });
    await assertPeriodOpen(t.date_created, 'non_gl', conn);
    // Once anything's actually been fulfilled/received, deleting the TO would orphan
    // real stock-moving Item Fulfillment/Receipt records -- only a completely untouched
    // order can be hard-deleted; anything further along should be Cancelled instead.
    if (t.status !== 'pending_fulfillment') {
      return res.status(409).json({ error: 'Only a transfer order with nothing fulfilled yet can be deleted -- cancel it instead.' });
    }

    await conn.beginTransaction();
    await conn.query('DELETE FROM transfer_order_lines WHERE transfer_order_id = ?', [req.params.id]);
    await conn.query('DELETE FROM transfer_orders WHERE id = ?', [req.params.id]);
    await conn.commit();
    res.status(204).send();
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
