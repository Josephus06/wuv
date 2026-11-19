// Accounting reports in Odoo's shape and flow (lib/financialReports.js), mounted at
// /api/reports/fr:
//   GET /api/reports/fr/:key          the report (JSON); ?expand=<line id> returns one folded line's children
//   GET /api/reports/fr/:key/xlsx     the report as an Excel file, every line unfolded
//
// Each report is its own page for permissions (Users & Permissions), registered here the first
// time any of them is asked for -- no migration to run. A new page's viewers are copied from the
// nearest existing report, so whoever could open the Trial Balance can open the Journal Audit.
const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { runReport, reportXlsx } = require('../lib/financialReports');

const router = express.Router();

// key -> the page (route) that grants it, its menu name, and the page its viewers are copied from.
const PAGES = {
  balance_sheet: ['/accounting-reports/balance-sheet', 'Balance Sheet', '/reports/balance-sheet'],
  profit_loss: ['/accounting-reports/profit-and-loss', 'Profit and Loss', '/reports/income-statement'],
  cash_flow: ['/accounting-reports/cash-flow', 'Cash Flow Statement', '/reports/balance-sheet'],
  executive_summary: ['/accounting-reports/executive-summary', 'Executive Summary', '/reports/income-statement'],
  general_ledger: ['/accounting-reports/general-ledger', 'General Ledger', '/reports/general-ledger'],
  trial_balance: ['/accounting-reports/trial-balance', 'Trial Balance', '/reports/trial-balance'],
  journal_audit: ['/accounting-reports/journal-audit', 'Journal Audit', '/reports/general-ledger'],
  check_register: ['/accounting-reports/check-register', 'Check Register', '/reports/general-ledger'],
  partner_ledger: ['/accounting-reports/partner-ledger', 'Partner Ledger', '/reports/ar-aging'],
  aged_receivable: ['/accounting-reports/aged-receivable', 'Aged Receivable', '/reports/ar-aging'],
  aged_payable: ['/accounting-reports/aged-payable', 'Aged Payable', '/reports/ap-aging'],
  invoice_analysis: ['/accounting-reports/invoice-analysis', 'Invoice Analysis', '/sales-invoices'],
  audit_trail: ['/accounting-reports/audit-trail', 'Audit Trail', '/reports/general-ledger'],
};

let registered = null;
function ensurePages() {
  if (!registered) {
    registered = (async () => {
      for (const [route, name, source] of Object.values(PAGES)) {
        let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [route]);
        if (!page) {
          const [[near]] = await pool.query('SELECT sort_order FROM pages WHERE route = ?', [source]);
          const [r] = await pool.query('INSERT INTO pages (name, route, sort_order, is_active) VALUES (?, ?, ?, TRUE)', [name, route, near?.sort_order ?? 0]);
          page = { id: r.insertId };
        }
        await pool.query(
          `INSERT INTO user_page_permissions (user_id, page_id, can_view)
           SELECT u.id, ?, TRUE FROM users u WHERE u.account_type = 'System Admin'
              AND NOT EXISTS (SELECT 1 FROM user_page_permissions x WHERE x.user_id = u.id AND x.page_id = ?)`, [page.id, page.id]);
        await pool.query(
          `INSERT INTO user_page_permissions (user_id, page_id, can_view)
           SELECT upp.user_id, ?, TRUE FROM user_page_permissions upp JOIN pages p ON p.id = upp.page_id
            WHERE p.route = ? AND upp.can_view = TRUE
              AND NOT EXISTS (SELECT 1 FROM user_page_permissions x WHERE x.user_id = upp.user_id AND x.page_id = ?)`,
          [page.id, source, page.id]);
      }
    })().catch((e) => { registered = null; throw e; });
  }
  return registered;
}

// The page behind a report, and whether this user may view it.
async function allowed(req, key) {
  await ensurePages();
  const [[row]] = await pool.query(
    `SELECT upp.can_view FROM user_page_permissions upp JOIN pages p ON p.id = upp.page_id
      WHERE upp.user_id = ? AND p.route = ?`, [req.user.id, PAGES[key][0]]);
  return !!(row && row.can_view);
}

const guard = async (req, res, next) => {
  try {
    if (!PAGES[req.params.key]) return res.status(404).json({ error: 'Unknown report' });
    if (!(await allowed(req, req.params.key))) return res.status(403).json({ error: 'You do not have permission to view this report' });
    next();
  } catch (err) { next(err); }
};

// The menu: which of the reports this user can open (and so registers the pages on first load).
router.get('/', requireAuth, async (req, res, next) => {
  try {
    await ensurePages();
    const [rows] = await pool.query(
      `SELECT p.route FROM user_page_permissions upp JOIN pages p ON p.id = upp.page_id
        WHERE upp.user_id = ? AND upp.can_view = TRUE AND p.route LIKE '/accounting-reports/%'`, [req.user.id]);
    const ok = new Set(rows.map((r) => r.route));
    res.json(Object.entries(PAGES).filter(([, [route]]) => ok.has(route)).map(([key, [route, name]]) => ({ key, route, name })));
  } catch (err) { next(err); }
});

router.get('/:key/xlsx', requireAuth, guard, async (req, res, next) => {
  try {
    const { buffer, filename } = await reportXlsx(req.params.key, req.query);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(buffer));
  } catch (err) { next(err); }
});

router.get('/:key', requireAuth, guard, async (req, res, next) => {
  try {
    res.json(await runReport(req.params.key, req.query));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
module.exports.PAGES = PAGES;
module.exports.ensurePages = ensurePages;
