import { isoWeek, weekOfRow } from '../utils/isoWeek';

// The week-number column for the Sunday-first calendar grids (asked 2026-11-14: "add week number
// beside all calendars"). The grid gets one more column in front (className "cal-with-weeks"), the
// header row an empty cell (WeekHead), and every row of seven cells a week cell before it
// (withWeeks), stacked "WK" over "46" (asked 2026-11-14). ISO-8601 weeks -- see utils/isoWeek.js for how a Sunday-first row is numbered.

export function WeekHead({ className = 'artist-calendar-weekday', style }) {
  return <div className={`${className} cal-wk-head`} style={style} />;
}

// The cells, with a week cell before each row of seven. `cells` are day keys ('YYYY-MM-DD') or
// null for blank cells; renderCell(key, i) draws one as before.
export function withWeeks(cells, renderCell, { className = 'cal-wk', style } = {}) {
  const out = [];
  for (let i = 0; i < cells.length; i += 1) {
    if (i % 7 === 0) {
      const day = cells.slice(i, i + 7).find(Boolean);
      out.push(
        <div key={`wk-${i}`} className={className} style={style} title={day ? 'ISO-8601 week number' : undefined}>
          {day && (
            <>
              <span className="cal-wk-tag">WK</span>
              <span className="cal-wk-no">{String(isoWeek(weekOfRow(day)).week).padStart(2, '0')}</span>
            </>
          )}
        </div>,
      );
    }
    out.push(renderCell(cells[i], i));
  }
  return out;
}
