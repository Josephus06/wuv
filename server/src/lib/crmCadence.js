// How often a customer should be visited, by CRM priority.
//
// customers.visit_every_days overrides this per account; NULL means "use the priority's default".
// Kept in one place because both the customer profile (routes/crm.js, "visit due on") and the
// needs-attention scoring read it, and they must agree on when a visit is overdue.
const PRIORITIES = ['high', 'normal', 'low'];

const DEFAULT_VISIT_EVERY_DAYS = { high: 14, normal: 30, low: 90 };

function visitEveryDays(priority, override) {
  const n = Number(override);
  if (Number.isInteger(n) && n > 0) return n;
  return DEFAULT_VISIT_EVERY_DAYS[priority] || DEFAULT_VISIT_EVERY_DAYS.normal;
}

// The business's clock. The servers do not share a timezone (the droplet and Railway run UTC, the
// office box Philippine time), so "today" for birthdays and the needs-attention run, and the hour
// the nightly job fires, are taken from this offset rather than the process's. Philippine time
// has no DST, so a fixed offset is exact.
const UTC_OFFSET_MIN = Number(process.env.CRM_UTC_OFFSET_MINUTES || 480);

// Today's date on the business clock, YYYY-MM-DD.
function businessToday(now = new Date()) {
  return new Date(now.getTime() + UTC_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}

// Milliseconds until the business clock next reads hour:minute.
function msUntilBusinessTime(hour, minute, now = new Date()) {
  const shifted = new Date(now.getTime() + UTC_OFFSET_MIN * 60000);
  const target = new Date(shifted);
  target.setUTCHours(hour, minute, 0, 0);
  if (target <= shifted) target.setUTCDate(target.getUTCDate() + 1);
  return target - shifted;
}

module.exports = { PRIORITIES, DEFAULT_VISIT_EVERY_DAYS, visitEveryDays, UTC_OFFSET_MIN, businessToday, msUntilBusinessTime };
