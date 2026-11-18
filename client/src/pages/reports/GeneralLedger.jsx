import { Fragment, useState } from 'react';
import api from '../../api/client';
import CompanyBranchFilter, { toParams, ScopeNote } from '../../components/CompanyBranchFilter';
import LoadingSpinner from '../../components/LoadingSpinner';
import { REPORT_TIMING } from '../../utils/reportTiming';
import { money } from './CoaTreeRows';
import { downloadFile } from '../../utils/downloadFile';

import { displayDate } from '../../utils/dates';

function today() { return new Date().toISOString().slice(0, 10); }
function formatDate(v) { return v ? displayDate(String(v).slice(0, 10)) : ''; }

const SOURCE_LABELS = {
  sales_invoice: 'Invoice', assembly_build: 'Assembly Build', item_delivery: 'Item Delivery',
  item_fulfillment: 'Item Fulfillment', item_receipt: 'Item Receipt', vendor_bill: 'Vendor Bill',
  inventory_adjustment: 'Inventory Adjustment', bill_credit: 'Bill Credit', receiving_report: 'Receiving Report',
  bill_payment: 'Bill Payment',
  // Sales Orders reach the ledger only when they are POS counter sales imported from a
  // Z-Reading; estimate-derived orders post through their invoice instead.
  sales_order: 'Counter Sales',
};

// Mirrors the real system's Accounting > Reports > General Ledger: a flat per-account
// balance list with each row's underlying transaction lines available on demand. The
// real UI fetches those lines via a separate "Expand" click; ours already has them
// inline in the response (this clone's data volumes are small enough that the extra
// payload is trivial), so "expand" here is just a local show/hide toggle, not a
// second request.
export default function GeneralLedger() {
  const [filterType, setFilterType] = useState('as_of');
  const [asOf, setAsOf] = useState(today());
  const [fromDate, setFromDate] = useState(today());
  const [report, setReport] = useState(null);
  // Company / branch (CompanyBranchFilter): blank is every company -- the consolidated view.
  const [scope, setScope] = useState({ companyId: '', locationId: '' });
  const [ranScope, setRanScope] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(() => new Set());

  async function generate() {
    setLoading(true);
    setError('');
    try {
      const params = { asOf, ...toParams(scope) };
      if (filterType === 'period_from') params.from = fromDate;
      const { data } = await api.get('/reports/general-ledger', { params });
      setReport(data);
      setRanScope(toParams(scope));
      setOpen(new Set());
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to generate report');
    } finally {
      setLoading(false);
    }
  }

  // Expand All / Collapse All (asked 2026-10-26): every account with lines (or an opening balance).
  const expandableCodes = () => (report?.rows || [])
    .filter((r) => r.ledgers.length > 0 || (!!report.from_date && !!r.opening_balance)).map((r) => r.account_code);
  const allOpen = !!report && expandableCodes().length > 0 && expandableCodes().every((c) => open.has(c));
  function toggleAll() { setOpen(allOpen ? new Set() : new Set(expandableCodes())); }

  // Extract: the ledger as on screen, every account expanded, as Excel (GET /reports/general-ledger/export).
  const [extracting, setExtracting] = useState(false);
  async function extract() {
    setExtracting(true); setError('');
    try {
      const params = { asOf: report.as_of, ...ranScope };
      if (report.from_date) params.from = report.from_date;
      await downloadFile('/reports/general-ledger/export', params,
        `general-ledger-${report.from_date ? `${report.from_date}-to-` : 'as-of-'}${report.as_of}.xlsx`);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not extract the General Ledger.');
    }
    setExtracting(false);
  }

  function toggle(code) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  }

  return (
    <div>
      <div className="page-header">
        <h1>General Ledger</h1>
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
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={generate} disabled={loading}>
          {loading ? 'Generating...' : 'Generate'}
        </button>
      </div>

      {error && <div className="card" style={{ color: '#b91c1c', marginBottom: 16 }}>{error}</div>}

      {loading && <LoadingSpinner label="Generating..." expectedMs={REPORT_TIMING.generalLedger} />}

      {!loading && report && (
        <div className="card">
          <ScopeNote scope={report.scope} />
          <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ marginRight: 'auto' }}>{report.from_date ? `${report.from_date} to ${report.as_of}` : `As of ${report.as_of}`}{report.scope ? ` — ${report.scope.label}` : ''}</strong>
            <button className="btn btn-sm" onClick={toggleAll} disabled={!expandableCodes().length}>{allOpen ? 'Collapse All' : 'Expand All'}</button>
            <button className="btn btn-sm" onClick={extract} disabled={extracting || !report.rows.length}>{extracting ? 'Extracting...' : 'Extract'}</button>
          </div>
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th></th><th>Account #</th><th>Account Title</th>
                  <th style={{ textAlign: 'right' }}>Balance</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.length === 0 && (
                  <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No accounts found.</td></tr>
                )}
                {report.rows.map((r) => {
                  const isOpen = open.has(r.account_code);
                  // In period mode an account can have no activity in the window but still
                  // carry an opening balance worth seeing, so it stays expandable.
                  const expandable = r.ledgers.length > 0 || (!!report.from_date && !!r.opening_balance);
                  return (
                    <Fragment key={r.account_code}>
                      <tr onClick={() => expandable && toggle(r.account_code)} style={{ cursor: expandable ? 'pointer' : 'default' }}>
                        <td>{expandable ? (isOpen ? '▾' : '▸') : ''}</td>
                        <td>{r.account_code}</td>
                        <td>{r.account_name}</td>
                        <td style={{ textAlign: 'right' }}>{money(r.balance)}</td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td />
                          <td colSpan={3} style={{ padding: 0 }}>
                            <table style={{ width: '100%' }}>
                              <thead>
                                <tr>
                                  <th>Transaction Date</th><th>Transaction #</th><th>Memo</th>
                                  <th style={{ textAlign: 'right' }}>Debit</th>
                                  <th style={{ textAlign: 'right' }}>Credit</th>
                                  <th style={{ textAlign: 'right' }}>Balance</th>
                                </tr>
                              </thead>
                              <tbody>
                                {report.from_date && (
                                  <tr>
                                    <td colSpan={3} style={{ fontStyle: 'italic' }}>Opening balance</td>
                                    <td /><td />
                                    <td style={{ textAlign: 'right', fontStyle: 'italic' }}>{money(r.opening_balance)}</td>
                                  </tr>
                                )}
                                {r.ledgers.map((l, idx) => (
                                  <tr key={idx}>
                                    <td>{formatDate(l.entry_date)}</td>
                                    <td>{SOURCE_LABELS[l.source_type] || l.source_type} {l.source_no}</td>
                                    <td>{l.memo || ''}</td>
                                    <td style={{ textAlign: 'right' }}>{l.debit ? money(l.debit) : ''}</td>
                                    <td style={{ textAlign: 'right' }}>{l.credit ? money(l.credit) : ''}</td>
                                    <td style={{ textAlign: 'right' }}>{money(l.balance)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
