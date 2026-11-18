const pool = require('../db');
const { releaseByMonthForEmployee } = require('./commissionRelease');

// Commission report (Commission module > Reports > Commission): one sales rep, one year,
// twelve month rows. Every figure is defined by the client:
//
//   Quota                     -- the rep's employee_quota for that month
//   Weighted Sales            -- SUM(net of tax) of ALL the rep's JOs that month (by SO date)
//   %                         -- Weighted Sales / Quota * 100
//   Estimated Commission      -- the rep's commission scheme looked up at Weighted Sales
//   Total Amount of JOs w/     \  SUM(net of tax) of only the rep's JOs whose own GP rate
//     passing GP rate         /   meets the job type's defined passing GP rate
//   Expected Commission       -- the scheme looked up at that passing-GP total
//   Confirmed Commission      -- (paid invoice of passing JOs / passing total) * Expected
//   Released Commission       -- TODO: needs a not-yet-built source; 0 for now
//   Unpaid Commission         -- Confirmed - Released
//
// Which scheme applies is decided by the rep's role flag on their user account, not chosen
// -- an Account Officer is read against the Account Officer scheme, a Supervisor against
// Sales Supervisor, and so on. Passing GP is the job type's Head-Office rate (gp_rate_head),
// matching the report's Head Office context.
//
// A rep's sales are their whole TEAM's, not just their own: a supervisor's Weighted Sales
// and passing-GP total roll up their own JOs plus every subordinate's, down the reporting
// tree (users.supervisor_id). A supervisor with two account officers under them is read at
// own + both AOs; a manager rolls up their supervisors and those supervisors' AOs; an
// account officer (no one beneath them) rolls up to just their own. This is why the scheme
// is looked up at a team-sized number.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Role flag -> scheme name, most senior first. A rep carrying several flags is read
// against the most senior scheme they hold.
const ROLE_TO_SCHEME = [
  { flag: 'is_sales_business_unit', scheme: 'SBU Head' },
  { flag: 'is_sales_manager', scheme: 'Sales Manager' },
  { flag: 'is_supervisor', scheme: 'Sales Supervisor' },
  { flag: 'is_account_officer', scheme: 'Account Officer' },
];

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

// A scheme is a ladder of Total-Weighted-Sales brackets -> a fixed commission amount. Below the
// first bracket pays nothing; above the last earns the top bracket's amount (the ladder doesn't cap
// what it recognises).
//
// The ladders have GAPS -- Sales Manager runs ...-10,500,000.00 then 10,600,000.01-..., so
// 10,500,000.01 to 10,600,000.00 is in no bracket. An amount in a gap takes the NEXT bracket up, as
// the source does (asked 2026-10-15): JICA EMMANUEL C. WU's January passing total 10,506,802.95 reads
// 31,800 there, and his August 12,508,863.56 reads 37,800. This used to pay 0 in a gap.
function lookupCommission(brackets, amount) {
  const amt = Number(amount) || 0;
  if (amt <= 0 || !brackets.length) return 0;
  const ladder = [...brackets].sort((x, y) => Number(x.max_weighted_sales) - Number(y.max_weighted_sales));
  if (amt < Number(ladder[0].min_weighted_sales)) return 0;
  const hit = ladder.find((b) => amt <= Number(b.max_weighted_sales));
  return Number((hit || ladder[ladder.length - 1]).commission_amount) || 0;
}

// The rep plus everyone reporting up to them, as a set of employee ids -- what their team
// weighted-sales rolls up. Walks the user_supervisors graph downward from the rep's own
// user; a rep with no user account (or no reports) rolls up to just themselves.
async function getTeamEmployeeIds(employeeId, rootUserId) {
  const team = new Set([Number(employeeId)]);
  if (!rootUserId) return [...team];

  // One pass over the active reporting graph, then BFS from the root user downward. Read
  // from user_supervisors rather than users.supervisor_id: a rep may report to several
  // supervisors, so this is a graph, not a tree, and a rep with two supervisors rolls up
  // into BOTH of their team totals. `visitedUsers` keeps a rep counted once per team even
  // when two paths reach them.
  const [links] = await pool.query(
    `SELECT u.id, u.employee_id, us.supervisor_id
       FROM user_supervisors us
       JOIN users u ON u.id = us.user_id
      WHERE u.is_active = TRUE`
  );
  const childrenBySupervisor = new Map();
  for (const u of links) {
    if (u.supervisor_id == null) continue;
    if (!childrenBySupervisor.has(u.supervisor_id)) childrenBySupervisor.set(u.supervisor_id, []);
    childrenBySupervisor.get(u.supervisor_id).push(u);
  }
  const queue = [rootUserId];
  const visitedUsers = new Set([rootUserId]);
  while (queue.length) {
    const uid = queue.shift();
    for (const child of childrenBySupervisor.get(uid) || []) {
      if (visitedUsers.has(child.id)) continue; // guard against any accidental cycle
      visitedUsers.add(child.id);
      if (child.employee_id != null) team.add(Number(child.employee_id));
      queue.push(child.id);
    }
  }
  return [...team];
}

// The sales divisions a Sales Business Unit owns -- its commission rolls up every sale in
// these, division-wide, on top of the reporting-tree rollup above.
async function getSbuDivisionIds(userId) {
  if (!userId) return [];
  const [rows] = await pool.query('SELECT sales_division_id FROM user_sales_divisions WHERE user_id = ?', [userId]);
  return rows.map((r) => r.sales_division_id);
}

// Whose sales a rep is read at -- the WHERE both the monthly report and its JO detail use.
//
//   Sales Manager   every sales order in every division except the branches (asked 2026-10-15:
//                   JICA EMMANUEL C. WU's January read 9,833,453.53 here, his own reporting tree,
//                   against the source's 12,954,199.85 -- which is the whole company's 13,645,932.27
//                   less Branch - Ayala and Branch-SM_Cebu, to the centavo). Marketing, Support and
//                   E-Commerce count; a division whose name starts "Branch" does not.
//   SBU Head        their reporting team's orders plus every order in the divisions they own
//   anyone else     their reporting team's orders (sales_rep_id in the team)
const BRANCH_DIVISIONS_SQL = "SELECT id FROM sales_divisions WHERE name LIKE 'Branch%'";
async function salesScope(employeeId, user) {
  const teamEmployeeIds = await getTeamEmployeeIds(employeeId, user ? user.id : null);
  const isManager = !!(user && user.is_sales_manager && !user.is_sales_business_unit);
  if (isManager) {
    return {
      sql: `(so.sales_division_id IS NULL OR so.sales_division_id NOT IN (${BRANCH_DIVISIONS_SQL}))`,
      params: [], teamEmployeeIds, sbuDivisionIds: [], companyWide: true,
    };
  }
  const sbuDivisionIds = user && user.is_sales_business_unit ? await getSbuDivisionIds(user.id) : [];
  if (sbuDivisionIds.length) {
    return { sql: '(so.sales_rep_id IN (?) OR so.sales_division_id IN (?))', params: [teamEmployeeIds, sbuDivisionIds], teamEmployeeIds, sbuDivisionIds };
  }
  return { sql: 'so.sales_rep_id IN (?)', params: [teamEmployeeIds], teamEmployeeIds, sbuDivisionIds };
}

function resolveScheme(user, brackets) {
  if (!user) return { schemeName: null, brackets: [] };
  const match = ROLE_TO_SCHEME.find((r) => user[r.flag]);
  return { schemeName: match ? match.scheme : null, brackets: match ? brackets : [] };
}

async function loadSchemeBrackets(schemeName) {
  if (!schemeName) return [];
  const [[scheme]] = await pool.query('SELECT id FROM commission_schemes WHERE name = ? AND is_active = TRUE LIMIT 1', [schemeName]);
  if (!scheme) return [];
  const [brackets] = await pool.query(
    `SELECT min_weighted_sales, max_weighted_sales, commission_amount, commission_rate
     FROM commission_scheme_brackets WHERE commission_scheme_id = ? ORDER BY sort_order, id`,
    [scheme.id]
  );
  return brackets;
}

async function buildCommissionReport(employeeId, year, filters = {}) {
  const [[employee]] = await pool.query(
    `SELECT e.id, CONCAT(e.first_name, ' ', e.last_name) AS name FROM employees e WHERE e.id = ?`,
    [employeeId]
  );
  if (!employee) return null;

  // The rep's user account carries both the role flag (which scheme) and, for an SBU, its
  // owned divisions -- fetch it once.
  const [[user]] = await pool.query(
    `SELECT id, is_account_officer, is_supervisor, is_sales_manager, is_sales_business_unit
     FROM users WHERE employee_id = ? AND is_active = TRUE ORDER BY id LIMIT 1`,
    [employeeId]
  );
  const { schemeName } = resolveScheme(user, []);
  const brackets = await loadSchemeBrackets(schemeName);
  // Whose orders count (salesScope): the reporting team; an SBU's divisions too; a Sales Manager the
  // whole company less the branches. Attributed by the SALES ORDER's rep, as the source does.
  const scope = await salesScope(employeeId, user);
  const { teamEmployeeIds, sbuDivisionIds } = scope;
  const whereParts = [scope.sql];
  const params = [...scope.params];
  whereParts.push('YEAR(so.date_created) = ?');
  params.push(year);
  // Cancelled sales orders never count toward weighted sales (or anything downstream).
  whereParts.push("(so.status IS NULL OR so.status <> 'cancelled')");
  // Nor does a line whose job order was cancelled -- the SO's own total already leaves it out
  // (routes/salesOrders.js LIVE_LINE), and Weighted Sales must agree (SO-70642's 250 delivery fee,
  // 2026-10-22).
  whereParts.push("(jo.id IS NULL OR jo.status <> 'Cancelled')");
  if (filters.salesDivisionId) { whereParts.push('so.sales_division_id = ?'); params.push(filters.salesDivisionId); }

  // Weighted sales is every (non-cancelled) sales-order LINE -- including lines on orders that
  // have not had their job order created yet (status pending_for_jo). So the base table is
  // sales_order_lines, with the job order left-joined in only for the passing-GP / paid logic.
  const [lines] = await pool.query(
    `SELECT jo.id AS jo_id, MONTH(so.date_created) AS month,
            so.sales_division_id, sd.name AS division_name,
            COALESCE(sol.net_of_tax, 0) AS net_of_tax,
            -- Some orders (esp. "... WITH INSTALLATION") carry GP only at the order level, not
            -- per line, so sol.gp_rate lands 0; fall back to the order's actual GP so those JOs
            -- aren't wrongly judged Below-GP (0% is impossible for a real, costed line).
            COALESCE(NULLIF(sol.gp_rate, 0), so.actual_gp_rate) AS jo_gp_rate, jt.gp_rate_head AS passing_gp_rate,
            sol.is_approved_low_gp
     FROM sales_order_lines sol
     JOIN sales_orders so ON so.id = sol.sales_order_id
     LEFT JOIN job_orders jo ON jo.id = sol.job_order_id
     LEFT JOIN job_types jt ON jt.id = sol.job_type_id
     LEFT JOIN sales_divisions sd ON sd.id = so.sales_division_id
     WHERE ${whereParts.join(' AND ')}`,
    params
  );

  // A line passes when it has a job order whose GP rate meets the job type's passing rate. A
  // line with no job order yet, no GP rate, or no defined threshold can't be judged as passing
  // -- it still counts in weighted sales, just not in the passing-rate total.
  const passingJoIds = [];
  for (const l of lines) {
    // Normally a line passes on GP rate; but an Admin/GM low-GP approval (is_approved_low_gp) forces
    // it to count as passing regardless of the rate, as long as it has a job order.
    const meetsGp = l.jo_gp_rate != null && l.passing_gp_rate != null && Number(l.jo_gp_rate) >= Number(l.passing_gp_rate);
    l.passing = l.jo_id != null && (Number(l.is_approved_low_gp) === 1 || meetsGp);
    if (l.passing) passingJoIds.push(l.jo_id);
  }

  // Paid portion of each passing JO, from its sales order's invoice payment. Uses the same
  // order-level attribution as the JO-detail report (computePaidByJo) so DT-converted invoices
  // -- whose lines carry no job_order_id -- are counted; the old line-level join silently
  // dropped them and understated Confirmed Commission.
  const paidByJo = await computePaidByJo(passingJoIds);

  const [quotaRows] = await pool.query(
    'SELECT month, quota FROM employee_quotas WHERE employee_id = ? AND year = ?',
    [employeeId, year]
  );
  const quotaByMonth = new Map(quotaRows.map((q) => [q.month, Number(q.quota)]));

  // Fold everything into the twelve month rows.
  const months = MONTHS.map((label, i) => ({
    month: i + 1, month_name: label, quota: quotaByMonth.get(i + 1) || 0,
    division_name: null, weighted_sales: 0, passing_total: 0, paid_passing: 0,
  }));

  for (const l of lines) {
    const row = months[l.month - 1];
    if (!row) continue;
    row.weighted_sales += Number(l.net_of_tax);
    if (!row.division_name && l.division_name) row.division_name = scope.companyWide ? 'All (excl. branches)' : l.division_name;
    if (l.passing) {
      row.passing_total += Number(l.net_of_tax);
      row.paid_passing += paidByJo.get(l.jo_id) || 0;
    }
  }

  // Released commission + voucher expense adjustments, sourced from this employee's Commission
  // Vouchers via the shared waterfall allocation (deductions from the earliest month, refunds
  // added, net = the voucher's total). See lib/commissionRelease.js.
  const { grossReleasedByMonth, deductedByMonth, refundedByMonth } = await releaseByMonthForEmployee(employeeId, year);

  // The Commission Payable(s) raised for each month (asked 2026-11-18), so a month with commission
  // but no payable -- which a Commission Voucher cannot release -- is visible on the report. A
  // payable covering a range of months is listed on each of them. Void payables are left out.
  const payablesByMonth = Array.from({ length: 13 }, () => []);
  const [cps] = await pool.query(
    `SELECT id, commission_payable_no, status,
            YEAR(period_from) AS fy, MONTH(period_from) AS fm, YEAR(COALESCE(period_to, period_from)) AS ty, MONTH(COALESCE(period_to, period_from)) AS tm
       FROM commission_payables
      WHERE employee_id = ? AND status <> 'void'
        AND YEAR(period_from) <= ? AND YEAR(COALESCE(period_to, period_from)) >= ?
      ORDER BY period_from, id`,
    [employeeId, year, year]
  );
  for (const cp of cps) {
    const from = Number(cp.fy) < Number(year) ? 1 : Number(cp.fm);
    const to = Number(cp.ty) > Number(year) ? 12 : Number(cp.tm);
    for (let m = from; m <= to; m += 1) {
      payablesByMonth[m].push({ id: cp.id, commission_payable_no: cp.commission_payable_no, status: cp.status });
    }
  }

  const rows = months.map((r) => {
    const weighted = round2(r.weighted_sales);
    const pct = r.quota > 0 ? round2((weighted / r.quota) * 100) : 0;
    // A month under 100% of its quota earns nothing (asked 2026-10-15): Estimated through Unpaid
    // read 0, and so does everything built on Confirmed (Commission Payable, vouchers). A month
    // with no quota set has no % to judge it by and is computed as before.
    const belowQuota = r.quota > 0 && pct < 100;
    const passingTotal = belowQuota ? 0 : round2(r.passing_total);
    const paid = belowQuota ? 0 : round2(r.paid_passing);
    const estimated = belowQuota ? 0 : round2(lookupCommission(brackets, weighted));
    const expected = round2(lookupCommission(brackets, passingTotal));
    const confirmed = passingTotal > 0 ? round2((paid / passingTotal) * expected) : 0;
    // Released and Unpaid as the source system reads them (asked 2026-10-03, "released commission
    // not matched"): Released is everything the vouchers paid against the month, before the
    // voucher's deductions; Unpaid = Confirmed - Released, so an over-release shows negative
    // (Nina, January: -543.52 in both). Deducted / Refunded stay as their own columns, for
    // information -- they no longer reduce Released.
    const released = round2(grossReleasedByMonth[r.month]);
    const deducted = round2(deductedByMonth[r.month]);
    const refunded = round2(refundedByMonth[r.month]);
    const unpaid = round2(confirmed - released);
    return {
      month: r.month, month_name: r.month_name, quota: round2(r.quota),
      division_name: r.division_name, weighted_sales: weighted, performance_pct: pct,
      estimated_commission: estimated, passing_gp_total: passingTotal,
      // paid_passing_total: the invoiced (paid) part of the passing JOs -- the numerator of
      // Confirmed, shown on the JO Detail's breakdown.
      expected_commission: expected, paid_passing_total: paid, confirmed_commission: confirmed,
      released_commission: released, expenses_deducted: deducted, expenses_refunded: refunded,
      unpaid_commission: unpaid,
      payables: payablesByMonth[r.month] || [],
    };
  });

  return {
    employee_id: employee.id, employee_name: employee.name, year: Number(year),
    scheme_name: schemeName, team_size: teamEmployeeIds.length, company_wide: !!scope.companyWide,
    sbu_division_count: sbuDivisionIds.length, rows,
  };
}

// The paid (net) portion of each JO, allocated from its invoices: each invoice line takes
// its share of that invoice's paid fraction (gross - amount_due) / gross. Voided invoices
// count as nothing paid. Same allocation the monthly report uses, generalised to any JOs.
// Paid-invoice amount attributable to each JO. Billing is at the sales-order level (an invoice,
// or a Delivery Ticket that converted to one), so we work from the SO's invoice payment rather
// than an invoice-line -> JO link: those links are only best-effort on the original importer and
// are entirely absent on DT-converted invoices (whose lines carry no JO). For each JO we take its
// own net-of-tax (the same figure the report commissions on) times its SO's paid fraction --
// gross collected / gross invoiced. That way a paid-in-full invoice marks its JOs' full net as
// paid, uniformly for original and DT-converted invoices alike.
async function computePaidByJo(joIds) {
  const paidByJo = new Map();
  if (!joIds.length) return paidByJo;
  const [jos] = await pool.query(
    `SELECT jo.id AS jo_id, jo.sales_order_id, COALESCE(sol.net_of_tax, 0) AS jo_net
       FROM job_orders jo
       LEFT JOIN sales_order_lines sol ON sol.id = jo.sales_order_line_id
      WHERE jo.id IN (?)`,
    [joIds]
  );
  const soIds = [...new Set(jos.map((j) => j.sales_order_id))];
  const fractionBySo = new Map();
  if (soIds.length) {
    const [inv] = await pool.query(
      `SELECT sales_order_id, SUM(gross_amount) AS gross, SUM(gross_amount - amount_due) AS paid
         FROM sales_invoices
        WHERE sales_order_id IN (?) AND (status IS NULL OR status <> 'cancelled')
        GROUP BY sales_order_id`,
      [soIds]
    );
    for (const r of inv) {
      const gross = Number(r.gross) || 0;
      fractionBySo.set(r.sales_order_id, gross > 0 ? (Number(r.paid) / gross) : 0);
    }
  }
  for (const j of jos) {
    const frac = fractionBySo.get(j.sales_order_id) || 0;
    if (frac) paidByJo.set(j.jo_id, (paidByJo.get(j.jo_id) || 0) + Number(j.jo_net) * frac);
  }
  return paidByJo;
}

// Per-JO detail behind one rep's commission for a single month: every JO in the rep's team
// (own + downline, plus any SBU-owned divisions), each with its GP rate, net of tax, and
// paid-invoice amount, split into JOs that met their job type's passing GP rate and those
// below it. This is the line-by-line backing for the monthly report's passing-GP total and
// its Confirmed figure.
async function buildCommissionJoDetail(employeeId, year, month, filters = {}) {
  const [[employee]] = await pool.query(
    "SELECT id, CONCAT(first_name, ' ', last_name) AS name FROM employees WHERE id = ?", [employeeId]
  );
  if (!employee) return null;

  const [[user]] = await pool.query(
    `SELECT id, is_sales_manager, is_sales_business_unit FROM users WHERE employee_id = ? AND is_active = TRUE ORDER BY id LIMIT 1`,
    [employeeId]
  );
  // The same scope as the monthly report (salesScope), so the detail adds up to its row.
  const scope = await salesScope(employeeId, user);
  const whereParts = [scope.sql];
  const params = [...scope.params];
  whereParts.push('YEAR(so.date_created) = ?'); params.push(Number(year));
  whereParts.push('MONTH(so.date_created) = ?'); params.push(Number(month));
  // Cancelled sales orders are excluded here too, so the detail matches the monthly totals -- and
  // cancelled job orders, as the monthly report leaves them out (2026-10-22).
  whereParts.push("(so.status IS NULL OR so.status <> 'cancelled')");
  whereParts.push("jo.status <> 'Cancelled'");
  if (filters.salesDivisionId) { whereParts.push('so.sales_division_id = ?'); params.push(filters.salesDivisionId); }
  // Only the JO its sales-order line belongs to. A rework JO (RWIP) hangs off the same line as the
  // original, but the line points at the original: counting both put the line's net in twice
  // (Amelyn A. Pen, January 2026: RWIP-1221's 29,670.93 made this screen's passing total disagree
  // with the Commission report's, found 2026-10-07). The report counts each line once.
  whereParts.push('(sol.id IS NULL OR sol.job_order_id = jo.id)');

  const [jos] = await pool.query(
    `SELECT jo.id AS jo_id, jo.job_order_no, so.sales_order_no, c.id AS customer_id, c.name AS customer_name,
            jt.display_name AS job_type, COALESCE(sol.net_of_tax, 0) AS net_of_tax,
            -- Fall back to the order-level actual GP when the line has none (see buildCommissionReport).
            COALESCE(NULLIF(sol.gp_rate, 0), so.actual_gp_rate) AS jo_gp_rate, jt.gp_rate_head AS passing_gp_rate,
            sol.id AS sales_order_line_id, sol.is_approved_low_gp,
            CONCAT(rep.first_name, ' ', rep.last_name) AS rep_name,
            -- Billing docs are at the sales-order level: a DT (internal invoice) and/or the
            -- Sales Invoice it converts to. Show both when present (all JOs of one SO share them).
            (SELECT dt.dt_no FROM delivery_tickets dt
              WHERE dt.sales_order_id = so.id AND dt.status <> 'void' ORDER BY dt.id LIMIT 1) AS dt_no,
            (SELECT si.invoice_no FROM sales_invoices si
              WHERE si.sales_order_id = so.id AND (si.status IS NULL OR si.status <> 'cancelled')
              ORDER BY si.id LIMIT 1) AS invoice_no
     FROM job_orders jo
     JOIN sales_orders so ON so.id = jo.sales_order_id
     LEFT JOIN sales_order_lines sol ON sol.id = jo.sales_order_line_id
     LEFT JOIN job_types jt ON jt.id = jo.job_type_id
     LEFT JOIN customers c ON c.id = so.customer_id
     LEFT JOIN employees rep ON rep.id = jo.sales_rep_id
     WHERE ${whereParts.join(' AND ')}
     ORDER BY so.date_created, jo.job_order_no`,
    params
  );

  const paidByJo = await computePaidByJo(jos.map((j) => j.jo_id));

  const totals = {
    passing: { net_of_tax: 0, paid_invoice: 0, count: 0 },
    below: { net_of_tax: 0, paid_invoice: 0, count: 0 },
  };
  const rows = jos.map((j) => {
    // Same rule the monthly report uses: a JO passes on its GP rate, OR because someone added
    // it to commission explicitly (is_approved_low_gp). This detail used to judge on the rate
    // alone, so an added JO still read "Below GP" here while already counting toward the
    // month's passing total -- the two screens disagreed about the same job order.
    const meetsGp = j.jo_gp_rate != null && j.passing_gp_rate != null
      && Number(j.jo_gp_rate) >= Number(j.passing_gp_rate);
    const addedManually = Number(j.is_approved_low_gp) === 1;
    const isPassing = meetsGp || addedManually;
    const net = round2(j.net_of_tax);
    const paidRaw = paidByJo.get(j.jo_id) || 0;
    const paid = round2(paidRaw);
    const bucket = isPassing ? totals.passing : totals.below;
    bucket.net_of_tax = round2(bucket.net_of_tax + net);
    // Summed unrounded and rounded once at the end, as the report does -- rounding each JO first
    // left this total a few centavos off the report's.
    bucket.paid_raw = (bucket.paid_raw || 0) + paidRaw;
    bucket.paid_invoice = round2(bucket.paid_raw);
    bucket.count += 1;
    return {
      job_order_no: j.job_order_no, sales_order_no: j.sales_order_no, customer_id: j.customer_id, customer_name: j.customer_name,
      rep_name: j.rep_name, job_type: j.job_type, gp_rate: j.jo_gp_rate == null ? null : Number(j.jo_gp_rate),
      passing_gp_rate: j.passing_gp_rate == null ? null : Number(j.passing_gp_rate),
      dt_no: j.dt_no || null, invoice_no: j.invoice_no || null,
      net_of_tax: net, paid_invoice: paid, is_passing: isPassing,
      // The UI needs to tell "passed on its own GP" apart from "was added": only the latter
      // can be taken back out, and only a JO that has a line can be added in the first place.
      meets_gp: meetsGp, is_approved_low_gp: addedManually,
      sales_order_line_id: j.sales_order_line_id || null,
    };
  });

  delete totals.passing.paid_raw;
  delete totals.below.paid_raw;

  return {
    employee_id: employee.id, employee_name: employee.name, year: Number(year), month: Number(month),
    team_size: scope.teamEmployeeIds.length, sbu_division_count: scope.sbuDivisionIds.length, rows, totals,
  };
}

// For DISPLAY on the Commission report and the Commission Summary only (asked 2026-11-18): a month
// with no Commission Payable shows no Confirmed Commission, and so no Unpaid (Confirmed − Released)
// -- it is not payable until a CP is raised, and the CP # column reads "No CP" for it. The figures
// are kept on the row as confirmed_before_cp / unpaid_before_cp.
//
// Never apply this to what the Commission Payable or the vouchers compute from: a new CP takes the
// month's Confirmed from buildCommissionReport, which would otherwise always read 0 for it.
function withholdConfirmedWithoutPayable(report) {
  if (!report?.rows) return report;
  const rows = report.rows.map((r) => {
    if ((r.payables || []).length) return r;
    return {
      ...r,
      confirmed_before_cp: r.confirmed_commission, unpaid_before_cp: r.unpaid_commission,
      confirmed_commission: 0, unpaid_commission: round2(0 - Number(r.released_commission || 0)),
    };
  });
  return { ...report, rows };
}

module.exports = { buildCommissionReport, buildCommissionJoDetail, getTeamEmployeeIds, getSbuDivisionIds, withholdConfirmedWithoutPayable };
