// The app-wide date format, "18 Sept 2026", for documents the server writes itself (the Estimate
// PDF, report period labels). The server-side twin of client/src/utils/dates.js: the two must
// agree, or a PDF and the screen it was printed from would show one date two ways. Month names are
// spelled out so the output does not depend on the Node build's ICU data.
//
// A bare "YYYY-MM-DD" is read by its own digits, so a DATE never moves a day whatever timezone the
// server runs in (Railway runs on UTC, the droplet and office box on Manila time).
//
// Not for cheque dates, which keep the bank's format.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];

function toDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n) => String(n).padStart(2, '0');

function displayDate(v) {
  const d = toDate(v);
  return d ? `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : '';
}

function displayMonth(v) {
  const d = toDate(v);
  return d ? `${MONTHS[d.getMonth()]} ${d.getFullYear()}` : '';
}

module.exports = { displayDate, displayMonth };
