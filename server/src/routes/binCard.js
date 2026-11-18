const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { movementsSql, unitIsBase, unitIsConvertible, toDocQty } = require('../lib/stockLedger');
const { dayBefore } = require('../lib/stockMovements');
const { sendXlsx, day } = require('../lib/xlsxExport');

const router = express.Router();
const ROUTE = '/bin-card-reports';

// Real Bin Card (Master Lists > Inventory Reports > Bin Card): a chronological,
// per-Item + per-Location transaction ledger with a running balance -- distinct from
// Stock Ledger (a Beginning/Input/Output/Ending *summary*, left untouched). Confirmed
// against the live system's `generate_bin_card` response shape: each row is one
// transaction (Trans #), tagged with a Ref # (the transaction it came from), a
// Withdraw From / Transfer To location pair, Qty In/Out, Rate, and a running Balance.
//
// The movements themselves are defined once in lib/stockLedger.js -- which branch of the build
// counts as a stock movement, and in which unit -- because the Production screen's On Hand is now
// the running total of the same rows. Two copies would let the report and the shop floor quote
// different stock for one item.
const UNION_SQL = movementsSql();

// WHY THIS REPORT NEEDS AN OPENING BALANCE.
//
// The running balance above starts at zero and adds whatever movements this build happens to
// hold -- which is only the transactions the year migrations brought over. Wherever that history
// is incomplete the total drifts, and it drifts both ways: measured across the 6,644 item +
// location pairs live's Stock Ledger covers, 3,648 of them (55%) disagreed with live's own
// figure. 1,484 showed stock where live says the bin is empty, and 1,094 showed a NEGATIVE
// balance, which no warehouse can hold. MATTE LAMINATING FILM read -286,311 LINCH against live's
// 15.87 rolls; IMARI 113 GSM read +77 SHT against live's 0.
//
// A ledger reconstructed from movements alone cannot fix this, because the missing part is the
// balance the item already had before the first movement we hold. live_stock_ledger carries
// exactly that -- Beginning Qty per item + location, as at the start of the window it was
// imported for -- so the report opens from that figure and replays only the movements inside the
// window, instead of replaying an incomplete decade from zero.
//
// THERE IS NO LONGER A WAY TO ASK FOR THE UNANCHORED VIEW. `?full=1` used to give one: every
// movement from zero, the honest picture of what this database actually holds. It is a real
// question, but not the one a bin card is opened to ask, and the answers diverge alarmingly --
// SINTRABOARD WHITE 3MM at Warehouse - Central read -17 SHT from zero against the source
// system's 11, a constant 28-sheet offset running through every row of the card, because the
// sheets already on that shelf predate the migrated history. A negative balance that no warehouse
// can hold was one checkbox away from the figure people act on. Reconciling the migration itself
// belongs in src/db/compare-stock-asof.js, which answers it against the source rather than
// leaving the reader to tell two views apart.
//
// The fallback below is NOT that view returning by another name -- it is what is left when there
// is nothing to anchor to, and it says so (`reconciled: false`).
//
// A ledger imported before window_from existed cannot be anchored (the Beginning Qty is real but
// nothing records which date it belongs to), so those fall back to the full view and say so via
// `reconciled: false` rather than quietly anchoring to a date that was guessed.
//
// The whole card -- balances included -- for one set of filters. Shared by the screen (GET /) and
// its Excel extract (GET /export) so the two can never disagree about a figure.
async function buildBinCard(query) {
  const { item_id: itemId, location_id: locationId, as_of: asOf, date_from: dateFromRaw } = query;
  if (!itemId) throw Object.assign(new Error('item_id is required'), { status: 400 });
  // Period From only hides rows; it never changes a balance. See the BALANCE FORWARD note below.
  const dateFrom = dateFromRaw ? String(dateFromRaw).slice(0, 10) : null;

  // Every qty this build actually writes to inventory_locations.qty_on_hand is in the
  // item's Base Unit (purchaseOrders.js's receive/return scale Purchase Unit qty up to
  // Base Unit before touching stock) -- confirmed against the live system, whose own
  // Bin Card records Qty In/Out in Base Unit too and derives the Stock Unit balance as
  // Base Unit balance / Conversion Factor (e.g. 1 ROLL = 1344.8 SQFT). So Balance(Base
  // Unit) is the raw running total (what already reconciles with qty_on_hand);
  // Balance(Stock Unit) is just that divided down.
  const [[unitInfo]] = await pool.query(
    `SELECT i.conversion_factor, su.code AS stock_unit_code, su.title AS stock_unit_title,
            bu.code AS base_unit_code, bu.title AS base_unit_title
     FROM inventories i
     LEFT JOIN units_of_measure su ON su.id = i.stock_unit_id
     LEFT JOIN units_of_measure bu ON bu.id = i.base_unit_id
     WHERE i.id = ?`,
    [itemId]
  );
  if (!unitInfo) throw Object.assign(new Error('Item not found'), { status: 404 });
  const conversionFactor = Number(unitInfo.conversion_factor) || 1;

  // live's own Beginning Qty for this item (and location, when one is chosen), quoted in the
  // item's Stock Unit like every other figure in that table, so it comes up to Base Unit the
  // same way the movements do.
  //
  // Asked for only when it can be used, and never allowed to take the report down with it.
  // window_from is a column import-stock-ledger.js adds on its next run, so between deploying
  // this and re-importing, an install's ledger does not have it yet -- selecting it there threw
  // "Unknown column 'window_from'" and the whole Bin Card 500'd. A report that cannot anchor
  // should fall back to the view it already had, not stop working, so any failure to read the
  // anchor means there is no anchor.
  let opening = null;
  try {
    [[opening]] = await pool.query(
      `SELECT SUM(beg_qty) AS beg_stock, MIN(window_from) AS window_from, MAX(window_to) AS window_to
         FROM live_stock_ledger
        WHERE inventory_id = ?${locationId ? ' AND location_id = ?' : ''}`,
      locationId ? [itemId, locationId] : [itemId]
    );
  } catch (err) {
    opening = null;
  }
  // No row for this item/location, but the install has a snapshot: the source held none here when
  // it was struck, so the card opens at zero on that date -- not on the full, unreconciled history.
  if (opening && !opening.window_from) {
    try {
      const [[g]] = await pool.query('SELECT MIN(window_from) AS window_from FROM live_stock_ledger');
      if (g && g.window_from) opening = { beg_stock: 0, window_from: g.window_from, window_to: null };
    } catch (err) { /* no snapshot column: keep the full-history view */ }
  }
  const windowFrom = opening?.window_from ? String(opening.window_from).slice(0, 10) : null;
  // THE DAY THE ANCHOR CLOSES IS ANSWERABLE TOO.
  //
  // The opening balance is struck at the START of window_from, which makes it equally the
  // CLOSING balance of the day before -- so a report asked for that day is answered by the
  // anchor alone, with no movements inside the window yet to replay. Against the source's own
  // Stock Ledger for 2026-09-30, the day before this install's 2026-10-01 snapshot, that figure
  // agreed on all 8,496 item/location pairs; the full-history fallback this used to take instead
  // disagreed on 4,604 of them and ran 904 of the stock ones negative, which no bin can be.
  //
  // ONE day, not any earlier date: Sept 29 would need the movements of Sept 30 subtracted back
  // off the anchor, and the migrated history this database holds is exactly what cannot be
  // trusted to do that -- which is why the anchor exists at all.
  const anchorCloses = windowFrom ? dayBefore(windowFrom) : null;
  // Asked "as of" a date before even that, the anchor is no help -- it describes a later moment
  // than the question. Answer from full history instead, and say so, rather than heading the
  // report with a Beginning Balance dated after the date asked for.
  const asOfBeforeWindow = !!(asOf && anchorCloses && String(asOf).slice(0, 10) < anchorCloses);
  const reconciled = !!windowFrom && !asOfBeforeWindow;
  // The date the opening balance is being quoted AT: the window's own start, or the day it
  // closes when that is the day asked about. A report headed "as at 01 Oct" for a 30 Sept
  // question reads as a bug even when the number is right.
  const openingAt = reconciled && asOf && String(asOf).slice(0, 10) < windowFrom ? anchorCloses : windowFrom;
  const openingBase = reconciled ? Number(opening.beg_stock || 0) * conversionFactor : 0;

  const where = ['item_id = ?'];
  const params = [itemId];
  if (locationId) {
    where.push('(to_location_id = ? OR from_location_id = ?)');
    params.push(locationId, locationId);
  }
  if (asOf) {
    where.push('trans_date <= ?');
    params.push(asOf);
  }
  // EVERY movement up to the as-of date, anchored or not. The anchored view used to ask only
  // for those from windowFrom on -- correct arithmetic, but it left the card with the two rows
  // October has so far and no sign of the dozen transfers that emptied the bin in September.
  // A bin card with the movements taken out of it is not a bin card. They are all read, and the
  // opening balance decides which DIRECTION each one is accumulated in; see below.

  // sort_id is only meaningful as a tie-breaker *within* one transaction type (it's an
  // auto-increment id from a different table per branch of the UNION, so comparing it
  // across branches is meaningless) -- order strictly by the real timestamp instead.
  const [rows] = await pool.query(
    `SELECT * FROM (${UNION_SQL}) movements WHERE ${where.join(' AND ')} ORDER BY trans_date, sort_ts`,
    params
  );

  // THE BALANCE RUNS BOTH WAYS OUT OF THE OPENING BALANCE.
  //
  // Forwards is the obvious half: each movement after the anchor adds to it. Backwards is the
  // half that was missing, and it is just as exact -- the anchor is the balance at that instant
  // and every movement before it is known, so the balance before any of them is the anchor with
  // those movements taken back off. Running backwards out of 11 SHT reproduces the source
  // system's own September column for SINTRABOARD WHITE 3MM to the sheet: 12 before the
  // adjustment that took 4, 16 before that, 17, 19, 20 ... and the card reads like the source's
  // instead of starting from zero and going negative.
  //
  // Where this database's history for a period is incomplete the derived balances drift from
  // the source by exactly what is missing -- the same drift the figures always had, now visible
  // against a true anchor rather than against zero.
  const firstPost = reconciled ? rows.findIndex((r) => String(r.trans_date).slice(0, 10) >= windowFrom) : 0;
  // No movement falls inside the window: every row read belongs before the anchor.
  const splitAt = firstPost === -1 ? rows.length : firstPost;
  const delta = (r) => Number(r.qty_in) - Number(r.qty_out);
  const balances = new Array(rows.length);
  let balanceBase = openingBase;
  for (let i = splitAt; i < rows.length; i += 1) { balanceBase += delta(rows[i]); balances[i] = balanceBase; }
  // The last movement before the window closes ON the opening balance, by definition.
  let back = openingBase;
  for (let i = splitAt - 1; i >= 0; i -= 1) { balances[i] = back; back -= delta(rows[i]); }

  // uom_convertible is decided HERE, by the same helper the ledger's own conversion uses, rather
  // than by the browser comparing strings. The report was previously flagging any unit whose
  // spelling differed from the base CODE -- so "Square Foot" against a base of SQFT, and the
  // MM/IN that job-order lines carry as their length/width unit, were all marked unreliable
  // even though the ledger converts them correctly. A warning that contradicts the number
  // beside it is worse than no warning.
  const withBalance = rows.map((r, i) => {
    const rowBalance = balances[i];
    // Qty In/Out are reported in the unit the SOURCE DOCUMENT used, while the balances stay in
    // Base Unit -- an adjustment of 2 SHT reads "2 SHT" and moves the balance 64 SQFT, which is
    // the row the warehouse can actually check against the paperwork. qty_in/qty_out keep the
    // Base Unit figures so nothing downstream that sums them has to change.
    // Labelled with the BASE unit whenever the document's unit is not a separate quantity unit:
    // no unit at all, the base unit under either spelling, or a dimension code like MM that a
    // job-order line carries for its length and width. Those rows are already in the base unit,
    // so "192 MM" would name the wrong one -- it is 192 square feet.
    const docUom = unitIsBase(r.doc_uom, unitInfo.base_unit_code, unitInfo.base_unit_title)
      ? (unitInfo.base_unit_title || unitInfo.base_unit_code)
      : r.doc_uom;
    const toDoc = (q) => toDocQty(
      q, r.doc_uom, unitInfo.base_unit_code, unitInfo.base_unit_title, unitInfo.conversion_factor,
    );
    return {
      ...r,
      doc_uom: docUom,
      doc_qty_in: toDoc(r.qty_in),
      doc_qty_out: toDoc(r.qty_out),
      balance_base: rowBalance,
      balance_stock: rowBalance / conversionFactor,
      // Before the anchor the balance is derived by running back out of it rather than
      // accumulated up to it -- same arithmetic, opposite direction, and worth being able to
      // tell apart when a figure is being checked against the paperwork.
      balance_derived: reconciled && i < splitAt,
      uom_convertible: unitIsConvertible(
        r.uom, unitInfo.base_unit_code, unitInfo.base_unit_title, unitInfo.conversion_factor,
      ),
    };
  });

  // The opening balance is itself a row of the ledger -- the one every other balance is
  // measured from -- so it is sent as one rather than as a number the reader has to hold in
  // their head. It sits at the boundary it describes, between the movements derived back out of
  // it and the ones accumulated forward from it; it used to be unshifted to the very oldest
  // position, which was the same place when nothing older than the anchor was listed.
  if (reconciled) {
    withBalance.splice(splitAt, 0, {
      trans_date: openingAt,
      trans_no: null,
      trans_type: 'Beginning Balance',
      ref_no: null,
      item_id: Number(itemId),
      from_location_id: null,
      from_location_name: null,
      to_location_id: null,
      to_location_name: null,
      qty_in: null,
      qty_out: null,
      rate: null,
      balance_base: openingBase,
      balance_stock: openingBase / conversionFactor,
      is_opening: true,
      // Carries no unit of its own -- it is a balance, already in the base unit.
      uom_convertible: true,
      doc_uom: null,
      doc_qty_in: null,
      doc_qty_out: null,
    });
  }

  // BALANCE FORWARD: PERIOD FROM HIDES ROWS, IT DOES NOT MOVE THE BALANCE.
  //
  // Every balance above was computed over the whole card, out of the anchor, exactly as it is
  // without a Period From. Only then are the rows dated before Period From dropped -- so the first
  // row still shown carries its true running balance, not one restarted at the window's edge --
  // and the balance they leave behind is shown as one "Balance Forward" row dated Period From,
  // the way the Beginning Balance row is. It is the balance of the last hidden row, i.e. the
  // balance at the start of Period From. Not added when the first row shown is the Beginning
  // Balance itself, which already says the same thing.
  if (dateFrom) {
    const firstShown = withBalance.findIndex((r) => String(r.trans_date).slice(0, 10) >= dateFrom);
    const shown = firstShown === -1 ? [] : withBalance.slice(firstShown);
    let forwardBase;
    if (firstShown === -1) {
      forwardBase = withBalance.length ? withBalance[withBalance.length - 1].balance_base : openingBase;
    } else if (firstShown > 0) {
      forwardBase = withBalance[firstShown - 1].balance_base;
    } else if (!withBalance[0].is_opening) {
      // Nothing hidden: the balance just before the first movement, which is that movement taken
      // back off its own balance.
      forwardBase = withBalance[0].balance_base - delta(withBalance[0]);
    }
    withBalance.length = 0;
    if (forwardBase !== undefined) {
      withBalance.push({
        trans_date: dateFrom,
        trans_no: null,
        trans_type: 'Balance Forward',
        ref_no: null,
        item_id: Number(itemId),
        from_location_id: null,
        from_location_name: null,
        to_location_id: null,
        to_location_name: null,
        qty_in: null,
        qty_out: null,
        rate: null,
        balance_base: forwardBase,
        balance_stock: forwardBase / conversionFactor,
        is_balance_forward: true,
        uom_convertible: true,
        doc_uom: null,
        doc_qty_in: null,
        doc_qty_out: null,
      });
    }
    withBalance.push(...shown);
  }

  // A running balance can only be accumulated oldest-first, but nobody opens a bin card to read
  // 2021: the question is almost always "what is this item doing now", and with 149 pages of
  // history that answer sat on the last page. Reversed after the balances are computed, so page
  // one is the most recent movement and each row still carries the balance as at its own date.
  withBalance.reverse();

  return {
    stock_unit_label: unitInfo.stock_unit_title ? `${unitInfo.stock_unit_title} (${unitInfo.stock_unit_code})` : (unitInfo.stock_unit_code || 'Stock Unit'),
    base_unit_label: unitInfo.base_unit_title ? `${unitInfo.base_unit_title} (${unitInfo.base_unit_code})` : (unitInfo.base_unit_code || 'Base Unit'),
    // The bare codes as well as the labels. Every Qty In/Out on this report is in the Base
    // Unit -- see lib/stockLedger.js, which scales each branch by conversion_factor -- so the
    // rows need a short code to repeat, not the full "Square Foot (SQFT)" title.
    stock_unit_code: unitInfo.stock_unit_code || null,
    base_unit_code: unitInfo.base_unit_code || null,
    conversion_factor: conversionFactor,
    // What the reader needs to know about which view they are looking at: whether it is
    // anchored to live's own opening balance, and from when.
    reconciled,
    window_from: reconciled ? windowFrom : null,
    // What the Beginning Balance row is dated -- window_from, or the day it closes when the
    // report was asked for that day.
    opening_at: reconciled ? openingAt : null,
    window_to: opening?.window_to ? String(opening.window_to).slice(0, 10) : null,
    opening_balance_base: reconciled ? openingBase : null,
    opening_balance_stock: reconciled ? openingBase / conversionFactor : null,
    date_from: dateFrom,
    rows: withBalance,
  };
}

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    res.json(await buildBinCard(req.query));
  } catch (err) {
    next(err);
  }
});

// Extract: every row of the card under the screen's filters (all pages, not the 20 on screen), as a
// workbook. Built by the same buildBinCard the screen reads, so the file cannot disagree with it.
router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const card = await buildBinCard(req.query);
    const baseUom = card.base_unit_code || card.base_unit_label || '';
    const isBalanceRow = (r) => r.is_opening || r.is_balance_forward;
    // Blank, not 0, where the screen shows nothing -- so a column total is still the movement.
    const qty = (v, docV) => (Number(v) ? Number(docV ?? v) : null);
    const QTY = '#,##0.0000';
    await sendXlsx(res, {
      filename: 'bin-card.xlsx',
      sheet: 'Bin Card',
      columns: [
        { header: 'Date', key: 'date', width: 12 },
        { header: 'Trans. #', key: 'trans_no', width: 18 },
        { header: 'Ref. #', key: 'ref_no', width: 18 },
        { header: 'Withdraw From', key: 'from', width: 24 },
        { header: 'Transfer To', key: 'to', width: 24 },
        { header: 'Qty In', key: 'qty_in', width: 14, numFmt: QTY },
        { header: 'Qty Out', key: 'qty_out', width: 14, numFmt: QTY },
        { header: 'UOM', key: 'uom', width: 10 },
        { header: 'Rate', key: 'rate', width: 14, money: true },
        { header: `Balance(Stock Unit / ${card.stock_unit_label})`, key: 'balance_stock', width: 20, numFmt: QTY },
        { header: `Balance(Base Unit / ${card.base_unit_label})`, key: 'balance_base', width: 20, numFmt: QTY },
      ],
      rows: card.rows.map((r) => ({
        date: day(r.trans_date),
        trans_no: r.is_balance_forward ? 'Balance Forward' : r.is_opening ? 'Beginning Balance' : (r.trans_no || ''),
        ref_no: r.ref_no || '',
        from: r.from_location_name || '',
        to: r.to_location_name || '',
        qty_in: qty(r.qty_in, r.doc_qty_in),
        qty_out: qty(r.qty_out, r.doc_qty_out),
        uom: isBalanceRow(r) ? '' : (r.doc_uom || r.uom || baseUom),
        rate: r.rate === null || r.rate === undefined || r.rate === '' || !Number.isFinite(Number(r.rate)) ? null : Number(r.rate),
        balance_stock: Number(r.balance_stock),
        balance_base: Number(r.balance_base),
      })),
    });
  } catch (err) {
    if (res.headersSent) { res.destroy(err); return; }
    next(err);
  }
});

module.exports = router;
