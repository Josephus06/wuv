// The API returns times already on the company clock as "YYYY-MM-DD HH:MM" (the *_local
// fields), so these only reformat strings -- the phone's own timezone never enters into it.

export function formatClock(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// "2026-10-20 17:30" -> "5:30 PM", or "Oct 21, 5:30 PM" when it is not on `relativeTo`.
export function formatLocalTime(local, relativeTo) {
  if (!local) return '';
  const [date, time] = local.split(' ');
  const clock = formatClock(time);
  if (!relativeTo || relativeTo === date) return clock;
  return `${formatDate(date, { month: 'short', day: 'numeric' })}, ${clock}`;
}

export function formatDate(iso, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  if (!iso) return '';
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
}

export function formatMinutes(mins) {
  const n = Number(mins) || 0;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

// "2026-10-20 03:14:02" (UTC, no marker) -> Date.
export function parseUtc(v) {
  return v ? new Date(`${String(v).replace(' ', 'T')}Z`) : null;
}
