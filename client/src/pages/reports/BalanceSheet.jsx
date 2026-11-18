import { Fragment, useState } from 'react';
import api from '../../api/client';
import CompanyBranchFilter, { toParams, ScopeNote } from '../../components/CompanyBranchFilter';
import LoadingSpinner from '../../components/LoadingSpinner';
import { REPORT_TIMING } from '../../utils/reportTiming';
import MonthYearPicker from '../../components/MonthYearPicker';
import CoaTreeRows, { money } from './CoaTreeRows';
import AccountTransactionsModal from './AccountTransactionsModal';

// The balance sheet is "as of" the last day of the selected month.
function endOfMonth({ year, month }) {
  const d = new Date(year, month, 0); // day 0 of next month = last day of this month
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Mirrors the real system's Accounting > Reports > Balance Sheet: same "as of" /
// Generate pattern and parent/child COA tree as Trial Balance, but only Asset,
// Liability, and Equity accounts. This build has no formal period-closing entries, so
// the backend adds a synthetic "Current Earnings (Unclosed)" line under Equity
// (cumulative Income - cumulative Expense to date) -- without it Assets would never
// actually equal Liabilities + Equity. Flagged in the UI, not hidden.
export default function BalanceSheet() {
  const now = new Date();
  const [monthYear, setMonthYear] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 });
  const [report, setReport] = useState(null);
  // Company / branch (CompanyBranchFilter): blank is every company -- the consolidated view.
  const [scope, setScope] = useState({ companyId: '', locationId: '' });
  // The scope the sheet on screen was generated for -- what Export and the drill-down use.
  const [ranScope, setRanScope] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  // The account whose amount was clicked -- its transactions open in a popup, as on the source.
  const [drill, setDrill] = useState(null);

  async function generate() {
    if (!monthYear) { setError('Select a month first.'); return; }
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/reports/balance-sheet', { params: { asOf: endOfMonth(monthYear), ...toParams(scope) } });
      setReport(data);
      setRanScope(toParams(scope));
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to generate report');
    } finally {
      setLoading(false);
    }
  }

  async function exportExcel() {
    if (!report) return;
    setExporting(true);
    setError('');
    try {
      const res = await api.get('/reports/balance-sheet/export', { params: { asOf: report.as_of, ...ranScope }, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `balance-sheet-${report.as_of}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError('Failed to export the balance sheet');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Balance Sheet</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Date as of:</label>
            <MonthYearPicker value={monthYear} onChange={setMonthYear} />
          </div>
          <CompanyBranchFilter value={scope} onChange={setScope} />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn-primary" onClick={generate} disabled={loading}>
            {loading ? 'Generating...' : 'Generate'}
          </button>
          {/* Exports the sheet shown -- the as-of date it was generated for, not whatever the picker
              has been changed to since. */}
          <button className="btn" onClick={exportExcel} disabled={loading || exporting || !report}>
            {exporting ? 'Exporting...' : 'Export to Excel'}
          </button>
        </div>
      </div>

      {error && <div className="card" style={{ color: '#b91c1c', marginBottom: 16 }}>{error}</div>}

      {loading && <LoadingSpinner label="Generating..." expectedMs={REPORT_TIMING.balanceSheet} />}

      {!loading && report && (
        <div className="card">
          <ScopeNote scope={report.scope} />
          <div style={{ marginBottom: 12, display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong>As of {report.as_of}{report.scope ? ` — ${report.scope.label}` : ''}</strong>
            <span>Total Assets: {money(report.asset_total)}</span>
            <span>Total Liabilities &amp; Equity: {money(report.liability_equity_total)}</span>
            <span>Current Year Earnings: {money(report.current_earnings)}</span>
            <span style={{ color: report.balanced ? '#15803d' : '#b91c1c', fontWeight: 600 }}>
              {report.balanced ? 'Balanced' : 'Out of Balance'}
            </span>
          </div>
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Account Code</th>
                  <th>Account Title</th>
                  <th style={{ textAlign: 'right' }}>Debit</th>
                  <th style={{ textAlign: 'right' }}>Credit</th>
                </tr>
              </thead>
              <tbody>
                {report.data.length === 0 && (
                  <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No activity as of this date.</td></tr>
                )}
                {report.data.map((typeGroup) => (
                  <Fragment key={`${typeGroup.normal}-${typeGroup.type}`}>
                    <tr>
                      <td colSpan={4} style={{ fontWeight: 700, background: 'var(--panel-2, #f3f4f6)' }}>{typeGroup.type}</td>
                    </tr>
                    {typeGroup.accounts.map((sub) => (
                      <Fragment key={`${typeGroup.type}-${sub.sub_type}`}>
                        <tr>
                          <td colSpan={4} style={{ fontStyle: 'italic', paddingLeft: 12 }}>{sub.sub_type}</td>
                        </tr>
                        {sub.account_ledgers.map((node) => (
                          <CoaTreeRows key={node.account_code} node={node} normal={typeGroup.normal} onDrill={setDrill} />
                        ))}
                      </Fragment>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {drill && report && <AccountTransactionsModal account={drill} asOf={report.as_of} scope={ranScope} onClose={() => setDrill(null)} />}
    </div>
  );
}
