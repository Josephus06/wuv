const pool = require('../db');

// Who approves a Business Trip (asked 2026-10-21): the requestor's own supervisor(s) -- the
// Supervisors list on the user in Users & Permissions (user_supervisors), active users only, never
// the requestor. It is still noted first by the department head, as before. A requestor with no
// supervisor set falls back to the Forms Approval page's approvers (approvers: []), so no trip is
// left with nobody to approve it. Read fresh each time, so a changed supervisor list is followed.
async function businessTripApprovers(requestorId, q = pool) {
  const [rows] = await q.query(
    `SELECT u.id, u.display_name FROM user_supervisors us JOIN users u ON u.id = us.supervisor_id
      WHERE us.user_id = ? AND u.is_active = 1 AND u.id <> ? ORDER BY u.display_name`,
    [requestorId, requestorId]).catch((e) => { if (e.code === 'ER_NO_SUCH_TABLE') return [[]]; throw e; });
  return rows;
}

module.exports = { businessTripApprovers };
