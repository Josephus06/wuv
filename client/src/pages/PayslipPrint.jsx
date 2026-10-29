import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import { formatDate, formatPeriod, peso, qtyLabel } from '../utils/payroll';

// Printable payslips of a payroll run: every employee, or one (?employee_id=). Two slips to
// an A4 page with a cut line between them, rendered without the app chrome. Opened in its own
// tab from the run. A run that is not approved yet prints with a DRAFT mark.
//
// The header carries the company's logo, and every slip the Wu Ventures mark behind it
// (public/payslip/, cropped from the logo files).
const LOGOS = { CFT: '/payslip/cuts-for-tots.png', FAT: '/payslip/fresh-and-tidy.png' };
const WU_LOGO = '/payslip/wu-ventures.png';
const logoFor = (run) => LOGOS[run.company_code]
  || (/cuts/i.test(run.company_name) ? LOGOS.CFT : /fresh/i.test(run.company_name) ? LOGOS.FAT : WU_LOGO);

function Lines({ title, lines, totalLabel }) {
  const total = lines.reduce((s, l) => s + Number(l.amount), 0);
  return (
    <table className="slip-lines">
      <thead><tr><th colSpan={3}>{title}</th></tr></thead>
      <tbody>
        {lines.length === 0 && <tr><td colSpan={3} className="slip-none">None</td></tr>}
        {lines.map((l, i) => (
          <tr key={i}>
            <td>{l.label}</td>
            <td className="slip-qty">{qtyLabel(l)}</td>
            <td className="num">{peso(l.amount)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot><tr><th colSpan={2}>{totalLabel}</th><th className="num">{peso(total)}</th></tr></tfoot>
    </table>
  );
}

function Slip({ run, slip }) {
  // Zero lines (no night diff, no absences ...) are noise on paper; the screen keeps them.
  const shown = (type) => slip.lines.filter((l) => l.line_type === type && Number(l.amount) !== 0);
  const otHours = Math.round(slip.overtime_minutes / 6) / 10;
  return (
    <section className="slip">
      <img className="slip-watermark" src={WU_LOGO} alt="" />
      {run.status !== 'approved' && <div className="slip-draft">DRAFT</div>}
      <header className="slip-head">
        <div className="slip-brand">
          <img className={`slip-logo${logoFor(run) === LOGOS.FAT ? ' is-square' : ''}`} src={logoFor(run)} alt={run.company_name} />
          <div>
            <div className="slip-company">{run.company_name}</div>
            <div className="slip-title">PAYSLIP</div>
          </div>
        </div>
        <div className="slip-period">
          <div><span>Period</span> {formatPeriod(run.period_start, run.period_end)}</div>
          <div><span>Pay date</span> {formatDate(run.pay_date)}</div>
        </div>
      </header>

      <dl className="slip-info">
        <dt>Name</dt><dd>{slip.employee_name}</dd>
        <dt>Employee No.</dt><dd>{slip.employee_code || '—'}</dd>
        <dt>Position</dt><dd>{slip.position_title || '—'}</dd>
        <dt>Branch</dt><dd>{[slip.branch_name, slip.department_name].filter(Boolean).join(' · ') || '—'}</dd>
        <dt>Rate</dt><dd>{slip.pay_type === 'daily' ? `${peso(slip.base_rate)} / day` : `${peso(slip.base_rate)} / month`}</dd>
        <dt>Attendance</dt>
        <dd>
          {Number(slip.days_worked)} day{Number(slip.days_worked) === 1 ? '' : 's'} worked
          {slip.days_absent > 0 && ` · ${slip.days_absent} absent`}
          {slip.late_minutes > 0 && ` · ${slip.late_minutes}m late`}
          {slip.undertime_minutes > 0 && ` · ${slip.undertime_minutes}m undertime`}
          {otHours > 0 && ` · ${otHours}h OT`}
        </dd>
      </dl>

      <div className="slip-cols">
        <Lines title="Earnings" lines={shown('earning')} totalLabel="Gross pay" />
        <Lines title="Deductions" lines={shown('deduction')} totalLabel="Total deductions" />
      </div>

      <div className="slip-net">
        <span>NET PAY</span>
        <strong>₱ {peso(slip.net_pay)}</strong>
      </div>

      <div className="slip-sign">
        <div>Prepared by</div>
        <div>Received by (signature over printed name) / Date</div>
      </div>
    </section>
  );
}

export default function PayslipPrint() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/payroll/${id}/payslips`, { params: Object.fromEntries(params.entries()) })
      .then(({ data: d }) => {
        setData(d);
        document.title = d.slips.length === 1
          ? `Payslip - ${d.slips[0].employee_name}`
          : `Payslips - ${d.run.company_name} ${d.run.period_start}`;
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not load the payslips'));
  }, [id, params]);

  if (error) return <div className="dtr-page"><div className="error-banner">{error}</div></div>;
  if (!data) return <LoadingSpinner />;

  const { run, slips } = data;
  return (
    <div className="dtr-page">
      <div className="print-toolbar dtr-toolbar">
        <button className="btn btn-primary" onClick={() => window.print()}>Print</button>
        <span className="muted">
          {slips.length} payslip{slips.length === 1 ? '' : 's'} · {run.company_name} · {formatPeriod(run.period_start, run.period_end)} · two per page
          {run.status !== 'approved' && ' · not approved yet, printed as DRAFT'}
        </span>
      </div>
      {slips.length === 0
        ? <div className="empty-state">No employees in this payroll.</div>
        : slips.map((s) => <Slip key={s.id} run={run} slip={s} />)}
    </div>
  );
}
