// Mirrors normaliseUnitUsed in server/src/routes/inventoryAdjustments.js -- keep the two in step.
//
// inventory_adjustment_lines.unit_used is stored two ways: lines this app wrote hold 'stock' or
// 'base', while the 7,619 that came across in the migration hold 'StockUnit' or 'BaseUnit'. Any
// screen comparing the raw column against 'base' therefore read every migrated row as the opposite
// of what it says -- 286 adjustments made in the base unit displayed "Stock Unit", and the Edit
// form's dropdown fell through to its first option because neither stored spelling matched an
// option value.
//
// Stock is the default because the form defaults to it: an adjustment of "2" against a 4'x8'
// acrylic sheet means 2 SHEETS, which is 64 SQFT.
export function isBaseUnit(unitUsed) {
  return ['base', 'baseunit'].includes(String(unitUsed || '').trim().toLowerCase());
}
