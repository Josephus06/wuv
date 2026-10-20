const jwt = require('jsonwebtoken');
const pool = require('../db');

const PERMISSION_ACTIONS = new Set(['can_view', 'can_add', 'can_edit', 'can_delete', 'can_approve']);

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing authorization token' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
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

// The same check as requirePermission, as a yes/no for a route that serves more or less
// depending on who asks (e.g. the employee profile, HR-only within a page others can view).
async function userCan(userId, route, action = 'can_view') {
  if (!PERMISSION_ACTIONS.has(action)) throw new Error(`Unknown permission action: ${action}`);
  const [[perm]] = await pool.query(
    `SELECT upp.${action} AS allowed FROM user_page_permissions upp
     JOIN pages p ON p.id = upp.page_id WHERE upp.user_id = ? AND p.route = ?`,
    [userId, route]
  );
  return !!(perm && perm.allowed);
}

module.exports = { requireAuth, requirePermission, requireAnyPermission, userCan };
