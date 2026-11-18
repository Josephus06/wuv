import { useEffect, useState } from 'react';
import BirCompanyPicker from '../../components/BirCompanyPicker';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import { DeadlineBanner, MonthPicker, Stat, money, useCsvDownload, useMonth } from './BirTaxCommon';

const right = { textAlign: 'right' };

// BIR Reports > VAT Computation (asked 2026-10-21): Output Tax (sales, less returns) less Input Tax
// (purchases) for the month -- the figures for the 2550M / 2550Q. Due the 15th of the next month.
export default function BirVatReport() {
  const [month, setMonth] = useMonth(-1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const csv = useCsvDownload('/reports/bir/vat', { month }, `bir-vat-${month}.csv`);

  useEffect(() => {
    let live = true;
    setLoading(true); setError('');
    api.get('/reports/bir/vat', { params: { month } })
      .then(({ data: d }) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e.response?.data?.error || 'Could not load the report.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [month]);

  const t = data?.totals;
  return (
    <div>
      <div className="page-header">
        <h1>VAT Computation</h1>
        <BirCompanyPicker />
        <button className="btn btn-primary" disabled={csv.busy || !data} onClick={csv.download}>
          {csv.busy ? 'Preparing…' : 'Download details (CSV)'}
        </button>
      </div>
      {(error || csv.error) && <div className="error-banner">{error || csv.error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <MonthPicker month={month} onChange={setMonth} />
      </div>

      {loading ? <LoadingSpinner /> : data && (
        <>
          <DeadlineBanner deadline={data.deadline} what={`VAT for ${data.label} (2550M / 2550Q)`} />
          <div className="stat-grid">
            <Stat label="Output Tax" value={money(t.output_tax)} />
            <Stat label="Less: Input Tax" value={money(t.input_tax)} />
            <Stat label={t.vat_payable >= 0 ? 'VAT Payable' : 'Excess Input Tax (carry over)'} value={money(Math.abs(t.vat_payable))} tone={t.vat_payable >= 0 ? 'danger' : 'success'} />
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ marginTop: 0 }}>Output Tax — Sales</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Sales</th><th style={right}>Invoices</th><th style={right}>Gross Sales</th><th style={right}>Less: Returns (CM)</th><th style={right}>Net Sales</th><th style={right}>Output Tax</th></tr>
                </thead>
                <tbody>
                  {data.output.map((o) => (
                    <tr key={o.key}>
                      <td>{o.label}</td>
                      <td style={right}>{o.invoices}{o.credit_memos ? <div className="muted" style={{ fontSize: 12 }}>{o.credit_memos} CM</div> : null}</td>
                      <td style={right}>{money(o.gross_sales)}</td>
                      <td style={right}>{o.returns ? `(${money(o.returns)})` : '—'}</td>
                      <td style={right}>{money(o.net_sales)}</td>
                      <td style={right}><strong>{money(o.output_tax)}</strong></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th colSpan={4}>Total</th>
                    <th style={right}>{money(data.output.reduce((s, o) => s + o.net_sales, 0))}</th>
                    <th style={right}>{money(t.output_tax)}</th>
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              By each invoice line&apos;s tax code. Returns are credit memos for returns or allowances only -- credit memos that clear a customer&apos;s withholding tax or write off a bad debt are not sales returns and are left out.
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ marginTop: 0 }}>Input Tax — Purchases</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Purchases</th><th style={right}>Documents</th><th style={right}>Net of VAT</th><th style={right}>Input Tax</th></tr>
                </thead>
                <tbody>
                  {data.input.map((i) => (
                    <tr key={i.key}>
                      <td>{i.label}</td>
                      <td style={right}>{i.count}</td>
                      <td style={right}>{money(i.net)}</td>
                      <td style={right}><strong>{money(i.input_tax)}</strong></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><th colSpan={3}>Total</th><th style={right}>{money(t.input_tax)}</th></tr>
                </tfoot>
              </table>
            </div>
            {data.purchases_not_subject_to_vat.count > 0 && (
              <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                Not counted: {data.purchases_not_subject_to_vat.count} vendor bills with no VAT (non-VAT suppliers / exempt) · {money(data.purchases_not_subject_to_vat.net)}
              </div>
            )}
          </div>

          <div className="card">
            <table>
              <tbody>
                <tr><td>Output Tax</td><td style={right}>{money(t.output_tax)}</td></tr>
                <tr><td>Less: Input Tax</td><td style={right}>({money(t.input_tax)})</td></tr>
                <tr>
                  <th>{t.vat_payable >= 0 ? 'VAT Payable' : 'Excess Input Tax'}</th>
                  <th style={right}>{money(Math.abs(t.vat_payable))}</th>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
