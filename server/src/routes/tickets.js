const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { sendArchived } = require('../lib/localArchive');
const { ticketVisibilityClause, canManageTicket, isGeneralManager } = require('../lib/ticketVisibility');
const { getSbuScope, departmentIdsForTab } = require('../lib/sbuGroups');

const router = express.Router();
const ROUTE = '/tickets';
// Settable through PUT /:id/status. 'declined' is deliberately NOT here: it is reached only by
// an approver refusing the ticket, and putting it in this list would let anyone who can move a
// ticket's status decline it without being an approver and without giving a reason.
const STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
// ...but it is a real stored status, so the list filter has to accept it.
const FILTER_STATUSES = [...STATUSES, 'declined'];

// Every authenticated user needs to be able to list departments to route a ticket or
// (if they're a head) to know which one they manage -- unlike /lookups/departments,
// which is gated behind the Lookups page permission that most non-admin accounts don't
// have. Placed before /:id so Express doesn't treat "meta" as a ticket id.
router.get('/meta/departments', requireAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT id, name, head_user_id FROM departments WHERE is_active = TRUE ORDER BY name');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Same reasoning as /meta/departments -- a department head assigning a ticket needs the
// list of staff to pick from, but most heads don't have the Users & Permissions page
// permission that GET /users requires. Minimal, non-sensitive fields only. A supervisor
// can only assign within their own department, so this is always scoped to one --
// department_id is required, not an optional filter.
// Empty for everyone except an SBU, which is what hides the SBU 1 / SBU 2 tabs from
// everyone else -- their visibility covers one group at most, so a tab strip would just be
// two labels over the same rows.
router.get('/meta/sbu-groups', requireAuth, async (req, res, next) => {
  try {
    const scope = await getSbuScope(req.user.id, { withMarketing: true });
    res.json({ groups: scope ? scope.groups.map((g) => ({ index: g.index, label: g.label, name: g.displayName })) : [] });
  } catch (err) {
    next(err);
  }
});

router.get('/meta/assignable-users', requireAuth, async (req, res, next) => {
  try {
    const { department_id: departmentId } = req.query;
    if (!departmentId) return res.status(400).json({ error: 'department_id is required.' });
    const [rows] = await pool.query(
      `SELECT u.id, u.username, u.display_name FROM users u
       JOIN employees e ON e.id = u.employee_id
       WHERE u.is_active = TRUE AND e.department_id = ?
       ORDER BY u.display_name`,
      [departmentId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Shared by list + detail: approver_names (who's tagged, for display), is_my_approval
// (does the *viewer* need to act), pending derived client-side from
// approver_names && !approved_at. GROUP_CONCAT/EXISTS subqueries instead of a JOIN so
// a ticket with multiple tagged approvers still comes back as one row, not fanned out.
// is_gm tells the client whether to offer the "Forward to GM"/GM-approve controls at
// all, independent of whether THIS ticket has been forwarded yet.
const APPROVAL_SELECT = `
  ab.display_name AS approved_by_name,
  fb.display_name AS forwarded_by_name,
  gb.display_name AS gm_approved_by_name,
  db.display_name AS declined_by_name,
  (SELECT GROUP_CONCAT(u.display_name SEPARATOR ', ') FROM ticket_approvers ta JOIN users u ON u.id = ta.user_id WHERE ta.ticket_id = t.id) AS approver_names,
  EXISTS(SELECT 1 FROM ticket_approvers ta WHERE ta.ticket_id = t.id AND ta.user_id = ?) AS is_my_approval,
  EXISTS(SELECT 1 FROM general_managers gm WHERE gm.user_id = ?) AS is_gm
`;

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { status, department_id: departmentId, sbu } = req.query;
    const { sql: visSql, params: visParams, sbuScope } = await ticketVisibilityClause(req.user.id);
    const where = [visSql];
    const params = [...visParams];
    if (status && FILTER_STATUSES.includes(status)) { where.push('t.status = ?'); params.push(status); }
    if (departmentId) { where.push('t.department_id = ?'); params.push(departmentId); }
    // SBU 1 / SBU 2 tab. Narrows within what the clause above already allows, so it can
    // only ever subtract from this user's visibility, never add to it.
    if (sbu && sbuScope) {
      const ids = departmentIdsForTab(sbuScope, sbu);
      where.push(
        `EXISTS (SELECT 1 FROM users su JOIN employees se ON se.id = su.employee_id
                  WHERE su.id = t.created_by_user_id AND se.department_id IN (${ids.map(() => '?').join(', ')}))`
      );
      params.push(...ids);
    }

    const [rows] = await pool.query(
      `SELECT t.*, d.name AS department_name, cu.display_name AS created_by_name, au.display_name AS assigned_to_name,
              ${APPROVAL_SELECT}
       FROM tickets t
       JOIN departments d ON d.id = t.department_id
       LEFT JOIN users cu ON cu.id = t.created_by_user_id
       LEFT JOIN users au ON au.id = t.assigned_to_user_id
       LEFT JOIN users ab ON ab.id = t.approved_by_user_id
       LEFT JOIN users fb ON fb.id = t.forwarded_by_user_id
       LEFT JOIN users gb ON gb.id = t.gm_approved_by_user_id
       LEFT JOIN users db ON db.id = t.declined_by_user_id
       WHERE ${where.join(' AND ')}
       ORDER BY t.id DESC`,
      [req.user.id, req.user.id, ...params]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { sql: visSql, params: visParams } = await ticketVisibilityClause(req.user.id);
    const [[ticket]] = await pool.query(
      `SELECT t.*, d.name AS department_name, cu.display_name AS created_by_name, au.display_name AS assigned_to_name,
              ${APPROVAL_SELECT}
       FROM tickets t
       JOIN departments d ON d.id = t.department_id
       LEFT JOIN users cu ON cu.id = t.created_by_user_id
       LEFT JOIN users au ON au.id = t.assigned_to_user_id
       LEFT JOIN users ab ON ab.id = t.approved_by_user_id
       LEFT JOIN users fb ON fb.id = t.forwarded_by_user_id
       LEFT JOIN users gb ON gb.id = t.gm_approved_by_user_id
       LEFT JOIN users db ON db.id = t.declined_by_user_id
       WHERE t.id = ? AND ${visSql}`,
      [req.user.id, req.user.id, req.params.id, ...visParams]
    );
    if (!ticket) return res.status(404).json({ error: 'Not found' });

    const [messages] = await pool.query(
      `SELECT m.*, u.display_name AS sender_name FROM ticket_messages m
       LEFT JOIN users u ON u.id = m.sender_user_id
       WHERE m.ticket_id = ? ORDER BY m.created_at ASC`,
      [req.params.id]
    );
    res.json({ ...ticket, messages });
  } catch (err) {
    next(err);
  }
});

// Created by the chat widget once the department + issue have both been collected --
// see server/src/lib/chatbotIntents.js's isTicketTrigger for the flow that leads here.
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { department_id: departmentId, description } = req.body;
    if (!departmentId) return res.status(400).json({ error: 'Select a department.' });
    if (!description || !description.trim()) return res.status(400).json({ error: 'Describe the issue.' });

    const [[dept]] = await pool.query('SELECT id FROM departments WHERE id = ? AND is_active = TRUE', [departmentId]);
    if (!dept) return res.status(400).json({ error: 'Invalid department.' });

    const desc = description.trim();
    const subject = desc.length > 60 ? `${desc.slice(0, 57)}...` : desc;

    // If the creator's own department has one or more rows in
    // department_ticket_approvers (e.g. Sales), those people must sign off before the
    // destination department can act on this ticket -- see the schema.sql comment.
    // Snapshotted into ticket_approvers here rather than re-derived later, so a
    // subsequent change to who approves for that department doesn't retroactively
    // change who's responsible for a ticket already in flight.
    const [creatorDeptApprovers] = await pool.query(
      `SELECT dta.user_id FROM users u
       JOIN employees e ON e.id = u.employee_id
       JOIN departments d ON d.id = e.department_id
       JOIN department_ticket_approvers dta ON dta.department_id = d.id AND dta.can_approve_ticket = 1
       WHERE u.id = ?`,
      [req.user.id]
    );

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `INSERT INTO tickets (ticket_no, department_id, subject, description, status, created_by_user_id)
         VALUES ('', ?, ?, ?, 'open', ?)`,
        [departmentId, subject, desc, req.user.id]
      );
      const ticketId = result.insertId;
      const ticketNo = `TICKET-${ticketId}`;
      await conn.query('UPDATE tickets SET ticket_no = ? WHERE id = ?', [ticketNo, ticketId]);
      await conn.query(
        'INSERT INTO ticket_messages (ticket_id, sender_user_id, message) VALUES (?, ?, ?)',
        [ticketId, req.user.id, desc]
      );
      for (const { user_id: approverUserId } of creatorDeptApprovers) {
        await conn.query('INSERT INTO ticket_approvers (ticket_id, user_id) VALUES (?, ?)', [ticketId, approverUserId]);
        await conn.query(
          `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
           VALUES (?, 'ticket_pending_approval', ?, ?, 'Ticket', ?)`,
          [approverUserId, `${ticketNo} needs your approval`, subject, ticketId]
        );
      }

      // Tell the destination department's head straight away, before any approval. They
      // could already SEE the ticket at this point but were told nothing until it cleared
      // approval, so an unapproved ticket could sit unnoticed -- and when the sender's
      // department has no approvers at all the ticket is immediately assignable, in which
      // case the old 'ticket_ready' notice on approval never fires and the head heard
      // nothing whatsoever. The message says which of the two situations this is.
      const [[destination]] = await conn.query('SELECT head_user_id FROM departments WHERE id = ?', [departmentId]);
      const awaitingApproval = creatorDeptApprovers.length > 0;
      if (destination?.head_user_id && Number(destination.head_user_id) !== Number(req.user.id)) {
        await conn.query(
          `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
           VALUES (?, 'ticket_received', ?, ?, 'Ticket', ?)`,
          [
            destination.head_user_id,
            `${ticketNo} was sent to your department`,
            awaitingApproval
              ? `${subject} -- still awaiting approval from the sender's department.`
              : `${subject} -- ready to assign.`,
            ticketId,
          ]
        );
      }
      await conn.commit();
      const [[row]] = await pool.query('SELECT * FROM tickets WHERE id = ?', [ticketId]);
      res.status(201).json(row);
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    next(err);
  }
});

router.post('/:id/messages', requireAuth, async (req, res, next) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required.' });

    const { sql: visSql, params: visParams } = await ticketVisibilityClause(req.user.id);
    const [[ticket]] = await pool.query(`SELECT id FROM tickets t WHERE t.id = ? AND ${visSql}`, [req.params.id, ...visParams]);
    if (!ticket) return res.status(404).json({ error: 'Not found' });

    const [result] = await pool.query(
      'INSERT INTO ticket_messages (ticket_id, sender_user_id, message) VALUES (?, ?, ?)',
      [req.params.id, req.user.id, message.trim()]
    );
    const [[row]] = await pool.query(
      `SELECT m.*, u.display_name AS sender_name FROM ticket_messages m
       LEFT JOIN users u ON u.id = m.sender_user_id WHERE m.id = ?`,
      [result.insertId]
    );
    await pool.query('UPDATE tickets SET updated_at = NOW() WHERE id = ?', [req.params.id]);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.put('/:id/assign', requireAuth, async (req, res, next) => {
  try {
    const { assigned_to_user_id: assignedToUserId } = req.body;
    const [[ticket]] = await pool.query(
      // ticket_no is read below to name the ticket in the assignment notification; without it
      // the assignee is told "undefined assigned to you".
      'SELECT ticket_no, department_id, approved_at, declined_at, forwarded_to_gm_at, gm_approved_at FROM tickets WHERE id = ?',
      [req.params.id]
    );
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    if (!(await canManageTicket(req.user.id, ticket.department_id))) {
      return res.status(403).json({ error: 'Only this ticket\'s department head can assign it.' });
    }
    if (ticket.declined_at) {
      return res.status(409).json({ error: 'This ticket was declined and cannot be assigned.' });
    }
    const [[{ count: approverCount }]] = await pool.query(
      'SELECT COUNT(*) AS count FROM ticket_approvers WHERE ticket_id = ?', [req.params.id]
    );
    if (approverCount > 0 && !ticket.approved_at) {
      return res.status(409).json({ error: 'This ticket is pending approval and cannot be assigned yet.' });
    }
    if (ticket.forwarded_to_gm_at && !ticket.gm_approved_at) {
      return res.status(409).json({ error: 'This ticket was forwarded to the General Manager and cannot be assigned until approved.' });
    }
    await pool.query(
      "UPDATE tickets SET assigned_to_user_id = ?, assigned_by_user_id = ?, assigned_at = CASE WHEN ? IS NOT NULL THEN NOW() ELSE NULL END, status = IF(status = 'open', 'in_progress', status), updated_at = NOW() WHERE id = ?",
      [assignedToUserId || null, req.user.id, assignedToUserId || null, req.params.id]
    );

    if (assignedToUserId) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
         VALUES (?, 'ticket_assigned', ?, ?, 'Ticket', ?)`,
        [assignedToUserId, `${ticket.ticket_no} assigned to you`, `You have been assigned ticket ${ticket.ticket_no}.`, req.params.id]
      );
    }

    const [[row]] = await pool.query('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// Any ONE of the tagged approvers (ticket_approvers, snapshotted at creation from the
// creator's department -- see POST /) clears this gate for everyone; it's not
// unanimous. Nothing else changes here; assignment/status flow resumes normally once
// approved_at is set.
router.put('/:id/approve', requireAuth, async (req, res, next) => {
  try {
    const [[ticket]] = await pool.query(
      'SELECT approved_at, declined_at, ticket_no, department_id, created_by_user_id FROM tickets WHERE id = ?',
      [req.params.id]
    );
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    if (ticket.approved_at) return res.status(409).json({ error: 'This ticket has already been approved.' });
    if (ticket.declined_at) return res.status(409).json({ error: 'This ticket has been declined and can no longer be approved.' });

    const [[isApprover]] = await pool.query(
      'SELECT 1 AS x FROM ticket_approvers WHERE ticket_id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!isApprover) return res.status(403).json({ error: 'Only this ticket\'s designated approver(s) can approve it.' });

    await pool.query(
      'UPDATE tickets SET approved_by_user_id = ?, approved_at = NOW(), updated_at = NOW() WHERE id = ?',
      [req.user.id, req.params.id]
    );

    // Let the destination department's head know it's actually actionable now --
    // before this they could see it but not assign it.
    const [[dept]] = await pool.query('SELECT head_user_id FROM departments WHERE id = ?', [ticket.department_id]);
    if (dept?.head_user_id) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
         VALUES (?, 'ticket_ready', ?, ?, 'Ticket', ?)`,
        [dept.head_user_id, `${ticket.ticket_no} is approved and ready to work on`, 'Approval cleared -- this ticket can now be assigned.', req.params.id]
      );
    }

    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
       VALUES (?, 'ticket_approved', ?, ?, 'Ticket', ?)`,
      [ticket.created_by_user_id, `${ticket.ticket_no} has been approved`, `Your ticket ${ticket.ticket_no} has been approved.`, req.params.id]
    );

    const [[row]] = await pool.query('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// The other half of an approval: refusing it. Whoever's sign-off is currently outstanding may
// decline -- a tagged approver while the ticket is unapproved, or a General Manager while it sits
// forwarded and un-GM-approved. Both write the same three columns, because the ticket is simply
// declined; which gate it died at is answered by declined_by_user_id.
//
// THE REASON IS REQUIRED. A refusal with no reason tells the requester only that they are not
// getting the thing, which is the part they already know. What they need is whether to fix the
// request and raise it again or drop it, and that is the sentence being demanded here.
//
// Declining is FINAL -- approve/assign/forward/status all refuse afterwards (see their guards).
// The conversation stays open so the requester can ask about it; to pursue the work they raise a
// new ticket. Reopening would erase the record that it was refused, which is the part worth
// keeping.
router.put('/:id/decline', requireAuth, async (req, res, next) => {
  try {
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to decline a ticket.' });
    if (reason.length > 500) return res.status(400).json({ error: 'Keep the reason to 500 characters or fewer.' });

    const [[ticket]] = await pool.query(
      `SELECT ticket_no, subject, department_id, created_by_user_id, approved_at, declined_at,
              forwarded_to_gm_at, forwarded_by_user_id, gm_approved_at
         FROM tickets WHERE id = ?`,
      [req.params.id]
    );
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    if (ticket.declined_at) return res.status(409).json({ error: 'This ticket has already been declined.' });

    const [[isApprover]] = await pool.query(
      'SELECT 1 AS x FROM ticket_approvers WHERE ticket_id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    // Each gate can only be refused while it is actually open: an approver who already approved
    // cannot change their mind after the fact, and the GM's refusal only exists once the ticket
    // has been forwarded to them.
    const mayDeclineAsApprover = !!isApprover && !ticket.approved_at;
    const mayDeclineAsGm = !!ticket.forwarded_to_gm_at && !ticket.gm_approved_at
      && await isGeneralManager(req.user.id);
    if (!mayDeclineAsApprover && !mayDeclineAsGm) {
      return res.status(403).json({ error: 'Only an approver whose sign-off is still outstanding can decline this ticket.' });
    }

    await pool.query(
      `UPDATE tickets SET status = 'declined', declined_by_user_id = ?, declined_at = NOW(),
              decline_reason = ?, updated_at = NOW() WHERE id = ?`,
      [req.user.id, reason, req.params.id]
    );

    // The requester is the one who has been waiting, and the reason is the whole point of
    // telling them -- so it travels in the notification rather than making them open the ticket
    // to find out whether it is worth reworking.
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
       VALUES (?, 'ticket_declined', ?, ?, 'Ticket', ?)`,
      [ticket.created_by_user_id, `${ticket.ticket_no} was declined`, reason, req.params.id]
    );

    // A GM's refusal also goes back to the head who escalated it -- they asked the question and
    // are the one who would otherwise keep waiting on an answer.
    if (mayDeclineAsGm && ticket.forwarded_by_user_id && ticket.forwarded_by_user_id !== ticket.created_by_user_id) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
         VALUES (?, 'ticket_declined', ?, ?, 'Ticket', ?)`,
        [ticket.forwarded_by_user_id, `${ticket.ticket_no} was declined by the General Manager`, reason, req.params.id]
      );
    }

    const [[row]] = await pool.query('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// Second, independent escalation gate on top of the one above -- the department
// head/supervisor (canManageTicket) can forward a not-yet-assigned ticket to the
// General Manager for extra sign-off. Deliberately restricted to before assignment:
// this is about deciding whether to take the ticket on at all, not something to layer
// on afterward.
router.put('/:id/forward-to-gm', requireAuth, async (req, res, next) => {
  try {
    const [[ticket]] = await pool.query(
      'SELECT department_id, assigned_to_user_id, declined_at, forwarded_to_gm_at, ticket_no, subject FROM tickets WHERE id = ?',
      [req.params.id]
    );
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    if (!(await canManageTicket(req.user.id, ticket.department_id))) {
      return res.status(403).json({ error: 'Only this ticket\'s department head can forward it.' });
    }
    if (ticket.declined_at) return res.status(409).json({ error: 'This ticket was declined and cannot be forwarded.' });
    if (ticket.assigned_to_user_id) return res.status(409).json({ error: 'This ticket has already been assigned.' });
    if (ticket.forwarded_to_gm_at) return res.status(409).json({ error: 'This ticket has already been forwarded.' });

    const [gms] = await pool.query('SELECT user_id FROM general_managers');
    if (!gms.length) return res.status(409).json({ error: 'No General Manager is configured yet.' });

    await pool.query(
      'UPDATE tickets SET forwarded_to_gm_at = NOW(), forwarded_by_user_id = ?, updated_at = NOW() WHERE id = ?',
      [req.user.id, req.params.id]
    );
    for (const { user_id: gmUserId } of gms) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
         VALUES (?, 'gm_approval_needed', ?, ?, 'Ticket', ?)`,
        [gmUserId, `${ticket.ticket_no} needs GM approval`, ticket.subject, req.params.id]
      );
    }

    const [[row]] = await pool.query('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// Any ONE tagged General Manager (general_managers -- company-wide, not per-ticket)
// clears this gate. Nothing else changes here; PUT /:id/assign resumes working once
// gm_approved_at is set.
router.put('/:id/gm-approve', requireAuth, async (req, res, next) => {
  try {
    const [[ticket]] = await pool.query(
      'SELECT forwarded_to_gm_at, gm_approved_at, declined_at, forwarded_by_user_id, ticket_no FROM tickets WHERE id = ?',
      [req.params.id]
    );
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    if (!ticket.forwarded_to_gm_at) return res.status(409).json({ error: 'This ticket has not been forwarded to the General Manager.' });
    if (ticket.gm_approved_at) return res.status(409).json({ error: 'This ticket has already been GM-approved.' });
    if (ticket.declined_at) return res.status(409).json({ error: 'This ticket has been declined and can no longer be approved.' });
    if (!(await isGeneralManager(req.user.id))) {
      return res.status(403).json({ error: 'Only a General Manager can approve this.' });
    }

    await pool.query(
      'UPDATE tickets SET gm_approved_by_user_id = ?, gm_approved_at = NOW(), updated_at = NOW() WHERE id = ?',
      [req.user.id, req.params.id]
    );
    if (ticket.forwarded_by_user_id) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
         VALUES (?, 'ticket_ready', ?, ?, 'Ticket', ?)`,
        [ticket.forwarded_by_user_id, `${ticket.ticket_no} was approved by the GM`, 'This ticket can now be assigned.', req.params.id]
      );
    }

    const [[row]] = await pool.query('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.put('/:id/status', requireAuth, async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status.' });

    const [[ticket]] = await pool.query(
      'SELECT department_id, assigned_to_user_id, created_by_user_id, declined_at, ticket_no FROM tickets WHERE id = ?',
      [req.params.id]
    );
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    // A declined ticket is a decision on the record, not a stage. Letting it be moved back to
    // "open" here would quietly undo the refusal and lose the reason with it.
    if (ticket.declined_at) {
      return res.status(409).json({ error: 'This ticket was declined; its status can no longer be changed.' });
    }

    const isAssignee = ticket.assigned_to_user_id === req.user.id;
    if (!isAssignee && !(await canManageTicket(req.user.id, ticket.department_id))) {
      return res.status(403).json({ error: 'You do not have permission to perform this action' });
    }

    const isResolving = status === 'resolved';
    await pool.query(
      'UPDATE tickets SET status = ?, resolved_by_user_id = ?, resolved_at = ?, updated_at = NOW() WHERE id = ?',
      [status, isResolving ? req.user.id : null, isResolving ? new Date() : null, req.params.id]
    );

    // Notify the requester specifically, not the assignee/approver -- they're the one
    // who's been waiting on this and has no other reason to be watching the ticket.
    if (isResolving) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
         VALUES (?, 'ticket_resolved', ?, ?, 'Ticket', ?)`,
        [ticket.created_by_user_id, `${ticket.ticket_no} was resolved`, 'Your ticket has been marked resolved.', req.params.id]
      );
    }

    const [[row]] = await pool.query('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[ticket]] = await conn.query('SELECT department_id FROM tickets WHERE id = ?', [req.params.id]);
    if (!ticket) {
      await conn.rollback();
      return res.status(404).json({ error: 'Not found' });
    }

    await conn.query('DELETE FROM ticket_messages WHERE ticket_id = ?', [req.params.id]);
    await conn.query('DELETE FROM ticket_approvers WHERE ticket_id = ?', [req.params.id]);
    await conn.query('DELETE FROM notifications WHERE related_type = ? AND related_id = ?', ['Ticket', req.params.id]);
    await conn.query('DELETE FROM tickets WHERE id = ?', [req.params.id]);

    await conn.commit();
    res.status(204).send();
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ error: 'This ticket cannot be deleted because it is referenced by other data.' });
    }
    next(err);
  } finally {
    conn.release();
  }
});


// ---------------------------------------------------------------------------------------
// Ticket attachments -- the screenshot or scanned document behind the complaint
// ---------------------------------------------------------------------------------------
//
// A ticket is usually about something the person can see. Uploads are base64 in a JSON body,
// matching /job-orders/:id/attachments -- there is no multipart handler on this server, and
// index.js mounts a larger body parser on this one path to fit them.
//
// The 10MB cap is deliberate: these rows live in the database, so an unbounded upload grows
// the same volume every other write shares.
const MAX_TICKET_UPLOAD_BYTES = 10 * 1024 * 1024;

// Images and PDFs only, and the file's OWN BYTES decide -- not the browser's Content-Type,
// which is attacker-chosen and in any case merely a guess taken from the file extension.
// Renaming payload.exe to shot.png would otherwise be enough to get it into the ticket queue
// for the next person to open.
const MAGIC = [
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },                  // %PDF
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },                        // GIF8
  { mime: 'image/bmp', bytes: [0x42, 0x4d] },                                    // BM
];

// WEBP and HEIC carry their marker after a 4-byte length field rather than at offset 0, so
// they are matched on the container tag instead of a flat prefix.
function sniff(buf) {
  for (const { mime, bytes } of MAGIC) {
    if (buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b)) return mime;
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1)/.test(buf.toString('ascii', 8, 12))) {
    return 'image/heic';
  }
  return null;
}

// Anyone who can see the ticket can attach to it and read what is attached. That is the same
// test the conversation itself uses -- an attachment is part of the conversation, and a
// ticket you may read but whose evidence you may not is of no use to anybody.
async function ticketIVisible(userId, ticketId) {
  const { sql, params } = await ticketVisibilityClause(userId);
  const [[row]] = await pool.query(`SELECT t.id FROM tickets t WHERE t.id = ? AND ${sql}`, [ticketId, ...params]);
  return !!row;
}

// Metadata only -- the blobs would make the ticket view's payload enormous for no benefit.
router.get('/:id/attachments', requireAuth, async (req, res, next) => {
  try {
    if (!(await ticketIVisible(req.user.id, req.params.id))) return res.status(404).json({ error: 'Not found' });
    const [rows] = await pool.query(
      `SELECT a.id, a.file_name, a.mime_type, a.size_bytes, a.created_at, a.archived_at, a.uploaded_by_user_id,
              u.display_name AS uploaded_by_name
         FROM ticket_attachments a
         LEFT JOIN users u ON u.id = a.uploaded_by_user_id
        WHERE a.ticket_id = ?
        ORDER BY a.created_at ASC, a.id ASC`,
      [req.params.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/:id/attachments', requireAuth, async (req, res, next) => {
  try {
    if (!(await ticketIVisible(req.user.id, req.params.id))) return res.status(404).json({ error: 'Not found' });

    const { file_name: fileName, data } = req.body || {};
    if (!fileName || !data) return res.status(400).json({ error: 'file_name and data are required.' });

    // Accepts either a bare base64 string or a full data: URL, since the browser's FileReader
    // hands back the latter.
    const base64 = String(data).includes(',') ? String(data).split(',').pop() : String(data);
    let buf;
    try {
      buf = Buffer.from(base64, 'base64');
    } catch {
      return res.status(400).json({ error: 'data is not valid base64.' });
    }
    if (!buf.length) return res.status(400).json({ error: 'That file is empty.' });
    if (buf.length > MAX_TICKET_UPLOAD_BYTES) {
      return res.status(413).json({ error: `Files must be ${MAX_TICKET_UPLOAD_BYTES / 1024 / 1024}MB or smaller.` });
    }

    // The stored type is the one read off the bytes, never the one the browser claimed, so
    // what gets served back later is what the file actually is.
    const detected = sniff(buf);
    if (!detected) {
      return res.status(415).json({ error: 'Only images (PNG, JPEG, GIF, BMP, WEBP, HEIC) and PDF files can be attached.' });
    }

    const [result] = await pool.query(
      `INSERT INTO ticket_attachments (ticket_id, file_name, mime_type, size_bytes, file_data, uploaded_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.params.id, String(fileName).slice(0, 255), detected, buf.length, buf, req.user.id],
    );
    // Bumped so a ticket with a new attachment sorts as recently active, exactly as a new
    // message does -- otherwise adding the evidence someone asked for leaves the ticket
    // looking untouched.
    await pool.query('UPDATE tickets SET updated_at = NOW() WHERE id = ?', [req.params.id]);

    const [[row]] = await pool.query(
      `SELECT a.id, a.file_name, a.mime_type, a.size_bytes, a.created_at, a.archived_at, a.uploaded_by_user_id,
              u.display_name AS uploaded_by_name
         FROM ticket_attachments a LEFT JOIN users u ON u.id = a.uploaded_by_user_id
        WHERE a.id = ?`,
      [result.insertId],
    );
    res.status(201).json(row);
  } catch (err) { next(err); }
});

router.get('/:id/attachments/:attachmentId/file', requireAuth, async (req, res, next) => {
  try {
    if (!(await ticketIVisible(req.user.id, req.params.id))) return res.status(404).json({ error: 'Not found' });
    const [[row]] = await pool.query(
      'SELECT file_name, mime_type, archive_path, file_data FROM ticket_attachments WHERE id = ? AND ticket_id = ?',
      [req.params.attachmentId, req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    // Moved to the office archive drive (db/archive-attachments.js): served from there.
    if (row.archive_path) return sendArchived(req, res, row);
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    // Only ever images and PDFs get here, both of which the browser renders, so they open in
    // a tab rather than downloading.
    res.setHeader('Content-Disposition', `inline; filename="${String(row.file_name).replace(/"/g, '')}"`);
    // The type was decided from the file's own bytes on upload, but nosniff costs nothing and
    // stops a browser second-guessing it.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(row.file_data);
  } catch (err) { next(err); }
});

// The person who attached it can take it back -- a wrong screenshot is a mistake anyone can
// make, and having to ask an admin to undo it is out of proportion. A System Admin can remove
// any of them. Nobody else can, including the person the ticket is assigned to: evidence
// someone else attached is not theirs to delete.
router.delete('/:id/attachments/:attachmentId', requireAuth, async (req, res, next) => {
  try {
    if (!(await ticketIVisible(req.user.id, req.params.id))) return res.status(404).json({ error: 'Not found' });
    const [[row]] = await pool.query(
      'SELECT uploaded_by_user_id FROM ticket_attachments WHERE id = ? AND ticket_id = ?',
      [req.params.attachmentId, req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'Not found' });

    const [[me]] = await pool.query('SELECT account_type FROM users WHERE id = ?', [req.user.id]);
    const mine = String(row.uploaded_by_user_id) === String(req.user.id);
    if (!mine && me?.account_type !== 'System Admin') {
      return res.status(403).json({ error: 'Only the person who attached this file, or a System Admin, can remove it.' });
    }

    const [r] = await pool.query('DELETE FROM ticket_attachments WHERE id = ? AND ticket_id = ?',
      [req.params.attachmentId, req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
