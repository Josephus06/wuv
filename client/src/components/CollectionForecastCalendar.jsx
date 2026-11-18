import { useEffect, useState } from 'react';
import api from '../api/client';
import Modal from './Modal';
import { useCalendarRange, CalAmount } from '../utils/calendarRange';
import { WeekHead, withWeeks } from './CalendarWeeks';

// The month of expected collections, in the shape of the production schedule so the two read
// alike -- but the chips carry CUSTOMER names, because the question here is who is paying us on
// a given day and how much, not which document it came from.
//
// Shared deliberately between the Treasury > Collection Forecast page and the dashboard card.
// Two copies would eventually disagree about a day's total, and the whole point of the calendar
// is that the number on the cell and the number in the popup are the same number.
//
// `range` is the GM dashboard's Day / Week / Month switch (utils/calendarRange.jsx); the Treasury page
// leaves it at Month. A week across a month end fetches both months, and the header's figures are of
// the days on screen.
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDayHeading(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

export default function CollectionForecastCalendar({ customerId, range = 'month' }) {
  const { cells, days, months, title, shift, todayKey } = useCalendarRange(range);
  const [data, setData] = useState({ calendar: [] });
  const [loading, setLoading] = useState(true);
  const [openDay, setOpenDay] = useState(null);
  const monthsKey = months.join(',');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const rs = await Promise.all(monthsKey.split(',').map((month) => api.get('/collection-forecast/calendar', {
          params: { month, customer_id: customerId || undefined },
        })));
        if (!cancelled) setData({ calendar: rs.flatMap((r) => r.data.calendar || []) });
      } catch {
        // Leave the calendar showing what it had rather than blanking it on a hiccup.
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [monthsKey, customerId]);

  const byDay = new Map((data.calendar || []).map((d) => [d.day, d]));
  const visible = days.map((k) => byDay.get(k)).filter(Boolean);
  const shown = {
    invoiceCount: visible.reduce((t, e) => t + Number(e.invoiceCount || 0), 0),
    total: visible.reduce((t, e) => t + Number(e.total || 0), 0),
    collected: visible.reduce((t, e) => t + Number(e.collected || 0), 0),
  };

  return (
    <div className="artist-calendar">
      <div className="artist-calendar-head">
        <button type="button" className="btn btn-sm" onClick={() => shift(-1)} disabled={loading}>&lsaquo;</button>
        <strong>{title}</strong>
        <button type="button" className="btn btn-sm" onClick={() => shift(1)} disabled={loading}>&rsaquo;</button>
        <span className="muted artist-calendar-count">
          {loading
            ? 'Loading...'
            : `${shown.invoiceCount} invoice${shown.invoiceCount === 1 ? '' : 's'} · ${money(shown.total)} expected`
              + (shown.collected > 0 ? ` · ${money(shown.collected)} collected` : '')}
        </span>
      </div>

      {/* Day: the day's breakdown in place of a single-cell grid. */}
      {range === 'day' && !loading && <DayBreakdown entry={byDay.get(days[0])} />}

      {range !== 'day' && <div className="artist-calendar-grid cal-compact cal-with-weeks">
        <WeekHead />
        {WEEKDAYS.map((w) => <div key={w} className="artist-calendar-weekday">{w}</div>)}
        {withWeeks(cells, (key, i) => {
          if (!key) return <div key={`pad-${i}`} className="artist-calendar-day is-empty" />;
          const entry = byDay.get(key);
          const customers = entry?.customers || [];
          // Every day opens, including empty ones -- a click that does nothing is
          // indistinguishable from the feature being broken, and "nothing expected" is
          // itself worth confirming.
          return (
            <div
              key={key}
              role="button"
              tabIndex={0}
              className={`artist-calendar-day is-clickable${key === todayKey ? ' is-today' : ''}${customers.length ? ' has-jobs' : ''}`}
              title={customers.length
                ? `${entry.invoiceCount} invoice(s), ${money(entry.total)} -- click to see them`
                : 'Nothing forecast -- click to confirm'}
              onClick={() => setOpenDay(key)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenDay(key); } }}
            >
              <span className="artist-calendar-daynum">{Number(key.slice(8, 10))}</span>
              {/* Forecast on the left, what actually came in beside it. The actual is only
                  drawn when there is something to draw -- a 0.00 on every future day would
                  read as "we collected nothing" rather than "this has not happened yet". */}
              {(entry?.total > 0 || entry?.collected > 0) && (
                <div className="cal-tally">
                  {entry.total > 0 && <span className="cal-tally-item"><CalAmount value={entry.total} full={money(entry.total)} /></span>}
                  {entry.collected > 0 && (
                    <span className="cal-tally-item cal-actual" title={`Actual collection: ${entry.paymentCount} payment(s), ${money(entry.collected)}`}>
                      <CalAmount value={entry.collected} full={money(entry.collected)} />
                    </span>
                  )}
                </div>
              )}
              {customers.slice(0, 3).map((c) => (
                <span
                  key={c.customerId}
                  className="artist-calendar-chip"
                  title={`${c.customerName} · ${c.invoiceCount} invoice(s) · ${money(c.total)}`}
                >
                  {c.customerName}
                </span>
              ))}
              {customers.length > 3 && (
                <span className="artist-calendar-more">+{customers.length - 3} more</span>
              )}
              {customers.length > 0 && <span className="cal-mobile-count">{customers.length}</span>}
            </div>
          );
        })}
      </div>}

      {openDay && (
        <Modal title={`Expected on ${formatDayHeading(openDay)}`} onClose={() => setOpenDay(null)} large>
          <DayBreakdown entry={byDay.get(openDay)} />
        </Modal>
      )}
    </div>
  );
}

// One row per CUSTOMER with their invoice count and total, expanding to the invoices behind it.
// Collapsed by default: the day's question is who and how much, and a day with a dozen customers
// would otherwise open as a wall of invoice numbers.
function DayBreakdown({ entry }) {
  const [openCustomer, setOpenCustomer] = useState(null);
  const customers = entry?.customers || [];

  if (!customers.length) {
    return (
      <div className="muted" style={{ padding: 20, textAlign: 'center' }}>
        Nothing forecast for collection on this day.
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th style={{ width: 32 }} />
            <th>Customer</th>
            <th className="text-right">Invoices</th>
            <th className="text-right">Total Expected</th>
            <th className="text-right">Actual Collection</th>
          </tr>
        </thead>
        <tbody>
          {customers.map((c) => {
            const open = openCustomer === c.customerId;
            return [
              <tr
                key={c.customerId}
                className="is-clickable"
                onClick={() => setOpenCustomer(open ? null : c.customerId)}
              >
                <td>{c.invoiceCount ? (open ? '▾' : '▸') : ''}</td>
                <td>{c.customerName}</td>
                <td className="text-right">{c.invoiceCount || '—'}</td>
                <td className="text-right">{c.total > 0 ? money(c.total) : '—'}</td>
                {/* A customer can appear here having paid on a day nothing of theirs was
                    forecast -- money we did not plan for, which is worth seeing rather than
                    hiding because it fits no row. */}
                <td className="text-right cal-actual">
                  {c.collected > 0 ? money(c.collected) : '—'}
                </td>
              </tr>,
              open && c.invoiceCount > 0 && (
                <tr key={`${c.customerId}-detail`}>
                  <td />
                  <td colSpan={4} style={{ padding: 0 }}>
                    <table style={{ width: '100%' }}>
                      <thead>
                        <tr>
                          <th>Invoice No</th>
                          <th>Date Created</th>
                          <th>Due Date</th>
                          <th className="text-right">Amount Due</th>
                        </tr>
                      </thead>
                      <tbody>
                        {c.invoices.map((inv) => (
                          <tr key={inv.id}>
                            <td>{inv.invoiceNo}</td>
                            <td>{inv.dateCreated}</td>
                            <td>{inv.dateDue || '—'}</td>
                            <td className="text-right">{money(inv.amountDue)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </td>
                </tr>
              ),
            ];
          })}
          <tr>
            <td />
            <td><strong>Total</strong></td>
            <td className="text-right"><strong>{entry.invoiceCount}</strong></td>
            <td className="text-right"><strong>{money(entry.total)}</strong></td>
            <td className="text-right cal-actual"><strong>{money(entry.collected || 0)}</strong></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
