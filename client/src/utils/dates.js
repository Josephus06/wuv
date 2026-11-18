// THE date format for everything the app displays: "18 Sept 2026".
//
// One formatter rather than ~180 separate toLocaleDateString calls, each free to drift. The month
// names are spelled out here instead of taken from the browser: 'en-GB' short months render
// "Sept" in current Chrome and Edge but "Sep" in older engines, and the format should not depend
// on which one a user happens to run.
//
// PARSING IS DELIBERATELY UNCHANGED. Each helper reads its value with `new Date(v)`, exactly as the
// call sites it replaced did, so no date moves: server/src/db.js returns DATE columns as
// "YYYY-MM-DD" and DATETIMEs as "YYYY-MM-DD HH:MM:SS" with no offset, and utils/datetime.js
// explains why that interpretation must not be changed wholesale. A bare "YYYY-MM-DD" is read by
// its own digits, which is the same day `new Date` gives anyone east of UTC and the right day
// for anyone west of it.
//
// NOT FOR CHEQUE DATES. The date printed on a cheque, and the Cheque Date on the cheque screens,
// keep their own format -- the bank's -- and do not use this.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];

function toDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n) => String(n).padStart(2, '0');

// "18 Sept 2026". Blank for nothing, and for anything that is not a date.
export function displayDate(v) {
  const d = toDate(v);
  return d ? `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : '';
}

// "18 Sept 2026, 10:05 am".
export function displayDateTime(v) {
  const d = toDate(v);
  if (!d) return '';
  const h = d.getHours();
  return `${displayDate(d)}, ${h % 12 || 12}:${pad(d.getMinutes())} ${h < 12 ? 'am' : 'pm'}`;
}

// "Sept 2026" -- for month headings and period labels.
export function displayMonth(v) {
  const d = toDate(v);
  return d ? `${MONTHS[d.getMonth()]} ${d.getFullYear()}` : '';
}

// An audit trail time (System Info / history: audit_logs.set_at), and other times this app writes
// itself, in Philippine time (2026-10-12). The server and database run on UTC, so from 1 Aug 2026 --
// when the app began writing them -- they are stored in UTC: VB-24859 saved at 8:30 am read
// "12:30 am". The July 2026 rows came over from the source already in Manila time and stay as they
// are (measured: 89% of July's fall in office hours as written, 97-99% of later months' fall in
// 00:00-10:00, which is office hours in UTC). Shown in Manila time whatever the computer's own zone.
const APP_UTC_FROM = '2026-08-01';
export function displayAuditTime(v) {
  if (v == null || v === '') return '';
  const s = String(v);
  const utc = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s) && !/(Z|[+-]\d{2}:?\d{2})$/i.test(s) && s.slice(0, 10) >= APP_UTC_FROM;
  if (!utc) return displayDateTime(v);
  const d = new Date(`${s.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return '';
  const m = new Date(d.getTime() + 8 * 3600 * 1000); // Manila's clock, read with the UTC getters
  const h = m.getUTCHours();
  return `${pad(m.getUTCDate())} ${MONTHS[m.getUTCMonth()]} ${m.getUTCFullYear()}, ${h % 12 || 12}:${pad(m.getUTCMinutes())} ${h < 12 ? 'am' : 'pm'}`;
}
