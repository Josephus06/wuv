// Cost-plus pricing formulas reverse-engineered from the live GraphicStar site's
// `/api/get_costing` (process) and `/api/get_inventories` (material) responses.
// See the plan notes for the verified example numbers these were checked against.
//
// THE ONE COPY OF THESE FORMULAS. It used to live in client/src/utils/costing.js, reachable
// only from the ERP's browser bundle, and the server hand-mirrored it in prose --
// liveEstimateSync.js still says "Mirrors client/src/utils/costing.js's computeAutoPricing
// `total` field exactly", which is a promise no compiler checks. The customer-facing quote site
// needs the same numbers from a different domain, so a third transcription was the alternative.
//
// Consumed as plain ESM by:
//   client/src/utils/costing.js  -- re-export, so ERP imports are unchanged
//   server/src/lib/costing.js    -- lazy dynamic import(), so the API prices quotes with this
//                                   exact code rather than a copy of it
//
// Keep it dependency-free and free of browser/Node globals: it has to run in both.

function num(v) {
  return v === null || v === undefined || v === '' ? 0 : Number(v);
}

// Linear-unit codes (from an item's own Unit of Measures list) converted to feet, and
// area-unit codes converted to square feet -- lets a process line's Length/Width be
// entered in whatever unit the selected UOM represents (e.g. meters) even though the
// item itself is priced by a different area unit (almost always Square Foot in the real
// catalog -- SQFT/SQTF cover 496 of 496 length+width-based items).
//
// Exported because the chatbot answers unit-conversion questions from these same tables
// (server/src/lib/unitConversion.js). A second copy over there would be free to drift, and
// an assistant quoting a different number than the estimate form is worse than one that
// declines to answer.
export const LENGTH_UNIT_TO_FEET = { FT: 1, LFT: 1, IN: 1 / 12, LINCH: 1 / 12, MM: 0.00328084, CM: 0.0328084, MTR: 3.28084, M: 3.28084, LMTR: 3.28084, YD: 3 };
export const AREA_UNIT_TO_SQFT = { SQFT: 1, SQTF: 1, SQM: 10.7639 };

// Converts a Length x Width entered in `uom` into the item's own base-unit area (e.g.
// Square Foot), so a 5x6 line entered in meters against a Square-Foot-priced tarpaulin
// comes out as ~322.92 sqft, not a raw (and wrong) 5x6=30. Unrecognized/blank units pass
// through unconverted (factor 1), matching the pre-conversion behavior for items whose
// Length/Width are already entered in the item's native unit.
export function convertAreaToBaseUnit(length, width, uom, baseUnitCode) {
  const lengthFactor = LENGTH_UNIT_TO_FEET[uom] ?? 1;
  const areaSqft = (num(length) * lengthFactor) * (num(width) * lengthFactor);
  const areaFactor = AREA_UNIT_TO_SQFT[baseUnitCode] ?? 1;
  return areaSqft / areaFactor;
}

// The linear counterpart, for the 496 items priced by length alone (base unit LMTR, LINCH,
// LFT): converts a Length entered in `uom` into the item's own base LINEAR unit, so 19 IN of
// a LINCH-based laminating film comes out as 19, and 3 MTR of an LMTR-based roll as 3.
// Both sides go through feet, the same pivot convertAreaToBaseUnit uses, so any pair of
// recognized linear codes converts correctly. Unrecognized/blank units pass through
// unconverted (factor 1) on either side, matching convertAreaToBaseUnit's behavior for
// lengths already entered in the item's native unit.
export function convertLengthToBaseUnit(length, uom, baseUnitCode) {
  const lengthFeet = num(length) * (LENGTH_UNIT_TO_FEET[uom] ?? 1);
  const baseFactor = LENGTH_UNIT_TO_FEET[baseUnitCode] ?? 1;
  return lengthFeet / baseFactor;
}

// A process's cost is banded by quantity -- find the bracket whose range contains qty.
export function selectBracket(brackets, qty) {
  if (!brackets?.length) return null;
  const q = num(qty);
  return brackets.find((b) => q >= num(b.qty_min) && q <= num(b.qty_max)) || null;
}

// Per-unit process cost/price for a given bracket -- the costing team's workbook
// (costing.xlsx, 2026-09-30), cell for cell. Letters are its columns:
//   N  SubTotal              = Click Charge + INK + DL + the five MOH + Other Charges. Other
//                              Charges were left out at first (the workbook's SUM(F:L, D)), but
//                              the source counts them and on 2026-10-02 the user chose to match
//                              the source (BR-ASSY: 7.875, not 2.625). New INK Cost is not in it.
//   P  Costing Allowance     = N x O%          Q  SubTotal (COGS) = N + P
//   S  Mark-Up (COGS)        = Q x R%          T  Total (COGS)    = Q + S
//   V  OPEX(Admin)           = Q x U%          X  Mark-Up OPEX(Admin)   = V x W%
//   Z  OPEX(Selling)         = Q x Y%          AB Mark-Up OPEX(Selling) = Q x AA%  (on Q, not Z --
//                                                 kept exactly as the workbook has it)
//   AC Total OPEX            = V + X + Z + AB
//   AD Sub Con               AF Mark-Up Sub Con = AD x AE%     AG Total Sub Con = AD + AF
//   AH Total Price           = T + AC + AG
//   AI Selling Price         = AH rounded UP to the peso (5.47 -> 6.00), ALWAYS. Since 2026-10-02
//                              there is no stored per-bracket price any more: the imported
//                              brackets each carried the old system's price, which had drifted
//                              from its own Total Price (120.2 -> 118), and the user asked that
//                              every Selling Price be the Total Price rounded up.
//   AL/AN/AP/AR  the discount ceilings as amounts = AI x each level's %
// costPerUnit = T (COGS before OPEX). costBasis = SubTotal + Sub Con (the plain Sub Con, not its
// mark-up -- the user's rule of 2026-10-28, replacing Total Sub Con) -- the Process Cost per unit,
// no COGS mark-up or OPEX.
export function computeProcessCosting(bracket) {
  if (!bracket) return null;
  const pct = (v, p) => v * num(p) / 100;
  const subtotalMoh = num(bracket.click_charge) + num(bracket.ink_cost) + num(bracket.direct_labor)
    + num(bracket.moh_power_equipment) + num(bracket.moh_depreciation) + num(bracket.moh_repairs_maintenance)
    + num(bracket.moh_indirect_materials) + num(bracket.moh_indirect_labor) + num(bracket.other_charges);
  const subCon = num(bracket.sub_con);
  const costingAllowance = pct(subtotalMoh, bracket.costing_allowance_pct);
  const subtotalAllowance = subtotalMoh + costingAllowance;
  const markupCogs = pct(subtotalAllowance, bracket.markup_cogs_pct);
  const costPerUnit = subtotalAllowance + markupCogs; // Total (COGS)
  const opexAdmin = pct(subtotalAllowance, bracket.opex_admin_pct);
  const markupOpexAdmin = pct(opexAdmin, bracket.markup_opex_admin_pct);
  const opexSelling = pct(subtotalAllowance, bracket.opex_selling_pct);
  const markupOpexSelling = pct(subtotalAllowance, bracket.markup_opex_selling_pct);
  const totalOpex = opexAdmin + markupOpexAdmin + opexSelling + markupOpexSelling;
  const markupSubCon = pct(subCon, bracket.markup_sub_con_pct);
  const totalSubCon = subCon + markupSubCon;
  const costBasis = subtotalMoh + subCon;
  const priceUnrounded = costPerUnit + totalOpex + totalSubCon; // Total Price
  // toFixed(6) first so float noise (99.0000000001) does not round a whole peso up by one.
  const pricePerUnit = Math.ceil(Number(priceUnrounded.toFixed(6)));
  return {
    subtotalMoh, subCon, costBasis, costingAllowance, subtotalAllowance, markupCogs, costPerUnit,
    opexAdmin, markupOpexAdmin, opexSelling, markupOpexSelling, totalOpex, markupSubCon, totalSubCon,
    priceUnrounded, pricePerUnit,
    discCeiling: pct(pricePerUnit, bracket.disc_ceiling_pct),
    discSupervisor: pct(pricePerUnit, bracket.disc_supervisor_pct),
    discManager: pct(pricePerUnit, bracket.disc_manager_pct),
    discGm: pct(pricePerUnit, bracket.disc_gm_pct),
  };
}

// Per-unit material cost/price for an inventory item (no quantity bands).
// costPerUnit includes wastage allowance (a real cost); pricePerUnit adds markup and
// rounds up to a whole peso, matching every real sample.
export function computeMaterialCosting(inventory) {
  if (!inventory) return null;
  const baseCost = num(inventory.material_cost);
  const wastage = baseCost * num(inventory.wastage_allowance_pct) / 100;
  const costPerUnit = baseCost + wastage; // Subtotal
  const markup = costPerUnit * num(inventory.markup_pct) / 100;
  const priceUnrounded = costPerUnit + markup;
  const pricePerUnit = inventory.selling_price != null && inventory.selling_price !== ''
    ? num(inventory.selling_price)
    : Math.ceil(priceUnrounded);
  return { baseCost, wastage, costPerUnit, priceUnrounded, pricePerUnit };
}

// Ties process + material costing together for one estimate process line. Mirrors the
// real site's own column layout (Process | Process Qty | Process UOM | Item | Length |
// Width | UOM | Qty | Total | Unit | Process Price | ...) -- Process Qty and material
// Qty are two independent numbers, not the same field:
//
// - Process cost/price is driven by `processQty` (falls back to `qty` if that's the
//   only one filled in, since a line with a single quantity most likely means the same
//   count for both): bracket matched by `processQty`, per-unit rate x processQty.
// - Material cost/price is driven by the material's own `qty`, further scaled by how much
//   of the item a single piece consumes (`sizeFactor`) -- material usage scales with size
//   even though process labor is priced per piece. What "size" means depends on how the
//   item is flagged: is_length_based && is_width_based consumes an AREA (length x width
//   converted into its base area unit -- see convertAreaToBaseUnit), while is_length_based
//   alone consumes a LENGTH (converted into its base linear unit -- see
//   convertLengthToBaseUnit). Anything else consumes 1. `total` = qty x sizeFactor,
//   matching the real site's "Total" column.
//
// process_cost/process_price and material_cost/material_price are each the EXTENDED
// (already qty-multiplied) amount for this line -- not per-unit rates -- so that
// total_cost = process_cost + material_cost and total_price = process_price +
// material_price are plain sums, and each column reflects the actual peso amount for
// the quantity entered rather than a rate the reader has to multiply themselves.
//
// process_cost and material_cost are true production cost, not price, and are
// deliberately sourced from different figures than process_price/material_price:
// - process_cost = (SubTotal MOH + Sub Con) x procQuantity -- the Process Costing tab's
//   own bracket fields, with no COGS markup or OPEX layered in (unlike process_price,
//   which is the full COGS+OPEX selling rate).
// - material_cost = Average Cost (Base Cost) x sizeFactor x matQuantity -- the inventory's
//   real weighted-average purchase cost normalized to its base unit via
//   conversion_factor. This is intentionally NOT the same field material_price is
//   derived from (Material Cost (Base Cost), the separate sales-pricing basis) -- Average
//   Cost is what the material actually costs; Material Cost is what its price is built on.
//
// discAmount (process_disc_amount) and materialDiscAmount (material_disc_amount) are the
// only other user-entered numbers this touches, mirroring each other:
// disc_process_price = process_price - discAmount, disc_material_price = material_price -
// materialDiscAmount -- the discounted amounts (not the raw ones) are what flow into
// total_price/gross_amount, since a discount on either line should actually reduce what's
// charged. tax_amount is a flat 12% VAT on net_of_tax, and gross_amount = net_of_tax +
// tax_amount (the tax-inclusive amount the customer actually pays; total_price stays
// tax-exclusive, matching net_of_tax, since cost/margin figures should compare against
// the pre-tax price). gp_rate is the resulting margin: (net_of_tax - total_cost) / net_of_tax.
export function computeAutoPricing({ brackets, inventory, processQty, qty, length, width, uom, discAmount, materialDiscAmount }) {
  const procQuantity = num(processQty) || num(qty) || 0;
  const matQuantity = num(qty) || 0;
  // A length-only item used to fall straight through to 1 here, because the only branch
  // that existed demanded is_width_based as well -- so its Length was read, displayed, and
  // then silently ignored: 19 IN of a LINCH-based laminating film priced as a single LINCH,
  // undercharging the material ~19x (sizeFactor multiplies material_cost and material_price,
  // not just the Total column). Width stays absent for those items by design; it is the
  // length that has to carry the usage.
  const sizeFactor = (() => {
    if (inventory?.is_length_based && inventory?.is_width_based && num(length) > 0 && num(width) > 0) {
      return convertAreaToBaseUnit(length, width, uom, inventory.base_unit_code);
    }
    if (inventory?.is_length_based && !inventory?.is_width_based && num(length) > 0) {
      return convertLengthToBaseUnit(length, uom, inventory.base_unit_code);
    }
    return 1;
  })();

  const bracket = selectBracket(brackets, procQuantity);
  const proc = computeProcessCosting(bracket);
  const mat = computeMaterialCosting(inventory);
  const avgCostBase = inventory ? num(inventory.average_cost) / (num(inventory.conversion_factor) || 1) : null;

  const process_cost = proc ? Number((proc.costBasis * procQuantity).toFixed(2)) : null;
  const process_price = proc ? Number((proc.pricePerUnit * procQuantity).toFixed(2)) : null;
  const material_cost = inventory ? Number((avgCostBase * sizeFactor * matQuantity).toFixed(2)) : null;
  const material_price = mat ? Number((mat.pricePerUnit * sizeFactor * matQuantity).toFixed(2)) : null;

  const disc_process_price = process_price != null ? Number((process_price - num(discAmount)).toFixed(2)) : null;
  const disc_material_price = material_price != null ? Number((material_price - num(materialDiscAmount)).toFixed(2)) : null;
  const net_of_tax = (disc_process_price != null || disc_material_price != null)
    ? Number(((disc_process_price || 0) + (disc_material_price || 0)).toFixed(2))
    : null;
  const tax_amount = net_of_tax != null ? Number((net_of_tax * 0.12).toFixed(2)) : null;

  const total_cost = (process_cost != null || material_cost != null)
    ? Number(((process_cost || 0) + (material_cost || 0)).toFixed(2))
    : null;
  const total_price = (disc_process_price != null || disc_material_price != null)
    ? Number(((disc_process_price ?? process_price ?? 0) + (disc_material_price ?? material_price ?? 0)).toFixed(2))
    : null;
  const gp_rate = net_of_tax ? Number((((net_of_tax - (total_cost || 0)) / net_of_tax) * 100).toFixed(2)) : null;
  const gross_amount = net_of_tax != null ? Number((net_of_tax + (tax_amount || 0)).toFixed(2)) : null;

  return {
    process_cost, process_price, material_cost, material_price,
    disc_process_price, disc_material_price, net_of_tax, tax_amount,
    total_cost, total_price, gp_rate, gross_amount,
    total: sizeFactor !== 1 ? Number((sizeFactor * matQuantity).toFixed(4)) : matQuantity,
  };
}
