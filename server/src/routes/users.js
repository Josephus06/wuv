const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { PLANNER_FLAGS } = require('../lib/plannerRoles');

const router = express.Router();
const ROUTE = '/users';

// Replace a user's SBU division ownership in full. Called on create/update; harmless
// (clears to none) for non-SBU users, so no flag check is needed here.
async function saveSalesDivisions(userId, ids) {
  const divisionIds = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  await pool.query('DELETE FROM user_sales_divisions WHERE user_id = ?', [userId]);
  for (const divisionId of [...new Set(divisionIds)]) {
    await pool.query('INSERT INTO user_sales_divisions (user_id, sales_division_id) VALUES (?, ?)', [userId, divisionId]);
  }
}

// Replace a user's supervisors in full, mirroring saveSalesDivisions above. A user may report
// to several supervisors, so this is the real relationship; `users.supervisor_id` is kept in
// sync with the FIRST one purely so older readers of that column still resolve to a sensible
// primary rather than NULL. Self-assignment is dropped -- it would make the commission rollup
// treat a user as their own report.
async function saveSupervisors(userId, ids) {
  const supervisorIds = [...new Set(
    (Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== Number(userId))
  )];
  await pool.query('DELETE FROM user_supervisors WHERE user_id = ?', [userId]);
  for (const supervisorId of supervisorIds) {
    await pool.query('INSERT INTO user_supervisors (user_id, supervisor_id) VALUES (?, ?)', [userId, supervisorId]);
  }
  await pool.query('UPDATE users SET supervisor_id = ? WHERE id = ?', [supervisorIds[0] ?? null, userId]);
}

// "Account Type" tab fields (step 4 of the real system's Add/Update User wizard).
const ACCOUNT_TYPE_FIELDS = [
  'user_group_id', 'account_type', 'can_approve_sales_estimate', 'is_account_officer',
  'is_supervisor', 'is_sales_manager', 'is_sales_marketing_director', 'is_sales_business_unit',
  'is_design_supervisor', 'is_purchasing_supervisor', ...PLANNER_FLAGS,
  'is_production_supervisor', 'can_edit_approved_po', 'approval_code',
  // Accounts Payable: assigns each liquidation item's COGS and notes liquidations (routes/forms.js).
  'is_accounts_payable',
  // Monthly fuel limit (2026-10-19; db/add-fuel-form.js): a Fuel Request past it is refused at submit.
  'has_fuel_limit', 'fuel_limit_liters',
  // Fuel Approver: approves every Fuel Request (they are not noted).
  'is_fuel_approver',
];

// Supervisors are NOT in the list above on purpose. Every field there that a PUT carries is
// written verbatim, so leaving supervisor_id in it would let a resent stale value overwrite the
// primary supervisor and drift from user_supervisors. The column
// is written only by saveSupervisors(), from the table.
// `supervisor_ids` is the payload field; a lone legacy `supervisor_id` is still accepted so a
// client running older code keeps working against a freshly deployed server.
const supervisorIdsFrom = (body) => {
  if (Array.isArray(body.supervisor_ids)) return body.supervisor_ids;
  if (body.supervisor_id !== undefined) return body.supervisor_id ? [body.supervisor_id] : [];
  return undefined;
};

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.username, u.email, u.display_name, u.employee_id, u.default_branch_id,
              u.is_active, u.last_login_at, u.created_at, u.account_type, u.supervisor_id,
              CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
              l.location_name AS default_branch_name,
              -- Every supervisor, comma-joined: a user may report to several, and showing
              -- only users.supervisor_id here would hide the secondary ones from the list.
              (SELECT GROUP_CONCAT(s.display_name ORDER BY s.display_name SEPARATOR ', ')
                 FROM user_supervisors us JOIN users s ON s.id = us.supervisor_id
                WHERE us.user_id = u.id) AS supervisor_name
       FROM users u
       LEFT JOIN employees e ON e.id = u.employee_id
       LEFT JOIN locations l ON l.id = u.default_branch_id
       ORDER BY u.id DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/meta/pages', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT id, name, route, parent_page_id, sort_order FROM pages WHERE is_active = TRUE ORDER BY sort_order, id');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[user]] = await pool.query(
      `SELECT id, username, email, display_name, employee_id, default_branch_id, is_active, last_login_at, created_at,
              supervisor_id, signature_data, signature_set_at, ${ACCOUNT_TYPE_FIELDS.join(', ')}
       FROM users WHERE id = ?`,
      [req.params.id]
    );
    if (!user) return res.status(404).json({ error: 'Not found' });

    const [branches] = await pool.query(
      'SELECT id, location_id, department_id, can_override_date, remarks, is_default FROM user_branches WHERE user_id = ?',
      [req.params.id]
    );
    const [permissions] = await pool.query(
      'SELECT page_id, can_view, can_add, can_edit, can_update, can_view_all, can_delete, can_approve, can_print, can_void FROM user_page_permissions WHERE user_id = ?',
      [req.params.id]
    );
    // The sales divisions this user owns as an SBU (empty for everyone else).
    const [divisions] = await pool.query(
      'SELECT sales_division_id FROM user_sales_divisions WHERE user_id = ?',
      [req.params.id]
    );

    // Everyone this user reports to. supervisor_id (the primary) rides along unchanged for
    // any caller still reading the single value.
    const [supervisors] = await pool.query(
      `SELECT us.supervisor_id, s.display_name
         FROM user_supervisors us JOIN users s ON s.id = us.supervisor_id
        WHERE us.user_id = ? ORDER BY s.display_name`,
      [req.params.id]
    );

    res.json({
      ...user,
      branches,
      permissions,
      sales_division_ids: divisions.map((d) => d.sales_division_id),
      supervisor_ids: supervisors.map((s) => s.supervisor_id),
      supervisor_names: supervisors.map((s) => s.display_name),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const { username, email, password, display_name, employee_id, default_branch_id, is_active } = req.body;
    if (!username || !email || !password || !display_name) {
      return res.status(400).json({ error: 'username, email, password, and display_name are required' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    // Fields not sent take the column default rather than NULL -- see the note on PUT below.
    const sentFields = ACCOUNT_TYPE_FIELDS.filter((f) => req.body[f] !== undefined);
    const accountTypeValues = sentFields.map((f) => (req.body[f] === '' ? null : req.body[f]));
    const [result] = await pool.query(
      `INSERT INTO users (employee_id, username, email, password_hash, display_name, default_branch_id, is_active${sentFields.map((f) => `, ${f}`).join('')})
       VALUES (?, ?, ?, ?, ?, ?, ?${sentFields.map(() => ', ?').join('')})`,
      [employee_id || null, username, email, passwordHash, display_name, default_branch_id || null, is_active ?? true, ...accountTypeValues]
    );
    // Written after the insert rather than in it, so the signature columns stay out of the
    // VALUES list every other field shares -- and so registering somebody on an older client
    // that knows nothing about signatures is unaffected.
    if (req.body.signature_data) {
      await pool.query('UPDATE users SET signature_data = ?, signature_set_at = NOW() WHERE id = ?',
        [req.body.signature_data, result.insertId]);
    }
    await saveSalesDivisions(result.insertId, req.body.sales_division_ids);
    await saveSupervisors(result.insertId, supervisorIdsFrom(req.body) || []);
    const [[row]] = await pool.query(
      `SELECT id, username, email, display_name, employee_id, default_branch_id, is_active, ${ACCOUNT_TYPE_FIELDS.join(', ')} FROM users WHERE id = ?`,
      [result.insertId]
    );
    res.status(201).json(row);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Username or email already in use' });
    next(err);
  }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { email, password, display_name, employee_id, default_branch_id, is_active } = req.body;
    // A field the request does not carry at all is left as stored. A browser tab opened before a
    // deploy that added a flag knows nothing of it, and writing NULL for it failed the whole save
    // on the NOT NULL column (can_edit_approved_po, 2026-10-01) -- permissions included.
    const sentFields = ACCOUNT_TYPE_FIELDS.filter((f) => req.body[f] !== undefined);
    const accountTypeValues = sentFields.map((f) => (req.body[f] === '' ? null : req.body[f]));
    const fields = [
      'email = ?', 'display_name = ?', 'employee_id = ?', 'default_branch_id = ?', 'is_active = ?',
      ...sentFields.map((f) => `${f} = ?`),
    ];
    const values = [email, display_name, employee_id || null, default_branch_id || null, is_active ?? true, ...accountTypeValues];

    if (password) {
      fields.push('password_hash = ?');
      values.push(await bcrypt.hash(password, 10));
    }

    // The signature is written only when the form actually sends one, unlike the fields above,
    // which are written verbatim on every PUT. A screen that does not show the signature pad --
    // or an API caller that has never heard of it -- must not silently erase somebody's
    // signature simply by saving their account. `null` still clears it, deliberately, which is
    // how Clear then Save removes one.
    if (req.body.signature_data !== undefined) {
      const sig = req.body.signature_data;
      if (sig !== null && !/^data:image\/(png|jpeg);base64,/.test(String(sig))) {
        return res.status(400).json({ error: 'A signature must be an image.' });
      }
      // A drawn signature is a few KB. A cap stops a pasted photograph filling a MEDIUMTEXT.
      if (sig !== null && String(sig).length > 2 * 1024 * 1024) {
        return res.status(400).json({ error: 'That signature image is too large.' });
      }
      fields.push('signature_data = ?', 'signature_set_at = ?');
      values.push(sig, sig ? new Date() : null);
    }

    await pool.query(`UPDATE users SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`, [...values, req.params.id]);
    if (req.body.sales_division_ids !== undefined) await saveSalesDivisions(req.params.id, req.body.sales_division_ids);
    const nextSupervisors = supervisorIdsFrom(req.body);
    if (nextSupervisors !== undefined) await saveSupervisors(req.params.id, nextSupervisors);
    const [[row]] = await pool.query(
      `SELECT id, username, email, display_name, employee_id, default_branch_id, is_active, ${ACCOUNT_TYPE_FIELDS.join(', ')} FROM users WHERE id = ?`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Email already in use' });
    next(err);
  }
});

router.delete('/:id', requireAuth, requirePermission(ROUTE, 'can_delete'), async (req, res, next) => {
  try {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('DELETE FROM user_page_permissions WHERE user_id = ?', [req.params.id]);
      await conn.query('DELETE FROM user_branches WHERE user_id = ?', [req.params.id]);
      await conn.query('DELETE FROM users WHERE id = ?', [req.params.id]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.put('/:id/branches', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const branches = Array.isArray(req.body.branches) ? req.body.branches : [];
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('DELETE FROM user_branches WHERE user_id = ?', [req.params.id]);
      for (const b of branches) {
        await conn.query(
          `INSERT INTO user_branches (user_id, location_id, department_id, can_override_date, remarks, is_default)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [req.params.id, b.location_id, b.department_id || null, !!b.can_override_date, b.remarks || null, !!b.is_default]
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.put('/:id/permissions', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const permissions = Array.isArray(req.body.permissions) ? req.body.permissions : [];
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('DELETE FROM user_page_permissions WHERE user_id = ?', [req.params.id]);
      for (const p of permissions) {
        if (!p.can_view && !p.can_add && !p.can_edit && !p.can_update && !p.can_view_all && !p.can_delete && !p.can_approve && !p.can_print && !p.can_void) continue;
        await conn.query(
          `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_update, can_view_all, can_delete, can_approve, can_print, can_void)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [req.params.id, p.page_id, !!p.can_view, !!p.can_add, !!p.can_edit, !!p.can_update, !!p.can_view_all, !!p.can_delete, !!p.can_approve, !!p.can_print, !!p.can_void]
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
