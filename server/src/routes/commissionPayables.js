const express = require('express');
const pool = require('../db');
const { assignDocNo } = require('../lib/docNumber');
const { requireAuth, requirePermission, userCan } = require('../middleware/auth');
const { assertPeriodOpen } = require('../lib/accountingPeriod');
const { computeCommissionPayableGl, commissionPostingDate } = require('../lib/glImpact');
// The GL posts on the commission month (2026-10-14), so that month has to be open too.
const postingDateOfMonth = (month) => (/^\d{4}-\d{2}$/.test(String(month || '')) ? commissionPostingDate({ period_to: `${month}-01` }) : null);
const { buildCommissionReport } = require('../lib/commissionReport');
const { releaseForPayable } = require('../lib/commissionRelease');
const { liveFiguresByPayable } = require('../lib/commissionPayableStatus');
const { headerDepartmentError } = require('../lib/requireDepartment');

const router = express.Router();
// Commission Payable (CP-####): books a sales employee's earned commission for a commission-month
// range as a payable. Header carries the period totals (Quota / Weighted Sales / JO with Passing
// GP Rate / Expected Commission / Commissionable Amount); one COMMISSIONS line per month, computed
// from the existing Commission report (buildCommissionReport). Posts DR Commission Expense -
// Internal (30611) / CR Commission Payable (24200).
const ROUTE = '/commission-payables';
const EXPENSE_CODE = '30611';
const PAYABLE_CODE = '24200';

const round2 = (n) => Number((Number(n) || 0).toFixed(2));
// Amounts inside error messages, so the user is told the actual shortfall rather than "not allowed".
const money = (n) => round2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// 'YYYY-MM' -> {year, month}. Returns null when malformed.
function parseMonth(s) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const year = Number(m[1]); const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}
// Inclusive list of {year, month} from `from` to `to`.
function monthsInRange(from, to) {
  const a = parseMonth(from); const b = parseMonth(to);
  if (!a || !b) return null;
  const start = a.year * 12 + (a.month - 1); const end = b.year * 12 + (b.month - 1);
  if (end < start) return null;
  const out = [];
  for (let i = start; i <= end; i += 1) out.push({ year: Math.floor(i / 12), month: (i % 12) + 1 });
  return out;
}

async function logAudit(conn, { cpId, userId, eventType, fieldName = null, oldValue = null, newValue = null }) {
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
     VALUES ('CommissionPayable', ?, ?, ?, ?, ?, ?)`,
    [cpId, eventType, fieldName, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), userId]
  );
}

// Core computation shared by the compute preview and by save (so stored values are authoritative,
// not whatever the client posted). Runs the Commission report once per year the range spans and
// pulls each month's row. Returns null when the employee/period is invalid.
async function computePayable(employeeId, from, to) {
  const months = monthsInRange(from, to);
  if (!months) return { error: 'Invalid commission date range.' };

  const [[emp]] = await pool.query(
    `SELECT e.id, CONCAT(e.first_name, ' ', e.last_name) AS name, e.department_id, d.name AS department_name
     FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = ?`,
    [employeeId]
  );
  if (!emp) return { error: 'Employee not found.' };

  const byYear = new Map();
  for (const { year } of months) {
    if (!byYear.has(year)) byYear.set(year, await buildCommissionReport(employeeId, year));
  }

  const lines = [];
  for (const { year, month } of months) {
    const rep = byYear.get(year);
    const row = rep?.rows?.find((r) => r.month === month);
    lines.push({
      line_month: `${year}-${String(month).padStart(2, '0')}-01`,
      quota: round2(row?.quota), weighted: round2(row?.weighted_sales), passing_jos: round2(row?.passing_gp_total),
      expected: round2(row?.expected_commission), confirmed: round2(row?.confirmed_commission),
      released: round2(row?.released_commission), commission: round2(row?.confirmed_commission),
    });
  }
  const totals = lines.reduce((a, l) => ({
    quota: round2(a.quota + l.quota), weighted_sales: round2(a.weighted_sales + l.weighted),
    passing_jos: round2(a.passing_jos + l.passing_jos), expected_commission: round2(a.expected_commission + l.expected),
    commissionable_amount: round2(a.commissionable_amount + l.commission),
  }), { quota: 0, weighted_sales: 0, passing_jos: 0, expected_commission: 0, commissionable_amount: 0 });

  const schemeName = byYear.values().next().value?.scheme_name || null;
  return { employee: { id: emp.id, name: emp.name }, department_id: emp.department_id, department_name: emp.department_name, scheme_name: schemeName, lines, totals };
}

// Employee / department / office location for a payable are resolved server-side from the target
// employee (employee.department_id; the employee's user default_branch_id -> location, else Head
// Office) -- never client-supplied money. Non-admins can only target THEMSELF; a System Admin can
// generate a payable for any sales account.
async function resolveEmployeeContext(employeeId) {
  if (!employeeId) return null;
  const [[e]] = await pool.query(
    `SELECT e.id, CONCAT(e.first_name, ' ', e.last_name) AS name, e.department_id, d.name AS department_name,
            u.default_branch_id, l.location_name AS office_location_name
     FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN users u ON u.employee_id = e.id
     LEFT JOIN locations l ON l.id = u.default_branch_id
     WHERE e.id = ? LIMIT 1`,
    [employeeId]
  );
  if (!e) return null;
  let locId = e.default_branch_id; let locName = e.office_location_name;
  if (!locId) {
    const [[ho]] = await pool.query("SELECT id, location_name FROM locations WHERE location_name = 'Head Office' LIMIT 1");
    locId = ho?.id || null; locName = ho?.location_name || null;
  }
  return {
    employee: { id: e.id, name: e.name },
    department: { id: e.department_id, name: e.department_name },
    office_location: locId ? { id: locId, name: locName } : null,
  };
}

async function getUserMeta(userId) {
  const [[u]] = await pool.query('SELECT account_type, employee_id FROM users WHERE id = ?', [userId]);
  const isAdmin = u?.account_type === 'System Admin';
  // View All on this page (2026-10-17): sees every employee's commission payables, not only their
  // own. Seeing only -- editing someone else's still takes a System Admin.
  const viewAll = isAdmin || await userCan(userId, ROUTE, 'can_view_all');
  return { isAdmin, viewAll, employeeId: u?.employee_id || null };
}

// The employee a compute/save applies to: an admin may target any employee via employee_id;
// everyone else is forced to their own linked employee.
async function targetEmployeeId(userId, requestedId) {
  const meta = await getUserMeta(userId);
  if (meta.isAdmin && requestedId) return Number(requestedId);
  return meta.employeeId;
}

// Prefills the create form. Non-admins get their own locked employee; admins additionally get the
// list of sales accounts they can generate a payable for.
router.get('/my-context', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const meta = await getUserMeta(req.user.id);
    const selfCtx = meta.employeeId ? await resolveEmployeeContext(meta.employeeId) : null;
    const flat = (c) => (c ? { id: c.employee.id, name: c.employee.name, department_name: c.department.name, office_location_name: c.office_location?.name || null } : null);

    let employees = [];
    if (meta.isAdmin) {
      const [rows] = await pool.query(
        `SELECT e.id, CONCAT(e.first_name, ' ', e.last_name) AS name, d.name AS department_name,
                COALESCE(l.location_name, 'Head Office') AS office_location_name
         FROM employees e
         JOIN users u ON u.employee_id = e.id
         LEFT JOIN departments d ON d.id = e.department_id
         LEFT JOIN locations l ON l.id = u.default_branch_id
         WHERE e.is_active = TRUE AND (u.is_account_officer OR u.is_supervisor OR u.is_sales_manager OR u.is_sales_business_unit OR u.is_sales_marketing_director)
         GROUP BY e.id, name, d.name, office_location_name ORDER BY name`
      );
      employees = rows;
    }
    res.json({ is_admin: meta.isAdmin, self: flat(selfCtx), employees });
  } catch (err) { next(err); }
});

// Compute preview for the "Compute Commission" button: the single-month line + totals for the
// target employee, plus their department, office location, and the two GL accounts.
router.get('/compute', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const empId = await targetEmployeeId(req.user.id, req.query.employee_id);
    if (!empId) return res.status(400).json({ error: 'No employee to compute for -- your account is not linked to an employee.' });
    const ctx = await resolveEmployeeContext(empId);
    if (!ctx) return res.status(400).json({ error: 'Employee not found.' });
    const month = req.query.month;
    const result = await computePayable(empId, month, month);
    if (result.error) return res.status(400).json({ error: result.error });

    const [[exp]] = await pool.query('SELECT id, account_code, account_name FROM chart_of_accounts WHERE account_code = ?', [EXPENSE_CODE]);
    const [[pay]] = await pool.query('SELECT id, account_code, account_name FROM chart_of_accounts WHERE account_code = ?', [PAYABLE_CODE]);
    res.json({
      ...result, employee: ctx.employee, department_name: ctx.department.name,
      office_location: ctx.office_location,
      expense_account: exp || null, payable_account: pay || null,
    });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const { search, status } = req.query;
    const where = []; const params = [];
    // Their own commission payables, or everyone's with View All (System Admins have it).
    const meta = await getUserMeta(req.user.id);
    if (!meta.viewAll) { where.push('cp.employee_id = ?'); params.push(meta.employeeId || -1); }
    if (status) { where.push('cp.status = ?'); params.push(status); }
    if (search) { where.push('(cp.commission_payable_no LIKE ? OR CONCAT(e.first_name, " ", e.last_name) LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT cp.id, cp.commission_payable_no, cp.date_created, cp.period_from, cp.period_to,
              cp.expected_commission, cp.commissionable_amount, cp.status,
              CONCAT(e.first_name, ' ', e.last_name) AS employee_name, d.name AS department_name
       FROM commission_payables cp
       LEFT JOIN employees e ON e.id = cp.employee_id
       LEFT JOIN departments d ON d.id = cp.department_id
       ${whereSql} ORDER BY cp.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[cp]] = await pool.query(
      `SELECT cp.*, CONCAT(e.first_name, ' ', e.last_name) AS employee_name, d.name AS department_name,
              loc.location_name AS office_location_name,
              exp.account_code AS expense_account_code, exp.account_name AS expense_account_name,
              pay.account_code AS payable_account_code, pay.account_name AS payable_account_name,
              u.display_name AS created_by_name
       FROM commission_payables cp
       LEFT JOIN employees e ON e.id = cp.employee_id
       LEFT JOIN departments d ON d.id = cp.department_id
       LEFT JOIN locations loc ON loc.id = cp.office_location_id
       LEFT JOIN chart_of_accounts exp ON exp.id = cp.expense_account_id
       LEFT JOIN chart_of_accounts pay ON pay.id = cp.payable_account_id
       LEFT JOIN users u ON u.id = cp.created_by_user_id
       WHERE cp.id = ?`,
      [req.params.id]
    );
    if (!cp) return res.status(404).json({ error: 'Not found' });
    const meta = await getUserMeta(req.user.id);
    if (!meta.viewAll && Number(cp.employee_id) !== Number(meta.employeeId)) {
      return res.status(403).json({ error: 'You can only view your own commission payables.' });
    }
    const [lines] = await pool.query('SELECT * FROM commission_payable_lines WHERE commission_payable_id = ? ORDER BY line_month', [req.params.id]);

    // GL Impact carries the department per row (Accounting on the payable line; the employee's
    // department, or every sales division for a manager, on the expense line).
    // Released = the net commission the (non-void) Commission Vouchers released against this payable
    // (after the deduction/refund waterfall). Commissionable Amount = Confirmed − Released.
    const { released } = await releaseForPayable(req.params.id);
    let vouchers = [];
    const [vtbl] = await pool.query("SHOW TABLES LIKE 'commission_voucher_lines'");
    if (vtbl.length) {
      [vouchers] = await pool.query(
        `SELECT cv.id, cv.voucher_no, cv.date_created, cv.status, cvl.released_amount
         FROM commission_voucher_lines cvl
         JOIN commission_vouchers cv ON cv.id = cvl.commission_voucher_id
         WHERE cvl.commission_payable_id = ? ORDER BY cv.id DESC`,
        [req.params.id]
      );
    }
    const confirmedTotal = round2(lines.reduce((s, l) => s + Number(l.confirmed || 0), 0));
    cp.released_commission = released;
    cp.commissionable_amount = round2(confirmedTotal - released);
    // Reflect on the line(s) so the Commissions tab shows Released and Commission Amount = Confirmed − Released.
    lines.forEach((l) => { l.released = released; l.commission = round2(Number(l.confirmed || 0) - released); });

    const glImpact = await computeCommissionPayableGl(cp);
    // The view needs to know whether this user may edit a settled payable and whether the
    // commission is fully released, so it can offer or withhold the buttons rather than letting
    // the server refuse after the click.
    const mayOverride = await userCan(req.user.id, ROUTE, 'can_approve');
    // Judged on the report's figures, as the status is (lib/commissionPayableStatus.js).
    const live = (await liveFiguresByPayable([cp.id])).get(Number(cp.id));
    const fullyReleased = live
      ? round2(live.released) + 0.005 >= round2(live.expected)
      : round2(released) + 0.005 >= round2(cp.expected_commission);
    res.json({
      ...cp, lines, gl_impact: glImpact, vouchers,
      can_override_edit_lock: mayOverride, fully_released: fullyReleased,
      // Edit (PUT /:id) is the owner's or a System Admin's; View All only lets others see it.
      can_edit_record: meta.isAdmin || Number(cp.employee_id) === Number(meta.employeeId),
    });
  } catch (err) { next(err); }
});

router.get('/:id/audit-logs', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.display_name AS set_by_name FROM audit_logs a LEFT JOIN users u ON u.id = a.set_by_user_id
       WHERE a.auditable_type = 'CommissionPayable' AND a.auditable_id = ? ORDER BY a.set_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { date_created: dateCreated, month, memo, employee_id: requestedEmployeeId } = req.body;

    // Non-admins can only raise a payable for themselves; an admin may target any sales account.
    const empId = await targetEmployeeId(req.user.id, requestedEmployeeId);
    if (!empId) return res.status(400).json({ error: 'No employee to generate for -- your account is not linked to an employee.' });
    const ctx = await resolveEmployeeContext(empId);
    if (!ctx) return res.status(400).json({ error: 'Employee not found.' });

    // Recompute server-side so the stored figures are authoritative.
    const computed = await computePayable(empId, month, month);
    if (computed.error) return res.status(400).json({ error: computed.error });
    // The department is the employee's own (employees.department_id), so that is where to fix it.
    const deptError = headerDepartmentError(computed.department_id, "Department on the employee's record");
    if (deptError) return res.status(400).json({ error: deptError });
    await assertPeriodOpen([dateCreated, postingDateOfMonth(month)], 'other_gl', conn);

    const [[exp]] = await conn.query('SELECT id FROM chart_of_accounts WHERE account_code = ?', [EXPENSE_CODE]);
    const [[pay]] = await conn.query('SELECT id FROM chart_of_accounts WHERE account_code = ?', [PAYABLE_CODE]);
    const t = computed.totals;
    const periodFrom = computed.lines[0].line_month;
    const periodTo = computed.lines[computed.lines.length - 1].line_month;

    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO commission_payables
         (commission_payable_no, date_created, employee_id, office_location_id, department_id, period_from, period_to,
          quota, weighted_sales, passing_jos, expected_commission, commissionable_amount,
          expense_account_id, payable_account_id, memo, status, created_by_user_id)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', ?)`,
      [
        dateCreated || new Date().toISOString().slice(0, 10), ctx.employee.id, ctx.office_location?.id || null, computed.department_id || null,
        periodFrom, periodTo, t.quota, t.weighted_sales, t.passing_jos, t.expected_commission, t.commissionable_amount,
        exp?.id || null, pay?.id || null, memo || null, req.user.id,
      ]
    );
    const cpId = result.insertId;
    const cpNo = await assignDocNo(conn, { table: 'commission_payables', column: 'commission_payable_no', prefix: 'CP-', id: cpId });

    for (const l of computed.lines) {
      await conn.query(
        `INSERT INTO commission_payable_lines (commission_payable_id, line_month, quota, weighted, passing_jos, expected, confirmed, released, commission)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [cpId, l.line_month, l.quota, l.weighted, l.passing_jos, l.expected, l.confirmed, l.released, l.commission]
      );
    }
    await logAudit(conn, { cpId, userId: req.user.id, eventType: 'Created', fieldName: 'commission_payable_no', newValue: cpNo });
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM commission_payables WHERE id = ?', [cpId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally { conn.release(); }
});

// Edit an existing payable: re-pick the commission month / date / memo and recompute. The employee
// is fixed once raised -- retargeting a payable at someone else is a different document, so change
// it by voiding and re-generating.
//
// A payable that has been paid, or that a live Commission Voucher has released against, backs a
// settlement, so recomputing it can strand those released amounts. That is a reason to ask for a
// deliberate decision, not to make the document permanently uneditable: can_approve overrides both
// guards. Without that permission the old behaviour stands -- reopen it or void the voucher first.
router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const cpId = Number(req.params.id);
    const [[existing]] = await conn.query('SELECT * FROM commission_payables WHERE id = ?', [cpId]);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const meta = await getUserMeta(req.user.id);
    if (!meta.isAdmin && Number(existing.employee_id) !== Number(meta.employeeId)) {
      return res.status(403).json({ error: 'You can only edit your own commission payables.' });
    }
    // Void is absolute -- there is no document left to recompute.
    if (existing.status === 'void') return res.status(409).json({ error: 'A void Commission Payable cannot be edited.' });

    const mayOverride = await userCan(req.user.id, ROUTE, 'can_approve');
    if (!mayOverride && (existing.status === 'paid' || round2(existing.amount_paid) > 0)) {
      return res.status(409).json({ error: 'This Commission Payable has been paid -- mark it unpaid before editing.' });
    }
    const [vtbl] = await conn.query("SHOW TABLES LIKE 'commission_voucher_lines'");
    if (vtbl.length && !mayOverride) {
      const [[used]] = await conn.query(
        `SELECT COUNT(*) AS c FROM commission_voucher_lines cvl
         JOIN commission_vouchers cv ON cv.id = cvl.commission_voucher_id
         WHERE cvl.commission_payable_id = ? AND cv.status <> 'void'`,
        [cpId]
      );
      if (used.c > 0) {
        return res.status(409).json({ error: 'A Commission Voucher has already released against this payable -- void that voucher first.' });
      }
    }

    const { date_created: dateCreated, month, memo } = req.body;
    const computed = await computePayable(existing.employee_id, month, month);
    if (computed.error) return res.status(400).json({ error: computed.error });
    // The department is the employee's own (employees.department_id), so that is where to fix it.
    const deptError = headerDepartmentError(computed.department_id, "Department on the employee's record");
    if (deptError) return res.status(400).json({ error: deptError });

    // Both the period it currently sits in and the one it is moving to must be open.
    await assertPeriodOpen([existing.date_created, commissionPostingDate(existing)], 'other_gl', conn);
    await assertPeriodOpen([dateCreated || existing.date_created, postingDateOfMonth(month)], 'other_gl', conn);

    const ctx = await resolveEmployeeContext(existing.employee_id);
    const t = computed.totals;
    const periodFrom = computed.lines[0].line_month;
    const periodTo = computed.lines[computed.lines.length - 1].line_month;

    await conn.beginTransaction();
    await conn.query(
      `UPDATE commission_payables SET date_created = ?, office_location_id = ?, department_id = ?,
              period_from = ?, period_to = ?, quota = ?, weighted_sales = ?, passing_jos = ?,
              expected_commission = ?, commissionable_amount = ?, memo = ?, updated_at = NOW()
       WHERE id = ?`,
      [
        dateCreated || existing.date_created, ctx?.office_location?.id || null, computed.department_id || null,
        periodFrom, periodTo, t.quota, t.weighted_sales, t.passing_jos, t.expected_commission,
        t.commissionable_amount, memo || null, cpId,
      ]
    );
    // Lines are wholly derived from the recomputed month range -- replace rather than reconcile.
    await conn.query('DELETE FROM commission_payable_lines WHERE commission_payable_id = ?', [cpId]);
    for (const l of computed.lines) {
      await conn.query(
        `INSERT INTO commission_payable_lines (commission_payable_id, line_month, quota, weighted, passing_jos, expected, confirmed, released, commission)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [cpId, l.line_month, l.quota, l.weighted, l.passing_jos, l.expected, l.confirmed, l.released, l.commission]
      );
    }
    await logAudit(conn, {
      cpId, userId: req.user.id, eventType: 'Updated', fieldName: 'commissionable_amount',
      oldValue: existing.commissionable_amount, newValue: t.commissionable_amount,
    });
    if (String(existing.period_from) !== String(periodFrom)) {
      await logAudit(conn, { cpId, userId: req.user.id, eventType: 'Updated', fieldName: 'period_from', oldValue: existing.period_from, newValue: periodFrom });
    }
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM commission_payables WHERE id = ?', [cpId]);
    res.json(row);
  } catch (err) {
    await conn.rollback();
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally { conn.release(); }
});

// Mark paid / unpaid.
//
// PAID means the commission has actually been released in full: the Commission Vouchers raised
// against this payable have released at least its Expected Commission. It used to be a plain
// flag anyone could set on an untouched payable, which is how CP-1 came to read PAID with
// 20,240.00 expected against 3,546.43 released -- a settled-looking document that still owed the
// rep 16,693.57.
//
// Marking unpaid is always allowed: it reopens the document, it does not claim anything.
router.put('/:id/pay', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[cp]] = await conn.query('SELECT status, expected_commission, commissionable_amount FROM commission_payables WHERE id = ?', [req.params.id]);
    if (!cp) return res.status(404).json({ error: 'Not found' });
    if (cp.status === 'void') return res.status(409).json({ error: 'This Commission Payable is void.' });
    const makePaid = req.body?.paid !== false;

    if (makePaid) {
      // The month's Expected and Released as the Commission report shows them (live Expected, not
      // the snapshot stored at creation; Released gross of voucher deductions) -- the same test the
      // vouchers use to flip status. Falls back to stored/net when the report can't be built.
      const live = (await liveFiguresByPayable([req.params.id])).get(Number(req.params.id));
      const released = live ? live.released : (await releaseForPayable(req.params.id)).released;
      const expected = round2(live ? live.expected : cp.expected_commission);
      // Half a centavo of tolerance, so a released amount that ties out to the last displayed
      // digit is not rejected over floating-point dust.
      if (round2(released) + 0.005 < expected) {
        return res.status(409).json({
          error: `This Commission Payable cannot be marked paid: ${money(released)} has been released against an Expected Commission of ${money(expected)}. `
            + `Release the remaining ${money(round2(expected - released))} through a Commission Voucher first.`,
        });
      }
    }

    await conn.beginTransaction();
    await conn.query('UPDATE commission_payables SET status = ?, amount_paid = ?, updated_at = NOW() WHERE id = ?',
      [makePaid ? 'paid' : 'unpaid', makePaid ? cp.commissionable_amount : 0, req.params.id]);
    await logAudit(conn, { cpId: req.params.id, userId: req.user.id, eventType: makePaid ? 'Paid' : 'Reopened', fieldName: 'status', oldValue: cp.status, newValue: makePaid ? 'paid' : 'unpaid' });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM commission_payables WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.put('/:id/void', requireAuth, requirePermission(ROUTE, 'can_void'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[cp]] = await conn.query('SELECT status, date_created, period_to FROM commission_payables WHERE id = ?', [req.params.id]);
    if (cp) await assertPeriodOpen([cp.date_created, commissionPostingDate(cp)], 'other_gl', conn);
    if (!cp) return res.status(404).json({ error: 'Not found' });
    if (cp.status === 'void') return res.status(409).json({ error: 'This Commission Payable is already void.' });
    await conn.beginTransaction();
    await conn.query("UPDATE commission_payables SET status = 'void', voided_by_user_id = ?, voided_at = NOW() WHERE id = ?", [req.user.id, req.params.id]);
    await logAudit(conn, { cpId: req.params.id, userId: req.user.id, eventType: 'Cancelled', fieldName: 'status', oldValue: cp.status, newValue: 'void' });
    await conn.commit();
    const [[row]] = await pool.query('SELECT * FROM commission_payables WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

module.exports = router;
