const express = require('express');
const pool = require('../db');
const { PO_TERM_SELECT, PO_TERM_JOINS, termDays } = require('../lib/poTerm');
const { insertNumbered } = require('../lib/docNumber');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { assertPeriodOpen } = require('../lib/accountingPeriod');
const { computeVendorBillGl, vendorBillDebitLines } = require('../lib/glImpact');
const { postReversalJournal, mirror, listReversalJournals } = require('../lib/reversalJournal');
const { postedBillGlRows, billInLedger } = require('../lib/vendorBillReversal');
const { liquidationPostError, liquidationBilling } = require('../lib/liquidationPosting');
const { sendXlsx, day: xlsxDay } = require('../lib/xlsxExport');
const { companyWhere } = require('../lib/requestScope');

const router = express.Router();
// Reached from a Received Purchase Order's "Bill" button, confirmed against the real
// system's Create Vendor Bill modal -- the AP-side counterpart to Sales Invoice.
//
// Or raised on its own (Create New on the list) as a STANDALONE expense bill: a supplier's bill
// with no PO behind it -- rent, utilities, freight, fees. Its supplier is vendor_bills.supplier_id
// and each line debits an expense account instead of billing a received PO line.
const ROUTE = '/vendor-bills';

async function logAudit(conn, { billId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('VendorBill', ?, ?, ?, ?, ?, ?)`,
    [billId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// price_per_unit/disc_percent/tax rate are fixed per-unit rates; Total Disc/Net of Tax/Tax
// Amt/Ext Price (gross) are always recomputed from qty x unit_price, never trusted from the
// client -- mirrors the same discipline used for Sales Invoice's billable-line amounts.
function computeLineAmounts({ unitPrice, discPercent, taxRate, qty }) {
  const subtotal = Number((Number(unitPrice || 0) * qty).toFixed(2));
  const discAmount = Number((subtotal * (Number(discPercent || 0) / 100)).toFixed(2));
  const netOfTax = Number((subtotal - discAmount).toFixed(2));
  const taxAmount = Number((netOfTax * (Number(taxRate || 0) / 100)).toFixed(2));
  const extPrice = Number((netOfTax + taxAmount).toFixed(2));
  return { subtotal, disc_amount: discAmount, net_of_tax: netOfTax, tax_amount: taxAmount, ext_price: extPrice };
}

// A bill line billed AT THE PO'S OWN TERMS -- the PO line's unit price and discount, untouched --
// takes its amounts from the PO line itself, in proportion to the quantity billed, instead of
// re-pricing qty x rate from scratch. The two used to round differently: the PO works a line out
// unrounded and rounds once when it stores it, computeLineAmounts rounds the subtotal, then the
// discount, then the net, then the tax. So billing a whole PO line could come out a centavo or more
// off the PO it was billed from (7 x 1,234.5678 less 12.5%: net 7,561.73 on the PO, 7,561.72 on the
// bill), and a chained discount (10;5;3 = 17.065%) made it likelier. Billing the whole line now
// gives exactly the PO's figures; a part of it gives that share, rounded to the centavo.
// Returns null when the line is not on the PO's own terms, or the PO line carries no stored amounts.
function computeLineFromPoLine(poLine, { unitPrice, discPercent, qty }) {
  const poQty = Number(poLine.qty);
  if (!(poQty > 0) || poLine.net_of_tax == null) return null;
  const same = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) < 0.000001;
  if (!same(unitPrice, poLine.rate) || !same(discPercent, poLine.disc_percent)) return null;
  const share = Number(qty) / poQty;
  const r2 = (v) => Number((Number(v || 0) * share).toFixed(2));
  const netOfTax = r2(poLine.net_of_tax);
  const discAmount = r2(poLine.disc_amount);
  const taxAmount = r2(poLine.tax_amount);
  return {
    subtotal: Number((netOfTax + discAmount).toFixed(2)), disc_amount: discAmount, net_of_tax: netOfTax,
    tax_amount: taxAmount, ext_price: Number((netOfTax + taxAmount).toFixed(2)),
  };
}

// A line priced from the Amount the user typed (net of VAT, after discount) rather than from
// qty x unit price: the Amount is kept exactly and Unit Price follows (Amount / Qty, before the
// discount), so a 4-decimal unit price cannot drift the line by centavos. A line with no quantity
// (some imported ones carry 0) takes the Amount as its unit price.
function computeLineFromAmount({ amount, discPercent, taxRate, qty }) {
  const netOfTax = Number(Number(amount || 0).toFixed(2));
  const d = Number(discPercent || 0);
  const subtotal = d > 0 && d < 100 ? Number((netOfTax / (1 - d / 100)).toFixed(2)) : netOfTax;
  const discAmount = Number((subtotal - netOfTax).toFixed(2));
  const taxAmount = Number((netOfTax * (Number(taxRate || 0) / 100)).toFixed(2));
  const unitPrice = Number(qty) > 0 ? Number((subtotal / Number(qty)).toFixed(4)) : subtotal;
  return { subtotal, disc_amount: discAmount, net_of_tax: netOfTax, tax_amount: taxAmount,
    ext_price: Number((netOfTax + taxAmount).toFixed(2)), unit_price: unitPrice };
}
const hasAmount = (l) => l && l.amount !== undefined && l.amount !== null && l.amount !== '' && Number.isFinite(Number(l.amount));
// A line's withholding: the amount typed for it when one was sent (the supplier's own figure, asked
// for 2026-10-02), else Net of Tax x the bill's withholding rate. Only on a line ticked to withhold;
// never more than the line's net. A NEGATIVE line (a reversal, allowed 2026-10-03) withholds a
// negative amount the same way, so the reversal undoes the withholding too.
function lineWtax(l, netOfTax, wtaxRate) {
  const typed = l && l.wtax_amount !== undefined && l.wtax_amount !== null && l.wtax_amount !== '' && Number.isFinite(Number(l.wtax_amount));
  if (!l?.is_withhold || (!typed && !(wtaxRate > 0))) return { is_withhold: false, wtax_amount: 0 };
  const sign = netOfTax < 0 ? -1 : 1;
  const amount = typed ? Math.abs(Number(l.wtax_amount)) : Math.abs(netOfTax) * wtaxRate / 100;
  return { is_withhold: true, wtax_amount: Number((sign * Math.min(amount, Math.abs(netOfTax))).toFixed(2)) };
}
// A line's VAT: the Tax Amount typed for it when one was sent (the supplier's own figure, asked for
// 2026-10-05), else Net of Tax x the tax code's rate as computed. Same rules as lineWtax: it takes
// the line's sign and is never more than the line's net. Ext Price (gross) follows it.
function withTypedTax(l, amounts) {
  const typed = l && l.tax_amount !== undefined && l.tax_amount !== null && l.tax_amount !== '' && Number.isFinite(Number(l.tax_amount));
  if (!typed) return amounts;
  const net = amounts.net_of_tax;
  const tax = Number(((net < 0 ? -1 : 1) * Math.min(Math.abs(Number(l.tax_amount)), Math.abs(net))).toFixed(2));
  return { ...amounts, tax_amount: tax, ext_price: Number((net + tax).toFixed(2)) };
}

// GL Impact computation lives in server/src/lib/glImpact.js (computeVendorBillGl),
// shared with the Reports engine so the reports can never drift from what this tab shows.
const computeGlImpact = computeVendorBillGl;

async function recomputePoBillStatus(conn, poId) {
  const [[row]] = await conn.query(
    `SELECT SUM(CASE WHEN billed_qty >= received_qty AND received_qty > 0 THEN 1 ELSE 0 END) AS fully,
            SUM(CASE WHEN billed_qty > 0 THEN 1 ELSE 0 END) AS any_billed,
            COUNT(*) AS total
     FROM purchase_order_lines WHERE purchase_order_id = ? AND received_qty > 0`,
    [poId]
  );
  let status = 'not_billed';
  if (row.total > 0 && row.fully === row.total) status = 'fully_billed';
  else if (row.any_billed > 0) status = 'partially_billed';
  await conn.query('UPDATE purchase_orders SET bill_status = ? WHERE id = ?', [status, poId]);
}

// Powers the Create Vendor Bill modal -- only PO lines with received_qty > billed_qty show
// up ("RR Qty" > "Billed Qty" on the real screen), Qty to Bill defaulting to the full
// remaining gap. Rate is a read-only snapshot of the PO line's own rate; Unit Price defaults
// to the same value but is independently editable, matching the real modal's split fields.
router.get('/for-purchase-order/:poId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[po]] = await pool.query(
      `SELECT po.id, po.po_no, po.memo, s.name AS supplier_name, ${PO_TERM_SELECT}
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       ${PO_TERM_JOINS}
       WHERE po.id = ?`,
      [req.params.poId]
    );
    if (!po) return res.status(404).json({ error: 'Not found' });
    // The PO's term, else its supplier's (lib/poTerm.js) -- the bill's Term and Date Due follow it.
    po.no_of_days = termDays(po);
    delete po.term_days_known;

    const [lines] = await pool.query(
      `SELECT pol.id AS purchase_order_line_id, pol.item_id, i.item_code, i.display_name AS item_name,
              pol.purchase_description, pol.location_id, loc.location_name, pol.department_id, d.name AS department_name,
              pol.received_qty, pol.billed_qty, pol.unit_title, pol.purchase_unit, pol.rate, pol.disc_percent,
              pol.qty AS po_qty, pol.disc_amount AS po_disc_amount, pol.net_of_tax AS po_net_of_tax, pol.tax_amount AS po_tax_amount,
              pol.tax_code_id, t.code AS tax_code, t.rate AS tax_rate
       FROM purchase_order_lines pol
       LEFT JOIN inventories i ON i.id = pol.item_id
       LEFT JOIN locations loc ON loc.id = pol.location_id
       LEFT JOIN departments d ON d.id = pol.department_id
       LEFT JOIN taxes t ON t.id = pol.tax_code_id
       WHERE pol.purchase_order_id = ? AND pol.received_qty > pol.billed_qty
       ORDER BY pol.id`,
      [req.params.poId]
    );

    // Pre-fills the Create Vendor Bill modal's own Account picker. This is the bill's
    // debit-side offset account -- Accounts Payable itself is always the fixed credit
    // leg in computeGlImpact() below, never user-selected, so defaulting this picker to
    // AP-Trade was wrong (it made every bill created from this modal double-book AP on
    // both sides unless someone thought to change it). "Inventory Received Not Billed"
    // is the real system's actual default for a PO-linked bill -- the 3-way-match
    // clearing account credited when the goods were received, debited back out here.
    //
    // Changed 2026-10-03: the source's own PO bills carry Accounts Payable - Trade as their Account
    // (its ledger credits 20100 and debits 20300 on every one), so that is the default now, and
    // lib/glImpact.js posts a PO bill with a payable header as CR it / DR 20300.
    const [[defaultAccount]] = await pool.query(
      "SELECT id, account_code, account_name, account_type FROM chart_of_accounts WHERE account_code = '20100' LIMIT 1"
    );
    // The PO has no header office location, only one per line: the bill defaults to the location
    // its lines use (the most common one when they differ).
    const [[defaultLocation]] = await pool.query(
      `SELECT loc.id, loc.location_name FROM purchase_order_lines pol JOIN locations loc ON loc.id = pol.location_id
        WHERE pol.purchase_order_id = ? GROUP BY loc.id, loc.location_name ORDER BY COUNT(*) DESC, loc.id LIMIT 1`,
      [req.params.poId]
    );

    const billableLines = lines.map((l) => {
      const qty = Number(l.received_qty) - Number(l.billed_qty);
      return {
        ...l,
        rr_qty: l.received_qty,
        billed_qty: l.billed_qty,
        qty,
        unit_price: l.rate,
        ...(computeLineFromPoLine({ qty: l.po_qty, rate: l.rate, disc_percent: l.disc_percent, disc_amount: l.po_disc_amount, net_of_tax: l.po_net_of_tax, tax_amount: l.po_tax_amount }, { unitPrice: l.rate, discPercent: l.disc_percent, qty })
          || computeLineAmounts({ unitPrice: l.rate, discPercent: l.disc_percent, taxRate: l.tax_rate, qty })),
      };
    });

    // For lines whose PO line has no department -- the bill must be given one (see POST /).
    // Sent here rather than read from /lookups, which the people billing may not be granted.
    const [departments] = await pool.query('SELECT id, name FROM departments WHERE is_active = TRUE ORDER BY name');
    res.json({
      ...po,
      default_account: defaultAccount || null,
      default_office_location: defaultLocation || null,
      lines: billableLines,
      departments,
    });
  } catch (err) {
    next(err);
  }
});

// What the standalone bill form picks from, under this page's own can_view.
router.get('/standalone-meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [suppliers] = await pool.query(
      `SELECT s.id, s.name, s.supplier_code, s.tin, COALESCE(pt.term_name, s.credit_term) AS term_name, COALESCE(pt.no_of_days, s.term_days) AS no_of_days
         FROM suppliers s LEFT JOIN payment_terms pt ON pt.id = s.payment_term_id
        WHERE s.is_active = 1 ORDER BY s.name`
    );
    const [accounts] = await pool.query(
      `SELECT coa.id, coa.account_code, coa.account_name, coa.account_type
         FROM chart_of_accounts coa
        -- Every postable (non-summary) account, the same list Cheques and Journals offer. is_active is
        -- not a usable filter here: 236 real accounts, Accounts Payable among them, carry 0.
        WHERE (coa.is_summary = 0 OR coa.is_summary IS NULL) ORDER BY coa.account_code`
    );
    const [departments] = await pool.query('SELECT id, name FROM departments WHERE is_active = TRUE ORDER BY name');
    const [taxes] = await pool.query('SELECT id, code, rate FROM taxes ORDER BY code');
    const [wtaxes] = await pool.query('SELECT id, code, name, rate FROM withholding_taxes WHERE is_active = 1 ORDER BY code, rate');
    const [[ap]] = await pool.query("SELECT id, account_code, account_name FROM chart_of_accounts WHERE account_code = '20100' LIMIT 1");
    res.json({ suppliers, accounts, departments, taxes, wtaxes, ap_account: ap || null });
  } catch (err) {
    next(err);
  }
});

router.get('/by-purchase-order/:poId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, bill_no, date_created, gross_amount, status FROM vendor_bills WHERE purchase_order_id = ? ORDER BY id DESC',
      [req.params.poId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, status } = req.query;
    const where = [];
    { const cw = companyWhere('vb.office_location_id'); if (cw) where.push(cw); } // topbar company switcher
    const params = [];
    // Paid in Full is two codes: 'paid_in_full' on bills made here, 'paid' on the 20,008 imported --
    // filtering on the first alone hid every imported paid bill, i.e. nearly all of 2025 (2026-10-08).
    if (status === 'paid_in_full' || status === 'paid') where.push("vb.status IN ('paid_in_full', 'paid')");
    else if (status) { where.push('vb.status = ?'); params.push(status); }
    // Date From / Date To on the bill date, inclusive (asked 2026-10-08). Only a real yyyy-mm-dd is
    // used, so a half-typed year does not turn into a query.
    const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
    if (day(req.query.date_from)) { where.push('vb.date_created >= ?'); params.push(day(req.query.date_from)); }
    if (day(req.query.date_to)) { where.push('vb.date_created <= ?'); params.push(day(req.query.date_to)); }
    if (search) {
      where.push('(vb.bill_no LIKE ? OR po.po_no LIKE ? OR s.name LIKE ? OR vb.reference_no LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // LEFT JOIN, not JOIN: a standalone expense bill has no purchase_order_id and would
    // otherwise drop out of this list entirely. Vendor comes from the PO when there is one
    // and from the bill's own supplier_id when there isn't.
    const [rows] = await pool.query(
      `SELECT vb.id, vb.bill_no, vb.reference_no, vb.date_created, vb.date_due, vb.term, vb.memo, vb.gross_amount, vb.amount_due, vb.status,
              vb.net_of_tax, vb.tax_amount, vb.wtax_amount,
              po.po_no, s.id AS supplier_id, s.name AS supplier_name, loc.location_name AS office_location_name
       FROM vendor_bills vb
       LEFT JOIN purchase_orders po ON po.id = vb.purchase_order_id
       LEFT JOIN suppliers s ON s.id = COALESCE(po.supplier_id, vb.supplier_id)
       LEFT JOIN locations loc ON loc.id = vb.office_location_id
       ${whereSql}
       -- Newest BILL DATE first. Ids do not follow the date on imported bills (2026's run 2 to 32,251),
       -- so ordering by id scattered the years through the pages.
       ORDER BY vb.date_created DESC, vb.id DESC`,
      params
    );
    // Extract (2026-10-12): the list under its current filters, every row, as a workbook.
    if (req.query.format === 'xlsx') {
      const STATUS = { open: 'Open', paid_in_full: 'Paid in Full', paid: 'Paid in Full', cancelled: 'Cancelled' };
      await sendXlsx(res, {
        filename: 'vendor-bills.xlsx',
        sheet: 'Vendor Bills',
        columns: [
          { header: 'Bill #', key: 'bill_no', width: 14 },
          { header: 'PO #', key: 'po', width: 14 },
          { header: 'Reference #', key: 'ref', width: 18 },
          { header: 'Date Created', key: 'date', width: 13 },
          { header: 'Date Due', key: 'due', width: 13 },
          { header: 'Office Location', key: 'location', width: 18 },
          { header: 'Vendor', key: 'vendor', width: 40 },
          { header: 'Net of Tax', key: 'net', width: 16, money: true },
          { header: 'Tax Amount', key: 'tax', width: 14, money: true },
          { header: 'Total Amount', key: 'gross', width: 16, money: true },
          { header: 'Withholding Tax', key: 'wtax', width: 15, money: true },
          { header: 'Net Amount', key: 'net_amount', width: 16, money: true },
          { header: 'Amount Due', key: 'amount_due', width: 16, money: true },
          { header: 'Term', key: 'term', width: 12 },
          { header: 'Memo', key: 'memo', width: 50 },
          { header: 'Status', key: 'status', width: 14 },
        ],
        rows: rows.map((r) => ({
          bill_no: r.bill_no, po: r.po_no || 'No PO', ref: r.reference_no || '', date: xlsxDay(r.date_created), due: xlsxDay(r.date_due),
          location: r.office_location_name || '', vendor: r.supplier_name || '', gross: Number(r.gross_amount || 0),
          net: Number(r.net_of_tax || 0), tax: Number(r.tax_amount || 0), wtax: Number(r.wtax_amount || 0),
          net_amount: Number((Number(r.gross_amount || 0) - Number(r.wtax_amount || 0)).toFixed(2)),
          amount_due: Number(r.amount_due || 0), term: r.term || '', memo: r.memo || '', status: STATUS[r.status] || r.status,
        })),
      });
      return;
    }
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[vb]] = await pool.query(
      `SELECT vb.*, po.po_no, s.name AS supplier_name, s.id AS vendor_id,
              coa.account_code, coa.account_name,
              loc.location_name AS office_location_name,
              wt.code AS wtax_code, u.display_name AS created_by_name, fr.request_no AS form_request_no
       FROM vendor_bills vb
       LEFT JOIN purchase_orders po ON po.id = vb.purchase_order_id
       LEFT JOIN suppliers s ON s.id = COALESCE(po.supplier_id, vb.supplier_id)
       LEFT JOIN chart_of_accounts coa ON coa.id = vb.account_id
       LEFT JOIN locations loc ON loc.id = vb.office_location_id
       LEFT JOIN withholding_taxes wt ON wt.id = vb.wtax_id
       LEFT JOIN users u ON u.id = vb.created_by_user_id
       LEFT JOIN form_requests fr ON fr.id = vb.form_request_id
       WHERE vb.id = ?`,
      [req.params.id]
    );
    if (!vb) return res.status(404).json({ error: 'Not found' });

    // line_account_* is the expense line's own debit account (NULL on PO-derived item
    // lines) -- aliased rather than account_code/account_name so it can't collide with the
    // header's own account columns selected above.
    const [lines] = await pool.query(
      `SELECT vbl.*, i.item_code, COALESCE(i.display_name, vbl.description) AS item_name,
              COALESCE(pol.purchase_description, vbl.description) AS purchase_description, pol.unit_title, pol.purchase_unit,
              loc.location_name, d.name AS department_name, t.code AS tax_code,
              lcoa.account_code AS line_account_code, lcoa.account_name AS line_account_name
       FROM vendor_bill_lines vbl
       LEFT JOIN chart_of_accounts lcoa ON lcoa.id = vbl.account_id
       LEFT JOIN inventories i ON i.id = vbl.item_id
       LEFT JOIN purchase_order_lines pol ON pol.id = vbl.purchase_order_line_id
       LEFT JOIN locations loc ON loc.id = vbl.location_id
       LEFT JOIN departments d ON d.id = vbl.department_id
       LEFT JOIN taxes t ON t.id = vbl.tax_code_id
       WHERE vbl.vendor_bill_id = ?`,
      [req.params.id]
    );

    // An imported bill posts from the source's own GL entry (live_gl_entries) until it is edited --
    // as the reports already read it -- so that is what GL Impact shows. Computing it instead left a
    // PO bill with no header account without its expense debit (VB-24367, 2026-10-24).
    const [liveGl] = await pool.query(
      `SELECT account_code, MAX(account_name) AS account_name, ROUND(SUM(debit), 2) AS debit, ROUND(SUM(credit), 2) AS credit
         FROM live_gl_entries WHERE source_type = 'vendor_bill' AND source_id = ?
        GROUP BY account_code ORDER BY MIN(id)`, [vb.id]);
    const glImpact = liveGl.length
      ? liveGl.map((r) => ({ ...r, debit: Number(r.debit), credit: Number(r.credit) })).filter((r) => r.debit || r.credit)
      // The lines that debit an account of their own, as the ledger takes them -- a PO bill's
      // Service line its item's expense account, not 20300 (lib/glImpact.js vendorBillDebitLines).
      : await computeGlImpact(vb, (await vendorBillDebitLines([vb.id])).get(Number(vb.id)) || []);
    res.json({ ...vb, gl_impact: glImpact, lines });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/related', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [billPayments] = await pool.query(
      `SELECT DISTINCT bp.id, bp.bill_payment_no, bp.date_created, bp.total_amount, bp.status
       FROM bill_payments bp
       JOIN bill_payment_lines bpl ON bpl.bill_payment_id = bp.id
       WHERE bpl.vendor_bill_id = ?
       ORDER BY bp.id DESC`,
      [req.params.id]
    );
    const [billCredits] = await pool.query(
      'SELECT id, bill_credit_no, date_created, total_amount, applied_amount, status FROM bill_credits WHERE vendor_bill_id = ? ORDER BY id DESC',
      [req.params.id]
    );
    // The reversal journal a cancel posted (2026-10-14).
    const reversalJournals = await listReversalJournals(pool, 'vendor_bill', Number(req.params.id));
    res.json({ bill_payments: billPayments, bill_credits: billCredits, reversal_journals: reversalJournals });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'VendorBill' AND a.auditable_id = ?
       ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// The standalone "Add Vendor Bill" form's Save. No PO, so nothing to move billed_qty on and
// no item lines -- each line is an expense booked straight to a Chart of Accounts entry
// (Account Code / Account Title / Description / Department / Amount / Tax Code on the real
// screen). Amount is the line's net-of-tax figure; tax and withholding are derived from it
// server-side, never trusted from the client, same discipline as the PO-based path below.
// Stored in vendor_bill_lines with qty = 1 and unit_price = amount so every downstream
// consumer (Bill Payment, Bill Credit, aging) reads the same money columns either way.
async function createExpenseBill(req, res, conn) {
  const {
    supplier_id: supplierId, date_created: dateCreated, term_id: termId, reference_no: referenceNo,
    account_id: accountId, office_location_id: officeLocationId, memo, wtax_id: wtaxId,
    expense_lines: submittedLines,
  } = req.body;

  if (!supplierId) return res.status(400).json({ error: 'Vendor is required.' });

  const submitted = (Array.isArray(submittedLines) ? submittedLines : [])
    .filter((l) => l.account_id && Number(l.amount) > 0);
  if (!submitted.length) return res.status(400).json({ error: 'Add at least one expense line.' });

  const billDate = dateCreated || new Date().toISOString().slice(0, 10);
  await assertPeriodOpen(billDate, 'ap', conn);

  const [[supplier]] = await conn.query('SELECT id FROM suppliers WHERE id = ?', [supplierId]);
  if (!supplier) return res.status(400).json({ error: 'Vendor not found.' });

  // Term drives Date Due the same way the PO-based modal does (date + the term's no_of_days),
  // resolved here rather than taking the client's arithmetic on trust.
  let termName = null;
  let dateDue = billDate;
  if (termId) {
    const [[term]] = await conn.query('SELECT term_name, no_of_days FROM payment_terms WHERE id = ?', [termId]);
    if (!term) return res.status(400).json({ error: 'Term not found.' });
    termName = term.term_name;
    const d = new Date(billDate);
    d.setDate(d.getDate() + Number(term.no_of_days || 0));
    dateDue = d.toISOString().slice(0, 10);
  }

  const taxIds = [...new Set(submitted.map((l) => l.tax_code_id).filter(Boolean))];
  const taxRateById = new Map();
  if (taxIds.length) {
    const [taxes] = await conn.query('SELECT id, rate FROM taxes WHERE id IN (?)', [taxIds]);
    for (const t of taxes) taxRateById.set(t.id, Number(t.rate) || 0);
  }

  let wtaxRate = 0;
  let wtaxDescription = null;
  if (wtaxId) {
    const [[wt]] = await conn.query('SELECT name, rate FROM withholding_taxes WHERE id = ?', [wtaxId]);
    if (!wt) return res.status(400).json({ error: 'Withholding Tax not found.' });
    wtaxRate = Number(wt.rate) || 0;
    wtaxDescription = wt.name;
  }

  const accountIds = [...new Set(submitted.map((l) => Number(l.account_id)))];
  const [accounts] = await conn.query('SELECT id FROM chart_of_accounts WHERE id IN (?)', [accountIds]);
  if (accounts.length !== accountIds.length) return res.status(400).json({ error: 'One of the selected accounts no longer exists.' });

  const computedLines = submitted.map((l) => {
    const amount = Number(Number(l.amount).toFixed(2));
    const taxRate = l.tax_code_id ? (taxRateById.get(Number(l.tax_code_id)) || 0) : 0;
    const taxAmount = Number((amount * (taxRate / 100)).toFixed(2));
    const grossAmount = Number((amount + taxAmount).toFixed(2));
    const isWithhold = !!l.is_withhold;
    const lineWtaxAmount = isWithhold ? Number((amount * wtaxRate / 100).toFixed(2)) : 0;
    return {
      account_id: Number(l.account_id),
      description: l.description || null,
      department_id: l.department_id || null,
      tax_code_id: l.tax_code_id || null,
      amount,
      tax_amount: taxAmount,
      gross_amount: grossAmount,
      is_withhold: isWithhold,
      wtax_amount: lineWtaxAmount,
      amount_due: Number((grossAmount - lineWtaxAmount).toFixed(2)),
    };
  });

  // No per-line discount on this form, so Sub Total and Net of Tax are the same figure --
  // both stored so the header reads identically to a PO-derived bill.
  const netOfTax = computedLines.reduce((s, l) => s + l.amount, 0);
  const taxAmount = computedLines.reduce((s, l) => s + l.tax_amount, 0);
  const grossAmount = computedLines.reduce((s, l) => s + l.gross_amount, 0);
  const wtaxAmount = computedLines.reduce((s, l) => s + l.wtax_amount, 0);
  const amountDue = grossAmount - wtaxAmount;

  await conn.beginTransaction();
  const [result] = await conn.query(
    `INSERT INTO vendor_bills
       (bill_no, purchase_order_id, supplier_id, date_created, date_due, term, reference_no, account_id,
        office_location_id, memo, subtotal, discount_amount, net_of_tax, tax_amount, gross_amount,
        wtax_id, wtax_description, wtax_amount, amount_due, created_by_user_id)
     VALUES ('', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      supplierId, billDate, dateDue, termName, referenceNo || null, accountId || null,
      officeLocationId || null, memo || null, netOfTax, netOfTax, taxAmount, grossAmount,
      wtaxId || null, wtaxDescription, wtaxAmount, amountDue, req.user.id,
    ]
  );
  const billId = result.insertId;
  await conn.query('UPDATE vendor_bills SET bill_no = ? WHERE id = ?', [`VB-${billId}`, billId]);

  for (const l of computedLines) {
    await conn.query(
      `INSERT INTO vendor_bill_lines
         (vendor_bill_id, purchase_order_line_id, item_id, account_id, description, location_id, department_id,
          qty, rate, unit_price, disc_percent, disc_amount, net_of_tax, tax_code_id, tax_amount, ext_price,
          is_withhold, wtax_amount, amount_due)
       VALUES (?, NULL, NULL, ?, ?, NULL, ?, 1, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
      [
        billId, l.account_id, l.description, l.department_id, l.amount, l.amount, l.amount,
        l.tax_code_id, l.tax_amount, l.gross_amount, l.is_withhold, l.wtax_amount, l.amount_due,
      ]
    );
  }

  await logAudit(conn, { billId, userId: req.user.id, eventType: 'Created', fieldName: 'bill_no', newValue: `VB-${billId}` });
  await conn.commit();

  const [[row]] = await pool.query('SELECT * FROM vendor_bills WHERE id = ?', [billId]);
  return res.status(201).json(row);
}

// Saving marks each included PO line's billed_qty forward by exactly the qty caught up in
// *this* transaction (never the line's full received qty) -- same running-total discipline
// as Sales Invoice/Item Delivery, so cancelling a Bill can subtract exactly this back out.
// Every money figure is recomputed server-side from qty/unit_price/disc_percent/tax rate,
// never trusted from the client's live-recalculated display values.
// A standalone expense bill. Same money discipline as the PO path -- every figure computed here
// from qty x unit price, discount, the tax code's rate and the withholding rate -- but each line
// names the expense account it debits and a description, instead of billing a received PO line.
// Every line needs a department, as on the PO path, so department budgets see the spending.
async function createStandaloneBill(req, res, conn) {
  const {
    supplier_id: supplierId, date_created: dateCreated, date_due: dateDue, term, reference_no: referenceNo,
    office_location_id: officeLocationId, memo, wtax_id: wtaxId, lines: submittedLines, account_id: apAccountId,
  } = req.body;
  // The header Account on the source's form: the payable the bill credits -- Accounts Payable - Trade
  // unless another is chosen. (On a PO bill account_id is the debit offset instead; see glImpact.)
  const [[apAcct]] = apAccountId
    ? await conn.query('SELECT id FROM chart_of_accounts WHERE id = ?', [apAccountId])
    : await conn.query("SELECT id FROM chart_of_accounts WHERE account_code = '20100' LIMIT 1");

  const [[supplier]] = await conn.query('SELECT id, name FROM suppliers WHERE id = ?', [supplierId]);
  if (!supplier) return res.status(400).json({ error: 'Choose a supplier.' });
  const submitted = (Array.isArray(submittedLines) ? submittedLines : []).filter((l) => Number(l.qty) > 0);
  if (!submitted.length) return res.status(400).json({ error: 'Add at least one line with a quantity.' });
  await assertPeriodOpen(dateCreated, 'ap', conn);

  // Raised from a Liquidation (Create Vendor Bill on the form): only an approved one, and each of its
  // items on one bill only (2026-10-12: a liquidation can be split across bills by item, receipts from
  // different vendors) -- never once a Journal has posted it (lib/liquidationPosting.js). The items
  // this bill posts are the ones its lines came from; an older screen that names none bills them all.
  const formRequestId = Number(req.body.form_request_id) || null;
  let formItemIds = [];
  // The account each item's line debits -- it stands in for an item AP has not given one on the form.
  const itemAccounts = new Map();
  if (formRequestId) {
    formItemIds = Array.isArray(req.body.form_request_item_ids)
      ? [...new Set(req.body.form_request_item_ids.map(Number).filter(Boolean))]
      : (await liquidationBilling(conn, formRequestId)).unbilledItemIds;
    for (const l of submitted) {
      if (Number(l.form_request_item_id) && Number(l.account_id)) itemAccounts.set(Number(l.form_request_item_id), Number(l.account_id));
    }
    const why = await liquidationPostError(conn, formRequestId, { via: 'bill', itemIds: formItemIds, itemAccounts });
    if (why) return res.status(409).json({ error: why });
  }

  const accountIds = [...new Set(submitted.map((l) => Number(l.account_id)).filter(Boolean))];
  const [accts] = accountIds.length ? await conn.query('SELECT id FROM chart_of_accounts WHERE id IN (?)', [accountIds]) : [[]];
  const knownAcct = new Set(accts.map((a) => a.id));
  const [taxes] = await conn.query('SELECT id, rate FROM taxes');
  const taxRate = new Map(taxes.map((t) => [t.id, Number(t.rate)]));

  let wtaxRate = 0;
  let wtaxDescription = null;
  if (wtaxId) {
    const [[wt]] = await conn.query('SELECT name, rate FROM withholding_taxes WHERE id = ?', [wtaxId]);
    wtaxRate = Number(wt?.rate) || 0;
    wtaxDescription = wt?.name || null;
  }

  const computedLines = [];
  for (const [idx, l] of submitted.entries()) {
    if (!knownAcct.has(Number(l.account_id))) return res.status(400).json({ error: `Choose an account on line ${idx + 1}.` });
    if (!Number(l.department_id)) return res.status(400).json({ error: `Choose a Department on line ${idx + 1}. It is required so department budgets can be tracked.` });
    const qty = Number(l.qty);
    const unitPrice = Number(l.unit_price);
    // Negative is allowed: a reversal bill (asked 2026-10-03).
    if (!Number.isFinite(unitPrice)) return res.status(400).json({ error: `Enter an amount on line ${idx + 1}.` });
    const amounts = withTypedTax(l, computeLineAmounts({ unitPrice, discPercent: l.disc_percent, taxRate: taxRate.get(Number(l.tax_code_id)) || 0, qty }));
    const w = lineWtax(l, amounts.net_of_tax, wtaxRate);
    const isWithhold = w.is_withhold;
    const lineWtaxAmount = w.wtax_amount;
    computedLines.push({
      account_id: Number(l.account_id), description: String(l.description || '').trim().slice(0, 500) || null,
      department_id: Number(l.department_id), location_id: Number(l.location_id) || null, qty, rate: unitPrice, unit_price: unitPrice,
      disc_percent: Number(l.disc_percent || 0), tax_code_id: Number(l.tax_code_id) || null, is_withhold: isWithhold,
      wtax_amount: lineWtaxAmount, amount_due: Number((amounts.ext_price - lineWtaxAmount).toFixed(2)), ...amounts,
    });
  }

  const subtotal = computedLines.reduce((sum, l) => sum + l.subtotal, 0);
  const discountAmount = computedLines.reduce((sum, l) => sum + l.disc_amount, 0);
  const netOfTax = computedLines.reduce((sum, l) => sum + l.net_of_tax, 0);
  const taxAmount = computedLines.reduce((sum, l) => sum + l.tax_amount, 0);
  const grossAmount = computedLines.reduce((sum, l) => sum + l.ext_price, 0);
  const wtaxAmount = computedLines.reduce((sum, l) => sum + l.wtax_amount, 0);
  const amountDue = Number((grossAmount - wtaxAmount).toFixed(2));

  await conn.beginTransaction();
  const { id: billId, no: billNo } = await insertNumbered(conn, {
    table: 'vendor_bills',
    column: 'bill_no',
    prefix: 'VB-',
    run: (no) => conn.query(
      `INSERT INTO vendor_bills
         (bill_no, purchase_order_id, supplier_id, form_request_id, date_created, date_due, term, reference_no, account_id, office_location_id,
          memo, subtotal, discount_amount, net_of_tax, tax_amount, gross_amount, wtax_id, wtax_description,
          wtax_amount, amount_due, created_by_user_id)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        no, supplier.id, formRequestId, dateCreated || new Date().toISOString().slice(0, 10), dateDue || null, term || null,
        referenceNo || null, apAcct ? apAcct.id : null, officeLocationId || null, memo || null,
        subtotal, discountAmount, netOfTax, taxAmount, grossAmount, wtaxId || null, wtaxDescription,
        wtaxAmount, amountDue, req.user.id,
      ]
    ),
  });

  for (const itemId of formItemIds) {
    await conn.query('INSERT INTO vendor_bill_form_items (vendor_bill_id, form_request_item_id) VALUES (?, ?)', [billId, itemId]);
    // An item with no account of its own takes the one its line on this bill debits.
    const accountId = itemAccounts.get(itemId);
    if (!accountId) continue;
    const [r] = await conn.query(
      'UPDATE form_request_items SET cogs_account_id = ? WHERE id = ? AND form_request_id = ? AND cogs_account_id IS NULL',
      [accountId, itemId, formRequestId]);
    if (r.affectedRows) {
      const [[a]] = await conn.query(
        `SELECT i.particulars, CONCAT(c.account_code, ' — ', c.account_name) AS label FROM form_request_items i
           JOIN chart_of_accounts c ON c.id = i.cogs_account_id WHERE i.id = ?`, [itemId]);
      await conn.query(
        `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
         VALUES ('FormRequest', ?, 'Updated', ?, NULL, ?, ?)`,
        [formRequestId, `COGS Account (${String(a?.particulars || 'item').slice(0, 100)}) from ${billNo}`, a?.label || null, req.user.id]);
    }
  }

  for (const l of computedLines) {
    await conn.query(
      `INSERT INTO vendor_bill_lines
         (vendor_bill_id, purchase_order_line_id, item_id, account_id, description, location_id, department_id, qty, rate, unit_price,
          disc_percent, disc_amount, net_of_tax, tax_code_id, tax_amount, ext_price, is_withhold, wtax_amount, amount_due)
       VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        billId, l.account_id, l.description, l.location_id, l.department_id, l.qty, l.rate, l.unit_price,
        l.disc_percent, l.disc_amount, l.net_of_tax, l.tax_code_id, l.tax_amount, l.ext_price, l.is_withhold,
        l.wtax_amount, l.amount_due,
      ]
    );
  }

  await logAudit(conn, { billId, userId: req.user.id, eventType: 'Created', fieldName: 'bill_no', newValue: billNo || `VB-${billId}` });
  await logAudit(conn, { billId, userId: req.user.id, eventType: 'Created', fieldName: 'supplier_id', newValue: supplier.name });
  await conn.commit();

  const [[row]] = await pool.query('SELECT * FROM vendor_bills WHERE id = ?', [billId]);
  return res.status(201).json(row);
}

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const {
      purchase_order_id: purchaseOrderId, date_created: dateCreated, date_due: dateDue, term,
      reference_no: referenceNo, account_id: accountId, office_location_id: officeLocationId, memo,
      wtax_id: wtaxId, lines: submittedLines,
    } = req.body;
    // No PO means this came from the standalone "Add Vendor Bill" form -- expense lines, not
    // PO item lines. Same endpoint so both kinds go through one permission check and one
    // numbering sequence.
    // wu venture's own "Add Vendor Bill" page (VendorBillCreate) posts expense_lines; GSUITE's
    // Create New modal posts lines + supplier_id and is handled just below.
    if (!purchaseOrderId && Array.isArray(req.body.expense_lines)) return await createExpenseBill(req, res, conn);
    // No PO: a standalone expense bill -- supplier + account lines.
    // Awaited, so its errors (a closed period) reach the catch below and the connection is not
    // released under it. A bare `return` let them escape and crashed the server (2026-10-03).
    if (!purchaseOrderId && req.body.supplier_id) return await createStandaloneBill(req, res, conn);
    if (!purchaseOrderId) return res.status(400).json({ error: 'Purchase Order is required.' });

    const submitted = (Array.isArray(submittedLines) ? submittedLines : [])
      .filter((l) => l.purchase_order_line_id && Number(l.qty) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Include at least one item.' });
    await assertPeriodOpen(dateCreated, 'ap', conn);

    const lineIds = submitted.map((l) => Number(l.purchase_order_line_id));
    const [poLines] = await conn.query(
      `SELECT pol.id, pol.item_id, pol.location_id, pol.department_id, pol.received_qty, pol.billed_qty,
              pol.rate, pol.tax_code_id, t.rate AS tax_rate,
              pol.qty, pol.disc_percent, pol.disc_amount, pol.net_of_tax, pol.tax_amount,
              -- A Non-Inventory item's line debits its expense account (computeVendorBillGl, 2026-10-24).
              CASE WHEN inv.item_type = 'Non-Inventory' THEN inv.expense_account_id END AS line_account_id
       FROM purchase_order_lines pol
       LEFT JOIN taxes t ON t.id = pol.tax_code_id
       LEFT JOIN inventories inv ON inv.id = pol.item_id
       WHERE pol.purchase_order_id = ? AND pol.id IN (?)`,
      [purchaseOrderId, lineIds]
    );
    if (poLines.length !== lineIds.length) return res.status(400).json({ error: 'One of the selected items is no longer eligible.' });
    const poLineById = new Map(poLines.map((l) => [l.id, l]));

    let wtaxRate = 0;
    if (wtaxId) {
      const [[wt]] = await conn.query('SELECT rate FROM withholding_taxes WHERE id = ?', [wtaxId]);
      wtaxRate = Number(wt?.rate) || 0;
    }

    const computedLines = [];
    for (const s of submitted) {
      const poLine = poLineById.get(Number(s.purchase_order_line_id));
      const qty = Number(s.qty);
      const remaining = Number(poLine.received_qty) - Number(poLine.billed_qty);
      // Reject rather than clamp -- a Qty to Bill beyond what was actually received is a
      // real data-entry error, not something to silently cap.
      if (qty > remaining + 1e-9) {
        return res.status(409).json({ error: `Qty to Bill (${qty}) exceeds the remaining billable qty (${remaining}) for this line.` });
      }
      const discPercent = Number(s.disc_percent || 0);
      const isWithhold = !!s.is_withhold;
      // A typed Amount wins; Unit Price follows it (computeLineFromAmount).
      const fromAmount = hasAmount(s) ? computeLineFromAmount({ amount: s.amount, discPercent, taxRate: poLine.tax_rate, qty }) : null;
      const unitPrice = fromAmount ? fromAmount.unit_price : (s.unit_price !== undefined ? Number(s.unit_price) : Number(poLine.rate));
      const amounts = withTypedTax(s, fromAmount
        || computeLineFromPoLine(poLine, { unitPrice, discPercent, qty })
        || computeLineAmounts({ unitPrice, discPercent, taxRate: poLine.tax_rate, qty }));
      const w = lineWtax({ ...s, is_withhold: isWithhold }, amounts.net_of_tax, wtaxRate);
      const lineWtaxAmount = w.wtax_amount;
      computedLines.push({
        purchase_order_line_id: poLine.id, item_id: poLine.item_id, account_id: poLine.line_account_id || null, location_id: poLine.location_id,
        // The PO line's department, or -- where the PO never had one -- the one chosen on the bill.
        department_id: poLine.department_id || Number(s.department_id) || null, qty, rate: poLine.rate, unit_price: unitPrice, disc_percent: discPercent,
        tax_code_id: poLine.tax_code_id, is_withhold: w.is_withhold, wtax_amount: lineWtaxAmount,
        amount_due: Number((amounts.ext_price - lineWtaxAmount).toFixed(2)), ...amounts,
      });
    }

    // Every bill line needs a department so department budgets see the spending (see
    // lib/requireDepartment.js). Bills are items, so unlike cheques and journals there is no
    // balance-sheet line to exempt.
    const noDept = computedLines.findIndex((l) => !l.department_id);
    if (noDept >= 0) return res.status(400).json({ error: `Choose a Department on line ${noDept + 1}. Its Purchase Order line has none, and it is required so department budgets can be tracked.` });

    const subtotal = computedLines.reduce((s, l) => s + l.subtotal, 0);
    const discountAmount = computedLines.reduce((s, l) => s + l.disc_amount, 0);
    const netOfTax = computedLines.reduce((s, l) => s + l.net_of_tax, 0);
    const taxAmount = computedLines.reduce((s, l) => s + l.tax_amount, 0);
    const grossAmount = computedLines.reduce((s, l) => s + l.ext_price, 0);
    const wtaxAmount = computedLines.reduce((s, l) => s + l.wtax_amount, 0);
    const amountDue = grossAmount - wtaxAmount;

    let wtaxDescription = null;
    if (wtaxId) {
      const [[wt]] = await conn.query('SELECT name FROM withholding_taxes WHERE id = ?', [wtaxId]);
      wtaxDescription = wt?.name || null;
    }

    await conn.beginTransaction();
    // The record itself is always a "Vendor Bill" (VB-#), matching the real system.
    const { id: billId } = await insertNumbered(conn, {
      table: 'vendor_bills',
      column: 'bill_no',
      prefix: 'VB-',
      run: (no) => conn.query(
        `INSERT INTO vendor_bills
           (bill_no, purchase_order_id, date_created, date_due, term, reference_no, account_id, office_location_id,
            memo, subtotal, discount_amount, net_of_tax, tax_amount, gross_amount, wtax_id, wtax_description,
            wtax_amount, amount_due, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          no, purchaseOrderId, dateCreated || new Date().toISOString().slice(0, 10), dateDue || null, term || null,
          referenceNo || null, accountId || null, officeLocationId || null, memo || null,
          subtotal, discountAmount, netOfTax, taxAmount, grossAmount, wtaxId || null, wtaxDescription,
          wtaxAmount, amountDue, req.user.id,
        ]
      ),
    });

    for (const l of computedLines) {
      await conn.query(
        `INSERT INTO vendor_bill_lines
           (vendor_bill_id, purchase_order_line_id, item_id, account_id, location_id, department_id, qty, rate, unit_price,
            disc_percent, disc_amount, net_of_tax, tax_code_id, tax_amount, ext_price, is_withhold, wtax_amount, amount_due)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          billId, l.purchase_order_line_id, l.item_id, l.account_id, l.location_id, l.department_id, l.qty, l.rate, l.unit_price,
          l.disc_percent, l.disc_amount, l.net_of_tax, l.tax_code_id, l.tax_amount, l.ext_price, l.is_withhold,
          l.wtax_amount, l.amount_due,
        ]
      );
      await conn.query(
        'UPDATE purchase_order_lines SET billed_qty = billed_qty + ? WHERE id = ?',
        [l.qty, l.purchase_order_line_id]
      );
    }

    await recomputePoBillStatus(conn, purchaseOrderId);
    await logAudit(conn, { billId, userId: req.user.id, eventType: 'Created', fieldName: 'bill_no', newValue: `VB-${billId}` });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM vendor_bills WHERE id = ?', [billId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// What already stands against a saved bill's money. Nothing here LOCKS it any more -- the amount is
// editable (asked for 2026-10-02) -- and the PUT below keeps each of these straight instead:
//   applied   what Bill Payments / Bill Credits have already settled: (gross - wtax) - amount_due.
//             The new total may not fall below it, and Amount Due becomes new total - applied.
//   oldGl     a bill brought over from the old system posts the old system's own GL entries
//             (live_gl_entries, see glImpact.js). When its amount changes those are replaced by the
//             entries computed from the edited lines -- after carrying its expense account onto the
//             bill, which those entries held and the imported header did not.
async function moneyContext(conn, vb) {
  const applied = Math.max(0, Number((Number(vb.gross_amount) - Number(vb.wtax_amount || 0) - Number(vb.amount_due)).toFixed(2)));
  const [[gl]] = await conn.query("SELECT 1 AS x FROM live_gl_entries WHERE source_type = 'vendor_bill' AND source_id = ? LIMIT 1", [vb.id])
    .catch((e) => { if (e.code === 'ER_NO_SUCH_TABLE') return [[null]]; throw e; });
  // 14 imported bills have lines that do not add up to their own total (VB-5: one 1,000.00 line on
  // a 6,937.50 bill). Re-pricing rebuilds the total from the lines, so it would silently cut such a
  // bill to its lines -- those stay as imported, and say why.
  const [[sum]] = await conn.query('SELECT COALESCE(SUM(net_of_tax), 0) AS s FROM vendor_bill_lines WHERE vendor_bill_id = ?', [vb.id]);
  const linesMismatch = Math.abs(Number(sum.s) - Number(vb.net_of_tax)) > 0.05
    ? `its lines add up to ${Number(sum.s).toFixed(2)} but its total is ${Number(vb.net_of_tax).toFixed(2)} (it came from the old system without all its lines)`
    : null;
  return { applied, oldGl: !!gl, linesMismatch };
}

// Tells the edit page up front which parts it may change, so it can lock them instead of letting
// someone type into fields the save will refuse.
router.get('/:id/edit-meta', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [[vb]] = await pool.query('SELECT * FROM vendor_bills WHERE id = ?', [req.params.id]);
    if (!vb) return res.status(404).json({ error: 'Not found' });
    const ctx = await moneyContext(pool, vb);
    res.json({ money_lock_reason: ctx.linesMismatch, applied_amount: ctx.applied, old_system_gl: ctx.oldGl });
  } catch (err) { next(err); }
});

// Edit a saved bill -- details and money (see moneyContext for what keeps the money straight):
//   - a PO bill's lines keep their item and quantity (billed_qty on the PO line was moved by
//     exactly that qty and stays in step); the Amount (or unit price), discount, tax code,
//     department and the withholding flag may change.
//   - a standalone expense bill's lines are replaced wholesale, like the create form.
// Every figure is recomputed here, as on create; amount_due = new total less what is already
// applied. Each changed header field is audit-logged.
const VB_DETAIL_FIELDS = ['date_created', 'date_due', 'term', 'reference_no', 'office_location_id', 'memo'];
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[vb]] = await conn.query('SELECT * FROM vendor_bills WHERE id = ?', [req.params.id]);
    if (!vb) return res.status(404).json({ error: 'Not found' });
    if (vb.status === 'cancelled') return res.status(409).json({ error: 'This Vendor Bill is cancelled and cannot be edited.' });
    const b = req.body || {};
    const day = (v) => (v ? String(v).slice(0, 10) : null);
    const oldDate = day(vb.date_created instanceof Date ? vb.date_created.toISOString() : vb.date_created);
    const newDate = day(b.date_created) || oldDate;
    // Moving a bill into or out of a closed period changes that period's books either way.
    await assertPeriodOpen(oldDate, 'ap', conn);
    if (newDate !== oldDate) await assertPeriodOpen(newDate, 'ap', conn);

    const details = {
      date_created: newDate,
      date_due: day(b.date_due),
      term: b.term == null ? null : String(b.term).slice(0, 100) || null,
      reference_no: b.reference_no == null ? null : String(b.reference_no).slice(0, 255) || null,
      office_location_id: Number(b.office_location_id) || null,
      memo: b.memo == null ? null : String(b.memo) || null,
    };

    const wantsMoney = Array.isArray(b.lines);
    const ctx = wantsMoney ? await moneyContext(conn, vb) : null;
    if (ctx?.linesMismatch) {
      return res.status(409).json({ error: `The amount of this bill cannot be changed: ${ctx.linesMismatch}. Its dates, term, reference, location and memo can still be edited.` });
    }

    let money = null;
    let newLines = null;
    if (wantsMoney) {
      const [taxes] = await conn.query('SELECT id, rate FROM taxes');
      const taxRate = new Map(taxes.map((t) => [t.id, Number(t.rate)]));
      const wtaxId = Number(b.wtax_id) || null;
      let wtaxRate = 0; let wtaxDescription = null;
      if (wtaxId) {
        const [[wt]] = await conn.query('SELECT name, rate FROM withholding_taxes WHERE id = ?', [wtaxId]);
        if (!wt) return res.status(400).json({ error: 'Choose a valid withholding tax.' });
        wtaxRate = Number(wt.rate) || 0; wtaxDescription = wt.name || null;
      }
      // poLine: the PO line a PO bill's line came from, so an unchanged line keeps the PO's own
      // figures (computeLineFromPoLine) -- only on the PO line's own tax code.
      const price = (l, qty, unitPrice, poLine = null) => {
        const rate = taxRate.get(Number(l.tax_code_id)) || 0;
        const fromPo = poLine && Number(poLine.tax_code_id) === Number(l.tax_code_id)
          ? computeLineFromPoLine(poLine, { unitPrice, discPercent: l.disc_percent, qty }) : null;
        const amounts = withTypedTax(l, hasAmount(l)
          ? computeLineFromAmount({ amount: l.amount, discPercent: l.disc_percent, taxRate: rate, qty })
          : { ...(fromPo || computeLineAmounts({ unitPrice, discPercent: l.disc_percent, taxRate: rate, qty })), unit_price: unitPrice });
        const w = lineWtax(l, amounts.net_of_tax, wtaxRate);
        return { ...amounts, ...w, amount_due: Number((amounts.ext_price - w.wtax_amount).toFixed(2)) };
      };

      const [existing] = await conn.query('SELECT * FROM vendor_bill_lines WHERE vendor_bill_id = ? ORDER BY id', [vb.id]);
      const hasItemLines = !!vb.purchase_order_id || existing.some((l) => l.purchase_order_line_id || l.item_id);
      newLines = [];
      if (hasItemLines) {
        // Same lines, same items and quantities: only their pricing and coding move.
        const byId = new Map(b.lines.map((l) => [Number(l.id), l]));
        const polIds = existing.map((l) => l.purchase_order_line_id).filter(Boolean);
        const [polRows] = polIds.length
          ? await conn.query('SELECT id, qty, rate, disc_percent, disc_amount, net_of_tax, tax_amount, tax_code_id FROM purchase_order_lines WHERE id IN (?)', [polIds])
          : [[]];
        const polById = new Map(polRows.map((p) => [Number(p.id), p]));
        if (existing.some((l) => !byId.has(l.id)) || b.lines.length !== existing.length) {
          return res.status(400).json({ error: 'A Purchase Order bill keeps its lines -- they can be re-priced, not added or removed.' });
        }
        for (const [idx, old] of existing.entries()) {
          const l = byId.get(old.id);
          const unitPrice = Number(l.unit_price);
          if (!hasAmount(l) && (!Number.isFinite(unitPrice) || unitPrice < 0)) return res.status(400).json({ error: `Enter a unit price on line ${idx + 1}.` });
          const departmentId = Number(l.department_id) || null;
          if (!departmentId) return res.status(400).json({ error: `Choose a Department on line ${idx + 1}. It is required so department budgets can be tracked.` });
          newLines.push({
            id: old.id, account_id: old.account_id, description: old.description, department_id: departmentId,
            qty: Number(old.qty), rate: old.rate, disc_percent: Number(l.disc_percent || 0),
            tax_code_id: Number(l.tax_code_id) || null, ...price(l, Number(old.qty), unitPrice, polById.get(Number(old.purchase_order_line_id)) || null),
          });
        }
      } else {
        // A line with an Amount counts even at qty 0 -- some imported lines carry none.
        const submitted = b.lines.filter((l) => Number(l.qty) > 0 || (hasAmount(l) && Number(l.amount) !== 0));
        if (!submitted.length) return res.status(400).json({ error: 'Add at least one line with an amount.' });
        const accountIds = [...new Set(submitted.map((l) => Number(l.account_id)).filter(Boolean))];
        const [accts] = accountIds.length ? await conn.query('SELECT id FROM chart_of_accounts WHERE id IN (?)', [accountIds]) : [[]];
        const knownAcct = new Set(accts.map((a) => a.id));
        for (const [idx, l] of submitted.entries()) {
          if (!knownAcct.has(Number(l.account_id))) return res.status(400).json({ error: `Choose an account on line ${idx + 1}.` });
          if (!Number(l.department_id)) return res.status(400).json({ error: `Choose a Department on line ${idx + 1}. It is required so department budgets can be tracked.` });
          const qty = Number(l.qty) || 0;
          const unitPrice = Number(l.unit_price);
          if (!hasAmount(l) && !Number.isFinite(unitPrice)) return res.status(400).json({ error: `Enter an amount on line ${idx + 1}.` });
          const priced = price(l, qty, unitPrice);
          newLines.push({
            id: null, account_id: Number(l.account_id), description: String(l.description || '').trim().slice(0, 500) || null,
            department_id: Number(l.department_id), location_id: Number(l.location_id) || null, qty, rate: priced.unit_price,
            disc_percent: Number(l.disc_percent || 0), tax_code_id: Number(l.tax_code_id) || null, ...priced,
          });
        }
      }

      const sum = (k) => Number(newLines.reduce((s, l) => s + l[k], 0).toFixed(2));
      const gross = sum('ext_price');
      const wtaxAmount = sum('wtax_amount');
      money = {
        subtotal: sum('subtotal'), discount_amount: sum('disc_amount'), net_of_tax: sum('net_of_tax'), tax_amount: sum('tax_amount'),
        gross_amount: gross, wtax_id: wtaxId, wtax_description: wtaxDescription, wtax_amount: wtaxAmount,
        // What Bill Payments / Credits already settled stays settled: Amount Due is the new total
        // less it, and the new total may not go below it.
        amount_due: Number((gross - wtaxAmount - ctx.applied).toFixed(2)),
      };
      // Only a bill something has settled is held at what was settled; with nothing applied the
      // total may be negative (a reversal bill, allowed 2026-10-03) and stays open.
      if (ctx.applied > 0.005 && money.amount_due < -0.005) {
        return res.status(409).json({ error: `${ctx.applied.toFixed(2)} of this bill is already paid or credited, so its total (net of withholding) cannot go below that.` });
      }
      if (ctx.applied > 0.005) money.amount_due = Math.max(0, money.amount_due);
      if (['open', 'paid', 'paid_in_full'].includes(vb.status)) money.status = Math.abs(money.amount_due) <= 0.005 ? 'paid_in_full' : 'open';
      // A standalone bill may also change its supplier.
      if (!hasItemLines) {
        const [[supplier]] = await conn.query('SELECT id FROM suppliers WHERE id = ?', [b.supplier_id]);
        if (!supplier) return res.status(400).json({ error: 'Choose a supplier.' });
        money.supplier_id = supplier.id;
      }
      // The header Account, on either kind of bill (PO bills too, asked 2026-10-03): on an expense
      // bill it is the payable credited, on a PO bill the debit offset (e.g. 20300 Inventory
      // Received Not Billed) -- see computeVendorBillGl.
      if (b.account_id) {
        const [[acct]] = await conn.query('SELECT id FROM chart_of_accounts WHERE id = ?', [b.account_id]);
        if (!acct) return res.status(400).json({ error: 'Choose a valid Account.' });
        money.account_id = acct.id;
      }
    }

    // A changed Account counts too: an imported bill posts from its source GL entry until edited,
    // so the new account would otherwise never reach the GL.
    const moneyChanged = !!money && (Math.abs(Number(vb.gross_amount) - money.gross_amount) > 0.005
      || Math.abs(Number(vb.net_of_tax) - money.net_of_tax) > 0.005 || Math.abs(Number(vb.tax_amount) - money.tax_amount) > 0.005
      || (money.account_id && Number(money.account_id) !== Number(vb.account_id)));
    let oldGlRows = null;
    if (moneyChanged && ctx.oldGl) {
      [oldGlRows] = await conn.query(
        "SELECT account_code, debit, credit FROM live_gl_entries WHERE source_type = 'vendor_bill' AND source_id = ?", [vb.id]);
      // The imported header has no debit account (19,162 of 19,164 bills); the old entry's largest
      // debit that is not input VAT is it. Without this the computed entry would drop its debit leg.
      if (!money.account_id && !vb.account_id && vb.purchase_order_id) {
        const debit = oldGlRows.filter((r) => Number(r.debit) > 0 && String(r.account_code) !== '14300')
          .sort((x, y) => Number(y.debit) - Number(x.debit))[0];
        if (debit) {
          const [[acct]] = await conn.query('SELECT id FROM chart_of_accounts WHERE account_code = ?', [debit.account_code]);
          if (acct) money.account_id = acct.id;
        }
      }
    }
    const update = { ...details, ...(money || {}) };
    await conn.beginTransaction();
    if (oldGlRows) {
      await conn.query("DELETE FROM live_gl_entries WHERE source_type = 'vendor_bill' AND source_id = ?", [vb.id]);
      await logAudit(conn, { billId: vb.id, userId: req.user.id, eventType: 'Updated', fieldName: 'old_system_gl_replaced',
        oldValue: JSON.stringify(oldGlRows).slice(0, 60000), newValue: 'computed from the edited lines' });
    }
    await conn.query(`UPDATE vendor_bills SET ${Object.keys(update).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      [...Object.values(update), vb.id]);

    if (newLines) {
      if (newLines[0] && newLines[0].id) {
        for (const l of newLines) {
          await conn.query(
            `UPDATE vendor_bill_lines SET department_id = ?, unit_price = ?, disc_percent = ?, disc_amount = ?, net_of_tax = ?,
                    tax_code_id = ?, tax_amount = ?, ext_price = ?, is_withhold = ?, wtax_amount = ?, amount_due = ?
              WHERE id = ? AND vendor_bill_id = ?`,
            [l.department_id, l.unit_price, l.disc_percent, l.disc_amount, l.net_of_tax, l.tax_code_id, l.tax_amount,
              l.ext_price, l.is_withhold, l.wtax_amount, l.amount_due, l.id, vb.id]);
        }
      } else {
        await conn.query('DELETE FROM vendor_bill_lines WHERE vendor_bill_id = ?', [vb.id]);
        for (const l of newLines) {
          await conn.query(
            `INSERT INTO vendor_bill_lines
               (vendor_bill_id, purchase_order_line_id, item_id, account_id, description, location_id, department_id, qty, rate, unit_price,
                disc_percent, disc_amount, net_of_tax, tax_code_id, tax_amount, ext_price, is_withhold, wtax_amount, amount_due)
             VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [vb.id, l.account_id, l.description, l.location_id, l.department_id, l.qty, l.rate, l.unit_price,
              l.disc_percent, l.disc_amount, l.net_of_tax, l.tax_code_id, l.tax_amount, l.ext_price, l.is_withhold,
              l.wtax_amount, l.amount_due]);
        }
      }
    }

    const show = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);
    for (const [k, v] of Object.entries(update)) {
      const before = show(vb[k]);
      const same = (before == null && v == null) || String(before ?? '') === String(v ?? '')
        || (typeof v === 'number' && Math.abs(Number(before) - v) < 0.005);
      if (!same) await logAudit(conn, { billId: vb.id, userId: req.user.id, eventType: 'Updated', fieldName: k, oldValue: before, newValue: v });
    }
    if (newLines) await logAudit(conn, { billId: vb.id, userId: req.user.id, eventType: 'Updated', fieldName: 'lines', newValue: `${newLines.length} line(s)` });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM vendor_bills WHERE id = ?', [vb.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    conn.release();
  }
});

// The Reversal Journal popup's table (components/ReversalJournalModal.jsx): the bill's posted entry,
// debits and credits swapped -- the same rows the cancel will post.
router.get('/:id/reversal-preview', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const gl = await postedBillGlRows(pool, req.params.id);
    if (!gl) return res.status(404).json({ error: 'Not found' });
    const { vb } = gl;
    // Never in the ledger (billInLedger): nothing to reverse, so the popup shows no lines.
    const inLedger = await billInLedger(pool, vb);
    res.json({
      doc_no: vb.bill_no,
      doc_date: vb.date_created,
      location: vb.office_location_id ? { id: vb.office_location_id, location_name: vb.office_location_name } : null,
      rows: inLedger ? mirror(gl.glRows) : [],
    });
  } catch (err) { next(err); }
});

// Cancel (void) a bill. Since 2026-10-14 it posts a REVERSAL journal dated the day chosen in the
// popup, and the bill keeps posting its original entry in its own period (lib/glImpact.js), so the
// month it was billed in is not rewritten -- as Sales Invoices, Delivery Tickets and Cheques do.
router.put('/:id/cancel', requireAuth, requirePermission(ROUTE, 'can_void'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[vb]] = await conn.query('SELECT status, purchase_order_id, date_created, gross_amount, wtax_amount, amount_due FROM vendor_bills WHERE id = ?', [req.params.id]);
    if (vb) await assertPeriodOpen(vb.date_created, 'ap', conn);
    if (!vb) return res.status(404).json({ error: 'Not found' });
    if (vb.status === 'cancelled') return res.status(409).json({ error: 'This Vendor Bill is already cancelled.' });
    // The reversal's own date: never before the bill's, and in an open A/P period.
    const body = req.body || {};
    const reversalDateIn = /^\d{4}-\d{2}-\d{2}$/.test(String(body.reversal_date || '')) ? String(body.reversal_date) : null;
    if (reversalDateIn) {
      if (reversalDateIn < String(vb.date_created instanceof Date ? vb.date_created.toISOString() : vb.date_created).slice(0, 10)) {
        return res.status(400).json({ error: 'The reversal date cannot be before the bill date.' });
      }
      await assertPeriodOpen(reversalDateIn, 'ap', conn);
    }
    // Not while anything has paid or credited it (asked 2026-10-06): voiding left those Bill Payments
    // and Bill Credits applied to a void bill -- the cash and AP no longer agreeing, with nothing to
    // say so. What is applied is gross less withholding less what is still due, as Edit reads it.
    const applied = Math.max(0, Number((Number(vb.gross_amount) - Number(vb.wtax_amount || 0) - Number(vb.amount_due)).toFixed(2)));
    if (applied > 0.005) {
      const [docs] = await conn.query(
        `SELECT bp.bill_payment_no AS no FROM bill_payment_lines bpl JOIN bill_payments bp ON bp.id = bpl.bill_payment_id
          WHERE bpl.vendor_bill_id = ? AND bpl.applied_amount > 0 AND bp.status <> 'voided'
         UNION
         SELECT bc.bill_credit_no FROM bill_credit_applications bca JOIN bill_credits bc ON bc.id = bca.bill_credit_id
          WHERE bca.vendor_bill_id = ? AND bca.applied_amount > 0 AND bc.status <> 'voided'`,
        [req.params.id, req.params.id]);
      const names = docs.map((d) => d.no).filter(Boolean);
      return res.status(409).json({
        error: `${applied.toFixed(2)} of this bill is already paid or credited${names.length ? ` (${names.join(', ')})` : ''}. Void or unapply ${names.length === 1 ? 'that' : 'those'} first, then void the bill.`,
      });
    }

    const [lines] = await conn.query('SELECT purchase_order_line_id, qty FROM vendor_bill_lines WHERE vendor_bill_id = ?', [req.params.id]);

    await conn.beginTransaction();
    // A standalone expense bill has no PO lines to give qty back to -- only the status flips.
    for (const l of lines) {
      if (!l.purchase_order_line_id) continue; // an expense line billed nothing off a PO
      await conn.query('UPDATE purchase_order_lines SET billed_qty = GREATEST(billed_qty - ?, 0) WHERE id = ?', [l.qty, l.purchase_order_line_id]);
    }
    await conn.query(
      "UPDATE vendor_bills SET status = 'cancelled', cancelled_by_user_id = ?, cancelled_at = NOW() WHERE id = ?",
      [req.user.id, req.params.id]
    );
    if (vb.purchase_order_id) await recomputePoBillStatus(conn, vb.purchase_order_id);
    await logAudit(conn, { billId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: 'open', newValue: 'cancelled' });
    // The reversal journal (2026-10-14), in the same transaction: a bill is never cancelled without it.
    const gl = await postedBillGlRows(conn, req.params.id);
    const reversal = gl && await billInLedger(conn, gl.vb) ? await postReversalJournal(conn, {
      sourceType: 'vendor_bill', sourceId: Number(req.params.id), sourceNo: gl.vb.bill_no,
      glRows: gl.glRows, documentDate: gl.vb.date_created, voidedAt: new Date(),
      reason: String(body.memo || body.reason || '').trim() || null, userId: req.user.id,
      locationId: body.location_id ? Number(body.location_id) : (gl.vb.office_location_id || null),
      date: reversalDateIn,
    }) : null;
    if (reversal) {
      await logAudit(conn, { billId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'reversal_journal', oldValue: null, newValue: reversal.journalNo });
    }
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM vendor_bills WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
