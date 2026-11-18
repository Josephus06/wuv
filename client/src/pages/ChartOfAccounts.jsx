import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import useAutoSearch from '../utils/useAutoSearch';
import SearchInput from '../components/SearchInput';

// Mirrors the real system's "Accounting > Chart of Accounts" screen -- fully migrated
// from the live site (276 accounts, real parent/child hierarchy). The real screen also
// has a "Change View" toggle for a tree layout; this build keeps the flat, searchable,
// paginated list (the other of the two real view modes) rather than building a second
// tree-rendering UI for the same data.
export default function ChartOfAccounts() {
  const { can } = useAuth();
  const navigate = useNavigate();

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const limit = 10;

  async function load() {
    setLoading(true);
    const params = { page, limit };
    if (search) params.search = search;
    const { data } = await api.get('/chart-of-accounts', { params });
    setRows(data.rows);
    setTotal(data.total);
    setLoading(false);
  }

  useEffect(() => { load(); }, [page]);

  function runSearch() {
    setPage(1);
    load();
  }
  useAutoSearch(search, runSearch);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div>
      <div className="page-header">
        <h1>Chart of Accounts</h1>
        {can('/chart-of-accounts', 'can_add') && <Link className="btn btn-primary" to={'/chart-of-accounts/new'}>Add New</Link>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="Account code or title..." />
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={runSearch}>Search</button>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <>
            <div className="table-wrap">
              <table className="responsive-cards">
                <thead>
                  <tr>
                    <th>Account Code</th>
                    <th>Account Title</th>
                    <th>Description</th>
                    <th>Type</th>
                    <th>Sub-Type</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>No accounts found.</td></tr>
                  )}
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td data-label="Account Code">{row.account_code}</td>
                      <td data-label="Account Title">{row.account_name}</td>
                      <td data-label="Description">{row.description}</td>
                      <td data-label="Type">{row.coa_account_type}</td>
                      <td data-label="Sub-Type">{row.account_sub_type}</td>
                      <td style={{ display: 'flex', gap: 6 }}>
                        {can('/chart-of-accounts', 'can_edit') && <Link className="btn btn-sm" to={`/chart-of-accounts/${row.id}/edit`}>Update</Link>}
                        <Link className="btn btn-sm btn-primary" to={`/chart-of-accounts/${row.id}`}>View</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} totalPages={totalPages} onChange={setPage} />
          </>
        )}
      </div>
    </div>
  );
}
