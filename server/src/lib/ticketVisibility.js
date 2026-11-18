const pool = require('../db');
const { getSbuScope } = require('./sbuGroups');

// Resolves a user's ticket-ops role, mirroring designSupervisorVisibility.js's own
// shape/discipline (checked fresh against the DB on every request, not trusted off the
// JWT -- a department's head_user_id can change after a token was issued).
//
// Returns:
//   { isSystemAdminHead: true, headOfDepartmentIds: [...] } -- the System Admin
//     department's head: org-wide oversight, sees/assigns every ticket regardless of
//     department (the "System Admin Supervisor" role).
//   { isSystemAdminHead: false, headOfDepartmentIds: [id, ...] } -- head of one or more
//     *other* departments (a department can in principle share a head with another,
//     e.g. small teams) -- sees/assigns only tickets in those departments.
//   { isSystemAdminHead: false, headOfDepartmentIds: [] } -- a regular user: sees only
//     tickets they created or are personally assigned to.
async function resolveTicketRole(userId) {
  const [rows] = await pool.query(
    `SELECT d.id, d.name FROM departments d WHERE d.head_user_id = ? AND d.is_active = TRUE`,
    [userId]
  );
  const isSystemAdminHead = rows.some((d) => d.name === 'System Admin');
  return { isSystemAdminHead, headOfDepartmentIds: rows.map((d) => d.id) };
}

// Builds the WHERE-clause fragment + params restricting a tickets query to what this
// user is allowed to see -- used identically by the list and detail routes so
// visibility can't drift between "what shows in the list" and "what a direct link to
// an id will load".
async function ticketVisibilityClause(userId) {
  const role = await resolveTicketRole(userId);
  if (role.isSystemAdminHead) return { sql: '1=1', params: [], role };

  // Anyone tagged as one of this ticket's approvers (ticket_approvers, snapshotted from
  // department_ticket_approvers at creation) needs to see it regardless of whether
  // they're also the creator, assignee, or a department head, since approval can be
  // gated on someone outside all of those. Same reasoning for a General Manager once a
  // ticket's been forwarded to them -- general_managers is company-wide, not scoped to
  // one department, so any GM can see any forwarded ticket regardless of where it
  // originally routed.
  const clauses = [
    't.created_by_user_id = ?', 't.assigned_to_user_id = ?',
    'EXISTS (SELECT 1 FROM ticket_approvers ta WHERE ta.ticket_id = t.id AND ta.user_id = ?)',
    "(t.forwarded_to_gm_at IS NOT NULL AND EXISTS (SELECT 1 FROM general_managers gm WHERE gm.user_id = ?))",
  ];
  const params = [userId, userId, userId, userId];
  if (role.headOfDepartmentIds.length) {
    clauses.push(`t.department_id IN (${role.headOfDepartmentIds.map(() => '?').join(', ')})`);
    params.push(...role.headOfDepartmentIds);
  }

  // An SBU sees tickets raised from BOTH SBU groups, plus Marketing, matched on the
  // raiser's department. Being tagged as approver already covers the group they approve,
  // but after the cross-approval swap that is the OTHER group -- without this an SBU would
  // lose sight of their own people's tickets entirely. Grouped by who raised it, not which
  // department it was sent to: a Sales - 1 ticket is SBU 1's whether it goes to Accounting
  // or Design.
  //
  // Marketing owns no SBU -- nobody holds it as a sales group -- so its tickets would
  // otherwise be visible to no SBU at all. Both cover it jointly, the same arrangement
  // non-standard job orders already use, which is why it is a third tab rather than being
  // folded into one of theirs: either can act on it, and neither is made to own it.
  const sbuScope = await getSbuScope(userId, { withMarketing: true });
  if (sbuScope) {
    clauses.push(
      `EXISTS (SELECT 1 FROM users su JOIN employees se ON se.id = su.employee_id
                WHERE su.id = t.created_by_user_id
                  AND se.department_id IN (${sbuScope.departmentIds.map(() => '?').join(', ')}))`
    );
    params.push(...sbuScope.departmentIds);
  }
  return { sql: `(${clauses.join(' OR ')})`, params, role, sbuScope };
}

// Can this user assign/reassign this specific ticket? Either the System Admin
// department's head (org-wide), or the head of the ticket's own department.
async function canManageTicket(userId, departmentId) {
  const role = await resolveTicketRole(userId);
  if (role.isSystemAdminHead) return true;
  return role.headOfDepartmentIds.includes(departmentId);
}

async function isGeneralManager(userId) {
  const [[row]] = await pool.query('SELECT 1 AS x FROM general_managers WHERE user_id = ?', [userId]);
  return !!row;
}

module.exports = { resolveTicketRole, ticketVisibilityClause, canManageTicket, isGeneralManager };
