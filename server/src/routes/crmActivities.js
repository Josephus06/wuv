const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission, userCan } = require('../middleware/auth');
const mailer = require('../lib/mailer');
const { buildInvite } = require('../lib/ics');

const router = express.Router();
const RELATED_TYPES = ['Lead', 'Customer', 'Estimate'];
const ACTIVITY_TYPES = ['call', 'email', 'meeting', 'visit', 'note', 'task'];
// Visits and meetings happen at a time and a place; the rest are just logged.
const SCHEDULED_TYPES = ['meeting', 'visit'];

// '2026-09-24T14:30' from a datetime-local input -> '2026-09-24 14:30:00' for MySQL.
function toDateTime(v) {
  if (!v) return null;
  const s = String(v).replace('T', ' ');
  return s.length === 16 ? `${s}:00` : s.slice(0, 19);
}

// crm_activities has no `pages` row of its own -- it's always accessed as a sub-
// resource of a Lead/Customer/Estimate (the CRM pipeline's own unit, since
// server/src/routes/crmPipeline.js replaced the old manually-tracked Opportunity), so
// it reuses whichever of THOSE the caller is already permitted to view/edit (same
// `permRoute`-reuse pattern Item Fulfillment/Quality Inspection use, see
// client/src/components/Layout.jsx:31-32). requireAuth alone is enough here since the
// page-level guard already happened on the parent page.

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { related_type: relatedType, related_id: relatedId } = req.query;
    if (!RELATED_TYPES.includes(relatedType) || !relatedId) {
      return res.status(400).json({ error: 'related_type and related_id are required.' });
    }
    const [rows] = await pool.query(
      `SELECT a.*, u1.display_name AS assigned_to_name, u2.display_name AS created_by_name,
              cc.contact_name
       FROM crm_activities a
       LEFT JOIN users u1 ON u1.id = a.assigned_to_user_id
       LEFT JOIN users u2 ON u2.id = a.created_by_user_id
       LEFT JOIN customer_contacts cc ON cc.id = a.contact_id
       WHERE a.related_type = ? AND a.related_id = ?
       ORDER BY COALESCE(a.starts_at, a.created_at) DESC`,
      [relatedType, relatedId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Powers the "My Tasks" dashboard widget: open (not-yet-done) tasks assigned to the
// logged-in user, across every Lead/Customer/Estimate, soonest due date first.
router.get('/my-tasks', requireAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.* FROM crm_activities a
       WHERE a.activity_type = 'task' AND a.is_done = FALSE AND a.assigned_to_user_id = ?
       ORDER BY (a.due_date IS NULL), a.due_date ASC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Visits and meetings between two dates, for the CRM calendar. `mine=1` narrows to the ones
// assigned to the caller. Unlike the per-record log above this is not reached through a parent
// record, so it takes the CRM Dashboard's permission (the page it is shown on).
router.get('/calendar', requireAuth, requirePermission('/crm-dashboard', 'can_view'), async (req, res, next) => {
  try {
    const { from, to } = req.query;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
      return res.status(400).json({ error: 'from and to (YYYY-MM-DD) are required.' });
    }
    const mine = req.query.mine === '1';
    const [rows] = await pool.query(
      `SELECT a.id, a.related_type, a.related_id, a.activity_type, a.subject, a.starts_at, a.ends_at,
              a.location, a.is_done, a.invite_sent_at, a.assigned_to_user_id,
              u.display_name AS assigned_to_name, cc.contact_name,
              CASE a.related_type WHEN 'Customer' THEN c.name WHEN 'Lead' THEN l.company_name END AS related_name
         FROM crm_activities a
         LEFT JOIN users u ON u.id = a.assigned_to_user_id
         LEFT JOIN customer_contacts cc ON cc.id = a.contact_id
         LEFT JOIN customers c ON a.related_type = 'Customer' AND c.id = a.related_id
         LEFT JOIN leads l ON a.related_type = 'Lead' AND l.id = a.related_id
        WHERE a.activity_type IN ('visit', 'meeting')
          AND a.starts_at >= ? AND a.starts_at < DATE_ADD(?, INTERVAL 1 DAY)
          ${mine ? 'AND a.assigned_to_user_id = ?' : ''}
        ORDER BY a.starts_at`,
      mine ? [from, to, req.user.id] : [from, to],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Email the contact a calendar invitation (.ics) for a visit or meeting. Goes to the contact the
// activity is "with" unless the caller names another address. Needs edit rights on the record the
// activity belongs to, since this writes to a customer on the company's behalf.
const PARENT_ROUTE = { Customer: '/customers', Lead: '/leads', Estimate: '/estimates' };

router.post('/:id/invite', requireAuth, async (req, res, next) => {
  try {
    const [[a]] = await pool.query(
      `SELECT a.*, cc.contact_name, cc.email AS contact_email
         FROM crm_activities a LEFT JOIN customer_contacts cc ON cc.id = a.contact_id
        WHERE a.id = ?`, [req.params.id],
    );
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (!(await userCan(req.user.id, PARENT_ROUTE[a.related_type], 'can_edit'))) {
      return res.status(403).json({ error: 'You do not have permission to do that.' });
    }
    if (!SCHEDULED_TYPES.includes(a.activity_type) || !a.starts_at) {
      return res.status(400).json({ error: 'Only a visit or meeting with a date and time can be sent as an invite.' });
    }
    const to = String(req.body.to || a.contact_email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return res.status(400).json({ error: 'No email address to send the invite to.' });
    }
    if (!mailer.isConfigured()) return res.status(503).json({ error: `Email is not set up on this server -- ${mailer.missingReason()}.` });

    const [[me]] = await pool.query('SELECT display_name, email FROM users WHERE id = ?', [req.user.id]);
    const kind = a.activity_type === 'visit' ? 'Visit' : 'Meeting';
    const ics = buildInvite({
      uid: `crm-activity-${a.id}@erp`,
      // Re-sending after an edit must update the same calendar entry, not add a second one.
      sequence: Math.floor(Date.now() / 1000),
      startsAt: a.starts_at,
      endsAt: a.ends_at,
      summary: `${kind}: ${a.subject}`,
      description: a.description,
      location: a.location,
      organizerName: me.display_name,
      organizerEmail: me.email,
      attendeeName: a.contact_name || to,
      attendeeEmail: to,
    });
    // starts_at is wall-clock with no zone; read it AS UTC and print it in UTC so it comes out
    // exactly as typed whatever timezone this server runs in.
    const when = new Date(`${String(a.starts_at).replace(' ', 'T')}Z`).toLocaleString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
    });
    const esc = (v) => String(v || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    const result = await mailer.send({
      to,
      subject: `${kind}: ${a.subject} — ${when}`,
      fromName: me.display_name,
      replyTo: me.email,
      html: `<p>Hi ${esc(a.contact_name || '')},</p>
        <p>${esc(me.display_name)} has scheduled a ${kind.toLowerCase()} with you.</p>
        <p><strong>${esc(a.subject)}</strong><br>${esc(when)}${a.location ? `<br>${esc(a.location)}` : ''}</p>
        ${a.description ? `<p>${esc(a.description)}</p>` : ''}
        <p>The attached invitation adds it to your calendar.</p>`,
      text: `${me.display_name} has scheduled a ${kind.toLowerCase()} with you.\n\n${a.subject}\n${when}${a.location ? `\n${a.location}` : ''}`,
      attachments: [{ filename: 'invite.ics', content: ics, contentType: 'text/calendar; method=REQUEST; charset=UTF-8' }],
    });
    if (!result.ok) return res.status(502).json({ error: result.error || 'The email could not be sent.' });

    await pool.query('UPDATE crm_activities SET invite_sent_at = NOW() WHERE id = ?', [a.id]);
    res.json({ ok: true, to });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const {
      related_type: relatedType, related_id: relatedId, activity_type: activityType,
      subject, description, due_date: dueDate, assigned_to_user_id: assignedToUserId,
      starts_at: startsAt, ends_at: endsAt, location, contact_id: contactId, outcome, is_done: isDone,
    } = req.body;
    if (!RELATED_TYPES.includes(relatedType) || !relatedId) {
      return res.status(400).json({ error: 'related_type and related_id are required.' });
    }
    if (!ACTIVITY_TYPES.includes(activityType)) return res.status(400).json({ error: 'Invalid activity type.' });
    if (!subject) return res.status(400).json({ error: 'Subject is required.' });
    const scheduled = SCHEDULED_TYPES.includes(activityType);
    if (scheduled && !startsAt) return res.status(400).json({ error: 'A visit or meeting needs a date and time.' });

    // A visit or meeting is either logged after the fact (done) or planned (open until ticked
    // off); the client says which. Other types keep their old behaviour: is_done starts FALSE
    // and only tasks show a Mark Done button.
    const done = scheduled && !!isDone;
    const [result] = await pool.query(
      `INSERT INTO crm_activities
         (related_type, related_id, activity_type, subject, description, due_date, assigned_to_user_id, created_by_user_id,
          starts_at, ends_at, location, contact_id, outcome, is_done, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [relatedType, relatedId, activityType, subject, description || null, dueDate || null,
        assignedToUserId || req.user.id, req.user.id,
        scheduled ? toDateTime(startsAt) : null, scheduled ? toDateTime(endsAt) : null,
        location || null, contactId || null, outcome || null, done, done ? new Date() : null]
    );
    const [[row]] = await pool.query('SELECT * FROM crm_activities WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

// Always expects the full set of editable fields (frontend spreads the existing
// activity and only changes what it's actually editing, e.g. just `is_done` when
// checking off a task) -- avoids ambiguity between "field omitted" and "field cleared"
// that a COALESCE-based partial update would have.
router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const {
      subject, description, due_date: dueDate, is_done: isDone, assigned_to_user_id: assignedToUserId,
      starts_at: startsAt, ends_at: endsAt, location, contact_id: contactId, outcome,
    } = req.body;
    if (!subject) return res.status(400).json({ error: 'Subject is required.' });

    const [[existing]] = await pool.query('SELECT is_done, completed_at FROM crm_activities WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    // Only stamp completed_at on the transition into done, and clear it on the
    // transition back out -- re-saving an already-done activity (e.g. editing its
    // subject) shouldn't bump the completion timestamp to "now".
    let completedAt = existing.completed_at;
    if (!!isDone !== !!existing.is_done) completedAt = isDone ? new Date() : null;

    await pool.query(
      `UPDATE crm_activities SET
         subject = ?, description = ?, due_date = ?,
         is_done = ?, completed_at = ?, assigned_to_user_id = ?,
         starts_at = ?, ends_at = ?, location = ?, contact_id = ?, outcome = ?, updated_at = NOW()
       WHERE id = ?`,
      [subject, description || null, dueDate || null, !!isDone, completedAt, assignedToUserId || null,
        toDateTime(startsAt), toDateTime(endsAt), location || null, contactId || null, outcome || null, req.params.id]
    );
    const [[row]] = await pool.query('SELECT * FROM crm_activities WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM crm_activities WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
