const ExcelJS = require('exceljs');

// Estimate > Extract (asked 2026-11-11): one sheet laid out as the sales team's own workbook --
// Date / Customer Name / Location / Sales Rep at the top, then each job line as its own block: the
// job line's header and values, then its processes under a second header, two blank rows between
// lines. Amounts are numbers so the sheet can be totalled.

const JOB_COLUMNS = [
  ['#', (j) => j.line_no],
  ['Job Type', (j) => j.job_type_name],
  ['NSTDJO#', (j) => j.nstdjo_no],
  ['Job Location', (j) => j.job_location_name],
  ['Description', (j) => j.description],
  ['Qty', (j) => j.quantity, 'qty'],
  ['Units', (j) => j.units],
  ['Price/Unit', (j) => j.price_per_unit, 'money'],
  ['Subtotal', (j) => j.subtotal, 'money'],
  ['Disc.%', (j) => j.disc_percent, 'money'],
  ['Disc. Amt', (j) => j.disc_amount, 'money'],
  ['Disc.', (j) => j.disc_price_per_unit, 'money'],
  ['Gross Amt', (j) => j.gross_amount, 'money'],
  ['Length', (j) => j.length, 'qty'],
  ['Width', (j) => j.width, 'qty'],
  ['Height', (j) => j.height, 'qty'],
  ['UOM', (j) => j.uom],
  ['GP Rate', (j) => j.gp_rate, 'money'],
];

const PROCESS_COLUMNS = [
  ['#', (p) => p.line_no],
  ['Process', (p) => p.process_name],
  ['Process Qty', (p) => p.process_qty, 'qty'],
  ['Process UOM', (p) => p.process_uom],
  ['Item', (p) => p.item_name],
  ['Length', (p) => p.length, 'qty'],
  ['Width', (p) => p.width, 'qty'],
  ['UOM', (p) => p.uom],
  ['Qty', (p) => p.qty, 'qty'],
  ['Total', (p) => p.total, 'qty'],
  ['Unit', (p) => p.unit],
  ['Process Price', (p) => p.process_price, 'money'],
  ['Process Disc. Amt', (p) => p.process_disc_amount, 'money'],
  ['Disc. Process Price', (p) => p.disc_process_price, 'money'],
  ['Material Price', (p) => p.material_price, 'money'],
  ['Material Disc. Amt', (p) => p.material_disc_amount, 'money'],
  ['Disc. Material', (p) => p.disc_material_price, 'money'],
  ['Total Price', (p) => p.total_price, 'money'],
];

const WIDTHS = [5, 26, 14, 16, 42, 9, 9, 13, 12, 11, 11, 12, 13, 12, 12, 12, 12, 13];
const FMT = { money: '#,##0.00', qty: '#,##0.####' };
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7E6E6' } };

const asNumber = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? v ?? null : Number(v));
const day = (v) => {
  if (!v) return '';
  const s = String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
  const [y, m, d] = s.split('-');
  return `${m}/${d}/${y}`;
};

function headerRow(ws, labels, underline) {
  const row = ws.addRow(labels);
  row.font = { bold: true };
  row.alignment = { vertical: 'middle', wrapText: true };
  labels.forEach((_, i) => {
    const c = row.getCell(i + 1);
    c.fill = HEADER_FILL;
    if (underline) c.border = { bottom: { style: 'medium' } };
  });
}

function valueRow(ws, columns, rec) {
  const row = ws.addRow(columns.map(([, get, kind]) => (kind ? asNumber(get(rec)) : get(rec) ?? '')));
  row.alignment = { vertical: 'top', wrapText: true };
  columns.forEach(([, , kind], i) => { if (kind) row.getCell(i + 1).numFmt = FMT[kind]; });
}

async function estimateWorkbook({ estimate, jobOrders }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Estimate');
  ws.columns = WIDTHS.map((width) => ({ width }));

  headerRow(ws, ['Date', 'Customer Name', 'Location', 'Sales Rep']);
  ws.addRow([day(estimate.date_created), estimate.customer_name || '', estimate.office_location_name || '', estimate.sales_rep_name || ''])
    .alignment = { vertical: 'top', wrapText: true };
  ws.addRow([]);
  ws.addRow([]);

  jobOrders.forEach((jo, n) => {
    if (n) { ws.addRow([]); ws.addRow([]); }
    headerRow(ws, JOB_COLUMNS.map(([label]) => label));
    valueRow(ws, JOB_COLUMNS, jo);
    ws.addRow([]);
    headerRow(ws, PROCESS_COLUMNS.map(([label]) => label), true);
    for (const p of jo.processes || []) valueRow(ws, PROCESS_COLUMNS, p);
  });
  return wb;
}

async function sendEstimateXlsx(res, loaded) {
  const wb = await estimateWorkbook(loaded);
  const no = loaded.estimate.estimate_no || `estimate-${loaded.estimate.id}`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${String(no).replace(/[^\w.-]/g, '_')}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

module.exports = { sendEstimateXlsx, estimateWorkbook };
