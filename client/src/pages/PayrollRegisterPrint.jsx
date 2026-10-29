import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import PayrollSignatories from '../components/PayrollSignatories';
import {
  companyLogo, formatDate, formatPeriod, isSquareLogo, peso, RUN_STATUS, WU_LOGO,
} from '../utils/payroll';

// Printable payroll register of a run: every employee's days, gross, contributions, tax, other
// deductions and net pay, with totals, a column to sign on release, and who prepared, noted and
// approved the run. Opened in its own tab from the run; rendered without the app chrome.

const other = (e) => Number(e.total_deductions) - Number(e.sss_ee) - Number(e.philhealth_ee) - Number(e.pagibig_ee) - Number(e.withholding_tax);
const sum = (rows, f) => rows.reduce((s, e) => s + f(e), 0);

export default function PayrollRegisterPrint() {
  const { id } = useParams();
  const [run, setRun] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/payroll/${id}`)
      .then(({ data }) => {
        setRun(data);
        document.title = `Payroll - ${data.company_name} ${data.period_start}`;
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not load the payroll'));
  }, [id]);

  if (error) return <div className="dtr-page"><div className="error-banner">{error}</div></div>;
  if (!run) return <LoadingSpinner />;

  const rows = [...run.employees].sort((a, b) => String(a.branch_name || '').localeCompare(String(b.branch_name || ''))
    || a.employee_name.localeCompare(b.employee_name));
  const logo = companyLogo(run);
  const approved = run.status === 'approved';

  return (
    <div className="dtr-page">
      <div className="print-toolbar dtr-toolbar">
        <button className="btn btn-primary" onClick={() => window.print()}>Print</button>
        <span className="muted">
          {rows.length} employee{rows.length === 1 ? '' : 's'} · {RUN_STATUS[run.status]?.label || run.status}
          {!approved && ' · not approved yet, printed as DRAFT'}
        </span>
      </div>

      <section className="register">
        <img className="slip-watermark" src={WU_LOGO} alt="" />
        {!approved && <div className="slip-draft">DRAFT</div>}
        <header className="slip-head">
          <div className="slip-brand">
            <img className={`slip-logo${isSquareLogo(logo) ? ' is-square' : ''}`} src={logo} alt={run.company_name} />
            <div>
              <div className="slip-company">{run.company_name}</div>
              <div className="slip-title">PAYROLL REGISTER</div>
            </div>
          </div>
          <div className="slip-period">
            <div><span>Period</span> {formatPeriod(run.period_start, run.period_end)} ({run.cutoff === 1 ? '1st' : '2nd'} cutoff)</div>
            <div><span>Pay date</span> {formatDate(run.pay_date)}</div>
          </div>
        </header>

        <table className="register-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Employee</th>
              <th className="num">Days</th>
              <th className="num">Gross Pay</th>
              <th className="num">SSS</th>
              <th className="num">PhilHealth</th>
              <th className="num">Pag-IBIG</th>
              <th className="num">Tax</th>
              <th className="num">Other Ded.</th>
              <th className="num">Net Pay</th>
              <th>Signature</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e, i) => (
              <tr key={e.id}>
                <td>{i + 1}</td>
                <td>
                  <strong>{e.employee_name}</strong>
                  <div className="register-sub">{[e.employee_code, e.branch_name].filter(Boolean).join(' · ')}</div>
                </td>
                <td className="num">{Number(e.days_worked)}</td>
                <td className="num">{peso(e.gross_pay)}</td>
                <td className="num">{peso(e.sss_ee)}</td>
                <td className="num">{peso(e.philhealth_ee)}</td>
                <td className="num">{peso(e.pagibig_ee)}</td>
                <td className="num">{peso(e.withholding_tax)}</td>
                <td className="num">{peso(other(e))}</td>
                <td className="num"><strong>{peso(e.net_pay)}</strong></td>
                <td className="register-sign" />
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={3}>Total · {rows.length} employee{rows.length === 1 ? '' : 's'}</th>
              <th className="num">{peso(run.total_gross)}</th>
              <th className="num">{peso(sum(rows, (e) => Number(e.sss_ee)))}</th>
              <th className="num">{peso(sum(rows, (e) => Number(e.philhealth_ee)))}</th>
              <th className="num">{peso(sum(rows, (e) => Number(e.pagibig_ee)))}</th>
              <th className="num">{peso(sum(rows, (e) => Number(e.withholding_tax)))}</th>
              <th className="num">{peso(sum(rows, other))}</th>
              <th className="num">{peso(run.total_net)}</th>
              <th />
            </tr>
          </tfoot>
        </table>

        <PayrollSignatories signatories={run.signatories} />
      </section>
    </div>
  );
}
