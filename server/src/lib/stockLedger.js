// THE ONE DEFINITION OF WHAT MOVES STOCK.
//
// Every stock-mutating action this build performs, unioned into one movement ledger: what the
// Bin Card lists row by row, and what the Production screen's On Hand is the running total of.
// It lived inside routes/binCard.js while the Bin Card was its only reader; the Production view
// reads it now too, and two copies of "which tables count as a movement" would be free to drift
// the moment either gained a branch -- leaving the report and the shop floor quoting different
// stock for the same item, which is the exact confusion this whole area keeps producing.
//
// Each branch mirrors what its route actually does to stock:
//   - Receiving Report (RR-#)        -> qty_in at the receipt line's Location
//   - Vendor Return (VR-#)           -> qty_out at the return line's Location
//   - Item Fulfillment (IF-#)        -> qty_out at the TO's Withdraw From
//   - Item Receipt (IR-#)            -> qty_in at the TO's Transfer To
//   - Assembly Build (AB-#)          -> qty_out (material consumption) at the process Location
//   - Inventory Adjustment (IA-#, approved only) -> signed delta at the line's Location
//     (new_qty - qty_on_hand), never the raw adjust_qty_by -- that is in whatever unit Unit Used
//     says, while new_qty/qty_on_hand are already normalised to Base Unit by
//     inventoryAdjustments.js, so their difference is the true movement.
//
// PO Qty / Rec. Qty / Qty to Return are always entered in Purchase Unit (confirmed: "5 qty for
// tarpaulin" on a PO means 5 ROLL, not 5 SQFT) -- purchaseOrders.js's receive/return endpoints
// scale that by conversion_factor before touching stock, so those branches scale the same way
// and report the real Base Unit movement.
//
// THE OTHER BRANCHES WERE NOT ALL BASE UNIT, WHICH THIS COMMENT USED TO CLAIM.
//
// Every branch now carries a `uom` -- the unit the source document actually recorded -- and its
// quantity is brought up to Base Unit by `toBase` below when that unit is not already the base
// one. Until 2026-09-10 only the two purchase branches did this, so one roll of tarpaulin
// received moved 1,722 SQFT while the same roll transferred out moved 1, and both were added to
// the same running balance. 11,098 fulfilment lines across 579 items were affected.
//
// Where each branch's unit comes from:
//
//   Receiving Report / Vendor Return  no uom -- already scaled in the SELECT, must not scale twice
//   Item Fulfillment / Item Receipt   tol.unit_used where the requestor set the Transfer Order's
//                                     Unit Used toggle, otherwise tol.uom -- USUALLY the stock
//                                     unit, but on JO-driven lines it is the dimension unit the
//                                     length/width were keyed in (MM/IN) while the quantity is
//                                     already in the base unit. See lineUnit.
//   Assembly Build                    abl.unit -- almost always the base unit already
//   Inventory Adjustment              ial.unit -- base when written by inventoryAdjustments.js,
//                                     the stock unit on migrated rows
//   RMI Receipt                       rrl.uom -- the RMI line's own unit
//
// A unit is recognised as "already base" by its CODE or its TITLE ('SQFT' and 'Square Foot' are
// one unit), and dimension codes never trigger a conversion. See toBase.
//
// The Bin Card still shows the unit per row, which is what makes this auditable rather than a
// silent correction: the reader can see which quantity came in which unit.
//
// STILL OUTSTANDING, deliberately not changed here:
//   - transferOrders.js writes the fulfilment quantity into inventory_locations.qty_on_hand
//     unscaled, so that stored snapshot is still wrong. This ledger no longer reads it.
//   - inventoryAdjustments.js scales when unit_used === 'stock', but every stored row reads
//     'StockUnit' or 'BaseUnit', so the comparison never matches and editing a legacy line
//     silently stops scaling it.

// filterByItem pushes `item_id IN (?)` into every branch rather than wrapping the union and
// filtering outside it. Same rows either way, but each branch then uses its own item_id index
// instead of the whole union being materialised first: measured 789ms cold against 119ms for
// five items. A caller passing true must supply the id array SIX times, once per branch, in
// order.
function movementsSql(filterByItem = false) {
  const and = (alias) => (filterByItem ? ` AND ${alias}.item_id IN (?)` : '');
  const where = (alias) => (filterByItem ? ` WHERE ${alias}.item_id IN (?)` : '');

  // Brings a movement up to Base Unit.
  //
  // A line records its own unit. Where that is already the item's base unit the quantity stands;
  // where it is the Stock/Purchase Unit -- "1" meaning 1 ROLL of something held in square feet --
  // it is multiplied by conversion_factor, exactly as Purchase Order receiving has always done.
  // One roll of tarpaulin received and the same roll transferred out now both move 1,722 SQFT
  // instead of 1,722 in and 1 out.
  //
  // Compared case-insensitively against the base unit's code, which is how the two are written:
  // uom holds 'ROLL' / 'SHT' / 'GAL' against a base of 'SQFT' / 'LTR', or the base code itself
  // when the line was already entered in base units. A NULL unit means the branch scaled the
  // quantity before this point, so it must not be scaled twice.
  // Two ways a unit can already BE the base unit, and the second one was missed until 2026-09-12:
  //
  //   code   'SQFT'        what units_of_measure.code holds
  //   title  'Square Foot' what units_of_measure.title holds -- and what some lines record
  //
  // They are the same unit written two ways. Comparing only against the code meant a line saying
  // "Square Foot" looked like a foreign unit and was multiplied by the conversion factor, so an
  // adjustment of 96 SQFT posted as 3,072. 18 lines were affected (10 inventory adjustments,
  // 7 assembly builds, 1 transfer order).
  //
  // MM / CM / IN / FT are never quantity units here. They are the unit the LENGTH and WIDTH were
  // keyed in -- a job order cutting 900mm x 430mm out of a sheet -- while the quantity itself is
  // the resulting area in the base unit. transfer_order_lines.uom carries that dimension unit on
  // JO-driven lines, so 192 SQFT fulfilled was being read as "192 MM", found not to match SQFT,
  // and multiplied by 32 to 6,144. No item in this database is stocked in a linear unit, so a
  // dimension code can never legitimately mean a quantity to convert.
  //
  // Everything else that differs from the base IS a stock-unit count -- 11,410 transfer order
  // lines say "2 ROLL" or "1 SHT" and genuinely need the factor. That is why the unit is not
  // simply ignored here: dropping the conversion would understate a roll of tarpaulin by 984x.
  const toBase = (qty, uom, inv, base) => `(${qty}) * CASE
      WHEN ${uom} IS NULL
        OR UPPER(${uom}) = UPPER(COALESCE(${base}.code, ''))
        OR UPPER(${uom}) = UPPER(COALESCE(${base}.title, ''))
        OR UPPER(${uom}) IN ('MM', 'CM', 'IN', 'FT')
      THEN 1 ELSE COALESCE(NULLIF(${inv}.conversion_factor, 0), 1) END`;

  // The unit an Item Fulfillment / Item Receipt quantity is actually in.
  //
  // tol.uom is a guess -- it is the stock unit on some lines and the dimension unit the length and
  // width were keyed in on others -- and it is all this had until the Transfer Order grew a Unit
  // Used toggle. Where a requestor has USED that toggle they have said outright which unit they
  // are asking in, so that answer wins: a line switched to Stock Unit and re-keyed as "1" means
  // one ROLL, and posting it as 1 SQFT would be the 984x understatement this file exists to stop.
  // NULL unit_used -- every line that predates the toggle -- falls through to tol.uom unchanged,
  // so no historical movement moves.
  const lineUnit = (tol, base, stock) => `CASE
      WHEN ${tol}.unit_used IS NULL OR ${tol}.unit_used = '' THEN ${tol}.uom
      WHEN LOWER(${tol}.unit_used) IN ('base', 'baseunit') THEN ${base}.title
      ELSE COALESCE(${stock}.title, ${base}.title) END`;

  return `
  SELECT r.date_created AS trans_date, r.receipt_no AS trans_no, 'Receiving Report' AS trans_type,
         po.po_no AS ref_no, rl.item_id, NULL AS from_location_id, NULL AS from_location_name,
         rl.location_id AS to_location_id, loc.location_name AS to_location_name,
         rl.qty_received * COALESCE(i0.conversion_factor, 1) AS qty_in, 0 AS qty_out, rl.rate, r.id AS sort_id, r.created_at AS sort_ts, NULL AS uom,
         pu0.title AS doc_uom,
         -- ref_id: the id of the record Ref # names, so the Bin Card can link it (2026-11-11).
         po.id AS ref_id
  FROM purchase_order_receipt_lines rl
  JOIN purchase_order_receipts r ON r.id = rl.purchase_order_receipt_id
  JOIN purchase_orders po ON po.id = r.purchase_order_id
  LEFT JOIN locations loc ON loc.id = rl.location_id
  LEFT JOIN inventories i0 ON i0.id = rl.item_id
  LEFT JOIN units_of_measure pu0 ON pu0.id = i0.purchase_unit_id${where('rl')}

  UNION ALL

  SELECT vr.date_created, vr.return_no, 'Vendor Return',
         po2.po_no, rl2.item_id, rl2.location_id, loc2.location_name, NULL, NULL,
         0, rl2.qty_returned * COALESCE(i1.conversion_factor, 1), rl2.rate, vr.id, vr.created_at, NULL,
         pu1.title, po2.id
  FROM purchase_return_lines rl2
  JOIN purchase_returns vr ON vr.id = rl2.purchase_return_id
  JOIN purchase_orders po2 ON po2.id = vr.purchase_order_id
  LEFT JOIN locations loc2 ON loc2.id = rl2.location_id
  LEFT JOIN inventories i1 ON i1.id = rl2.item_id
  LEFT JOIN units_of_measure pu1 ON pu1.id = i1.purchase_unit_id${where('rl2')}

  UNION ALL

  SELECT f.date_created, f.fulfillment_no, 'Item Fulfillment',
         tord.to_no, fl.item_id, tord.withdraw_from_location_id, wloc.location_name, NULL, NULL,
         0, ${toBase('fl.qty_fulfilled', lineUnit('tol', 'bu', 'su'), 'i', 'bu')}, i.average_cost, f.id, f.created_at,
         ${lineUnit('tol', 'bu', 'su')}, ${lineUnit('tol', 'bu', 'su')}, tord.id
  FROM item_fulfillment_lines fl
  JOIN item_fulfillments f ON f.id = fl.item_fulfillment_id
  JOIN transfer_orders tord ON tord.id = f.transfer_order_id
  LEFT JOIN transfer_order_lines tol ON tol.id = fl.transfer_order_line_id
  LEFT JOIN locations wloc ON wloc.id = tord.withdraw_from_location_id
  LEFT JOIN inventories i ON i.id = fl.item_id
  LEFT JOIN units_of_measure bu ON bu.id = i.base_unit_id
  LEFT JOIN units_of_measure su ON su.id = i.stock_unit_id${where('fl')}

  UNION ALL

  SELECT r2.date_created, r2.receipt_no, 'Item Receipt',
         f2.fulfillment_no, rl3.item_id, NULL, NULL, tord2.transfer_to_location_id, tloc.location_name,
         ${toBase('rl3.qty_received', lineUnit('tol3', 'bu2', 'su2'), 'i2', 'bu2')}, 0, i2.average_cost, r2.id, r2.created_at,
         ${lineUnit('tol3', 'bu2', 'su2')}, ${lineUnit('tol3', 'bu2', 'su2')}, tord2.id
  FROM item_receipt_lines rl3
  JOIN item_receipts r2 ON r2.id = rl3.item_receipt_id
  JOIN item_fulfillments f2 ON f2.id = r2.item_fulfillment_id
  JOIN transfer_orders tord2 ON tord2.id = r2.transfer_order_id
  LEFT JOIN transfer_order_lines tol3 ON tol3.id = rl3.transfer_order_line_id
  LEFT JOIN locations tloc ON tloc.id = tord2.transfer_to_location_id
  LEFT JOIN inventories i2 ON i2.id = rl3.item_id
  LEFT JOIN units_of_measure bu2 ON bu2.id = i2.base_unit_id
  LEFT JOIN units_of_measure su2 ON su2.id = i2.stock_unit_id${where('rl3')}

  UNION ALL

  SELECT ab.date_created, ab.ab_no, 'Assembly Build',
         jo.job_order_no, abl.item_id, abl.location_id, aloc.location_name, NULL, NULL,
         0, ${toBase('abl.total_qty_to_build', 'abl.unit', 'i3', 'bu3')}, NULL, ab.id, ab.created_at, abl.unit, abl.unit, jo.id
  FROM assembly_build_lines abl
  JOIN assembly_builds ab ON ab.id = abl.assembly_build_id
  JOIN job_orders jo ON jo.id = ab.job_order_id
  LEFT JOIN locations aloc ON aloc.id = abl.location_id
  LEFT JOIN inventories i3 ON i3.id = abl.item_id
  LEFT JOIN units_of_measure bu3 ON bu3.id = i3.base_unit_id
  WHERE abl.item_id IS NOT NULL AND abl.location_id IS NOT NULL${and('abl')}

  UNION ALL

  SELECT ia.date_created, ia.adjustment_no, 'Inventory Adjustment',
         NULL, ial.item_id,
         IF(ial.new_qty - ial.qty_on_hand < 0, ial.location_id, NULL), IF(ial.new_qty - ial.qty_on_hand < 0, iloc.location_name, NULL),
         IF(ial.new_qty - ial.qty_on_hand >= 0, ial.location_id, NULL), IF(ial.new_qty - ial.qty_on_hand >= 0, iloc.location_name, NULL),
         ${toBase('GREATEST(ial.new_qty - ial.qty_on_hand, 0)', 'ial.unit', 'i4', 'bu4')},
         ${toBase('GREATEST(-(ial.new_qty - ial.qty_on_hand), 0)', 'ial.unit', 'i4', 'bu4')},
         ial.est_unit_cost, ia.id, ia.updated_at, ial.unit,
         -- The unit the adjustment was ENTERED in, which is not ial.unit. ial.unit is the unit the
         -- stored quantities are in (Base Unit on anything this app wrote); Unit Used is what the
         -- person chose, and "2" against a 4'x8' sheet means 2 SHT.
         CASE WHEN LOWER(ial.unit_used) IN ('base', 'baseunit') THEN bu4.title
              ELSE COALESCE(su4.title, bu4.title) END,
         NULL
  FROM inventory_adjustment_lines ial
  JOIN inventory_adjustments ia ON ia.id = ial.inventory_adjustment_id
  LEFT JOIN locations iloc ON iloc.id = ial.location_id
  LEFT JOIN inventories i4 ON i4.id = ial.item_id
  LEFT JOIN units_of_measure bu4 ON bu4.id = i4.base_unit_id
  LEFT JOIN units_of_measure su4 ON su4.id = i4.stock_unit_id
  WHERE ia.status = 'approved'${and('ial')}

  UNION ALL

  -- Office Supply Requisition fulfillments (OSRF): out of the Withdraw From warehouse, and into
  -- the Transfer To one when the requisition names it -- a one-step transfer. Left out until
  -- 2026-10-05, so a fulfilled requisition never came off the shelf it was served from. The lines
  -- record the item's base unit code, so toBase leaves them as they are.
  SELECT osf.date_created, osf.osrf_no, 'Office Supply Fulfillment',
         osr.osr_no, osfl.item_id, osf.withdraw_from_location_id, owloc.location_name, NULL, NULL,
         0, ${toBase('osfl.fulfilled_qty', 'osfl.uom', 'i5', 'bu5')}, osfl.cost, osf.id, osf.created_at, osfl.uom, osfl.uom, osr.id
  FROM osr_fulfillment_lines osfl
  JOIN osr_fulfillments osf ON osf.id = osfl.osrf_id
  JOIN office_supply_requisitions osr ON osr.id = osf.osr_id
  LEFT JOIN locations owloc ON owloc.id = osf.withdraw_from_location_id
  LEFT JOIN inventories i5 ON i5.id = osfl.item_id
  LEFT JOIN units_of_measure bu5 ON bu5.id = i5.base_unit_id
  WHERE osf.withdraw_from_location_id IS NOT NULL AND (i5.item_type IS NULL OR LOWER(i5.item_type) NOT IN ('service', 'non-inventory', 'noninventory'))${and('osfl')}

  UNION ALL

  SELECT osf2.date_created, osf2.osrf_no, 'Office Supply Fulfillment',
         osr2.osr_no, osfl2.item_id, NULL, NULL, osf2.transfer_to_location_id, otloc.location_name,
         ${toBase('osfl2.fulfilled_qty', 'osfl2.uom', 'i6', 'bu6')}, 0, osfl2.cost, osf2.id, osf2.created_at, osfl2.uom, osfl2.uom, osr2.id
  FROM osr_fulfillment_lines osfl2
  JOIN osr_fulfillments osf2 ON osf2.id = osfl2.osrf_id
  JOIN office_supply_requisitions osr2 ON osr2.id = osf2.osr_id
  LEFT JOIN locations otloc ON otloc.id = osf2.transfer_to_location_id
  LEFT JOIN inventories i6 ON i6.id = osfl2.item_id
  LEFT JOIN units_of_measure bu6 ON bu6.id = i6.base_unit_id
  WHERE osf2.transfer_to_location_id IS NOT NULL AND (i6.item_type IS NULL OR LOWER(i6.item_type) NOT IN ('service', 'non-inventory', 'noninventory'))${and('osfl2')}

  UNION ALL

  -- RMI receipts (rmi_receipt_lines, 2026-10-05): material returned from a branch arrives at the
  -- RMI's Return To and leaves its Return From, on the day it was received -- a one-step transfer.
  -- Only receipts taken in T1S: the migrated RMIs' receipts are inside the source's Beginning
  -- Balance already (see db/create-rmi-receipts.js). The line's own unit, so toBase converts it.
  SELECT rrl.date_received, rmi.rmi_no, 'RMI Receipt',
         NULL, rrl.item_id, rmi.return_from_location_id, rfloc.location_name, NULL, NULL,
         0, ${toBase('rrl.qty', 'rrl.uom', 'i7', 'bu7')}, i7.average_cost, rrl.id, rrl.created_at, rrl.uom, rrl.uom, NULL
  FROM rmi_receipt_lines rrl
  JOIN rmis rmi ON rmi.id = rrl.rmi_id
  LEFT JOIN locations rfloc ON rfloc.id = rmi.return_from_location_id
  LEFT JOIN inventories i7 ON i7.id = rrl.item_id
  LEFT JOIN units_of_measure bu7 ON bu7.id = i7.base_unit_id${where('rrl')}

  UNION ALL

  SELECT rrl2.date_received, rmi2.rmi_no, 'RMI Receipt',
         NULL, rrl2.item_id, NULL, NULL, rmi2.return_to_location_id, rtloc.location_name,
         ${toBase('rrl2.qty', 'rrl2.uom', 'i8', 'bu8')}, 0, i8.average_cost, rrl2.id, rrl2.created_at, rrl2.uom, rrl2.uom, NULL
  FROM rmi_receipt_lines rrl2
  JOIN rmis rmi2 ON rmi2.id = rrl2.rmi_id
  LEFT JOIN locations rtloc ON rtloc.id = rmi2.return_to_location_id
  LEFT JOIN inventories i8 ON i8.id = rrl2.item_id
  LEFT JOIN units_of_measure bu8 ON bu8.id = i8.base_unit_id${where('rrl2')}
`;
}

// How many item-id placeholders movementsSql(true) carries -- one per movement branch. Callers
// pass movementParams(ids) rather than counting branches themselves, so adding a branch here
// cannot leave a caller one parameter short.
const MOVEMENT_FILTER_COUNT = 10;
function movementParams(ids) {
  return Array.from({ length: MOVEMENT_FILTER_COUNT }, () => ids);
}

// On-hand per item + location, as the running total of those movements -- the same number the
// Bin Card's last row shows for that pair, because it is the same rows summed.
//
// WHY THE MOVEMENTS AND NOT inventory_locations. The snapshot table was never populated by the
// year migrations, so it read 0 for almost the whole catalogue while the Bin Card could show
// stock -- a job order line for an item with rolls in the warehouse read as a full materials
// shortage. Seeding the snapshot from the source system's Stock Ledger was the other way to fix
// that, and it needs a complete, current import to stay right; deriving means the two screens
// cannot disagree and there is nothing to keep in sync.
//
// It inherits the movement history's own faults: where the migration is incomplete this total is
// wrong, and it can come out negative, which no shelf can be. That is visible rather than hidden,
// which is the point -- a wrong number that matches the ledger it came from can be chased down.
//
// A row's location is whichever end of the movement it happened at: qty_in rows carry a
// to_location, qty_out rows a from_location, and an Inventory Adjustment sets one or the other by
// the sign of its delta.
async function deriveOnHand(db, itemIds) {
  const ids = [...new Set((itemIds || []).filter((id) => id != null).map(Number))];
  const byPair = new Map();
  if (!ids.length) return byPair;
  const p6 = movementParams(ids);

  const sumByPair = async (since) => {
    const [rows] = await db.query(
      `SELECT m.item_id, COALESCE(m.to_location_id, m.from_location_id) AS location_id,
              SUM(m.qty_in - m.qty_out) AS balance
         FROM (${movementsSql(true)}) m
        ${since ? 'WHERE m.trans_date >= ?' : ''}
        GROUP BY m.item_id, COALESCE(m.to_location_id, m.from_location_id)`,
      since ? [...p6, since] : p6
    );
    const map = new Map();
    for (const r of rows) {
      if (r.location_id != null) map.set(`${r.item_id}|${r.location_id}`, Number(r.balance));
    }
    return map;
  };

  // Anchored exactly as the Bin Card anchors: the source system's Beginning Balance, plus the
  // movements since. Same inputs, same arithmetic, so On Hand is the Bin Card's closing balance
  // for that item and warehouse rather than a second opinion about it.
  const [ledger] = await db.query(
    `SELECT lsl.inventory_id, lsl.location_id, lsl.window_from,
            lsl.beg_qty * COALESCE(NULLIF(i.conversion_factor, 0), 1) AS opening_base
       FROM live_stock_ledger lsl
       JOIN inventories i ON i.id = lsl.inventory_id
      WHERE lsl.inventory_id IN (?) AND lsl.location_id IS NOT NULL AND lsl.window_from IS NOT NULL`,
    [ids]
  ).catch(() => [[]]); // no ledger table yet: every pair falls back to full history below

  const anchors = new Map();
  for (const r of ledger) {
    anchors.set(`${r.inventory_id}|${r.location_id}`, {
      opening: Number(r.opening_base) || 0,
      from: String(r.window_from).slice(0, 10),
    });
  }

  // Every row of one ledger import shares a window, so this is one cutoff in practice; looping
  // keeps it correct if a partial re-import ever leaves two.
  const cutoffs = [...new Set([...anchors.values()].map((a) => a.from))];
  // Items the snapshot has NO row for still have a snapshot to start from -- the install's -- as the
  // Bin Card reads it. Asking only about the items in hand, an item the source held none of (no row)
  // looked like an install with no snapshot at all and fell back to its whole history from zero:
  // 3M 3630-53 CARDINAL RED showed 7,231.98 sqft on hand from a 2022 receipt the source had long
  // since used, while its Bin Card read 31.98 (2026-10-23).
  if (!cutoffs.length) {
    const [[g]] = await db.query('SELECT MIN(window_from) AS window_from FROM live_stock_ledger').catch(() => [[null]]);
    if (g && g.window_from) cutoffs.push(String(g.window_from).slice(0, 10));
  }
  const since = new Map();
  for (const c of cutoffs) since.set(c, await sumByPair(c));

  // Pairs the ledger knows about are anchored -- including ones with no movements at all, whose
  // on-hand is simply their opening balance, which a movements-only sum would report as nothing.
  for (const [pair, a] of anchors) {
    byPair.set(pair, a.opening + (since.get(a.from)?.get(pair) ?? 0));
  }

  // With no snapshot at all, everything is the full movement history. With one, a pair it does not
  // list is a pair the source held NOTHING at when the snapshot was struck (the snapshot is the
  // source's whole position -- every item and location with a balance), so it starts from zero at
  // the snapshot date and counts only the movements since. Falling back to full history there
  // showed stock -- negative, often -- that the source never had, from the migration's gaps.
  if (cutoffs.length === 0) {
    for (const [pair, bal] of await sumByPair(null)) byPair.set(pair, bal);
  } else {
    const cutoff = cutoffs.sort()[0];
    for (const [pair, bal] of since.get(cutoff)) if (!byPair.has(pair)) byPair.set(pair, bal);
  }
  // To the 4 decimals stock is kept in. The opening balance is a beginning qty times a conversion
  // factor, added to summed movements in floating point, so 71 on hand could come back
  // 70.99999999999 -- and an Assembly Build needing exactly 71 was refused "need 71.0000, only
  // 71.0000 on hand" (JO-72534-1-15, 2026-10-21). Every caller compares against this figure.
  for (const [pair, bal] of byPair) byPair.set(pair, Math.round(Number(bal) * 10000) / 10000);
  return byPair;
}

// The SQL rule in `toBase`, expressed once in JavaScript so callers can ask the same question
// about a row they are displaying. The Bin Card used to re-implement this in the browser and drift
// out of step with it -- flagging rows the ledger had converted perfectly well, and telling the
// reader the balance was unreliable when it was not.
const DIMENSION_UNITS = ['MM', 'CM', 'IN', 'FT'];

// True when the recorded unit IS the base unit, so the quantity needs no conversion. NULL means
// the branch scaled it already. Both spellings of a unit count -- code 'SQFT' and title
// 'Square Foot' are the same unit -- and a dimension code is the job order's length/width unit,
// never the quantity's.
function unitIsBase(uom, baseCode, baseTitle) {
  if (uom === null || uom === undefined || uom === '') return true;
  const v = String(uom).trim().toUpperCase();
  return v === String(baseCode || '').trim().toUpperCase()
    || v === String(baseTitle || '').trim().toUpperCase()
    || DIMENSION_UNITS.includes(v);
}

// Whether a row's quantity could actually be brought to the base unit. A unit that is not the base
// one is converted with the item's conversion factor, so the only genuinely broken case is an item
// with NO usable factor -- null or zero -- where the quantity lands in the balance unconverted.
//
// A factor of exactly 1 is NOT that case, even though the unit is spelled differently. It means
// one of these is one of those: a 1-litre can of reducer is stock unit CAN, base unit LTR,
// factor 1, and multiplying by 1 is the correct conversion. Treating 1 as "no factor" would have
// raised the warning on 3,375 movements across 83 items that are handled correctly, which is the
// same crying-wolf problem this whole change is undoing.
function unitIsConvertible(uom, baseCode, baseTitle, conversionFactor) {
  if (unitIsBase(uom, baseCode, baseTitle)) return true;
  const f = Number(conversionFactor);
  return Number.isFinite(f) && f > 0;
}

// Turns a Base Unit quantity back into the quantity the source document actually recorded, so a
// report can show what was written down rather than what it was converted to. An adjustment of
// 2 SHT against a 4'x8' acrylic sheet moves 64 SQFT of stock; this gives back the 2.
//
// Derived from the base figure rather than read from the document, deliberately: dividing by the
// same factor the conversion multiplied by cannot disagree with the balance it sits beside, which
// a separately-stored raw quantity eventually would.
function toDocQty(baseQty, docUom, baseCode, baseTitle, conversionFactor) {
  const q = Number(baseQty) || 0;
  if (unitIsBase(docUom, baseCode, baseTitle)) return q;
  const f = Number(conversionFactor);
  return Number.isFinite(f) && f > 0 ? q / f : q;
}

module.exports = {
  movementsSql, movementParams, deriveOnHand, unitIsBase, unitIsConvertible, toDocQty, DIMENSION_UNITS,
};
