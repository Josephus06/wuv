const pool = require('../db');
const { leaveApproversFor } = require('./formNoters');

// Who notes and who approves a Leave Application -- by the filer's REPORTING LINE (asked
// 2026-10-19), the Supervisors list on each user in Users & Permissions (user_supervisors):
//
//   approver  the first people up the line who are "approver level": ticked Sales Business Unit,
//             on the General Managers list, or ticked "Approve leave" on a department
//   noter     the filer's direct supervisor(s), unless they are the approver -- then it goes
//             straight to approval
//
//   Account Officer -> Supervisor (notes) -> SBU (approves)
//   Supervisor      -> SBU (approves, nothing to note)
//   SBU             -> their supervisor, e.g. JICA (approves, nothing to note)
//
// Nobody approver level up the line: the General Managers approve. No supervisor at all: the
// department rule from before -- its ticked leave approvers, else the Forms Approval approvers
// (approvers: [] here means "whoever holds can_approve on that page"), straight to approval.
//
// Read fresh on every call: a supervisor list changes after a form is filed, and the form follows
// the line as it is now.

const MAX_DEPTH = 8;

async function generalManagers(q) {
  const [rows] = await q.query(
    `SELECT u.id, u.display_name FROM general_managers gm JOIN users u ON u.id = gm.user_id
      WHERE u.is_active = 1 ORDER BY u.display_name`);
  return rows;
}

async function supervisorsOf(q, userIds) {
  if (!userIds.length) return [];
  const [rows] = await q.query(
    `SELECT DISTINCT u.id, u.display_name, u.is_sales_business_unit
       FROM user_supervisors us JOIN users u ON u.id = us.supervisor_id
      WHERE us.user_id IN (?) AND u.is_active = 1 ORDER BY u.display_name`, [userIds]);
  return rows;
}

async function leaveTickedIds(q) {
  try {
    const [rows] = await q.query('SELECT DISTINCT user_id FROM department_ticket_approvers WHERE can_approve_leave = 1');
    return new Set(rows.map((r) => Number(r.user_id)));
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') return new Set();
    throw e;
  }
}

const strip = (u) => ({ id: Number(u.id), display_name: u.display_name });

// { noters: [{id, display_name}], approvers: [...], via: 'line' | 'gm' | 'department' }
async function leaveRoute(doc, q = pool) {
  const filerId = Number(doc.user_id);
  const direct = (await supervisorsOf(q, [filerId])).filter((u) => Number(u.id) !== filerId);
  if (!direct.length) {
    // No reporting line recorded: the department rule, straight to approval. Never the filer --
    // a department's own leave approver filing leave goes to the Forms Approval approvers.
    const approvers = (await leaveApproversFor(doc.department_id, q)).map(strip).filter((u) => u.id !== filerId);
    return { noters: [], approvers, via: 'department' };
  }

  const gms = await generalManagers(q);
  const gmIds = new Set(gms.map((g) => Number(g.id)));
  const ticked = await leaveTickedIds(q);
  const approverLevel = (u) => !!u.is_sales_business_unit || gmIds.has(Number(u.id)) || ticked.has(Number(u.id));

  // The filer is approver level themself (an SBU, a department's leave approver): whoever they
  // report to approves -- JICA for the SBUs -- with nothing to note.
  const [[filer]] = await q.query('SELECT id, is_sales_business_unit FROM users WHERE id = ?', [filerId]);
  if (filer && approverLevel(filer)) return { noters: [], approvers: direct.map(strip), via: 'line' };

  // Up the line a level at a time; the first level holding anyone approver level approves.
  const seen = new Set([filerId]);
  let level = direct;
  let approvers = [];
  for (let depth = 0; depth < MAX_DEPTH && level.length; depth += 1) {
    level.forEach((u) => seen.add(Number(u.id)));
    approvers = level.filter(approverLevel);
    if (approvers.length) {
      return {
        noters: depth === 0 ? [] : direct.map(strip),
        approvers: approvers.map(strip),
        via: 'line',
      };
    }
    level = (await supervisorsOf(q, level.map((u) => Number(u.id)))).filter((u) => !seen.has(Number(u.id)));
  }

  // Nobody approver level up the line: the General Managers approve, the direct supervisor notes.
  const gmApprovers = gms.filter((g) => Number(g.id) !== filerId).map(strip);
  const directIds = new Set(direct.map((u) => Number(u.id)));
  return {
    noters: gmApprovers.some((g) => directIds.has(g.id)) ? [] : direct.map(strip),
    approvers: gmApprovers,
    via: 'gm',
  };
}

module.exports = { leaveRoute };
