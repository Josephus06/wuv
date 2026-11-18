const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const {
  movementsQuery, ledgerQuery, shapeLedgerRow, SOURCES, snapshotFrom, today,
} = require('../lib/stockMovements');
const { sendXlsx } = require('../lib/xlsxExport');

const router = express.Router();
const ROUTE = '/stock-ledger-reports';

// "Inventory > Inventory Reports > Stock Ledger", computed from this app's own stock movements.
//
// It used to be served verbatim from `live_stock_ledger`, a frozen snapshot of live's report for
// 2026-01-01..2026-07-28. Nothing here ever posted to it, so receiving reports never showed up
// and the date filter did nothing. Now:
//
//   Beginning = the snapshot's beg_qty (the only source for balances predating the migration)
//               plus every movement from the snapshot date up to the day before `from`
//   Input / Output = movements inside [from, to], from src/lib/stockMovements.js
//   Ending    = Beginning + Input - Output
//
// The snapshot is kept strictly as the opening balance. Its own Input/Output columns are no
// longer served, because they describe live's window rather than the one being asked for.
//
// Only stock-carrying items appear: services, non-inventory items, landed costs and discounts
// are excluded, as they have no quantity on hand to ledger.
//
// A KNOWN LIMIT, stated rather than hidden. Reconciled against the snapshot over its own window,
// the computed Input matches live on 97% of item+location cells and Output on 88%. The gap is
// production consumption: assembly_build_lines.qty is the job order's material requirement
// repeated on every build of that order, so multi-build job orders overstate the draw. Receipts,
// transfers, returns and adjustments are exact. `/movements` shows the documents behind any
// figure, which is how to check one.
//
// The report's rows, shared with its Excel extract so the file holds exactly the figures on screen.
async function ledgerRows(req) {
  // "As of" sends only `to`, meaning everything up to that date -- so the period opens at the
  // snapshot date, which is as far back as the data goes.
  const { sql, params } = ledgerQuery({
    snapshotFrom: await snapshotFrom(pool),
    itemId: req.query.item_id || null,
    locationId: req.query.location_id || null,
    from: req.query.from || null,
    to: req.query.to || null,
  });
  const [rows] = await pool.query(sql, params);
  return rows.map(shapeLedgerRow);
}

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    res.json(await ledgerRows(req));
  } catch (err) {
    next(err);
  }
});

// Extract: the whole report under the current filters, as a workbook -- every item, not the ten on
// screen. Flattened to one row per Item + Location with the Item Code repeated so it can be
// filtered; an item with no location row gets a single row of its own, as it does on screen.
router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const rows = await ledgerRows(req);
    const out = [];
    const seen = new Set();
    for (const r of rows) {
      if (!r.location_id) {
        if (!seen.has(r.inventory_id)) out.push({ item_code: r.item_code, unit_title: r.unit_title || '' });
        seen.add(r.inventory_id);
        continue;
      }
      seen.add(r.inventory_id);
      out.push({
        item_code: r.item_code, location: r.location_name || '', unit_title: r.unit_title || '',
        // beg_cost comes straight from the query and is blank on screen when null; so here too.
        beg_qty: r.beg_qty, beg_cost: r.beg_cost == null || r.beg_cost === '' ? null : Number(r.beg_cost),
        beg_value: r.beg_value, input: r.input, value_of_inputs: r.value_of_inputs,
        output: r.output, value_of_outputs: r.value_of_outputs,
        ending_qty: r.ending_qty, ending_qty_base: r.ending_qty_base, base_unit: r.base_unit_code || '',
        ending_cost: r.ending_cost, ending_value: r.ending_value,
      });
    }
    const QTY = '#,##0.0000'; // quantities show 4 decimals on screen
    await sendXlsx(res, {
      filename: 'stock-ledger.xlsx',
      sheet: 'Stock Ledger',
      columns: [
        { header: 'Item Code', key: 'item_code', width: 18 },
        { header: 'Location', key: 'location', width: 24 },
        { header: 'Unit Title', key: 'unit_title', width: 12 },
        { header: 'Beg. Inv. Qty On-hand', key: 'beg_qty', width: 16, numFmt: QTY },
        { header: 'Beg. Ave. Cost', key: 'beg_cost', width: 14, money: true },
        { header: 'Beg. Inv. On-hand Value', key: 'beg_value', width: 17, money: true },
        { header: 'Input', key: 'input', width: 14, numFmt: QTY },
        { header: 'Value of Inputs', key: 'value_of_inputs', width: 16, money: true },
        { header: 'Output', key: 'output', width: 14, numFmt: QTY },
        { header: 'Value of Outputs', key: 'value_of_outputs', width: 16, money: true },
        { header: 'Ending Inv. Qty On-hand (Stock Unit)', key: 'ending_qty', width: 18, numFmt: QTY },
        { header: 'Ending Inv. Qty On-hand (Base Unit)', key: 'ending_qty_base', width: 18, numFmt: QTY },
        { header: 'Base Unit', key: 'base_unit', width: 10 },
        { header: 'Ending Ave. Cost', key: 'ending_cost', width: 14, money: true },
        { header: 'Ending Inv On-hand Value', key: 'ending_value', width: 17, money: true },
      ],
      rows: out,
    });
  } catch (err) {
    if (res.headersSent) { res.destroy(err); return; }
    next(err);
  }
});

// The documents behind a cell -- every movement for one item + location over the period, newest
// first. This is what makes a figure checkable: a receiving report that raised stock is now a row
// you can point at, which was the whole complaint about the old frozen report.
router.get('/movements', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const itemId = req.query.item_id || null;
    if (!itemId) return res.status(400).json({ message: 'item_id is required' });
    const to = req.query.to || today();
    const anchor = await snapshotFrom(pool);
    const from = req.query.from && req.query.from > anchor ? req.query.from : anchor;

    const mv = movementsQuery({ itemId, locationId: req.query.location_id || null, from, to });
    const [rows] = await pool.query(
      `SELECT m.*, l.location_name
         FROM (${mv.sql}) m
         LEFT JOIN locations l ON l.id = m.location_id
        ORDER BY m.move_date DESC, m.source
        LIMIT 500`,
      mv.params
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// Lets the UI name the sources it is summing without hard-coding them a second time.
router.get('/sources', requireAuth, requirePermission(ROUTE, 'can_view'), (_req, res) => {
  res.json(SOURCES.map((s) => ({ key: s.key, label: s.label })));
});

module.exports = router;
