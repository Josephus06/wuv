import { useState, useEffect } from 'react';
import api from '../../api/client';
import CompanyBranchFilter, { toParams, ScopeNote } from '../../components/CompanyBranchFilter';
import LoadingSpinner from '../../components/LoadingSpinner';
import { REPORT_TIMING } from '../../utils/reportTiming';
import { money } from './CoaTreeRows';

function today() { return new Date().toISOString().slice(0, 10); }

const BREAKDOWN_OPTIONS = [
  { value: 'total', label: 'Total Only' },
  { value: 'months', label: 'Months' },
  // One column per company in the group (each branch's company, locations.company_id).
  { value: 'company', label: 'Company' },
  { value: 'location', label: 'Location' },
  { value: 'department', label: 'Department' },
];

// Every row/column here is generic over `report.columns` (always >=1 entries, even in
// Total Only mode) -- one shared rendering path for all 4 breakdown modes, matching how
// the backend (reportsEngine.js's buildIncomeStatement) computes them through the same
// multi-column pipeline.
function SectionRows({ sections, columns, onDrill }) {
  const numCols = columns.length;
  const rows = [];
  // Render an account and, indented beneath it, its child accounts (the breakdown) --
  // e.g. 30000 Revenue with 30100 Sales / 30200 Sales Discount / 30300 Returns under it.
  const renderAccount = (a, depth) => {
    rows.push(
      <tr key={a.account_code}>
        <td style={{ paddingLeft: 24 + depth * 20 }}>{a.account_code}</td>
        <td style={depth === 0 && a.children && a.children.length ? { fontWeight: 600 } : undefined}>{a.account_name}</td>
        {a.amounts.map((v, i) => (
          // The breakdown's Total column (2026-10-26) in bold, so the row's sum reads apart from its parts.
          <td key={i} style={{ textAlign: 'right', ...(columns[i]?.key === '__total' ? { fontWeight: 600 } : {}) }}>
            {v ? (
              <button type="button" className="link-btn" style={{ color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer' }}
                onClick={() => onDrill(a, columns[i])}>{money(v)}</button>
            ) : money(v)}
            {' '}<span style={{ color: 'var(--muted, #888)', fontSize: '0.85em' }}>({a.percents ? a.percents[i] : 0}%)</span>
          </td>
        ))}
      </tr>
    );
    for (const c of (a.children || [])) renderAccount(c, depth + 1);
  };
  for (const s of sections) {
    rows.push(
      <tr key={`sub-${s.sub_type}`}>
        <td colSpan={2} style={{ fontStyle: 'italic', paddingLeft: 12 }}>{s.sub_type}</td>
        {Array.from({ length: numCols }).map((_, i) => <td key={i} />)}
      </tr>
    );
    for (const a of s.accounts) renderAccount(a, 0);
    rows.push(
      <tr key={`subtotal-${s.sub_type}`}>
        <td /><td style={{ fontWeight: 600 }}>Total {s.sub_type}</td>
        {s.subtotals.map((v, i) => <td key={i} style={{ textAlign: 'right', fontWeight: 600 }}>{money(v)}</td>)}
      </tr>
    );
  }
  return rows;
}

// Drill-down modal: the transactions behind one clicked income-statement amount.
function TransactionsModal({ ctx, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    api.get('/reports/income-statement/transactions', { params: ctx.params })
      .then((r) => { if (alive) { setData(r.data); setLoading(false); } })
      .catch((e) => { if (alive) { setError(e.response?.data?.error || 'Failed to load transactions'); setLoading(false); } });
    return () => { alive = false; };
  }, [ctx]);
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 50, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 24, overflow: 'auto' }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ maxWidth: 900, width: '100%', maxHeight: '85vh', overflow: 'auto', marginTop: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <strong>TRANSACTIONS &nbsp;|&nbsp; {ctx.title}</strong>
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </div>
        {loading && <LoadingSpinner />}
        {error && <div style={{ color: '#b91c1c' }}>{error}</div>}
        {data && (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr><th>Trans #</th><th>Date</th><th>Name</th><th style={{ textAlign: 'right' }}>Debit</th><th style={{ textAlign: 'right' }}>Credit</th></tr>
              </thead>
              <tbody>
                {data.rows.map((r, i) => (
                  <tr key={i}>
                    {/* Opens in a new tab so the report and this list stay where they are. */}
                    <td>{r.link
                      ? <a href={r.link} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--link, #2563eb)', textDecoration: 'underline' }}>{r.source_no}</a>
                      : r.source_no}</td>
                    <td>{(r.entry_date || '').slice(0, 10)}</td>
                    <td>{r.name}</td>
                    <td style={{ textAlign: 'right' }}>{money(r.debit)}</td>
                    <td style={{ textAlign: 'right' }}>{money(r.credit)}</td>
                  </tr>
                ))}
                {!data.rows.length && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--muted,#888)' }}>No transactions.</td></tr>}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700 }}>
                  <td colSpan={3}>TOTAL</td>
                  <td style={{ textAlign: 'right' }}>{money(data.total_debit)}</td>
                  <td style={{ textAlign: 'right' }}>{money(data.total_credit)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// Mirrors the real system's Accounting > Reports > Income Statement, including its
// split "Generate" button (Total Only/Months/Location/Department breakdown modes) and
// its "Date:" row filter-type dropdown ("As of" = calendar-year-to-date through the
// date; "Period from" = an explicit custom range) -- the same filter/date1/date2 shape
// the other 3 reports use.
export default function IncomeStatement() {
  const [filterType, setFilterType] = useState('as_of');
  const [asOf, setAsOf] = useState(today());
  const [fromDate, setFromDate] = useState(today());
  const [breakdown, setBreakdown] = useState('total');
  const [menuOpen, setMenuOpen] = useState(false);
  const [report, setReport] = useState(null);
  // Company / branch (CompanyBranchFilter): blank is every company -- the consolidated view.
  const [scope, setScope] = useState({ companyId: '', locationId: '' });
  // The scope the statement on screen was generated for -- what Extract and the drill-down use.
  const [ranScope, setRanScope] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [drill, setDrill] = useState(null);
  // Extract: the report on screen, as a workbook -- the same dates and breakdown it was generated with.
  const [exporting, setExporting] = useState(false);
  async function extract() {
    if (!report) return;
    setExporting(true); setError('');
    try {
      const params = { asOf: report.as_of, breakdown: report.breakdown, ...ranScope };
      if (report.from_date && filterType === 'period_from') params.from = report.from_date;
      const { data } = await api.get('/reports/income-statement/export', { params, responseType: 'blob' });
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url; a.download = `income-statement-${report.from_date}-to-${report.as_of}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('Could not extract the Income Statement.');
    } finally {
      setExporting(false);
    }
  }

  function handleDrill(account, column) {
    const params = { accountCode: account.account_code, breakdown: report.breakdown, columnKey: column.key, asOf: report.as_of, ...ranScope };
    if (report.from_date) params.from = report.from_date;
    const colPart = report.breakdown === 'total' ? '' : ` | ${column.label}`;
    setDrill({ params, title: `${account.account_code} | ${account.account_name} | ${report.from_date} to ${report.as_of}${colPart}` });
  }

  async function generate(mode) {
    setMenuOpen(false);
    setBreakdown(mode);
    setLoading(true);
    setError('');
    try {
      const params = { asOf, breakdown: mode, ...toParams(scope) };
      if (filterType === 'period_from') params.from = fromDate;
      const { data } = await api.get('/reports/income-statement', { params });
      setReport(data);
      setRanScope(toParams(scope));
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to generate report');
    } finally {
      setLoading(false);
    }
  }

  const numCols = report?.columns?.length || 1;

  return (
    <div>
      <div className="page-header">
        <h1>Income Statement</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Date</label>
            <select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
              <option value="as_of">As of</option>
              <option value="period_from">Period from</option>
            </select>
          </div>
          {filterType === 'period_from' && (
            <div className="field">
              <label>From</label>
              <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </div>
          )}
          <div className="field">
            <label>{filterType === 'period_from' ? 'To' : 'Date as of'}</label>
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </div>
          <CompanyBranchFilter value={scope} onChange={setScope} />
        </div>
        <div style={{ position: 'relative', display: 'inline-block', marginTop: 12 }}>
          <button className="btn btn-primary" onClick={() => setMenuOpen((v) => !v)} disabled={loading}>
            {loading ? 'Generating...' : 'Generate'} <span style={{ fontSize: '0.8em' }}>▾</span>
          </button>
          {menuOpen && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, marginTop: 4, minWidth: 160,
              background: 'var(--surface, #fff)', border: '1px solid var(--border, #ddd)',
              borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.12)', padding: 6, zIndex: 10,
            }}
            >
              {BREAKDOWN_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className="link-btn"
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px' }}
                  onClick={() => generate(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {error && <div className="card" style={{ color: '#b91c1c', marginBottom: 16 }}>{error}</div>}

      {loading && <LoadingSpinner label="Generating..." expectedMs={REPORT_TIMING.incomeStatement} />}

      {!loading && report && (
        <div className="card">
          <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button className="btn" disabled={exporting} onClick={extract} title="Download this report as Excel">{exporting ? 'Extracting...' : 'Extract'}</button>
            <strong>{report.from_date} to {report.as_of}{report.scope ? ` — ${report.scope.label}` : ''}</strong>
            {report.breakdown !== 'total' && <span style={{ marginLeft: 12, color: 'var(--muted, #888)' }}>Breakdown: {BREAKDOWN_OPTIONS.find((o) => o.value === report.breakdown)?.label}</span>}
          </div>
          <ScopeNote scope={report.scope} />
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Account</th><th></th>
                  {report.columns.map((c) => <th key={c.key} style={{ textAlign: 'right' }}>{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                <tr><td colSpan={2 + numCols} style={{ fontWeight: 700, background: 'var(--panel-2, #f3f4f6)' }}>REVENUES</td></tr>
                <SectionRows sections={report.revenue_sections} columns={report.columns} onDrill={handleDrill} />
                <tr>
                  <td /><td style={{ fontWeight: 700 }}>TOTAL REVENUES</td>
                  {report.revenue_totals.map((v, i) => <td key={i} style={{ textAlign: 'right', fontWeight: 700 }}>{money(v)}</td>)}
                </tr>

                <tr><td colSpan={2 + numCols} style={{ fontWeight: 700, background: 'var(--panel-2, #f3f4f6)' }}>COST OF GOODS SOLD &amp; EXPENSES</td></tr>
                <SectionRows sections={report.expense_sections} columns={report.columns} onDrill={handleDrill} />
                <tr>
                  <td /><td style={{ fontWeight: 700 }}>TOTAL EXPENSES</td>
                  {report.expense_totals.map((v, i) => <td key={i} style={{ textAlign: 'right', fontWeight: 700 }}>{money(v)}</td>)}
                </tr>

                <tr>
                  <td /><td style={{ fontWeight: 700, fontSize: '1.05em' }}>NET INCOME</td>
                  {report.net_income.map((v, i) => <td key={i} style={{ textAlign: 'right', fontWeight: 700, fontSize: '1.05em' }}>{money(v)}</td>)}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {drill && <TransactionsModal ctx={drill} onClose={() => setDrill(null)} />}
    </div>
  );
}
