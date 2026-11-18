// Whether an estimate process line's item is listed on the "Print with Selected Items" quotations
// (2026-10-28). Ticked or unticked on the estimate view; never touched, a line counts as ticked when
// it has an item that is not a Service -- the materials, not SERVICE LABOR -- as the source shows it.
export function isPrintSelected(p) {
  if (p.print_selected === 1 || p.print_selected === 0 || p.print_selected === true || p.print_selected === false) return !!p.print_selected;
  return !!p.item_id && String(p.item_type || '').toLowerCase() !== 'service';
}
