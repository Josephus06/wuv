// Where a user "is", for rules that treat Head Office differently from the branches.
//
// Two fields claim to hold this and they do not always agree:
//
//   user_branches.is_default  the "Default Login Location" on the User Branches tab. This is the
//                             live one -- it already decides the Office Location an Estimate opens
//                             with (routes/auth.js builds user.default_branch from it).
//   users.default_branch_id   the older field set on the User Account step, still shown as
//                             "Default Branch" on the Users list.
//
// The login location wins and the older field is the fallback, so an account configured either way
// still resolves to somewhere. An account with NEITHER resolves to null, and callers here read
// that as Head Office -- the stricter side of every rule built on this, so a half-configured
// account cannot quietly pick up the looser one.
const pool = require('../db');

const HEAD_OFFICE = 'head office';

async function resolveDefaultLocation(userId) {
  // LIMIT 1 rather than trusting is_default to be unique: nothing in the schema stops a user
  // carrying two default branches, and this has to answer with one location either way.
  const [[row]] = await pool.query(
    `SELECT COALESCE(ubl.id, dbl.id) AS id,
            COALESCE(ubl.location_name, dbl.location_name) AS location_name
       FROM users u
       LEFT JOIN user_branches ub ON ub.user_id = u.id AND ub.is_default = TRUE
       LEFT JOIN locations ubl ON ubl.id = ub.location_id
       LEFT JOIN locations dbl ON dbl.id = u.default_branch_id
      WHERE u.id = ?
      LIMIT 1`,
    [userId],
  );
  return row?.id ? { id: row.id, location_name: row.location_name } : null;
}

// Prefix-matched and case-insensitive because the name is typed into the locations master by
// hand: the importers already hedge the same way ("Head Office%", "%Head Office%"), so a
// "Head Office - Main" must not read as a branch.
//
// Split out from isHeadOfficeUser so callers that have already read a batch of location names
// can ask the same question without a query each -- getSalesRepEmployeeScope classifies every
// user in one pass. One definition of "is this Head Office", used by both.
//
// A missing name answers TRUE, as it does for a user with no location at all: Head Office is the
// stricter side of every rule built on this, so a half-configured account cannot quietly pick up
// the looser one.
function isHeadOfficeName(locationName) {
  if (!locationName) return true;
  return String(locationName).trim().toLowerCase().startsWith(HEAD_OFFICE);
}

async function isHeadOfficeUser(userId) {
  const loc = await resolveDefaultLocation(userId);
  return isHeadOfficeName(loc?.location_name);
}

module.exports = { resolveDefaultLocation, isHeadOfficeUser, isHeadOfficeName };
