// The costing team's workbook (costing.xlsx), column for column -- shared by the Process Costing
// view and edit screens so both lay a bracket out the same way. An entry with `key` is an input;
// one with `calc` is a formula cell, computed by computeProcessCosting (shared/costing.js, which
// documents each formula). Changing the layout here changes no figure.
export const PROCESS_COSTING_COLUMNS = [
  { key: 'click_charge', label: 'Click Charge' },
  { key: 'new_ink_cost', label: 'New INK Cost', highlight: true },
  { key: 'ink_cost', label: 'INK' },
  { key: 'direct_labor', label: 'DL' },
  { key: 'moh_power_equipment', label: 'MOH(P/E)' },
  { key: 'moh_depreciation', label: 'MOH(DC)' },
  { key: 'moh_repairs_maintenance', label: 'MOH(R&M)' },
  { key: 'moh_indirect_materials', label: 'MOH(IM&C)' },
  { key: 'moh_indirect_labor', label: 'MOH(IL)' },
  { key: 'other_charges', label: 'Other Charges' },
  { calc: 'subtotalMoh', label: 'SubTotal', shade: true },
  { key: 'costing_allowance_pct', label: 'Costing Allowance' },
  { calc: 'costingAllowance', label: 'Costing Allowance' },
  { calc: 'subtotalAllowance', label: 'SubTotal (COGS)', shade: true },
  { key: 'markup_cogs_pct', label: 'Mark-Up (COGS)' },
  { calc: 'markupCogs', label: 'Mark-Up (COGS)' },
  { calc: 'costPerUnit', label: 'Total (COGS)', shade: true },
  { key: 'opex_admin_pct', label: 'OPEX (Admin)' },
  { calc: 'opexAdmin', label: 'OPEX (Admin)' },
  { key: 'markup_opex_admin_pct', label: 'Mark-Up OPEX (Admin)' },
  { calc: 'markupOpexAdmin', label: 'Mark-Up OPEX (Admin)' },
  { key: 'opex_selling_pct', label: 'OPEX (Selling)' },
  { calc: 'opexSelling', label: 'OPEX (Selling)' },
  { key: 'markup_opex_selling_pct', label: 'Mark-Up OPEX (Selling)' },
  { calc: 'markupOpexSelling', label: 'Mark-Up OPEX (Selling)' },
  { calc: 'totalOpex', label: 'Total OPEX', shade: true },
  { key: 'sub_con', label: 'Sub Con' },
  { key: 'markup_sub_con_pct', label: 'Mark-Up Sub Con' },
  { calc: 'markupSubCon', label: 'Mark-Up Sub Con' },
  { calc: 'totalSubCon', label: 'Total Sub Con', shade: true },
  { calc: 'priceUnrounded', label: 'Total Price', shade: true },
  { calc: 'pricePerUnit', label: 'Selling Price', shade: true },
  { key: 'costing_reference', label: 'Costing Reference', text: true },
  { key: 'disc_ceiling_pct', label: 'DC Account Officer' },
  { calc: 'discCeiling', label: 'DC Account Officer' },
  { key: 'disc_supervisor_pct', label: 'DC Sales Supervisor' },
  { calc: 'discSupervisor', label: 'DC Sales Supervisor' },
  { key: 'disc_manager_pct', label: 'DC Sales Manager' },
  { calc: 'discManager', label: 'DC Sales Manager' },
  { key: 'disc_gm_pct', label: 'DC General Manager' },
  { calc: 'discGm', label: 'DC General Manager' },
];

// Header cells, as the source draws them: a percent and the amount it produces sit under one
// heading spanning both (Costing Allowance: 5.00 | 0.10).
export function processCostingHeaderGroups() {
  const groups = [];
  const cols = PROCESS_COSTING_COLUMNS;
  for (let i = 0; i < cols.length; i += 1) {
    const c = cols[i];
    const next = cols[i + 1];
    if (c.key && c.key.endsWith('_pct') && next?.calc) {
      groups.push({ label: next.label, span: 2, shade: false });
      i += 1;
    } else {
      groups.push({ label: c.label, span: 1, shade: !!c.shade, highlight: !!c.highlight });
    }
  }
  return groups;
}

export const EMPTY_BRACKET = {
  qty_min: '', qty_max: '', click_charge: 0, new_ink_cost: 0, ink_cost: 0, direct_labor: 0,
  moh_power_equipment: 0, moh_depreciation: 0, moh_repairs_maintenance: 0,
  moh_indirect_materials: 0, moh_indirect_labor: 0, other_charges: 0, sub_con: 0, markup_sub_con_pct: 0,
  costing_allowance_pct: 0, markup_cogs_pct: 0, opex_admin_pct: 0, markup_opex_admin_pct: 0,
  opex_selling_pct: 0, markup_opex_selling_pct: 0,
  disc_ceiling_pct: 0, disc_supervisor_pct: 0, disc_manager_pct: 0, disc_gm_pct: 0,
  costing_reference: '', is_active: true,
};
export const BRACKET_FIELDS = Object.keys(EMPTY_BRACKET);

// Two decimals, as the source shows every cell.
export function fmt2(v) {
  const n = Number(v);
  return v == null || v === '' || !Number.isFinite(n) ? '' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
