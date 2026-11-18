const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { PRIORITIES, DEFAULT_VISIT_EVERY_DAYS, visitEveryDays, businessToday } = require('../lib/crmCadence');
const { refreshAttention, crmAttentionJobEnabled, daysToBirthday } = require('../lib/crmAttention');
const { getSalesRepEmployeeScope } = require('../lib/salesVisibility');

const router = express.Router();

// The customer's CRM profile -- priority, tags, visit cadence, and the dates derived from the
// activity log and sales orders. No pages row of its own: it is part of the customer, so it
// borrows /customers' permissions (view to read, edit to change), same as the contacts and
// addresses sub-resources in routes/customers.js.
const ROUTE = '/customers';

// The next occurrence of a birthday on or after today (business clock), as YYYY-MM-DD. Feb 29
// falls on Feb 28 in a non-leap year rather than skipping to Mar 1, so the greeting isn't late.
function nextBirthday(birthday, asOf = businessToday()) {
  if (!birthday) return null;
  const next = daysToBirthday(birthday, asOf);
  return next ? next.date : null;
}

function addDays(dateStr, days) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

router.get('/meta', requireAuth, (req, res) => {
  res.json({ priorities: PRIORITIES, defaultVisitEveryDays: DEFAULT_VISIT_EVERY_DAYS });
});

router.get('/tags', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT t.*, (SELECT COUNT(*) FROM customer_tags ct WHERE ct.tag_id = t.id) AS customer_count
         FROM crm_tags t ORDER BY t.name`,
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/tags', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Tag name is required.' });
    const [result] = await pool.query('INSERT INTO crm_tags (name, color) VALUES (?, ?)', [name, req.body.color || null]);
    const [[row]] = await pool.query('SELECT * FROM crm_tags WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A tag with that name already exists.' });
    next(err);
  }
});

router.get('/customers/:id/profile', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const customerId = req.params.id;
    const [[customer]] = await pool.query(
      'SELECT id, crm_priority, visit_every_days FROM customers WHERE id = ?', [customerId],
    );
    if (!customer) return res.status(404).json({ error: 'Not found' });

    const [tags] = await pool.query(
      `SELECT t.id, t.name, t.color FROM customer_tags ct JOIN crm_tags t ON t.id = ct.tag_id
        WHERE ct.customer_id = ? ORDER BY t.name`, [customerId],
    );
    // A visit counts once it is done; when it happened is its start time, falling back to when
    // it was ticked off for visits logged without one.
    const [[lastVisit]] = await pool.query(
      `SELECT id, subject, COALESCE(starts_at, completed_at, created_at) AS visited_at
         FROM crm_activities
        WHERE activity_type = 'visit' AND related_type = 'Customer' AND related_id = ? AND is_done = TRUE
        ORDER BY visited_at DESC LIMIT 1`, [customerId],
    );
    const [[nextScheduled]] = await pool.query(
      `SELECT id, activity_type, subject, starts_at, location
         FROM crm_activities
        WHERE activity_type IN ('visit', 'meeting') AND related_type = 'Customer' AND related_id = ?
          AND is_done = FALSE AND starts_at >= CURDATE()
        ORDER BY starts_at LIMIT 1`, [customerId],
    );
    const [[lastOrder]] = await pool.query(
      'SELECT MAX(date_created) AS last_order_date FROM sales_orders WHERE customer_id = ?', [customerId],
    );
    const [contacts] = await pool.query(
      'SELECT id, contact_name, birthday FROM customer_contacts WHERE customer_id = ? AND birthday IS NOT NULL',
      [customerId],
    );

    const cadence = visitEveryDays(customer.crm_priority, customer.visit_every_days);
    const lastVisitDate = lastVisit ? String(lastVisit.visited_at).slice(0, 10) : null;
    const upcomingBirthdays = contacts
      .map((c) => ({ contact_id: c.id, contact_name: c.contact_name, birthday: c.birthday, next: nextBirthday(c.birthday) }))
      .sort((a, b) => a.next.localeCompare(b.next));

    res.json({
      customer_id: customer.id,
      crm_priority: customer.crm_priority,
      visit_every_days: customer.visit_every_days,
      effective_visit_every_days: cadence,
      tags,
      last_visit: lastVisit || null,
      visit_due_on: lastVisitDate ? addDays(lastVisitDate, cadence) : null,
      next_scheduled: nextScheduled || null,
      last_order_date: lastOrder.last_order_date,
      upcoming_birthdays: upcomingBirthdays,
    });
  } catch (err) {
    next(err);
  }
});

router.put('/customers/:id/profile', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const { crm_priority: priority, visit_every_days: everyDays, tag_ids: tagIds } = req.body;
  if (!PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Priority must be high, normal or low.' });
  const every = everyDays === '' || everyDays == null ? null : Number(everyDays);
  if (every !== null && !(Number.isInteger(every) && every > 0 && every <= 3650)) {
    return res.status(400).json({ error: 'Visit every must be a whole number of days.' });
  }
  if (!Array.isArray(tagIds)) return res.status(400).json({ error: 'tag_ids must be a list.' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      'UPDATE customers SET crm_priority = ?, visit_every_days = ?, updated_at = NOW() WHERE id = ?',
      [priority, every, req.params.id],
    );
    if (!result.affectedRows) {
      await conn.rollback();
      return res.status(404).json({ error: 'Not found' });
    }
    await conn.query('DELETE FROM customer_tags WHERE customer_id = ?', [req.params.id]);
    const ids = [...new Set(tagIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (ids.length) {
      await conn.query(
        `INSERT INTO customer_tags (customer_id, tag_id)
         SELECT ?, id FROM crm_tags WHERE id IN (?)`, [req.params.id, ids],
      );
    }
    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// --- Needs Attention ---------------------------------------------------------------------------
// The ranked list from lib/crmAttention.js's nightly snapshot. Lives under the CRM Dashboard's
// permission (that page is where it is shown), and narrows rows the same way Estimates and Sales
// Orders do: a rep sees the customers whose latest order was theirs (or their people's / the
// branches', per lib/salesVisibility.js).
const DASHBOARD = '/crm-dashboard';

router.get('/attention', requireAuth, requirePermission(DASHBOARD, 'can_view'), async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const scope = await getSalesRepEmployeeScope(req.user.id, ROUTE);
    const [[me]] = await pool.query('SELECT employee_id FROM users WHERE id = ?', [req.user.id]);

    const where = [];
    const params = [];
    if (scope) {
      where.push('a.owner_employee_id IN (?)');
      params.push(scope.length ? scope : [0]);
    }
    if (req.query.owner === 'mine') {
      where.push('a.owner_employee_id = ?');
      params.push(me?.employee_id || 0);
    } else if (req.query.owner) {
      where.push('a.owner_employee_id = ?');
      params.push(Number(req.query.owner));
    }
    if (PRIORITIES.includes(req.query.priority)) {
      where.push('c.crm_priority = ?');
      params.push(req.query.priority);
    }
    if (req.query.reason) {
      where.push("JSON_SEARCH(a.reasons, 'one', ?, NULL, '$[*].code') IS NOT NULL");
      params.push(String(req.query.reason));
    }
    if (req.query.q) {
      where.push('(c.name LIKE ? OR c.customer_code LIKE ?)');
      params.push(`%${req.query.q}%`, `%${req.query.q}%`);
    }
    if (req.query.snoozed !== '1') where.push('(s.snoozed_until IS NULL OR s.snoozed_until < CURDATE())');
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const from = `FROM crm_attention a
      JOIN customers c ON c.id = a.customer_id
      LEFT JOIN crm_attention_snoozes s ON s.customer_id = a.customer_id`;

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} ${whereSql}`, params);
    const [rows] = await pool.query(
      `SELECT a.*, c.name AS customer_name, c.customer_code, c.crm_priority, s.snoozed_until,
              TRIM(CONCAT(COALESCE(e.first_name, ''), ' ', COALESCE(e.last_name, ''))) AS owner_name
         ${from}
         LEFT JOIN employees e ON e.id = a.owner_employee_id
         ${whereSql}
        ORDER BY a.score DESC, a.customer_id
        LIMIT ? OFFSET ?`, [...params, limit, offset],
    );
    // Owners the caller can filter by: the ones whose customers they can see at all.
    const [owners] = await pool.query(
      `SELECT a.owner_employee_id AS id, TRIM(CONCAT(COALESCE(e.first_name, ''), ' ', COALESCE(e.last_name, ''))) AS name,
              COUNT(*) AS n
         FROM crm_attention a LEFT JOIN employees e ON e.id = a.owner_employee_id
        WHERE a.owner_employee_id IS NOT NULL ${scope ? 'AND a.owner_employee_id IN (?)' : ''}
        GROUP BY a.owner_employee_id, e.first_name, e.last_name ORDER BY name`,
      scope ? [scope.length ? scope : [0]] : [],
    );
    const [[meta]] = await pool.query('SELECT MAX(computed_at) AS computed_at FROM crm_attention');

    res.json({
      computed_at: meta.computed_at,
      refreshable: crmAttentionJobEnabled(),
      total,
      my_employee_id: me?.employee_id || null,
      owners,
      rows: rows.map((r) => ({ ...r, reasons: typeof r.reasons === 'string' ? JSON.parse(r.reasons) : r.reasons })),
    });
  } catch (err) {
    next(err);
  }
});

// Rebuild the snapshot now rather than waiting for the night run. A few seconds of work, so it
// is kept behind edit rights and shares one run between simultaneous clicks. Only on the server
// that owns the job (CRM_ATTENTION_JOB=1) -- see the replication note in index.js.
let refreshing = null;
router.post('/attention/refresh', requireAuth, requirePermission(DASHBOARD, 'can_edit'), async (req, res, next) => {
  try {
    if (!crmAttentionJobEnabled()) {
      return res.status(409).json({ error: 'The list is rebuilt on another server and copied here; it cannot be refreshed from this one.' });
    }
    if (!refreshing) refreshing = refreshAttention().finally(() => { refreshing = null; });
    res.json(await refreshing);
  } catch (err) {
    next(err);
  }
});

router.post('/attention/:customerId/snooze', requireAuth, requirePermission(DASHBOARD, 'can_view'), async (req, res, next) => {
  try {
    const days = Number(req.body.days);
    if (!Number.isInteger(days) || days < 1 || days > 365) return res.status(400).json({ error: 'Snooze for 1 to 365 days.' });
    await pool.query(
      `INSERT INTO crm_attention_snoozes (customer_id, snoozed_until, snoozed_by_user_id)
       VALUES (?, DATE_ADD(CURDATE(), INTERVAL ? DAY), ?)
       ON DUPLICATE KEY UPDATE snoozed_until = VALUES(snoozed_until), snoozed_by_user_id = VALUES(snoozed_by_user_id)`,
      [req.params.customerId, days, req.user.id],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/attention/:customerId/snooze', requireAuth, requirePermission(DASHBOARD, 'can_view'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM crm_attention_snoozes WHERE customer_id = ?', [req.params.customerId]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.nextBirthday = nextBirthday;
