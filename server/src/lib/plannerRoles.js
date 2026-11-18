const pool = require('../db');

// The production planner role flags, one per production department: Signage (the original --
// db/add-signage-planner-role.js), DPOD, CNC and LFP (db/add-department-planner-roles.js).
//
// Every gate in the app asks the same question of them -- "is this user a planner?" -- and none
// asks which department, because that is not the flag's job: what a planner may reach is decided
// by their department's warehouse (lib/jobLocationVisibility.js), the same filter that bounds
// every other production user. So the list lives here once, and adding a fifth department means
// adding its column to the migration and its name to this array, nothing else.
const PLANNER_FLAGS = ['is_signage_planner', 'is_DPOD_planner', 'is_CNC_planner', 'is_LFP_planner'];

// For dropping into a SELECT list.
const PLANNER_COLUMNS = PLANNER_FLAGS.join(', ');

// `row` is any users row (or /auth/me user object) carrying the flag columns.
const isPlanner = (row) => PLANNER_FLAGS.some((flag) => !!row?.[flag]);

// Checked fresh against the database rather than trusted off the JWT, same discipline as the
// other role lookups -- moving someone off planning has to take effect on their next request,
// not at their next login.
async function isPlannerUser(userId) {
  const [[row]] = await pool.query(`SELECT ${PLANNER_COLUMNS} FROM users WHERE id = ?`, [userId]);
  return isPlanner(row);
}

module.exports = { PLANNER_FLAGS, PLANNER_COLUMNS, isPlanner, isPlannerUser };
