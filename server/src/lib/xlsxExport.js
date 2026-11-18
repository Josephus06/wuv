const ExcelJS = require('exceljs');

// Stream a one-sheet workbook: bold, frozen, filterable header row; money columns as numbers so
// they can be totalled. columns = [{ header, key, width, money?, numFmt? }], rows = plain objects
// by key. numFmt, when given, overrides money's '#,##0.00' (e.g. '#,##0.0000' for quantities).
async function sendXlsx(res, { filename, sheet, columns, rows }) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
  const ws = wb.addWorksheet(sheet, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({
    header: c.header, key: c.key, width: c.width || 16, ...(c.numFmt ? { style: { numFmt: c.numFmt } } : c.money ? { style: { numFmt: '#,##0.00' } } : {}),
  }));
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).commit();
  for (const r of rows) ws.addRow(r).commit();
  ws.commit();
  await wb.commit();
}

// A DATE column as YYYY-MM-DD whichever way the driver returned it.
const day = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : '');

module.exports = { sendXlsx, day };
