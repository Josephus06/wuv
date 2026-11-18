const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { PLANNER_COLUMNS, PLANNER_FLAGS, isPlanner } = require('../lib/plannerRoles');
const { requireAuth, clearPresence, isSystemAdmin } = require('../middleware/auth');
const { isHeadOfficeUser } = require('../lib/userLocation');

const router = express.Router();

// One place that mints tokens, so an impersonation session carries exactly the same claims a
// real login does -- plus `impersonated_by` when one admin is acting as someone else.
function signToken(user, impersonatedBy = null) {
  const payload = { id: user.id, username: user.username, display_name: user.display_name };
  if (impersonatedBy) {
    payload.impersonated_by = {
      id: impersonatedBy.id,
      username: impersonatedBy.username,
      display_name: impersonatedBy.display_name,
    };
  }
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });
}

const label = (u) => u.display_name || u.username;

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    // Named columns rather than SELECT *: users carries three MEDIUMTEXT image blobs
    // (avatar_data, cover_data, bg_data -- the last one a full-screen wallpaper), and a
    // star here drags all of them across the wire on every single sign-in to read a
    // password hash and ten flags. This list is exactly what the handler below uses:
    // password_hash for the bcrypt compare, and the rest for the token and the response.
    const [[user]] = await pool.query(
      `SELECT id, username, email, display_name, password_hash, default_branch_id,
              account_type, can_approve_sales_estimate, is_design_supervisor,
              is_supervisor, is_purchasing_supervisor, ${PLANNER_COLUMNS},
              is_production_supervisor, can_edit_approved_po
         FROM users WHERE (username = ? OR email = ?) AND is_active = TRUE`,
      [username, username]
    );
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);

    const token = signToken(user);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        display_name: user.display_name,
        default_branch_id: user.default_branch_id,
        can_approve_sales_estimate: !!user.can_approve_sales_estimate,
        is_design_supervisor: !!user.is_design_supervisor,
        is_supervisor: !!user.is_supervisor,
        is_purchasing_supervisor: !!user.is_purchasing_supervisor,
        ...Object.fromEntries(PLANNER_FLAGS.map((flag) => [flag, !!user[flag]])),
        is_production_supervisor: !!user.is_production_supervisor,
        can_edit_approved_po: !!user.can_edit_approved_po,
        account_type: user.account_type,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------
// Admin "Log in as" -- an admin needs to see and fix things as the user actually sees
// them, and asking for the user's password does not work: they can change it, and a
// shared master password would make an admin's session indistinguishable from the real
// user's in every audit row, which in a system carrying estimate approvals, NSTDJO
// sign-offs and commission payouts destroys attribution for the user's genuine actions
// as much as for the admin's.
//
// So the admin authenticates as themselves and switches. The target's own password is
// never involved, which is exactly why this keeps working whatever they later set it to,
// and there is no new secret to leak. The issued token carries `impersonated_by`: the
// banner reads off it, /auth/me returns it, and both ends of the session are written to
// audit_logs against the target user, so the window is reconstructable afterwards.
// ---------------------------------------------------------------------------------
router.post('/impersonate/:userId', requireAuth, async (req, res, next) => {
  try {
    // Refuse while already impersonating. Without this an admin could hop admin -> admin
    // -> user, and the second token would name only the middle account as the actor,
    // losing whoever actually started the chain.
    if (req.user.impersonated_by) {
      return res.status(409).json({ error: 'You are already signed in as another user. Return to your own account first.' });
    }
    if (!await isSystemAdmin(req.user.id)) {
      return res.status(403).json({ error: 'Only a System Admin can sign in as another user.' });
    }

    const targetId = Number(req.params.userId);
    if (!Number.isInteger(targetId) || targetId <= 0) return res.status(400).json({ error: 'Invalid user.' });
    if (targetId === Number(req.user.id)) return res.status(400).json({ error: 'That is already your own account.' });

    // Inactive accounts are refused for the same reason /login refuses them -- an admin
    // should not be able to act as somebody who has been switched off.
    const [[target]] = await pool.query(
      'SELECT id, username, display_name FROM users WHERE id = ? AND is_active = TRUE', [targetId]
    );
    if (!target) return res.status(404).json({ error: 'User not found, or their account is inactive.' });

    const [[admin]] = await pool.query(
      'SELECT id, username, display_name FROM users WHERE id = ?', [req.user.id]
    );

    // event_type is a fixed ENUM (Created/Updated/Approved/Disapproved/Cancelled/Deleted/
    // Status Change) -- 'Impersonation' is not one of its values, so writing it truncated to
    // empty and, under strict mode, failed the insert and the whole sign-in with it. 'Updated'
    // is an allowed value; the field_name and message carry what actually happened.
    await pool.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, new_value, set_by_user_id)
       VALUES ('User', ?, 'Updated', 'impersonation_started', ?, ?)`,
      [target.id, `${label(admin)} signed in as ${label(target)}`, admin.id]
    );

    res.json({ token: signToken(target, admin), impersonating: target, impersonated_by: admin });
  } catch (err) {
    next(err);
  }
});

// Hands the admin back their own session. Authorised by the token's own `impersonated_by`
// rather than by re-checking admin rights: whoever holds this token demonstrably started
// as that admin, and an admin demoted mid-session must still be able to get back out.
router.post('/stop-impersonating', requireAuth, async (req, res, next) => {
  try {
    const origin = req.user.impersonated_by;
    if (!origin) return res.status(400).json({ error: 'You are not signed in as another user.' });

    const [[admin]] = await pool.query(
      'SELECT id, username, display_name, is_active FROM users WHERE id = ?', [origin.id]
    );
    if (!admin || !admin.is_active) {
      return res.status(403).json({ error: 'Your own account is no longer active. Please sign in again.' });
    }

    await pool.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, new_value, set_by_user_id)
       VALUES ('User', ?, 'Updated', 'impersonation_ended', ?, ?)`,
      [req.user.id, `${label(admin)} returned to their own account`, admin.id]
    );
    // The impersonated user drops off the Contacts rail -- the admin was never really them.
    await clearPresence(req.user.id);

    res.json({ token: signToken(admin) });
  } catch (err) {
    next(err);
  }
});

// Tokens are stateless, so this doesn't invalidate anything -- it just clears the presence
// heartbeat so the user drops off the feed's Contacts rail the moment they sign out.
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await clearPresence(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const [[user]] = await pool.query(
      `SELECT id, username, email, display_name, default_branch_id, employee_id,
              account_type, can_approve_sales_estimate, is_design_supervisor,
              is_account_officer, is_supervisor, is_sales_manager,
              is_sales_marketing_director, is_sales_business_unit, is_purchasing_supervisor,
              ${PLANNER_COLUMNS}, is_production_supervisor, can_edit_approved_po, supervisor_id,
              is_accounts_payable, avatar_data
       FROM users WHERE id = ?`,
      [req.user.id]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.can_approve_sales_estimate = !!user.can_approve_sales_estimate;
    user.is_design_supervisor = !!user.is_design_supervisor;
    user.is_account_officer = !!user.is_account_officer;
    user.is_supervisor = !!user.is_supervisor;
    // Whose job orders this user may act on as their supervisor (lib/salesVisibility.js).
    user.report_employee_ids = await require('../lib/salesVisibility').reportEmployeeIds(user.id);
    user.is_sales_manager = !!user.is_sales_manager;
    user.is_sales_marketing_director = !!user.is_sales_marketing_director;
    user.is_sales_business_unit = !!user.is_sales_business_unit;
    // GM approvals (RMA NSSOs, RWIP / RFQC) -- lib/generalManagers.js decides on the server too.
    user.is_general_manager = await require('../lib/generalManagers').isGeneralManager(user.id);
    user.is_purchasing_supervisor = !!user.is_purchasing_supervisor;
    for (const flag of PLANNER_FLAGS) user[flag] = !!user[flag];
    user.is_production_supervisor = !!user.is_production_supervisor;
    user.can_edit_approved_po = !!user.can_edit_approved_po;
    user.is_accounts_payable = !!user.is_accounts_payable;

    // The "Default Login Location" branch (User Branches tab, is_default = TRUE) --
    // distinct from users.default_branch_id (a separate, legacy field set on the User
    // Account step). This is what auto-fills Office Location/Sales Division when a user
    // starts a new Estimate: their own branch's location + department.
    const [[defaultBranch]] = await pool.query(
      `SELECT ub.location_id, ub.department_id, d.name AS department_name,
              -- The warehouse this department is restricted to on every job order list, if any.
              -- Carried here so the UI can say why a list is short rather than leaving it looking
              -- broken; the restriction itself is enforced server-side (lib/jobLocationVisibility.js).
              d.job_location_id, jl.location_name AS job_location_name
       FROM user_branches ub
       LEFT JOIN departments d ON d.id = ub.department_id
       LEFT JOIN locations jl ON jl.id = d.job_location_id
       WHERE ub.user_id = ? AND ub.is_default = TRUE LIMIT 1`,
      [user.id]
    );
    user.default_branch = defaultBranch || null;

    // Head Office and the branches are held to different rules in places (billing a Sales Order,
    // for one -- see requireInvoiceCreatePermission in routes/salesInvoices.js). The client gates
    // the buttons for those rules, so it has to reach the same answer the server will; resolving
    // it here, from the one helper the server uses, is what stops the two drifting into a button
    // that opens a form only for the save to be refused.
    user.is_head_office = await isHeadOfficeUser(user.id);

    const [permissions] = await pool.query(
      `SELECT p.route, upp.can_view, upp.can_add, upp.can_edit, upp.can_update, upp.can_view_all, upp.can_delete, upp.can_approve, upp.can_print, upp.can_void
       FROM user_page_permissions upp
       JOIN pages p ON p.id = upp.page_id
       WHERE upp.user_id = ?`,
      [user.id]
    );

    // The production floor roles (the department planners, Production Supervisor) carry their
    // access as a tag on the account rather than as a permission row -- see requireProductionView
    // in routes/production.js, which lets them read the module on the strength of the tag alone.
    // The client only knows about permission rows: it builds the sidebar and every button gate
    // from this list, so without the row a planner is refused a screen the server would serve.
    // Adding the row the tag implies keeps the two answers the same rather than making every
    // caller of can() learn about role flags. can_view only -- what they may WRITE is decided
    // per action by the server, not by this list.
    if ((isPlanner(user) || user.is_production_supervisor)
        && !permissions.some((perm) => perm.route === '/production')) {
      permissions.push({
        route: '/production',
        can_view: 1, can_add: 0, can_edit: 0, can_update: 0, can_view_all: 0, can_delete: 0, can_approve: 0, can_print: 0, can_void: 0,
      });
    }

    // Same reasoning for the head of a department and the Forms approval queue. Noting a
    // liquidation or a payment is not a permission -- it is being the head of the department the
    // form came from, read off that department's ticket approver list (lib/formNoters.js). The
    // client builds its menu from permission rows alone, so without this a head would have no way
    // to reach the queue holding the forms only they can note.
    //
    // can_view only. It opens the page; the page then shows just their own departments' forms, and
    // whether they may note any given one is still decided per form by the server.
    const [headOf] = await pool.query(
      `SELECT 1 FROM department_ticket_approvers a JOIN departments d ON d.id = a.department_id
        WHERE a.user_id = ? AND a.can_note_form = 1 AND d.is_active = TRUE LIMIT 1`,
      [user.id]
    );
    // Accounts Payable too: it notes every liquidation, and reaches them through the same queue.
    if ((headOf.length || user.is_accounts_payable) && !permissions.some((perm) => perm.route === '/forms/approval')) {
      permissions.push({
        route: '/forms/approval',
        can_view: 1, can_add: 0, can_edit: 0, can_update: 0, can_view_all: 0, can_delete: 0, can_approve: 0, can_print: 0, can_void: 0,
      });
    }

    // Read off the token, not the database -- being impersonated is a property of this
    // session, not of the account. Two admins can be acting as the same user at once, and
    // only their own tokens know it.
    user.impersonated_by = req.user.impersonated_by || null;

    res.json({ user, permissions });
  } catch (err) {
    next(err);
  }
});

// Accepts a data: URL (the client resizes/compresses to a small square JPEG via canvas
// before sending -- see client/src/utils/image.js) rather than a multipart file upload,
// so no disk storage / multer dependency is needed; capped well under the express.json
// body limit to keep rows small since this also gets cached in localStorage.
const AVATAR_DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,/;
const MAX_AVATAR_DATA_URL_LENGTH = 700_000;

router.put('/me/avatar', requireAuth, async (req, res, next) => {
  try {
    const { dataUrl } = req.body;
    if (typeof dataUrl !== 'string' || !AVATAR_DATA_URL_RE.test(dataUrl)) {
      return res.status(400).json({ error: 'Expected a PNG/JPEG/WebP image data URL' });
    }
    if (dataUrl.length > MAX_AVATAR_DATA_URL_LENGTH) {
      return res.status(400).json({ error: 'Image is too large' });
    }
    await pool.query('UPDATE users SET avatar_data = ? WHERE id = ?', [dataUrl, req.user.id]);
    res.json({ avatar_data: dataUrl });
  } catch (err) {
    next(err);
  }
});

// Self-service password change. Until this existed the only way a password changed was an
// admin editing it on Users & Permissions, so passwords were handed over verbally and never
// rotated.
const MIN_PASSWORD_LENGTH = 8;

router.put('/me/password', requireAuth, async (req, res, next) => {
  try {
    // An impersonating admin must not be able to change the password of the account they are
    // standing in -- that would turn "Log in as" into a permanent, unattributed takeover,
    // which is the exact hole impersonation was designed to avoid. Admins can still reset
    // anyone's password from Users & Permissions, where it is recorded against them.
    if (req.user.impersonated_by) {
      return res.status(403).json({
        error: 'You cannot change a password while signed in as another user. Use Users & Permissions instead.',
      });
    }

    const { current_password: currentPassword, new_password: newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Your current password and a new password are both required.' });
    }
    if (String(newPassword).length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Your new password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'Your new password must be different from your current one.' });
    }

    const [[user]] = await pool.query(
      'SELECT id, password_hash FROM users WHERE id = ? AND is_active = TRUE', [req.user.id]
    );
    if (!user) return res.status(404).json({ error: 'User not found.' });

    // Verified, never assumed: without this a borrowed unlocked screen is enough to lock the
    // real owner out of their own account.
    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) return res.status(403).json({ error: 'Your current password is incorrect.' });

    await pool.query(
      'UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?',
      [await bcrypt.hash(newPassword, 10), user.id]
    );
    // The value is deliberately a description, never the password or its hash -- audit_logs
    // is readable from the System Info tab on several pages.
    await pool.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, new_value, set_by_user_id)
       VALUES ('User', ?, 'Updated', 'password', 'changed by the account owner', ?)`,
      [user.id, user.id]
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/me/avatar', requireAuth, async (req, res, next) => {
  try {
    await pool.query('UPDATE users SET avatar_data = NULL WHERE id = ?', [req.user.id]);
    res.json({ avatar_data: null });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
