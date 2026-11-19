const express = require('express');
// The topbar company switcher: dashboard figures count only the chosen company's branches.
const { scopedTable } = require('../lib/requestScope');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { DESIGN_QUEUE_STATUS } = require('../lib/designSupervisorVisibility');

const router = express.Router();

// Sales Orders never carry a "paid" flag or link to an invoice (there's no invoices
// table in this build) -- 'billed' is the closest real status to "paid", so that's what
// Total Paid/Unpaid below are built on.
const PAID_STATUS = 'billed';
const UNPAID_STATUSES = ['pending_for_jo', 'jo_in_process', 'pending_delivery', 'partially_delivered', 'pending_billing', 'pending_billing_partially_delivered'];

// Resolves which sales-role dashboard (if any) the requesting user should see, and the
// set of employee_ids whose data they're allowed to see. Looked up fresh from the DB on
// every request rather than trusted from the JWT, matching the pattern already used for
// the estimate-approval permission check elsewhere in this app -- a role flag or the
// supervisor_id link can change after the token was issued.
async function resolveScope(userId) {
  const [[me]] = await pool.query(
    `SELECT u.id, u.employee_id, u.account_type, u.is_account_officer, u.is_supervisor, u.is_sales_manager, u.is_design_supervisor
     FROM users u WHERE u.id = ?`,
    [userId]
  );
  if (!me) return { role: 'admin', employeeIds: [] };

  // A "System Admin" account type always gets the org-wide Admin view, even if the sales
  // role checkboxes also happen to be set on it -- those two things are independent
  // fields in the Account Type step, and Account Type is the deliberate role signal.
  if (me.account_type === 'System Admin') {
    return { role: 'admin', employeeIds: [] };
  }

  // Design Supervisor takes priority over the sales-role checks below -- it's a
  // production/design role, not a sales one, even though nothing stops both flags being
  // set on the same account in principle.
  if (me.is_design_supervisor) {
    return { role: 'design_supervisor', employeeIds: me.employee_id ? [me.employee_id] : [] };
  }

  // Artist is purely the free-text Account Type value (no dedicated boolean flag exists
  // for it, same as there's none for most non-sales roles) -- checked after Design
  // Supervisor since a Design Supervisor's own Account Type is often also "Artist".
  if (me.account_type === 'Artist') {
    return { role: 'artist', employeeIds: me.employee_id ? [me.employee_id] : [] };
  }

  if (me.is_sales_manager) {
    // Sales Manager: every sales user's data (Account Officers + Supervisors), not just
    // people directly under this one manager -- there's no manager-level tree, only the
    // one-level Supervisor -> Account Officer link.
    const [rows] = await pool.query(
      `SELECT u.id, u.display_name, u.employee_id
       FROM users u WHERE u.is_account_officer = TRUE OR u.is_supervisor = TRUE`
    );
    return { role: 'sales_manager', reps: rows, employeeIds: rows.map((r) => r.employee_id).filter(Boolean) };
  }

  if (me.is_supervisor) {
    // Supervisor: themself + every Account Officer whose supervisor_id points at them.
    const [rows] = await pool.query(
      `SELECT u.id, u.display_name, u.employee_id
       FROM users u WHERE u.supervisor_id = ? OR u.id = ?`,
      [userId, userId]
    );
    return { role: 'supervisor', reps: rows, employeeIds: rows.map((r) => r.employee_id).filter(Boolean) };
  }

  if (me.is_account_officer) {
    return {
      role: 'account_officer',
      reps: [{ id: me.id, display_name: null, employee_id: me.employee_id }],
      employeeIds: me.employee_id ? [me.employee_id] : [],
    };
  }

  return { role: 'admin', employeeIds: [] };
}

function monthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  return start;
}

// Last 6 months of sales_orders total_amount, oldest first -- feeds the stat-card
// sparklines. `employeeIds` narrows to specific reps; omit/empty for the org-wide trend.
async function salesTrend(employeeIds) {
  const now = new Date();
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1).toISOString().slice(0, 10);
  const scoped = employeeIds && employeeIds.length;
  const placeholders = scoped ? employeeIds.map(() => '?').join(', ') : '';
  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(date_created, '%Y-%m') AS ym, COALESCE(SUM(total_amount), 0) AS amount
     FROM sales_orders
     WHERE date_created >= ? ${scoped ? `AND sales_rep_id IN (${placeholders})` : ''}
     GROUP BY ym ORDER BY ym`,
    scoped ? [sixMonthsAgo, ...employeeIds] : [sixMonthsAgo]
  );
  const byMonth = Object.fromEntries(rows.map((r) => [r.ym, Number(r.amount)]));
  const out = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    out.push(byMonth[key] || 0);
  }
  return out;
}

async function repMetrics(employeeIds) {
  if (!employeeIds.length) {
    return {
      weightedSales: { count: 0, amount: 0 },
      kpi: { winRate: 0, estimatesCreated: 0, estimatesApproved: 0 },
      paid: { count: 0, amount: 0 },
      unpaid: { count: 0, amount: 0 },
      avgDealSize: 0,
      pipeline: [],
      trend: [0, 0, 0, 0, 0, 0],
      rings: [],
    };
  }
  const placeholders = employeeIds.map(() => '?').join(', ');
  const monthStart = monthRange();

  const [[weighted]] = await pool.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS amount
     FROM ${scopedTable('sales_orders')} sales_orders WHERE sales_rep_id IN (${placeholders}) AND date_created >= ?`,
    [...employeeIds, monthStart]
  );

  const [[estTotals]] = await pool.query(
    `SELECT COUNT(*) AS created, SUM(status = 'approved') AS approved
     FROM ${scopedTable('estimates')} estimates WHERE sales_rep_id IN (${placeholders})`,
    employeeIds
  );

  const [[paid]] = await pool.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS amount
     FROM ${scopedTable('sales_orders')} sales_orders WHERE sales_rep_id IN (${placeholders}) AND status = ?`,
    [...employeeIds, PAID_STATUS]
  );

  const unpaidPlaceholders = UNPAID_STATUSES.map(() => '?').join(', ');
  const [[unpaid]] = await pool.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS amount
     FROM ${scopedTable('sales_orders')} sales_orders WHERE sales_rep_id IN (${placeholders}) AND status IN (${unpaidPlaceholders})`,
    [...employeeIds, ...UNPAID_STATUSES]
  );

  const [[allTime]] = await pool.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS amount
     FROM ${scopedTable('sales_orders')} sales_orders WHERE sales_rep_id IN (${placeholders})`,
    employeeIds
  );

  const [pipeline] = await pool.query(
    `SELECT status, COUNT(*) AS count FROM ${scopedTable('estimates')} estimates WHERE sales_rep_id IN (${placeholders}) GROUP BY status`,
    employeeIds
  );

  const created = Number(estTotals?.created || 0);
  const approved = Number(estTotals?.approved || 0);
  const trend = await salesTrend(employeeIds);
  const winRate = created ? Number(((approved / created) * 100).toFixed(1)) : 0;
  const paidAmt = Number(paid.amount);
  const unpaidAmt = Number(unpaid.amount);
  const pipelineRows = pipeline.map((p) => ({ status: p.status, count: Number(p.count) }));
  const pipelineTotal = pipelineRows.reduce((s, p) => s + p.count, 0);
  const pipelineApproved = pipelineRows.find((p) => p.status === 'approved')?.count || 0;

  return {
    weightedSales: { count: Number(weighted.count), amount: Number(weighted.amount) },
    kpi: { winRate, estimatesCreated: created, estimatesApproved: approved },
    paid: { count: Number(paid.count), amount: paidAmt },
    unpaid: { count: Number(unpaid.count), amount: unpaidAmt },
    avgDealSize: allTime.count ? Number((allTime.amount / allTime.count).toFixed(2)) : 0,
    pipeline: pipelineRows,
    trend,
    rings: [
      { label: 'Win Rate', value: winRate, color: '#4A6329' },
      { label: 'Paid Ratio', value: (paidAmt + unpaidAmt) > 0 ? Math.round((paidAmt / (paidAmt + unpaidAmt)) * 100) : 0, color: '#C9A227' },
      { label: 'Pipeline Approved', value: pipelineTotal ? Math.round((pipelineApproved / pipelineTotal) * 100) : 0, color: '#3E8577' },
    ],
  };
}

async function adminMetrics() {
  const [[activeUsers]] = await pool.query('SELECT COUNT(*) AS count FROM users WHERE is_active = TRUE');
  const [[userTotals]] = await pool.query('SELECT COUNT(*) AS total FROM users');
  const [[estRingTotals]] = await pool.query(`SELECT COUNT(*) AS total, SUM(status = 'approved') AS approved FROM estimates`);

  const [topCustomers] = await pool.query(
    `SELECT c.id, c.name, COUNT(*) AS order_count, COALESCE(SUM(so.total_amount), 0) AS amount
     FROM ${scopedTable('sales_orders')} so JOIN customers c ON c.id = so.customer_id
     GROUP BY c.id, c.name ORDER BY amount DESC LIMIT 5`
  );

  const [trendingJobTypes] = await pool.query(
    `SELECT jt.id, jt.display_name, COUNT(*) AS uses
     FROM sales_order_lines sol JOIN job_types jt ON jt.id = sol.job_type_id
     WHERE sol.job_type_id IS NOT NULL
     GROUP BY jt.id, jt.display_name ORDER BY uses DESC LIMIT 5`
  );

  const [salesByDepartment] = await pool.query(
    `SELECT d.id, d.name, COUNT(*) AS order_count, COALESCE(SUM(so.total_amount), 0) AS amount
     FROM ${scopedTable('sales_orders')} so
     JOIN employees e ON e.id = so.sales_rep_id
     JOIN departments d ON d.id = e.department_id
     WHERE d.name LIKE 'Sales%'
     GROUP BY d.id, d.name ORDER BY d.name`
  );

  const [[pendingApprovals]] = await pool.query(
    `SELECT COUNT(*) AS count FROM ${scopedTable('estimates')} estimates WHERE status IN ('pending_supervisor_approval', 'pending_customer_approval')`
  );

  const monthStart = monthRange();
  const [[salesThisMonth]] = await pool.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS amount FROM ${scopedTable('sales_orders')} sales_orders WHERE date_created >= ?`,
    [monthStart]
  );
  const [[orderPaidThisMonth]] = await pool.query(
    `SELECT COUNT(*) AS count, SUM(status = ?) AS paid FROM ${scopedTable('sales_orders')} sales_orders WHERE date_created >= ?`,
    [PAID_STATUS, monthStart]
  );

  // estimates.total_amount is a stale/legacy column (no longer written to -- the wizard
  // now computes an estimate's total live from its job orders' gross_amount, same as
  // EstimateView does), so it's re-derived here via the same rollup instead of trusted.
  const [recentEstimates] = await pool.query(
    `SELECT e.id, e.estimate_no, e.status, e.created_at, c.name AS customer_name,
            COALESCE(jo.total, 0) AS total_amount
     FROM ${scopedTable('estimates')} e
     JOIN customers c ON c.id = e.customer_id
     LEFT JOIN (
       SELECT estimate_id, SUM(gross_amount) AS total FROM estimate_job_orders GROUP BY estimate_id
     ) jo ON jo.estimate_id = e.id
     ORDER BY e.created_at DESC LIMIT 6`
  );

  const trend = await salesTrend();

  return {
    activeUsers: Number(activeUsers.count),
    topCustomers: topCustomers.map((c) => ({ id: c.id, name: c.name, orderCount: Number(c.order_count), amount: Number(c.amount) })),
    trendingJobTypes: trendingJobTypes.map((j) => ({ id: j.id, name: j.display_name, uses: Number(j.uses) })),
    salesByDepartment: salesByDepartment.map((d) => ({ id: d.id, name: d.name, orderCount: Number(d.order_count), amount: Number(d.amount) })),
    pendingApprovals: Number(pendingApprovals.count),
    salesThisMonth: { count: Number(salesThisMonth.count), amount: Number(salesThisMonth.amount) },
    trend,
    recentEstimates: recentEstimates.map((r) => ({
      id: r.id, estimateNo: r.estimate_no, status: r.status, totalAmount: Number(r.total_amount || 0),
      customerName: r.customer_name, createdAt: r.created_at,
    })),
    rings: [
      { label: 'Users Active', value: userTotals.total ? Math.round((Number(activeUsers.count) / userTotals.total) * 100) : 0, color: '#4A6329' },
      { label: 'Estimates Approved', value: estRingTotals.total ? Math.round((Number(estRingTotals.approved || 0) / estRingTotals.total) * 100) : 0, color: '#C9A227' },
      { label: 'Orders Paid', value: orderPaidThisMonth.count ? Math.round((Number(orderPaidThisMonth.paid || 0) / orderPaidThisMonth.count) * 100) : 0, color: '#3E8577' },
    ],
  };
}

// A JO counts as "active" on the design/artist board once it has an artist and hasn't
// gone back to Sales/production yet -- covers the initial pass and any revision round,
// deliberately excluding "For Design Supervisor" (no artist yet, that's the assignment
// queue below, not a schedule row) and anything Released/Cancelled.
const ARTIST_ACTIVE_SUB_STATUSES = ['For Artist', 'For Artist (Revision)', 'Sales Approval'];

async function scheduleRows(whereSql, params) {
  const [rows] = await pool.query(
    `SELECT jo.id, jo.job_order_no, jo.description, jo.sub_status, jo.planned_start_at, jo.planned_end_at,
            jo.layout_started_at, jo.layout_ended_at, jo.artist_id,
            c.name AS customer_name, CONCAT(ar.first_name, ' ', ar.last_name) AS artist_name,
            EXISTS(SELECT 1 FROM job_order_layout_sessions s WHERE s.job_order_id = jo.id AND s.ended_at IS NULL) AS is_running
     FROM job_orders jo
     LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
     LEFT JOIN customers c ON c.id = so.customer_id
     LEFT JOIN employees ar ON ar.id = jo.artist_id
     ${whereSql}
     ORDER BY jo.planned_start_at IS NULL, jo.planned_start_at ASC`,
    params
  );
  return rows.map((r) => ({
    id: r.id, jobOrderNo: r.job_order_no, description: r.description, subStatus: r.sub_status,
    plannedStartAt: r.planned_start_at, plannedEndAt: r.planned_end_at,
    layoutStartedAt: r.layout_started_at, layoutEndedAt: r.layout_ended_at,
    customerName: r.customer_name, artistId: r.artist_id, artistName: r.artist_name,
    isRunning: !!r.is_running,
  }));
}

async function designSupervisorMetrics() {
  const [[pendingAssignment]] = await pool.query(
    `SELECT COUNT(*) AS count FROM job_orders WHERE status = ? AND sub_status = 'For Design Supervisor'`,
    [DESIGN_QUEUE_STATUS]
  );

  const [[notStarted]] = await pool.query(
    `SELECT COUNT(*) AS count FROM job_orders
     WHERE sub_status IN ('For Artist', 'For Artist (Revision)') AND layout_started_at IS NULL`
  );

  const [[inProgress]] = await pool.query(
    `SELECT COUNT(DISTINCT jo.id) AS count
     FROM job_orders jo JOIN job_order_layout_sessions s ON s.job_order_id = jo.id AND s.ended_at IS NULL`
  );

  const [[pendingSalesApproval]] = await pool.query(
    `SELECT COUNT(*) AS count FROM job_orders WHERE sub_status = 'Sales Approval'`
  );

  const subStatusPlaceholders = ARTIST_ACTIVE_SUB_STATUSES.map(() => '?').join(', ');
  const schedule = await scheduleRows(
    `WHERE jo.artist_id IS NOT NULL AND jo.sub_status IN (${subStatusPlaceholders})`,
    ARTIST_ACTIVE_SUB_STATUSES
  );

  const [workload] = await pool.query(
    `SELECT jo.artist_id, CONCAT(ar.first_name, ' ', ar.last_name) AS name, COUNT(*) AS count
     FROM job_orders jo JOIN employees ar ON ar.id = jo.artist_id
     WHERE jo.artist_id IS NOT NULL AND jo.sub_status IN (${subStatusPlaceholders})
     GROUP BY jo.artist_id, name ORDER BY count DESC`,
    ARTIST_ACTIVE_SUB_STATUSES
  );

  // "Overdue" here means: currently running (an open Play session) and past its own
  // Planned End -- a simpler, dashboard-level proxy for the exact
  // actualSeconds-vs-allotted comparison AssignedJobOrderRun.jsx does live for one JO at
  // a time; good enough for "which of these needs attention right now".
  const [overdue] = await pool.query(
    `SELECT jo.id, jo.job_order_no, jo.planned_end_at, CONCAT(ar.first_name, ' ', ar.last_name) AS artist_name
     FROM job_orders jo
     JOIN job_order_layout_sessions s ON s.job_order_id = jo.id AND s.ended_at IS NULL
     LEFT JOIN employees ar ON ar.id = jo.artist_id
     WHERE jo.planned_end_at IS NOT NULL AND jo.planned_end_at < NOW()
     GROUP BY jo.id, jo.job_order_no, jo.planned_end_at, ar.first_name, ar.last_name
     ORDER BY jo.planned_end_at ASC`
  );

  const notStartedCount = Number(notStarted.count);
  const inProgressCount = Number(inProgress.count);
  const pendingSalesApprovalCount = Number(pendingSalesApproval.count);
  const activeCount = notStartedCount + inProgressCount;

  return {
    pendingAssignment: Number(pendingAssignment.count),
    notStarted: notStartedCount,
    inProgress: inProgressCount,
    pendingSalesApproval: pendingSalesApprovalCount,
    schedule,
    workload: workload.map((w) => ({ artistId: w.artist_id, name: w.name, count: Number(w.count) })),
    overdue: overdue.map((o) => ({ id: o.id, jobOrderNo: o.job_order_no, plannedEndAt: o.planned_end_at, artistName: o.artist_name })),
    rings: [
      { label: 'In Progress', value: activeCount ? Math.round((inProgressCount / activeCount) * 100) : 0, color: '#4A6329' },
      { label: 'Sales-Ready', value: (inProgressCount + pendingSalesApprovalCount) ? Math.round((pendingSalesApprovalCount / (inProgressCount + pendingSalesApprovalCount)) * 100) : 0, color: '#C9A227' },
    ],
  };
}

async function artistMetrics(employeeId) {
  if (!employeeId) {
    return { active: 0, notStarted: 0, completedThisMonth: 0, avgPerformance: null, schedule: [], rings: [] };
  }

  const [[active]] = await pool.query(
    `SELECT COUNT(*) AS count FROM job_orders WHERE artist_id = ? AND sub_status IN ('For Artist', 'For Artist (Revision)')`,
    [employeeId]
  );
  const [[notStarted]] = await pool.query(
    `SELECT COUNT(*) AS count FROM job_orders
     WHERE artist_id = ? AND sub_status IN ('For Artist', 'For Artist (Revision)') AND layout_started_at IS NULL`,
    [employeeId]
  );
  const monthStart = monthRange();
  const [[completedThisMonth]] = await pool.query(
    `SELECT COUNT(*) AS count FROM job_orders WHERE artist_id = ? AND layout_ended_at >= ?`,
    [employeeId, monthStart]
  );

  // Performance % per completed JO this month = allotted (minutes_consume x layout_qty)
  // / actual (sum of that JO's session durations) x 100 -- same formula
  // AssignedJobOrderRun.jsx computes live for one JO; averaged here across all of this
  // artist's completions this month for a single at-a-glance number.
  const [completedRows] = await pool.query(
    `SELECT jo.id, jo.layout_qty, pjt.minutes_consume,
            (SELECT COALESCE(SUM(TIMESTAMPDIFF(SECOND, s.started_at, s.ended_at)), 0)
             FROM job_order_layout_sessions s WHERE s.job_order_id = jo.id AND s.ended_at IS NOT NULL) AS actual_seconds
     FROM job_orders jo
     LEFT JOIN pms_job_types pjt ON pjt.id = jo.layout_job_type_id
     WHERE jo.artist_id = ? AND jo.layout_ended_at >= ?`,
    [employeeId, monthStart]
  );
  const performances = completedRows
    .map((r) => {
      const allotted = Number(r.minutes_consume || 0) * Number(r.layout_qty || 1) * 60;
      const actual = Number(r.actual_seconds || 0);
      return allotted > 0 && actual > 0 ? (allotted / actual) * 100 : null;
    })
    .filter((p) => p !== null);
  const avgPerformance = performances.length
    ? Number((performances.reduce((s, p) => s + p, 0) / performances.length).toFixed(1))
    : null;

  const schedule = await scheduleRows(
    `WHERE jo.artist_id = ? AND jo.sub_status IN ('For Artist', 'For Artist (Revision)')`,
    [employeeId]
  );

  const activeCount = Number(active.count);
  const notStartedCount = Number(notStarted.count);

  return {
    active: activeCount,
    notStarted: notStartedCount,
    completedThisMonth: Number(completedThisMonth.count),
    avgPerformance,
    schedule,
    rings: [
      ...(avgPerformance !== null ? [{ label: 'Avg Performance', value: Math.max(0, Math.min(100, Math.round(avgPerformance))), color: '#4A6329' }] : []),
      { label: 'Started Ratio', value: activeCount ? Math.round(((activeCount - notStartedCount) / activeCount) * 100) : 0, color: '#C9A227' },
    ],
  };
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const scope = await resolveScope(req.user.id);

    if (scope.role === 'admin') {
      const metrics = await adminMetrics();
      return res.json({ role: 'admin', ...metrics });
    }

    if (scope.role === 'design_supervisor') {
      const metrics = await designSupervisorMetrics();
      return res.json({ role: 'design_supervisor', ...metrics });
    }

    if (scope.role === 'artist') {
      const metrics = await artistMetrics(scope.employeeIds[0]);
      return res.json({ role: 'artist', ...metrics });
    }

    const summary = await repMetrics(scope.employeeIds);

    let byRep = [];
    if (scope.role !== 'account_officer') {
      byRep = await Promise.all(scope.reps.map(async (r) => ({
        userId: r.id,
        name: r.display_name,
        ...(await repMetrics(r.employee_id ? [r.employee_id] : [])),
      })));
    }

    res.json({ role: scope.role, summary, byRep });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
// Reused by the chatbot's data-Q&A intents (server/src/lib/chatbotIntents.js) so "what's
// my weighted sales this month" answers with the exact same number this Dashboard
// itself shows, rather than a second, possibly-drifting copy of the same query.
module.exports.resolveScope = resolveScope;
module.exports.repMetrics = repMetrics;
