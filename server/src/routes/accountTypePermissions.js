const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();
// Default permission matrix per Account Type, used by the Add/Update User wizard's
// "Apply template" button. These are a starting point for a new user, never a live link:
// applying one fills the wizard's checkboxes and the admin saves whatever they end up with,
// so editing a template here never retroactively changes anyone's existing access.
//
// Gated on the Users & Permissions page rather than a page of its own -- whoever is trusted to
// set a user's permissions is exactly who should be able to shape the defaults.
const ROUTE = '/users';

// Read every template at once -- the wizard loads this with its other lookups and applies
// client-side, so switching account types in the dropdown needs no extra round trip.
router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT account_type, page_id, can_view, can_add, can_edit, can_update, can_view_all, can_delete, can_approve, can_print, can_void FROM account_type_permissions'
    );
    const byType = {};
    rows.forEach((r) => {
      if (!byType[r.account_type]) byType[r.account_type] = [];
      byType[r.account_type].push(r);
    });
    res.json(byType);
  } catch (err) { next(err); }
});

// Replace one account type's whole matrix. Same all-or-nothing shape as
// PUT /users/:id/permissions: rows with nothing ticked are simply not stored.
router.put('/:accountType', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const accountType = String(req.params.accountType || '').trim();
    if (!accountType) return res.status(400).json({ error: 'Account type is required.' });
    const permissions = Array.isArray(req.body.permissions) ? req.body.permissions : [];

    await conn.beginTransaction();
    await conn.query('DELETE FROM account_type_permissions WHERE account_type = ?', [accountType]);
    for (const p of permissions) {
      if (!p.page_id) continue;
      // can_update belongs in this test too: a page where it is the ONLY box ticked is a real
      // grant (an artist who may advance a Job Order but not edit it -- the case the permission
      // was added for) and leaving it out silently dropped that row instead of saving it.
      if (!p.can_view && !p.can_add && !p.can_edit && !p.can_update && !p.can_view_all && !p.can_delete && !p.can_approve && !p.can_print && !p.can_void) continue;
      await conn.query(
        `INSERT INTO account_type_permissions
           (account_type, page_id, can_view, can_add, can_edit, can_update, can_view_all, can_delete, can_approve, can_print, can_void, updated_at, updated_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
        [accountType, p.page_id, !!p.can_view, !!p.can_add, !!p.can_edit, !!p.can_update, !!p.can_view_all, !!p.can_delete, !!p.can_approve, !!p.can_print, !!p.can_void, req.user.id]
      );
    }
    await conn.commit();

    const [rows] = await pool.query(
      'SELECT account_type, page_id, can_view, can_add, can_edit, can_update, can_view_all, can_delete, can_approve, can_print, can_void FROM account_type_permissions WHERE account_type = ?',
      [accountType]
    );
    res.json(rows);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
