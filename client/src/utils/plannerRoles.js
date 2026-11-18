// Mirror of server/src/lib/plannerRoles.js -- the production planner role flags, one per
// production department. /auth/me returns every one of them on the user, and each screen only
// ever asks "is this user a planner?", never which department: what a planner may reach is
// decided server-side by their department's warehouse, not by the flag.
//
// Kept in step with the server list. Adding a fifth department means the column, the server
// array, and this one.
export const PLANNER_FLAGS = ['is_signage_planner', 'is_DPOD_planner', 'is_CNC_planner', 'is_LFP_planner'];

export function isPlanner(user) {
  return PLANNER_FLAGS.some((flag) => !!user?.[flag]);
}
