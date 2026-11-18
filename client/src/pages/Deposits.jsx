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
const STATUS_LABELS = { open: 'Open', void: 'Void' };
function money(v) { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'; }
function formatDate(v) { return v ? displayDate(v) : ''; }

// Saved Bank Deposits (BD-####): each rolls up not-deposited customer payments into a bank account.
export default function Deposits() {
  const { can } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  // Date: As of (on or before) or a Period (From / To) on the deposit date. Blank = every date.
  const [dateMode, setDateMode] = useState('as_of');
  const [asOf, setAsOf] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);

  async function load() {
    setLoading(true);
    const params = {};
    if (search) params.search = search;
    if (status) params.status = status;
    if (dateMode === 'as_of' && asOf) params.as_of = asOf;
    if (dateMode === 'range') {
      if (dateFrom) params.date_from = dateFrom;
      if (dateTo) params.date_to = dateTo;
    }
    const { data } = await api.get('/deposits', { params });
    setRows(data);
    setLoading(false);
  }

  useEffect(() => { setPage(1); load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  function runSearch() { setPage(1); load(); }
  useAutoSearch(search, runSearch);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <div className="page-header">
        <h1>Saved Deposits</h1>
        {can('/deposits', 'can_add') && <Link className="btn btn-primary" to="/deposits/new">Add New</Link>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="BD No, Account or Memo..." />
          </div>
          {/* Period puts two dates beside the mode picker -- more than one grid cell holds, so the
              field takes two cells then, and each date may shrink rather than spill over. */}
          <div className="field" style={dateMode === 'range' ? { gridColumn: 'span 2' } : undefined}>
            <label>Date</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <select value={dateMode} onChange={(e) => setDateMode(e.target.value)} style={{ width: 'auto', flex: '0 0 auto' }}>
                <option value="as_of">As of</option>
                <option value="range">Period</option>
              </select>
              {dateMode === 'range' ? (
                <>
                  <input type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} title="From" style={{ flex: 1, minWidth: 0 }} />
                  <input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} title="To" style={{ flex: 1, minWidth: 0 }} />
                </>
              ) : (
                <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
              )}
            </div>
          </div>
          <div className="field">
            <label>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">--ALL--</option>
              <option value="open">Open</option>
              <option value="void">Void</option>
            </select>
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={runSearch}>Search</button>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr><th>Deposit No</th><th>Date</th><th>Account</th><th style={{ textAlign: 'right' }}>Total Deposit</th><th>Status</th><th>Memo</th><th></th></tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No deposits found.</td></tr>}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Deposit No">{row.bd_no}</td>
                    <td data-label="Date">{formatDate(row.date_created)}</td>
                    <td data-label="Account">{row.account_name}</td>
                    <td data-label="Total Deposit" style={{ textAlign: 'right' }}>{money(row.total_amount)}</td>
                    <td data-label="Status">{STATUS_LABELS[row.status] || row.status}</td>
                    <td data-label="Memo">{row.memo}</td>
                    <td><Link className="btn btn-sm btn-primary" to={`/deposits/${row.id}`}>View</Link></td>
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
