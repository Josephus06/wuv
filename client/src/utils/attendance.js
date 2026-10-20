// The attendance API returns times already on the business clock as "YYYY-MM-DD HH:MM"
// (the *_local fields), so these only reformat strings -- no Date parsing, which would drag
// the browser's own timezone back in.

export const WEEKDAYS = [
  { value: 1, short: 'Mon' }, { value: 2, short: 'Tue' }, { value: 3, short: 'Wed' },
  { value: 4, short: 'Thu' }, { value: 5, short: 'Fri' }, { value: 6, short: 'Sat' },
  { value: 0, short: 'Sun' },
];

// "17:30[:00]" -> "5:30 PM"
export function formatClock(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// "2026-10-20 17:30" -> "5:30 PM", or "Oct 21, 5:30 PM" when it falls on a different day
// than `relativeTo` (an overnight shift's time-out).
export function formatLocalTime(local, relativeTo) {
  if (!local) return '';
  const [date, time] = local.split(' ');
  const clock = formatClock(time);
  if (!relativeTo || relativeTo === date) return clock;
  return `${formatDate(date, { month: 'short', day: 'numeric' })}, ${clock}`;
}

export function formatDate(iso, opts = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) {
  if (!iso) return '';
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
}

// 125 -> "2h 05m"; 0 -> "" (blank reads better than "0m" in a column of mostly zeros).
export function formatMinutes(mins, { blankZero = true } = {}) {
  const n = Number(mins) || 0;
  if (!n && blankZero) return '';
  const h = Math.floor(n / 60);
  const m = n % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

export function formatShiftHours(start, end) {
  return `${formatClock(start)} – ${formatClock(end)}`;
}

export function formatDays(daysOfWeek) {
  const set = new Set(String(daysOfWeek || '').split(',').filter(Boolean).map(Number));
  if (set.size === 7) return 'Every day';
  if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) return 'Mon–Fri';
  if (set.size === 6 && [1, 2, 3, 4, 5, 6].every((d) => set.has(d))) return 'Mon–Sat';
  return WEEKDAYS.filter((d) => set.has(d.value)).map((d) => d.short).join(', ');
}

const STATUS_BADGE = {
  Present: 'badge-success',
  Late: 'badge-warning',
  Absent: 'badge-danger',
  'No Time Out': 'badge-danger',
  'On Duty': 'badge-info',
  Scheduled: 'badge-muted',
};

export function statusBadgeClass(status) {
  return STATUS_BADGE[status] || 'badge-muted';
}

// A semi-monthly cutoff as { from, to }: 0 = the one today falls in, -1 = the one before.
export function cutoffRange(offset = 0) {
  const d = new Date();
  let year = d.getFullYear();
  let month = d.getMonth(); // 0-based
  let half = d.getDate() <= 15 ? 0 : 1;
  let steps = offset;
  while (steps < 0) { half -= 1; if (half < 0) { half = 1; month -= 1; if (month < 0) { month = 11; year -= 1; } } steps += 1; }
  while (steps > 0) { half += 1; if (half > 1) { half = 0; month += 1; if (month > 11) { month = 0; year += 1; } } steps -= 1; }
  const mm = String(month + 1).padStart(2, '0');
  const last = new Date(year, month + 1, 0).getDate();
  return half === 0
    ? { from: `${year}-${mm}-01`, to: `${year}-${mm}-15` }
    : { from: `${year}-${mm}-16`, to: `${year}-${mm}-${last}` };
}

// "2026-10-20 08:04" -> "2026-10-20T08:04" for <input type="datetime-local">.
export function toInputValue(local) {
  return local ? local.replace(' ', 'T') : '';
}
