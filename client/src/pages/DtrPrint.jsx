import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import { COMPANY } from '../config/company';
import { formatClock, formatLocalTime, formatMinutes } from '../utils/attendance';

// Printable Daily Time Record: one sheet per employee, every date of the period listed (rest
// days and holidays included), with totals and sign-off lines. Opened in its own tab from
// HR → Attendance (one employee or a whole company) or from My Attendance (your own), and
// rendered without the app chrome so a company's sheets print one per page.
//   ?from=&to=  and  ?employee_id= | ?company_id=[&branch_id=] | ?mine=1

const weekday = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
const dayOfMonth = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const longDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

// "Seaside - Opening" -> "Opening"; the branch is already in the sheet's header.
const shortName = (name) => String(name || '').replace(/^.+? - /, '');
const blankZero = (m) => formatMinutes(m) || '';

function Sheet({ sheet, from, to }) {
  const { employee: e, days, totals } = sheet;
  return (
    <section className="dtr-sheet">
      <header className="dtr-head">
        <div className="dtr-company">{e.company_name || COMPANY.name}</div>
        {e.branch_name && <div className="dtr-branch">{e.branch_name}</div>}
        <h1>DAILY TIME RECORD</h1>
        <div className="dtr-period">{longDate(from)} – {longDate(to)}</div>
      </header>

      <dl className="dtr-info">
        <dt>Name</dt><dd>{e.name}</dd>
        <dt>Employee No.</dt><dd>{e.employee_code || '—'}</dd>
        <dt>Position</dt><dd>{e.position_title || '—'}</dd>
        <dt>Department</dt><dd>{e.department_name || '—'}</dd>
      </dl>

      <table className="dtr-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Day</th>
            <th>Schedule</th>
            <th>Time In</th>
            <th>Time Out</th>
            <th>Late</th>
            <th>Under-time</th>
            <th>Over-time</th>
            <th>Hours</th>
            <th>Remarks</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.date} className={d.remarks.includes('Rest day') ? 'is-rest' : d.remarks.includes('Absent') ? 'is-absent' : ''}>
              <td>{dayOfMonth(d.date)}</td>
              <td>{weekday(d.date)}</td>
              <td className="dtr-sched">
                {d.schedule ? <>{shortName(d.schedule.name)}<div>{formatClock(d.schedule.start.split(' ')[1])}–{formatClock(d.schedule.end.split(' ')[1])}</div></> : ''}
              </td>
              <td>{formatLocalTime(d.time_in_local, d.date)}</td>
              <td>{formatLocalTime(d.time_out_local, d.date)}</td>
              <td className="num">{blankZero(d.late_minutes)}</td>
              <td className="num">{blankZero(d.undertime_minutes)}</td>
              <td className="num">{blankZero(d.overtime_minutes)}</td>
              <td className="num">{blankZero(d.worked_minutes)}</td>
              <td className="dtr-remarks">{d.remarks.join('; ')}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th colSpan={5}>
              Total · {totals.present} day{totals.present === 1 ? '' : 's'} present · {totals.absent} absent · {totals.rest} rest day{totals.rest === 1 ? '' : 's'}
            </th>
            <th className="num">{blankZero(totals.late_minutes) || '0m'}</th>
            <th className="num">{blankZero(totals.undertime_minutes) || '0m'}</th>
            <th className="num">{blankZero(totals.overtime_minutes) || '0m'}</th>
            <th className="num">{blankZero(totals.worked_minutes) || '0m'}</th>
            <th />
          </tr>
        </tfoot>
      </table>

      <p className="dtr-certify">
        I certify on my honor that the above is a true and correct report of the hours of work performed, recorded daily
        at the time of arrival and departure from office.
      </p>
      <div className="dtr-signatures">
        <div>Employee&apos;s Signature</div>
        <div>Verified by (Immediate Head)</div>
        <div>Received by (HR)</div>
      </div>
    </section>
  );
}

export default function DtrPrint() {
  const [params] = useSearchParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const q = Object.fromEntries(params.entries());
    const url = q.mine ? '/attendance/me/dtr' : '/attendance/dtr';
    delete q.mine;
    api.get(url, { params: q })
      .then(({ data: d }) => {
        setData(d);
        document.title = d.sheets.length === 1 ? `DTR - ${d.sheets[0].employee.name}` : `DTR - ${d.sheets.length} employees`;
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not load the DTR'));
  }, [params]);

  if (error) return <div className="dtr-page"><div className="error-banner">{error}</div></div>;
  if (!data) return <LoadingSpinner />;

  return (
    <div className="dtr-page">
      <div className="print-toolbar dtr-toolbar">
        <button className="btn btn-primary" onClick={() => window.print()}>Print</button>
        <span className="muted">
          {data.sheets.length} sheet{data.sheets.length === 1 ? '' : 's'} · {longDate(data.from)} – {longDate(data.to)} · one employee per page
        </span>
      </div>
      {data.sheets.length === 0
        ? <div className="empty-state">No active employees match.</div>
        : data.sheets.map((s) => <Sheet key={s.employee.id} sheet={s} from={data.from} to={data.to} />)}
    </div>
  );
}
