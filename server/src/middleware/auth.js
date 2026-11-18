const jwt = require('jsonwebtoken');
const pool = require('../db');

// can_edit and can_update are DIFFERENT rights, despite the grid having labelled can_edit
// "Can Update" for years. can_edit opens the Edit form -- structural change to the record.
// can_update moves the transaction along its own workflow without touching its content, which
// is what an artist sending a layout for Sales Approval needs and all they should have.
const PERMISSION_ACTIONS = new Set(['can_view', 'can_add', 'can_edit', 'can_update', 'can_view_all', 'can_delete', 'can_approve', 'can_print', 'can_void']);

// System Admin is the one role defined by the account itself rather than by a permission
// row -- create-account-type-permissions.js seeds it full access on every page. The JWT
// carries only id/username/display_name, so the account type is read fresh; that also means
// demoting someone takes effect immediately rather than at their next login.
async function isSystemAdmin(userId) {
  const [[u]] = await pool.query('SELECT account_type FROM users WHERE id = ?', [userId]);
  return u?.account_type === 'System Admin';
}

// Presence heartbeat for the newsfeed's Contacts rail. Every authenticated request would be
// one UPDATE per request, which is far more writes than "who's online" is worth -- so each
// user's row is touched at most once a minute, tracked in-process. A restart just means one
// extra write per active user.
const PRESENCE_THROTTLE_MS = 60_000;
const lastTouched = new Map();

// Presence writes must never be able to exhaust the connection pool.
//
// The throttle alone is not enough: if the database stops completing writes (a full disk, a
// metadata lock held by a schema change), every user's next beat still fires a fresh UPDATE
// that hangs. At pool.connectionLimit = 10 that wedges the entire API within minutes -- real
// queries then queue behind stuck "who's online" updates. Capping in-flight beats at one
// bounds the damage to a single connection no matter how long the database stays stuck.
// A skipped beat costs nothing; the user's next request tries again.
let presenceInFlight = 0;
const MAX_PRESENCE_IN_FLIGHT = 1;

function touchPresence(userId) {
  const now = Date.now();
  const prev = lastTouched.get(userId);
  if (prev && now - prev < PRESENCE_THROTTLE_MS) return;
  if (presenceInFlight >= MAX_PRESENCE_IN_FLIGHT) return;

  // Stamped only once the write is actually issued, so a skipped beat retries immediately
  // rather than waiting out another full throttle window.
  lastTouched.set(userId, now);
  presenceInFlight += 1;
  // Fire-and-forget: presence is never worth failing or delaying a real request over.
  pool.query('UPDATE users SET last_seen_at = NOW() WHERE id = ?', [userId])
    .catch(() => {})
    .finally(() => { presenceInFlight -= 1; });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing authorization token' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    // Never beat presence for an impersonated session: the user is not actually online, and
    // showing them on the feed's Contacts rail because an admin opened their account would
    // be plainly wrong -- and would keep them "online" indefinitely while the admin worked.
    if (!payload.impersonated_by) touchPresence(payload.id);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Called on logout so someone who signs out drops off the Contacts rail immediately rather
// than lingering for the length of the online window.
function clearPresence(userId) {
  lastTouched.delete(userId);
  return pool.query('UPDATE users SET last_seen_at = NULL WHERE id = ?', [userId]);
}

// Checks user_page_permissions for the given route + action ('can_view' | 'can_add' | 'can_edit' | 'can_delete' | 'can_approve')
function requirePermission(route, action = 'can_view') {
  if (!PERMISSION_ACTIONS.has(action)) {
    throw new Error(`Unknown permission action: ${action}`);
  }

  return async (req, res, next) => {
    try {
      const [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [route]);
      if (!page) return res.status(500).json({ error: `Page not registered: ${route}` });

      const [[perm]] = await pool.query(
        `SELECT ${action} AS allowed FROM user_page_permissions WHERE user_id = ? AND page_id = ?`,
        [req.user.id, page.id]
      );

      if (!perm || !perm.allowed) {
        return res.status(403).json({ error: 'You do not have permission to perform this action' });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Passes when the user holds `action` on ANY of the given routes -- for lookups that several
// pages share (e.g. the shift list feeds Shifts, Shift Assignments and Attendance alike).
function requireAnyPermission(routes, action = 'can_view') {
  if (!PERMISSION_ACTIONS.has(action)) {
    throw new Error(`Unknown permission action: ${action}`);
  }

  return async (req, res, next) => {
    try {
      const [[row]] = await pool.query(
        `SELECT MAX(upp.${action}) AS allowed
         FROM user_page_permissions upp JOIN pages p ON p.id = upp.page_id
         WHERE upp.user_id = ? AND p.route IN (?)`,
        [req.user.id, routes]
      );
      if (!row || !row.allowed) {
        return res.status(403).json({ error: 'You do not have permission to perform this action' });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

// The same check requirePermission makes, as a plain call, for routes that need to branch on a
// permission rather than refuse outright -- e.g. letting can_approve override a guard that stops
// everyone else. System Admin is seeded full access on every page, so it short-circuits true and
// does not depend on that seeding having run.
async function userCan(userId, route, action = 'can_view') {
  if (!PERMISSION_ACTIONS.has(action)) throw new Error(`Unknown permission action: ${action}`);
  if (await isSystemAdmin(userId)) return true;
  const [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [route]);
  if (!page) return false;
  const [[perm]] = await pool.query(
    `SELECT ${action} AS allowed FROM user_page_permissions WHERE user_id = ? AND page_id = ?`,
    [userId, page.id]
  );
  return !!(perm && perm.allowed);
}

module.exports = { requireAuth, requirePermission, requireAnyPermission, clearPresence, isSystemAdmin, userCan };
