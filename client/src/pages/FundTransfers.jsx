import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDate } from '../utils/dates';
import useAutoSearch from '../utils/useAutoSearch';
import SearchInput from '../components/SearchInput';

const PAGE_SIZE = 15;
function money(v) { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'; }
function formatDate(v) { return v ? displayDate(v) : ''; }

export default function FundTransfers() {
  const { can, user } = useAuth();
  const canPrint = can('/fund-transfers', 'can_print') || user?.account_type === 'System Admin';
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [asOf, setAsOf] = useState('');
  const [page, setPage] = useState(1);

  async function load() {
    setLoading(true);
    const params = {};
    if (search) params.search = search;
    if (asOf) params.as_of = asOf;
    const { data } = await api.get('/fund-transfers', { params });
    setRows(data);
    setLoading(false);
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  function runSearch() { setPage(1); load(); }
  useAutoSearch(search, runSearch);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <div className="page-header">
        <h1>Saved Fund Transfers</h1>
        {can('/fund-transfers', 'can_add') && <Link className="btn btn-primary" to="/fund-transfers/new">Add New</Link>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="FT No, Account or Memo..." />
          </div>
          <div className="field">
            <label>Date Created (as of)</label>
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={runSearch}>Search</button>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr><th>Fund Transfer No</th><th>Date Created</th><th>From Account</th><th>To Account</th><th>Prepared By</th><th style={{ textAlign: 'right' }}>Total Amount</th><th></th></tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No fund transfers found.</td></tr>}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Fund Transfer No">{row.ft_no}</td>
                    <td data-label="Date Created">{formatDate(row.date_created)}</td>
                    <td data-label="From Account">{row.from_account_name}</td>
                    <td data-label="To Account">{row.to_account_name}</td>
                    <td data-label="Prepared By">{row.prepared_by_name}</td>
                    <td data-label="Total Amount" style={{ textAlign: 'right' }}>{money(row.amount)}</td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      {canPrint && <button className="btn btn-sm" onClick={() => window.open(`/fund-transfers/${row.id}/print`, '_blank')}>Print</button>}
                      <Link className="btn btn-sm btn-primary" to={`/fund-transfers/${row.id}`}>View</Link>
                    </td>
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
