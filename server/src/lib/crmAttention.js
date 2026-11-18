// CRM > Needs Attention: which customers a sales rep should reach out to, and why.
//
// Rules, not a model. Every point on the score comes from a signal a rep can check for themselves
// ("no order in 64 days, usually every 21"), so the list can be argued with and tuned. The AI in
// phase 3 writes the words on top of this; it does not decide who is on it.
//
// SIGNALS (points before multipliers)
//   reorder   ordering later than the customer's own usual gap        up to 40
//   trend     last 90 days' sales well under their usual quarter     up to 25
//   visit     past the visit cadence for their priority              up to 30
//             (or High priority with no visit ever logged: 15)
//   overdue   money that fell due in the last year and is unpaid     up to 20
//   birthday  a contact's birthday within BIRTHDAY_DAYS               10
// then  x priority (high 1.5 / normal 1 / low 0.6)
//       x account size (0.8 .. 1.4 by last-12-months sales)
//       x 0.5 when a visit or meeting is already booked within SCHEDULED_DAYS.
//
// "Never visited" is NOT a signal on its own for normal/low priority. Visits only started being
// logged with this module, so on day one every customer has none -- counting that would put all
// ~8,000 active accounts on the list and bury the ones that matter.
//
// WHO OWNS A CUSTOMER: the sales rep (an employee) on their most recent sales order.
// customers.default_sales_rep_id is empty on every row, so it cannot be the answer. Using the
// employee id also lets the list reuse lib/salesVisibility.js unchanged.
//
// Written as a snapshot to crm_attention by the nightly job (index.js) or on demand; the page reads
// the snapshot. The whole table is replaced in one transaction so a reader never sees half a run.
const pool = require('../db');
const { collectOpenItems } = require('./arAging');
const { visitEveryDays, businessToday } = require('./crmCadence');

const HISTORY_MONTHS = 24;
const MIN_ORDER_DAYS_FOR_PATTERN = 4; // distinct order days needed before a "usual gap" means anything
const REORDER_LATE_RATIO = 2; // flagged once it's been twice their usual gap
const TREND_WINDOW_DAYS = 90;
const TREND_BASELINE_DAYS = 360; // the four quarters before the current one
const TREND_MIN_BASELINE = 20000; // PHP per quarter; smaller accounts swing too much to read a trend
const TREND_DROP = 0.5; // flagged when this quarter is under half their usual
const OVERDUE_MIN = 1000; // PHP
// Only invoices that fell due within the last year. The open-AR ledger still carries balances from
// 2021 that are migration residue (payments that never linked to the bill -- see the AR aging
// notes in lib/arAging.js), and a five-year-old "overdue" is a collections question, not a reason
// to visit this month.
const OVERDUE_MAX_AGE_DAYS = 365;
const BIRTHDAY_DAYS = 7;
const SCHEDULED_DAYS = 14;
const PRIORITY_WEIGHT = { high: 1.5, normal: 1, low: 0.6 };

const DAY_MS = 86400000;

function toDay(v) { return v ? String(v).slice(0, 10) : null; }
function dayNum(dateStr) { return Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / DAY_MS); }
function round2(n) { return Math.round(n * 100) / 100; }
function peso(n) { return `₱${Math.round(n).toLocaleString('en-US')}`; }
function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function shortDate(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// Days from asOf to the next occurrence of a birthday (0 = today). Feb 29 counts as Feb 28.
function daysToBirthday(birthday, asOf) {
  const [, m, d] = toDay(birthday).split('-').map(Number);
  const [y] = asOf.split('-').map(Number);
  for (const year of [y, y + 1]) {
    const lastDay = new Date(Date.UTC(year, m, 0)).getUTCDate();
    const candidate = `${year}-${String(m).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
    const diff = dayNum(candidate) - dayNum(asOf);
    if (diff >= 0) return { days: diff, date: candidate };
  }
  return null;
}

async function loadInputs(asOf) {
  const [orders] = await pool.query(
    `SELECT customer_id, date_created, total_amount, sales_rep_id
       FROM sales_orders
      WHERE status <> 'cancelled' AND customer_id IS NOT NULL
        AND date_created >= DATE_SUB(?, INTERVAL ${HISTORY_MONTHS} MONTH) AND date_created < DATE_ADD(?, INTERVAL 1 DAY)
      ORDER BY customer_id, date_created`, [asOf, asOf],
  );
  const [customers] = await pool.query(
    'SELECT id, crm_priority, visit_every_days FROM customers WHERE is_active = TRUE',
  );
  const [visits] = await pool.query(
    `SELECT related_id AS customer_id, MAX(COALESCE(starts_at, completed_at, created_at)) AS last_visit_at
       FROM crm_activities
      WHERE activity_type = 'visit' AND related_type = 'Customer' AND is_done = TRUE
      GROUP BY related_id`,
  );
  const [scheduled] = await pool.query(
    `SELECT related_id AS customer_id, MIN(starts_at) AS next_at
       FROM crm_activities
      WHERE activity_type IN ('visit', 'meeting') AND related_type = 'Customer' AND is_done = FALSE
        AND starts_at >= ? GROUP BY related_id`, [asOf],
  );
  const [birthdays] = await pool.query(
    'SELECT customer_id, contact_name, birthday FROM customer_contacts WHERE birthday IS NOT NULL',
  );
  const openItems = await collectOpenItems(asOf);
  return { orders, customers, visits, scheduled, birthdays, openItems };
}

function scoreCustomers(asOf, inputs) {
  const today = dayNum(asOf);
  const byCustomer = new Map();
  const get = (id) => {
    if (!byCustomer.has(id)) byCustomer.set(id, { orders: [], birthdays: [], overdue: 0, credit: 0, oldestDue: null });
    return byCustomer.get(id);
  };

  for (const o of inputs.orders) get(o.customer_id).orders.push(o);
  for (const v of inputs.visits) get(v.customer_id).lastVisitAt = v.last_visit_at;
  for (const s of inputs.scheduled) get(s.customer_id).nextScheduledAt = s.next_at;
  for (const b of inputs.birthdays) get(b.customer_id).birthdays.push(b);
  for (const item of inputs.openItems) {
    const c = get(item.customer_id);
    if (item.balance < 0) {
      c.credit += -item.balance; // unapplied cash and open credit memos offset what is owed
    } else if (item.due_date && toDay(item.due_date) < asOf && today - dayNum(toDay(item.due_date)) <= OVERDUE_MAX_AGE_DAYS) {
      c.overdue += item.balance;
      const due = toDay(item.due_date);
      if (!c.oldestDue || due < c.oldestDue) c.oldestDue = due;
    }
  }

  const rows = [];
  for (const cust of inputs.customers) {
    const c = byCustomer.get(cust.id);
    const priority = cust.crm_priority || 'normal';
    if (!c && priority !== 'high') continue;
    const data = c || { orders: [], birthdays: [], overdue: 0, credit: 0 };
    const reasons = [];

    // --- reorder ---
    const orderDays = [...new Set(data.orders.map((o) => toDay(o.date_created)))].sort();
    const lastOrder = orderDays[orderDays.length - 1] || null;
    if (orderDays.length >= MIN_ORDER_DAYS_FOR_PATTERN) {
      const gaps = orderDays.slice(1).map((d, i) => dayNum(d) - dayNum(orderDays[i]));
      const usual = Math.max(1, median(gaps));
      const since = today - dayNum(lastOrder);
      const ratio = since / usual;
      if (ratio >= REORDER_LATE_RATIO && since >= 14) {
        reasons.push({
          code: 'reorder',
          points: Math.min(40, 15 * Math.log2(ratio)),
          text: `No order in ${since} days — usually orders every ${Math.round(usual)} days`,
        });
      }
    }

    // --- sales trend ---
    let recent = 0;
    let baseline = 0;
    let revenue12m = 0;
    for (const o of data.orders) {
      const age = today - dayNum(toDay(o.date_created));
      const amount = Number(o.total_amount) || 0;
      if (age < TREND_WINDOW_DAYS) recent += amount;
      else if (age < TREND_WINDOW_DAYS + TREND_BASELINE_DAYS) baseline += amount;
      if (age < 365) revenue12m += amount;
    }
    const usualQuarter = baseline / (TREND_BASELINE_DAYS / TREND_WINDOW_DAYS);
    if (usualQuarter >= TREND_MIN_BASELINE && recent < usualQuarter * TREND_DROP) {
      const drop = 1 - recent / usualQuarter;
      reasons.push({
        code: 'trend',
        points: 25 * drop,
        text: `Sales down ${Math.round(drop * 100)}% — ${peso(recent)} in the last 90 days vs ${peso(usualQuarter)} a usual quarter`,
      });
    }

    // --- visits ---
    const cadence = visitEveryDays(priority, cust.visit_every_days);
    if (data.lastVisitAt) {
      const sinceVisit = today - dayNum(toDay(data.lastVisitAt));
      const late = sinceVisit - cadence;
      if (late > 0) {
        reasons.push({
          code: 'visit',
          points: Math.min(30, 10 + (late / cadence) * 10),
          text: `Last visited ${sinceVisit} days ago — due every ${cadence} days`,
        });
      }
    } else if (priority === 'high') {
      reasons.push({ code: 'visit', points: 15, text: 'High priority and no visit logged yet' });
    }

    // --- overdue money ---
    const overdue = Math.max(0, data.overdue - data.credit);
    if (overdue >= OVERDUE_MIN) {
      const daysLate = today - dayNum(data.oldestDue);
      reasons.push({
        code: 'overdue',
        points: Math.min(20, 8 + Math.log10(overdue / OVERDUE_MIN) * 4 + (daysLate > 60 ? 4 : 0)),
        text: `${peso(overdue)} overdue — oldest ${daysLate} days past due`,
      });
    }

    // --- birthdays ---
    for (const b of data.birthdays) {
      const next = daysToBirthday(b.birthday, asOf);
      if (next && next.days <= BIRTHDAY_DAYS) {
        reasons.push({
          code: 'birthday',
          points: 10,
          text: next.days === 0 ? `${b.contact_name}'s birthday is today` : `${b.contact_name}'s birthday is ${shortDate(next.date)}`,
        });
      }
    }

    if (!reasons.length) continue;

    let score = reasons.reduce((s, r) => s + r.points, 0);
    score *= PRIORITY_WEIGHT[priority] || 1;
    const size = Math.min(1.4, Math.max(0.8, 1 + 0.1 * Math.log10(Math.max(1, revenue12m / 10000))));
    score *= size;
    const nextAt = data.nextScheduledAt ? toDay(data.nextScheduledAt) : null;
    if (nextAt && dayNum(nextAt) - today <= SCHEDULED_DAYS) {
      score *= 0.5;
      reasons.push({ code: 'scheduled', points: 0, text: `Already booked for ${shortDate(nextAt)}` });
    }

    const lastOrderRow = data.orders[data.orders.length - 1];
    rows.push({
      customer_id: cust.id,
      owner_employee_id: lastOrderRow ? lastOrderRow.sales_rep_id : null,
      score: round2(score),
      reasons: reasons.map((r) => ({ ...r, points: round2(r.points) })),
      last_order_date: lastOrder,
      last_visit_at: data.lastVisitAt || null,
      next_scheduled_at: data.nextScheduledAt || null,
      revenue_12m: round2(revenue12m),
      overdue_amount: round2(overdue),
    });
  }
  return rows.sort((a, b) => b.score - a.score);
}

// Recompute and replace the snapshot. Returns { rows, ms }.
async function refreshAttention(asOf = businessToday()) {
  const started = Date.now();
  const inputs = await loadInputs(asOf);
  const rows = scoreCustomers(asOf, inputs);
  const computedAt = new Date();

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM crm_attention');
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await conn.query(
        `INSERT INTO crm_attention
           (customer_id, owner_employee_id, score, reasons, last_order_date, last_visit_at, next_scheduled_at,
            revenue_12m, overdue_amount, computed_at)
         VALUES ?`,
        [chunk.map((r) => [
          r.customer_id, r.owner_employee_id, r.score, JSON.stringify(r.reasons), r.last_order_date,
          r.last_visit_at, r.next_scheduled_at, r.revenue_12m, r.overdue_amount, computedAt,
        ])],
      );
    }
    await conn.query('DELETE FROM crm_attention_snoozes WHERE snoozed_until < ?', [asOf]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return { rows: rows.length, ms: Date.now() - started };
}

// Whether THIS server may rebuild the snapshot -- nightly or by the Refresh button. See the
// replication note at the scheduler in index.js.
function crmAttentionJobEnabled() {
  return process.env.CRM_ATTENTION_JOB === '1';
}

module.exports = { refreshAttention, scoreCustomers, daysToBirthday, crmAttentionJobEnabled };
