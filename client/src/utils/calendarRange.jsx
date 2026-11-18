import { useState } from 'react';
import { rowWeekLabel, weekLabel } from './isoWeek';

// The Day / Week / Month switch shared by the General Manager's dashboard calendars (asked
// 2026-10-06). One anchor date, three ways to look around it:
//   month  the anchor's month, Sunday-first grid with blank leading cells (what they always showed)
//   week   the Sunday-to-Saturday week around the anchor, CUT TO THE ANCHOR'S MONTH (asked 2026-10-08):
//          October's first week is Oct 1-3 alone, with Sep 27-30 left as blank cells, never shown
//          as part of October. The arrows walk the month's own weeks, then into the next month's.
//   day    the anchor alone
// `months` is every YYYY-MM the visible days fall in: the calendar endpoints are monthly, so a week
// across a month end asks for both. Day keys are built from local dates, never toISOString(), which
// slides a day back here in UTC+8 before 08:00.
export const CALENDAR_RANGES = [
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
];

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); };

export function useCalendarRange(range = 'month') {
  const [anchor, setAnchor] = useState(() => dayKey(new Date()));
  const a = parse(anchor);

  let cells = [];
  let title = '';
  if (range === 'day') {
    cells = [anchor];
    // With its ISO week (2026-11-14).
    title = `${a.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} · ${weekLabel(anchor)}`;
  } else if (range === 'week') {
    const start = new Date(a.getFullYear(), a.getMonth(), a.getDate() - a.getDay());
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      // A day of the neighbouring month is a blank cell, as the month grid's leading cells are.
      cells.push(d.getMonth() === a.getMonth() ? dayKey(d) : null);
    }
    const inMonth = cells.filter(Boolean);
    const first = parse(inMonth[0]); const end = parse(inMonth[inMonth.length - 1]);
    const short = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    title = first.getTime() === end.getTime()
      ? `${short(first)}, ${end.getFullYear()}`
      : `${short(first)} – ${end.getDate()}, ${end.getFullYear()}`;
    title = `${title} · ${rowWeekLabel(anchor)}`;
  } else {
    const y = a.getFullYear(); const m = a.getMonth();
    const leading = new Date(y, m, 1).getDay();
    const days = new Date(y, m + 1, 0).getDate();
    for (let i = 0; i < leading; i += 1) cells.push(null);
    for (let d = 1; d <= days; d += 1) cells.push(dayKey(new Date(y, m, d)));
    title = `${MONTH_NAMES[m]} ${y}`;
  }
  const days = cells.filter(Boolean);
  const months = [...new Set(days.map((k) => k.slice(0, 7)))];

  const shift = (delta) => {
    if (range === 'day') setAnchor(dayKey(new Date(a.getFullYear(), a.getMonth(), a.getDate() + delta)));
    // The day after this (month-cut) week, or the day before it -- which is how Oct 1-3 steps back
    // to Sep 27-30 rather than skipping it.
    else if (range === 'week') {
      const edge = parse(delta > 0 ? days[days.length - 1] : days[0]);
      setAnchor(dayKey(new Date(edge.getFullYear(), edge.getMonth(), edge.getDate() + (delta > 0 ? 1 : -1))));
    }
    else setAnchor(dayKey(new Date(a.getFullYear(), a.getMonth() + delta, 1)));
  };

  return { cells, days, months, title, shift, todayKey: dayKey(new Date()), first: days[0], last: days[days.length - 1] };
}

// The Day / Week / Month buttons.
export function CalendarRangeSwitch({ value, onChange }) {
  return (
    <div className="status-tabs" style={{ margin: 0 }}>
      {CALENDAR_RANGES.map((r) => (
        <button key={r.key} type="button" className={`status-tab ${value === r.key ? 'active' : ''}`} onClick={() => onChange(r.key)}>
          {r.label}
        </button>
      ))}
    </div>
  );
}

// A day cell's peso figure: the full amount, and "171K" / "1.2M" for a phone, where seven columns
// leave no room for one (index.css swaps them under 600px).
function compactMoney(n) {
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(Math.round(n));
}
export function CalAmount({ value, full }) {
  return (
    <>
      <span className="cal-amt-full">{full}</span>
      <span className="cal-amt-short">{compactMoney(Number(value) || 0)}</span>
    </>
  );
}
