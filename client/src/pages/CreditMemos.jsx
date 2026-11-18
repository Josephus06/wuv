import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/useAuth';
import api from '../api/client';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

import { displayDate } from '../utils/dates';
import useAutoSearch from '../utils/useAutoSearch';
import { CustomerLink } from '../components/PartyLink';
import SearchInput from '../components/SearchInput';

const PAGE_SIZE = 10;
const STATUS_LABELS = { open: 'Open', voided: 'Void' };

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? displayDate(String(v).slice(0, 10)) : ''; }

export default function CreditMemos() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  // Period From / As of Date: inclusive bounds on Date Created, applied on Search like the others.
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  function filterParams() {
    const params = {};
    if (status) params.status = status;
    if (search) params.search = search;
    if (dateFrom) params.date_from = dateFrom;
    if (dateTo) params.date_to = dateTo;
    return params;
  }

  async function load() {
    setLoading(true);
    const { data } = await api.get('/credit-memos', { params: filterParams() });
    setRows(data);
    setLoading(false);
  }

  useEffect(() => { setPage(1); load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  function runSearch() {
    setPage(1);
    load();
  }
  useAutoSearch(search, runSearch);

  // Extract: every credit memo under the filters above, as a workbook.
  async function runExport() {
    setExporting(true); setExportError('');
    try {
      const { data } = await api.get('/credit-memos/export', { params: filterParams(), responseType: 'blob' });
      const range = dateFrom || dateTo ? `-${dateFrom || 'start'}-to-${dateTo || 'today'}` : '';
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url; a.download = `credit-memos${range}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setExportError('Could not extract the credit memos.');
    } finally {
      setExporting(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <div className="page-header">
        <h1>Credit Memos</h1>
        {can('/credit-memos', 'can_add') && <Link className="btn btn-primary" to={'/credit-memos/new'}>Add Credit Memo</Link>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <SearchInput
              value={search} onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runSearch()}
              placeholder="CM #, Invoice # or Customer..."
            />
          </div>
          <div className="field">
            <label>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">--ALL--</option>
              <option value="open">Open</option>
              <option value="voided">Void</option>
            </select>
          </div>
          <div className="field">
            <label>Period From</label>
            <input type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} />
          </div>
          <div className="field">
            <label>As of Date</label>
            <input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} />
          </div>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={runSearch}>Search</button>
          <button className="btn" disabled={exporting} onClick={runExport} title="Download every credit memo under the filters above">
            {exporting ? 'Extracting...' : 'Extract'}
          </button>
          {exportError && <span style={{ color: 'var(--danger)' }}>{exportError}</span>}
        </div>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Credit Memo #</th>
                  <th>Date Created</th>
                  <th>Customer</th>
                  <th>Invoice #</th>
                  <th>Gross Amount</th>
                  <th>Applied</th>
                  <th>Remaining</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>No credit memos found.</td></tr>
                )}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Credit Memo #">{row.credit_memo_no}</td>
                    <td data-label="Date Created">{formatDate(row.date_created)}</td>
                    <td data-label="Customer"><CustomerLink id={row.customer_id} name={row.customer_name} /></td>
                    <td data-label="Invoice #">{row.invoice_no}</td>
                    <td data-label="Gross Amount">{money(row.gross_amount)}</td>
                    <td data-label="Applied">{money(row.applied_amount)}</td>
                    <td data-label="Remaining">{money(Number(row.gross_amount) - Number(row.applied_amount))}</td>
                    <td data-label="Status">{STATUS_LABELS[row.status] || row.status}</td>
                    <td><Link className="btn btn-sm btn-primary" to={`/credit-memos/${row.id}`}>View</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} totalPages={totalPages} onChange={setPage} />
      </div>
    </div>
  );
}
