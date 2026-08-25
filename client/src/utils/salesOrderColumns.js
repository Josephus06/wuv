// The Sales Order line grids, shared by the on-screen view and the print-out so the two
// can't drift apart -- a column added for the operator shows up on the hand-out too.

export const STATUS_LABELS = {
  pending_for_jo: 'Pending for JO',
  jo_in_process: 'JO In-Process',
  pending_delivery: 'Pending Delivery',
  partially_delivered: 'Partially Delivered',
  pending_billing: 'Pending Billing',
  pending_billing_partially_delivered: 'Pending Billing / Partially Delivered',
  billed: 'Billed',
  cancelled: 'Cancelled',
  undeposited: 'Undeposited',
  deposited: 'Deposited',
};

export function num(v) { return v === null || v === undefined || v === '' ? 0 : Number(v); }

export function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

// The collected columns are filled in by whoever banks the day's takings, not by the
// Z-Reading import, which only knows what the till rang up. Printing 0.00 there asserts a
// collection of zero; blank says nobody has recorded one yet, which is what is true. Any
// figure actually entered still prints -- only the untouched zero is left empty.
export function moneyOrBlank(v) {
  return Number(v || 0) === 0 ? '' : money(v);
}

// Just the clock time: the date is already the row's first column, and a shift opens and
// closes on the day it belongs to.
export function shiftTime(v) {
  if (!v) return '';
  const m = /\d{2}:\d{2}/.exec(String(v).slice(11));
  return m ? m[0] : '';
}

// Imported counter sales use a completely different line grid: one row per DATE, showing
// how the day's takings split across cash, e-wallet and bank deposit, what is still
// uncollected, and the VAT breakdown. None of the job/production columns below apply, so
// the two grids are separate lists rather than one list with most cells blank.
export const DAILY_COLLECTION_COLUMNS = [
  { key: 'sale_date', label: 'Date', render: (r) => (r.sale_date ? String(r.sale_date).slice(0, 10) : '') },
  // Who had the till, from the Z-Reading's own OPENED/CLOSED lines.
  {
    key: 'pos_opened_by',
    label: 'Opened By',
    render: (r) => [r.pos_opened_by, shiftTime(r.pos_opened_at)].filter(Boolean).join(' · '),
  },
  {
    key: 'pos_cashier',
    label: 'Closed By',
    render: (r) => [r.pos_cashier, shiftTime(r.pos_closed_at)].filter(Boolean).join(' · '),
  },
  { key: 'cash', label: 'Cash', money: true },
  { key: 'collected_cash', label: 'Collected Cash', money: true, blankWhenZero: true, render: (r) => moneyOrBlank(r.collected_cash) },
  { key: 'gcash', label: 'E-wallet', money: true },
  { key: 'collected_gcash', label: 'Collected E-wallet', money: true, blankWhenZero: true, render: (r) => moneyOrBlank(r.collected_gcash) },
  { key: 'collected_bank_deposit', label: 'Collected Bank Deposit / Collected Sales', money: true },
  { key: 'total_daily_sales', label: 'Total Daily Sales', money: true },
  { key: 'total_cash_to_deposit', label: 'Total Cash to be Deposited', money: true },
  { key: 'total_gcash', label: 'Total E-wallet', money: true },
  { key: 'uncollected_sales', label: 'Uncollected Sales', money: true },
  { key: 'vat_ex', label: 'VAT EX', money: true },
  { key: 'vat_12', label: 'VAT 12%', money: true },
  { key: 'vat_inc', label: 'VAT (Inc.)', money: true },
];

export const LINE_COLUMNS = [
  { key: 'job_type_name', label: 'Job Type' },
  { key: 'job_location_name', label: 'Job Location' },
  { key: 'description', label: 'Description' },
  { key: 'quantity', label: 'Qty' },
  { key: 'quantity_built', label: 'Built', render: (r) => (r.job_order_id ? Number(r.quantity_built || 0) : '') },
  { key: 'quantity_inspected', label: 'QI', render: (r) => (r.job_order_id ? Number(r.quantity_inspected || 0) : '') },
  { key: 'quantity_delivered', label: 'Delivered', render: (r) => (r.job_order_id ? Number(r.quantity_delivered || 0) : '') },
  { key: 'quantity_invoiced', label: 'Invoiced', render: (r) => (r.job_order_id ? Number(r.quantity_invoiced || 0) : '') },
  { key: 'units', label: 'Units' },
  { key: 'price_per_unit', label: 'Price/Unit' },
  { key: 'subtotal', label: 'Subtotal' },
  { key: 'disc_percent', label: 'Disc %' },
  { key: 'disc_amount', label: 'Disc Amt' },
  { key: 'disc_price_per_unit', label: 'Disc Price/Unit' },
  { key: 'tax_code', label: 'Tax Code' },
  { key: 'length', label: 'Length' },
  { key: 'width', label: 'Width' },
  { key: 'height', label: 'Height' },
  { key: 'uom', label: 'UOM' },
  { key: 'remarks', label: 'Remarks' },
  { key: 'memo', label: 'Memo' },
  { key: 'delivery_date', label: 'Delivery Date', render: (r) => (r.delivery_date ? String(r.delivery_date).slice(0, 10) : '') },
  { key: 'delivery_time', label: 'Delivery Time' },
  { key: 'gp_rate', label: 'GP Rate', render: (r) => (r.gp_rate != null ? `${r.gp_rate}%` : '') },
];

// The four figures the footer/print totals show. The daily collections grid carries its own
// VAT breakdown per day, so it adds up those columns instead of the job-line
// subtotal/discount/tax fields, which it never fills -- reading the estimate-shaped fields
// there would show a row of zeroes.
export function salesOrderTotals(lines, isDailyCollections) {
  const subtotal = lines.reduce((s, l) => s + num(isDailyCollections ? l.vat_ex : l.subtotal), 0);
  const discountTotal = isDailyCollections ? 0 : lines.reduce((s, l) => s + num(l.disc_amount), 0);
  const netOfTax = subtotal - discountTotal;
  const taxTotal = isDailyCollections
    ? lines.reduce((s, l) => s + num(l.vat_12), 0)
    : lines.reduce((s, l) => s + (num(l.subtotal) - num(l.disc_amount)) * (num(l.tax_rate) / 100), 0);
  const totalAmount = isDailyCollections
    ? lines.reduce((s, l) => s + num(l.total_daily_sales), 0)
    : netOfTax + taxTotal;
  return { netOfTax, discountTotal, taxTotal, totalAmount };
}
