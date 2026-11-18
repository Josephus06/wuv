const { movementsSql, movementParams } = require('./stockLedger');
// Every transaction in this app that moves stock, as one uniform movement stream.
//
// WHY THIS EXISTS. The Stock Ledger used to be served verbatim from `live_stock_ledger`, a
// frozen snapshot of live's own report for one fixed window (2026-01-01..2026-07-28). Nothing
// this app does ever reached it, so a receiving report entered here -- or migrated here --
// simply never appeared, and the on-screen date filter was decorative. This module is the
// movement history the report was missing.
//
// WHICH DOCUMENTS MOVE STOCK, and which conspicuously do not:
//
//   IN   Receiving Report    purchase_order_receipt_lines   location on the line
//   IN   Item Receipt        item_receipt_lines             location = the transfer order's destination
//   OUT  Item Fulfillment    item_fulfillment_lines         location = the transfer order's source
//   OUT  Purchase Return     purchase_return_lines          location on the line
//   OUT  Assembly Build      assembly_build_lines           materials consumed by production
//   BOTH Inventory Adjustment inventory_adjustment_lines    sign of adjust_qty_by decides
//
//   NOT  Item Delivery       item_delivery_lines carries job_order_id and qty_delivered and no
//                            item at all -- a delivery ships a finished job order to a customer,
//                            it does not draw an inventory item. It is not a stock movement and
//                            is deliberately absent here.
//
// STATUS. Only approved adjustments and completed builds move stock; cancelled and pending ones
// are excluded. Receipts, fulfillments and returns carry no status column -- their existence is
// the posting.
//
// VALUE. Only some sources state an amount (ext_price on receipt and return lines, est_unit_cost
// on adjustment lines, material_cost on build lines). Transfers state none. Rather than invent a
// cost, unvalued movements are counted separately in `qty_unvalued` so the caller can price them
// at the item's average cost and stay honest about which figures are derived.
const NON_STOCK_TYPES = ['Service', 'Non-Inventory', 'Landed Cost', 'Discount'];

// The window `live_stock_ledger` was imported for. Its beg_qty is the opening balance as of this
// date and already contains every movement before it, so the computed ledger only ever adds
// movements from here forward -- counting anything earlier would double them.
//
// Read from the snapshot itself, not fixed: at the T1S cut-over the snapshot is re-imported as the
// source's position at the close of 2026-09-30 (import-stock-ledger.js --from=2026-10-01), and the
// anchor has to move with it. live_stock_ledger.window_from records the date it was imported for,
// and the table replicates to the office box, so both servers follow a re-import with no setting
// to change. SNAPSHOT_FROM is only the fallback when the table has no window_from yet.
const SNAPSHOT_FROM = '2026-01-01';
async function snapshotFrom(q) {
  try {
    const [[r]] = await q.query("SELECT DATE_FORMAT(MIN(window_from), '%Y-%m-%d') AS d FROM live_stock_ledger");
    return (r && r.d) || SNAPSHOT_FROM;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') return SNAPSHOT_FROM;
    throw e;
  }
}

// One SELECT per source. `?` placeholders are the shared filter, appended identically to each so
// the union stays a single parameterised statement.
const SOURCES = [
  {
    key: 'receiving_report',
    label: 'Receiving Report',
    sql: `
      SELECT rl.item_id, rl.location_id, r.date_created AS move_date, 'in' AS direction,
             rl.qty_received AS qty, rl.ext_price AS value,
             'Receiving Report' AS source, r.receipt_no AS doc_no, r.id AS doc_id
        FROM purchase_order_receipt_lines rl
        JOIN purchase_order_receipts r ON r.id = rl.purchase_order_receipt_id
       WHERE rl.qty_received <> 0`,
  },
  {
    key: 'item_receipt',
    label: 'Item Receipt',
    sql: `
      SELECT irl.item_id, t.transfer_to_location_id AS location_id, ir.date_created AS move_date,
             'in' AS direction, irl.qty_received AS qty, NULL AS value,
             'Item Receipt' AS source, ir.receipt_no AS doc_no, ir.id AS doc_id
        FROM item_receipt_lines irl
        JOIN item_receipts ir ON ir.id = irl.item_receipt_id
        JOIN transfer_order_lines tl ON tl.id = irl.transfer_order_line_id
        JOIN transfer_orders t ON t.id = tl.transfer_order_id
       WHERE irl.qty_received <> 0`,
  },
  {
    key: 'item_fulfillment',
    label: 'Item Fulfillment',
    sql: `
      SELECT ifl.item_id, t.withdraw_from_location_id AS location_id, f.date_created AS move_date,
             'out' AS direction, ifl.qty_fulfilled AS qty, NULL AS value,
             'Item Fulfillment' AS source, f.fulfillment_no AS doc_no, f.id AS doc_id
        FROM item_fulfillment_lines ifl
        JOIN item_fulfillments f ON f.id = ifl.item_fulfillment_id
        JOIN transfer_order_lines tl ON tl.id = ifl.transfer_order_line_id
        JOIN transfer_orders t ON t.id = tl.transfer_order_id
       WHERE ifl.qty_fulfilled <> 0`,
  },
  {
    key: 'purchase_return',
    label: 'Purchase Return',
    sql: `
      SELECT pl.item_id, pl.location_id, p.date_created AS move_date, 'out' AS direction,
             pl.qty_returned AS qty, pl.ext_price AS value,
             'Purchase Return' AS source, p.return_no AS doc_no, p.id AS doc_id
        FROM purchase_return_lines pl
        JOIN purchase_returns p ON p.id = pl.purchase_return_id
       WHERE pl.qty_returned <> 0`,
  },
  {
    key: 'adjustment',
    label: 'Inventory Adjustment',
    sql: `
      SELECT al.item_id, al.location_id, a.date_created AS move_date,
             IF(al.adjust_qty_by >= 0, 'in', 'out') AS direction, ABS(al.adjust_qty_by) AS qty,
             ABS(al.adjust_qty_by * COALESCE(al.est_unit_cost, 0)) AS value,
             'Inventory Adjustment' AS source, a.adjustment_no AS doc_no, a.id AS doc_id
        FROM inventory_adjustment_lines al
        JOIN inventory_adjustments a ON a.id = al.inventory_adjustment_id
       WHERE al.adjust_qty_by <> 0 AND a.status = 'approved'`,
  },
  {
    key: 'assembly_build',
    label: 'Assembly Build',
    sql: `
      SELECT bl.item_id, bl.location_id, b.date_created AS move_date, 'out' AS direction,
             bl.qty AS qty, bl.material_cost AS value,
             'Assembly Build' AS source, b.ab_no AS doc_no, b.id AS doc_id
        FROM assembly_build_lines bl
        JOIN assembly_builds b ON b.id = bl.assembly_build_id
       WHERE bl.qty <> 0 AND b.status = 'completed' AND b.cancelled_at IS NULL`,
  },
];

// Builds the movement stream as a single subquery. `filters` narrows it:
//   { itemId, locationId, from, to }  -- from/to are inclusive dates.
// Returns { sql, params } ready to drop into a CTE or FROM clause.
//
// THE BIN CARD'S MOVEMENTS (2026-11-13). This used to union SOURCES above -- a second copy of what
// counts as a stock movement -- and the two disagreed: as of 31 Oct, ACRYLIC CLEAR 4.5 MM 4'X8' at
// Warehouse - CNC read 32.5 SHT here against 0.7443 SHT on its Bin Card. This copy took an Item
// Receipt's 32 (square feet, its line's unit) as 32 sheets, never converting the unit, and counted
// only Assembly Builds whose status is 'completed' -- every build made in this app is 'saved', so
// none of October's production left the shelf here. Now both reports read lib/stockLedger.js
// movementsSql -- each line brought to the Base Unit by its own unit -- and this turns it back into
// the Stock Unit the ledger reports in (÷ conversion factor), so the two reports cannot drift again.
// SOURCES stays as the list of labels only.
//
// A movement's value is its stock quantity x the rate it carries (a receipt's price, a transfer's
// average cost); one with no rate -- an Assembly Build -- is priced at the item's average cost by
// shapeLedgerRow, as before.
function movementsQuery(filters = {}) {
  const { itemId, locationId, from, to } = filters;
  const base = itemId ? movementsSql(true) : movementsSql();
  const params = itemId ? movementParams([Number(itemId)]) : [];
  const where = ['(m.qty_in <> 0 OR m.qty_out <> 0)'];
  if (locationId) { where.push('COALESCE(m.to_location_id, m.from_location_id) = ?'); params.push(Number(locationId)); }
  if (from) { where.push('m.trans_date >= ?'); params.push(from); }
  if (to) { where.push('m.trans_date <= ?'); params.push(to); }
  const sql = `
      SELECT m.item_id, COALESCE(m.to_location_id, m.from_location_id) AS location_id, m.trans_date AS move_date,
             IF(m.qty_in <> 0, 'in', 'out') AS direction,
             (m.qty_in + m.qty_out) / COALESCE(NULLIF(mi.conversion_factor, 0), 1) AS qty,
             IF(m.rate IS NULL, NULL, (m.qty_in + m.qty_out) / COALESCE(NULLIF(mi.conversion_factor, 0), 1) * m.rate) AS value,
             m.trans_type AS source, m.trans_no AS doc_no, m.sort_id AS doc_id
        FROM (${base}) m
        JOIN inventories mi ON mi.id = m.item_id
       WHERE ${where.join(' AND ')}`;
  return { sql, params };
}

const today = () => new Date().toISOString().slice(0, 10);
const dayBefore = (d) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
};

// The whole ledger as one statement: opening balance from the snapshot plus everything that
// moved since, then the period's own movements. Lives here rather than in the route so the
// reconciliation harness can run the identical query instead of a lookalike copy of it.
function ledgerQuery(filters = {}) {
  const itemId = filters.itemId || null;
  const locationId = filters.locationId || null;
  const to = filters.to || today();
  const anchor = filters.snapshotFrom || SNAPSHOT_FROM;
  const from = filters.from && filters.from > anchor ? filters.from : anchor;

  const prior = movementsQuery({ itemId, locationId, from: anchor, to: dayBefore(from) });
  const window = movementsQuery({ itemId, locationId, from, to });

  const snapWhere = ['sl.inventory_id IS NOT NULL', 'sl.location_id IS NOT NULL'];
  const snapParams = [];
  if (itemId) { snapWhere.push('sl.inventory_id = ?'); snapParams.push(itemId); }
  if (locationId) { snapWhere.push('sl.location_id = ?'); snapParams.push(locationId); }

  const sql = `
    WITH prior AS (${prior.sql}),
    win AS (${window.sql}),
    snap AS (
      SELECT sl.inventory_id AS item_id, sl.location_id, sl.unit_title,
             SUM(sl.beg_qty) AS beg_qty, AVG(sl.beg_cost) AS beg_cost,
             AVG(COALESCE(sl.ending_cost, sl.beg_cost)) AS ave_cost
        FROM live_stock_ledger sl
       WHERE ${snapWhere.join(' AND ')}
       GROUP BY 1, 2, 3
    ),
    prior_net AS (
      SELECT item_id, location_id, SUM(IF(direction = 'in', qty, -qty)) AS net_qty
        FROM prior GROUP BY 1, 2
    ),
    win_agg AS (
      SELECT item_id, location_id,
             SUM(IF(direction = 'in', qty, 0)) AS input,
             SUM(IF(direction = 'in', COALESCE(value, 0), 0)) AS input_value,
             SUM(IF(direction = 'in' AND value IS NULL, qty, 0)) AS input_unvalued,
             SUM(IF(direction = 'out', qty, 0)) AS output,
             SUM(IF(direction = 'out', COALESCE(value, 0), 0)) AS output_value,
             SUM(IF(direction = 'out' AND value IS NULL, qty, 0)) AS output_unvalued
        FROM win GROUP BY 1, 2
    ),
    cells AS (
      SELECT item_id, location_id FROM snap
      UNION SELECT item_id, location_id FROM prior_net
      UNION SELECT item_id, location_id FROM win_agg
    )
    SELECT k.item_id AS inventory_id, i.item_code, i.display_name,
           COALESCE(s.unit_title, u.code) AS unit_title,
           COALESCE(NULLIF(i.conversion_factor, 0), 1) AS conversion_factor,
           su.code AS stock_unit_code, u.code AS base_unit_code,
           k.location_id, l.location_name,
           COALESCE(s.beg_qty, 0) + COALESCE(p.net_qty, 0) AS beg_qty,
           s.beg_cost, s.ave_cost,
           COALESCE(w.input, 0) AS input, COALESCE(w.input_value, 0) AS input_value,
           COALESCE(w.input_unvalued, 0) AS input_unvalued,
           COALESCE(w.output, 0) AS output, COALESCE(w.output_value, 0) AS output_value,
           COALESCE(w.output_unvalued, 0) AS output_unvalued
      FROM cells k
      JOIN inventories i ON i.id = k.item_id
      LEFT JOIN units_of_measure u ON u.id = i.base_unit_id
      LEFT JOIN units_of_measure su ON su.id = i.stock_unit_id
      LEFT JOIN locations l ON l.id = k.location_id
      LEFT JOIN snap s ON s.item_id = k.item_id AND s.location_id = k.location_id
      LEFT JOIN prior_net p ON p.item_id = k.item_id AND p.location_id = k.location_id
      LEFT JOIN win_agg w ON w.item_id = k.item_id AND w.location_id = k.location_id
     WHERE (i.item_type IS NULL OR i.item_type NOT IN (${NON_STOCK_TYPES.map(() => '?').join(', ')}))
     ORDER BY i.item_code, l.location_name`;

  return { sql, params: [...prior.params, ...window.params, ...snapParams, ...NON_STOCK_TYPES] };
}

// Turns a raw ledger row into the shape the report renders. Movements that carry no amount of
// their own (transfers, mainly) are priced at the item's average cost, so they contribute a value
// instead of silently reading as free.
function shapeLedgerRow(r) {
  const ave = Number(r.ave_cost || r.beg_cost || 0);
  const begQty = Number(r.beg_qty || 0);
  const input = Number(r.input || 0);
  const output = Number(r.output || 0);
  const endingQty = begQty + input - output;
  return {
    inventory_id: r.inventory_id,
    item_code: r.item_code,
    display_name: r.display_name,
    unit_title: r.unit_title,
    location_id: r.location_id,
    location_name: r.location_name,
    beg_qty: begQty,
    beg_cost: r.beg_cost,
    beg_value: begQty * ave,
    input,
    value_of_inputs: Number(r.input_value || 0) + Number(r.input_unvalued || 0) * ave,
    output,
    value_of_outputs: Number(r.output_value || 0) + Number(r.output_unvalued || 0) * ave,
    ending_qty: endingQty,
    // The same on-hand in the Base Unit (2026-10-29) -- stock qty x conversion_factor, as the Bin
    // Card's Balance (Base Unit) reads it.
    ending_qty_base: endingQty * Number(r.conversion_factor || 1),
    stock_unit_code: r.stock_unit_code || null,
    base_unit_code: r.base_unit_code || null,
    ending_cost: ave,
    ending_value: endingQty * ave,
  };
}

module.exports = {
  movementsQuery, ledgerQuery, shapeLedgerRow, SOURCES, SNAPSHOT_FROM, snapshotFrom, NON_STOCK_TYPES,
  today, dayBefore,
};
