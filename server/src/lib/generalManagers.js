const pool = require('../db');
const { isSystemAdmin } = require('../middleware/auth');

// Who is a General Manager. Two places say so -- the General Managers list (general_managers) and an
// account whose type is 'General Manager' -- and either is enough, as for the fleet reminders
// (lib/fleet.js).
async function generalManagerIds(q = pool) {
  const [a] = await q.query('SELECT u.id FROM general_managers gm JOIN users u ON u.id = gm.user_id WHERE u.is_active = 1').catch(() => [[]]);
  const [b] = await q.query("SELECT id FROM users WHERE account_type = 'General Manager' AND is_active = 1");
  return [...new Set([...a, ...b].map((r) => Number(r.id)))];
}

async function isGeneralManager(userId, q = pool) {
  return (await generalManagerIds(q)).includes(Number(userId));
}

// GM approval (asked 2026-10-31): an RMA / RMA-Installation NSSO, and an RWIP or RFQC job order, is
// approved by a General Manager -- or a System Admin -- and by no other permission.
async function mayGmApprove(userId, q = pool) {
  return (await isSystemAdmin(userId)) || isGeneralManager(userId, q);
}

// Tell the GMs something is waiting on them. Called after the commit; a failed notice never undoes
// the record.
async function notifyGmApproval({ title, message = null, relatedType, relatedId }, actorId) {
  try {
    const { insertFor } = require('./approvalNotifications');
    await insertFor(await generalManagerIds(), { type: 'gm_approval', title, message, relatedType, relatedId }, actorId);
  } catch (err) { console.error('[notifications] GM approval:', err.message); }
}

module.exports = { generalManagerIds, isGeneralManager, mayGmApprove, notifyGmApproval };
