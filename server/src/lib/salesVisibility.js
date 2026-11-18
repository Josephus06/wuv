const pool = require('../db');
const { userCan } = require('../middleware/auth');
const { isHeadOfficeName } = require('./userLocation');

// Sales-rep-scoped visibility for Estimates/Sales Orders: an Account Officer only ever
// sees their own transactions; a Supervisor sees their own plus everyone who reports to
// them (user_supervisors, one level -- "his or her people"), matching the
// account_type/is_account_officer/is_supervisor fields already on `users`. A rep with two
// supervisors is visible to both.
// Checked fresh against the DB on every call rather than trusted off the JWT, same
// discipline as the estimate-approval permission check -- these flags can change after
// the token was issued.
//
// Returns:
//   null                -> unrestricted (System Admin, or a role that's neither an
//                           Account Officer nor a Supervisor -- no visibility rule
//                           applies to them, so don't touch behavior for those accounts).
//   number[]             -> the employee ids whose transactions this user may see
//                           (their own, plus direct reports' if they're a supervisor),
//                           OR -- outside Head Office -- every branch person's.
//
// OUTSIDE HEAD OFFICE THE RULE IS THE BRANCHES, NOT THE PERSON. A user whose default login
// location is not Head Office sees every non-Head-Office person's transactions, not just their
// own: the branches work one another's jobs, cover for each other and answer the same walk-in
// customers, so scoping a branch account to its own name left the person standing in the shop
// unable to open the transaction the customer was asking about. What they still do not see is
// Head Office's own work. Permissions decide what they may DO with what they can see -- this
// answers only which rows exist for them, and an action they hold the right for works on a
// branch transaction whether or not it is theirs.
//
// NOT THE OFFICE LOCATION STAMPED ON THE DOCUMENT. That column says Head Office on all but a
// handful of rows -- all 29,081 estimates belonging to the seven branch accounts included --
// so reading the rule off the stamp would hide a branch user's OWN work from them. Whose
// transaction it is, is the sales rep behind it, and where THAT person logs in is the answer.
//
// It only ever widens. Anyone unrestricted today stays unrestricted (the early returns below
// come first), and the branch pool is unioned with the old own-plus-reports set rather than
// replacing it -- a branch supervisor with a Head Office report keeps seeing that report's
// work, which a straight replacement would quietly have taken away. Every one of the six
// reports on file is a branch user today, so the union is a no-op now; it is there so the
// first cross-location report does not silently narrow somebody's list.
// WHO SEES WHAT (asked 2026-10-08):
//   - can_view_all ticked on the page (`route`) -> everything, whatever their role. Jocelyn Ybanez
//     is an Account Officer; ticking View All on Estimates for her shows her every estimate.
//   - SBU or Supervisor -> their own plus EVERYONE under them, all the way down the
//     user_supervisors chain (an SBU's supervisors' reps included), not just direct reports.
//   - Account Officer -> their own only.
// The branch pool below still applies on top of these.
async function getSalesRepEmployeeScope(userId, route = null) {
  const [[user]] = await pool.query(
    'SELECT account_type, is_account_officer, is_supervisor, is_sales_business_unit, employee_id FROM users WHERE id = ?',
    [userId]
  );
  if (!user || !user.employee_id) return null;
  if (user.account_type === 'System Admin') return null;
  if (route && await userCan(userId, route, 'can_view_all')) return null;
  const isSbu = !!user.is_sales_business_unit;
  if (!user.is_account_officer && !user.is_supervisor && !isSbu) return null;

  const ids = [user.employee_id];

  // Everyone's home location in one pass, rather than a query per user. The COALESCE is the same
  // one resolveDefaultLocation uses -- the Default Login Location wins, the older Default Branch
  // field is the fallback -- so this classifies each user exactly as isHeadOfficeUser would.
  //
  // Read fresh, like everything else here: moving someone's default login location has to take
  // effect on their next request, not at their next login.
  const [people] = await pool.query(
    `SELECT u.id, u.employee_id,
            COALESCE(
              (SELECT l.location_name FROM user_branches ub JOIN locations l ON l.id = ub.location_id
                WHERE ub.user_id = u.id AND ub.is_default = TRUE LIMIT 1),
              (SELECT l.location_name FROM locations l WHERE l.id = u.default_branch_id)
            ) AS location_name
       FROM users u`
  );
  // Judged in JS by isHeadOfficeName rather than by a LIKE in the SQL, so "is this Head Office"
  // has exactly one definition. A second copy in a WHERE clause is the kind that drifts.
  const atHeadOffice = (row) => isHeadOfficeName(row?.location_name);

  if (!atHeadOffice(people.find((r) => Number(r.id) === Number(userId)))) {
    people.filter((r) => r.employee_id && !atHeadOffice(r)).forEach((r) => ids.push(r.employee_id));
  }

  if (user.is_supervisor || isSbu) {
    // Read from user_supervisors, not users.supervisor_id: a rep may report to several
    // supervisors, and the column only holds the primary -- using it would hide every
    // secondary report's transactions from the supervisor who also owns them.
    // Walked level by level so a supervisor's supervisor (an SBU) sees the whole tree.
    const [links] = await pool.query(
      `SELECT us.supervisor_id, us.user_id, u.employee_id
         FROM user_supervisors us JOIN users u ON u.id = us.user_id`
    );
    const seen = new Set([Number(userId)]);
    let frontier = [Number(userId)];
    while (frontier.length) {
      const next = [];
      for (const l of links) {
        if (!frontier.includes(Number(l.supervisor_id)) || seen.has(Number(l.user_id))) continue;
        seen.add(Number(l.user_id));
        next.push(Number(l.user_id));
        if (l.employee_id) ids.push(l.employee_id);
      }
      frontier = next;
    }
  }
  // Deduped because the three sources overlap -- a branch supervisor is in the pool, and so are
  // their branch reports.
  return [...new Set(ids)];
}

// Is this user the given sales rep, or one of that rep's supervisors (user_supervisors)? A
// supervisor may act on a report's job order as the rep could -- Forward to Design Supervisor,
// edit it before Production, answer a revision (asked 2026-10-03: Ronel Parenno for Jocelyn Ybanez).
async function isRepOrSupervisorOf(userId, salesRepEmployeeId) {
  if (!salesRepEmployeeId) return false;
  const [[me]] = await pool.query('SELECT employee_id FROM users WHERE id = ?', [userId]);
  if (me?.employee_id && String(me.employee_id) === String(salesRepEmployeeId)) return true;
  const [[sup]] = await pool.query(
    `SELECT 1 AS ok FROM user_supervisors us JOIN users u ON u.id = us.user_id
      WHERE us.supervisor_id = ? AND u.employee_id = ? LIMIT 1`,
    [userId, salesRepEmployeeId],
  );
  return !!sup;
}

// The employee ids of everyone who reports to this user -- sent on /auth/me so the pages can draw
// the same buttons isRepOrSupervisorOf allows.
async function reportEmployeeIds(userId) {
  const [rows] = await pool.query(
    `SELECT DISTINCT u.employee_id FROM user_supervisors us JOIN users u ON u.id = us.user_id
      WHERE us.supervisor_id = ? AND u.employee_id IS NOT NULL`,
    [userId],
  );
  return rows.map((r) => r.employee_id);
}

// Is this user above the given user in user_supervisors -- a direct supervisor, or the supervisor's
// supervisor and on up (the "head" of whoever raised a document)? Walked upward from the subject,
// each user once, so a loop in the graph cannot spin forever.
async function isAboveInChain(userId, subjectUserId) {
  if (!userId || !subjectUserId) return false;
  const seen = new Set([Number(subjectUserId)]);
  let level = [Number(subjectUserId)];
  while (level.length) {
    const [rows] = await pool.query('SELECT DISTINCT supervisor_id FROM user_supervisors WHERE user_id IN (?)', [level]);
    const next = rows.map((r) => Number(r.supervisor_id)).filter((id) => !seen.has(id));
    if (next.includes(Number(userId))) return true;
    next.forEach((id) => seen.add(id));
    level = next;
  }
  return false;
}

// The users a user reports to directly (user_supervisors), active ones only.
async function directSupervisorIds(userId) {
  const [rows] = await pool.query(
    'SELECT us.supervisor_id AS id FROM user_supervisors us JOIN users u ON u.id = us.supervisor_id WHERE us.user_id = ? AND u.is_active = TRUE',
    [userId],
  );
  return rows.map((r) => r.id);
}

module.exports = { getSalesRepEmployeeScope, isRepOrSupervisorOf, reportEmployeeIds, isAboveInChain, directSupervisorIds };
