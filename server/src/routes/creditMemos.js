const express = require('express');
const pool = require('../db');
const { grossDueSql, grossDue } = require('../lib/invoiceDue');
const { assignDocNo } = require('../lib/docNumber');
const { requireAuth, requirePermission, userCan } = require('../middleware/auth');
const { assertPeriodOpen } = require('../lib/accountingPeriod');
const { computeCreditMemoGl } = require('../lib/glImpact');
const ExcelJS = require('exceljs');

const { getSalesRepEmployeeScope } = require('../lib/salesVisibility');
const { lineDepartmentError } = require('../lib/requireDepartment');

const router = express.Router();
// Reached from an Open Invoice's "Credit Memo" button -- the AR mirror of Bill Credit,
// but with sales-shaped lines rather than GL-account expense rows, because crediting a
// customer reverses goods or services sold and so has to reverse revenue and output VAT
// line by line.
const ROUTE = '/credit-memos';

async function logAudit(conn, { memoId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('CreditMemo', ?, ?, ?, ?, ?, ?)`,
    [memoId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// Identical arithmetic to a Delivery Ticket line -- recomputed server-side from the four
// editable inputs rather than trusting the browser's preview.
function computeLineAmounts({ quantity, pricePerUnit, discPercent, taxRate }) {
  const qty = Number(quantity || 0);
  const price = Number(pricePerUnit || 0);
  const pct = Number(discPercent || 0);
  const subtotal = Number((price * qty).toFixed(2));
  const discAmount = Number((subtotal * (pct / 100)).toFixed(2));
  const discPerUnit = Number((price * (pct / 100)).toFixed(4));
  const discPricePerUnit = Number((price - discPerUnit).toFixed(4));
  const netOfTax = Number((subtotal - discAmount).toFixed(2));
  const taxAmount = Number((netOfTax * (Number(taxRate || 0) / 100)).toFixed(2));
  const grossAmount = Number((netOfTax + taxAmount).toFixed(2));
  return {
    subtotal, disc_amount: discAmount, disc_per_unit: discPerUnit, disc_price_per_unit: discPricePerUnit,
    net_of_tax: netOfTax, tax_amount: taxAmount, gross_amount: grossAmount,
  };
}

// The submitted ITEMS lines priced the way both Create and Edit store them.
async function prepareLines(conn, lines) {
  const submitted = (Array.isArray(lines) ? lines : []).filter((l) => Number(l.quantity) > 0);
  const taxCodes = [...new Set(submitted.map((l) => l.tax_code).filter(Boolean))];
  const taxByCode = new Map();
  if (taxCodes.length) {
    const [rows] = await conn.query('SELECT code, rate FROM taxes WHERE code IN (?)', [taxCodes]);
    rows.forEach((r) => taxByCode.set(r.code, Number(r.rate)));
  }
  const prepared = submitted.map((l, idx) => {
    const quantity = Number(l.quantity);
    const pricePerUnit = Number(l.price_per_unit || 0);
    const discPercent = Number(l.disc_percent || 0);
    return {
      line_no: idx + 1,
      sales_invoice_line_id: l.sales_invoice_line_id || null,
      job_order_id: l.job_order_id || null,
      item_id: l.item_id || null,
      item_name: l.item_name || null,
      description: l.description || null,
      department_id: l.department_id || null,
      quantity,
      units: l.units || null,
      price_per_unit: pricePerUnit,
      disc_percent: discPercent,
      tax_code: l.tax_code || null,
      ...computeLineAmounts({ quantity, pricePerUnit, discPercent, taxRate: taxByCode.get(l.tax_code) || 0 }),
    };
  });
  const sum = (key) => Number(prepared.reduce((acc, l) => acc + Number(l[key] || 0), 0).toFixed(2));
  return {
    prepared,
    totals: { subtotal: sum('subtotal'), discountAmount: sum('disc_amount'), netOfTax: sum('net_of_tax'), taxAmount: sum('tax_amount'), grossAmount: sum('gross_amount') },
  };
}

async function insertLines(conn, memoId, prepared) {
  for (const l of prepared) {
    await conn.query(
      `INSERT INTO credit_memo_lines
         (credit_memo_id, line_no, sales_invoice_line_id, job_order_id, item_id, item_name, description,
          department_id, quantity, units, price_per_unit, subtotal, disc_percent, disc_per_unit, disc_amount,
          disc_price_per_unit, net_of_tax, tax_code, tax_amount, gross_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        memoId, l.line_no, l.sales_invoice_line_id, l.job_order_id, l.item_id, l.item_name, l.description,
        l.department_id, l.quantity, l.units, l.price_per_unit, l.subtotal, l.disc_percent, l.disc_per_unit,
        l.disc_amount, l.disc_price_per_unit, l.net_of_tax, l.tax_code, l.tax_amount, l.gross_amount,
      ]
    );
  }
}

// Every invoice a memo is applied to must be that customer's -- the customer it is BILLED to first (2026-10-19:
// CM-5695 for FILINVEST could not apply to INV-81555..81558, ordered under MACTAN SEASCAPES).
async function assertInvoicesBelongTo(conn, applyLines, customerId) {
  for (const l of applyLines) {
    const [[a]] = await conn.query(
      `SELECT COALESCE(s2.customer_id, so.customer_id, e.customer_id, ns.customer_id) AS customer_id
         FROM sales_invoices s2 LEFT JOIN sales_orders so ON so.id = s2.sales_order_id
         LEFT JOIN estimates e ON e.id = s2.estimate_id LEFT JOIN non_standard_sales_orders ns ON ns.id = s2.nsso_id
        WHERE s2.id = ?`, [l.sales_invoice_id]);
    if (!a || Number(a.customer_id) !== Number(customerId)) {
      throw Object.assign(new Error('One of the invoices to apply to belongs to a different customer.'), { status: 400 });
    }
  }
}

// Undo one application: the money goes back on the invoice (same as Void). Called while the
// application row still exists. The cash balance (amount_due, net of EWT) only takes back what the
// gross balance leaves above the EWT -- undoing the EWT credit on a paid INV-80196 leaves its cash
// balance at 0, with the 430.62 back on its gross Amount Due.
async function unapplyFromInvoice(conn, invoiceId, amount) {
  const [[si]] = await conn.query('SELECT amount_due, ewt_amount FROM sales_invoices WHERE id = ?', [invoiceId]);
  if (!si) return;
  const grossAfter = (await grossDue(conn, invoiceId)) + Number(amount);
  const cap = Math.max(grossAfter - Number(si.ewt_amount || 0), 0);
  const newDue = Number(Math.min(Number(si.amount_due) + Number(amount), cap).toFixed(2));
  await conn.query(
    "UPDATE sales_invoices SET amount_due = ?, status = IF(status = 'paid_in_full' AND ? > 0.005, 'saved', status) WHERE id = ?",
    [newDue, newDue, invoiceId]
  );
}

// Up to the invoice's GROSS Amount Due (lib/invoiceDue.js), not its cash balance: an EWT credit memo
// clears the EWT a customer withheld after paying the rest (CM-5608 on INV-80196). Called before the
// application row is written. The cash balance (amount_due) never goes below zero.
async function applyToInvoice(conn, invoiceId, amount) {
  const [[si]] = await conn.query('SELECT invoice_no, amount_due, status FROM sales_invoices WHERE id = ?', [invoiceId]);
  if (!si) throw Object.assign(new Error('One of the selected invoices is no longer valid.'), { status: 400 });
  if (si.status === 'cancelled') throw Object.assign(new Error(`${si.invoice_no} is void and cannot be credited.`), { status: 409 });
  const due = await grossDue(conn, invoiceId);
  if (amount > due + 1e-9) {
    throw Object.assign(new Error(`Applied Amount (${amount}) exceeds ${si.invoice_no}'s remaining Amount Due (${due.toFixed(2)}).`), { status: 409 });
  }
  const newDue = Math.max(Number((Number(si.amount_due) - amount).toFixed(2)), 0);
  await conn.query(
    "UPDATE sales_invoices SET amount_due = ?, status = IF(? <= 0.005, 'paid_in_full', status) WHERE id = ?",
    [newDue, newDue, invoiceId]
  );
}

// Powers the Credit Memo modal. ITEMS starts empty (the real form's own behaviour -- you
// add exactly what's being credited back via Add Item), but the source invoice's lines
// come along as `invoice_lines` so the form can offer them as a starting point rather
// than making someone retype a line they're crediting in full.
router.get('/for-invoice/:invoiceId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[si]] = await pool.query(
      `SELECT si.id AS sales_invoice_id, si.invoice_no, si.office_location_id, si.memo, si.amount_due,
              si.gross_amount, si.status, COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id) AS customer_id,
              c.name AS customer_name,
              loc.location_name AS office_location_name
       FROM sales_invoices si
       LEFT JOIN sales_orders so ON so.id = si.sales_order_id
       LEFT JOIN estimates e ON e.id = si.estimate_id
       LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id
       LEFT JOIN customers c ON c.id = COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id)
       LEFT JOIN locations loc ON loc.id = si.office_location_id
       WHERE si.id = ?`,
      [req.params.invoiceId]
    );
    if (!si) return res.status(404).json({ error: 'Not found' });
    if (si.status === 'cancelled') return res.status(409).json({ error: 'This Invoice is void and cannot be credited.' });

    const [[arAcct]] = await pool.query("SELECT id, account_code, account_name FROM chart_of_accounts WHERE account_code = '12100'");

    const [invoiceLines] = await pool.query(
      `SELECT sil.id AS sales_invoice_line_id, sil.job_order_id, jo.job_order_no, sil.description,
              sil.quantity, sil.units, sil.price_per_unit, sil.disc_percent, sil.tax_code,
              t.rate AS tax_rate
       FROM sales_invoice_lines sil
       LEFT JOIN job_orders jo ON jo.id = sil.job_order_id
       LEFT JOIN taxes t ON t.code = sil.tax_code
       WHERE sil.sales_invoice_id = ?`,
      [req.params.invoiceId]
    );

    const [applyLines] = await pool.query(
      `SELECT si2.id AS sales_invoice_id, si2.invoice_no, si2.date_created, si2.gross_amount, ${grossDueSql('si2')} AS amount_due
       FROM sales_invoices si2
       JOIN sales_orders so2 ON so2.id = si2.sales_order_id
       WHERE so2.customer_id = ? AND si2.status != 'cancelled' AND ${grossDueSql('si2')} > 0.005
       ORDER BY si2.id DESC`,
      [si.customer_id]
    );

    res.json({
      ...si,
      ar_account_id: arAcct?.id || null,
      ar_account_code: arAcct?.account_code || null,
      ar_account_name: arAcct?.account_name || null,
      invoice_lines: invoiceLines,
      apply_lines: applyLines,
    });
  } catch (err) {
    next(err);
  }
});

// The standalone "Create Credit Memo" page (client/src/pages/CreditMemoForm.jsx): no source invoice,
// just a customer -- the old system's credit_memo_crud screen. Gives the customer's open invoices
// for APPLY, the default A/R account, and the rep the memo will be filed under.
router.get('/for-customer/:customerId', requireAuth, async (req, res, next) => {
  try {
    if (!(await userCan(req.user.id, ROUTE, 'can_add')) && !(await userCan(req.user.id, ROUTE, 'can_edit'))) {
      return res.status(403).json({ error: 'You do not have permission to perform this action' });
    }
    // Editing a memo (?credit_memo_id=): the invoices it already settles are listed too, with what
    // it applied added back to Amount Due -- that is what is available to it once the edit replaces
    // its applications. Without this an invoice the memo paid off in full would vanish from APPLY.
    const editingId = Number(req.query.credit_memo_id) || null;
    const mine = new Map();
    if (editingId) {
      const [apps] = await pool.query(
        'SELECT sales_invoice_id, SUM(applied_amount) AS amt FROM credit_memo_applications WHERE credit_memo_id = ? AND sales_invoice_id IS NOT NULL GROUP BY sales_invoice_id',
        [editingId]);
      apps.forEach((a) => mine.set(a.sales_invoice_id, Number(a.amt)));
    }
    const [[c]] = await pool.query('SELECT id, name, default_sales_rep_id FROM customers WHERE id = ?', [req.params.customerId]);
    if (!c) return res.status(404).json({ error: 'Customer not found.' });
    const [[arAcct]] = await pool.query("SELECT id, account_code, account_name FROM chart_of_accounts WHERE account_code = '12100'");
    const [applyLines] = await pool.query(
      `SELECT si.id AS sales_invoice_id, si.invoice_no, si.bs_si_no, si.date_created, si.gross_amount, ${grossDueSql('si')} AS amount_due
         FROM sales_invoices si
         LEFT JOIN sales_orders so ON so.id = si.sales_order_id
         LEFT JOIN estimates e ON e.id = si.estimate_id
         LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id
        WHERE COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id) = ?
          AND si.status <> 'cancelled' AND (${grossDueSql('si')} > 0.005 OR si.id IN (?))
        ORDER BY si.date_created DESC, si.id DESC`, [c.id, mine.size ? [...mine.keys()] : [0]]);
    applyLines.forEach((l) => { l.amount_due = Number((Number(l.amount_due) + (mine.get(l.sales_invoice_id) || 0)).toFixed(2)); });
    res.json({
      customer_id: c.id, customer_name: c.name,
      ar_account_id: arAcct?.id || null, ar_account_code: arAcct?.account_code || null, ar_account_name: arAcct?.account_name || null,
      apply_lines: applyLines,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/by-invoice/:invoiceId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    // RAISED FROM the invoice, or APPLIED TO it. Only the first was asked for, and the second is
    // how most credits actually reach an invoice: a memo raised from Credit Memos > Add carries no
    // sales_invoice_id at all and does its work through credit_memo_applications. The invoice then
    // read "Paid In Full" with "No payments or credits against this invoice yet" underneath --
    // INV-1703, credited 78.00 by CM-5491, was the report of it.
    //
    // applied_amount is what this memo put against THIS invoice, not the memo's whole applied
    // total: CM-5490 covers three SHEMBERG invoices at 9,722.31, and each of them should show its
    // own share rather than the lot.
    const [rows] = await pool.query(
      `SELECT cm.id, cm.credit_memo_no, cm.date_created, cm.gross_amount, cm.status,
              COALESCE(a.applied_here, 0) AS applied_amount
         FROM credit_memos cm
         LEFT JOIN (SELECT credit_memo_id, SUM(applied_amount) AS applied_here
                      FROM credit_memo_applications WHERE sales_invoice_id = ?
                     GROUP BY credit_memo_id) a ON a.credit_memo_id = cm.id
        WHERE cm.sales_invoice_id = ? OR a.credit_memo_id IS NOT NULL
        ORDER BY cm.id DESC`,
      [req.params.invoiceId, req.params.invoiceId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// The list and its Excel extract read the same filters, so the file always holds what the table shows.
// Period From / As of Date bound date_created, both ends inclusive.
async function listFilter(req) {
  const { search, status, date_from: dateFrom, date_to: dateTo } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('cm.status = ?'); params.push(status); }
  if (dateFrom) { where.push('cm.date_created >= ?'); params.push(dateFrom); }
  if (dateTo) { where.push('cm.date_created <= ?'); params.push(dateTo); }
  // An Account Officer sees only their own credit memos; a Supervisor sees theirs plus their
  // reports'. Same rule Estimates and Sales Orders already apply -- see lib/salesVisibility.js,
  // which returns null (and so changes nothing) for every account that is neither.
  const salesScope = await getSalesRepEmployeeScope(req.user.id, ROUTE);
  if (salesScope) { where.push('cm.sales_rep_id IN (?)'); params.push(salesScope); }
  if (search) {
    where.push('(cm.credit_memo_no LIKE ? OR c.name LIKE ? OR si.invoice_no LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { whereSql, params } = await listFilter(req);
    const [rows] = await pool.query(
      `SELECT cm.id, cm.credit_memo_no, cm.date_created, cm.gross_amount, cm.applied_amount, cm.status,
              cm.customer_id, c.name AS customer_name, si.invoice_no
       FROM credit_memos cm
       LEFT JOIN customers c ON c.id = cm.customer_id
       LEFT JOIN sales_invoices si ON si.id = cm.sales_invoice_id
       ${whereSql}
       ORDER BY cm.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Registered before /:id, which would otherwise take "export" as a credit memo id.
router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { whereSql, params } = await listFilter(req);
    const [rows] = await pool.query(
      `SELECT cm.credit_memo_no, cm.date_created, cm.gross_amount, cm.applied_amount, cm.status, cm.memo,
              c.name AS customer_name, si.invoice_no
       FROM credit_memos cm
       LEFT JOIN customers c ON c.id = cm.customer_id
       LEFT JOIN sales_invoices si ON si.id = cm.sales_invoice_id
       ${whereSql}
       ORDER BY cm.date_created DESC, cm.id DESC`,
      params
    );

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="credit-memos.xlsx"');
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
    const ws = wb.addWorksheet('Credit Memos', { views: [{ state: 'frozen', ySplit: 1 }] });
    const money = { numFmt: '#,##0.00' };
    // The list's columns, in its order, plus Memo.
    ws.columns = [
      { header: 'Credit Memo #', key: 'no', width: 18 },
      { header: 'Date Created', key: 'date', width: 13 },
      { header: 'Customer', key: 'customer', width: 38 },
      { header: 'Invoice #', key: 'invoice', width: 16 },
      { header: 'Gross Amount', key: 'gross', width: 16, style: money },
      { header: 'Applied', key: 'applied', width: 16, style: money },
      { header: 'Remaining', key: 'remaining', width: 16, style: money },
      { header: 'Status', key: 'status', width: 10 },
      { header: 'Memo', key: 'memo', width: 40 },
    ];
    ws.autoFilter = 'A1:I1';
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).commit();

    const STATUS = { open: 'Open', voided: 'Void' };
    const day = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : '');
    for (const r of rows) {
      const gross = Number(r.gross_amount || 0); const applied = Number(r.applied_amount || 0);
      ws.addRow({
        no: r.credit_memo_no, date: day(r.date_created), customer: r.customer_name || '',
        invoice: r.invoice_no || '', gross, applied, remaining: gross - applied,
        status: STATUS[r.status] || r.status, memo: r.memo || '',
      }).commit();
    }
    ws.commit();
    await wb.commit();
  } catch (err) {
    // Once streaming has begun the status line is gone; cut the download short so a partial
    // file cannot pass for a complete one.
    if (res.headersSent) { res.destroy(err); return; }
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[cm]] = await pool.query(
      `SELECT cm.*, c.name AS customer_name, si.invoice_no, loc.location_name AS office_location_name,
              coa.account_code AS ar_account_code, coa.account_name AS ar_account_name,
              u.display_name AS created_by_name,
              CONCAT(e.first_name, ' ', e.last_name) AS sales_rep_name
       FROM credit_memos cm
       LEFT JOIN customers c ON c.id = cm.customer_id
       LEFT JOIN employees e ON e.id = cm.sales_rep_id
       LEFT JOIN sales_invoices si ON si.id = cm.sales_invoice_id
       LEFT JOIN locations loc ON loc.id = cm.office_location_id
       LEFT JOIN chart_of_accounts coa ON coa.id = cm.ar_account_id
       LEFT JOIN users u ON u.id = cm.created_by_user_id
       WHERE cm.id = ?`,
      [req.params.id]
    );
    if (!cm) return res.status(404).json({ error: 'Not found' });
    // Defence in depth for the list filter above: hiding a document from the list while still
    // serving it to anyone who types its id is not a restriction. See lib/salesVisibility.js.
    const salesScope = await getSalesRepEmployeeScope(req.user.id, ROUTE);
    if (salesScope && !salesScope.includes(cm.sales_rep_id)) {
      return res.status(404).json({ error: 'Not found' });
    }

    const [lines] = await pool.query(
      `SELECT cml.*, jo.job_order_no, d.name AS department_name
       FROM credit_memo_lines cml
       LEFT JOIN job_orders jo ON jo.id = cml.job_order_id
       LEFT JOIN departments d ON d.id = cml.department_id
       WHERE cml.credit_memo_id = ? ORDER BY cml.line_no`,
      [req.params.id]
    );

    const [applications] = await pool.query(
      // COALESCE: an application may point at an invoice this database does not hold, in
      // which case only the number live recorded is available.
      `SELECT cma.*, COALESCE(si.invoice_no, cma.invoice_no) AS invoice_no,
              si.date_created AS invoice_date, si.gross_amount AS invoice_gross
       FROM credit_memo_applications cma
       LEFT JOIN sales_invoices si ON si.id = cma.sales_invoice_id
       WHERE cma.credit_memo_id = ?`,
      [req.params.id]
    );

    const glImpact = await computeCreditMemoGl(cm, lines, applications);
    res.json({ ...cm, lines, applications, gl_impact: glImpact });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'CreditMemo' AND a.auditable_id = ?
       ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const {
      sales_invoice_id: salesInvoiceId, customer_id: bodyCustomerId, date_created: dateCreated, office_location_id: officeLocationId,
      ar_account_id: arAccountId, memo, lines, apply_lines: applyLines,
    } = req.body;
    // Raised from an invoice (its customer), or on its own from Credit Memos > Add (a customer,
    // no source invoice) -- the old system allows both.
    if (!salesInvoiceId && !bodyCustomerId) return res.status(400).json({ error: 'Choose the Customer.' });

    let si;
    if (salesInvoiceId) {
      [[si]] = await conn.query(
        `SELECT si.id, si.status, si.sales_rep_id, COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id) AS customer_id
           FROM sales_invoices si
           LEFT JOIN sales_orders so ON so.id = si.sales_order_id
           LEFT JOIN estimates e ON e.id = si.estimate_id
           LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id
          WHERE si.id = ?`,
        [salesInvoiceId]
      );
      if (!si) return res.status(404).json({ error: 'Invoice not found.' });
      if (si.status === 'cancelled') return res.status(409).json({ error: 'This Invoice is void and cannot be credited.' });
    } else {
      const [[cust]] = await conn.query('SELECT id, default_sales_rep_id FROM customers WHERE id = ?', [bodyCustomerId]);
      if (!cust) return res.status(404).json({ error: 'Customer not found.' });
      si = { id: null, customer_id: cust.id, sales_rep_id: cust.default_sales_rep_id || null };
    }

    const { prepared, totals: { subtotal, discountAmount, netOfTax, taxAmount, grossAmount } } = await prepareLines(conn, lines);
    if (!prepared.length) return res.status(400).json({ error: 'Add at least one item to credit.' });
    // The department lives on the lines here (credit_memo_lines.department_id), not the header.
    const deptError = lineDepartmentError(prepared);
    if (deptError) return res.status(400).json({ error: deptError });

    // The memo can only offset as much as it's actually worth. The real system lets you
    // apply the source invoice's full total regardless of what ITEMS adds up to and saves
    // with a negative Unapplied Amount -- that's an accounting error, so this rejects it
    // (see the note above credit_memos in schema.sql).
    const submittedApply = (Array.isArray(applyLines) ? applyLines : []).filter((l) => l.sales_invoice_id && Number(l.applied_amount) > 0);
    const appliedTotal = Number(submittedApply.reduce((s, l) => s + Number(l.applied_amount), 0).toFixed(2));
    if (appliedTotal > grossAmount + 1e-9) {
      return res.status(409).json({
        error: `Applied Amount (${appliedTotal}) exceeds this Credit Memo's own total (${grossAmount}). Add the items you're crediting, or lower what you're applying.`,
      });
    }
    await assertPeriodOpen(dateCreated, 'ar', conn);

    await assertInvoicesBelongTo(conn, submittedApply, si.customer_id);

    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO credit_memos
         (credit_memo_no, sales_invoice_id, customer_id, sales_rep_id, date_created, office_location_id, ar_account_id, memo,
          subtotal, discount_amount, net_of_tax, tax_amount, gross_amount, applied_amount, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        si.id, si.customer_id, si.sales_rep_id || null, dateCreated || new Date().toISOString().slice(0, 10),
        officeLocationId || null, arAccountId || null, memo || null,
        subtotal, discountAmount, netOfTax, taxAmount, grossAmount, appliedTotal, req.user.id,
      ]
    );
    const memoId = result.insertId;
    const memoNo = await assignDocNo(conn, { table: 'credit_memos', column: 'credit_memo_no', prefix: 'CM-', id: memoId });

    await insertLines(conn, memoId, prepared);

    for (const l of submittedApply) {
      await applyToInvoice(conn, l.sales_invoice_id, Number(l.applied_amount));
      await conn.query(
        'INSERT INTO credit_memo_applications (credit_memo_id, sales_invoice_id, applied_amount) VALUES (?, ?, ?)',
        [memoId, l.sales_invoice_id, l.applied_amount]
      );
    }

    await logAudit(conn, { memoId, userId: req.user.id, eventType: 'Created', fieldName: 'credit_memo_no', newValue: memoNo });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM credit_memos WHERE id = ?', [memoId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    conn.release();
  }
});

// Edit a saved Credit Memo: header (date, office location, memo), its ITEMS and its APPLY lines.
// The customer and source invoice stay as created. Its old invoice applications are reversed and the
// new ones applied in one transaction, so every invoice's Amount Due ends where the edited memo
// leaves it. Whatever Customer Payments have drawn on the memo stays drawn, and the new total must
// still cover it. The GL is derived from the memo as it stands, so there is nothing to re-post.
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[cm]] = await conn.query('SELECT * FROM credit_memos WHERE id = ?', [req.params.id]);
    if (!cm) return res.status(404).json({ error: 'Not found' });
    if (cm.status === 'voided') return res.status(409).json({ error: 'A voided Credit Memo cannot be edited.' });

    const { date_created: dateCreated, office_location_id: officeLocationId, memo, lines, apply_lines: applyLines } = req.body;
    await assertPeriodOpen(cm.date_created, 'ar', conn);
    if (dateCreated) await assertPeriodOpen(dateCreated, 'ar', conn);

    // A memo migrated from the source holds its header only -- no item lines (all 5,476 of them,
    // 2026-10-05). Edited without lines, it keeps its stored amounts: only the date, location, memo
    // and applications change. Once lines are sent they replace the amounts, as for any other memo.
    const [[{ n: storedLines }]] = await conn.query('SELECT COUNT(*) AS n FROM credit_memo_lines WHERE credit_memo_id = ?', [cm.id]);
    const keepAmounts = Number(storedLines) === 0 && !(Array.isArray(lines) && lines.length);
    let prepared = [];
    let totals;
    if (keepAmounts) {
      totals = {
        subtotal: Number(cm.subtotal || 0), discountAmount: Number(cm.discount_amount || 0), netOfTax: Number(cm.net_of_tax || 0),
        taxAmount: Number(cm.tax_amount || 0), grossAmount: Number(cm.gross_amount || 0),
      };
    } else {
      ({ prepared, totals } = await prepareLines(conn, lines));
      if (!prepared.length) return res.status(400).json({ error: 'Add at least one item to credit.' });
      const deptError = lineDepartmentError(prepared);
      if (deptError) return res.status(400).json({ error: deptError });
    }

    const submittedApply = (Array.isArray(applyLines) ? applyLines : []).filter((l) => l.sales_invoice_id && Number(l.applied_amount) > 0);
    const appliedToInvoices = Number(submittedApply.reduce((acc, l) => acc + Number(l.applied_amount), 0).toFixed(2));
    // Drawn on by Customer Payments, and applications to invoices this database does not hold:
    // neither is touched by an edit, but both still use up the memo.
    const [[drawn]] = await conn.query(
      `SELECT COALESCE(SUM(cpl.applied_amount), 0) AS amt FROM customer_payment_lines cpl
         JOIN customer_payments cp ON cp.id = cpl.customer_payment_id
        WHERE cpl.credit_memo_id = ? AND cp.status != 'voided'`, [cm.id]);
    const [[orphan]] = await conn.query(
      'SELECT COALESCE(SUM(applied_amount), 0) AS amt FROM credit_memo_applications WHERE credit_memo_id = ? AND sales_invoice_id IS NULL', [cm.id]);
    const keptApplied = Number((Number(drawn.amt) + Number(orphan.amt)).toFixed(2));
    const appliedTotal = Number((appliedToInvoices + keptApplied).toFixed(2));
    if (appliedTotal > totals.grossAmount + 1e-9) {
      return res.status(409).json({
        error: keptApplied > 0
          ? `Applied Amount (${appliedTotal}, of which ${keptApplied} is drawn by Customer Payments) exceeds this Credit Memo's new total (${totals.grossAmount}).`
          : `Applied Amount (${appliedTotal}) exceeds this Credit Memo's own total (${totals.grossAmount}).`,
      });
    }
    await assertInvoicesBelongTo(conn, submittedApply, cm.customer_id);

    const [oldApps] = await conn.query(
      'SELECT sales_invoice_id, applied_amount FROM credit_memo_applications WHERE credit_memo_id = ? AND sales_invoice_id IS NOT NULL', [cm.id]);

    await conn.beginTransaction();
    // Undo first, so the new applications are checked against each invoice as if this memo had
    // never touched it.
    for (const a of oldApps) await unapplyFromInvoice(conn, a.sales_invoice_id, a.applied_amount);
    await conn.query('DELETE FROM credit_memo_applications WHERE credit_memo_id = ? AND sales_invoice_id IS NOT NULL', [cm.id]);
    if (!keepAmounts) {
      await conn.query('DELETE FROM credit_memo_lines WHERE credit_memo_id = ?', [cm.id]);
      await insertLines(conn, cm.id, prepared);
    }
    for (const l of submittedApply) {
      await applyToInvoice(conn, l.sales_invoice_id, Number(l.applied_amount));
      await conn.query(
        'INSERT INTO credit_memo_applications (credit_memo_id, sales_invoice_id, applied_amount) VALUES (?, ?, ?)',
        [cm.id, l.sales_invoice_id, l.applied_amount]
      );
    }
    await conn.query(
      `UPDATE credit_memos SET date_created = ?, office_location_id = ?, memo = ?,
         subtotal = ?, discount_amount = ?, net_of_tax = ?, tax_amount = ?, gross_amount = ?, applied_amount = ?
       WHERE id = ?`,
      [dateCreated || cm.date_created, officeLocationId === undefined ? cm.office_location_id : (officeLocationId || null), memo ?? null,
        totals.subtotal, totals.discountAmount, totals.netOfTax, totals.taxAmount, totals.grossAmount, appliedTotal, cm.id]
    );
    const day = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);
    const changes = [
      ['date_created', day(cm.date_created), day(dateCreated || cm.date_created)],
      ['memo', cm.memo || null, memo || null],
      ['gross_amount', Number(cm.gross_amount), totals.grossAmount],
      ['applied_amount', Number(cm.applied_amount), appliedTotal],
    ].filter(([, a, b]) => String(a ?? '') !== String(b ?? ''));
    if (!changes.length) changes.push(['lines', null, 'edited']);
    for (const [field, oldValue, newValue] of changes) {
      await logAudit(conn, { memoId: cm.id, userId: req.user.id, eventType: 'Updated', fieldName: field, oldValue, newValue });
    }
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM credit_memos WHERE id = ?', [cm.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id/void', requireAuth, requirePermission(ROUTE, 'can_void'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[cm]] = await conn.query('SELECT status, date_created FROM credit_memos WHERE id = ?', [req.params.id]);
    if (cm) await assertPeriodOpen(cm.date_created, 'ar', conn);
    if (!cm) return res.status(404).json({ error: 'Not found' });
    if (cm.status === 'voided') return res.status(409).json({ error: 'This Credit Memo is already voided.' });

    // A memo already drawn on by a Customer Payment can't be unwound from here -- that
    // payment's own line would be left pointing at a credit that no longer exists. Void
    // the payment first; this reports which one rather than failing opaquely.
    const [drawnOn] = await conn.query(
      `SELECT cp.customer_payment_no FROM customer_payment_lines cpl
       JOIN customer_payments cp ON cp.id = cpl.customer_payment_id
       WHERE cpl.credit_memo_id = ? AND cp.status != 'voided'`,
      [req.params.id]
    );
    if (drawnOn.length) {
      return res.status(409).json({
        error: `This Credit Memo has been drawn on by ${drawnOn.map((p) => p.customer_payment_no).join(', ')}. Void that payment first.`,
      });
    }

    const [applications] = await conn.query(
      'SELECT sales_invoice_id, applied_amount FROM credit_memo_applications WHERE credit_memo_id = ?',
      [req.params.id]
    );

    await conn.beginTransaction();
    for (const a of applications) {
      if (a.sales_invoice_id) await unapplyFromInvoice(conn, a.sales_invoice_id, a.applied_amount);
    }
    await conn.query("UPDATE credit_memos SET status = 'voided', voided_by_user_id = ?, voided_at = NOW() WHERE id = ?", [req.user.id, req.params.id]);
    await logAudit(conn, { memoId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: 'open', newValue: 'voided' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM credit_memos WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
