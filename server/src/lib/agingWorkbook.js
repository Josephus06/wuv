// Excel extracts of AR Aging, AR Aging Details, AP Aging and AP Aging Details (asked 2026-10-02).
// Each is built from the same report data the screen shows -- the summary rows, or the open
// items behind them -- so the sheet always adds up to what was on screen for the same filters.
//
// Money is written as numbers with a display format, never as preformatted text: the first thing
// anyone does to an aging sheet is total or filter a column. Dates are YYYY-MM-DD text, the
// choice lib/artistIncentiveWorkbook.js documents (an Excel date built from a JS Date can land on
// the previous day).
const ExcelJS = require('exceljs');

const MONEY = '#,##0.00';
const day = (v) => (v ? String(v).slice(0, 10) : '');
const num = (v) => Number(v || 0);

function sheet(wb, name, columns) {
  const ws = wb.addWorksheet(name);
  ws.columns = columns;
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return ws;
}

function finish(ws, moneyKeys, lastCol) {
  moneyKeys.forEach((k) => { ws.getColumn(k).numFmt = MONEY; });
  ws.autoFilter = { from: 'A1', to: `${lastCol}1` };
}

const BUCKETS = [
  { header: 'Current', key: 'current' },
  { header: '1-30 days', key: 'd1_30' },
  { header: '31-60 days', key: 'd31_60' },
  { header: '61-90 days', key: 'd61_90' },
  { header: 'Over 90 days', key: 'over_90' },
  { header: 'Total Balance', key: 'total_balance' },
];

// AR Aging / AP Aging: one row per customer or vendor, then the totals row.
function summaryWorkbook({ title, partyHeader, partyKey, data }) {
  const wb = new ExcelJS.Workbook();
  const ws = sheet(wb, title, [
    { header: partyHeader, key: 'party', width: 46 },
    ...BUCKETS.map((b) => ({ ...b, width: 16 })),
  ]);
  for (const r of data.rows || []) {
    ws.addRow({ party: r[partyKey], ...Object.fromEntries(BUCKETS.map((b) => [b.key, num(r[b.key])])) });
  }
  const t = data.totals || {};
  const total = ws.addRow({ party: `TOTAL (as of ${day(data.as_of)})`, ...Object.fromEntries(BUCKETS.map((b) => [b.key, num(t[b.key])])) });
  total.font = { bold: true };
  finish(ws, BUCKETS.map((b) => b.key), 'G');
  return wb;
}

function arAgingWorkbook(data) {
  if (data.sbu_layout) return arAgingSbuWorkbook(data);
  return summaryWorkbook({ title: 'AR Aging', partyHeader: 'Customer Name', partyKey: 'customer_name', data });
}

// AR Aging filtered by SBU (asked 2026-10-14), laid out as the SBU heads' own sheet: each
// supervisor / account officer / SBU head on a heading row -- role and name shaded orange -- with
// their customers under it, a gap after each, and one "Total:" at the end. Every cell boxed.
const SBU_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8CBAD' } };
const THIN = { style: 'thin' };
function arAgingSbuWorkbook(data) {
  const wb = new ExcelJS.Workbook();
  const ws = sheet(wb, 'AR Aging', [
    { header: 'Customer Name', key: 'customer', width: 34 },
    { header: 'Term', key: 'term', width: 20 },
    { header: '', key: 'role', width: 20 },
    { header: 'Account Officer', key: 'officer', width: 26 },
    ...BUCKETS.map((b) => ({ ...b, width: 14 })),
  ]);
  const money = (r) => Object.fromEntries(BUCKETS.map((b) => [b.key, num(r[b.key]) || null]));
  for (const sec of data.sbu_layout.sections) {
    const head = ws.addRow({ role: sec.label, officer: sec.name });
    head.font = { bold: true };
    ['role', 'officer'].forEach((k) => { head.getCell(k).fill = SBU_FILL; });
    ws.addRow({});
    for (const r of sec.rows) {
      ws.addRow({ customer: r.customer_name, term: r.term_name || '', officer: r.officer_name || sec.name, ...money(r) });
    }
  }
  const t = data.totals || {};
  const total = ws.addRow({ officer: 'Total:', ...money(t) });
  total.font = { bold: true };
  total.getCell('officer').alignment = { horizontal: 'right' };
  ws.eachRow((row) => {
    for (let col = 1; col <= 10; col += 1) row.getCell(col).border = { top: THIN, left: THIN, bottom: THIN, right: THIN };
  });
  BUCKETS.forEach((b) => { ws.getColumn(b.key).numFmt = MONEY; });
  return wb;
}

function apAgingWorkbook(data) {
  return summaryWorkbook({ title: 'AP Aging', partyHeader: 'Vendor Name', partyKey: 'supplier_name', data });
}

// AR Aging Details, laid out as the source's own extract (asked 2026-10-02): the customer's name on
// a row of its own, its documents under it with the Customer column left blank, "Total - <name>"
// beneath them, and one "Total" at the end. Sales Rep sits between Open Balance and Location, and
// dates read as the source writes them (10/4/2022) -- still text, for the reason at the top.
const mdy = (v) => { const d = day(v); return d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}/${d.slice(0, 4)}` : ''; };
function arAgingDetailsWorkbook(groups) {
  const wb = new ExcelJS.Workbook();
  const ws = sheet(wb, 'AR Aging Details', [
    { header: 'Customer', key: 'customer', width: 34 },
    { header: 'Trans. Date', key: 'trans_date', width: 11 },
    { header: 'Trans. #', key: 'trans_no', width: 12 },
    { header: 'BS #', key: 'bs_no', width: 9 },
    { header: 'Memo', key: 'memo', width: 36 },
    { header: 'PO #', key: 'po_no', width: 22 },
    { header: 'Date Due', key: 'date_due', width: 11 },
    { header: 'Age', key: 'age', width: 7 },
    { header: 'Open Balance', key: 'open_balance', width: 15 },
    { header: 'Sales Rep', key: 'sales_rep', width: 26 },
    { header: 'Location', key: 'location', width: 16 },
  ]);
  ws.getRow(1).alignment = { horizontal: 'center' };
  ['customer', 'memo'].forEach((k) => { ws.getColumn(k).alignment = { wrapText: true, vertical: 'top' }; });
  let grand = 0;
  for (const g of groups) {
    ws.addRow({ customer: g.customer_name });
    for (const it of g.items) {
      ws.addRow({
        trans_date: mdy(it.trans_date), trans_no: it.trans_no || '', bs_no: it.bs_no || '',
        memo: it.memo || '', po_no: it.po_no || '', date_due: mdy(it.date_due), age: num(it.age),
        open_balance: num(it.open_balance), sales_rep: it.sales_rep || '', location: it.location_name || '',
      });
    }
    ws.addRow({ customer: `Total - ${g.customer_name}`, open_balance: Math.round(num(g.total_balance) * 100) / 100 });
    grand += num(g.total_balance);
  }
  ws.addRow({ customer: 'Total', open_balance: Math.round(grand * 100) / 100 });
  finish(ws, ['open_balance'], 'K');
  return wb;
}

// AP Aging Details: every open payables item behind AP Aging, grouped by vendor with a total under
// each -- the columns of a vendor's Details on the page, plus the vendor.
function apAgingDetailsWorkbook(items, asOf, daysOverdue) {
  const wb = new ExcelJS.Workbook();
  const ws = sheet(wb, 'AP Aging Details', [
    { header: 'Vendor', key: 'vendor', width: 40 },
    { header: 'Type', key: 'type', width: 16 },
    { header: 'Reference', key: 'reference', width: 16 },
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Due Date', key: 'due_date', width: 12 },
    { header: 'Days Overdue', key: 'days_overdue', width: 12 },
    { header: 'Original', key: 'original_amount', width: 16 },
    { header: 'Balance', key: 'balance', width: 16 },
    { header: 'PO #', key: 'po_no', width: 16 },
    { header: 'Ref #', key: 'ref_no', width: 16 },
    { header: 'Memo', key: 'memo', width: 40 },
    { header: 'Location', key: 'location', width: 20 },
  ]);
  const byVendor = new Map();
  for (const it of items) {
    const k = it.supplier_name || '(no vendor)';
    if (!byVendor.has(k)) byVendor.set(k, []);
    byVendor.get(k).push(it);
  }
  let grand = 0;
  for (const name of [...byVendor.keys()].sort((a, b) => a.localeCompare(b))) {
    const list = byVendor.get(name)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.reference).localeCompare(String(b.reference)));
    let sub = 0;
    for (const it of list) {
      ws.addRow({
        vendor: name, type: it.type || '', reference: it.reference || '', date: day(it.date), due_date: day(it.due_date),
        days_overdue: daysOverdue(it), original_amount: num(it.original_amount), balance: num(it.balance),
        po_no: it.po_no || '', ref_no: it.ref_no || '', memo: it.memo || '', location: it.location_name || '',
      });
      sub += num(it.balance);
    }
    ws.addRow({ vendor: `${name} -- total`, balance: Math.round(sub * 100) / 100 }).font = { bold: true };
    grand += sub;
  }
  ws.addRow({ vendor: `GRAND TOTAL (as of ${day(asOf)})`, balance: Math.round(grand * 100) / 100 }).font = { bold: true };
  finish(ws, ['original_amount', 'balance'], 'L');
  return wb;
}

async function sendWorkbook(res, wb, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

module.exports = { arAgingWorkbook, apAgingWorkbook, arAgingDetailsWorkbook, apAgingDetailsWorkbook, sendWorkbook };
