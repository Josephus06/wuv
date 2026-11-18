// ISO-8601 week numbers for the calendars (asked 2026-11-14: "add week number beside all calendars";
// 2026 has 53 weeks, so the last week of December 2026 is WK-53 and the first of January WK-01).
//
// An ISO week runs Monday to Sunday, and week 1 is the week holding the year's first Thursday --
// so 28 Dec 2026 - 3 Jan 2027 is 2026's WK-53, and 4 Jan 2027 starts WK-01 of 2027.
//
// The app's calendars are drawn Sunday-first (Sun ... Sat). A Sunday belongs to the ISO week that
// ENDS on it, but on these grids it leads the row with the Monday-to-Saturday after it -- so a row
// is labelled by its Monday (weekOfRow): six of its seven days are that week.
const pad = (n) => String(n).padStart(2, '0');

function toDate(v) {
  if (v instanceof Date) return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  const [y, m, d] = String(v).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

// { week, year } -- the ISO week of a date (a Date or 'YYYY-MM-DD'), and the ISO year it is in.
export function isoWeek(v) {
  const d = toDate(v);
  const day = (d.getDay() + 6) % 7; // Monday 0 ... Sunday 6
  const thursday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day + 3);
  const year = thursday.getFullYear();
  const jan4 = new Date(year, 0, 4);
  const week1Monday = new Date(year, 0, 4 - ((jan4.getDay() + 6) % 7));
  const week = 1 + Math.round((thursday - week1Monday) / (7 * 86400000));
  return { week, year };
}

// "WK-46"
export function weekLabel(v) { return `WK-${pad(isoWeek(v).week)}`; }

// The week a Sunday-first calendar row stands for: the row's Monday. Pass any day in the row
// (Date or 'YYYY-MM-DD').
export function weekOfRow(v) {
  const d = toDate(v);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay() + 1);
}

// "WK-46" for a Sunday-first row containing this day.
export function rowWeekLabel(v) { return weekLabel(weekOfRow(v)); }
