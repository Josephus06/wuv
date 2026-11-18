// Company / branch scope for reports.
//
// Wu Ventures keeps one set of books. A transaction belongs to a BRANCH (its office_location_id,
// carried onto each GL line as location_id), and a branch belongs to a COMPANY (locations.company_id):
//
//   Wu Ventures (everything -- the consolidated view, no filter)
//     Fresh n Tidy  -> its branches
//     Cuts For Tots -> its branches
//
// A report asked for ?companyId= or ?locationId= is cut down to the GL lines of those branches.
// Lines with no branch at all belong to no company: they appear only in the consolidated view, and
// the scoped result says how many were left out so they can be found and fixed.
const pool = require('../db');

const toId = (v) => (Number(v) > 0 ? Number(v) : null);

// { companyId, locationId } off a request's query string.
function scopeFromQuery(q = {}) {
  return { companyId: toId(q.companyId ?? q.company_id), locationId: toId(q.locationId ?? q.location_id) };
}

// -> null for the consolidated view, else { locationIds: Set<number>, label, companyId, locationId }.
// A branch wins over a company when both are given (a branch is already inside one company).
async function resolveScope(scope = {}) {
  const companyId = toId(scope.companyId);
  const locationId = toId(scope.locationId);
  if (!companyId && !locationId) return null;
  if (locationId) {
    const [[loc]] = await pool.query(
      `SELECT l.id, l.location_name, c.name AS company_name FROM locations l
         LEFT JOIN companies c ON c.id = l.company_id WHERE l.id = ?`, [locationId]);
    return {
      companyId, locationId, locationIds: new Set([locationId]),
      label: loc ? `${loc.company_name ? `${loc.company_name} — ` : ''}${loc.location_name}` : `Branch #${locationId}`,
    };
  }
  const [[co]] = await pool.query('SELECT name FROM companies WHERE id = ?', [companyId]);
  const [locs] = await pool.query('SELECT id FROM locations WHERE company_id = ?', [companyId]);
  return { companyId, locationId: null, locationIds: new Set(locs.map((l) => Number(l.id))), label: co ? co.name : `Company #${companyId}` };
}

// The GL lines inside the scope, plus how many were dropped for having no branch.
function filterLines(lines, resolved) {
  if (!resolved) return { lines, unassigned: 0 };
  let unassigned = 0;
  const kept = [];
  for (const l of lines) {
    const loc = Number(l.location_id) || null;
    if (!loc) { unassigned += 1; continue; }
    if (resolved.locationIds.has(loc)) kept.push(l);
  }
  return { lines: kept, unassigned };
}

// What a scoped report says about itself (shown above the figures).
function scopeInfo(resolved, unassigned) {
  if (!resolved) return { scope: null };
  return {
    scope: {
      company_id: resolved.companyId, location_id: resolved.locationId, label: resolved.label,
      branch_count: resolved.locationIds.size, unassigned_lines: unassigned,
    },
  };
}

// location_id -> company_id, for splitting a report into one column per company.
async function companyByLocation() {
  const [rows] = await pool.query('SELECT id, company_id FROM locations');
  return new Map(rows.map((r) => [Number(r.id), r.company_id ? Number(r.company_id) : null]));
}

module.exports = { scopeFromQuery, resolveScope, filterLines, scopeInfo, companyByLocation };
