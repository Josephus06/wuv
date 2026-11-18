const express = require('express');
const { lineDepartmentError } = require('../lib/requireDepartment');
const pool = require('../db');
const { assignDocNo } = require('../lib/docNumber');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { assertPeriodOpen } = require('../lib/accountingPeriod');
const { liquidationPostError } = require('../lib/liquidationPosting');
const { journalLinesInPesos } = require('../lib/glImpact');

const router = express.Router();
// Journal (JRNL-####): a manual general-journal entry. Balanced debit/credit lines posted straight
// to the GL (its GL Impact IS its lines). Each line = an account + optional department/party + a
// debit or a credit + a memo. Total debit must equal total credit.
const ROUTE = '/journals';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (v) => Number(num(v).toFixed(2));
const trunc = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));

async function logAudit(conn, { journalId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('Journal', ?, ?, ?, ?, ?, ?)`,
    [journalId, eventType, fieldName, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), userId]
  );
}

// Lookups for the create form: posting accounts (exclude summary/header accounts), departments,
// locations, and the three party sources (vendor/customer/employee) for the per-line Name picker.
router.get('/meta', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    // Posting accounts = non-summary. The migrated COA has most rows flagged is_active=0 (the flag
    // is unreliable in the imported data -- even accounts actively used in the GL, e.g. 20100/10004,
    // are marked inactive), so filter on is_summary only, matching how the live GL posts to them.
    const [accounts] = await pool.query(
      'SELECT id, account_code, account_name, account_type FROM chart_of_accounts WHERE (is_summary = 0 OR is_summary IS NULL) ORDER BY account_code'
    );
    const [departments] = await pool.query('SELECT id, name FROM departments WHERE is_active = TRUE ORDER BY name');
    const [locations] = await pool.query('SELECT id, location_name FROM locations ORDER BY location_name');
    const [vendors] = await pool.query('SELECT id, name FROM suppliers WHERE is_active = TRUE ORDER BY name');
    const [customers] = await pool.query('SELECT id, name FROM customers ORDER BY name');
    const [employees] = await pool.query("SELECT id, CONCAT(first_name, ' ', last_name) AS name FROM employees WHERE is_active = TRUE ORDER BY first_name, last_name");
    res.json({ accounts, departments, locations, vendors, customers, employees });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, status, as_of: asOf } = req.query;
    const where = [];
    const params = [];
    if (status) { where.push('j.status = ?'); params.push(status); }
    if (asOf) { where.push('j.date_created <= ?'); params.push(asOf); }
    if (search) { where.push('(j.journal_no LIKE ? OR j.memo LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT j.id, j.journal_no, j.date_created, j.status, j.memo, j.total_debit, j.total_credit
       FROM journals j ${whereSql} ORDER BY j.date_created DESC, j.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[j]] = await pool.query(
      `SELECT j.*, loc.location_name AS location_name,
              CONCAT(cu.display_name) AS created_by_name
       FROM journals j
       LEFT JOIN locations loc ON loc.id = j.location_id
       LEFT JOIN users cu ON cu.id = j.created_by_user_id
       WHERE j.id = ?`,
      [req.params.id]
    );
    if (!j) return res.status(404).json({ error: 'Not found' });
    // The liquidation it posts, if raised from one. A separate lookup so a database without the
    // column yet (db/add-journal-liquidation-link.js) still opens journals.
    if (j.form_request_id) {
      const [[fr]] = await pool.query('SELECT request_no FROM form_requests WHERE id = ?', [j.form_request_id]);
      j.form_request_no = fr ? fr.request_no : null;
    }
    const [lines] = await pool.query(
      `SELECT jl.*, coa.account_code, coa.account_name, d.name AS department_name
       FROM journal_lines jl
       LEFT JOIN chart_of_accounts coa ON coa.id = jl.account_id
       LEFT JOIN departments d ON d.id = jl.department_id
       WHERE jl.journal_id = ? ORDER BY jl.line_no`,
      [req.params.id]
    );
    // gl_lines: what posts -- the lines in pesos when the journal is in another currency.
    res.json({ ...j, lines, gl_lines: journalLinesInPesos(j, lines) });
  } catch (err) { next(err); }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'Journal' AND a.auditable_id = ? ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { date_created: dateCreated, location_id: locationId, currency, conversion, memo, lines } = req.body;
    const rows = (Array.isArray(lines) ? lines : [])
      .filter((l) => l.account_id && (num(l.debit) > 0 || num(l.credit) > 0));
    if (rows.length < 2) return res.status(400).json({ error: 'A journal needs at least two lines with an account and a debit or credit.' });

    const totalDebit = round2(rows.reduce((s, l) => s + num(l.debit), 0));
    const totalCredit = round2(rows.reduce((s, l) => s + num(l.credit), 0));
    if (totalDebit !== totalCredit) return res.status(400).json({ error: `Journal is out of balance: debit ${totalDebit} vs credit ${totalCredit}.` });
    if (totalDebit === 0) return res.status(400).json({ error: 'Enter debit/credit amounts.' });
    const deptError = lineDepartmentError(rows); // every line (2026-10-07), not only budgeted accounts
    if (deptError) return res.status(400).json({ error: deptError });
    await assertPeriodOpen(dateCreated, 'other_gl');
    // Raised from a Liquidation (Create Journal on the form): an approved one that no Vendor Bill or
    // Journal has posted yet (lib/liquidationPosting.js).
    const formRequestId = Number(req.body.form_request_id) || null;
    if (formRequestId) {
      const why = await liquidationPostError(conn, formRequestId);
      if (why) return res.status(409).json({ error: why });
    }

    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO journals (journal_no, date_created, location_id, currency, conversion, memo, status, total_debit, total_credit, created_by_user_id${formRequestId ? ', form_request_id' : ''})
       VALUES ('', ?, ?, ?, ?, ?, 'SAVED', ?, ?, ?${formRequestId ? ', ?' : ''})`,
      [dateCreated || new Date().toISOString().slice(0, 10), locationId || null, trunc(currency, 10), num(conversion) || 1, trunc(memo, 1000), totalDebit, totalCredit, req.user.id,
        ...(formRequestId ? [formRequestId] : [])]
    );
    const journalId = r.insertId;
    const journalNo = await assignDocNo(conn, { table: 'journals', column: 'journal_no', prefix: 'JRNL-', id: journalId });

    let lineNo = 0;
    for (const l of rows) {
      lineNo += 1;
      await conn.query(
        `INSERT INTO journal_lines (journal_id, line_no, account_id, department_id, party_type, party_id, party_name, debit, credit, memo)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [journalId, lineNo, l.account_id, l.department_id || null, trunc(l.party_type, 20), l.party_id || null, trunc(l.party_name, 255),
         round2(l.debit), round2(l.credit), trunc(l.memo, 500)]
      );
    }
    await logAudit(conn, { journalId, userId: req.user.id, eventType: 'Created', fieldName: 'journal_no', newValue: journalNo });
    await conn.commit();
    res.status(201).json({ id: journalId, journal_no: journalNo });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// Edit a saved journal: header (date, location, currency, memo) and its lines, replaced as a set.
// The GL is derived from the journal as it stands (lib/glImpact.js), so nothing needs re-posting.
// Not for a void journal. A REVERSAL (one a void wrote, or the source's) and a journal written for a
// document can be edited, with a warning on screen. Both the old and the new date must be in an
// open period.
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[j]] = await conn.query('SELECT * FROM journals WHERE id = ?', [req.params.id]);
    if (!j) return res.status(404).json({ error: 'Not found' });
    if (String(j.status).toLowerCase() === 'void') return res.status(409).json({ error: 'A voided journal cannot be edited.' });
    // Reversals and system-written journals are editable too (asked 2026-10-07, "edit all") --
    // the screen warns that a reversal then no longer exactly cancels its voided document.
    const { date_created: dateCreated, location_id: locationId, currency, conversion, memo, lines } = req.body;
    const rows = (Array.isArray(lines) ? lines : [])
      .filter((l) => l.account_id && (num(l.debit) > 0 || num(l.credit) > 0));
    if (rows.length < 2) return res.status(400).json({ error: 'A journal needs at least two lines with an account and a debit or credit.' });
    const totalDebit = round2(rows.reduce((s, l) => s + num(l.debit), 0));
    const totalCredit = round2(rows.reduce((s, l) => s + num(l.credit), 0));
    if (totalDebit !== totalCredit) return res.status(400).json({ error: `Journal is out of balance: debit ${totalDebit} vs credit ${totalCredit}.` });
    if (totalDebit === 0) return res.status(400).json({ error: 'Enter debit/credit amounts.' });
    const deptError = lineDepartmentError(rows); // every line (2026-10-07), not only budgeted accounts
    if (deptError) return res.status(400).json({ error: deptError });
    await assertPeriodOpen(j.date_created, 'other_gl', conn);
    if (dateCreated) await assertPeriodOpen(dateCreated, 'other_gl', conn);

    await conn.beginTransaction();
    await conn.query(
      `UPDATE journals SET date_created = ?, location_id = ?, currency = ?, conversion = ?, memo = ?, total_debit = ?, total_credit = ?
        WHERE id = ?`,
      [dateCreated || j.date_created, locationId || null, trunc(currency, 10), num(conversion) || 1, trunc(memo, 1000), totalDebit, totalCredit, j.id]
    );
    await conn.query('DELETE FROM journal_lines WHERE journal_id = ?', [j.id]);
    let lineNo = 0;
    for (const l of rows) {
      lineNo += 1;
      await conn.query(
        `INSERT INTO journal_lines (journal_id, line_no, account_id, department_id, party_type, party_id, party_name, debit, credit, memo)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [j.id, lineNo, l.account_id, l.department_id || null, trunc(l.party_type, 20), l.party_id || null, trunc(l.party_name, 255),
         round2(l.debit), round2(l.credit), trunc(l.memo, 500)]
      );
    }
    const day = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);
    const changes = [
      ['date_created', day(j.date_created), day(dateCreated || j.date_created)],
      ['memo', j.memo || null, memo || null],
      ['total_debit', Number(j.total_debit), totalDebit],
    ].filter(([, a, b]) => String(a ?? '') !== String(b ?? ''));
    if (!changes.length) changes.push(['lines', null, 'edited']);
    for (const [fieldName, oldValue, newValue] of changes) {
      await logAudit(conn, { journalId: j.id, userId: req.user.id, eventType: 'Updated', fieldName, oldValue, newValue });
    }
    await conn.commit();
    res.json({ id: j.id, journal_no: j.journal_no });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.put('/:id/void', requireAuth, requirePermission(ROUTE, 'can_void'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[j]] = await conn.query('SELECT status, date_created FROM journals WHERE id = ?', [req.params.id]);
    if (!j) return res.status(404).json({ error: 'Not found' });
    if (j.status === 'void') return res.status(409).json({ error: 'Already voided.' });
    await assertPeriodOpen(j.date_created, 'other_gl', conn);
    await conn.beginTransaction();
    await conn.query("UPDATE journals SET status = 'void', voided_at = NOW(), voided_by_user_id = ? WHERE id = ?", [req.user.id, req.params.id]);
    await logAudit(conn, { journalId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: j.status, newValue: 'void' });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM journals WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

module.exports = router;
