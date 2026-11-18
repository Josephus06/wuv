const pool = require('../db');
const { insertFor, usersWithPermission } = require('./approvalNotifications');

// BIR filing deadlines (asked 2026-10-21), for a month's taxes:
//   Expanded Withholding Tax       the 5th of the following month
//   Creditable Withholding Tax     2307s from customers collected by the END of the same month
//   VAT                            the 15th of the following month
// The dates are the company's own deadlines as given, not moved for weekends or holidays.

const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m 1-12
const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const KINDS = {
  ewt: { label: 'Expanded Withholding Tax', route: '/reports/bir-ewt', day: 5, nextMonth: true },
  cwt: { label: 'BIR 2307 from customers', route: '/reports/bir-cwt', day: 'eom', nextMonth: false },
  vat: { label: 'VAT', route: '/reports/bir-vat', day: 15, nextMonth: true },
};

// "2026-10" -> { from, to, label }
function monthRange(ym) {
  if (!/^\d{4}-\d{2}$/.test(String(ym || ''))) return null;
  const [y, m] = ym.split('-').map(Number);
  if (m < 1 || m > 12) return null;
  return { month: ym, from: `${ym}-01`, to: `${ym}-${pad(lastDay(y, m))}`, label: `${MONTHS[m - 1]} ${y}` };
}

// When a month's filing of this kind is due.
function dueDate(kind, ym) {
  const k = KINDS[kind];
  let [y, m] = ym.split('-').map(Number);
  if (k.nextMonth) { m += 1; if (m > 12) { m = 1; y += 1; } }
  const d = k.day === 'eom' ? lastDay(y, m) : k.day;
  return `${y}-${pad(m)}-${pad(d)}`;
}

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// The due date, and how it stands today, for the report header.
function deadlineInfo(kind, ym, today = manilaToday()) {
  const due = dueDate(kind, ym);
  const days = daysBetween(today, due);
  return {
    kind, label: KINDS[kind].label, due_date: due, days_left: days,
    state: days < 0 ? 'overdue' : days === 0 ? 'today' : days <= 3 ? 'soon' : 'upcoming',
  };
}

const prevMonth = (ym) => { let [y, m] = ym.split('-').map(Number); m -= 1; if (m < 1) { m = 12; y -= 1; } return `${y}-${pad(m)}`; };

// The filings coming due around today: last month's EWT and VAT, this month's 2307s.
function upcoming(today = manilaToday()) {
  const thisMonth = today.slice(0, 7);
  return [
    { ...deadlineInfo('ewt', prevMonth(thisMonth), today), month: prevMonth(thisMonth) },
    { ...deadlineInfo('cwt', thisMonth, today), month: thisMonth },
    { ...deadlineInfo('vat', prevMonth(thisMonth), today), month: prevMonth(thisMonth) },
  ];
}

// Daily: tell whoever can view each report, 3 days before, the day before and on the day.
async function runBirReminders(today = manilaToday()) {
  const sent = [];
  for (const d of upcoming(today)) {
    if (![3, 1, 0].includes(d.days_left)) continue;
    const k = KINDS[d.kind];
    const users = await usersWithPermission(k.route, 'can_view');
    if (!users.length) continue;
    const monthLabel = monthRange(d.month).label;
    let extra = '';
    if (d.kind === 'cwt') {
      const [[r]] = await pool.query(
        `SELECT COUNT(*) AS n FROM sales_invoices si LEFT JOIN customer_2307_receipts r ON r.sales_invoice_id = si.id
          WHERE si.status <> 'cancelled' AND si.ewt_amount > 0 AND si.date_created BETWEEN ? AND ? AND r.sales_invoice_id IS NULL`,
        [monthRange(d.month).from, monthRange(d.month).to]).catch(() => [[{ n: 0 }]]);
      extra = ` ${r.n} invoice${Number(r.n) === 1 ? '' : 's'} still without a 2307.`;
    }
    const when = d.days_left === 0 ? 'is due today' : d.days_left === 1 ? 'is due tomorrow' : `is due in ${d.days_left} days`;
    await insertFor(users, {
      type: 'bir_deadline',
      title: `${k.label} for ${monthLabel} ${when}`,
      message: `${k.label} for ${monthLabel} ${when} (${d.due_date}).${extra}`,
      // Opens the report on that month: Bir:<kind>, and the month as YYYYMM.
      relatedType: `Bir:${d.kind}`, relatedId: Number(d.month.replace('-', '')),
    }, null);
    sent.push(`${d.kind} ${d.month} -> ${users.length}`);
  }
  return sent;
}

module.exports = { KINDS, monthRange, dueDate, deadlineInfo, upcoming, runBirReminders, manilaToday };
