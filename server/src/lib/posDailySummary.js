// Reader for the salon branches' "Manual Daily Sales Reports" workbook (Cuts For Tots), sheet
// SALES SUMMARY: one row per day, kept by hand because it is more accurate than the POS.
//
//   row 2   "BRANCH : SM SEASIDE"
//   row 4   headers                          rows 9..   one per day          a "TOTAL" row ends it
//
// WFC = First Haircut Certificate (250), ISC = Discount Card (199): both sold, so both sales; GC = gift
// certificate, money held for the customer (Customer Deposits) until it is used.
//
//   A Date   B customers   C WFC qty   D ISC qty   E GC w/ WFC qty   F GC qty
//   G Net Services   H Products   I WFC (= C x 250)   J ISC (= D x 199)   K GC w/ WFC (= E x 730)
//   L GC Bought   M Discounts   N ISC Manual Discount   O GC Used
//   P Cash Sales (= T - Q)   Q GCASH   R Cash Deposit   S Cash Over-Short (= P - R)
//   T Total Sales Net of Discount (= G + H + I + J)
//   U.. counts: KIDDIE / ADULT / BANG CUT, HAIR ART, BABY WASH SOLD, BABY GEL SOLD, GC HAIRCUT ...,
//           Chups Sold, FREE ISC
//
// Columns are found by their header text, not their letter, so a column added or moved in next
// month's copy does not shift every figure. Discounts and the ISC Manual Discount are already off
// Net Services (the sheet's own Total adds G..J only), so they are reported, never deducted again.
//
// Each day becomes what lib/posSalesImport.js builds an invoice from -- the same shape the POS
// Category Sales report is read into -- plus its payment: GCash, cash, gift certificates redeemed,
// and the cash short / over against what was deposited.
const XLSX = require('xlsx');

const round2 = (n) => Number((Number(n) || 0).toFixed(2));
const num = (v) => (v == null || v === '' ? 0 : Number(String(v).replace(/,/g, '')) || 0);
const normHead = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

// Header text (normalised) -> field. First match wins, so the longer phrases come first.
const COLUMNS = [
  ['date', /^DATE$/],
  ['customers', /^NO OF CUSTOMER/],
  ['wfc_qty', /^NO OF WFC SOLD/],
  ['isc_qty', /^NO OF ISC SOLD/],
  ['gc_wfc_qty', /^NO OF GC W WFC SOLD/],
  ['gc_qty', /^NO OF GC SOLD/],
  ['net_services', /^NET SERVICES$/],
  ['products', /^PRODUCTS$/],
  ['wfc', /^WFC$/],
  ['isc', /^ISC$/],
  ['gc_wfc', /^GC W WFC$/],
  ['gc_bought', /^GC BOUGHT$/],
  ['discounts', /^DISCOUNTS$/],
  ['isc_discount', /^ISC MANUAL DISCOUNT$/],
  ['gc_used', /^GC USED$/],
  ['cash_sales', /^CASH SALES$/],
  ['gcash', /^GCASH$/],
  ['cash_deposit', /^CASH DEPOSIT/],
  ['over_short', /^CASH OVER SHORT$/],
  ['total', /^TOTAL SALES NET OF DISCOUNT$/],
  ['baby_wash', /^BABY WASH SOLD$/],
  ['baby_gel', /^BABY GEL SOLD$/],
  ['chups', /^CHUPS SOLD$/],
];

// The products counted by the sheet, sold under "Products": stock lines at no price of their own (the
// peso total is the PRODUCTS line), so what was sold still leaves the shelf.
const COUNTED_PRODUCTS = [['baby_wash', 'BABY WASH'], ['baby_gel', 'BABY GEL'], ['chups', 'CHUPS']];

function excelDate(v) {
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    return d ? `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` : null;
  }
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(v || '').trim());
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

function isDailySummaryWorkbook(buffer) {
  try {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    return wb.SheetNames.some((n) => /SALES\s*SUMMARY/i.test(n));
  } catch { return false; }
}

// -> [{ ok, errors, import_key, store_name, branch_code, shift, closed_date, categories, total_amount, payment, ... }]
function parseDailySummary(buffer, sourceFile) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames.find((n) => /SALES\s*SUMMARY/i.test(n));
  if (!sheetName) return [{ ok: false, errors: ['No SALES SUMMARY sheet in this workbook.'] }];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null });

  const branchCell = rows.slice(0, 6).flat().find((v) => /BRANCH\s*:/i.test(String(v || '')));
  const branch = branchCell ? String(branchCell).replace(/.*BRANCH\s*:\s*/i, '').trim() : null;
  const headIdx = rows.findIndex((r) => r.some((v) => normHead(v) === 'DATE') && r.some((v) => /NET SERVICES/.test(normHead(v))));
  if (headIdx < 0) return [{ ok: false, errors: ['Could not find the header row (Date ... Net Services ...).'] }];
  const col = {};
  rows[headIdx].forEach((h, i) => {
    const t = normHead(h);
    const hit = COLUMNS.find(([key, re]) => col[key] === undefined && re.test(t));
    if (hit) col[hit[0]] = i;
  });
  const missing = ['date', 'net_services', 'gcash', 'total'].filter((k) => col[k] === undefined);
  if (missing.length) return [{ ok: false, errors: [`Missing columns: ${missing.join(', ')}.`] }];
  if (!branch) return [{ ok: false, errors: ['Could not read "BRANCH :" at the top of the sheet.'] }];

  const out = [];
  for (const r of rows.slice(headIdx + 1)) {
    const v = (k) => (col[k] === undefined ? 0 : num(r[col[k]]));
    const rawDate = r[col.date];
    if (/^TOTAL$/i.test(String(rawDate || '').trim())) break;
    const date = excelDate(rawDate);
    if (!date) continue; // blank spacer rows
    const errors = [];

    const lines = (category, items) => ({ name: category, items: items.filter((i) => i.quantity) });
    const categories = [
      lines('HAIR SERVICES', [{ quantity: v('net_services') ? 1 : 0, description: 'HAIR SALON SERVICES', unit_price: v('net_services'), amount: v('net_services') }]),
      lines('HAIR PRODUCT SALES', [{ quantity: v('products') ? 1 : 0, description: 'HAIR PRODUCTS SALES', unit_price: v('products'), amount: v('products') }]),
      lines('HAIR PRODUCTS', COUNTED_PRODUCTS.map(([k, name]) => ({ quantity: v(k), description: name, unit_price: 0, amount: 0 }))),
      lines('CERTIFICATES', [
        { quantity: v('wfc_qty'), description: 'WFC - FIRST HAIRCUT CERTIFICATE', unit_price: v('wfc_qty') ? round2(v('wfc') / v('wfc_qty')) : 0, amount: v('wfc') },
        { quantity: v('isc_qty'), description: 'ISC - DISCOUNT CARD', unit_price: v('isc_qty') ? round2(v('isc') / v('isc_qty')) : 0, amount: v('isc') },
      ]),
      lines('GIFT CERTIFICATES', [
        { quantity: v('gc_wfc_qty'), description: 'GIFT CERTIFICATE W/ WFC', unit_price: v('gc_wfc_qty') ? round2(v('gc_wfc') / v('gc_wfc_qty')) : 0, amount: v('gc_wfc') },
        { quantity: v('gc_bought') ? 1 : 0, description: 'GIFT CERTIFICATE', unit_price: v('gc_bought'), amount: v('gc_bought') },
      ]),
    ].filter((c) => c.items.length);

    const sales = round2(v('net_services') + v('products') + v('wfc') + v('isc'));
    if (Math.abs(sales - v('total')) > 0.01) {
      errors.push(`Net Services + Products + WFC + ISC is ${sales.toFixed(2)}, the sheet's Total Sales says ${v('total').toFixed(2)}.`);
    }
    const giftSold = round2(v('gc_wfc') + v('gc_bought'));
    const totalAmount = round2(sales + giftSold);
    const cash = round2(v('cash_sales'));
    const gcash = round2(v('gcash'));
    const gcUsed = round2(v('gc_used'));
    // The sheet's Cash Sales is Total - GCash, so it already counts gift certificates redeemed as if
    // they were cash. The cash actually taken is what is left once those are taken back out.
    const cashTaken = round2(cash - gcUsed);
    const short = round2(v('over_short')); // Cash Sales - Cash Deposit: positive = short, negative = over

    out.push({
      ok: !errors.length, errors,
      kind: 'daily', source_file: sourceFile,
      store_name: branch, branch_code: branch, shift: 'DAY',
      closed_date: date, closed_by: null,
      categories, total_amount: totalAmount,
      import_key: `DAILY:${branch}|${date}`,
      customers: v('customers'),
      discounts: round2(v('discounts') + v('isc_discount')),
      payment: { cash: cashTaken, gcash, gc_used: gcUsed, short, deposit: round2(v('cash_deposit')), gift_sold: giftSold },
    });
  }
  if (!out.length) return [{ ok: false, errors: ['No dated rows in the SALES SUMMARY sheet.'] }];
  return out;
}

module.exports = { isDailySummaryWorkbook, parseDailySummary };
