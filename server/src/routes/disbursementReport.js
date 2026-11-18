const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

// Every disbursement that left the company in a date range -- Cheques and Bill Payments together,
// on the day the money was RELEASED rather than the day the document was raised. Those are
// different days by design: a payment is prepared, approved, and only then handed over.
//
// Its own permission page rather than borrowing Cheques' or Bill Payments'. This lists what was
// paid to whom across both, which is the treasurer's and the auditor's question; being able to
// read that is not the same right as being able to raise a payment.
const ROUTE = '/reports/disbursement';

// THE TWO SOURCES DO NOT OVERLAP. Checked before unioning them: of 868 bill payments, ZERO carry a
// check_no that matches any cheque's cheque_number, so the same disbursement cannot appear twice.
// They are separate populations -- cheques are raised directly, bill payments settle vendor bills.
//
// Voided is excluded on both sides. A voided cheque never left the building, and a report of money
// paid out that counts them overstates the period. The two tables spell it differently -- cheques
// use 'void', bill_payments use 'voided' -- which is why this is not one shared constant.
const SELECT_SQL = `
  SELECT 'Cheque' AS source, c.date_released, c.payee_name AS payee, c.date_created,
         c.cheque_number AS cheque_no, c.memo,
         coa.account_code, coa.account_name,
         c.total_amount AS amount, c.cheque_no AS doc_no,
         -- Who was paid, for the Supplier / Employee filter: a cheque names its payee's kind.
         CASE WHEN c.payee_type IN ('VENDOR', 'supplier') THEN 'supplier'
              WHEN c.payee_type = 'EMPLOYEE' THEN 'employee'
              WHEN c.payee_type = 'CUSTOMER' THEN 'customer' END AS payee_kind,
         c.payee_id
    FROM cheques c
    LEFT JOIN chart_of_accounts coa ON coa.id = c.account_id
   WHERE c.date_released IS NOT NULL AND c.status <> 'void'
     AND c.date_released BETWEEN ? AND ?

  UNION ALL

  -- The BANK account, not the A/P account: a disbursement report is about which account the money
  -- came out of. ap_account_id is the liability being settled, which is a different question.
  SELECT 'Bill Payment', bp.date_released, bp.payee_name, bp.date_created,
         bp.check_no, bp.memo,
         coa2.account_code, coa2.account_name,
         bp.total_amount, bp.bill_payment_no,
         -- A bill payment always settles a supplier's bills.
         'supplier', bp.supplier_id
    FROM bill_payments bp
    LEFT JOIN chart_of_accounts coa2 ON coa2.id = bp.bank_account_id
   WHERE bp.date_released IS NOT NULL AND bp.status <> 'voided'
     AND bp.date_released BETWEEN ? AND ?
`;

function range(query) {
  const today = new Date().toISOString().slice(0, 10);
  const from = String(query.from || '').slice(0, 10) || today;
  const to = String(query.to || '').slice(0, 10) || today;
  // Swapped dates would silently return nothing; answering the range they meant is kinder than
  // an empty report that looks like "nothing was paid".
  return from <= to ? { from, to } : { from: to, to: from };
}

// Supplier / Employee filter (asked 2026-10-02): payee_type narrows to one kind, payee_id to one
// supplier or employee within it. 115 employee cheques carry only a typed payee name and no
// employee id, so they show under Employee but never under one chosen employee.
const PAYEE_KINDS = ['supplier', 'employee', 'customer'];
function payeeFilter(query) {
  const kind = PAYEE_KINDS.includes(String(query.payee_type)) ? String(query.payee_type) : null;
  const id = kind && Number(query.payee_id) > 0 ? Number(query.payee_id) : null;
  return { kind, id };
}

async function fetchRows({ from, to }, { kind, id } = {}) {
  const where = [];
  const params = [from, to, from, to];
  if (kind) { where.push('d.payee_kind = ?'); params.push(kind); }
  if (id) { where.push('d.payee_id = ?'); params.push(id); }
  const [rows] = await pool.query(
    `SELECT * FROM (${SELECT_SQL}) d ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY d.date_released, d.payee, d.cheque_no`,
    params,
  );
  return rows;
}

// How much of the picture is missing. A bill payment with no Date Released has not been released
// as far as this system knows, so it is correctly absent -- but someone reconciling a month needs
// to be told that rather than left to assume the report is complete. Cheques all carry one.
async function pendingCount() {
  const [[r]] = await pool.query(
    "SELECT COUNT(*) AS n FROM bill_payments WHERE date_released IS NULL AND status <> 'voided'",
  );
  return Number(r.n) || 0;
}

// The Payee picker: only suppliers / employees who have actually been paid by cheque or bill
// payment, so the list is short and nothing in it returns an empty report. Under the report's own
// permission -- a treasurer reading this need not hold the Suppliers or Employees master lists.
router.get('/payees', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const kind = String(req.query.type);
    let rows;
    if (kind === 'supplier') {
      [rows] = await pool.query(
        `SELECT s.id, s.name FROM suppliers s
          WHERE s.id IN (SELECT payee_id FROM cheques WHERE payee_type IN ('VENDOR', 'supplier') AND payee_id IS NOT NULL)
             OR s.id IN (SELECT supplier_id FROM bill_payments WHERE supplier_id IS NOT NULL)
          ORDER BY s.name`);
    } else if (kind === 'employee') {
      [rows] = await pool.query(
        `SELECT e.id, TRIM(CONCAT(COALESCE(e.first_name, ''), ' ', COALESCE(e.last_name, ''))) AS name FROM employees e
          WHERE e.id IN (SELECT payee_id FROM cheques WHERE payee_type = 'EMPLOYEE' AND payee_id IS NOT NULL)
          ORDER BY e.first_name, e.last_name`);
    } else {
      return res.status(400).json({ error: 'type must be supplier or employee' });
    }
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { from, to } = range(req.query);
    const rows = await fetchRows({ from, to }, payeeFilter(req.query));
    res.json({
      from,
      to,
      rows,
      total_amount: rows.reduce((s, r) => s + Number(r.amount || 0), 0),
      bill_payments_without_release_date: await pendingCount(),
    });
  } catch (err) {
    next(err);
  }
});

// Dates are written as plain YYYY-MM-DD TEXT rather than Excel dates, the same choice
// lib/artistIncentiveWorkbook.js documents: an Excel date is a timezone-less serial filled from a
// JS Date, and every conversion in that chain is a chance to land on the previous day. The report
// only ever shows the day, and YYYY-MM-DD sorts correctly as text.
const day = (v) => (v ? String(v).slice(0, 10) : '');

router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { from, to } = range(req.query);
    const rows = await fetchRows({ from, to }, payeeFilter(req.query));

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Disbursement');

    // The six columns asked for, in that order. Source and Amount follow them rather than
    // replacing any: a reader needs to know whether a line was a cheque or a bill payment, and a
    // disbursement report nobody can total is half a report.
    ws.columns = [
      { header: 'Date released', key: 'date_released', width: 14 },
      { header: 'Payee', key: 'payee', width: 38 },
      { header: 'Date Created', key: 'date_created', width: 14 },
      { header: 'Cheque No.', key: 'cheque_no', width: 16 },
      { header: 'Account', key: 'account', width: 34 },
      { header: 'Memo', key: 'memo', width: 60 },
      { header: 'Source', key: 'source', width: 14 },
      { header: 'Amount', key: 'amount', width: 15 },
    ];
    ws.getRow(1).font = { bold: true };

    rows.forEach((r) => {
      ws.addRow({
        date_released: day(r.date_released),
        payee: r.payee || '',
        date_created: day(r.date_created),
        cheque_no: r.cheque_no || '',
        account: r.account_code ? `${r.account_code} — ${r.account_name}` : (r.account_name || ''),
        memo: r.memo || '',
        source: r.source,
        // A number with a display format, never a preformatted string: the first thing anyone
        // does to a disbursement sheet is total the column.
        amount: Number(r.amount || 0),
      });
    });
    ws.getColumn('amount').numFmt = '#,##0.00';
    ws.autoFilter = { from: 'A1', to: `H${rows.length + 1}` };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="disbursement-${from}-to-${to}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
