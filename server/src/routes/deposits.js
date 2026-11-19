const express = require('express');
const pool = require('../db');
const { assignDocNo } = require('../lib/docNumber');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { assertPeriodOpen } = require('../lib/accountingPeriod');
const { depositGlRows } = require('../lib/depositGl');
const { lineDepartmentError } = require('../lib/requireDepartment');
const { companyWhere } = require('../lib/requestScope');

const router = express.Router();
// Bank Deposit (BD-####): deposits one or more NOT-DEPOSITED customer payments into a bank account,
// plus Other Deposit lines (money in no payment explains -- ADDED to the total) and Cash Back lines
// (cash kept back instead of banked -- DEDUCTED from it). total_amount is the net that reaches the
// bank. Each payment links via customer_payments.deposit_id and flips to 'deposited'. GL Impact is
// lib/depositGl.js.
const ROUTE = '/deposits';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (v) => Number(num(v).toFixed(2));
const trunc = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));

async function logAudit(conn, { depositId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('BankDeposit', ?, ?, ?, ?, ?, ?)`,
    [depositId, eventType, fieldName, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), userId]
  );
}

const PARTY_TABLES = {
  VENDOR: "SELECT name FROM suppliers WHERE id = ?",
  CUSTOMER: "SELECT name FROM customers WHERE id = ?",
  EMPLOYEE: "SELECT CONCAT(first_name, ' ', last_name) AS name FROM employees WHERE id = ?",
};

// Validates the Other Deposit and Cash Back lines off the request and returns them ready to
// insert, or { error }. Rows the form left completely blank are dropped rather than refused, the
// way the form's own empty starter row would otherwise block every save. The party's name is read
// from its record rather than taken from the browser, so the two cannot disagree.
async function normaliseLines(conn, otherDeposits, cashBacks) {
  const out = [];
  const kinds = [['other', 'Other Deposit', otherDeposits], ['cashback', 'Cash Back', cashBacks]];
  for (const [lineType, label, raw] of kinds) {
    let lineNo = 0;
    for (const l of Array.isArray(raw) ? raw : []) {
      const amount = round2(l.amount);
      const blank = !amount && !l.account_id && !l.party_id && !l.payment_method_id && !l.department_id && !l.location_id && !String(l.memo || '').trim();
      if (blank) continue;
      lineNo += 1;
      if (amount <= 0) return { error: `${label} line ${lineNo}: enter an amount above zero.` };
      if (!l.account_id) return { error: `${label} line ${lineNo}: select an account.` };
      const [[acct]] = await conn.query('SELECT id FROM chart_of_accounts WHERE id = ?', [l.account_id]);
      if (!acct) return { error: `${label} line ${lineNo}: that account no longer exists.` };

      let partyType = null; let partyId = null; let partyName = null;
      if (lineType === 'other' && l.party_type && l.party_id) {
        partyType = String(l.party_type).toUpperCase();
        if (!PARTY_TABLES[partyType]) return { error: `${label} line ${lineNo}: unknown name type.` };
        const [[p]] = await conn.query(PARTY_TABLES[partyType], [l.party_id]);
        if (!p) return { error: `${label} line ${lineNo}: that name no longer exists.` };
        partyId = Number(l.party_id); partyName = trunc(p.name, 255);
      }
      out.push({
        line_type: lineType, line_no: lineNo, party_type: partyType, party_id: partyId, party_name: partyName,
        amount, account_id: Number(l.account_id),
        payment_method_id: lineType === 'other' ? (Number(l.payment_method_id) || null) : null,
        department_id: Number(l.department_id) || null, location_id: Number(l.location_id) || null,
        memo: trunc(l.memo, 1000),
      });
    }
  }
  return out;
}

// The part of a deposit's total that none of its linked payments or lines explain: payments the
// source deposited that were never linked here (deposits imported as header + total; see
// db/import-deposit-details.js, which links them only where everything ties). lib/depositGl.js
// already posts it as Undeposited Funds. Edit keeps it and adds the changes on top -- rebuilding the
// total from what is linked turned every such deposit to 0 the moment it was edited (2026-10-12).
async function unlinkedPaymentsShare(conn, d) {
  const [[p]] = await conn.query('SELECT COALESCE(SUM(payment_amount), 0) AS s FROM customer_payments WHERE deposit_id = ?', [d.id]);
  // wu: counter-sales orders swept into the deposit are linked money too, not an unlinked share.
  const [[so]] = await conn.query('SELECT COALESCE(SUM(total_amount), 0) AS s FROM sales_orders WHERE deposit_id = ?', [d.id]);
  p.s = num(p.s) + num(so.s);
  const [[l]] = await conn.query(
    `SELECT COALESCE(SUM(CASE WHEN line_type = 'other' THEN amount ELSE 0 END), 0) AS other,
            COALESCE(SUM(CASE WHEN line_type = 'cashback' THEN amount ELSE 0 END), 0) AS cashback
       FROM bank_deposit_lines WHERE deposit_id = ?`, [d.id]);
  const share = round2(num(d.total_amount) - num(p.s) - num(l.other) + num(l.cashback));
  return share > 0.005 ? share : 0;
}

// Department is required on every Other Deposit and Cash Back line (2026-10-07). Each list is
// checked on its own so the message names the line as the form numbers it.
function depositLinesDepartmentError(lines) {
  for (const [lineType, label] of [['other', 'Other Deposit'], ['cashback', 'Cash Back']]) {
    const err = lineDepartmentError(lines.filter((l) => l.line_type === lineType));
    if (err) return `${label}: ${err}`;
  }
  return null;
}

// Lookups for the create form: bank accounts (COA detail_type 'Bank') + not-yet-deposited payments,
// and for the Other Deposit / Cash Back lines: posting accounts, payment methods, departments,
// locations and the three party sources for the Name picker (the same ones Journals offer).
router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [accounts] = await pool.query("SELECT id, account_code, account_name FROM chart_of_accounts WHERE detail_type = 'Bank' ORDER BY account_code");
    // Non-summary, not is_active: the flag is unreliable in the migrated chart (see routes/journals.js).
    const [lineAccounts] = await pool.query(
      'SELECT id, account_code, account_name, account_type FROM chart_of_accounts WHERE (is_summary = 0 OR is_summary IS NULL) ORDER BY account_code'
    );
    const [paymentMethods] = await pool.query('SELECT id, name FROM payment_methods WHERE is_active = TRUE ORDER BY name');
    const [departments] = await pool.query('SELECT id, name FROM departments WHERE is_active = TRUE ORDER BY name');
    // Also the deposit's own Branch picker (bank_deposits.office_location_id), so the company name rides along.
    const [locations] = await pool.query(
      `SELECT l.id, l.location_name, c.name AS company_name FROM locations l
         LEFT JOIN companies c ON c.id = l.company_id ORDER BY c.name, l.location_name`);
    // Enough of each party for the Name picker's tabs to tell two people of the same name apart,
    // the way the live form's Employees / Vendor / Customer tabs do.
    const [vendors] = await pool.query(
      `SELECT id, supplier_code AS code, name, company_name, address,
              COALESCE(NULLIF(mobile_no, ''), NULLIF(contact_no, ''), office_no) AS contact_no, tin
       FROM suppliers WHERE is_active = TRUE ORDER BY name`
    );
    const [customers] = await pool.query('SELECT id, customer_code AS code, name, company_name, address, tin FROM customers ORDER BY name');
    // address / birth_date / sex arrive with the HR 201-file migration, which not every install has
    // run -- asking for them unconditionally took this whole form down on all three. Each is read
    // only where the column exists, and reads as blank elsewhere.
    const [empCols] = await pool.query(
      `SELECT COLUMN_NAME AS c FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'employees' AND COLUMN_NAME IN ('address', 'birth_date', 'sex')`
    );
    const hasEmp = new Set(empCols.map((r) => r.c));
    const optional = ['address', 'birth_date', 'sex'].map((c) => (hasEmp.has(c) ? c : `NULL AS ${c}`)).join(', ');
    const [employees] = await pool.query(
      `SELECT id, employee_code AS code, CONCAT(first_name, ' ', last_name) AS name, position_title, ${optional},
              phone AS contact_no
       FROM employees WHERE is_active = TRUE ORDER BY first_name, last_name`
    );
    const [payments] = await pool.query(
      `SELECT cp.id, cp.customer_payment_no, cp.date_created, cp.payment_amount,
              c.name AS customer_name, loc.location_name, pm.name AS payment_method_name
       FROM customer_payments cp
       LEFT JOIN customers c ON c.id = cp.customer_id
       LEFT JOIN locations loc ON loc.id = cp.office_location_id
       LEFT JOIN payment_methods pm ON pm.id = cp.payment_method_id
       -- Not the CPAY-INV-#### rows: db/generate-invoice-payments.js wrote one per already-paid
       -- imported invoice (see routes/collectionForecast.js REAL_PAYMENT). No money arrived with
       -- them, so there is nothing to bank, and 68,061 of them sit at not_deposited. They filled 934
       -- of the 1,000 rows this list was capped at -- newest id first, and the generator ran after
       -- the import -- so 147 of 2026's 213 real payments, branch ones among them, never appeared
       -- (2026-10-12). Without them the list is a few hundred rows and needs no cap.
       WHERE (cp.status = 'not_deposited' AND cp.deposit_id IS NULL AND cp.customer_payment_no NOT LIKE 'CPAY-INV-%')
          OR (? > 0 AND cp.deposit_id = ?)
       ORDER BY cp.date_created DESC, cp.id DESC`,
      // Editing a deposit (?deposit_id=): its own payments are offered too, ticked by the form.
      [Number(req.query.deposit_id) || 0, Number(req.query.deposit_id) || 0]
    );
    // Imported counter sales sit in Undeposited Funds exactly like a not-deposited Customer
    // Payment, so the same Deposit sweeps them. total_daily_sales is what was debited to
    // Undeposited Funds, so that is what clears out of it.
    const [salesOrders] = await pool.query(
      `SELECT so.id, so.sales_order_no, so.date_created, so.total_amount,
              c.name AS customer_name, loc.location_name, so.pos_branch_code, so.contract_description
       FROM sales_orders so
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN locations loc ON loc.id = so.office_location_id
       WHERE (so.sales_layout = 'daily_collections' AND so.status = 'undeposited' AND so.deposit_id IS NULL)
          OR (? > 0 AND so.deposit_id = ?)
       ORDER BY so.id DESC LIMIT 1000`,
      // Editing a deposit (?deposit_id=): its own counter-sales orders are offered too.
      [Number(req.query.deposit_id) || 0, Number(req.query.deposit_id) || 0]
    );
    res.json({
      accounts, payments, sales_orders: salesOrders,
      lineAccounts, paymentMethods, departments, locations, vendors, customers, employees,
    });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, status } = req.query;
    // Date: As of (on or before) or a Period (From / To, inclusive) on the deposit date. Only a
    // full yyyy-mm-dd is used, so a half-typed date does not turn into a query.
    const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
    const asOf = day(req.query.as_of);
    const from = day(req.query.date_from);
    const to = day(req.query.date_to);
    const where = [];
    { const cw = companyWhere('d.office_location_id'); if (cw) where.push(cw); } // topbar company switcher
    const params = [];
    if (status) { where.push('d.status = ?'); params.push(status); }
    if (asOf) { where.push('d.date_created <= ?'); params.push(asOf); }
    if (from) { where.push('d.date_created >= ?'); params.push(from); }
    if (to) { where.push('d.date_created <= ?'); params.push(to); }
    if (search) { where.push('(d.bd_no LIKE ? OR d.memo LIKE ? OR coa.account_name LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT d.id, d.bd_no, d.date_created, d.total_amount, d.status, d.memo, coa.account_name,
              loc.location_name, co.name AS company_name
       FROM bank_deposits d LEFT JOIN chart_of_accounts coa ON coa.id = d.account_id
       LEFT JOIN locations loc ON loc.id = d.office_location_id
       LEFT JOIN companies co ON co.id = loc.company_id
       ${whereSql} ORDER BY d.date_created DESC, d.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[d]] = await pool.query(
      `SELECT d.*, coa.account_code, coa.account_name, loc.location_name, co.name AS company_name
       FROM bank_deposits d
       LEFT JOIN chart_of_accounts coa ON coa.id = d.account_id
       LEFT JOIN locations loc ON loc.id = d.office_location_id
       LEFT JOIN companies co ON co.id = loc.company_id
       WHERE d.id = ?`,
      [req.params.id]
    );
    if (!d) return res.status(404).json({ error: 'Not found' });
    const [payments] = await pool.query(
      `SELECT cp.id, cp.customer_payment_no, cp.date_created, cp.payment_amount, cp.customer_id, c.name AS customer_name
       FROM customer_payments cp LEFT JOIN customers c ON c.id = cp.customer_id
       WHERE cp.deposit_id = ? ORDER BY cp.id`,
      [req.params.id]
    );
    const [salesOrders] = await pool.query(
      `SELECT so.id, so.sales_order_no, so.date_created, so.total_amount, so.contract_description,
              c.name AS customer_name
       FROM sales_orders so LEFT JOIN customers c ON c.id = so.customer_id
       WHERE so.deposit_id = ? ORDER BY so.id`,
      [req.params.id]
    );
    // Counter-sales orders count in the payments' share that depositGlRows credits to 10006.
    // Guarded so a deploy that lands before src/db/add-deposit-other-lines.js has run still opens
    // every deposit rather than 500ing on the missing table.
    const [lineTbl] = await pool.query("SHOW TABLES LIKE 'bank_deposit_lines'");
    const [lines] = !lineTbl.length ? [[]] : await pool.query(
      `SELECT l.*, coa.account_code, coa.account_name, pm.name AS payment_method_name,
              dep.name AS department_name, loc.location_name
       FROM bank_deposit_lines l
       JOIN chart_of_accounts coa ON coa.id = l.account_id
       LEFT JOIN payment_methods pm ON pm.id = l.payment_method_id
       LEFT JOIN departments dep ON dep.id = l.department_id
       LEFT JOIN locations loc ON loc.id = l.location_id
       WHERE l.deposit_id = ? ORDER BY l.line_type, l.line_no`,
      [req.params.id]
    );
    const [[uf]] = await pool.query("SELECT account_code, account_name FROM chart_of_accounts WHERE account_code = '10006'");
    const unlinked = lineTbl.length ? await unlinkedPaymentsShare(pool, d) : 0;
    res.json({ ...d, payments, sales_orders: salesOrders, lines, unlinked_amount: unlinked, gl: depositGlRows(d, lines, uf), reconciled: await isReconciled(pool, d.id) });
  } catch (err) { next(err); }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'BankDeposit' AND a.auditable_id = ? ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const {
      date_created: dateCreated, account_id: accountId, memo,
      payment_ids: paymentIds, sales_order_ids: salesOrderIds,
    } = req.body;
    if (!accountId) return res.status(400).json({ error: 'Select a bank account to deposit into.' });
    const ids = [...new Set((Array.isArray(paymentIds) ? paymentIds : []).map(Number).filter(Boolean))];
    const soIds = [...new Set((Array.isArray(salesOrderIds) ? salesOrderIds : []).map(Number).filter(Boolean))];

    const lines = await normaliseLines(conn, req.body.other_deposits, req.body.cash_backs);
    if (lines.error) return res.status(400).json({ error: lines.error });
    const deptError = depositLinesDepartmentError(lines);
    if (deptError) return res.status(400).json({ error: deptError });
    // A deposit of nothing but Other Deposit lines is still money going to the bank; a deposit of
    // nothing but Cash Back is not, which the net-total check below catches.
    if (!ids.length && !soIds.length && !lines.some((l) => l.line_type === 'other')) {
      return res.status(400).json({ error: 'Select at least one payment or counter-sales order, or add an Other Deposit.' });
    }

    let pays = [];
    if (ids.length) {
      [pays] = await conn.query(
        "SELECT id, payment_amount, status, deposit_id FROM customer_payments WHERE id IN (?)", [ids]
      );
      if (pays.length !== ids.length) return res.status(400).json({ error: 'One or more payments are no longer valid.' });
      for (const p of pays) {
        if (p.deposit_id || p.status === 'deposited') return res.status(409).json({ error: 'One or more payments are already deposited.' });
        if (p.status === 'voided') return res.status(409).json({ error: 'A voided payment cannot be deposited.' });
      }
    }

    // Counter-sales orders deposit the amount that was debited to Undeposited Funds, so the
    // account clears exactly. Re-checked here rather than trusted from the form.
    let orders = [];
    if (soIds.length) {
      [orders] = await conn.query(
        "SELECT id, sales_order_no, total_amount, status, deposit_id, sales_layout FROM sales_orders WHERE id IN (?)", [soIds]
      );
      if (orders.length !== soIds.length) return res.status(400).json({ error: 'One or more counter-sales orders are no longer valid.' });
      for (const o of orders) {
        if (o.sales_layout !== 'daily_collections') return res.status(400).json({ error: `${o.sales_order_no} is not a counter-sales order.` });
        if (o.deposit_id || o.status === 'deposited') return res.status(409).json({ error: `${o.sales_order_no} is already deposited.` });
        if (o.status === 'cancelled') return res.status(409).json({ error: `${o.sales_order_no} is cancelled.` });
      }
    }

    // Payments and counter-sales orders both clear Undeposited Funds; depositGlRows credits 10006
    // with whatever the Other Deposit / Cash Back lines do not explain.
    const paymentsTotal = pays.reduce((s, p) => s + num(p.payment_amount), 0)
      + orders.reduce((s, o) => s + num(o.total_amount), 0);
    const otherTotal = lines.filter((l) => l.line_type === 'other').reduce((s, l) => s + l.amount, 0);
    const cashBackTotal = lines.filter((l) => l.line_type === 'cashback').reduce((s, l) => s + l.amount, 0);
    const total = round2(paymentsTotal + otherTotal - cashBackTotal);
    if (total <= 0) {
      return res.status(400).json({ error: 'Cash Back cannot be as much as the payments and Other Deposits together -- the deposit total must be above zero.' });
    }
    await assertPeriodOpen(dateCreated, 'ar');

    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO bank_deposits (bd_no, date_created, account_id, memo, total_amount, status, created_by_user_id, office_location_id)
       VALUES ('', ?, ?, ?, ?, 'open', ?, ?)`,
      [dateCreated || new Date().toISOString().slice(0, 10), accountId, trunc(memo, 1000), total, req.user.id,
        Number(req.body.office_location_id) || null]
    );
    const depositId = r.insertId;
    const bdNo = await assignDocNo(conn, { table: 'bank_deposits', column: 'bd_no', prefix: 'BD-', id: depositId });
    if (ids.length) {
      await conn.query("UPDATE customer_payments SET deposit_id = ?, status = 'deposited' WHERE id IN (?)", [depositId, ids]);
    }
    if (soIds.length) await conn.query("UPDATE sales_orders SET deposit_id = ?, status = 'deposited' WHERE id IN (?)", [depositId, soIds]);
    for (const l of lines) {
      await conn.query(
        `INSERT INTO bank_deposit_lines (deposit_id, line_type, line_no, party_type, party_id, party_name, amount,
                                         account_id, payment_method_id, department_id, location_id, memo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [depositId, l.line_type, l.line_no, l.party_type, l.party_id, l.party_name, l.amount,
          l.account_id, l.payment_method_id, l.department_id, l.location_id, l.memo]
      );
    }
    await logAudit(conn, { depositId, userId: req.user.id, eventType: 'Created', fieldName: 'bd_no', newValue: bdNo });
    await conn.commit();
    res.status(201).json({ id: depositId, bd_no: bdNo });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// Cleared in a Bank Reconciliation? Then the bank statement is matched to this exact deposit and
// it must not change under the reconciliation. Guarded for installs without the module.
async function isReconciled(db, depositId) {
  const [t] = await db.query("SHOW TABLES LIKE 'bank_reconciliation_matches'");
  if (!t.length) return false;
  const [[m]] = await db.query("SELECT 1 AS x FROM bank_reconciliation_matches WHERE source_kind = 'deposit' AND source_id = ? LIMIT 1", [depositId]);
  return !!m;
}

// Edit a Bank Deposit (asked 2026-10-03): the same form as creating one, opened on what was saved --
// date, bank account, memo, which payments it sweeps in, and the Other Deposit / Cash Back lines.
// The deposit's current payments are released back to Not Deposited first and the ticked ones
// taken, all in one transaction. Refused once void, once reconciled against the bank, or when the
// old or the new date falls in a closed period. Its GL is derived on read (lib/depositGl.js), so
// there is nothing to unpost.
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[d]] = await conn.query('SELECT * FROM bank_deposits WHERE id = ?', [req.params.id]);
    if (!d) return res.status(404).json({ error: 'Not found' });
    if (d.status === 'void') return res.status(409).json({ error: 'A voided deposit cannot be edited.' });
    if (await isReconciled(conn, d.id)) {
      return res.status(409).json({ error: 'This deposit is cleared in a Bank Reconciliation and can no longer be edited.' });
    }
    const {
      date_created: dateCreated, account_id: accountId, memo, payment_ids: paymentIds, sales_order_ids: salesOrderIds,
    } = req.body;
    if (!accountId) return res.status(400).json({ error: 'Select a bank account to deposit into.' });
    const ids = [...new Set((Array.isArray(paymentIds) ? paymentIds : []).map(Number).filter(Boolean))];
    const soIds = [...new Set((Array.isArray(salesOrderIds) ? salesOrderIds : []).map(Number).filter(Boolean))];
    const lines = await normaliseLines(conn, req.body.other_deposits, req.body.cash_backs);
    if (lines.error) return res.status(400).json({ error: lines.error });
    const deptError = depositLinesDepartmentError(lines);
    if (deptError) return res.status(400).json({ error: deptError });
    // Read before anything below relinks or replaces lines -- it is the share as saved.
    const unlinked = await unlinkedPaymentsShare(conn, d);
    if (!ids.length && !soIds.length && !unlinked && !lines.some((l) => l.line_type === 'other')) {
      return res.status(400).json({ error: 'Select at least one payment or counter-sales order, or add an Other Deposit.' });
    }
    let pays = [];
    if (ids.length) {
      [pays] = await conn.query('SELECT id, payment_amount, status, deposit_id FROM customer_payments WHERE id IN (?)', [ids]);
    }
    if (pays.length !== ids.length) return res.status(400).json({ error: 'One or more payments are no longer valid.' });
    for (const p of pays) {
      if (p.status === 'voided') return res.status(409).json({ error: 'A voided payment cannot be deposited.' });
      if (p.deposit_id && Number(p.deposit_id) !== Number(d.id)) return res.status(409).json({ error: 'One or more payments are already in another deposit.' });
    }
    let orders = [];
    if (soIds.length) {
      [orders] = await conn.query('SELECT id, sales_order_no, total_amount, status, deposit_id, sales_layout FROM sales_orders WHERE id IN (?)', [soIds]);
    }
    if (orders.length !== soIds.length) return res.status(400).json({ error: 'One or more counter-sales orders are no longer valid.' });
    for (const o of orders) {
      if (o.sales_layout !== 'daily_collections') return res.status(400).json({ error: `${o.sales_order_no} is not a counter-sales order.` });
      if (o.status === 'cancelled') return res.status(409).json({ error: `${o.sales_order_no} is cancelled.` });
      if (o.deposit_id && Number(o.deposit_id) !== Number(d.id)) return res.status(409).json({ error: `${o.sales_order_no} is already in another deposit.` });
    }
    const paymentsTotal = pays.reduce((t, p) => t + num(p.payment_amount), 0)
      + orders.reduce((t, o) => t + num(o.total_amount), 0);
    const otherTotal = lines.filter((l) => l.line_type === 'other').reduce((t, l) => t + l.amount, 0);
    const cashBackTotal = lines.filter((l) => l.line_type === 'cashback').reduce((t, l) => t + l.amount, 0);
    const total = round2(unlinked + paymentsTotal + otherTotal - cashBackTotal);
    if (total <= 0) {
      return res.status(400).json({ error: 'Cash Back cannot be as much as the payments and Other Deposits together -- the deposit total must be above zero.' });
    }
    const day = (v) => (v instanceof Date ? v.toISOString() : String(v || '')).slice(0, 10);
    const oldDate = day(d.date_created);
    const newDate = day(dateCreated) || oldDate;
    await assertPeriodOpen(oldDate, 'ar', conn);
    if (newDate !== oldDate) await assertPeriodOpen(newDate, 'ar', conn);

    const [oldPays] = await conn.query('SELECT customer_payment_no FROM customer_payments WHERE deposit_id = ? ORDER BY id', [d.id]);
    await conn.beginTransaction();
    await conn.query("UPDATE customer_payments SET deposit_id = NULL, status = 'not_deposited' WHERE deposit_id = ?", [d.id]);
    if (ids.length) await conn.query("UPDATE customer_payments SET deposit_id = ?, status = 'deposited' WHERE id IN (?)", [d.id, ids]);
    await conn.query("UPDATE sales_orders SET deposit_id = NULL, status = 'undeposited' WHERE deposit_id = ?", [d.id]);
    if (soIds.length) await conn.query("UPDATE sales_orders SET deposit_id = ?, status = 'deposited' WHERE id IN (?)", [d.id, soIds]);
    await conn.query('DELETE FROM bank_deposit_lines WHERE deposit_id = ?', [d.id]);
    for (const l of lines) {
      await conn.query(
        `INSERT INTO bank_deposit_lines (deposit_id, line_type, line_no, party_type, party_id, party_name, amount,
                                         account_id, payment_method_id, department_id, location_id, memo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.id, l.line_type, l.line_no, l.party_type, l.party_id, l.party_name, l.amount,
          l.account_id, l.payment_method_id, l.department_id, l.location_id, l.memo]
      );
    }
    const newLocationId = Number(req.body.office_location_id) || null;
    await conn.query('UPDATE bank_deposits SET date_created = ?, account_id = ?, memo = ?, total_amount = ?, office_location_id = ? WHERE id = ?',
      [newDate, accountId, trunc(memo, 1000), total, newLocationId, d.id]);
    if (Number(d.office_location_id || 0) !== Number(newLocationId || 0)) {
      await logAudit(conn, { depositId: d.id, userId: req.user.id, eventType: 'Updated', fieldName: 'office_location_id', oldValue: d.office_location_id, newValue: newLocationId });
    }

    const changes = [];
    if (newDate !== oldDate) changes.push(['date_created', oldDate, newDate]);
    if (Number(accountId) !== Number(d.account_id)) changes.push(['account_id', d.account_id, accountId]);
    if ((memo || '') !== (d.memo || '')) changes.push(['memo', d.memo, memo]);
    if (round2(d.total_amount) !== total) changes.push(['total_amount', round2(d.total_amount), total]);
    const [newPays] = await conn.query('SELECT customer_payment_no FROM customer_payments WHERE deposit_id = ? ORDER BY id', [d.id]);
    const list = (r) => r.map((x) => x.customer_payment_no).join(', ');
    if (list(oldPays) !== list(newPays)) changes.push(['payments', list(oldPays), list(newPays)]);
    for (const [f, o, n] of changes) {
      await logAudit(conn, { depositId: d.id, userId: req.user.id, eventType: 'Updated', fieldName: f, oldValue: o, newValue: n });
    }
    if (!changes.length) await logAudit(conn, { depositId: d.id, userId: req.user.id, eventType: 'Updated', fieldName: 'lines', newValue: `${lines.length} line(s)` });
    await conn.commit();
    res.json({ id: d.id, bd_no: d.bd_no });
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally { conn.release(); }
});

router.put('/:id/void', requireAuth, requirePermission(ROUTE, 'can_void'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[d]] = await conn.query('SELECT status, date_created FROM bank_deposits WHERE id = ?', [req.params.id]);
    if (!d) return res.status(404).json({ error: 'Not found' });
    if (d.status === 'void') return res.status(409).json({ error: 'Already voided.' });
    await assertPeriodOpen(d.date_created, 'ar', conn);
    await conn.beginTransaction();
    // Release the payments back to not-deposited so they can be deposited again.
    await conn.query("UPDATE customer_payments SET deposit_id = NULL, status = 'not_deposited' WHERE deposit_id = ?", [req.params.id]);
    // Same for any counter-sales orders swept into this deposit -- back to undeposited.
    await conn.query("UPDATE sales_orders SET deposit_id = NULL, status = 'undeposited' WHERE deposit_id = ?", [req.params.id]);
    await conn.query("UPDATE bank_deposits SET status = 'void', voided_at = NOW(), voided_by_user_id = ? WHERE id = ?", [req.user.id, req.params.id]);
    await logAudit(conn, { depositId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: d.status, newValue: 'void' });
    await conn.commit();
    res.json({ ok: true });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

module.exports = router;
