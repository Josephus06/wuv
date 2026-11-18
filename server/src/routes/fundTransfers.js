const express = require('express');
const pool = require('../db');
const { assignDocNo } = require('../lib/docNumber');
const { requireAuth, requirePermission, isSystemAdmin, userCan } = require('../middleware/auth');
const { assertPeriodOpen } = require('../lib/accountingPeriod');
const { fundTransferPostError, hasLink } = require('../lib/fundTransferPosting');

const router = express.Router();
// Fund Transfer (FT-####): moves an amount from one bank account to another. GL: DR the To account
// / CR the From account.
const ROUTE = '/fund-transfers';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (v) => Number(num(v).toFixed(2));
const trunc = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));

async function logAudit(conn, { ftId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('FundTransfer', ?, ?, ?, ?, ?, ?)`,
    [ftId, eventType, fieldName, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), userId]
  );
}

router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [accounts] = await pool.query("SELECT id, account_code, account_name FROM chart_of_accounts WHERE detail_type = 'Bank' ORDER BY account_code");
    // The branch the transfer belongs to -- what puts it in a company's books (locations.company_id).
    const [locations] = await pool.query(
      `SELECT l.id, l.location_name, c.name AS company_name FROM locations l
         LEFT JOIN companies c ON c.id = l.company_id WHERE l.is_active = TRUE ORDER BY c.name, l.location_name`);
    res.json({ accounts, locations });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, status, as_of: asOf } = req.query;
    const where = [];
    const params = [];
    if (status) { where.push('ft.status = ?'); params.push(status); }
    if (asOf) { where.push('ft.date_created <= ?'); params.push(asOf); }
    if (search) { where.push('(ft.ft_no LIKE ? OR ft.memo LIKE ? OR fa.account_name LIKE ? OR ta.account_name LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT ft.id, ft.ft_no, ft.date_created, ft.amount, ft.status, ft.memo,
              fa.account_name AS from_account_name, ta.account_name AS to_account_name,
              u.display_name AS prepared_by_name, loc.location_name, co.name AS company_name
       FROM fund_transfers ft
       LEFT JOIN chart_of_accounts fa ON fa.id = ft.from_account_id
       LEFT JOIN chart_of_accounts ta ON ta.id = ft.to_account_id
       LEFT JOIN users u ON u.id = ft.created_by_user_id
       LEFT JOIN locations loc ON loc.id = ft.office_location_id
       LEFT JOIN companies co ON co.id = loc.company_id
       ${whereSql} ORDER BY ft.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[ft]] = await pool.query(
      `SELECT ft.*, fa.account_code AS from_account_code, fa.account_name AS from_account_name,
              ta.account_code AS to_account_code, ta.account_name AS to_account_name,
              u.display_name AS prepared_by_name, loc.location_name, co.name AS company_name
       FROM fund_transfers ft
       LEFT JOIN chart_of_accounts fa ON fa.id = ft.from_account_id
       LEFT JOIN chart_of_accounts ta ON ta.id = ft.to_account_id
       LEFT JOIN users u ON u.id = ft.created_by_user_id
       LEFT JOIN locations loc ON loc.id = ft.office_location_id
       LEFT JOIN companies co ON co.id = loc.company_id
       WHERE ft.id = ?`,
      [req.params.id]
    );
    if (!ft) return res.status(404).json({ error: 'Not found' });
    // GL Impact: DR the To account / CR the From account for the amount.
    const amt = round2(ft.amount);
    const gl = (ft.status !== 'void' && amt > 0) ? [
      { account_code: ft.to_account_code, account_name: ft.to_account_name, debit: amt, credit: 0 },
      { account_code: ft.from_account_code, account_name: ft.from_account_name, debit: 0, credit: amt },
    ] : [];
    res.json({ ...ft, gl });
  } catch (err) { next(err); }
});

// The Fund Transfer Voucher, as the old system prints it (client/src/pages/FundTransferPrint.jsx).
// Its lines are the transfer's GL entry -- shown even on a voided transfer, which prints marked VOID.
router.get('/:id/print', requireAuth, async (req, res, next) => {
  try {
    if (!(await isSystemAdmin(req.user.id)) && !(await userCan(req.user.id, ROUTE, 'can_print'))) {
      return res.status(403).json({ error: 'You do not have permission to print a Fund Transfer.' });
    }
    const [[ft]] = await pool.query(
      `SELECT ft.*, fa.account_code AS from_account_code, fa.account_name AS from_account_name,
              ta.account_code AS to_account_code, ta.account_name AS to_account_name,
              u.display_name AS prepared_by_name, u.signature_data AS prepared_signature
       FROM fund_transfers ft
       LEFT JOIN chart_of_accounts fa ON fa.id = ft.from_account_id
       LEFT JOIN chart_of_accounts ta ON ta.id = ft.to_account_id
       LEFT JOIN users u ON u.id = ft.created_by_user_id
       WHERE ft.id = ?`,
      [req.params.id]
    );
    if (!ft) return res.status(404).json({ error: 'Not found' });
    const amt = round2(ft.amount);
    const lines = [
      { account_code: ft.to_account_code, account_name: ft.to_account_name, debit: amt, credit: 0 },
      { account_code: ft.from_account_code, account_name: ft.from_account_name, debit: 0, credit: amt },
    ];
    res.json({ ...ft, lines });
  } catch (err) { next(err); }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'FundTransfer' AND a.auditable_id = ? ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { date_created: dateCreated, from_account_id: fromId, to_account_id: toId, amount, memo } = req.body;
    if (!fromId || !toId) return res.status(400).json({ error: 'Select both a From and a To account.' });
    if (String(fromId) === String(toId)) return res.status(400).json({ error: 'From and To accounts must be different.' });
    if (round2(amount) <= 0) return res.status(400).json({ error: 'Enter an amount greater than 0.' });
    await assertPeriodOpen(dateCreated, 'other_gl');
    // Raised from an approved Fund Transfer Request (Create Fund Transfer Voucher on the form,
    // 2026-10-14): it may not post more than the request has left (lib/fundTransferPosting.js).
    const formRequestId = Number(req.body.form_request_id) || null;
    if (formRequestId) {
      const why = await fundTransferPostError(conn, formRequestId, amount);
      if (why) return res.status(409).json({ error: why });
    }
    const linkForm = formRequestId && await hasLink(conn, 'fund_transfers');
    const officeLocationId = Number(req.body.office_location_id) || null;

    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO fund_transfers (ft_no, date_created, from_account_id, to_account_id, amount, memo, status, created_by_user_id, office_location_id${linkForm ? ', form_request_id' : ''})
       VALUES ('', ?, ?, ?, ?, ?, 'open', ?, ?${linkForm ? ', ?' : ''})`,
      [dateCreated || new Date().toISOString().slice(0, 10), fromId, toId, round2(amount), trunc(memo, 1000), req.user.id,
        officeLocationId, ...(linkForm ? [formRequestId] : [])]
    );
    const ftId = r.insertId;
    const ftNo = await assignDocNo(conn, { table: 'fund_transfers', column: 'ft_no', prefix: 'FT-', id: ftId });
    await logAudit(conn, { ftId, userId: req.user.id, eventType: 'Created', fieldName: 'ft_no', newValue: ftNo });
    await conn.commit();
    res.status(201).json({ id: ftId, ft_no: ftNo });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// Edit a saved transfer. Its GL entry is derived from these fields (lib/glImpact.js), so saving is
// all it takes to move the entry -- both the old and the new date must be in an open period.
const EDIT_FIELDS = ['date_created', 'from_account_id', 'to_account_id', 'amount', 'memo', 'office_location_id'];
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[ft]] = await conn.query('SELECT * FROM fund_transfers WHERE id = ?', [req.params.id]);
    if (!ft) return res.status(404).json({ error: 'Not found' });
    if (ft.status === 'void') return res.status(409).json({ error: 'This Fund Transfer is voided and cannot be edited.' });
    const b = req.body;
    const day = (v) => (v == null || v === '' ? null : String(v instanceof Date ? v.toISOString() : v).slice(0, 10));
    const next_ = {
      date_created: day(b.date_created) || day(ft.date_created),
      from_account_id: b.from_account_id ? Number(b.from_account_id) : null,
      to_account_id: b.to_account_id ? Number(b.to_account_id) : null,
      amount: round2(b.amount),
      memo: trunc(b.memo, 1000),
      office_location_id: Number(b.office_location_id) || null,
    };
    if (!next_.from_account_id || !next_.to_account_id) return res.status(400).json({ error: 'Select both a From and a To account.' });
    if (next_.from_account_id === next_.to_account_id) return res.status(400).json({ error: 'From and To accounts must be different.' });
    if (next_.amount <= 0) return res.status(400).json({ error: 'Enter an amount greater than 0.' });
    await assertPeriodOpen(ft.date_created, 'other_gl', conn);
    await assertPeriodOpen(next_.date_created, 'other_gl', conn);

    await conn.beginTransaction();
    await conn.query(
      `UPDATE fund_transfers SET ${EDIT_FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
      [...EDIT_FIELDS.map((f) => next_[f]), req.params.id]
    );
    const was = { ...ft, date_created: day(ft.date_created), amount: round2(ft.amount) };
    for (const f of EDIT_FIELDS) {
      if (String(was[f] ?? '') !== String(next_[f] ?? '')) {
        await logAudit(conn, { ftId: req.params.id, userId: req.user.id, eventType: 'Updated', fieldName: f, oldValue: was[f], newValue: next_[f] });
      }
    }
    await conn.commit();
    res.json({ id: Number(req.params.id), ft_no: ft.ft_no });
  } catch (err) {
    await conn.rollback();
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally { conn.release(); }
});

router.put('/:id/void', requireAuth, requirePermission(ROUTE, 'can_void'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[ft]] = await conn.query('SELECT status, date_created FROM fund_transfers WHERE id = ?', [req.params.id]);
    if (!ft) return res.status(404).json({ error: 'Not found' });
    if (ft.status === 'void') return res.status(409).json({ error: 'Already voided.' });
    await assertPeriodOpen(ft.date_created, 'other_gl', conn);
    await conn.beginTransaction();
    await conn.query("UPDATE fund_transfers SET status = 'void', voided_at = NOW(), voided_by_user_id = ? WHERE id = ?", [req.user.id, req.params.id]);
    await logAudit(conn, { ftId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: ft.status, newValue: 'void' });
    await conn.commit();
    res.json({ ok: true });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

module.exports = router;
