const express = require('express');
const pool = require('../db');
const { COMPANY } = require('../config/company');
const { PO_TERM_SELECT, PO_TERM_JOINS, termDays } = require('../lib/poTerm');
const mailer = require('../lib/mailer');
const { buildPurchaseOrderPdf, purchaseOrderPdfFilename } = require('../lib/purchaseOrderPdf');
const { requireAuth, requirePermission, isSystemAdmin, userCan } = require('../middleware/auth');
const { assertPeriodOpen, requireOpenPeriod } = require('../lib/accountingPeriod');
const { insertNumbered, insertSuffixed } = require('../lib/docNumber');
const { isApproved, normalisePoStatus, statusNormSql } = require('../lib/poStatus');
const { sendXlsx, day } = require('../lib/xlsxExport');
const { parseDiscountChain } = require('../lib/discountChain');
const { lineDepartmentError } = require('../lib/requireDepartment');
const { notifyPoPending, notifyPoApproved } = require('../lib/approvalNotifications');
const { isNonStockItem } = require('../lib/itemTypes');

// Purchase Order types the General Manager alone approves whatever the amount: PO3 (Services with
// JO). PO4 (Services / Non-Inventory without JO) follows PO1/PO2 from 2026-10-20 -- a Purchasing
// Supervisor approves it up to APPROVAL_THRESHOLD, above that the GM after them. Kept in step with
// lib/approvalNotifications.js and client PurchaseOrderView.jsx.
const GM_ONLY_TYPES = ['PO3'];

// Tells whoever acts next on a PO that has just been saved or approved (lib/approvalNotifications.js).
function notifyPoNextStep(po, actorId) {
  const st = normalisePoStatus(po.status);
  if (st === 'pending_approval' || st === 'pending_approval_gm') {
    return notifyPoPending({ id: po.id, poNo: po.po_no, status: st, total: po.total_amount, type: po.type }, actorId);
  }
  if (isApproved(po.status)) return notifyPoApproved({ id: po.id, poNo: po.po_no, createdBy: po.created_by_user_id }, actorId);
  return null;
}

// A line's Discount % may be a chain ("10;5" -- 10% off, then 5% off the rest). Resolved here into
// the one percent it comes to, which is what every calculation below and every document copied
// from the PO already uses; the chain itself is kept in disc_formula for the screens. Returns an
// error message for a discount that is not a valid percent or chain.
function resolveLineDiscounts(lines) {
  for (const l of lines) {
    const d = parseDiscountChain(l.disc_formula != null && l.disc_formula !== '' ? l.disc_formula : l.disc_percent);
    if (d.error) return d.error;
    l.disc_percent = d.pct;
    l.disc_formula = d.formula;
  }
  return null;
}

// A PO line's amounts are rounded to the centavo at each step (asked 2026-10-08, PO-20099): Subtotal,
// then Discount on it, then Net of Tax = Subtotal - Discount, then Tax on that, then Ext. Price.
// Rounding only at the end gave 2 x 4,696.4285 at 5% off as 8,923.21 (8,923.21415); the
// figures on the page -- 9,392.86 less 469.64 -- say 8,923.22. Rates keep their 6 decimals.
// toFixed(6) first, so a binary float like 1.005 does not round to 1.00.
const cents = (n) => Math.round(Number((Number(n) * 100).toFixed(6))) / 100;
// A quantity at the 4 decimals the PO / receipt lines keep (DECIMAL(14,4)).
const qty4 = (n) => Math.round(Number((Number(n || 0) * 10000).toFixed(6))) / 10000;
const router = express.Router();
const ROUTE = '/purchase-orders';
const APPROVAL_THRESHOLD = 10000;

async function logAudit(conn, { poId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('PurchaseOrder', ?, ?, ?, ?, ?, ?)`,
    [poId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// Powers the Place Order Form's working grid -- every still-open line (PR Qty not yet
// fully caught by PO Qty) across the selected Purchase Requisitions. Skips the real
// screen's Supplier Price comparison/reason-code justification for now (see schema.sql
// note on purchase_orders) -- just a straightforward per-line Supplier/Rate/Tax entry.
router.get('/canvass-lines', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const prIds = String(req.query.pr_ids || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
    if (!prIds.length) return res.json([]);

    const [lines] = await pool.query(
      `SELECT prl.id AS purchase_requisition_line_id, prl.purchase_requisition_id, pr.pr_no,
              prl.item_id, i.item_code, i.display_name AS item_name, prl.purchase_description,
              prl.job_order_id, jo.job_order_no, prl.qty, prl.po_qty, prl.purchase_unit, prl.unit_title,
              -- The requisition's own department, so the PO line it becomes starts out charged to
              -- whoever asked for it rather than to a blank the buyer has to fill in per line.
              pr.department_id,
              COALESCE((SELECT SUM(qty_on_hand) FROM inventory_locations WHERE inventory_id = prl.item_id), 0) AS qty_on_hand
       FROM purchase_requisition_lines prl
       JOIN purchase_requisitions pr ON pr.id = prl.purchase_requisition_id
       LEFT JOIN inventories i ON i.id = prl.item_id
       LEFT JOIN job_orders jo ON jo.id = prl.job_order_id
       WHERE prl.purchase_requisition_id IN (?) AND prl.qty > prl.po_qty
       ORDER BY pr.id, prl.line_no`,
      [prIds]
    );
    lines.forEach((l) => { l.remaining = Number(l.qty) - Number(l.po_qty); });
    res.json(lines);
  } catch (err) {
    next(err);
  }
});

// Mirrors the real "Saved Purchase Orders" list's status tabs -- these don't map onto a
// single column, they're a read-only bucket derived from status + receipt_status +
// bill_status together (e.g. "Pending Billing" means status=approved AND fully received
// AND not yet billed at all). Once ANY billing has happened the bucket is driven by
// bill_status rather than receipt_status, since you can't un-bill your way back to
// "pending receipt" -- billing is always the further-along axis.
// TWO VOCABULARIES LIVE IN purchase_orders.status, and this has to read both.
//
// The app writes codes -- 'pending_approval', 'approved', 'cancelled'. The import from the live
// system wrote that system's LABELS -- 'Fully Billed', 'Approved by General Manager', 'Pending
// Approval for GM'. On the droplet that is 19,475 rows of labels against 6 rows of codes.
//
// Comparing only against codes therefore matched almost nothing: 'Pending Approval' is not
// 'pending_approval' (space, not underscore), and 'Fully Billed' was not consulted at all, so
// 19,295 purchase orders fell through to ELSE and showed as Pending Receipt -- while the PO itself
// displayed "Fully Billed" from the same column. Two screens, one column, opposite answers.
// 'Cancelled' matched only by the accident of MySQL comparing case-insensitively.
//
// Normalised at READ time rather than rewritten in the table: these labels came from the source
// system and Sync from Source will write them again, so a one-off UPDATE would be undone by the
// next sync and this would be back.
const STATUS_NORM = "LOWER(REPLACE(po.status, ' ', '_'))";
const LIST_STATUS_CASE = `
  CASE
    WHEN ${STATUS_NORM} = 'pending_approval' THEN 'pending_approval'
    -- 'Pending Approval for GM' as well as the app's own 'pending_approval_gm'.
    WHEN ${STATUS_NORM} IN ('pending_approval_gm', 'pending_approval_for_gm') THEN 'pending_approval_gm'
    WHEN ${STATUS_NORM} = 'cancelled' THEN 'cancelled'
    -- The source's own settled states are taken at their word. They are the further-along axis:
    -- a PO the live system calls Fully Billed is not awaiting receipt whatever receipt_status,
    -- which the import never populated, happens to say.
    WHEN ${STATUS_NORM} = 'fully_billed' THEN 'fully_billed'
    -- Billing done HERE outranks an earlier label from the source: a PO imported as Pending Billing
    -- and then billed in T1S read Pending Billing for good, because the label was checked first
    -- (2026-10-06). The source's label still stands for a PO nothing here has billed.
    WHEN po.bill_status = 'fully_billed' THEN 'fully_billed'
    WHEN ${STATUS_NORM} = 'partially_billed' OR po.bill_status = 'partially_billed' THEN 'partially_billed'
    WHEN ${STATUS_NORM} = 'pending_billing' THEN 'pending_billing'
    -- Then the workflow this system drives itself, for POs raised here.
    WHEN po.receipt_status = 'fully_received' THEN 'pending_billing'
    WHEN po.receipt_status = 'partially_received' THEN 'partially_received'
    ELSE 'pending_receipt'
  END
`;
const LIST_STATUS_VALUES = [
  'pending_approval', 'pending_approval_gm', 'pending_receipt', 'partially_received',
  'pending_billing', 'partially_billed', 'fully_billed', 'cancelled',
];

// The list's filters, shared with its Excel extract so the file holds exactly what the list shows.
// The common* half leaves out the status tab, since the tab counts are taken across every tab.
function listFilter(req) {
  const { search, status, supplier_id: supplierId, date_from: dateFrom, as_of: asOf } = req.query;
  const commonWhere = [];
  const commonParams = [];
  if (supplierId) { commonWhere.push('po.supplier_id = ?'); commonParams.push(supplierId); }
  // Period From / Date Created (As of): inclusive bounds on Date Created.
  if (dateFrom) { commonWhere.push('po.date_created >= ?'); commonParams.push(String(dateFrom).slice(0, 10)); }
  if (asOf) { commonWhere.push('po.date_created <= ?'); commonParams.push(asOf); }
  if (search) { commonWhere.push('(po.po_no LIKE ? OR s.name LIKE ?)'); commonParams.push(`%${search}%`, `%${search}%`); }

  const where = [...commonWhere];
  const params = [...commonParams];
  if (status && LIST_STATUS_VALUES.includes(status)) { where.push(`(${LIST_STATUS_CASE}) = ?`); params.push(status); }
  return {
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
    params,
    commonWhereSql: commonWhere.length ? `WHERE ${commonWhere.join(' AND ')}` : '',
    commonParams,
  };
}

const LIST_FROM = `FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN users u ON u.id = po.created_by_user_id`;

const LIST_SELECT = `SELECT po.id, po.po_no, po.ref_no, po.type, po.date_created, po.status, po.receipt_status, po.bill_status,
              po.discount_amount, po.net_of_tax, po.tax_amount, po.total_amount, po.memo,
              po.supplier_id, s.name AS supplier_name, COALESCE(u.display_name, po.prepared_by_name) AS created_by_name,
              (${LIST_STATUS_CASE}) AS list_status
       ${LIST_FROM}`;

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { page = '1', limit = '10' } = req.query;
    const { whereSql, params, commonWhereSql, commonParams } = listFilter(req);

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${LIST_FROM} ${whereSql}`, params);

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 10));
    const offset = (pageNum - 1) * limitNum;

    const [rows] = await pool.query(
      `${LIST_SELECT}
       ${whereSql}
       ORDER BY po.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    const [countRows] = await pool.query(
      `SELECT (${LIST_STATUS_CASE}) AS list_status, COUNT(*) AS count ${LIST_FROM} ${commonWhereSql} GROUP BY list_status`,
      commonParams
    );
    const counts = Object.fromEntries(LIST_STATUS_VALUES.map((s) => [s, 0]));
    countRows.forEach((r) => { if (counts[r.list_status] !== undefined) counts[r.list_status] = r.count; });

    res.json({ rows, total, page: pageNum, limit: limitNum, counts });
  } catch (err) {
    next(err);
  }
});

// Extract: every purchase order under the list's current filters and status tab, as a workbook.
// Registered before /:id.
router.get('/export', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { whereSql, params } = listFilter(req);
    const [rows] = await pool.query(`${LIST_SELECT} ${whereSql} ORDER BY po.id DESC`, params);
    const STATUS = {
      pending_approval: 'Pending Approval', pending_approval_gm: 'Pending Approval (GM)',
      pending_receipt: 'Pending Receipt', partially_received: 'Partially Received',
      pending_billing: 'Pending Billing', partially_billed: 'Partially Billed',
      fully_billed: 'Fully Billed', cancelled: 'Cancelled',
    };
    const ITEM_STATUS = { partially_received: 'Partially Received', fully_received: 'Fully Received' };
    await sendXlsx(res, {
      filename: 'purchase-orders.xlsx',
      sheet: 'Purchase Orders',
      columns: [
        { header: 'PO No', key: 'po_no', width: 14 },
        { header: 'Ref. No', key: 'ref_no', width: 14 },
        { header: 'Date Created', key: 'date_created', width: 12 },
        { header: 'Supplier', key: 'supplier', width: 38 },
        { header: 'Discount Amt', key: 'discount', width: 14, money: true },
        { header: 'Total Amt (Net of VAT)', key: 'net', width: 20, money: true },
        { header: 'Tax Amt', key: 'tax', width: 14, money: true },
        { header: 'Total Amt', key: 'total', width: 15, money: true },
        { header: 'Prepared By', key: 'prepared_by', width: 24 },
        { header: 'Status', key: 'status', width: 20 },
        { header: 'Item Status', key: 'item_status', width: 18 },
        { header: 'PO Type', key: 'type', width: 14 },
        { header: 'Memo', key: 'memo', width: 50 },
      ],
      rows: rows.map((r) => ({
        po_no: r.po_no, ref_no: r.ref_no || '', date_created: day(r.date_created), supplier: r.supplier_name || '',
        discount: Number(r.discount_amount || 0), net: Number(r.net_of_tax || 0), tax: Number(r.tax_amount || 0),
        total: Number(r.total_amount || 0), prepared_by: r.created_by_name || '',
        status: STATUS[r.list_status] || r.list_status, item_status: ITEM_STATUS[r.receipt_status] || '',
        type: r.type || '', memo: r.memo || '',
      })),
    });
  } catch (err) {
    if (res.headersSent) { res.destroy(err); return; }
    next(err);
  }
});

// A Landed Cost PO's mother. Linked by parent_purchase_order_id when made here, but the PO2s that
// came over from the real system carry no link -- only the number: PO-20594-1 is PO-20594's. So an
// unlinked PO2 falls back on its number, and the mother's Landed Cost tab matches the same way.
const PARENT_PO_JOIN = `LEFT JOIN purchase_orders parent ON parent.id = po.parent_purchase_order_id
         OR (po.parent_purchase_order_id IS NULL AND po.type = 'PO2' AND parent.po_no = SUBSTRING_INDEX(po.po_no, '-', 2))`;

// A PO1's Landed Cost POs (PO2) not yet received. While any is open the PO1 cannot be received
// (asked 2026-10-12): its landed cost is received first, so the charge is in before the goods are.
// Settled means received, or past it -- an imported PO2 the source calls Pending / Partially / Fully
// Billed was received there (911 of them read receipt_status 'not_received' here). A cancelled one
// does not count. Linked as the Landed Cost tab links them: parent_purchase_order_id, or the number.
async function openLandedCosts(conn, parentId) {
  const [rows] = await conn.query(
    `SELECT po.po_no, po.status FROM purchase_orders po
      WHERE po.type = 'PO2' AND po.receipt_status <> 'fully_received'
        AND ${statusNormSql('po.status')} NOT IN ('cancelled', 'canceled', 'pending_billing', 'partially_billed', 'fully_billed', 'billed')
        AND (po.parent_purchase_order_id = ?
             OR (po.parent_purchase_order_id IS NULL
                 AND po.po_no LIKE CONCAT((SELECT m.po_no FROM purchase_orders m WHERE m.id = ?), '-%')))
      ORDER BY po.id`,
    [parentId, parentId]);
  return rows.map((r) => r.po_no);
}

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[po]] = await pool.query(
      `SELECT po.*, s.name AS supplier_name, s.supplier_code, COALESCE(u.display_name, po.prepared_by_name) AS created_by_name,
              ${PO_TERM_SELECT}, parent.po_no AS parent_po_no, parent.id AS parent_po_id
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN users u ON u.id = po.created_by_user_id
       ${PO_TERM_JOINS}
       ${PARENT_PO_JOIN}
       WHERE po.id = ?`,
      [req.params.id]
    );
    if (!po) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT pol.*, i.item_code, i.display_name AS item_name, pr.pr_no, prl.qty AS pr_qty, t.code AS tax_code,
              loc.location_name, d.name AS department_name, jo.job_order_no
       FROM purchase_order_lines pol
       LEFT JOIN inventories i ON i.id = pol.item_id
       LEFT JOIN purchase_requisition_lines prl ON prl.id = pol.purchase_requisition_line_id
       LEFT JOIN purchase_requisitions pr ON pr.id = prl.purchase_requisition_id
       LEFT JOIN taxes t ON t.id = pol.tax_code_id
       LEFT JOIN locations loc ON loc.id = pol.location_id
       LEFT JOIN departments d ON d.id = pol.department_id
       LEFT JOIN job_orders jo ON jo.id = pol.job_order_id
       WHERE pol.purchase_order_id = ?`,
      [req.params.id]
    );

    // What holds up receiving this PO, shown against its Receive button.
    const openLanded = po.type === 'PO2' ? [] : await openLandedCosts(pool, po.id);
    res.json({ ...po, lines, open_landed_costs: openLanded });
  } catch (err) {
    next(err);
  }
});

// Printable Purchase Order -- the copy that goes to the supplier.
//
// Who may print:
//   System Admin  -- any purchase order, at any status.
//   Everyone else -- needs can_print on /purchase-orders AND a PO that has been APPROVED.
//
// The approval rule is the point of the gate. A printed PO is an order placed: hand one to a
// supplier and they will deliver against it. Printing one still sitting at Pending Approval would
// commit the company to a purchase nobody has signed off, and the paper would carry no trace that
// it was never approved. Admins are exempt so historical orders can always be reprinted.
//
// isApproved(), not `status === 'approved'`: 19,066 of the purchase orders on the droplet carry
// the live system's labels ('Fully Billed', 'Approved by General Manager') rather than this app's
// codes, and every one of them was approved long ago. See lib/poStatus.js.
// The printable PO -- header, lines and the sign-off signatures. Shared by the print page and the
// emailed PDF, so the supplier is sent exactly the document the Print button shows.
async function loadPrintablePo(id) {
    const [[po]] = await pool.query(
      `SELECT po.*, s.name AS supplier_name, s.supplier_code, s.address AS supplier_address,
              s.tin AS supplier_tin, s.contact_no AS supplier_contact_no, s.email AS supplier_email,
              s.credit_term AS supplier_credit_term,
              COALESCE(u.display_name, po.prepared_by_name) AS created_by_name,
              -- Term as the PO page reads it (2026-11-12): the PO's own, else the supplier's payment term.
              ${PO_TERM_SELECT},
              sup.display_name AS approved_by_supervisor_name,
              gm.display_name AS approved_by_gm_name,
              parent.po_no AS parent_po_no
         FROM purchase_orders po
         LEFT JOIN suppliers s ON s.id = po.supplier_id
         LEFT JOIN users u ON u.id = po.created_by_user_id
         LEFT JOIN users sup ON sup.id = po.approved_by_supervisor_user_id
         LEFT JOIN users gm ON gm.id = po.approved_by_gm_user_id
         ${PO_TERM_JOINS}
         ${PARENT_PO_JOIN}
        WHERE po.id = ?`,
      [id]
    );
    if (!po) return null;

    const [lines] = await pool.query(
      `SELECT pol.*, i.item_code, i.display_name AS item_name, t.code AS tax_code,
              loc.location_name, d.name AS department_name,
              -- The JO the line is bought for: its own, else its PR line's (a PO-1 from a PR).
              COALESCE(jo.id, pjo.id) AS line_job_order_id, COALESCE(jo.job_order_no, pjo.job_order_no) AS job_order_no
         FROM purchase_order_lines pol
         LEFT JOIN inventories i ON i.id = pol.item_id
         LEFT JOIN taxes t ON t.id = pol.tax_code_id
         LEFT JOIN locations loc ON loc.id = pol.location_id
         LEFT JOIN departments d ON d.id = pol.department_id
         LEFT JOIN job_orders jo ON jo.id = pol.job_order_id
         LEFT JOIN purchase_requisition_lines prl ON prl.id = pol.purchase_requisition_line_id
         LEFT JOIN job_orders pjo ON pjo.id = prl.job_order_id
        WHERE pol.purchase_order_id = ?
        ORDER BY pol.id`,
      [id]
    );

    // The signatures for the sign-off block, fetched here and nowhere else (a few KB of PNG each,
    // and only the printed sheet has anywhere to put them) -- the same arrangement as Forms.
    // Taken from the people the workflow RECORDED, never from whoever is printing: the preparer,
    // and the approver the page names (the GM where the GM signed it off, else the supervisor).
    // Someone with no signature on file leaves the line blank to be signed by hand.
    const approverId = po.approved_by_gm_user_id || po.approved_by_supervisor_user_id || null;
    const signers = [po.created_by_user_id, approverId].filter(Boolean);
    let preparedSignature = null;
    let approvedSignature = null;
    if (signers.length) {
      const [sigs] = await pool.query(
        'SELECT id, signature_data FROM users WHERE id IN (?) AND signature_data IS NOT NULL', [signers]);
      const byId = new Map(sigs.map((s) => [String(s.id), s.signature_data]));
      preparedSignature = byId.get(String(po.created_by_user_id)) || null;
      approvedSignature = approverId ? byId.get(String(approverId)) || null : null;
    }

    // "Approved by": one fixed signatory on every printed PO, named by PO_FINAL_APPROVER_USERNAME --
    // the recorded approver above prints as "Pre-Approved by". Unset, the line is left blank to be
    // signed by hand.
    const finalUsername = process.env.PO_FINAL_APPROVER_USERNAME || '';
    const [[finalApprover]] = finalUsername
      ? await pool.query('SELECT display_name, signature_data FROM users WHERE username = ? LIMIT 1', [finalUsername])
      : [[null]];

    return {
      ...po, lines, prepared_signature: preparedSignature, approved_signature: approvedSignature,
      final_approver_name: finalApprover?.display_name || '',
      final_approver_signature: finalApprover?.signature_data || null,
    };
}

// Who may print -- and so email -- a PO: can_print on the page, and the PO approved. A System
// Admin is exempt from both. Returns null when allowed, else { status, body } to answer with.
async function printRefusal(userId, po, verb = 'print') {
  if (await isSystemAdmin(userId)) return null;
  const [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (!page) return { status: 500, body: { error: `Page not registered: ${ROUTE}` } };
  const [[perm]] = await pool.query(
    'SELECT can_print FROM user_page_permissions WHERE user_id = ? AND page_id = ?',
    [userId, page.id]
  );
  if (!perm || !perm.can_print) {
    return { status: 403, body: { error: `You do not have permission to ${verb} a Purchase Order` } };
  }
  // Reported separately from the permission failure: "ask your admin for access" and "get it
  // approved first" are different problems with different fixes.
  if (!isApproved(po.status)) {
    return {
      status: 403,
      body: { error: `This Purchase Order is ${po.status} -- only an approved Purchase Order can be ${verb === 'print' ? 'printed' : 'emailed'}.`, reason: 'not_approved' },
    };
  }
  return null;
}

// The document trail printed under the PO (asked 2026-10-08, the live system's box): every Receiving
// Report, Vendor Bill, Bill Credit, Journal and Bill Payment that followed the order, plus PAY, the
// release of each bill payment's check. Each row: date, reference, who processed it and that user's
// signature on file. Voided / cancelled documents are left out.
//   RR    purchase_order_receipts of this PO
//   VB    vendor_bills of this PO
//   BC    bill_credits on those bills, directly or applied to them
//   BPAY  bill_payments paying those bills
//   JRNL  journals raised from those bill payments
//   PAY   those bill payments' release -- Date Released and Check No.
async function loadDocumentTrail(poId) {
  const userCols = 'u.display_name AS processed_by, u.signature_data AS signature';
  const [rr] = await pool.query(
    `SELECT 'RR' AS type, r.date_created AS date, r.receipt_no AS ref, ${userCols}
       FROM purchase_order_receipts r LEFT JOIN users u ON u.id = r.created_by_user_id
      WHERE r.purchase_order_id = ? ORDER BY r.date_created, r.id`, [poId]);
  const [vb] = await pool.query(
    `SELECT 'VB' AS type, vb.id, vb.date_created AS date, COALESCE(NULLIF(vb.bill_no, ''), vb.reference_no) AS ref, ${userCols}
       FROM vendor_bills vb LEFT JOIN users u ON u.id = vb.created_by_user_id
      WHERE vb.purchase_order_id = ? AND vb.cancelled_at IS NULL AND LOWER(COALESCE(vb.status, '')) NOT LIKE '%cancel%'
      ORDER BY vb.date_created, vb.id`, [poId]);
  const billIds = vb.map((b) => b.id);
  let bc = []; let bpay = []; let jrnl = [];
  if (billIds.length) {
    [bc] = await pool.query(
      `SELECT DISTINCT 'BC' AS type, bc.date_created AS date, bc.bill_credit_no AS ref, ${userCols}
         FROM bill_credits bc LEFT JOIN users u ON u.id = bc.created_by_user_id
        WHERE (bc.vendor_bill_id IN (?) OR bc.id IN (SELECT bca.bill_credit_id FROM bill_credit_applications bca WHERE bca.vendor_bill_id IN (?)))
          AND bc.voided_at IS NULL AND LOWER(COALESCE(bc.status, '')) NOT LIKE '%void%'
        ORDER BY bc.date_created`, [billIds, billIds]);
    [bpay] = await pool.query(
      `SELECT DISTINCT bp.id, bp.date_created AS date, bp.bill_payment_no AS ref, bp.date_released, bp.check_no, ${userCols}
         FROM bill_payments bp
         JOIN bill_payment_lines bpl ON bpl.bill_payment_id = bp.id
         LEFT JOIN users u ON u.id = bp.created_by_user_id
        WHERE bpl.vendor_bill_id IN (?) AND bp.voided_at IS NULL AND LOWER(COALESCE(bp.status, '')) NOT LIKE '%void%'
        ORDER BY bp.date_created, bp.id`, [billIds]);
    if (bpay.length) {
      [jrnl] = await pool.query(
        `SELECT 'JRNL' AS type, j.date_created AS date, j.journal_no AS ref, ${userCols}
           FROM journals j LEFT JOIN users u ON u.id = j.created_by_user_id
          WHERE j.source_type = 'bill_payment' AND j.source_id IN (?) AND j.voided_at IS NULL
          ORDER BY j.date_created, j.id`, [bpay.map((p) => p.id)]);
    }
  }
  const strip = ({ id, date_released: dr, check_no: cn, ...row }) => row;
  return {
    RR: rr, VB: vb.map(strip), BC: bc, JRNL: jrnl,
    BPAY: bpay.map((p) => strip({ ...p, type: 'BPAY' })),
    PAY: bpay.filter((p) => p.date_released || p.check_no).map((p) => ({
      type: 'PAY', date: p.date_released, ref: p.check_no || p.ref, processed_by: p.processed_by, signature: p.signature,
    })),
  };
}

router.get('/:id/print', requireAuth, async (req, res, next) => {
  try {
    const po = await loadPrintablePo(req.params.id);
    if (!po) return res.status(404).json({ error: 'Not found' });
    const refused = await printRefusal(req.user.id, po);
    if (refused) return res.status(refused.status).json(refused.body);
    po.trail = await loadDocumentTrail(po.id);
    res.json(po);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- email to the supplier
//
// The approved PO, as a PDF, to the supplier -- the same document the Print button produces, so
// nobody has to print it, scan it and attach it by hand. Open to whoever may print it (the same
// gate), since emailing it is just delivering the printout.
//
// The address defaults to the one last used for this PO (a correction made once is the better
// guess), then the supplier record's email; the sender can always override it. Each send is
// written to the PO's audit log -- field 'emailed_to_supplier' -- which is also where "last sent"
// is read back from. No schema change.
const EMAIL_FIELD = 'emailed_to_supplier';
const escHtml = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const peso = (n) => `PHP ${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function lastEmailed(poId) {
  const [[row]] = await pool.query(
    `SELECT a.new_value AS sent_to, a.set_at AS sent_at, u.display_name AS sent_by_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
      WHERE a.auditable_type = 'PurchaseOrder' AND a.auditable_id = ? AND a.field_name = ?
      ORDER BY a.set_at DESC, a.id DESC LIMIT 1`,
    [poId, EMAIL_FIELD]
  );
  return row || null;
}

function buildPoEmail(po, { senderName, senderEmail, note }) {
  const subject = `Purchase Order ${po.po_no} from ${COMPANY.name}`;
  const lines = po.lines || [];
  const intro = `Please find attached our Purchase Order ${po.po_no}${po.need_by_date ? `, needed by ${String(po.need_by_date instanceof Date ? po.need_by_date.toISOString() : po.need_by_date).slice(0, 10)}` : ''}.`;
  const text = [
    `Dear ${po.supplier_name || 'Supplier'},`, '', intro, note ? `\n${note}\n` : '',
    `Items: ${lines.length}`, `Total Amount: ${peso(po.total_amount)}`, '',
    'Kindly confirm receipt of this order.', '', 'Thank you,', senderName || 'Purchasing', senderEmail || '',
    COMPANY.name,
  ].join('\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;font-size:14px;line-height:1.5">
  <p>Dear ${escHtml(po.supplier_name || 'Supplier')},</p>
  <p>${escHtml(intro)}</p>
  ${note ? `<p style="white-space:pre-wrap;border-left:3px solid #C9A227;padding-left:10px">${escHtml(note)}</p>` : ''}
  <table style="border-collapse:collapse;margin:8px 0">
    <tr><td style="padding:3px 12px 3px 0;color:#64748b">PO No.</td><td style="font-weight:bold">${escHtml(po.po_no)}</td></tr>
    <tr><td style="padding:3px 12px 3px 0;color:#64748b">Items</td><td>${lines.length}</td></tr>
    <tr><td style="padding:3px 12px 3px 0;color:#64748b">Total Amount</td><td style="font-weight:bold">${escHtml(peso(po.total_amount))}</td></tr>
  </table>
  <p>Kindly confirm receipt of this order.</p>
  <p>Thank you,<br>${escHtml(senderName || 'Purchasing')}${senderEmail ? `<br><a href="mailto:${escHtml(senderEmail)}">${escHtml(senderEmail)}</a>` : ''}<br>
  <span style="color:#2E3F1C;font-weight:bold">${escHtml(COMPANY.name)}</span></p>
</div>`;
  return { subject, html, text };
}

router.get('/:id/email-recipient', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[po]] = await pool.query(
      `SELECT po.id, po.status, s.name AS supplier_name, s.email AS supplier_email
         FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ?`,
      [req.params.id]
    );
    if (!po) return res.status(404).json({ error: 'Not found' });
    const last = await lastEmailed(req.params.id);
    const onFile = String(po.supplier_email || '').trim();
    res.json({
      suggested: last?.sent_to || onFile || '',
      source: last?.sent_to ? 'the address last used' : onFile ? 'the supplier record' : null,
      supplierName: po.supplier_name,
      sentAt: last?.sent_at || null,
      sentTo: last?.sent_to || null,
      sentByName: last?.sent_by_name || null,
      mailConfigured: mailer.isConfigured(),
      mailProblem: mailer.isConfigured() ? null : mailer.missingReason(),
    });
  } catch (err) { next(err); }
});

router.post('/:id/email', requireAuth, async (req, res, next) => {
  try {
    if (!mailer.isConfigured()) {
      return res.status(503).json({ error: `Email is not set up on this server -- ${mailer.missingReason()}.` });
    }
    const po = await loadPrintablePo(req.params.id);
    if (!po) return res.status(404).json({ error: 'Not found' });
    const refused = await printRefusal(req.user.id, po, 'email');
    if (refused) return res.status(refused.status).json(refused.body);

    const to = String(req.body?.email || po.supplier_email || '').trim();
    if (!to) return res.status(400).json({ error: 'This supplier has no email address on file. Enter one to send it to.' });
    // Permissive on purpose -- catches a missing @ or a stray space, nothing more.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return res.status(400).json({ error: `"${to}" does not look like an email address.` });
    }

    // Unlike the estimate's, the PDF IS the message here: a PO email without the PO is useless, so
    // a PDF that will not build stops the send rather than going out empty-handed.
    let pdf;
    try { pdf = await buildPurchaseOrderPdf(po); } catch (pdfErr) {
      console.error(`purchase order ${req.params.id}: PDF failed --`, pdfErr);
      return res.status(500).json({ error: `The Purchase Order PDF could not be generated: ${pdfErr.message}` });
    }

    // Replies go to whoever sent it -- the buyer the supplier should answer.
    const [[me]] = await pool.query('SELECT display_name, email FROM users WHERE id = ?', [req.user.id]);
    const { subject, html, text } = buildPoEmail(po, {
      senderName: me?.display_name, senderEmail: me?.email, note: String(req.body?.note || '').trim() || null,
    });
    const filename = purchaseOrderPdfFilename(po);
    const sent = await mailer.send({
      to, subject, html, text,
      attachments: [{ filename, content: pdf, contentType: 'application/pdf' }],
      replyTo: me?.email || undefined, fromName: me?.display_name,
    });
    if (!sent.ok) return res.status(502).json({ error: `The mail server refused it: ${sent.error}` });

    // Recorded only after it actually went. 'Updated', not 'Emailed': audit_logs.event_type is an
    // ENUM without the latter. A failed audit line must not turn a sent email into an error.
    try {
      await logAudit(pool, {
        poId: req.params.id, userId: req.user.id, eventType: 'Updated',
        fieldName: EMAIL_FIELD, newValue: to.slice(0, 255),
      });
    } catch (auditErr) {
      console.error(`purchase order ${req.params.id}: emailed to ${to}, audit entry failed --`, auditErr.message);
    }
    res.json({ ok: true, sentTo: to, sentAt: new Date().toISOString(), attachedPdf: filename });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'PurchaseOrder' AND a.auditable_id = ?
       ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// "Compare" on a Purchase Order line -- what this item has cost before, so the rate being
// approved can be judged against what was actually paid for it elsewhere.
//
// Two tables, from one body of purchases (PURCHASES_SQL below):
//
//   suppliers  one row per supplier, its MOST RECENT price -- the comparison itself, and what
//              the live system's own "Supplier Prices" popup shows. Computed over EVERY purchase,
//              not over the listed page of history: a supplier last used in 2022 still belongs in
//              a price comparison, and on a busy item it would fall off any sensible LIMIT.
//   history    the individual purchases behind it, newest first, capped -- a long-running item
//              has hundreds and nobody reads past the recent ones.
//
// A purchase is counted once, from the document that holds the price actually paid: the Receiving
// Report where the item has been received (its rate is the invoice price, which can differ from
// the PO's), the Purchase Order itself where it has not. Cancelled POs are not purchases.
// `exclude_po` keeps the order being looked at out of its own history.
//
// inventory_supplier_prices is folded in last, for suppliers this install holds no document for.
// That table is empty on the droplet today, but the Inventory screen maintains it by hand and the
// source system's own popup reads from a list like it -- a hand-entered quotation for a supplier
// never yet bought from is exactly what a comparison wants. Those rows carry their ref_no as text,
// not a link: the document they name may not be in this database.
const PURCHASES_SQL = `
  SELECT 'RR' AS doc_type, rl.id AS line_id, rr.id AS doc_id, rr.receipt_no AS doc_no,
         rr.date_created AS doc_date, po.id AS purchase_order_id, po.po_no,
         po.supplier_id, s.name AS supplier_name,
         rl.qty_received AS qty, rl.rate, rl.disc_percent,
         COALESCE(pol.purchase_unit, pol.unit_title) AS unit
    FROM purchase_order_receipt_lines rl
    JOIN purchase_order_receipts rr ON rr.id = rl.purchase_order_receipt_id
    JOIN purchase_order_lines pol ON pol.id = rl.purchase_order_line_id
    JOIN purchase_orders po ON po.id = rr.purchase_order_id
    JOIN suppliers s ON s.id = po.supplier_id
   WHERE rl.item_id = ? AND po.id <> ?
  UNION ALL
  SELECT 'PO', pol.id, po.id, po.po_no,
         po.date_created, po.id, po.po_no,
         po.supplier_id, s.name,
         pol.qty, pol.rate, pol.disc_percent,
         COALESCE(pol.purchase_unit, pol.unit_title)
    FROM purchase_order_lines pol
    JOIN purchase_orders po ON po.id = pol.purchase_order_id
    JOIN suppliers s ON s.id = po.supplier_id
   WHERE pol.item_id = ? AND po.id <> ?
     AND ${statusNormSql('po.status')} NOT IN ('cancelled', 'canceled')
     AND NOT EXISTS (
       SELECT 1 FROM purchase_order_receipt_lines rl2 WHERE rl2.purchase_order_line_id = pol.id
     )`;

const PRICE_HISTORY_LIMIT = 50;

router.get('/item-price-history/:itemId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const itemId = Number(req.params.itemId);
    if (!itemId) return res.status(400).json({ error: 'itemId is required' });
    // 0 matches no purchase order, so "no exclusion" needs no second version of the query.
    const excludePo = Number(req.query.exclude_po) || 0;
    const args = [itemId, excludePo, itemId, excludePo];

    const [[item]] = await pool.query(
      'SELECT id, item_code, display_name FROM inventories WHERE id = ?',
      [itemId]
    );
    if (!item) return res.status(404).json({ error: 'Not found' });

    const [history] = await pool.query(
      `SELECT * FROM (${PURCHASES_SQL}) h
        ORDER BY h.doc_date DESC, h.doc_id DESC
        LIMIT ${PRICE_HISTORY_LIMIT}`,
      args
    );

    // One row per supplier: its newest purchase, by the same ordering the history reads in.
    const [latest] = await pool.query(
      `SELECT r.* FROM (
         SELECT h.*, ROW_NUMBER() OVER (
                  PARTITION BY h.supplier_id ORDER BY h.doc_date DESC, h.doc_id DESC
                ) AS rn
           FROM (${PURCHASES_SQL}) h
       ) r
       WHERE r.rn = 1
       ORDER BY r.doc_date DESC`,
      args
    );

    const [priceList] = await pool.query(
      `SELECT isp.supplier_id, s.name AS supplier_name, isp.price AS rate,
              isp.last_purchase_date, isp.ref_no
         FROM inventory_supplier_prices isp
         JOIN suppliers s ON s.id = isp.supplier_id
        WHERE isp.inventory_id = ?
        ORDER BY isp.last_purchase_date DESC, isp.id DESC`,
      [itemId]
    );

    const bySupplier = new Map();
    for (const h of latest) {
      bySupplier.set(h.supplier_id, {
        supplier_id: h.supplier_id,
        supplier_name: h.supplier_name,
        rate: h.rate,
        unit: h.unit,
        last_purchase_date: h.doc_date,
        ref_no: h.doc_no,
        doc_type: h.doc_type,
        doc_id: h.doc_id,
        source: 'document',
      });
    }
    for (const p of priceList) {
      // Price list ordered newest-first, so the first row for a supplier is the one to keep.
      if (bySupplier.has(p.supplier_id)) continue;
      bySupplier.set(p.supplier_id, {
        supplier_id: p.supplier_id,
        supplier_name: p.supplier_name,
        rate: p.rate,
        unit: null,
        last_purchase_date: p.last_purchase_date,
        ref_no: p.ref_no,
        doc_type: null,
        doc_id: null,
        source: 'price_list',
      });
    }

    // Newest first, undated price-list rows last -- the same order the popup reads in.
    const suppliers = [...bySupplier.values()].sort((a, b) => {
      const da = a.last_purchase_date ? new Date(a.last_purchase_date).getTime() : -Infinity;
      const db = b.last_purchase_date ? new Date(b.last_purchase_date).getTime() : -Infinity;
      return db - da;
    });

    res.json({ item, suppliers, history, history_limit: PRICE_HISTORY_LIMIT });
  } catch (err) {
    next(err);
  }
});

// Saving splits the working grid into one PO per distinct Supplier -- a canvass batch
// covering several suppliers becomes several POs in one Save, matching the real screen.
// Each line's qty is capped against its source PR line's own remaining (qty - po_qty)
// balance, re-checked fresh here rather than trusting whatever the client last saw.
router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { date_created: dateCreated, ref_no: refNo, memo, lines } = req.body;
    const submitted = (Array.isArray(lines) ? lines : []).filter((l) => l.item_id && l.supplier_id && Number(l.qty) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Add at least one line with a Supplier and Qty greater than 0.' });
    const discError = resolveLineDiscounts(submitted);
    if (discError) return res.status(400).json({ error: discError });
    const deptError = lineDepartmentError(submitted);
    if (deptError) return res.status(400).json({ error: deptError });
    await assertPeriodOpen(dateCreated, 'non_gl', conn);

    const prLineIds = [...new Set(submitted.map((l) => l.purchase_requisition_line_id).filter(Boolean))];
    const prLineById = new Map();
    if (prLineIds.length) {
      const [prLines] = await conn.query('SELECT id, qty, po_qty FROM purchase_requisition_lines WHERE id IN (?)', [prLineIds]);
      prLines.forEach((l) => prLineById.set(l.id, l));
    }
    const consumedByPrLine = {};
    for (const l of submitted) {
      if (!l.purchase_requisition_line_id) continue;
      const prLine = prLineById.get(l.purchase_requisition_line_id);
      if (!prLine) return res.status(400).json({ error: 'One of the selected PR lines is no longer valid.' });
      const remaining = Number(prLine.qty) - Number(prLine.po_qty) - (consumedByPrLine[l.purchase_requisition_line_id] || 0);
      if (Number(l.qty) > remaining) {
        return res.status(409).json({ error: `Qty for ${l.purchase_description || 'a line'} exceeds what's still open on its PR (${remaining}).` });
      }
      consumedByPrLine[l.purchase_requisition_line_id] = (consumedByPrLine[l.purchase_requisition_line_id] || 0) + Number(l.qty);
    }

    // Tax rate is looked up server-side (never trusted from the client) -- same
    // discipline as the Sales Invoice line copy.
    const taxCodeIds = [...new Set(submitted.map((l) => l.tax_code_id).filter(Boolean))];
    const taxRateById = new Map();
    if (taxCodeIds.length) {
      const [taxRows] = await conn.query('SELECT id, rate FROM taxes WHERE id IN (?)', [taxCodeIds]);
      taxRows.forEach((t) => taxRateById.set(t.id, Number(t.rate)));
    }

    const groups = new Map();
    for (const l of submitted) {
      if (!groups.has(l.supplier_id)) groups.set(l.supplier_id, []);
      groups.get(l.supplier_id).push(l);
    }

    await conn.beginTransaction();
    const createdPOs = [];
    for (const [supplierId, groupLines] of groups) {
      let subtotal = 0; let discountAmount = 0; let netOfTax = 0; let taxAmount = 0;
      const computed = groupLines.map((l) => {
        const qty = Number(l.qty);
        const rate = Number(l.rate || 0);
        const discPercent = Number(l.disc_percent || 0);
        const lineSubtotal = cents(qty * rate);
        const lineDiscAmount = cents(lineSubtotal * (discPercent / 100));
        const lineNetOfTax = cents(lineSubtotal - lineDiscAmount);
        const taxRatePct = l.tax_code_id ? (taxRateById.get(l.tax_code_id) || 0) : 0;
        // Ext. Price is the gross the supplier bills, from the unrounded figures; Tax is what is left
        // over Net of Tax, so the rounded Net + Tax always equals it (PO-20586: 28,828.12 + 3,459.38 =
        // 32,287.50, not 3,459.37 and a total a centavo short).
        const extPrice = taxRatePct ? cents(qty * rate * (1 - discPercent / 100) * (1 + taxRatePct / 100)) : lineNetOfTax;
        const lineTaxAmount = cents(extPrice - lineNetOfTax);
        subtotal += lineSubtotal; discountAmount += lineDiscAmount; netOfTax += lineNetOfTax; taxAmount += lineTaxAmount;
        return { ...l, lineSubtotal, lineDiscAmount, lineNetOfTax, lineTaxAmount, extPrice };
      });
      const totalAmount = netOfTax + taxAmount;

      const { id: poId, no: poNo } = await insertNumbered(conn, {
        table: 'purchase_orders',
        column: 'po_no',
        prefix: 'PO-',
        run: (no) => conn.query(
          `INSERT INTO purchase_orders (po_no, date_created, supplier_id, ref_no, memo, subtotal, discount_amount, net_of_tax, tax_amount, total_amount, status, created_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?)`,
          [no, dateCreated || new Date().toISOString().slice(0, 10), supplierId, refNo || null, memo || null, subtotal, discountAmount, netOfTax, taxAmount, totalAmount, req.user.id]
        ),
      });

      for (const l of computed) {
        await conn.query(
          `INSERT INTO purchase_order_lines
             (purchase_order_id, purchase_requisition_line_id, item_id, purchase_description, location_id, department_id,
              qty, purchase_unit, unit_title, rate, disc_percent, disc_formula, disc_amount, net_of_tax, tax_code_id, tax_amount, ext_price)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [poId, l.purchase_requisition_line_id || null, l.item_id, l.purchase_description || null, l.location_id || null, l.department_id || null,
            l.qty, l.purchase_unit || null, l.unit_title || null, l.rate || 0, l.disc_percent || 0, l.disc_formula || null, l.lineDiscAmount, l.lineNetOfTax, l.tax_code_id || null, l.lineTaxAmount, l.extPrice]
        );
        if (l.purchase_requisition_line_id) {
          await conn.query('UPDATE purchase_requisition_lines SET po_qty = po_qty + ? WHERE id = ?', [l.qty, l.purchase_requisition_line_id]);
        }
      }
      await logAudit(conn, { poId, userId: req.user.id, eventType: 'Created', fieldName: 'po_no', newValue: poNo });
      createdPOs.push(poId);
    }

    // Once every line on a PR has caught its po_qty up to the full requested qty, the
    // PR itself moves to Request In-Process (or Completed once received -- not modeled
    // yet since there's no Received PO step in this build).
    for (const prLineId of prLineIds) {
      const [[prLine]] = await conn.query('SELECT purchase_requisition_id FROM purchase_requisition_lines WHERE id = ?', [prLineId]);
      if (!prLine) continue;
      const [allLines] = await conn.query('SELECT qty, po_qty FROM purchase_requisition_lines WHERE purchase_requisition_id = ?', [prLine.purchase_requisition_id]);
      const [[pr]] = await conn.query('SELECT status FROM purchase_requisitions WHERE id = ?', [prLine.purchase_requisition_id]);
      if (pr && pr.status === 'pending_request') {
        const anyOrdered = allLines.some((l) => Number(l.po_qty) > 0);
        if (anyOrdered) {
          await conn.query("UPDATE purchase_requisitions SET status = 'request_in_process', updated_at = NOW() WHERE id = ?", [prLine.purchase_requisition_id]);
        }
      }
    }

    await conn.commit();
    const [pos] = await pool.query('SELECT * FROM purchase_orders WHERE id IN (?)', [createdPOs]);
    pos.forEach((p) => notifyPoNextStep(p, req.user.id));
    res.status(201).json(pos);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Approval path depends on PO type and amount (see the /direct route's status pick for
// PO3/PO4, which skip straight to the GM tier below):
//   PO1/PO2/PO4, total > APPROVAL_THRESHOLD: Purchasing Supervisor approves -> pending_approval_gm
//     -> General Manager approves -> 'approved'.
//   PO1/PO2/PO4, total <= APPROVAL_THRESHOLD: Purchasing Supervisor approves -> 'approved' directly;
//     the GM is not told.
//   PO3: created straight into pending_approval_gm, and approved by the General Manager alone,
//     whatever the amount -- the GM is notified of every one. (PO4 was GM-only too on 2026-10-19;
//     back with the supervisor tier 2026-10-20.)
// A General Manager (or System Admin) may also approve at the FIRST stage: that approves the PO
// outright, skipping the supervisor tier.
// A System Admin can also perform the GM-tier approval (matches the "GM" ~ admin-level
// authority precedent used elsewhere, e.g. approving PO3/PO4 costing without a dedicated
// GM account existing yet).
router.put('/:id/approve', requireAuth, requirePermission(ROUTE, 'can_approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[po]] = await conn.query('SELECT status, total_amount, type FROM purchase_orders WHERE id = ?', [req.params.id]);
    if (!po) return res.status(404).json({ error: 'Not found' });
    const [[actingUser]] = await conn.query('SELECT is_purchasing_supervisor, account_type FROM users WHERE id = ?', [req.user.id]);

    let newStatus;
    await conn.beginTransaction();
    // Normalised: an imported PO reads 'Pending Approval' / 'Pending Approval for GM', and the
    // view (which normalises) offered Approve on those while this route refused them.
    const st = normalisePoStatus(po.status);
    const isGm = actingUser.account_type === 'System Admin' || actingUser.account_type === 'General Manager';
    if (st === 'pending_approval' && isGm) {
      // The GM outranks the supervisor tier, so a GM approving at the first stage approves it
      // outright -- any amount -- rather than waiting on a Purchasing Supervisor (PO-20623 sat
      // un-approvable for the GM). Stamped in the GM columns: that is who signed it.
      newStatus = 'approved';
      await conn.query(
        "UPDATE purchase_orders SET status = 'approved', approved_by_gm_user_id = ?, approved_by_gm_at = NOW() WHERE id = ?",
        [req.user.id, req.params.id]
      );
    } else if (st === 'pending_approval') {
      if (!actingUser.is_purchasing_supervisor) {
        await conn.rollback();
        return res.status(403).json({ error: 'Only a Purchasing Supervisor or General Manager can approve this Purchase Order at this stage.' });
      }
      newStatus = Number(po.total_amount) > APPROVAL_THRESHOLD ? 'pending_approval_gm' : 'approved';
      await conn.query(
        'UPDATE purchase_orders SET status = ?, approved_by_supervisor_user_id = ?, approved_by_supervisor_at = NOW() WHERE id = ?',
        [newStatus, req.user.id, req.params.id]
      );
    } else if (st === 'pending_approval_gm') {
      // A Purchasing Supervisor may clear this tier too, but only under the threshold. PO3/PO4 are
      // created straight into pending_approval_gm, so without this a 500-peso service PO waited on
      // the General Manager while a 9,000-peso PO1 did not -- the amount, not the type, is what
      // the threshold is there to judge. Above it, still the GM alone.
      // EXCEPT PO3: the General Manager approves those whatever the amount. (A PO4 created here
      // before 2026-10-20 can still be cleared by a supervisor under the threshold.)
      const gmOnly = GM_ONLY_TYPES.includes(po.type);
      const isSupervisorUnderThreshold = !gmOnly && !!actingUser.is_purchasing_supervisor
        && Number(po.total_amount) <= APPROVAL_THRESHOLD;
      if (!isGm && !isSupervisorUnderThreshold) {
        await conn.rollback();
        return res.status(403).json({
          error: gmOnly
            ? `A ${po.type} Purchase Order is approved by the General Manager, whatever the amount.`
            : actingUser.is_purchasing_supervisor
            ? `A Purchasing Supervisor can approve up to ${APPROVAL_THRESHOLD.toLocaleString('en-US')}. This one is for ${Number(po.total_amount).toLocaleString('en-US', { minimumFractionDigits: 2 })} and needs a General Manager.`
            : 'Only a General Manager / System Admin can approve this Purchase Order.',
        });
      }
      newStatus = 'approved';
      // Stamped as whoever actually signed it. Writing the GM columns for a supervisor's approval
      // would make the PO claim a General Manager approved it -- which is exactly what the header
      // reads back from these columns.
      await conn.query(
        isGm
          ? "UPDATE purchase_orders SET status = 'approved', approved_by_gm_user_id = ?, approved_by_gm_at = NOW() WHERE id = ?"
          : "UPDATE purchase_orders SET status = 'approved', approved_by_supervisor_user_id = ?, approved_by_supervisor_at = NOW() WHERE id = ?",
        [req.user.id, req.params.id]
      );
    } else {
      await conn.rollback();
      return res.status(409).json({ error: `This Purchase Order is not pending approval (current status: ${po.status}).` });
    }
    await logAudit(conn, { poId: req.params.id, userId: req.user.id, eventType: 'Approved', fieldName: 'status', oldValue: po.status, newValue: newStatus });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM purchase_orders WHERE id = ?', [req.params.id]);
    notifyPoNextStep(row, req.user.id);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// What may go on a Landed Cost PO: the charges defined in Master Lists > Landed Costs, and
// nothing else.
//
// The picker used to offer the whole inventory -- thousands of stock items, none of which belongs
// on a freight charge. The landed costs themselves already exist as inventory items and every
// existing PO-2 line already points at one, so the LINE does not change; only what can be chosen.
//
// Each lookup entry carries the item it stands for (landed_costs.item_id, see
// db/add-landed-cost-item.js), rather than being matched to one by name -- renaming a landed cost
// must not silently remove it from this list.
//
// An entry with no item linked is deliberately still returned, marked unusable, so the screen can
// say WHY a charge somebody expects is not selectable instead of simply not showing it.
router.get('/meta/landed-cost-items', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      // The unit titles come along because a landed cost line records the quantity in the item's
      // purchase unit, exactly as an ordinary PO line does -- the form should not have to fetch
      // the whole inventory again just to learn them.
      `SELECT lc.id AS landed_cost_id, lc.name, lc.allocation_method,
              i.id, i.item_code, i.display_name,
              pu.title AS purchase_unit_title, bu.title AS base_unit_title
         FROM landed_costs lc
         LEFT JOIN inventories i ON i.id = lc.item_id
         LEFT JOIN units_of_measure pu ON pu.id = i.purchase_unit_id
         LEFT JOIN units_of_measure bu ON bu.id = i.base_unit_id
        WHERE lc.is_active = TRUE
        ORDER BY lc.name`,
    );
    res.json(rows.map((r) => ({ ...r, usable: !!r.id })));
  } catch (err) { next(err); }
});

// Landed Cost (PO-2): a sub-PO tied to an already-Approved, non-PO2 parent PO, used for
// freight/customs/etc. charges. Not sourced from any Purchase Requisition line.
router.get('/:id/landed-costs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT po.id, po.po_no, po.date_created, po.status, po.total_amount, po.memo,
              po.supplier_id, s.name AS supplier_name, pt.term_name
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN payment_terms pt ON pt.id = po.term_id
       WHERE po.type = 'PO2'
         AND (po.parent_purchase_order_id = ?
              OR (po.parent_purchase_order_id IS NULL
                  AND po.po_no LIKE CONCAT((SELECT m.po_no FROM purchase_orders m WHERE m.id = ?), '-%')))
       ORDER BY po.id DESC`,
      [req.params.id, req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/landed-costs', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[parent]] = await conn.query('SELECT po_no, type, status FROM purchase_orders WHERE id = ?', [req.params.id]);
    if (!parent) return res.status(404).json({ error: 'Not found' });
    if (parent.type === 'PO2') return res.status(409).json({ error: 'A Landed Cost PO cannot itself have a Landed Cost.' });
    // isApproved, not a literal compare: an imported PO says 'Approved by General Manager'.
    if (!isApproved(parent.status)) return res.status(409).json({ error: 'The parent Purchase Order must be Approved before adding a Landed Cost.' });

    const { date_created: dateCreated, supplier_id: supplierId, term_id: termId, memo, lines } = req.body;
    await assertPeriodOpen(dateCreated, 'non_gl', conn);
    const submitted = (Array.isArray(lines) ? lines : []).filter((l) => l.item_id && Number(l.qty) > 0);
    if (!supplierId) return res.status(400).json({ error: 'Select a Supplier.' });
    if (!submitted.length) return res.status(400).json({ error: 'Add at least one line with a Qty greater than 0.' });

    const taxCodeIds = [...new Set(submitted.map((l) => l.tax_code_id).filter(Boolean))];
    const taxRateById = new Map();
    if (taxCodeIds.length) {
      const [taxRows] = await conn.query('SELECT id, rate FROM taxes WHERE id IN (?)', [taxCodeIds]);
      taxRows.forEach((t) => taxRateById.set(t.id, Number(t.rate)));
    }

    let subtotal = 0; let discountAmount = 0; let netOfTax = 0; let taxAmount = 0;
    const computed = submitted.map((l) => {
      const qty = Number(l.qty);
      const rate = Number(l.rate || 0);
      const discPercent = Number(l.disc_percent || 0);
      const lineSubtotal = cents(qty * rate);
      const lineDiscAmount = cents(lineSubtotal * (discPercent / 100));
      const lineNetOfTax = cents(lineSubtotal - lineDiscAmount);
      const taxRatePct = l.tax_code_id ? (taxRateById.get(l.tax_code_id) || 0) : 0;
      // Ext. Price is the gross the supplier bills, from the unrounded figures; Tax is what is left
      // over Net of Tax, so the rounded Net + Tax always equals it (PO-20586: 28,828.12 + 3,459.38 =
      // 32,287.50, not 3,459.37 and a total a centavo short).
      const extPrice = taxRatePct ? cents(qty * rate * (1 - discPercent / 100) * (1 + taxRatePct / 100)) : lineNetOfTax;
      const lineTaxAmount = cents(extPrice - lineNetOfTax);
      subtotal += lineSubtotal; discountAmount += lineDiscAmount; netOfTax += lineNetOfTax; taxAmount += lineTaxAmount;
      return { ...l, lineDiscAmount, lineNetOfTax, lineTaxAmount, extPrice };
    });
    const totalAmount = netOfTax + taxAmount;

    await conn.beginTransaction();
    // Numbered after the mother PO -- PO-20604-1, -2, ... -- not from the PO sequence (asked
    // 2026-10-09, as on the real system: PO-20169-1 under PO-20169). See insertSuffixed.
    const { id: poId, no: poNo } = await insertSuffixed(conn, {
      table: 'purchase_orders',
      column: 'po_no',
      base: parent.po_no,
      run: (no) => conn.query(
        `INSERT INTO purchase_orders (po_no, type, parent_purchase_order_id, date_created, supplier_id, term_id, memo,
           subtotal, discount_amount, net_of_tax, tax_amount, total_amount, status, created_by_user_id)
         VALUES (?, 'PO2', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?)`,
        [no, req.params.id, dateCreated || new Date().toISOString().slice(0, 10), supplierId, termId || null, memo || null,
          subtotal, discountAmount, netOfTax, taxAmount, totalAmount, req.user.id]
      ),
    });

    for (const l of computed) {
      await conn.query(
        // location_id / department_id carried the same way every other PO path carries them: a
        // freight or customs charge belongs to a warehouse and a cost centre as much as the goods
        // it lands, and without them a Landed Cost PO was the one type that could not say where.
        `INSERT INTO purchase_order_lines
           (purchase_order_id, item_id, purchase_description, location_id, department_id,
            qty, purchase_unit, unit_title,
            rate, disc_percent, disc_amount, net_of_tax, tax_code_id, tax_amount, ext_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [poId, l.item_id, l.purchase_description || null, l.location_id || null, l.department_id || null,
          l.qty, l.purchase_unit || null, l.unit_title || null,
          l.rate || 0, l.disc_percent || 0, l.lineDiscAmount, l.lineNetOfTax, l.tax_code_id || null, l.lineTaxAmount, l.extPrice]
      );
    }
    await logAudit(conn, { poId, userId: req.user.id, eventType: 'Created', fieldName: 'po_no', newValue: poNo });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM purchase_orders WHERE id = ?', [poId]);
    notifyPoNextStep(row, req.user.id);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Direct PO (PO-3 "Services with JO" / PO-4 "Services/Non-Inventory without JO"): a
// standalone Purchase Order not sourced from any Purchase Requisition. Each line can
// carry its own Location/Department, and (PO-3 only) a Job Order.
router.post('/direct', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { po_category: poCategory, date_created: dateCreated, need_by_date: needByDate, supplier_id: supplierId, term_id: termId, ref_no: refNo, memo, lines } = req.body;
    if (!['PO3', 'PO4'].includes(poCategory)) return res.status(400).json({ error: 'Select a PO Category.' });
    if (!supplierId) return res.status(400).json({ error: 'Select a Supplier.' });
    const submitted = (Array.isArray(lines) ? lines : []).filter((l) => l.item_id && Number(l.qty) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Add at least one line with a Qty greater than 0.' });
    const discError = resolveLineDiscounts(submitted);
    if (discError) return res.status(400).json({ error: discError });
    const deptError = lineDepartmentError(submitted);
    if (deptError) return res.status(400).json({ error: deptError });

    const taxCodeIds = [...new Set(submitted.map((l) => l.tax_code_id).filter(Boolean))];
    const taxRateById = new Map();
    if (taxCodeIds.length) {
      const [taxRows] = await conn.query('SELECT id, rate FROM taxes WHERE id IN (?)', [taxCodeIds]);
      taxRows.forEach((t) => taxRateById.set(t.id, Number(t.rate)));
    }

    let subtotal = 0; let discountAmount = 0; let netOfTax = 0; let taxAmount = 0;
    const computed = submitted.map((l) => {
      const qty = Number(l.qty);
      const rate = Number(l.rate || 0);
      const discPercent = Number(l.disc_percent || 0);
      const lineSubtotal = cents(qty * rate);
      const lineDiscAmount = cents(lineSubtotal * (discPercent / 100));
      const lineNetOfTax = cents(lineSubtotal - lineDiscAmount);
      const taxRatePct = l.tax_code_id ? (taxRateById.get(l.tax_code_id) || 0) : 0;
      // Ext. Price is the gross the supplier bills, from the unrounded figures; Tax is what is left
      // over Net of Tax, so the rounded Net + Tax always equals it (PO-20586: 28,828.12 + 3,459.38 =
      // 32,287.50, not 3,459.37 and a total a centavo short).
      const extPrice = taxRatePct ? cents(qty * rate * (1 - discPercent / 100) * (1 + taxRatePct / 100)) : lineNetOfTax;
      const lineTaxAmount = cents(extPrice - lineNetOfTax);
      subtotal += lineSubtotal; discountAmount += lineDiscAmount; netOfTax += lineNetOfTax; taxAmount += lineTaxAmount;
      return { ...l, lineDiscAmount, lineNetOfTax, lineTaxAmount, extPrice };
    });
    const totalAmount = netOfTax + taxAmount;
    // PO3 (Services with JO) skips the Purchasing Supervisor tier and goes straight to the General
    // Manager. PO4 (Services/Non-Inventory without JO) starts with the Purchasing Supervisor, as
    // PO1/PO2 do (2026-10-20) -- see the /:id/approve route for the full tier breakdown.
    const initialStatus = GM_ONLY_TYPES.includes(poCategory) ? 'pending_approval_gm' : 'pending_approval';

    await conn.beginTransaction();
    const { id: poId, no: poNo } = await insertNumbered(conn, {
      table: 'purchase_orders',
      column: 'po_no',
      prefix: 'PO-',
      run: (no) => conn.query(
        `INSERT INTO purchase_orders (po_no, type, date_created, need_by_date, supplier_id, term_id, ref_no, memo,
           subtotal, discount_amount, net_of_tax, tax_amount, total_amount, status, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [no, poCategory, dateCreated || new Date().toISOString().slice(0, 10), needByDate || null, supplierId, termId || null, refNo || null, memo || null,
          subtotal, discountAmount, netOfTax, taxAmount, totalAmount, initialStatus, req.user.id]
      ),
    });

    for (const l of computed) {
      await conn.query(
        `INSERT INTO purchase_order_lines
           (purchase_order_id, item_id, purchase_description, location_id, department_id, job_order_id, memo,
            qty, purchase_unit, unit_title, rate, disc_percent, disc_formula, disc_amount, net_of_tax, tax_code_id, tax_amount, ext_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [poId, l.item_id, l.purchase_description || null, l.location_id || null, l.department_id || null,
          poCategory === 'PO3' ? (l.job_order_id || null) : null, l.memo || null,
          l.qty, l.purchase_unit || null, l.unit_title || null, l.rate || 0, l.disc_percent || 0, l.disc_formula || null,
          l.lineDiscAmount, l.lineNetOfTax, l.tax_code_id || null, l.lineTaxAmount, l.extPrice]
      );
    }
    await logAudit(conn, { poId, userId: req.user.id, eventType: 'Created', fieldName: 'po_no', newValue: poNo });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM purchase_orders WHERE id = ?', [poId]);
    notifyPoNextStep(row, req.user.id);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.get('/:id/receipts', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT r.id, r.receipt_no, r.date_created, r.total_amount, r.is_on_hold
       FROM purchase_order_receipts r
       WHERE r.purchase_order_id = ?
       ORDER BY r.id DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/receipts/:receiptId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[receipt]] = await pool.query(
      `SELECT r.*, po.id AS purchase_order_id, po.po_no, s.name AS supplier_name, u.display_name AS created_by_name
       FROM purchase_order_receipts r
       JOIN purchase_orders po ON po.id = r.purchase_order_id
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN users u ON u.id = r.created_by_user_id
       WHERE r.id = ?`,
      [req.params.receiptId]
    );
    if (!receipt) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT rl.*, i.item_code, i.display_name AS item_name, loc.location_name, t.code AS tax_code
       FROM purchase_order_receipt_lines rl
       LEFT JOIN inventories i ON i.id = rl.item_id
       LEFT JOIN locations loc ON loc.id = rl.location_id
       LEFT JOIN taxes t ON t.id = rl.tax_code_id
       WHERE rl.purchase_order_receipt_id = ?`,
      [req.params.receiptId]
    );

    res.json({ ...receipt, lines });
  } catch (err) {
    next(err);
  }
});

// Receiving a PO ("Receiving Report" / RR-#): lands the received qty as stock at each
// line's chosen Location (this is what makes the qty show up as on-hand in the
// warehouse), and re-derives the parent PO's receipt_status. Only allowed once the PO is
// Approved -- mirrors the real system, where "Receive" only appears post-approval.
// Rate/Discount%/Tax Code are re-entered per receipt line (invoice price can differ from
// the PO's) rather than just copied from the PO line, matching the real form.
// Receiving is the warehouse's job: PO Edit, or Add on Receiving Reports, as the PO page offers it.
async function requireReceiveRight(req, res, next) {
  try {
    if (await userCan(req.user.id, ROUTE, 'can_edit') || await userCan(req.user.id, '/receiving-reports', 'can_add')) return next();
    return res.status(403).json({ error: 'You do not have permission to receive this Purchase Order.' });
  } catch (err) { return next(err); }
}

router.post('/:id/receipts', requireAuth, requireReceiveRight, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[po]] = await conn.query('SELECT id, type, status, receipt_status FROM purchase_orders WHERE id = ?', [req.params.id]);
    if (!po) return res.status(404).json({ error: 'Not found' });
    // isApproved, not a literal compare -- see lib/poStatus.js. Comparing to the code alone made
    // every imported PO unreceivable, because 'Approved by General Manager' is not 'approved'.
    if (!isApproved(po.status)) return res.status(409).json({ error: 'This Purchase Order must be Approved before it can be received.' });
    if (po.type !== 'PO2') {
      const open = await openLandedCosts(conn, po.id);
      if (open.length) {
        return res.status(409).json({ error: `Receive its Landed Cost PO${open.length > 1 ? 's' : ''} first: ${open.join(', ')}.` });
      }
    }

    const { date_created: dateCreated, ref_no: refNo, memo, is_on_hold: isOnHold, lines } = req.body;
    // Quantities are kept to 4 decimals (purchase_order_lines.qty / qty_received are DECIMAL(14,4)), so a
    // Rec. Qty typed with more is read at 4 -- 0.053333 is the 0.0533 the PO line holds, its rest, not
    // "more than is open" (2026-10-23: PO-21208, typed to make the total match the PO's 2,720.00).
    const submitted = (Array.isArray(lines) ? lines : [])
      .map((l) => ({ ...l, qty_received: qty4(l.qty_received) }))
      .filter((l) => l.purchase_order_line_id && Number(l.qty_received) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Enter a Qty Received greater than 0 for at least one line.' });
    // Receiving lands stock and makes the line billable.
    await assertPeriodOpen(dateCreated, 'non_gl', conn);

    const lineIds = submitted.map((l) => l.purchase_order_line_id);
    // conversion_factor: PO Qty (and Rec. Qty here) is always in Purchase Unit -- the
    // amount that actually lands in inventory_locations.qty_on_hand (and Bin Card) is in
    // Base Unit, so it has to be scaled by the item's own Purchase Unit -> Base Unit
    // factor (e.g. 5 ROLL x 1344.8 = 6,724 SQFT).
    const [poLines] = await conn.query(
      `SELECT pol.id, pol.item_id, pol.qty, pol.received_qty, pol.location_id, pol.rate, pol.disc_percent, pol.tax_code_id, pol.disc_amount, pol.net_of_tax, pol.tax_amount, pol.ext_price, COALESCE(i.conversion_factor, 1) AS conversion_factor, i.item_type
       FROM purchase_order_lines pol
       LEFT JOIN inventories i ON i.id = pol.item_id
       WHERE pol.id IN (?) AND pol.purchase_order_id = ?`,
      [lineIds, req.params.id]
    );
    const poLineById = new Map(poLines.map((l) => [l.id, l]));

    for (const l of submitted) {
      const poLine = poLineById.get(l.purchase_order_line_id);
      if (!poLine) return res.status(400).json({ error: 'One of the selected lines does not belong to this Purchase Order.' });
      const remaining = qty4(Number(poLine.qty) - Number(poLine.received_qty));
      if (Number(l.qty_received) > remaining + 1e-9) {
        return res.status(409).json({ error: `Qty Received exceeds what's still open on this line (${remaining}).` });
      }
      if (!l.location_id && !poLine.location_id) {
        return res.status(400).json({ error: 'Select a Location for every line being received.' });
      }
    }

    const taxCodeIds = [...new Set(submitted.map((l) => l.tax_code_id).filter(Boolean))];
    const taxRateById = new Map();
    if (taxCodeIds.length) {
      const [taxRows] = await conn.query('SELECT id, rate FROM taxes WHERE id IN (?)', [taxCodeIds]);
      taxRows.forEach((t) => taxRateById.set(t.id, Number(t.rate)));
    }

    // What earlier receipts already took of each PO line -- for the "rest of the line" rule below.
    const [priorRows] = await conn.query(
      `SELECT purchase_order_line_id AS id, SUM(qty_received) AS qty, SUM(disc_amount) AS disc, SUM(net_of_tax) AS net,
              SUM(tax_amount) AS tax, SUM(ext_price) AS ext
         FROM purchase_order_receipt_lines WHERE purchase_order_line_id IN (?) GROUP BY purchase_order_line_id`,
      [submitted.map((l) => l.purchase_order_line_id)]);
    const priorOf = new Map(priorRows.map((r) => [Number(r.id), r]));
    const same = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) < 1e-9;

    let subtotal = 0; let discountAmount = 0; let netOfTax = 0; let taxAmount = 0;
    const computed = submitted.map((l) => {
      const poLine = poLineById.get(l.purchase_order_line_id);
      const qty = Number(l.qty_received);
      const rate = Number(l.rate || 0);
      const discPercent = Number(l.disc_percent || 0);
      let lineSubtotal = cents(qty * rate);
      let lineDiscAmount = cents(lineSubtotal * (discPercent / 100));
      let lineNetOfTax = cents(lineSubtotal - lineDiscAmount);
      const taxRatePct = l.tax_code_id ? (taxRateById.get(l.tax_code_id) || 0) : 0;
      // Ext. Price is the gross the supplier bills, from the unrounded figures; Tax is what is left
      // over Net of Tax, so the rounded Net + Tax always equals it (PO-20586: 28,828.12 + 3,459.38 =
      // 32,287.50, not 3,459.37 and a total a centavo short).
      let extPrice = taxRatePct ? cents(qty * rate * (1 - discPercent / 100) * (1 + taxRatePct / 100)) : lineNetOfTax;
      let lineTaxAmount = cents(extPrice - lineNetOfTax);
      // Received at the PO line's own terms (rate, discount, tax code): its amounts come FROM the PO
      // line rather than being recomputed from the rate, so receipts add up to the PO exactly
      // (2026-10-09: PO-20604 730.00, its RR priced from a rate migrated to 4 decimals came to
      // 730.02). The rest of the line takes what earlier receipts left; a partial one, its share.
      // Earlier receipts are trusted for the remainder only while their quantities still account
      // for what is received (no vendor return in between); otherwise the share is pro-rated.
      const poQty = Number(poLine.qty);
      if (poQty > 0 && same(rate, poLine.rate) && same(discPercent, poLine.disc_percent)
        && String(l.tax_code_id || '') === String(poLine.tax_code_id || '')) {
        const prior = priorOf.get(Number(poLine.id));
        const priorQty = Number(prior?.qty || 0);
        const isRest = Math.abs(priorQty + qty - poQty) < 1e-9 && Math.abs(priorQty - Number(poLine.received_qty)) < 1e-9;
        const part = (field, priorField) => (isRest
          ? cents(Number(poLine[field] || 0) - Number(prior?.[priorField] || 0))
          : cents(Number(poLine[field] || 0) * (qty / poQty)));
        lineDiscAmount = part('disc_amount', 'disc');
        lineNetOfTax = part('net_of_tax', 'net');
        extPrice = part('ext_price', 'ext');
        lineTaxAmount = cents(extPrice - lineNetOfTax);
        lineSubtotal = cents(lineNetOfTax + lineDiscAmount);
      }
      subtotal += lineSubtotal; discountAmount += lineDiscAmount; netOfTax += lineNetOfTax; taxAmount += lineTaxAmount;
      return {
        purchase_order_line_id: l.purchase_order_line_id, tax_code_id: l.tax_code_id || null,
        poLine, qty, rate, discPercent, lineDiscAmount, lineNetOfTax, lineTaxAmount, extPrice,
        locationId: l.location_id || poLine.location_id,
      };
    });
    const totalAmount = netOfTax + taxAmount;

    await conn.beginTransaction();
    const { id: receiptId } = await insertNumbered(conn, {
      table: 'purchase_order_receipts',
      column: 'receipt_no',
      prefix: 'RR-',
      run: (no) => conn.query(
        `INSERT INTO purchase_order_receipts (receipt_no, purchase_order_id, date_created, ref_no, memo, is_on_hold, subtotal, discount_amount, net_of_tax, tax_amount, total_amount, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [no, req.params.id, dateCreated || new Date().toISOString().slice(0, 10), refNo || null, memo || null, !!isOnHold, subtotal, discountAmount, netOfTax, taxAmount, totalAmount, req.user.id]
      ),
    });

    for (const l of computed) {
      await conn.query(
        `INSERT INTO purchase_order_receipt_lines
           (purchase_order_receipt_id, purchase_order_line_id, item_id, location_id, qty_received, rate, disc_percent, disc_amount, net_of_tax, tax_code_id, tax_amount, ext_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [receiptId, l.purchase_order_line_id, l.poLine.item_id, l.locationId || null, l.qty, l.rate, l.discPercent, l.lineDiscAmount, l.lineNetOfTax, l.tax_code_id, l.lineTaxAmount, l.extPrice]
      );
      await conn.query('UPDATE purchase_order_lines SET received_qty = received_qty + ? WHERE id = ?', [l.qty, l.purchase_order_line_id]);
      // A charge (Landed Cost, Service, ...) is received so it can be billed, but lands no stock.
      if (l.locationId && !isNonStockItem(l.poLine.item_type)) {
        const baseQty = l.qty * Number(l.poLine.conversion_factor || 1);
        await conn.query(
          `INSERT INTO inventory_locations (inventory_id, location_id, qty_on_hand)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE qty_on_hand = qty_on_hand + VALUES(qty_on_hand)`,
          [l.poLine.item_id, l.locationId, baseQty]
        );
      }
    }

    const [allLines] = await conn.query('SELECT qty, received_qty FROM purchase_order_lines WHERE purchase_order_id = ?', [req.params.id]);
    const allReceived = allLines.every((l) => Number(l.received_qty) >= Number(l.qty));
    const anyReceived = allLines.some((l) => Number(l.received_qty) > 0);
    const receiptStatus = allReceived ? 'fully_received' : anyReceived ? 'partially_received' : 'not_received';
    await conn.query('UPDATE purchase_orders SET receipt_status = ? WHERE id = ?', [receiptStatus, req.params.id]);

    await logAudit(conn, { poId: req.params.id, userId: req.user.id, eventType: 'Status Change', fieldName: 'receipt_status', oldValue: po.receipt_status, newValue: receiptStatus });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM purchase_order_receipts WHERE id = ?', [receiptId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Edit a saved Receiving Report (2026-10-12): its header (date, Ref. #, memo, On Hold) and, per
// line, Rec. Qty, Location, Rate, Discount % and Tax Code. Lines are not added or removed here.
// Everything a receipt moved is moved again by the difference:
//   - the PO line's received_qty, and the PO's receipt_status;
//   - stock (inventory_locations) -- out of the old location, into the new -- for stock items only;
//     the Bin Card reads the receipt lines themselves and follows on its own.
// A line may not go below what has been BILLED of its PO line (received_qty may not fall under
// billed_qty), nor above what the PO line still has open. Amounts are worked out as on Receive.
router.put('/receipts/:receiptId', requireAuth, requireReceiveRight, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[r]] = await conn.query('SELECT * FROM purchase_order_receipts WHERE id = ?', [req.params.receiptId]);
    if (!r) return res.status(404).json({ error: 'Not found' });
    const day = (v) => (v instanceof Date ? v.toISOString() : String(v || '')).slice(0, 10);
    const oldDate = day(r.date_created);
    const newDate = day(req.body.date_created) || oldDate;
    await assertPeriodOpen(oldDate, 'non_gl', conn);
    if (newDate !== oldDate) await assertPeriodOpen(newDate, 'non_gl', conn);

    const [oldLines] = await conn.query(
      `SELECT rl.*, pol.qty AS po_qty, pol.received_qty AS po_received, COALESCE(pol.billed_qty, 0) AS po_billed,
              pol.rate AS po_rate, pol.disc_percent AS po_disc, pol.tax_code_id AS po_tax, pol.disc_amount AS po_disc_amount,
              pol.net_of_tax AS po_net, pol.ext_price AS po_ext,
              COALESCE(i.conversion_factor, 1) AS conversion_factor, i.item_type, i.item_code
         FROM purchase_order_receipt_lines rl
         JOIN purchase_order_lines pol ON pol.id = rl.purchase_order_line_id
         LEFT JOIN inventories i ON i.id = rl.item_id
        WHERE rl.purchase_order_receipt_id = ?`, [r.id]);
    const sent = new Map((Array.isArray(req.body.lines) ? req.body.lines : []).map((l) => [Number(l.id), l]));

    const [taxRows] = await conn.query('SELECT id, rate FROM taxes');
    const taxRate = new Map(taxRows.map((t) => [Number(t.id), Number(t.rate)]));
    const same = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) < 1e-9;

    const plans = [];
    for (const o of oldLines) {
      const s = sent.get(Number(o.id)) || {};
      // To 4 decimals, as the quantities are kept (see Receive).
      const qty = qty4(s.qty_received !== undefined ? s.qty_received : o.qty_received);
      const locationId = s.location_id !== undefined ? (Number(s.location_id) || null) : o.location_id;
      const rate = s.rate !== undefined ? Number(s.rate || 0) : Number(o.rate || 0);
      const discPercent = s.disc_percent !== undefined ? Number(s.disc_percent || 0) : Number(o.disc_percent || 0);
      const taxCodeId = s.tax_code_id !== undefined ? (Number(s.tax_code_id) || null) : (o.tax_code_id || null);
      const label = o.item_code || `line ${o.id}`;
      if (!(qty > 0)) return res.status(400).json({ error: `${label}: Rec. Qty must be above 0.` });
      if (!locationId) return res.status(400).json({ error: `${label}: select a Location.` });
      const otherReceived = Number(o.po_received) - Number(o.qty_received);
      if (qty > Number(o.po_qty) - otherReceived + 1e-9) {
        return res.status(409).json({ error: `${label}: Rec. Qty can be at most ${Number(o.po_qty) - otherReceived} (the PO line's ${Number(o.po_qty)} less what other receipts took).` });
      }
      if (otherReceived + qty < Number(o.po_billed) - 1e-9) {
        return res.status(409).json({ error: `${label}: ${Number(o.po_billed)} of its PO line is already billed, so this receipt cannot go below ${Number(o.po_billed) - otherReceived}.` });
      }
      // Amounts: at the PO line's own terms, its share of the PO line's amounts (as on Receive);
      // otherwise worked from the rate.
      const tr = taxCodeId ? (taxRate.get(taxCodeId) || 0) : 0;
      let subtotal = cents(qty * rate);
      let discAmount = cents(subtotal * (discPercent / 100));
      let net = cents(subtotal - discAmount);
      let ext = tr ? cents(qty * rate * (1 - discPercent / 100) * (1 + tr / 100)) : net;
      const poQty = Number(o.po_qty);
      if (poQty > 0 && same(rate, o.po_rate) && same(discPercent, o.po_disc) && String(taxCodeId || '') === String(o.po_tax || '')) {
        discAmount = cents(Number(o.po_disc_amount || 0) * (qty / poQty));
        net = cents(Number(o.po_net || 0) * (qty / poQty));
        ext = cents(Number(o.po_ext || 0) * (qty / poQty));
        subtotal = cents(net + discAmount);
      }
      plans.push({ o, qty, locationId, rate, discPercent, taxCodeId, subtotal, discAmount, net, tax: cents(ext - net), ext });
    }

    await conn.beginTransaction();
    const changes = [];
    for (const p of plans) {
      const { o } = p;
      await conn.query(
        `UPDATE purchase_order_receipt_lines SET qty_received = ?, location_id = ?, rate = ?, disc_percent = ?, disc_amount = ?,
                net_of_tax = ?, tax_code_id = ?, tax_amount = ?, ext_price = ? WHERE id = ?`,
        [p.qty, p.locationId, p.rate, p.discPercent, p.discAmount, p.net, p.taxCodeId, p.tax, p.ext, o.id]);
      const dq = p.qty - Number(o.qty_received);
      if (Math.abs(dq) > 1e-9) {
        await conn.query('UPDATE purchase_order_lines SET received_qty = received_qty + ? WHERE id = ?', [dq, o.purchase_order_line_id]);
      }
      if (!isNonStockItem(o.item_type)) {
        const conv = Number(o.conversion_factor || 1);
        const moved = Number(o.location_id || 0) !== Number(p.locationId || 0);
        const upsert = (loc, by) => conn.query(
          `INSERT INTO inventory_locations (inventory_id, location_id, qty_on_hand) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE qty_on_hand = qty_on_hand + VALUES(qty_on_hand)`, [o.item_id, loc, by]);
        if (moved) {
          if (o.location_id) await upsert(o.location_id, -Number(o.qty_received) * conv);
          await upsert(p.locationId, p.qty * conv);
        } else if (Math.abs(dq) > 1e-9 && p.locationId) {
          await upsert(p.locationId, dq * conv);
        }
      }
      if (Math.abs(dq) > 1e-9) changes.push(`${o.item_code}: qty ${Number(o.qty_received)} -> ${p.qty}`);
      if (Number(o.location_id || 0) !== Number(p.locationId || 0)) changes.push(`${o.item_code}: location changed`);
      if (!same(o.rate, p.rate) || !same(o.disc_percent, p.discPercent) || String(o.tax_code_id || '') !== String(p.taxCodeId || '')) {
        changes.push(`${o.item_code}: price terms changed`);
      }
    }

    const sum = (k) => cents(plans.reduce((t, p) => t + p[k], 0));
    const refNo = req.body.ref_no !== undefined ? (req.body.ref_no || null) : r.ref_no;
    const memo = req.body.memo !== undefined ? (req.body.memo || null) : r.memo;
    const isOnHold = req.body.is_on_hold !== undefined ? !!req.body.is_on_hold : !!r.is_on_hold;
    await conn.query(
      `UPDATE purchase_order_receipts SET date_created = ?, ref_no = ?, memo = ?, is_on_hold = ?, subtotal = ?, discount_amount = ?,
              net_of_tax = ?, tax_amount = ?, total_amount = ? WHERE id = ?`,
      [newDate, refNo, memo, isOnHold, sum('subtotal'), sum('discAmount'), sum('net'), sum('tax'), cents(sum('net') + sum('tax')), r.id]);
    if (newDate !== oldDate) changes.push(`date ${oldDate} -> ${newDate}`);
    if ((refNo || '') !== (r.ref_no || '')) changes.push('Ref. # changed');
    if ((memo || '') !== (r.memo || '')) changes.push('memo changed');
    if (isOnHold !== !!r.is_on_hold) changes.push(isOnHold ? 'put on hold' : 'taken off hold');

    const [[po]] = await conn.query('SELECT receipt_status FROM purchase_orders WHERE id = ?', [r.purchase_order_id]);
    const [allLines] = await conn.query('SELECT qty, received_qty FROM purchase_order_lines WHERE purchase_order_id = ?', [r.purchase_order_id]);
    const allReceived = allLines.every((l) => Number(l.received_qty) >= Number(l.qty));
    const anyReceived = allLines.some((l) => Number(l.received_qty) > 0);
    const receiptStatus = allReceived ? 'fully_received' : anyReceived ? 'partially_received' : 'not_received';
    await conn.query('UPDATE purchase_orders SET receipt_status = ? WHERE id = ?', [receiptStatus, r.purchase_order_id]);
    // Logged on the PO, whose System Info is where its receipts' history is read.
    await logAudit(conn, {
      poId: r.purchase_order_id, userId: req.user.id, eventType: 'Updated', fieldName: r.receipt_no,
      oldValue: null, newValue: changes.length ? changes.join('; ').slice(0, 1000) : 'saved, no changes',
    });
    if (po && po.receipt_status !== receiptStatus) {
      await logAudit(conn, { poId: r.purchase_order_id, userId: req.user.id, eventType: 'Status Change', fieldName: 'receipt_status', oldValue: po.receipt_status, newValue: receiptStatus });
    }
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM purchase_order_receipts WHERE id = ?', [r.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    conn.release();
  }
});

router.get('/:id/returns', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT vr.id, vr.return_no, vr.date_created, vr.total_amount
       FROM purchase_returns vr
       WHERE vr.purchase_order_id = ?
       ORDER BY vr.id DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/returns/:returnId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[ret]] = await pool.query(
      `SELECT vr.*, po.id AS purchase_order_id, po.po_no, po.supplier_id, s.name AS supplier_name, u.display_name AS created_by_name
       FROM purchase_returns vr
       JOIN purchase_orders po ON po.id = vr.purchase_order_id
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN users u ON u.id = vr.created_by_user_id
       WHERE vr.id = ?`,
      [req.params.returnId]
    );
    if (!ret) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT rl.*, i.item_code, i.display_name AS item_name, loc.location_name, t.code AS tax_code
       FROM purchase_return_lines rl
       LEFT JOIN inventories i ON i.id = rl.item_id
       LEFT JOIN locations loc ON loc.id = rl.location_id
       LEFT JOIN taxes t ON t.id = rl.tax_code_id
       WHERE rl.purchase_return_id = ?`,
      [req.params.returnId]
    );

    res.json({ ...ret, lines });
  } catch (err) {
    next(err);
  }
});

// "Vendor Return" (VR-#): decrements received_qty on each PO line (capped at what's
// currently recorded as received -- received_qty already nets out past returns, so it's
// the correct ceiling) and decrements stock at the same Location the item was received
// into. Re-derives receipt_status the same way the receive endpoint does, which is what
// lets a return flip a Fully Received PO back to Partially Received, matching the real
// system's confirmed behavior.
router.post('/:id/returns', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[po]] = await conn.query('SELECT id, status, receipt_status FROM purchase_orders WHERE id = ?', [req.params.id]);
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (po.receipt_status === 'not_received') return res.status(409).json({ error: 'Nothing has been received on this Purchase Order yet.' });

    const { date_created: dateCreated, ref_no: refNo, memo, lines } = req.body;
    const submitted = (Array.isArray(lines) ? lines : []).filter((l) => l.purchase_order_line_id && Number(l.qty_returned) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Enter a Qty to Return greater than 0 for at least one line.' });
    // Returning to the supplier takes the stock back out again.
    await assertPeriodOpen(dateCreated, 'non_gl', conn);

    const lineIds = submitted.map((l) => l.purchase_order_line_id);
    // Same Purchase Unit -> Base Unit scaling as receiving (see POST /:id/receipts) --
    // qty_returned is in Purchase Unit, the stock decrement must be in Base Unit.
    const [poLines] = await conn.query(
      `SELECT pol.id, pol.item_id, pol.qty, pol.received_qty, pol.location_id, COALESCE(i.conversion_factor, 1) AS conversion_factor
       FROM purchase_order_lines pol
       LEFT JOIN inventories i ON i.id = pol.item_id
       WHERE pol.id IN (?) AND pol.purchase_order_id = ?`,
      [lineIds, req.params.id]
    );
    const poLineById = new Map(poLines.map((l) => [l.id, l]));

    for (const l of submitted) {
      const poLine = poLineById.get(l.purchase_order_line_id);
      if (!poLine) return res.status(400).json({ error: 'One of the selected lines does not belong to this Purchase Order.' });
      if (Number(l.qty_returned) > Number(poLine.received_qty)) {
        return res.status(409).json({ error: `Qty to Return exceeds what's currently received on this line (${poLine.received_qty}).` });
      }
    }

    const taxCodeIds = [...new Set(submitted.map((l) => l.tax_code_id).filter(Boolean))];
    const taxRateById = new Map();
    if (taxCodeIds.length) {
      const [taxRows] = await conn.query('SELECT id, rate FROM taxes WHERE id IN (?)', [taxCodeIds]);
      taxRows.forEach((t) => taxRateById.set(t.id, Number(t.rate)));
    }

    let subtotal = 0; let discountAmount = 0; let netOfTax = 0; let taxAmount = 0;
    const computed = submitted.map((l) => {
      const poLine = poLineById.get(l.purchase_order_line_id);
      const qty = Number(l.qty_returned);
      const rate = Number(l.rate || 0);
      const discPercent = Number(l.disc_percent || 0);
      const lineSubtotal = cents(qty * rate);
      const lineDiscAmount = cents(lineSubtotal * (discPercent / 100));
      const lineNetOfTax = cents(lineSubtotal - lineDiscAmount);
      const taxRatePct = l.tax_code_id ? (taxRateById.get(l.tax_code_id) || 0) : 0;
      // Ext. Price is the gross the supplier bills, from the unrounded figures; Tax is what is left
      // over Net of Tax, so the rounded Net + Tax always equals it (PO-20586: 28,828.12 + 3,459.38 =
      // 32,287.50, not 3,459.37 and a total a centavo short).
      const extPrice = taxRatePct ? cents(qty * rate * (1 - discPercent / 100) * (1 + taxRatePct / 100)) : lineNetOfTax;
      const lineTaxAmount = cents(extPrice - lineNetOfTax);
      subtotal += lineSubtotal; discountAmount += lineDiscAmount; netOfTax += lineNetOfTax; taxAmount += lineTaxAmount;
      return {
        purchase_order_line_id: l.purchase_order_line_id, tax_code_id: l.tax_code_id || null,
        poLine, qty, rate, discPercent, lineDiscAmount, lineNetOfTax, lineTaxAmount, extPrice,
      };
    });
    const totalAmount = netOfTax + taxAmount;

    await conn.beginTransaction();
    const { id: returnId } = await insertNumbered(conn, {
      table: 'purchase_returns',
      column: 'return_no',
      prefix: 'VR-',
      run: (no) => conn.query(
        `INSERT INTO purchase_returns (return_no, purchase_order_id, date_created, ref_no, memo, subtotal, discount_amount, net_of_tax, tax_amount, total_amount, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [no, req.params.id, dateCreated || new Date().toISOString().slice(0, 10), refNo || null, memo || null, subtotal, discountAmount, netOfTax, taxAmount, totalAmount, req.user.id]
      ),
    });

    for (const l of computed) {
      await conn.query(
        `INSERT INTO purchase_return_lines
           (purchase_return_id, purchase_order_line_id, item_id, location_id, qty_returned, rate, disc_percent, disc_amount, net_of_tax, tax_code_id, tax_amount, ext_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [returnId, l.purchase_order_line_id, l.poLine.item_id, l.poLine.location_id, l.qty, l.rate, l.discPercent, l.lineDiscAmount, l.lineNetOfTax, l.tax_code_id, l.lineTaxAmount, l.extPrice]
      );
      await conn.query('UPDATE purchase_order_lines SET received_qty = received_qty - ? WHERE id = ?', [l.qty, l.purchase_order_line_id]);
      if (l.poLine.location_id) {
        const baseQty = l.qty * Number(l.poLine.conversion_factor || 1);
        await conn.query(
          'UPDATE inventory_locations SET qty_on_hand = GREATEST(qty_on_hand - ?, 0) WHERE inventory_id = ? AND location_id = ?',
          [baseQty, l.poLine.item_id, l.poLine.location_id]
        );
      }
    }

    const [allLines] = await conn.query('SELECT qty, received_qty FROM purchase_order_lines WHERE purchase_order_id = ?', [req.params.id]);
    const allReceived = allLines.every((l) => Number(l.received_qty) >= Number(l.qty));
    const anyReceived = allLines.some((l) => Number(l.received_qty) > 0);
    const receiptStatus = allReceived ? 'fully_received' : anyReceived ? 'partially_received' : 'not_received';
    await conn.query('UPDATE purchase_orders SET receipt_status = ? WHERE id = ?', [receiptStatus, req.params.id]);

    await logAudit(conn, { poId: req.params.id, userId: req.user.id, eventType: 'Status Change', fieldName: 'receipt_status', oldValue: po.receipt_status, newValue: receiptStatus });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM purchase_returns WHERE id = ?', [returnId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Editing a saved Purchase Order -- mirrors the real system's "Edit" button (confirmed
// against the sandbox: reuses the same header/line fields as Create, gated by
// `can_edit`). Only allowed while still Pending Approval, matching how every other
// transaction type in this build already treats "once approved, no further edits" --
// once a PO is approved it may already have Receiving Reports / Vendor Bills built on
// top of its lines, and this build has no undo path for that (same reasoning as
// Inventory Adjustment/Sales Invoice/Vendor Bill only supporting Cancel post-save, never
// Edit). Qty changes are only accepted for lines with zero received/billed activity; on a
// PR-sourced (PO1) line the PR line's po_qty moves by the same difference, so Cancel's
// po_qty - qty still nets back to what it was before this PO; everything
// else (rate, discount, tax code, description, location, department) is always
// editable, and lines can be added/removed as long as nothing's been received/billed
// against them yet.
// A line's Purchase Description, at ANY status and on every type, PO1 to PO4 (asked 2026-10-08:
// "purchase description must be editable"). Unlike the full edit below, which stops at approval,
// this touches nothing that receiving, billing or the totals rest on -- it is the wording only.
router.put('/:id/lines/:lineId/description', requireAuth, requireOpenPeriod('purchase_orders', 'non_gl'), requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const [[line]] = await pool.query(
      'SELECT id, purchase_description FROM purchase_order_lines WHERE id = ? AND purchase_order_id = ?',
      [req.params.lineId, req.params.id],
    );
    if (!line) return res.status(404).json({ error: 'Line not found on this Purchase Order.' });
    const value = String(req.body?.purchase_description ?? '').trim().slice(0, 1000) || null;
    if ((value ?? '') !== (line.purchase_description ?? '')) {
      await pool.query('UPDATE purchase_order_lines SET purchase_description = ? WHERE id = ?', [value, line.id]);
      await logAudit(pool, {
        poId: req.params.id, userId: req.user.id, eventType: 'Updated',
        fieldName: `line ${line.id} purchase_description`, oldValue: line.purchase_description, newValue: value,
      });
    }
    res.json({ id: line.id, purchase_description: value });
  } catch (err) { next(err); }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[po]] = await conn.query('SELECT * FROM purchase_orders WHERE id = ?', [req.params.id]);
    if (!po) return res.status(404).json({ error: 'Not found' });
    // Pending Approval: anyone with can_edit. Approved: only someone switched on for it
    // (users.can_edit_approved_po, per user). Received/billed lines stay protected below either way.
    // Normalised: a PO imported from the source carries its labels ('Pending Approval', 'Pending
    // Approval for GM'), which the raw codes never matched -- so an imported PO still awaiting
    // approval was refused as if approved (PO-20609).
    // A System Admin edits whatever the status (asked 2026-10-06) -- approved, billed or cancelled.
    // The line protections below (no qty change / removal on a received or billed line) still hold.
    if (!['pending_approval', 'pending_approval_gm'].includes(normalisePoStatus(po.status)) && !(await isSystemAdmin(req.user.id))) {
      const [[me]] = await conn.query('SELECT can_edit_approved_po FROM users WHERE id = ?', [req.user.id]);
      const cancelled = String(po.status || '').toLowerCase().includes('cancel');
      if (!(me?.can_edit_approved_po && isApproved(po.status) && !cancelled)) {
        return res.status(409).json({ error: 'Only a Purchase Order that is still Pending Approval can be edited.' });
      }
    }
    await assertPeriodOpen([po.date_created, req.body.date_created], 'non_gl', conn);

    const {
      date_created: dateCreated, need_by_date: needByDate, supplier_id: supplierId,
      term_id: termId, ref_no: refNo, memo, lines,
    } = req.body;
    if (!supplierId) return res.status(400).json({ error: 'Select a Supplier.' });
    const submitted = (Array.isArray(lines) ? lines : []).filter((l) => l.item_id && Number(l.qty) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Add at least one line with a Qty greater than 0.' });
    const discError = resolveLineDiscounts(submitted);
    if (discError) return res.status(400).json({ error: discError });
    const deptError = lineDepartmentError(submitted);
    if (deptError) return res.status(400).json({ error: deptError });

    const [existingLines] = await conn.query('SELECT * FROM purchase_order_lines WHERE purchase_order_id = ?', [req.params.id]);
    const existingById = new Map(existingLines.map((l) => [l.id, l]));

    const submittedIds = new Set(submitted.filter((l) => l.id).map((l) => Number(l.id)));
    for (const existing of existingLines) {
      if (submittedIds.has(existing.id)) continue;
      if (Number(existing.received_qty) > 0 || Number(existing.billed_qty) > 0) {
        return res.status(409).json({ error: 'Cannot remove a line that already has Received or Billed activity.' });
      }
    }

    for (const l of submitted) {
      if (!l.id) continue;
      const existing = existingById.get(Number(l.id));
      if (!existing) return res.status(400).json({ error: 'One of the submitted lines does not belong to this Purchase Order.' });
      // A PR-sourced line's qty may change (the PR asks for 0.0533 ROLL, the supplier sells whole
      // rolls); its PR line's po_qty moves by the same difference below, the way Cancel undoes it.
      // A received or billed line's qty may change too (asked 2026-10-31), but never below what has
      // already been received or billed on it; receipt_status is re-read from the lines after.
      const floor = Math.max(Number(existing.received_qty || 0), Number(existing.billed_qty || 0));
      if (Number(l.qty) !== Number(existing.qty) && Number(l.qty) < floor - 1e-9) {
        return res.status(409).json({ error: `Qty on ${existing.purchase_description || `line ${existing.id}`} cannot go below what is already Received / Billed (${floor}).` });
      }
    }
    for (const l of submitted) {
      if (l.id) continue;
      if (l.purchase_requisition_line_id) return res.status(400).json({ error: 'New lines cannot be linked to a Purchase Requisition.' });
    }

    const taxCodeIds = [...new Set(submitted.map((l) => l.tax_code_id).filter(Boolean))];
    const taxRateById = new Map();
    if (taxCodeIds.length) {
      const [taxRows] = await conn.query('SELECT id, rate FROM taxes WHERE id IN (?)', [taxCodeIds]);
      taxRows.forEach((t) => taxRateById.set(t.id, Number(t.rate)));
    }

    let subtotal = 0; let discountAmount = 0; let netOfTax = 0; let taxAmount = 0;
    const computed = submitted.map((l) => {
      const qty = Number(l.qty);
      const rate = Number(l.rate || 0);
      const discPercent = Number(l.disc_percent || 0);
      const lineSubtotal = cents(qty * rate);
      const lineDiscAmount = cents(lineSubtotal * (discPercent / 100));
      const lineNetOfTax = cents(lineSubtotal - lineDiscAmount);
      const taxRatePct = l.tax_code_id ? (taxRateById.get(l.tax_code_id) || 0) : 0;
      // Ext. Price is the gross the supplier bills, from the unrounded figures; Tax is what is left
      // over Net of Tax, so the rounded Net + Tax always equals it (PO-20586: 28,828.12 + 3,459.38 =
      // 32,287.50, not 3,459.37 and a total a centavo short).
      const extPrice = taxRatePct ? cents(qty * rate * (1 - discPercent / 100) * (1 + taxRatePct / 100)) : lineNetOfTax;
      const lineTaxAmount = cents(extPrice - lineNetOfTax);
      subtotal += lineSubtotal; discountAmount += lineDiscAmount; netOfTax += lineNetOfTax; taxAmount += lineTaxAmount;
      return { ...l, lineDiscAmount, lineNetOfTax, lineTaxAmount, extPrice };
    });
    const totalAmount = netOfTax + taxAmount;

    await conn.beginTransaction();

    for (const existing of existingLines) {
      if (submittedIds.has(existing.id)) continue;
      if (existing.purchase_requisition_line_id) {
        await conn.query('UPDATE purchase_requisition_lines SET po_qty = GREATEST(po_qty - ?, 0) WHERE id = ?', [existing.qty, existing.purchase_requisition_line_id]);
      }
      await conn.query('DELETE FROM purchase_order_lines WHERE id = ?', [existing.id]);
    }

    for (const l of computed) {
      if (l.id) {
        const existing = existingById.get(Number(l.id));
        const delta = Number(l.qty) - Number(existing.qty);
        if (existing.purchase_requisition_line_id && delta !== 0) {
          await conn.query('UPDATE purchase_requisition_lines SET po_qty = GREATEST(po_qty + ?, 0) WHERE id = ?', [delta, existing.purchase_requisition_line_id]);
        }
        if (delta !== 0) {
          await logAudit(conn, { poId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: `qty (line ${existing.id})`, oldValue: existing.qty, newValue: l.qty });
        }
        await conn.query(
          `UPDATE purchase_order_lines SET
             purchase_description = ?, location_id = ?, department_id = ?, qty = ?, purchase_unit = ?, unit_title = ?,
             rate = ?, disc_percent = ?, disc_formula = ?, disc_amount = ?, net_of_tax = ?, tax_code_id = ?, tax_amount = ?, ext_price = ?
           WHERE id = ?`,
          [l.purchase_description || null, l.location_id || null, l.department_id || null, l.qty, l.purchase_unit || null, l.unit_title || null,
            l.rate || 0, l.disc_percent || 0, l.disc_formula || null, l.lineDiscAmount, l.lineNetOfTax, l.tax_code_id || null, l.lineTaxAmount, l.extPrice, l.id]
        );
      } else {
        await conn.query(
          `INSERT INTO purchase_order_lines
             (purchase_order_id, item_id, purchase_description, location_id, department_id, job_order_id,
              qty, purchase_unit, unit_title, rate, disc_percent, disc_formula, disc_amount, net_of_tax, tax_code_id, tax_amount, ext_price)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [req.params.id, l.item_id, l.purchase_description || null, l.location_id || null, l.department_id || null, l.job_order_id || null,
            l.qty, l.purchase_unit || null, l.unit_title || null, l.rate || 0, l.disc_percent || 0, l.disc_formula || null, l.lineDiscAmount, l.lineNetOfTax, l.tax_code_id || null, l.lineTaxAmount, l.extPrice]
        );
      }
    }

    await conn.query(
      `UPDATE purchase_orders SET
         date_created = ?, need_by_date = ?, supplier_id = ?, term_id = ?, ref_no = ?, memo = ?,
         subtotal = ?, discount_amount = ?, net_of_tax = ?, tax_amount = ?, total_amount = ?
       WHERE id = ?`,
      [dateCreated || po.date_created, needByDate || null, supplierId, termId || null, refNo || null, memo || null,
        subtotal, discountAmount, netOfTax, taxAmount, totalAmount, req.params.id]
    );
    await logAudit(conn, { poId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: 'total_amount', oldValue: po.total_amount, newValue: totalAmount });

    // A qty raised over what was received reopens the PO for receiving; one lowered to it closes it.
    // Same rule as Receive (above).
    const [allLines] = await conn.query('SELECT qty, received_qty FROM purchase_order_lines WHERE purchase_order_id = ?', [req.params.id]);
    const allReceived = allLines.every((x) => Number(x.received_qty) >= Number(x.qty));
    const anyReceived = allLines.some((x) => Number(x.received_qty) > 0);
    const receiptStatus = allReceived ? 'fully_received' : anyReceived ? 'partially_received' : 'not_received';
    if (anyReceived && receiptStatus !== po.receipt_status) {
      await conn.query('UPDATE purchase_orders SET receipt_status = ? WHERE id = ?', [receiptStatus, req.params.id]);
      await logAudit(conn, { poId: req.params.id, userId: req.user.id, eventType: 'Status Change', fieldName: 'receipt_status', oldValue: po.receipt_status, newValue: receiptStatus });
    }
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM purchase_orders WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/:id/cancel', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[po]] = await conn.query('SELECT status, date_created FROM purchase_orders WHERE id = ?', [req.params.id]);
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (normalisePoStatus(po.status) === 'cancelled') return res.status(409).json({ error: 'This PO is already cancelled.' });
    await assertPeriodOpen(po.date_created, 'non_gl', conn);
    // Not while anything on it is billed or received (asked 2026-10-06): cancelling left its bills,
    // received stock and receipts standing under a PO that said Cancelled. Undo in reverse -- void
    // the bill(s), Vendor Return what was received -- then cancel.
    const [[act]] = await conn.query(
      'SELECT COALESCE(SUM(billed_qty), 0) AS billed, COALESCE(SUM(received_qty), 0) AS received FROM purchase_order_lines WHERE purchase_order_id = ?',
      [req.params.id]);
    if (Number(act.billed) > 0.00001) {
      const [bills] = await conn.query("SELECT bill_no FROM vendor_bills WHERE purchase_order_id = ? AND status <> 'cancelled'", [req.params.id]);
      const names = bills.map((b) => b.bill_no).filter(Boolean);
      return res.status(409).json({
        error: `This PO is billed${names.length ? ` (${names.join(', ')})` : ''}. Void its bill${names.length === 1 ? '' : 's'} first (undoing any payment or credit on ${names.length === 1 ? 'it' : 'them'}), then Vendor Return what was received, then cancel.`,
      });
    }
    if (Number(act.received) > 0.00001) {
      return res.status(409).json({ error: 'Items on this PO are received. Vendor Return them first, then cancel.' });
    }

    const [lines] = await conn.query('SELECT purchase_requisition_line_id, qty FROM purchase_order_lines WHERE purchase_order_id = ?', [req.params.id]);

    await conn.beginTransaction();
    for (const l of lines) {
      if (l.purchase_requisition_line_id) {
        await conn.query('UPDATE purchase_requisition_lines SET po_qty = GREATEST(po_qty - ?, 0) WHERE id = ?', [l.qty, l.purchase_requisition_line_id]);
      }
    }
    await conn.query(
      "UPDATE purchase_orders SET status = 'cancelled', cancelled_by_user_id = ?, cancelled_at = NOW() WHERE id = ?",
      [req.user.id, req.params.id]
    );
    await logAudit(conn, { poId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: po.status, newValue: 'cancelled' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM purchase_orders WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
