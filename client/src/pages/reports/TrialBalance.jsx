import { Fragment, useState } from 'react';
import api from '../../api/client';
import CompanyBranchFilter, { toParams, ScopeNote } from '../../components/CompanyBranchFilter';
import LoadingSpinner from '../../components/LoadingSpinner';
import { REPORT_TIMING } from '../../utils/reportTiming';
import CoaTreeRows, { money } from './CoaTreeRows';

function today() { return new Date().toISOString().slice(0, 10); }

// Mirrors the real system's Accounting > Reports > Trial Balance: a "Date as of:"
// filter + Generate, then every account grouped DEBIT side / CREDIT side -> account
// type -> sub-type -> the parent/child COA tree, each node's amount a rollup of its
// children. `balanced` (debit_total === credit_total) is the report's own built-in
// correctness check on the whole GL Impact effort behind it.
export default function TrialBalance() {
  const [asOf, setAsOf] = useState(today());
  const [report, setReport] = useState(null);
  // Company / branch (CompanyBranchFilter): blank is every company -- the consolidated view.
  const [scope, setScope] = useState({ companyId: '', locationId: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function generate() {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/reports/trial-balance', { params: { asOf, ...toParams(scope) } });
      setReport(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to generate report');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Trial Balance</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Date as of</label>
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </div>
          <CompanyBranchFilter value={scope} onChange={setScope} />
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={generate} disabled={loading}>
          {loading ? 'Generating...' : 'Generate'}
        </button>
      </div>

      {error && <div className="card" style={{ color: '#b91c1c', marginBottom: 16 }}>{error}</div>}

      {loading && <LoadingSpinner label="Generating..." expectedMs={REPORT_TIMING.trialBalance} />}

      {!loading && report && (
        <div className="card">
          <ScopeNote scope={report.scope} />
          <div style={{ marginBottom: 12, display: 'flex', gap: 24, alignItems: 'center' }}>
            <strong>As of {report.as_of}{report.scope ? ` — ${report.scope.label}` : ''}</strong>
            <span>Total Debit: {money(report.debit_total)}</span>
            <span>Total Credit: {money(report.credit_total)}</span>
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
                          <CoaTreeRows key={node.account_code} node={node} normal={typeGroup.normal} />
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
    </div>
  );
}
