import { useEffect, useState } from 'react';
import api from '../../api/client';
import EntityPicker from '../../components/EntityPicker';
import LoadingSpinner from '../../components/LoadingSpinner';
import Modal from '../../components/Modal';
import CommissionPayableCell from '../../components/CommissionPayableCell';
import { money } from './CoaTreeRows';

function currentYear() { return new Date().getFullYear(); }

// Mirrors the real Commission module's Commission report: pick a Sales Rep, an optional
// Sales Division, and a Year, then twelve month rows of quota / weighted sales /
// performance / the several commission figures. Every column is computed server-side
// (see lib/commissionReport.js) from the rep's own commission scheme and their JOs.
export default function CommissionReport() {
  const [salesRep, setSalesRep] = useState(null);
  const [division, setDivision] = useState(null);
  const [year, setYear] = useState(currentYear());
  const [reps, setReps] = useState([]);
  const [divisions, setDivisions] = useState([]);
  const [selfOnly, setSelfOnly] = useState(false);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Released Commission drill-down: the vouchers behind one month's figure.
  const [released, setReleased] = useState(null);

  async function openReleased(row) {
    setReleased({ month_name: row.month_name, loading: true, rows: [] });
    try {
      const { data } = await api.get('/reports/commission/released-detail', { params: { employeeId: report.employee_id ?? salesRep?.id, year, month: row.month } });
      setReleased({ month_name: row.month_name, ...data });
    } catch (err) {
      setReleased({ month_name: row.month_name, rows: [], error: err.response?.data?.error || 'Could not load the vouchers.' });
    }
  }

  async function runReport(repId, yr = year) {
    if (!repId) { setError('Select a Sales Rep first.'); return; }
    setLoading(true);
    setError('');
    try {
      const params = { employeeId: repId, year: yr };
      if (division && !selfOnly) params.salesDivisionId = division.id;
      const { data } = await api.get('/reports/commission', { params });
      setReport(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to generate report');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Scope drives the whole page; keep it independent of the divisions lookup, which an
    // Account Officer isn't permitted to call (and doesn't need -- their picker is hidden).
    api.get('/reports/commission/scope').then(({ data }) => {
      setReps(data.reps);
      if (data.self_only && data.self) {
        // Account Officer / plain sales user: no picker -- auto-run their own report.
        setSelfOnly(true);
        setSalesRep(data.self);
        runReport(data.self.id);
      } else {
        // Only users who pick a rep also use the division filter (best-effort).
        api.get('/lookups/sales-divisions').then((r) => setDivisions(r.data)).catch(() => {});
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function generate() { runReport(salesRep?.id); }

  const totals = report ? report.rows.reduce((t, r) => ({
    weighted_sales: t.weighted_sales + r.weighted_sales,
    estimated_commission: t.estimated_commission + r.estimated_commission,
    passing_gp_total: t.passing_gp_total + r.passing_gp_total,
    expected_commission: t.expected_commission + r.expected_commission,
    confirmed_commission: t.confirmed_commission + r.confirmed_commission,
    released_commission: t.released_commission + r.released_commission,
    expenses_deducted: t.expenses_deducted + (r.expenses_deducted || 0),
    expenses_refunded: t.expenses_refunded + (r.expenses_refunded || 0),
    unpaid_commission: t.unpaid_commission + r.unpaid_commission,
  }), {
    weighted_sales: 0, estimated_commission: 0, passing_gp_total: 0, expected_commission: 0,
    confirmed_commission: 0, released_commission: 0, expenses_deducted: 0, expenses_refunded: 0, unpaid_commission: 0,
  }) : null;

  return (
    <div>
      <div className="page-header">
        <h1>Commission</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          {!selfOnly && (
            <div className="field">
              <label>Sales Rep.</label>
              <EntityPicker
                label="Sales Rep" items={reps} value={salesRep?.id || ''} getLabel={(r) => r.name}
                columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} onSelect={setSalesRep}
              />
            </div>
          )}
          {!selfOnly && (
            <div className="field">
              <label>Sales Division</label>
              <EntityPicker
                label="Sales Division" items={divisions} value={division?.id || ''} getLabel={(d) => d.name}
                columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} onSelect={setDivision}
              />
            </div>
          )}
          <div className="field">
            <label>Year</label>
            <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 120 }} />
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={generate} disabled={loading}>
          {loading ? 'Generating...' : 'Generate'}
        </button>
      </div>

      {error && <div className="card" style={{ color: '#b91c1c', marginBottom: 16 }}>{error}</div>}

      {loading && <LoadingSpinner />}

      {!loading && report && (
        <div className="card">
          <div style={{ marginBottom: 12, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <strong>{report.employee_name}</strong>
            <span>Year: {report.year}</span>
            <span>Scheme: {report.scheme_name || <span style={{ color: '#b91c1c' }}>none (no role scheme)</span>}</span>
          </div>
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th rowSpan={2}>Month</th>
                  <th rowSpan={2}>CP #</th>
                  <th rowSpan={2} style={{ textAlign: 'right' }}>Quota</th>
                  <th rowSpan={2}>Sales Division</th>
                  <th rowSpan={2} style={{ textAlign: 'right' }}>Weighted Sales</th>
                  <th rowSpan={2} style={{ textAlign: 'right' }}>%</th>
                  <th rowSpan={2} style={{ textAlign: 'right' }}>Estimated Commission</th>
                  <th rowSpan={2} style={{ textAlign: 'right' }}>Total Amount of JO&apos;s with Passing Rate</th>
                  <th rowSpan={2} style={{ textAlign: 'right' }}>Expected Commission</th>
                  <th rowSpan={2} style={{ textAlign: 'right' }}>Confirmed Commission</th>
                  <th rowSpan={2} style={{ textAlign: 'right' }}>Released Commission</th>
                  <th colSpan={2} style={{ textAlign: 'center' }}>Expenses</th>
                  <th rowSpan={2} style={{ textAlign: 'right' }}>Unpaid Commission</th>
                </tr>
                <tr>
                  <th style={{ textAlign: 'right' }}>Deducted</th>
                  <th style={{ textAlign: 'right' }}>Refunded</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.month}>
                    <td data-label="Month">{r.month_name}</td>
                    <td data-label="CP #"><CommissionPayableCell row={r} /></td>
                    <td data-label="Quota" style={{ textAlign: 'right' }}>{money(r.quota)}</td>
                    <td data-label="Sales Division">{r.division_name || ''}</td>
                    <td data-label="Weighted Sales" style={{ textAlign: 'right' }}>{money(r.weighted_sales)}</td>
                    <td data-label="%" style={{ textAlign: 'right' }}>{money(r.performance_pct)}</td>
                    <td data-label="Estimated Commission" style={{ textAlign: 'right' }}>{money(r.estimated_commission)}</td>
                    <td data-label="Total JO Passing" style={{ textAlign: 'right' }}>{money(r.passing_gp_total)}</td>
                    <td data-label="Expected Commission" style={{ textAlign: 'right' }}>{money(r.expected_commission)}</td>
                    <td data-label="Confirmed Commission" style={{ textAlign: 'right' }}>{money(r.confirmed_commission)}</td>
                    <td data-label="Released Commission" style={{ textAlign: 'right' }}>
                      {Number(r.released_commission) !== 0
                        ? <button type="button" className="link-btn" title="Show the vouchers" onClick={() => openReleased(r)}>{money(r.released_commission)}</button>
                        : money(r.released_commission)}
                    </td>
                    <td data-label="Deducted" style={{ textAlign: 'right' }}>{r.expenses_deducted ? money(r.expenses_deducted) : ''}</td>
                    <td data-label="Refunded" style={{ textAlign: 'right' }}>{r.expenses_refunded ? money(r.expenses_refunded) : ''}</td>
                    <td data-label="Unpaid Commission" style={{ textAlign: 'right' }}>{money(r.unpaid_commission)}</td>
                  </tr>
                ))}
              </tbody>
              {totals && (
                <tfoot>
                  <tr style={{ fontWeight: 700 }}>
                    <td>Total</td>
                    <td></td>
                    <td></td>
                    <td></td>
                    <td style={{ textAlign: 'right' }}>{money(totals.weighted_sales)}</td>
                    <td></td>
                    <td style={{ textAlign: 'right' }}>{money(totals.estimated_commission)}</td>
                    <td style={{ textAlign: 'right' }}>{money(totals.passing_gp_total)}</td>
                    <td style={{ textAlign: 'right' }}>{money(totals.expected_commission)}</td>
                    <td style={{ textAlign: 'right' }}>{money(totals.confirmed_commission)}</td>
                    <td style={{ textAlign: 'right' }}>{money(totals.released_commission)}</td>
                    <td style={{ textAlign: 'right' }}>{totals.expenses_deducted ? money(totals.expenses_deducted) : ''}</td>
                    <td style={{ textAlign: 'right' }}>{totals.expenses_refunded ? money(totals.expenses_refunded) : ''}</td>
                    <td style={{ textAlign: 'right' }}>{money(totals.unpaid_commission)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
            Released Commission is what the employee&apos;s Commission Vouchers paid against the month, before deductions (as the source system shows it) &mdash; click it to see the vouchers. Unpaid = Confirmed − Released.
            Deducted / Refunded show the vouchers&apos; expense adjustments for information; they do not reduce Released.
            CP # is the month&apos;s Commission Payable; <span style={{ color: '#b91c1c', fontWeight: 600 }}>No CP</span> means none has been created yet: the month cannot be released on a Commission Voucher, and its Confirmed and Unpaid Commission are not shown until one is.
          </p>
        </div>
      )}

      {released && (
        <Modal title={`Released Commission — ${released.month_name} ${year}`} onClose={() => setReleased(null)} large>
          {released.loading ? <LoadingSpinner /> : released.error ? <div className="error-banner">{released.error}</div> : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Voucher #</th><th>Date</th><th>Commission Payable</th>
                    <th style={{ textAlign: 'right' }}>Released for {released.month_name}</th>
                    <th style={{ textAlign: 'right' }}>Voucher Total</th>
                    <th style={{ textAlign: 'right' }}>Voucher Deductions</th>
                  </tr>
                </thead>
                <tbody>
                  {released.rows.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center' }}>No vouchers.</td></tr>}
                  {released.rows.map((v, i) => (
                    <tr key={`${v.voucher_id}-${v.payable_id}-${i}`}>
                      <td><button type="button" className="link-btn" onClick={() => window.open(`/commission-vouchers/${v.voucher_id}`, '_blank')}>{v.voucher_no}</button></td>
                      <td>{String(v.date_created).slice(0, 10)}</td>
                      <td><button type="button" className="link-btn" onClick={() => window.open(`/commission-payables/${v.payable_id}`, '_blank')}>{v.commission_payable_no}</button></td>
                      <td style={{ textAlign: 'right' }}>{money(v.released_amount)}</td>
                      <td style={{ textAlign: 'right' }}>{money(v.total_payments)}</td>
                      <td style={{ textAlign: 'right' }}>{v.voucher_deductions ? money(v.voucher_deductions) : ''}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700 }}><td colSpan={3}>Total released</td><td style={{ textAlign: 'right' }}>{money(released.total)}</td><td colSpan={2}></td></tr>
                </tfoot>
              </table>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
