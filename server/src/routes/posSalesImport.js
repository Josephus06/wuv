// Sales Invoices > Import POS Sales: one invoice per POS shift from its CATEGORY SALES report, paid
// from the same shift's Z-READING (lib/posSalesImport.js has the rules).
//
//   POST /preview   the PDFs -> each shift's lines, new items, payments, warnings; nothing is saved
//   POST /          the same PDFs + customer / branch / department -> the invoices. The PDFs are read
//                   again rather than trusting figures sent back from the browser, and every shift is
//                   its own transaction, so one bad shift does not undo the others.
const express = require('express');
const multer = require('multer');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { assertPeriodOpen } = require('../lib/accountingPeriod');
const { extractPdfText } = require('../lib/posCategorySales');
const { readReport, buildShifts, importShift } = require('../lib/posSalesImport');
const { parseDailySummary } = require('../lib/posDailySummary');

const router = express.Router();
const ROUTE = '/sales-invoices';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 124 },
  fileFilter: (req, file, cb) => {
    // POS reports as PDF; the salons' daily sales sheet as an Excel workbook.
    if (file.mimetype === 'application/pdf' || /\.(pdf|xlsx)$/i.test(file.originalname)) return cb(null, true);
    cb(new Error('Only PDF reports and .xlsx daily sales sheets can be imported.'));
  },
});

async function readFiles(files) {
  const reports = [];
  for (const file of files) {
    // A daily sales sheet (lib/posDailySummary.js): every dated row is a day of its own.
    if (/\.xlsx$/i.test(file.originalname)) {
      let days;
      try { days = parseDailySummary(file.buffer, file.originalname); } catch (e) { days = [{ ok: false, errors: [`Could not read the workbook: ${e.message}`] }]; }
      for (const d of days) {
        reports.push({ source_file: `${file.originalname}${d.closed_date ? ` (${d.closed_date})` : ''}`, kind: d.ok ? 'daily' : 'unknown', parsed: d });
      }
      continue;
    }
    let text = '';
    try { text = await extractPdfText(file.buffer); } catch { text = ''; }
    if (text.replace(/\s/g, '').length < 100) {
      reports.push({ source_file: file.originalname, kind: 'unknown', parsed: { ok: false, errors: ['This PDF has no text in it (a scan or photo) -- export the report from the POS as a PDF.'] } });
      continue;
    }
    reports.push({ source_file: file.originalname, ...readReport(text) });
  }
  return reports;
}

router.post('/preview', requireAuth, requirePermission(ROUTE, 'can_add'), upload.array('files', 124), async (req, res, next) => {
  try {
    if (!(req.files || []).length) return res.status(400).json({ error: 'Attach the Category Sales (and Z-Reading) PDFs.' });
    res.json(await buildShifts(pool, await readFiles(req.files)));
  } catch (err) { next(err); }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), upload.array('files', 124), async (req, res, next) => {
  try {
    const customerId = Number(req.body.customer_id) || null;
    const locationId = Number(req.body.office_location_id) || null;
    const departmentId = Number(req.body.department_id) || null;
    const salesRepId = Number(req.body.sales_rep_id) || null;
    if (!customerId) return res.status(400).json({ error: 'Select the customer the sales are recorded against.' });
    if (!locationId) return res.status(400).json({ error: 'Select the branch -- it puts these sales in its company\'s books.' });
    if (!departmentId) return res.status(400).json({ error: 'Select the department these sales belong to.' });
    const { shifts } = await buildShifts(pool, await readFiles(req.files || []));
    const results = [];
    for (const shift of shifts) {
      if (!shift.ok) { results.push({ key: shift.key, ok: false, errors: shift.errors }); continue; }
      const conn = await pool.getConnection();
      try {
        await assertPeriodOpen(shift.date, 'ar', conn);
        await conn.beginTransaction();
        const inv = await importShift(conn, shift, { customerId, locationId, departmentId, salesRepId, userId: req.user.id });
        await conn.commit();
        results.push({ key: shift.key, ok: true, invoice: inv });
      } catch (err) {
        await conn.rollback().catch(() => {});
        results.push({ key: shift.key, ok: false, errors: [err.code === 'ER_DUP_ENTRY' ? 'Already imported.' : err.message] });
      } finally { conn.release(); }
    }
    res.json({ results });
  } catch (err) { next(err); }
});

module.exports = router;
