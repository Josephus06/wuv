const pool = require('../db');

// The two SBU groups, resolved from data rather than hardcoded ids, so adding a third SBU
// or moving a division between them is a configuration change and not a code change.
//
// THE ID TRAP THIS EXISTS TO ABSORB. Ownership lives in user_sales_divisions, which points
// at `sales_divisions`; the documents point at `departments`
// (non_standard_job_orders.sales_division_id is a DEPARTMENT id, despite the column name,
// and a ticket's group comes from its creator's employees.department_id). The two tables
// number the same team differently -- id 5 is department "Sales - 1" but sales_division
// "Sales - 2" -- so the join can only be made on the name, and the names disagree on
// spacing ("Sales-1" vs "Sales - 1"). Everything is matched on a normalised key instead;
// the chatbot already treats division names this way for the same reason.
const norm = (s) => String(s || '').toLowerCase().replace(/[\s_-]+/g, '');

// Only the numbered sales groups form an SBU group: "Sales - 1" through "Sales - 4"
// normalise to sales1..sales4. Support, Marketing, the branches and the unnumbered "Sales"
// department are deliberately not groups -- there are exactly two SBUs, covering sales
// groups 1+3 and 2+4, and a user who owns only a non-sales division (Marketing has the SBU
// flag set for commission purposes) is not an SBU group owner.
const isSalesGroup = (departmentName) => /^sales\d+$/.test(norm(departmentName));

// Groups are numbered by the lowest department id they own, which is what makes Michelle's
// group (Sales - 1, Sales - 3) "SBU 1" and Arlene's (Sales - 2, Sales - 4) "SBU 2" --
// the numbering users already use for them.
async function getSbuGroups() {
  // A System Admin account carrying the SBU flag is not a real SBU group -- on the live
  // database the admin account has it set and owns EVERY division, which would both take
  // the "SBU 1" label off the actual first SBU and, because a group's scope is the union of
  // all groups, silently widen every SBU's view to every division in the company. An admin
  // already sees everything through their own scope, so excluding them costs nothing.
  const [owners] = await pool.query(
    `SELECT u.id AS user_id, u.display_name, sd.name AS division_name
       FROM users u
       JOIN user_sales_divisions usd ON usd.user_id = u.id
       JOIN sales_divisions sd ON sd.id = usd.sales_division_id
      WHERE u.is_sales_business_unit = TRUE AND u.is_active = TRUE
        AND (u.account_type IS NULL OR u.account_type <> 'System Admin')`
  );
  if (!owners.length) return [];

  const [departments] = await pool.query('SELECT id, name FROM departments WHERE is_active = TRUE');
  const departmentByKey = new Map(departments.map((d) => [norm(d.name), d]));

  const byUser = new Map();
  for (const row of owners) {
    const department = departmentByKey.get(norm(row.division_name));
    if (!department) continue; // a division with no matching department owns no documents
    if (!isSalesGroup(department.name)) continue;
    if (!byUser.has(row.user_id)) {
      byUser.set(row.user_id, { userId: row.user_id, displayName: row.display_name, departmentIds: [], departmentNames: [] });
    }
    const group = byUser.get(row.user_id);
    group.departmentIds.push(department.id);
    group.departmentNames.push(department.name);
  }

  return [...byUser.values()]
    .filter((g) => g.departmentIds.length)
    .sort((a, b) => Math.min(...a.departmentIds) - Math.min(...b.departmentIds))
    .map((g, i) => ({ ...g, index: i + 1, label: `SBU ${i + 1}` }));
}

// Marketing raises job orders too, and owns no SBU: nobody holds it as a sales group, so
// under the rule above its orders would sit in a queue with no approver who can see them.
// Both SBUs cover it jointly, which is why it is a third tab rather than being folded into
// one of theirs -- either can clear it, and neither is made to own it.
//
// Resolved by name for the same reason everything else here is: the department id differs
// between the office and cloud databases, so an id in code would point at the wrong team on
// one of them.
const isMarketing = (departmentName) => norm(departmentName) === 'marketing';

async function getMarketingDepartmentIds() {
  const [rows] = await pool.query('SELECT id, name FROM departments WHERE is_active = TRUE');
  return rows.filter((d) => isMarketing(d.name)).map((d) => d.id);
}

// An SBU sees BOTH groups' non-standard job orders and tickets -- that is the whole point
// of the cross-approval arrangement, and an approver who cannot find a document cannot
// approve it. Returns null for everyone else, leaving their existing scope untouched.
//
// `withMarketing` is off by default and asked for explicitly by each caller, because
// widening what an SBU can read is a separate decision per module rather than something
// that should arrive as a side effect. Non-standard job orders set it so both SBUs can
// approve Marketing's orders; tickets set it so Marketing's tickets are visible to, and
// actionable by, either SBU rather than sitting in a queue with nobody able to see them.
async function getSbuScope(userId, { withMarketing = false } = {}) {
  const [[user]] = await pool.query(
    'SELECT is_sales_business_unit FROM users WHERE id = ? AND is_active = TRUE',
    [userId]
  );
  if (!user?.is_sales_business_unit) return null;

  const groups = await getSbuGroups();
  // The flag alone is not enough -- it is also set on accounts that own no sales group at
  // all (Marketing, and the admin account before it was excluded above). Only an owner of
  // one of the groups gets the cross-group view and the tabs; for everyone else this
  // returns null and their page keeps exactly the layout and scope it has today.
  if (!groups.some((g) => g.userId === userId)) return null;

  const tabs = [...groups];
  if (withMarketing) {
    const marketingIds = await getMarketingDepartmentIds();
    // Numbered after the real SBUs so the existing tabs keep the indexes users have
    // bookmarked, and skipped entirely where no Marketing department exists rather than
    // showing a tab that could only ever be empty.
    if (marketingIds.length) {
      tabs.push({
        userId: null,
        displayName: 'Marketing department',
        departmentIds: marketingIds,
        departmentNames: ['Marketing'],
        index: groups.length + 1,
        label: 'Marketing',
      });
    }
  }

  return { groups: tabs, departmentIds: tabs.flatMap((g) => g.departmentIds) };
}

// Narrows a scope to one tab. An unknown/absent index means "both", so a stale bookmark
// widens to everything this user may see rather than silently showing an empty list.
function departmentIdsForTab(scope, sbuIndex) {
  const wanted = Number(sbuIndex);
  const group = scope.groups.find((g) => g.index === wanted);
  return group ? group.departmentIds : scope.departmentIds;
}

// Either SBU may approve either group's documents. The per-document approver snapshot
// (taken at creation from department_ticket_approvers) still governs everyone else, but an
// SBU is not limited to the group they happen to be tagged on -- including for documents
// raised before this rule existed, which is why this is checked at approval time rather
// than by tagging both SBUs when the document is created.
//
// `departmentId` is the document's own group: sales_division_id on a job order, the
// raiser's department on a ticket.
//
// Marketing is included because this is only called from non-standard job orders, where both
// SBUs cover it -- see the Marketing tab above.
async function sbuCanApproveDepartment(userId, departmentId) {
  if (departmentId == null) return false;
  const scope = await getSbuScope(userId, { withMarketing: true });
  if (!scope) return false;
  return scope.departmentIds.includes(Number(departmentId));
}

module.exports = { getSbuGroups, getSbuScope, departmentIdsForTab, sbuCanApproveDepartment };
