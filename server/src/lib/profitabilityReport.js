// Accounting > Reports > Profitability Report -- what each Sales Order was estimated to earn, what it has
// actually earned so far, and what it cost to get there.
//
// SHAPE. One group per Sales Order (the parent row), one child row per Sales Order LINE. The
// real system draws its children as Job Orders, and for all but a handful of rows those are the
// same thing: a JO is raised from one SO line, and `sales_order_lines.job_order_id` points
// straight at it (125,345 of 127,317 lines carry one, and not a single one disagrees with
// job_orders.sales_order_line_id).
//
// Children are the LINES rather than the JOs on purpose, for two cases the JO side gets wrong:
//
//   * 3,020 lines have no Job Order at all (a Sales Order still pending for JO). Keyed on JOs
//     those lines vanish, and the parent's Est Revenue stops agreeing with the Sales Order's own
//     total -- the first thing anyone checks this report against.
//   * three lines carry TWO job orders (a rework RWIP, an RMA, a re-issued JO). Keyed on JOs the
//     line's revenue would be counted once per JO, inventing money that was never quoted.
//
// So the line is the unit of revenue, and every JO raised from it -- the original and any
// rework -- contributes its cost to that one row. The JO # shown is the line's own
// `job_order_id`, with the newest JO on the line as a fallback for the ~2k migrated lines where
// that column was never filled in; the rest are listed in the row's Details.
//
// WHERE EACH COLUMN COMES FROM, and why that source and not another:
//
//   Est Revenue   sales_order_lines.gross_amount -- tax-inclusive, so a parent's Est Revenue adds
//                 up to the Sales Order's own total_amount (checked: SO-70893, line 780.00 =
//                 header 780.00). net_of_tax would read 8-9% light against the document it came
//                 from and invite exactly the wrong bug report.
//
//   Est Cost      SUM(job_order_processes.process_cost + material_cost) over every JO on the
//                 line. This is the same expression the app itself uses for the cost of a
//                 production batch (routes/production.js builds an Assembly Build's total_amount
//                 from it) and the "Total Amount" the Production JO screen already shows, so the
//                 report agrees with the screen a user would check it against.
//
//                 NOT SUM(total_cost), which the Job Order view's footer adds up: in the migrated
//                 data total_cost is a per-unit rate, not an extended amount (a 10,000-sheet
//                 process line carries total_cost 0.4576 against material_cost 2.00), so summing
//                 it down a job mixes unit rates with lot amounts and lands ~45% low on average
//                 (measured: 805 vs 1,459 against the builds' own totals over 3,000 job orders).
//                 That footer is its own pre-existing problem and is deliberately not copied here.
//
//   Actual Revenue  SUM(sales_invoice_lines.gross_amount) for invoices that are not cancelled.
//
//                 NOT keyed on sales_invoice_lines.sales_order_line_id, which is the obvious
//                 column and is wrong: 121,008 of the 121,012 invoice lines carry a value there
//                 that matches no sales_order_lines row at all -- the migration wrote the source
//                 system's own line ids straight through without remapping them. Reading revenue
//                 off that column returns 0.00 for all but four lines in the database.
//
//                 So the link is job_order_id -> job_orders.sales_order_line_id. That resolves
//                 for 105,073 lines and, where it resolves, the job order always belongs to the
//                 invoice's own sales order (checked: zero exceptions), so it can be trusted.
//
//                 THE 15,626 THAT STILL CANNOT BE PLACED. Those lines carry no job order at all
//                 and account for PHP 175.5M of PHP 482.4M invoiced -- 36% of the money, spread
//                 evenly over 2021-2026, and the largest invoices are the worst affected. They
//                 are handled in two steps rather than dropped:
//                   * on a sales order with exactly ONE line, an invoice can only be billing that
//                     line, so the amount is attributed to it (2,126 lines);
//                   * otherwise it is counted in the GROUP's Actual Revenue -- taken from the
//                     invoice header's sales_order_id, which always resolves -- and shown as an
//                     "invoiced, not attributable to a line" row inside the group.
//                 That keeps a group's total equal to what the customer was actually billed,
//                 keeps parent and children adding up, and puts the missing link on screen
//                 instead of quietly understating a third of the revenue.
//
//   Actual Cost   completed Assembly Builds (assembly_builds.total_amount, cancelled excluded --
//                 the same status test lib/stockMovements.js uses to decide a build moved stock)
//                 plus anything purchased against the JO and already received
//                 (received_qty x rate on purchase_order_lines that name it). The build total is
//                 the source system's own figure for what the batch consumed; it is NOT recomputed
//                 from the build's lines, which reproduce it for only 411 of 5,000 builds.
//
//   Committed Cost  the other half of those purchase order lines: (qty - received_qty) x rate on
//                 POs that are not Cancelled -- money promised to a supplier for this job and not
//                 yet spent. NOTE: purchase_order_lines.job_order_id is null on every row in the
//                 current data, so both PO-derived figures read 0.00 today. They are wired up
//                 rather than omitted so the column starts working the day purchasing begins
//                 charging a PO line to a job, instead of silently staying blank.
//
//   Unbilled Receivable  Est Revenue - Actual Revenue. Not clamped at zero: a line invoiced for
//                 more than it was quoted is a real thing that happens and a negative here is the
//                 only place the report would show it.
//
//   Profit        Actual Revenue - Actual Cost, and Margin % is Profit over Actual Revenue. Both
//                 read 0.00 until something is invoiced, which is what the real report does -- a
//                 job that has not billed has not made a profit yet, however it was estimated.
//
// COST. Pagination is over Sales Orders, and every per-line aggregate is fetched for that page's
// lines only -- ~10-25 orders at a time, never the 69,761 in the table. The five aggregate
// queries are separate statements stitched together in JS rather than correlated subqueries, so
// each one is a single indexed pass and none of them multiplies against another.
const pool = require('../db');
const { getSalesRepEmployeeScope } = require('./salesVisibility');

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;
// A CSV of every Sales Order ever raised is 69,761 groups and ~127k lines -- minutes of query
// time for a file nobody reads to the end. The export takes the filtered set up to this many
// orders and says in the response header when it was truncated, rather than pretending.
const CSV_MAX_SALES_ORDERS = 2000;

const DATE_MODES = ['as_of', 'on', 'between', 'all'];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isoDate(v) {
  if (!v) return null;
  if (v instanceof Date) {
    // Local parts, not toISOString(): a DATE column read back as midnight local time shifts to
    // the previous day in UTC for everyone east of Greenwich, which is where this runs.
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  return String(v).slice(0, 10);
}

// The SO Date filter, as the real report's dropdown offers it: everything up to a date, one exact
// date, a range, or no date filter at all. Anything unrecognised falls back to "as of", the
// dropdown's own default, rather than quietly returning the whole table.
function dateFilter(mode, from, to) {
  const m = DATE_MODES.includes(mode) ? mode : 'as_of';
  if (m === 'all') return { sql: null, params: [] };
  if (m === 'between') {
    if (!from && !to) return { sql: null, params: [] };
    if (from && to) return { sql: 'so.date_created BETWEEN ? AND ?', params: [from, to] };
    if (from) return { sql: 'so.date_created >= ?', params: [from] };
    return { sql: 'so.date_created <= ?', params: [to] };
  }
  if (!from) return { sql: null, params: [] };
  if (m === 'on') return { sql: 'so.date_created = ?', params: [from] };
  return { sql: 'so.date_created <= ?', params: [from] };
}

// Which Sales Orders this run covers. Shared by the count, the page and the CSV so the three can
// never disagree about the filtered set.
async function buildWhere(userId, filters) {
  const where = [];
  const params = [];

  if (filters.salesRepId) { where.push('so.sales_rep_id = ?'); params.push(filters.salesRepId); }
  if (filters.customerId) { where.push('so.customer_id = ?'); params.push(filters.customerId); }
  if (filters.officeLocationId) { where.push('so.office_location_id = ?'); params.push(filters.officeLocationId); }
  if (filters.salesDivisionId) { where.push('so.sales_division_id = ?'); params.push(filters.salesDivisionId); }

  const dateWhere = dateFilter(filters.dateMode, filters.dateFrom, filters.dateTo);
  if (dateWhere.sql) { where.push(dateWhere.sql); params.push(...dateWhere.params); }

  // Cancelled orders are excluded by default -- a cancelled job has no profit to report and
  // leaving them in makes the Unbilled Receivable column read as money owed. Kept available
  // behind a flag because "what did we cancel" is a fair question to ask of this report.
  if (!filters.includeCancelled) where.push("so.status <> 'cancelled'");

  // General Searching, against the five identifiers actually printed on the row: the estimate
  // number, the order number, the customer, the contract description and the job order number.
  if (filters.search) {
    const q = `%${filters.search.trim()}%`;
    where.push(`(so.sales_order_no LIKE ? OR e.estimate_no LIKE ? OR c.name LIKE ?
      OR so.contract_description LIKE ?
      OR EXISTS (SELECT 1 FROM job_orders jos WHERE jos.sales_order_id = so.id AND jos.job_order_no LIKE ?))`);
    params.push(q, q, q, q, q);
  }

  // Same visibility rule as the Sales Orders list itself: an Account Officer sees their own
  // orders, a Supervisor theirs plus their reports', a branch account its branches' -- and a
  // report that showed more than the list it drills into would be a way around that rule.
  const scope = await getSalesRepEmployeeScope(userId);
  if (scope) {
    if (scope.length === 0) {
      // A scoped user with nothing in scope sees nothing. Without this an empty IN () is a SQL
      // error, and `IN (NULL)` would match nothing by accident rather than on purpose.
      where.push('1 = 0');
    } else {
      where.push('so.sales_rep_id IN (?)');
      params.push(scope);
    }
  }

  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

// The joins the SELECT and the search share. estimates/customers are needed by the search
// clause as well as the row, so they are always joined; the rest are display only.
const SO_FROM = `FROM sales_orders so
  LEFT JOIN estimates e ON e.id = so.estimate_id
  LEFT JOIN customers c ON c.id = so.customer_id
  LEFT JOIN employees sr ON sr.id = so.sales_rep_id
  LEFT JOIN sales_divisions sd ON sd.id = so.sales_division_id
  LEFT JOIN locations loc ON loc.id = so.office_location_id`;

const SO_SELECT = `SELECT so.id, so.sales_order_no, so.date_created, so.contract_description, so.status,
         so.estimate_id, e.estimate_no, so.customer_id, c.name AS customer_name,
         CONCAT(COALESCE(sr.first_name, ''), ' ', COALESCE(sr.last_name, '')) AS sales_rep_name,
         sd.name AS sales_division_name, loc.location_name AS office_location_name`;

// Everything hanging off one page of Sales Orders: their lines, the JO on each line, and the
// money aggregates. Returns { linesBySo, invoicedBySo } -- the second is what the customer was
// actually billed per order, which is not always the sum of what can be pinned to its lines.
async function linesForSalesOrders(soIds) {
  if (soIds.length === 0) return { linesBySo: new Map(), invoicedBySo: new Map() };

  // What each order was actually billed, straight off the invoices' own header link. This is the
  // authoritative Actual Revenue for a group: it does not depend on any line being traceable, and
  // the headers' own totals agree with the sum of their lines (73,593 of 73,594 invoices).
  const [invoiced] = await pool.query(
    `SELECT si.sales_order_id, SUM(COALESCE(sil.gross_amount, 0)) AS actual_revenue,
            COUNT(DISTINCT si.id) AS invoice_count
       FROM sales_invoice_lines sil
       JOIN sales_invoices si ON si.id = sil.sales_invoice_id
      WHERE si.status <> 'cancelled' AND si.sales_order_id IN (?)
      GROUP BY si.sales_order_id`,
    [soIds],
  );
  const invoicedBySo = new Map(invoiced.map((r) => [Number(r.sales_order_id), {
    actual_revenue: num(r.actual_revenue),
    invoice_count: num(r.invoice_count),
  }]));

  const [lines] = await pool.query(
    `SELECT sol.id, sol.sales_order_id, sol.line_no, sol.description, sol.quantity, sol.units,
            COALESCE(sol.gross_amount, 0) AS est_revenue,
            jo.id AS job_order_id, jo.job_order_no, DATE(jo.created_at) AS jo_date, jo.status AS jo_status
       FROM sales_order_lines sol
       LEFT JOIN job_orders jo ON jo.id = sol.job_order_id
      WHERE sol.sales_order_id IN (?)
      ORDER BY sol.sales_order_id, sol.line_no, sol.id`,
    [soIds],
  );
  if (lines.length === 0) return { linesBySo: new Map(), invoicedBySo };

  // Which of these orders has exactly one line. An invoice line with no job order on a
  // single-line order can only be billing that one line, so it is safe to place there; on a
  // multi-line order it is not, and guessing would move money onto the wrong job.
  const lineCountBySo = new Map();
  for (const l of lines) lineCountBySo.set(l.sales_order_id, (lineCountBySo.get(l.sales_order_id) || 0) + 1);

  const lineIds = lines.map((l) => l.id);

  // Every job order raised from these lines -- including the ones sales_order_lines.job_order_id
  // does not name: the ~2k migrated lines where that column is empty, and the rework/RMA JOs
  // raised later against a line that already had one. Their costs belong to the line either way.
  const [jos] = await pool.query(
    `SELECT jo.id, jo.job_order_no, jo.sales_order_line_id, jo.status, DATE(jo.created_at) AS jo_date
       FROM job_orders jo
      WHERE jo.sales_order_line_id IN (?)
      ORDER BY jo.sales_order_line_id, jo.id`,
    [lineIds],
  );
  const josByLine = new Map();
  for (const jo of jos) {
    if (!josByLine.has(jo.sales_order_line_id)) josByLine.set(jo.sales_order_line_id, []);
    josByLine.get(jo.sales_order_line_id).push(jo);
  }

  const [estCosts] = await pool.query(
    `SELECT jo.sales_order_line_id AS line_id,
            SUM(COALESCE(p.process_cost, 0) + COALESCE(p.material_cost, 0)) AS est_cost
       FROM job_orders jo
       JOIN job_order_processes p ON p.job_order_id = jo.id
      WHERE jo.sales_order_line_id IN (?)
      GROUP BY jo.sales_order_line_id`,
    [lineIds],
  );

  // Revenue that can be placed on a line: through the invoice line's job order, which is the
  // only link in this data that resolves (see the note at the top of the file).
  const [actualRevenues] = await pool.query(
    `SELECT jo.sales_order_line_id AS line_id,
            SUM(COALESCE(sil.gross_amount, 0)) AS actual_revenue,
            COUNT(DISTINCT si.id) AS invoice_count
       FROM sales_invoice_lines sil
       JOIN sales_invoices si ON si.id = sil.sales_invoice_id
       JOIN job_orders jo ON jo.id = sil.job_order_id
      WHERE si.status <> 'cancelled' AND jo.sales_order_line_id IN (?)
      GROUP BY jo.sales_order_line_id`,
    [lineIds],
  );

  // The rest, per order: invoiced but carrying no job order. Placed on the line below only where
  // the order has exactly one; otherwise it stays at group level.
  const [unplaced] = await pool.query(
    `SELECT si.sales_order_id, SUM(COALESCE(sil.gross_amount, 0)) AS amount
       FROM sales_invoice_lines sil
       JOIN sales_invoices si ON si.id = sil.sales_invoice_id
       LEFT JOIN job_orders jo ON jo.id = sil.job_order_id
      WHERE si.status <> 'cancelled' AND jo.id IS NULL AND si.sales_order_id IN (?)
      GROUP BY si.sales_order_id`,
    [soIds],
  );
  const unplacedBySo = new Map(unplaced.map((r) => [Number(r.sales_order_id), num(r.amount)]));

  const [builtCosts] = await pool.query(
    `SELECT jo.sales_order_line_id AS line_id,
            SUM(COALESCE(b.total_amount, 0)) AS built_cost,
            COUNT(*) AS build_count
       FROM job_orders jo
       JOIN assembly_builds b ON b.job_order_id = jo.id
      WHERE b.status = 'completed' AND b.cancelled_at IS NULL AND jo.sales_order_line_id IN (?)
      GROUP BY jo.sales_order_line_id`,
    [lineIds],
  );

  const [poCosts] = await pool.query(
    `SELECT jo.sales_order_line_id AS line_id,
            SUM(COALESCE(pol.received_qty, 0) * COALESCE(pol.rate, 0)) AS received_cost,
            SUM(GREATEST(COALESCE(pol.qty, 0) - COALESCE(pol.received_qty, 0), 0) * COALESCE(pol.rate, 0)) AS committed_cost
       FROM purchase_order_lines pol
       JOIN job_orders jo ON jo.id = pol.job_order_id
       JOIN purchase_orders po ON po.id = pol.purchase_order_id
      WHERE po.status <> 'Cancelled' AND jo.sales_order_line_id IN (?)
      GROUP BY jo.sales_order_line_id`,
    [lineIds],
  );

  const byLine = (rows, key) => new Map(rows.map((r) => [Number(r.line_id), r[key]]));
  const estCostMap = byLine(estCosts, 'est_cost');
  const revenueMap = byLine(actualRevenues, 'actual_revenue');
  const invoiceCountMap = byLine(actualRevenues, 'invoice_count');
  const builtMap = byLine(builtCosts, 'built_cost');
  const buildCountMap = byLine(builtCosts, 'build_count');
  const receivedMap = byLine(poCosts, 'received_cost');
  const committedMap = byLine(poCosts, 'committed_cost');

  const grouped = new Map();
  for (const line of lines) {
    const lineJos = josByLine.get(line.id) || [];
    // The newest JO on the line as the fallback label: for a line whose job_order_id was never
    // filled in, showing nothing in the JO # column reads as "no job order was ever raised",
    // which is a different and much worse claim than "here is the one we found".
    const shown = line.job_order_id
      ? { id: line.job_order_id, job_order_no: line.job_order_no, jo_date: line.jo_date, status: line.jo_status }
      : lineJos[lineJos.length - 1] || null;

    const estRevenue = num(line.est_revenue);
    const estCost = num(estCostMap.get(line.id));
    // The single-line rule: on an order with one line, invoiced-but-unlinked money belongs here.
    const soleLine = lineCountBySo.get(line.sales_order_id) === 1;
    const actualRevenue = num(revenueMap.get(line.id)) + (soleLine ? num(unplacedBySo.get(line.sales_order_id)) : 0);
    const actualCost = num(builtMap.get(line.id)) + num(receivedMap.get(line.id));
    const committedCost = num(committedMap.get(line.id));
    const profit = actualRevenue - actualCost;

    const row = {
      line_id: line.id,
      line_no: line.line_no,
      description: line.description,
      quantity: num(line.quantity),
      units: line.units,
      job_order_id: shown?.id || null,
      job_order_no: shown?.job_order_no || null,
      jo_date: isoDate(shown?.jo_date),
      jo_status: shown?.status || null,
      // Every JO on the line, for the Details panel -- this is where a rework JO shows up, and
      // the reason the line's cost can exceed what one job order's processes add up to.
      job_orders: lineJos.map((j) => ({ id: j.id, job_order_no: j.job_order_no, status: j.status, jo_date: isoDate(j.jo_date) })),
      est_revenue: estRevenue,
      est_cost: estCost,
      actual_revenue: actualRevenue,
      actual_cost: actualCost,
      unbilled_receivable: estRevenue - actualRevenue,
      committed_cost: committedCost,
      profit,
      margin_pct: actualRevenue !== 0 ? (profit / actualRevenue) * 100 : 0,
      invoice_count: num(invoiceCountMap.get(line.id)),
      build_count: num(buildCountMap.get(line.id)),
    };
    if (!grouped.has(line.sales_order_id)) grouped.set(line.sales_order_id, []);
    grouped.get(line.sales_order_id).push(row);
  }
  return { linesBySo: grouped, invoicedBySo };
}

const MONEY_KEYS = ['est_revenue', 'est_cost', 'actual_revenue', 'actual_cost', 'unbilled_receivable', 'committed_cost', 'profit'];

// A parent row is the sum of its children, and the page total the sum of the parents. Margin is
// recomputed from the summed profit and revenue rather than averaged -- an average of percentages
// weights a 500-peso line the same as a 500,000-peso one.
function rollUp(rows) {
  const t = Object.fromEntries(MONEY_KEYS.map((k) => [k, 0]));
  for (const r of rows) for (const k of MONEY_KEYS) t[k] += num(r[k]);
  t.unallocated_revenue = rows.reduce((s, r) => s + num(r.unallocated_revenue), 0);
  t.margin_pct = t.actual_revenue !== 0 ? (t.profit / t.actual_revenue) * 100 : 0;
  return t;
}

// Under a peso is rounding between an invoice header and its lines, not a broken link -- a row
// saying "0.13 could not be attributed" would be noise on every page.
const UNALLOCATED_EPSILON = 1;

// One group. Est Revenue, Est Cost and the cost columns roll up from the lines; Actual Revenue is
// taken from the invoices instead, so a group states what the customer was billed even where a
// line cannot be identified -- and the shortfall is carried as `unallocated_revenue` so the
// children can be shown not to add up, on the row where that is true.
function rollUpGroup(lines, invoiced) {
  const t = rollUp(lines);
  const billed = num(invoiced?.actual_revenue);
  const attributed = t.actual_revenue;
  const unallocated = billed - attributed;

  t.actual_revenue = billed;
  t.unallocated_revenue = Math.abs(unallocated) >= UNALLOCATED_EPSILON ? unallocated : 0;
  t.unbilled_receivable = t.est_revenue - billed;
  t.profit = billed - t.actual_cost;
  t.margin_pct = billed !== 0 ? (t.profit / billed) * 100 : 0;
  t.invoice_count = num(invoiced?.invoice_count);
  return t;
}

async function buildProfitabilityReport(userId, filters = {}) {
  const { whereSql, params } = await buildWhere(userId, filters);

  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${SO_FROM} ${whereSql}`, params);

  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(filters.limit) || DEFAULT_PAGE_SIZE));
  const page = Math.max(1, Number(filters.page) || 1);
  const offset = (page - 1) * limit;

  const [orders] = await pool.query(
    `${SO_SELECT} ${SO_FROM} ${whereSql} ORDER BY so.date_created DESC, so.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const { linesBySo, invoicedBySo } = await linesForSalesOrders(orders.map((o) => o.id));

  const rows = orders.map((o) => {
    const lines = linesBySo.get(o.id) || [];
    return {
      sales_order_id: o.id,
      sales_order_no: o.sales_order_no,
      so_date: isoDate(o.date_created),
      status: o.status,
      estimate_id: o.estimate_id,
      estimate_no: o.estimate_no,
      customer_id: o.customer_id,
      customer_name: o.customer_name,
      sales_rep_name: (o.sales_rep_name || '').trim() || null,
      sales_division_name: o.sales_division_name,
      office_location_name: o.office_location_name,
      contract_description: o.contract_description,
      ...rollUpGroup(lines, invoicedBySo.get(o.id)),
      lines,
    };
  });

  return {
    rows,
    total,
    page,
    limit,
    total_pages: Math.max(1, Math.ceil(total / limit)),
    page_totals: rollUp(rows),
  };
}

// The same filtered set as the on-screen report, flattened one row per Sales Order line with the
// parent's identifiers repeated -- a spreadsheet can group or pivot that, and cannot do anything
// useful with a parent/child shape.
async function buildProfitabilityCsv(userId, filters = {}) {
  const { whereSql, params } = await buildWhere(userId, filters);
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${SO_FROM} ${whereSql}`, params);

  const [orders] = await pool.query(
    `${SO_SELECT} ${SO_FROM} ${whereSql} ORDER BY so.date_created DESC, so.id DESC LIMIT ?`,
    [...params, CSV_MAX_SALES_ORDERS],
  );
  const { linesBySo, invoicedBySo } = await linesForSalesOrders(orders.map((o) => o.id));

  const header = [
    'Est #', 'SO #', 'SO Date', 'JO #', 'JO Date', 'Sales Rep', 'Sales Div', 'Office Location',
    'Customer', 'Contract Desc.', 'Line #', 'Line Description', 'Qty', 'Units',
    'Est Revenue', 'Est Cost', 'Actual Revenue', 'Actual Cost', 'Unbilled Receivable',
    'Committed Cost', 'Profit', 'Margin %',
  ];
  // Excel reads a leading = + - @ as a formula, so a description that starts with one is quoted
  // and prefixed -- the same defence the other CSV exports in this app use.
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const money = (v) => num(v).toFixed(2);

  const out = [header.join(',')];
  for (const o of orders) {
    const lines = linesBySo.get(o.id) || [];
    for (const l of lines) {
      out.push([
        cell(o.estimate_no), cell(o.sales_order_no), cell(isoDate(o.date_created)),
        cell(l.job_order_no), cell(l.jo_date), cell((o.sales_rep_name || '').trim()),
        cell(o.sales_division_name), cell(o.office_location_name), cell(o.customer_name),
        cell(o.contract_description), cell(l.line_no), cell(l.description), cell(l.quantity), cell(l.units),
        money(l.est_revenue), money(l.est_cost), money(l.actual_revenue), money(l.actual_cost),
        money(l.unbilled_receivable), money(l.committed_cost), money(l.profit), num(l.margin_pct).toFixed(2),
      ].join(','));
    }
    // The same "invoiced, not attributable to a line" row the screen shows inside the group, so a
    // spreadsheet's column total matches the report's and matches what the customer was billed.
    const group = rollUpGroup(lines, invoicedBySo.get(o.id));
    if (group.unallocated_revenue) {
      out.push([
        cell(o.estimate_no), cell(o.sales_order_no), cell(isoDate(o.date_created)),
        '', '', cell((o.sales_rep_name || '').trim()),
        cell(o.sales_division_name), cell(o.office_location_name), cell(o.customer_name),
        cell(o.contract_description), '', cell('Invoiced, not attributable to a line'), '', '',
        '0.00', '0.00', money(group.unallocated_revenue), '0.00',
        money(-group.unallocated_revenue), '0.00', money(group.unallocated_revenue), '',
      ].join(','));
    }
  }

  return {
    csv: out.join('\n'),
    sales_orders: orders.length,
    total,
    truncated: total > orders.length,
  };
}

// The numbers behind one child row: the job orders on the line, their process costing (what Est
// Cost is made of), the builds that consumed material (Actual Cost), and the invoices that billed
// it (Actual Revenue). Permission is checked by the route; this only refuses a line the caller's
// sales scope does not cover, so Details cannot be used to read past the list's own visibility.
async function buildProfitabilityLineDetail(userId, lineId) {
  const scope = await getSalesRepEmployeeScope(userId);
  const scopeSql = scope ? (scope.length ? 'AND so.sales_rep_id IN (?)' : 'AND 1 = 0') : '';
  const scopeParams = scope && scope.length ? [scope] : [];

  const [[line]] = await pool.query(
    `SELECT sol.id, sol.line_no, sol.description, sol.quantity, sol.units, sol.price_per_unit,
            COALESCE(sol.gross_amount, 0) AS est_revenue, sol.net_of_tax, sol.tax_amount,
            so.id AS sales_order_id, so.sales_order_no, so.date_created AS so_date, so.contract_description,
            c.name AS customer_name, e.estimate_no
       FROM sales_order_lines sol
       JOIN sales_orders so ON so.id = sol.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN estimates e ON e.id = so.estimate_id
      WHERE sol.id = ? ${scopeSql}`,
    [lineId, ...scopeParams],
  );
  if (!line) return null;

  const [jobOrders] = await pool.query(
    `SELECT id, job_order_no, status, sub_status, quantity, quantity_built, quantity_invoiced,
            DATE(created_at) AS jo_date
       FROM job_orders WHERE sales_order_line_id = ? ORDER BY id`,
    [lineId],
  );
  const joIds = jobOrders.map((j) => j.id);

  const [processes] = joIds.length ? await pool.query(
    `SELECT p.job_order_id, jo.job_order_no, p.line_no, pr.process_name, p.category, p.parts,
            i.display_name AS item_name, p.qty, p.unit, p.process_cost, p.material_cost, p.total_cost,
            COALESCE(p.process_cost, 0) + COALESCE(p.material_cost, 0) AS line_est_cost
       FROM job_order_processes p
       JOIN job_orders jo ON jo.id = p.job_order_id
       LEFT JOIN processes pr ON pr.id = p.process_id
       LEFT JOIN inventories i ON i.id = p.item_id
      WHERE p.job_order_id IN (?)
      ORDER BY p.job_order_id, p.line_no, p.id`,
    [joIds],
  ) : [[]];

  const [builds] = joIds.length ? await pool.query(
    `SELECT b.id, b.ab_no, b.job_order_id, jo.job_order_no, b.date_created, b.quantity_built,
            b.total_amount, b.status
       FROM assembly_builds b
       JOIN job_orders jo ON jo.id = b.job_order_id
      WHERE b.job_order_id IN (?) AND b.cancelled_at IS NULL
      ORDER BY b.date_created, b.id`,
    [joIds],
  ) : [[]];

  // Invoice lines are found through their job order, and -- on a sales order with only this one
  // line -- also the ones carrying no job order, which can only be billing it. Same two rules the
  // list uses, so Details cannot show a different Actual Revenue from the row it opened from.
  const [[{ so_line_count: soLineCount }]] = await pool.query(
    'SELECT COUNT(*) AS so_line_count FROM sales_order_lines WHERE sales_order_id = ?',
    [line.sales_order_id],
  );
  const soleLine = Number(soLineCount) === 1;
  const invoiceWhere = [];
  const invoiceParams = [];
  if (joIds.length) { invoiceWhere.push('sil.job_order_id IN (?)'); invoiceParams.push(joIds); }
  if (soleLine) {
    invoiceWhere.push('(sil.job_order_id IS NULL AND si.sales_order_id = ?)');
    invoiceParams.push(line.sales_order_id);
  }
  const [invoices] = invoiceWhere.length ? await pool.query(
    `SELECT si.id, si.invoice_no, si.date_created, si.status, sil.quantity, sil.units,
            sil.price_per_unit, sil.net_of_tax, sil.tax_amount, COALESCE(sil.gross_amount, 0) AS gross_amount,
            sil.job_order_id
       FROM sales_invoice_lines sil
       JOIN sales_invoices si ON si.id = sil.sales_invoice_id
      WHERE ${invoiceWhere.join(' OR ')}
      ORDER BY si.date_created, si.id`,
    invoiceParams,
  ) : [[]];

  const [purchases] = joIds.length ? await pool.query(
    `SELECT po.id, po.po_no, po.status, pol.job_order_id, jo.job_order_no, i.display_name AS item_name,
            pol.qty, pol.received_qty, pol.rate,
            COALESCE(pol.received_qty, 0) * COALESCE(pol.rate, 0) AS received_cost,
            GREATEST(COALESCE(pol.qty, 0) - COALESCE(pol.received_qty, 0), 0) * COALESCE(pol.rate, 0) AS committed_cost
       FROM purchase_order_lines pol
       JOIN purchase_orders po ON po.id = pol.purchase_order_id
       JOIN job_orders jo ON jo.id = pol.job_order_id
       LEFT JOIN inventories i ON i.id = pol.item_id
      WHERE pol.job_order_id IN (?) AND po.status <> 'Cancelled'
      ORDER BY po.id`,
    [joIds],
  ) : [[]];

  const estCost = processes.reduce((s, p) => s + num(p.line_est_cost), 0);
  const actualRevenue = invoices.filter((i) => i.status !== 'cancelled').reduce((s, i) => s + num(i.gross_amount), 0);
  const actualCost = builds.filter((b) => b.status === 'completed').reduce((s, b) => s + num(b.total_amount), 0)
    + purchases.reduce((s, p) => s + num(p.received_cost), 0);
  const committedCost = purchases.reduce((s, p) => s + num(p.committed_cost), 0);
  const estRevenue = num(line.est_revenue);

  return {
    line: { ...line, so_date: isoDate(line.so_date), est_revenue: estRevenue },
    job_orders: jobOrders.map((j) => ({ ...j, jo_date: isoDate(j.jo_date) })),
    processes,
    builds: builds.map((b) => ({ ...b, date_created: isoDate(b.date_created) })),
    invoices: invoices.map((i) => ({ ...i, date_created: isoDate(i.date_created) })),
    purchases,
    totals: {
      est_revenue: estRevenue,
      est_cost: estCost,
      actual_revenue: actualRevenue,
      actual_cost: actualCost,
      unbilled_receivable: estRevenue - actualRevenue,
      committed_cost: committedCost,
      profit: actualRevenue - actualCost,
      margin_pct: actualRevenue !== 0 ? ((actualRevenue - actualCost) / actualRevenue) * 100 : 0,
    },
  };
}

// The pickers' contents, scoped the same way the rows are: a user who cannot see another rep's
// orders has no business picking that rep out of a list either. Locations (13) and sales
// divisions (11) are small enough to send whole; customers are 21,562 and are searched instead.
async function getProfitabilityScope(userId) {
  const scope = await getSalesRepEmployeeScope(userId);
  const repWhere = scope ? (scope.length ? 'WHERE e.id IN (?)' : 'WHERE 1 = 0') : '';
  const repParams = scope && scope.length ? [scope] : [];

  const [reps] = await pool.query(
    `SELECT e.id, CONCAT(COALESCE(e.first_name, ''), ' ', COALESCE(e.last_name, '')) AS name
       FROM employees e ${repWhere}
       ${repWhere ? 'AND' : 'WHERE'} EXISTS (SELECT 1 FROM sales_orders so WHERE so.sales_rep_id = e.id)
      ORDER BY name`,
    repParams,
  );
  const [locations] = await pool.query(
    'SELECT id, location_name FROM locations WHERE is_active = TRUE ORDER BY location_name',
  );
  const [divisions] = await pool.query('SELECT id, name FROM sales_divisions ORDER BY name');

  return { reps, locations, divisions, scoped: scope !== null };
}

// Typeahead for the Customer filter. Capped, because /customers returns all 21,562 rows and this
// report has no reason to repeat that mistake.
async function searchProfitabilityCustomers(term) {
  const q = `%${String(term || '').trim()}%`;
  const [rows] = await pool.query(
    `SELECT c.id, c.name
       FROM customers c
      WHERE c.name LIKE ? AND EXISTS (SELECT 1 FROM sales_orders so WHERE so.customer_id = c.id)
      ORDER BY c.name
      LIMIT 25`,
    [q],
  );
  return rows;
}

module.exports = {
  buildProfitabilityReport,
  buildProfitabilityCsv,
  buildProfitabilityLineDetail,
  getProfitabilityScope,
  searchProfitabilityCustomers,
  DATE_MODES,
  CSV_MAX_SALES_ORDERS,
};
