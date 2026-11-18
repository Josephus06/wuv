import { useEffect, useState } from 'react';
import api from '../../api/client';
import { CustomerLink } from '../../components/PartyLink';
import { useAuth } from '../../context/useAuth';
import EntityPicker from '../../components/EntityPicker';
import LoadingSpinner from '../../components/LoadingSpinner';
import { money } from './CoaTreeRows';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function currentYear() { return new Date().getFullYear(); }
function pct(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

// How the month's Unpaid Commission comes about, step by step, with the Commission report's own
// figures for the month (asked 2026-10-07, laid out like the Book1 worksheet Accounting uses):
//   Confirmed = Total invoiced JO with passing GP / JO passing GP x Expected
//   Unpaid    = Confirmed - Released
// The figures come from the report's row (server: month_summary), so they always match it.
function UnpaidDerivation({ s, monthName, year }) {
  const step = { display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) auto', gap: '4px 24px', alignItems: 'baseline' };
  const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
  const note = { gridColumn: '1 / -1', fontSize: 12, marginTop: -2, marginBottom: 6 };
  const ratio = Number(s.passing_gp_total) > 0 ? (Number(s.paid_passing_total) / Number(s.passing_gp_total)) * 100 : 0;
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 className="subsection" style={{ marginTop: 0 }}>How the Unpaid Commission is derived — {monthName} {year}</h3>
      <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
        <div style={{ ...step, flex: '1 1 420px' }}>
          <span>Expected Commission</span><strong style={num}>{money(s.expected_commission)}</strong>
          <span className="muted" style={note}>{s.scheme_name || 'The scheme'} looked up at the JO passing GP total below</span>

          <span>JO passing GP</span><strong style={num}>{money(s.passing_gp_total)}</strong>
          <span className="muted" style={note}>Net of tax of every JO that met its passing GP rate (or was added) — the &quot;Passing&quot; rows below</span>

          <span>Total invoiced JO with passing GP</span><strong style={num}>{money(s.paid_passing_total)}</strong>
          <span className="muted" style={note}>The paid-invoice part of those JOs ({pct(ratio)}% of them)</span>

          <span style={{ borderTop: '1px solid var(--border)', paddingTop: 6, fontWeight: 600 }}>Confirmed Commission</span>
          <strong style={{ ...num, borderTop: '1px solid var(--border)', paddingTop: 6 }}>{money(s.confirmed_commission)}</strong>
          <span className="muted" style={note}>
            {money(s.paid_passing_total)} ÷ {money(s.passing_gp_total)} × {money(s.expected_commission)}
          </span>

          <span>Released Commission</span><strong style={num}>{money(s.released_commission)}</strong>
          <span className="muted" style={note}>Paid by Commission Vouchers against {monthName}</span>

          <span style={{ borderTop: '2px solid var(--text, #333)', paddingTop: 6, fontWeight: 700 }}>Unpaid Commission</span>
          <strong style={{ ...num, borderTop: '2px solid var(--text, #333)', paddingTop: 6, fontSize: '1.1em' }}>{money(s.unpaid_commission)}</strong>
          <span className="muted" style={note}>{money(s.confirmed_commission)} − {money(s.released_commission)}</span>
        </div>
        <div style={{ flex: '0 1 300px', fontSize: 13, background: 'var(--surface-2, #f3f4f6)', borderRadius: 8, padding: '10px 14px', alignSelf: 'flex-start' }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Formula</div>
          <div>Confirmed Commission =</div>
          <div style={{ paddingLeft: 12, marginBottom: 8 }}>Total invoiced JO with passing GP ÷ JO passing GP × Expected Commission</div>
          <div>Unpaid Commission =</div>
          <div style={{ paddingLeft: 12 }}>Confirmed Commission − Released Commission</div>
        </div>
      </div>
    </div>
  );
}

// Per-JO commission detail for one rep in one month: every JO (own + team + any SBU-owned
// divisions) with its GP rate, net of tax and paid-invoice amount, split into JOs that met
// their job type's passing GP rate and those below it. This is the line-by-line backing
// behind the monthly Commission report's passing-GP total and Confirmed figure.
export default function CommissionJoDetail() {
  const { can } = useAuth();
  const [salesRep, setSalesRep] = useState(null);
  const [division, setDivision] = useState(null);
  const [year, setYear] = useState(currentYear());
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [reps, setReps] = useState([]);
  const [divisions, setDivisions] = useState([]);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [savingLine, setSavingLine] = useState(null);

  const canApprove = can('/commission-report', 'can_approve');

  // Add a below-GP job order to the rep's commission (or take it back out). The totals and the
  // GP Status column both move, so the report is regenerated rather than patched in place --
  // it keeps this screen honest about what the monthly Commission report will now say.
  async function toggleCommission(row, include) {
    if (!row.sales_order_line_id) return;
    setSavingLine(row.sales_order_line_id);
    setError('');
    try {
      await api.post('/reports/commission/jo-detail/add-to-commission', {
        sales_order_line_id: row.sales_order_line_id, include,
      });
      await generate();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not update this job order.');
    } finally {
      setSavingLine(null);
    }
  }

  useEffect(() => {
    Promise.all([
      api.get('/reports/commission/sales-reps'),
      api.get('/lookups/sales-divisions'),
    ]).then(([repRes, divRes]) => { setReps(repRes.data); setDivisions(divRes.data); }).catch(() => {});
  }, []);

  // Extract: the job orders listed, as an Excel file -- the rep, month and division of the report
  // on screen, not whatever the filters have since been changed to.
  const [extracting, setExtracting] = useState(false);
  async function extract() {
    if (!report) return;
    setExtracting(true);
    setError('');
    try {
      const params = { employeeId: report.employee_id, year: report.year, month: report.month };
      if (report.sales_division_id) params.salesDivisionId = report.sales_division_id;
      const res = await api.get('/reports/commission/jo-detail/export', { params, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `commission-jo-detail-${String(report.employee_name || 'rep').replace(/[^\w.-]+/g, '-')}-${report.year}-${String(report.month).padStart(2, '0')}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError('Could not extract the job orders.');
    } finally {
      setExtracting(false);
    }
  }

  async function generate() {
    if (!salesRep) { setError('Select a Sales Rep first.'); return; }
    setLoading(true);
    setError('');
    try {
      const params = { employeeId: salesRep.id, year, month };
      if (division) params.salesDivisionId = division.id;
      const { data } = await api.get('/reports/commission/jo-detail', { params });
      setReport({ ...data, sales_division_id: division?.id || null });
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to generate report');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Commission — JO Detail</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Sales Rep.</label>
            <EntityPicker
              label="Sales Rep" items={reps} value={salesRep?.id || ''} getLabel={(r) => r.name}
              columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} onSelect={setSalesRep}
            />
          </div>
          <div className="field">
            <label>Sales Division</label>
            <EntityPicker
              label="Sales Division" items={divisions} value={division?.id || ''} getLabel={(d) => d.name}
              columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} onSelect={setDivision}
            />
          </div>
          <div className="field">
            <label>Month</label>
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Year</label>
            <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 110 }} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn-primary" onClick={generate} disabled={loading}>
            {loading ? 'Generating...' : 'Generate'}
          </button>
          {report && !loading && (
            <button className="btn" onClick={extract} disabled={extracting || report.rows.length === 0}>
              {extracting ? 'Extracting...' : 'Extract'}
            </button>
          )}
        </div>
      </div>

      {error && <div className="card" style={{ color: '#b91c1c', marginBottom: 16 }}>{error}</div>}
      {loading && <LoadingSpinner />}

      {!loading && report && (
        <>
          <div className="estimate-footer card" style={{ marginBottom: 16 }}>
            <div><span className="muted">Passing-GP JOs</span><div className="hi-lg">{report.totals.passing.count}</div></div>
            <div><span className="muted">Passing — Net of Tax</span><div className="hi-lg">{money(report.totals.passing.net_of_tax)}</div></div>
            <div><span className="muted">Passing — Paid Invoice</span><div className="hi-lg" style={{ color: '#15803d' }}>{money(report.totals.passing.paid_invoice)}</div></div>
            <div><span className="muted">Below-GP JOs</span><div className="hi-lg">{report.totals.below.count}</div></div>
            <div><span className="muted">Below — Net of Tax</span><div className="hi-lg">{money(report.totals.below.net_of_tax)}</div></div>
            <div><span className="muted">Below — Paid Invoice</span><div className="hi-lg" style={{ color: '#b91c1c' }}>{money(report.totals.below.paid_invoice)}</div></div>
          </div>

          {report.month_summary && <UnpaidDerivation s={report.month_summary} monthName={MONTHS[report.month - 1]} year={report.year} />}

          <div className="card">
            <div style={{ marginBottom: 12, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              <strong>{report.employee_name}</strong>
              <span>{MONTHS[report.month - 1]} {report.year}</span>
              <span>Team: {report.team_size}{report.sbu_division_count ? ` + ${report.sbu_division_count} division(s)` : ''}</span>
              <span>{report.rows.length} JO(s)</span>
            </div>
            <div className="table-wrap">
              <table className="responsive-cards">
                <thead>
                  <tr>
                    <th>JO #</th>
                    <th>SO #</th>
                    <th>DT #</th>
                    <th>Invoice #</th>
                    <th>Customer</th>
                    <th>Sales Rep</th>
                    <th>Job Type</th>
                    <th style={{ textAlign: 'right' }}>GP Rate</th>
                    <th style={{ textAlign: 'right' }}>Passing GP</th>
                    <th style={{ textAlign: 'right' }}>Net of Tax</th>
                    <th style={{ textAlign: 'right' }}>Paid Invoice</th>
                    <th>GP Status</th>
                    {canApprove && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {report.rows.length === 0 && (
                    <tr><td colSpan={canApprove ? 13 : 12} className="muted" style={{ textAlign: 'center', padding: 20 }}>No job orders for this rep in this month.</td></tr>
                  )}
                  {report.rows.map((r, i) => (
                    <tr key={i}>
                      <td data-label="JO #">{r.job_order_no}</td>
                      <td data-label="SO #">{r.sales_order_no}</td>
                      <td data-label="DT #">{r.dt_no || '—'}</td>
                      <td data-label="Invoice #">{r.invoice_no || '—'}</td>
                      <td data-label="Customer"><CustomerLink id={r.customer_id} name={r.customer_name} /></td>
                      <td data-label="Sales Rep">{r.rep_name}</td>
                      <td data-label="Job Type">{r.job_type}</td>
                      <td data-label="GP Rate" style={{ textAlign: 'right' }}>{r.gp_rate == null ? '—' : `${pct(r.gp_rate)}%`}</td>
                      <td data-label="Passing GP" style={{ textAlign: 'right' }}>{r.passing_gp_rate == null ? '—' : `${pct(r.passing_gp_rate)}%`}</td>
                      <td data-label="Net of Tax" style={{ textAlign: 'right' }}>{money(r.net_of_tax)}</td>
                      <td data-label="Paid Invoice" style={{ textAlign: 'right' }}>{money(r.paid_invoice)}</td>
                      <td data-label="GP Status">
                        <span style={{ color: r.is_passing ? '#15803d' : '#b91c1c', fontWeight: 600 }}>
                          {r.is_passing ? 'Passing' : 'Below GP'}
                        </span>
                        {/* A JO that only passes because it was added is marked, so nobody reads
                            the green "Passing" as if it had earned the GP rate on its own. */}
                        {r.is_approved_low_gp && !r.meets_gp && (
                          <div className="muted" style={{ fontSize: '0.85em' }}>added to commission</div>
                        )}
                      </td>
                      {canApprove && (
                        <td>
                          {/* Only a below-GP JO needs adding; one that already meets the rate
                              counts anyway, so there is nothing to offer. */}
                          {!r.meets_gp && r.sales_order_line_id && (
                            r.is_approved_low_gp ? (
                              <button
                                className="btn btn-sm"
                                disabled={savingLine === r.sales_order_line_id}
                                onClick={() => toggleCommission(r, false)}
                              >
                                {savingLine === r.sales_order_line_id ? 'Saving...' : 'Remove'}
                              </button>
                            ) : (
                              <button
                                className="btn btn-sm btn-primary"
                                disabled={savingLine === r.sales_order_line_id}
                                onClick={() => toggleCommission(r, true)}
                              >
                                {savingLine === r.sales_order_line_id ? 'Saving...' : 'Add to Commission'}
                              </button>
                            )
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
