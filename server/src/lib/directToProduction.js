// "Direct to Production" on a job type (job_types.is_direct_to_prod): a Job Order of that type has no
// layout to make -- installation, mobilization, site inspection, accessories -- so it skips Design and
// the artist altogether and goes straight to Production, Pending for Scheduling (asked 2026-10-08).
//
// It lands exactly where Sales's sign-off of a designed JO puts one (routes/jobOrders.js
// approve-sales): status Released, sub status Approved, production_stage pending_for_scheduling.
// Forward to Design only acts on a JO still at sub status Pending, so a released one cannot be
// forwarded by mistake.
const RELEASED = { status: 'Released', sub_status: 'Approved', production_stage: 'pending_for_scheduling' };

async function isDirectToProduction(conn, jobTypeId) {
  if (!jobTypeId) return false;
  const [[jt]] = await conn.query('SELECT is_direct_to_prod FROM job_types WHERE id = ?', [jobTypeId]);
  return !!(jt && Number(jt.is_direct_to_prod));
}

// Releases a just-created Job Order to Production when its job type is Direct to Production.
// Runs inside the caller's transaction. Returns true when it released the JO.
async function releaseIfDirectToProduction(conn, { jobOrderId, jobTypeId, userId, fromStatus = null, fromSubStatus = null }) {
  if (!(await isDirectToProduction(conn, jobTypeId))) return false;
  await conn.query(
    `UPDATE job_orders SET status = ?, sub_status = ?, production_stage = ?, date_forwarded = NOW(), updated_at = NOW()
      WHERE id = ?`,
    [RELEASED.status, RELEASED.sub_status, RELEASED.production_stage, jobOrderId],
  );
  for (const [field, oldValue, newValue] of [
    ['status', fromStatus, RELEASED.status],
    ['sub_status', fromSubStatus, RELEASED.sub_status],
    ['production_stage', null, `${RELEASED.production_stage} (job type is Direct to Production)`],
  ]) {
    await conn.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES ('JobOrder', ?, 'Updated', ?, ?, ?, ?)`,
      [jobOrderId, field, oldValue, newValue, userId],
    );
  }
  return true;
}

// Job orders of this type made BEFORE it was marked Direct to Production, still waiting in Design:
// no production stage yet, no artist, not released, not cancelled, not on hold. Ticking the box used
// to leave them there -- CNC-ACCESSORIES was ticked on 2026-10-15 and NSSO-INT-1951 / NSSO-INT-1963's
// nine NSJOs stayed "For Design Supervisor". Releases each as a new one would be; returns their numbers.
// dryRun lists them without changing anything.
async function releaseWaitingForJobType(conn, jobTypeId, userId, { dryRun = false } = {}) {
  if (!(await isDirectToProduction(conn, jobTypeId))) return [];
  const [jos] = await conn.query(
    `SELECT id, job_order_no, status, sub_status FROM job_orders
      WHERE job_type_id = ? AND production_stage IS NULL AND artist_id IS NULL
        AND (status IS NULL OR status NOT IN ('Cancelled', 'Released'))
        AND COALESCE(is_on_hold, 0) = 0
      ORDER BY id`, [jobTypeId]);
  if (!dryRun) {
    for (const jo of jos) {
      await releaseIfDirectToProduction(conn, { jobOrderId: jo.id, jobTypeId, userId, fromStatus: jo.status, fromSubStatus: jo.sub_status });
    }
  }
  return jos.map((j) => j.job_order_no);
}

module.exports = { isDirectToProduction, releaseIfDirectToProduction, releaseWaitingForJobType, RELEASED };
