const express = require('express');
const pool = require('../db');
const { insertNumbered } = require('../lib/docNumber');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { computeCustomerRefundGl } = require('../lib/glImpact');
const { assertPeriodOpen } = require('../lib/accountingPeriod');
const { headerDepartmentError } = require('../lib/requireDepartment');

const router = express.Router();
// Customer Refund (CRFND-####): returns cash to a customer against one or more of their
// Customer Payments. A standalone Accounting transaction (unlike Customer Payment / Credit
// Memo which are raised from an invoice) -- you pick a customer, then how much of each of
// their payments to refund. Debits A/R Trade (12100), credits Customer Refund (10005).
const ROUTE = '/customer-refunds';

async function logAudit(conn, { refundId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('CustomerRefund', ?, ?, ?, ?, ?, ?)`,
    [refundId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// Customer Payments applied to a refund (2026-11-05; customer_payment_lines.customer_refund_id,
// add-payment-refund-apply.js). A refund debits A/R, so it stays open until payments are applied to
// it; its amount due is the refund less what non-voided payments apply.
let refundApplyReady = false;
async function refundsReady(q = pool) {
  if (!refundApplyReady) {
    const [c] = await q.query("SHOW COLUMNS FROM customer_payment_lines LIKE 'customer_refund_id'");
    refundApplyReady = c.length > 0;
  }
  return refundApplyReady;
}
async function paymentsApplied(q, refundId) {
  if (!(await refundsReady(q))) return [];
  const [rows] = await q.query(
    `SELECT cpl.id, cpl.customer_payment_id, cpl.applied_amount, cp.customer_payment_no, cp.date_created, cp.status
       FROM customer_payment_lines cpl JOIN customer_payments cp ON cp.id = cpl.customer_payment_id
      WHERE cpl.customer_refund_id = ? AND cp.status <> 'voided' ORDER BY cp.date_created, cp.id`, [refundId]);
  return rows;
}

// Powers the create form: the customer's refundable payments plus the two default GL accounts.
router.get('/for-customer/:customerId', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[customer]] = await pool.query('SELECT id, name, tin FROM customers WHERE id = ?', [req.params.customerId]);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const [payments] = await pool.query(
      `SELECT id AS customer_payment_id, customer_payment_no, date_created, payment_amount, customer_id
       FROM customer_payments
       WHERE customer_id = ? AND status != 'voided'
       ORDER BY id DESC`,
      [req.params.customerId]
    );
    const [[arAcct]] = await pool.query("SELECT id, account_code, account_name FROM chart_of_accounts WHERE account_code = '12100'");
    const [[refundAcct]] = await pool.query("SELECT id, account_code, account_name FROM chart_of_accounts WHERE account_code = '10005'");

    res.json({
      customer,
      payments,
      ar_account_id: arAcct?.id || null, ar_account_code: arAcct?.account_code || null, ar_account_name: arAcct?.account_name || null,
      account_id: refundAcct?.id || null, account_code: refundAcct?.account_code || null, account_name: refundAcct?.account_name || null,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, status } = req.query;
    const where = [];
    const params = [];
    if (status) { where.push('cr.status = ?'); params.push(status); }
    if (search) {
      where.push('(cr.customer_refund_no LIKE ? OR c.name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT cr.id, cr.customer_refund_no, cr.date_created, cr.refund_amount, cr.status,
              cr.customer_id, c.name AS customer_name, pm.name AS payment_method_name
       FROM customer_refunds cr
       LEFT JOIN customers c ON c.id = cr.customer_id
       LEFT JOIN payment_methods pm ON pm.id = cr.payment_method_id
       ${whereSql}
       ORDER BY cr.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[cr]] = await pool.query(
      `SELECT cr.*, c.name AS customer_name, c.tin AS customer_tin, d.name AS department_name,
              loc.location_name AS office_location_name, pm.name AS payment_method_name,
              acc.account_code AS account_code, acc.account_name AS account_name,
              ar.account_code AS ar_account_code, ar.account_name AS ar_account_name,
              iu.display_name AS issued_by_name, u.display_name AS created_by_name
       FROM customer_refunds cr
       LEFT JOIN customers c ON c.id = cr.customer_id
       LEFT JOIN departments d ON d.id = cr.department_id
       LEFT JOIN locations loc ON loc.id = cr.office_location_id
       LEFT JOIN payment_methods pm ON pm.id = cr.payment_method_id
       LEFT JOIN chart_of_accounts acc ON acc.id = cr.account_id
       LEFT JOIN chart_of_accounts ar ON ar.id = cr.ar_account_id
       LEFT JOIN users iu ON iu.id = cr.issued_by_user_id
       LEFT JOIN users u ON u.id = cr.created_by_user_id
       WHERE cr.id = ?`,
      [req.params.id]
    );
    if (!cr) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT crl.*, cp.customer_payment_no, cp.date_created AS payment_date, cp.payment_amount AS payment_amount,
              c.name AS payment_customer_name
       FROM customer_refund_lines crl
       LEFT JOIN customer_payments cp ON cp.id = crl.customer_payment_id
       LEFT JOIN customers c ON c.id = cp.customer_id
       WHERE crl.customer_refund_id = ?`,
      [req.params.id]
    );

    const glImpact = await computeCustomerRefundGl(cr);
    const payments = await paymentsApplied(pool, cr.id);
    const paid = payments.reduce((t, p) => t + Number(p.applied_amount), 0);
    res.json({
      ...cr, lines, gl_impact: glImpact, payments_applied: payments,
      amount_paid: Number(paid.toFixed(2)),
      amount_due: cr.status === 'voided' ? 0 : Number(Math.max(Number(cr.refund_amount) - paid, 0).toFixed(2)),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'CustomerRefund' AND a.auditable_id = ?
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
      customer_id: customerId, date_created: dateCreated, department_id: departmentId,
      office_location_id: officeLocationId, account_id: accountId, ar_account_id: arAccountId,
      payment_method_id: paymentMethodId, memo, lines,
    } = req.body;

    if (!customerId) return res.status(400).json({ error: 'Customer is required.' });
    const deptError = headerDepartmentError(departmentId);
    if (deptError) return res.status(400).json({ error: deptError });

    const submitted = (Array.isArray(lines) ? lines : []).filter((l) => l.customer_payment_id && Number(l.refund_amount) > 0);
    if (!submitted.length) return res.status(400).json({ error: 'Enter a refund amount for at least one payment.' });

    // A refund can't exceed the payment it's returning -- reject rather than clamp.
    const prepared = [];
    for (const l of submitted) {
      const [[cp]] = await conn.query('SELECT customer_payment_no, payment_amount, status, customer_id FROM customer_payments WHERE id = ?', [l.customer_payment_id]);
      if (!cp) return res.status(400).json({ error: 'One of the selected payments is no longer valid.' });
      if (cp.status === 'voided') return res.status(409).json({ error: `${cp.customer_payment_no} is void and cannot be refunded.` });
      if (Number(cp.customer_id) !== Number(customerId)) return res.status(400).json({ error: `${cp.customer_payment_no} does not belong to this customer.` });
      if (Number(l.refund_amount) > Number(cp.payment_amount) + 1e-9) {
        return res.status(409).json({ error: `Refund Amount (${l.refund_amount}) exceeds ${cp.customer_payment_no}'s Original Amount (${cp.payment_amount}).` });
      }
      prepared.push({ customer_payment_id: l.customer_payment_id, original_amount: Number(cp.payment_amount), refund_amount: Number(l.refund_amount) });
    }

    const refundTotal = Number(prepared.reduce((s, l) => s + l.refund_amount, 0).toFixed(2));

    // Default the two GL accounts if the form didn't send them.
    let accId = accountId || null;
    let arId = arAccountId || null;
    if (!accId) { const [[a]] = await conn.query("SELECT id FROM chart_of_accounts WHERE account_code = '10005'"); accId = a?.id || null; }
    if (!arId) { const [[a]] = await conn.query("SELECT id FROM chart_of_accounts WHERE account_code = '12100'"); arId = a?.id || null; }
    await assertPeriodOpen(dateCreated, 'ar', conn);

    await conn.beginTransaction();
    const { id: refundId } = await insertNumbered(conn, {
      table: 'customer_refunds',
      column: 'customer_refund_no',
      prefix: 'CRFND-',
      run: (no) => conn.query(
        `INSERT INTO customer_refunds
           (customer_refund_no, date_created, customer_id, department_id, office_location_id, account_id,
            ar_account_id, payment_method_id, refund_amount, memo, issued_by_user_id, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          no, dateCreated || new Date().toISOString().slice(0, 10), customerId, departmentId || null,
          officeLocationId || null, accId, arId, paymentMethodId || null, refundTotal, memo || null,
          req.user.id, req.user.id,
        ]
      ),
    });

    for (const l of prepared) {
      await conn.query(
        'INSERT INTO customer_refund_lines (customer_refund_id, customer_payment_id, original_amount, refund_amount) VALUES (?, ?, ?, ?)',
        [refundId, l.customer_payment_id, l.original_amount, l.refund_amount]
      );
    }

    await logAudit(conn, { refundId, userId: req.user.id, eventType: 'Created', fieldName: 'customer_refund_no', newValue: `CRFND-${refundId}` });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM customer_refunds WHERE id = ?', [refundId]);
    res.status(201).json(row);
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
    const [[cr]] = await conn.query('SELECT status, date_created FROM customer_refunds WHERE id = ?', [req.params.id]);
    if (cr) await assertPeriodOpen(cr.date_created, 'ar', conn);
    if (!cr) return res.status(404).json({ error: 'Not found' });
    if (cr.status === 'voided') return res.status(409).json({ error: 'This Customer Refund is already voided.' });
    const applied = await paymentsApplied(conn, req.params.id);
    if (applied.length) {
      return res.status(409).json({
        error: `Customer Payment(s) ${applied.map((p) => p.customer_payment_no).join(', ')} are applied to this refund -- unapply them first.`,
      });
    }

    await conn.beginTransaction();
    await conn.query("UPDATE customer_refunds SET status = 'voided', voided_by_user_id = ?, voided_at = NOW() WHERE id = ?", [req.user.id, req.params.id]);
    await logAudit(conn, { refundId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: cr.status, newValue: 'voided' });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM customer_refunds WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
