import { useEffect, useState } from 'react';
import BirCompanyPicker from '../../components/BirCompanyPicker';
import { useSearchParams } from 'react-router-dom';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import { DeadlineBanner, Stat, money } from './BirTaxCommon';

// BIR Reports > Income Tax Return (asked 2026-11-07): the quarterly corporate income tax return,
// BIR Form 1702Q, cumulative from January 1 as the form is -- from the Income Statement, at RCIT 25%
// against MCIT 2% of gross income. The tax credits start from what T1S knows (prior quarters' tax due,
// the CWT on customers' invoices); Accounting replaces any of them with the figure actually filed or
// paid, and the tax payable follows. Those edits are for the computation on screen, not saved.

const right = { textAlign: 'right' };
const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
function lastQuarter() {
  const t = manilaToday(); let y = Number(t.slice(0, 4)); let q = Math.floor((Number(t.slice(5, 7)) - 1) / 3);
  if (q === 0) { q = 4; y -= 1; }
  return `${y}-Q${q}`;
}
function stepQuarter(q, n) {
  const [y, k] = q.split('-Q').map(Number);
  const i = y * 4 + (k - 1) + n;
  return `${Math.floor(i / 4)}-Q${(i % 4) + 1}`;
}
const pct = (r) => `${Math.round(r * 1000) / 10}%`;
const CREDIT_LINES = [
  ['prior_year_excess', 'Prior year’s excess credits'],
  ['prior_quarter_payments', 'Tax payment(s) for the previous quarter(s)'],
  ['cwt_prior_quarters', 'Creditable tax withheld (2307) for the previous quarter(s)'],
  ['cwt_this_quarter', 'Creditable tax withheld (2307) per BIR Form 2307 for this quarter'],
];

export default function BirItrReport() {
  const [params, setParams] = useSearchParams();
  const quarter = /^\d{4}-Q[1-4]$/.test(params.get('quarter') || '') ? params.get('quarter') : lastQuarter();
  const setQuarter = (q) => { const p = new URLSearchParams(params); p.set('quarter', q); setParams(p, { replace: true }); };
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [credits, setCredits] = useState({});

  useEffect(() => {
    let live = true;
    setLoading(true); setError('');
    api.get('/reports/bir/itr', { params: { quarter } })
      .then(({ data: d }) => { if (!live) return; setData(d); setCredits(Object.fromEntries(Object.entries(d.credits).map(([k, v]) => [k, String(v)]))); })
      .catch((e) => { if (live) setError(e.response?.data?.error || 'Could not compute the return.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [quarter]);

  const y = data?.ytd;
  const totalCredits = CREDIT_LINES.reduce((s, [k]) => s + (Number(credits[k]) || 0), 0);
  const payable = y ? Math.round((y.tax_due - totalCredits) * 100) / 100 : 0;
  const edited = data && CREDIT_LINES.some(([k]) => Number(credits[k] || 0) !== Number(data.credits[k] || 0));

  // One line of the computation: the quarter's figure and the cumulative one beside it.
  const Line = ({ no, label, q, ytd, bold, sub }) => (
    <tr style={bold ? { fontWeight: 700 } : undefined}>
      <td className="muted" style={{ width: 36 }}>{no}</td>
      <td style={sub ? { paddingLeft: 24 } : undefined}>{label}</td>
      <td style={right}>{q == null ? '' : money(q)}</td>
      <td style={right}>{ytd == null ? '' : money(ytd)}</td>
    </tr>
  );

  return (
    <div>
      <div className="page-header"><h1>Income Tax Return (1702Q)</h1>
        <BirCompanyPicker /></div>
      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16, display: 'flex', gap: 6, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-secondary" onClick={() => setQuarter(stepQuarter(quarter, -1))} aria-label="Previous quarter">‹</button>
        <div className="field" style={{ margin: 0 }}>
          <label>Quarter</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input type="number" style={{ width: 90 }} value={quarter.slice(0, 4)}
              onChange={(e) => /^\d{4}$/.test(e.target.value) && setQuarter(`${e.target.value}-${quarter.slice(5)}`)} />
            <select value={quarter.slice(5)} onChange={(e) => setQuarter(`${quarter.slice(0, 4)}-${e.target.value}`)}>
              <option value="Q1">Q1 (Jan – Mar)</option>
              <option value="Q2">Q2 (Apr – Jun)</option>
              <option value="Q3">Q3 (Jul – Sep)</option>
              <option value="Q4">Q4 (Oct – Dec)</option>
            </select>
          </div>
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => setQuarter(stepQuarter(quarter, 1))} aria-label="Next quarter">›</button>
        {data && <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={() => window.print()}>Print</button>}
      </div>

      {loading ? <LoadingSpinner /> : data && (
        <>
          <DeadlineBanner deadline={data.deadline}
            what={data.n < 4 ? `Income tax for ${data.label} (BIR Form 1702Q)` : `Q4 goes on the annual return (BIR Form 1702-RT) for ${data.year}`} />

          <div className="stat-grid">
            <Stat label="Taxable income to date" value={money(y.taxable_income)} />
            <Stat label={`Tax due (${y.mcit_applies ? `MCIT ${pct(data.rates.mcit)}` : `RCIT ${pct(data.rates.rcit)}`})`} value={money(y.tax_due)} />
            <Stat label="Less: tax credits" value={money(totalCredits)} />
            <Stat label={payable >= 0 ? 'Tax payable' : 'Overpayment'} value={money(Math.abs(payable))} tone={payable > 0 ? 'danger' : 'success'} />
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ marginTop: 0 }}>Computation of tax — {data.label}</h3>
            <div className="table-wrap">
              <table>
                <thead><tr><th /><th /><th style={right}>This quarter</th><th style={right}>January 1 to date</th></tr></thead>
                <tbody>
                  <Line no="1" label="Sales / revenues / receipts / fees" q={data.this_quarter.sales} ytd={y.sales} />
                  <Line no="2" label="Less: cost of sales / services" q={data.this_quarter.cost} ytd={y.cost} />
                  <Line no="3" label="Gross income from operation" q={data.this_quarter.gross_from_operation} ytd={y.gross_from_operation} bold />
                  <Line no="4" label="Add: other taxable income not subjected to final tax" q={data.this_quarter.other_income} ytd={y.other_income} />
                  <Line no="5" label="Total gross income" q={data.this_quarter.gross_income} ytd={y.gross_income} bold />
                  <Line no="6" label="Less: deductions" q={data.this_quarter.deductions} ytd={y.deductions} />
                  {y.deduction_sections.map((s) => <Line key={s.label} label={s.label.toLowerCase().replace(/^\w/, (c) => c.toUpperCase())} ytd={s.amount} sub />)}
                  {y.income_tax_excluded.map((a) => <Line key={a.code} label={`Less: ${a.code} ${a.name} (not deductible)`} ytd={-a.amount} sub />)}
                  <Line no="7" label="Taxable income" q={data.this_quarter.taxable_income} ytd={y.taxable_income} bold />
                  <Line no="8" label={`Regular income tax — ${pct(data.rates.rcit)} of taxable income to date`} ytd={y.rcit} />
                  <Line no="9" label={`Minimum corporate income tax — ${pct(data.rates.mcit)} of total gross income to date`} ytd={y.mcit} />
                  <Line no="10" label={`Income tax due — the higher of 8 and 9 (${y.mcit_applies ? 'MCIT' : 'RCIT'})`} ytd={y.tax_due} bold />
                </tbody>
              </table>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ marginTop: 0 }}>Less: tax credits / payments</h3>
            <div className="table-wrap">
              <table>
                <tbody>
                  {CREDIT_LINES.map(([k, label]) => (
                    <tr key={k}>
                      <td>{label}
                        {k === 'prior_quarter_payments' && <div className="muted" style={{ fontSize: 12 }}>Starts at the previous quarters’ tax due as computed here ({money(data.credits[k])}). Replace with what was paid.</div>}
                        {k === 'cwt_this_quarter' && <div className="muted" style={{ fontSize: 12 }}>The withholding on customers’ invoices of the quarter ({y.cwt.count} invoice{y.cwt.count === 1 ? '' : 's'} to date). Claim only what 2307s were received for.</div>}
                      </td>
                      <td style={{ ...right, width: 200 }}>
                        <input type="number" step="0.01" style={{ width: 170, textAlign: 'right' }} value={credits[k] ?? ''}
                          onChange={(e) => setCredits((c) => ({ ...c, [k]: e.target.value }))} />
                      </td>
                    </tr>
                  ))}
                  <tr style={{ fontWeight: 700 }}><td>Total tax credits / payments</td><td style={right}>{money(totalCredits)}</td></tr>
                  <tr style={{ fontWeight: 700 }}>
                    <td>{payable >= 0 ? 'Tax payable' : 'Overpayment'} (income tax due less credits)</td>
                    <td style={right}>{money(Math.abs(payable))}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            {edited && (
              <div style={{ marginTop: 8 }}>
                <button type="button" className="btn btn-sm" onClick={() => setCredits(Object.fromEntries(Object.entries(data.credits).map(([k, v]) => [k, String(v)])))}>Reset to T1S figures</button>
                <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>Your changes are for this computation only; they are not saved.</span>
              </div>
            )}
          </div>

          <div className="muted" style={{ fontSize: 12 }}>
            From the Income Statement, January 1 – {data.to}: Revenues, less Cost of Goods Sold and Cost of Services; Other Income added;
            every other expense section deducted except provision for income tax. Income already subjected to final tax (e.g. bank interest)
            should be taken out of Other Income before filing. MCIT applies from the fourth taxable year of operations.
          </div>
        </>
      )}
    </div>
  );
}
