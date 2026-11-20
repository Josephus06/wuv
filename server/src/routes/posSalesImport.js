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
const { isBirSalesSummary, parseBirSalesSummary } = require('../lib/posBirSalesSummary');
const { currentScope } = require('../lib/requestScope');

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
    // The salons' POS BIR Sales Summary: every day on it pairs with the daily sheet's day (lib/posSalesImport.js).
    if (isBirSalesSummary(text)) {
      const bir = parseBirSalesSummary(text);
      if (!bir.ok) { reports.push({ source_file: file.originalname, kind: 'unknown', parsed: { ok: false, errors: bir.errors } }); continue; }
      for (const d of bir.days) {
        reports.push({ source_file: file.originalname, kind: 'bir', parsed: { ok: true, ...d, store_name: bir.store_name, address: bir.address, tin: bir.tin } });
      }
      continue;
    }
    reports.push({ source_file: file.originalname, ...readReport(text) });
  }
  return reports;
}

// The pickers' lists -- branches, customers, departments -- under this page's own permission. Read
// from /customers and /lookups they needed Customers and Lookups rights too, and a cashier without
// them saw three empty pickers (2026-11-19). Branches follow the topbar company switcher.
router.get('/options', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const scope = currentScope();
    const ids = scope ? [...scope.locationIds].map(Number).filter((n) => n > 0) : null;
    const [branches] = await pool.query(
      `SELECT l.id, l.location_name, l.company_id, c.name AS company_name FROM locations l
         LEFT JOIN companies c ON c.id = l.company_id
        WHERE l.is_active = TRUE ${ids ? `AND l.id IN (${ids.length ? ids.join(',') : 'NULL'})` : ''}
        ORDER BY c.name, l.location_name`);
    const [customers] = await pool.query('SELECT id, name, customer_code FROM customers WHERE is_active = TRUE ORDER BY name');
    const [departments] = await pool.query('SELECT id, name FROM departments WHERE is_active = TRUE ORDER BY name');
    res.json({ branches, customers, departments });
  } catch (err) { next(err); }
});

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
