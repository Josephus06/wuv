import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

const PAGE_SIZE = 10;

// Mirrors the real GraphicStar "Jobs" list (#/jobs) -- Display Name / Base Unit / COGS /
// Asset / Income columns, search, and an Add Job button. Real system calls this entity
// "Job" (the Setup Job screen) -- we keep our existing "Job Type" naming since that's
// what it's called everywhere else in this app (Job Orders' "Job Type" field, etc).
export default function JobTypes() {
  const { can } = useAuth();
  const navigate = useNavigate();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  async function load(searchValue = search) {
    setLoading(true);
    const { data } = await api.get('/job-types', { params: searchValue ? { search: searchValue } : {} });
    setRows(data);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function runSearch() {
    setPage(1);
    load(search);
  }

  async function handleDelete(row) {
    if (!confirm(`Delete job type "${row.display_name}"?`)) return;
    try {
      await api.delete(`/job-types/${row.id}`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Delete failed');
    }
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <div className="page-header">
        <h1>Job Types</h1>
        {can('/job-types', 'can_add') && <Link className="btn btn-primary" to={'/job-types/new'}>Add Job</Link>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Search</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="Display name or code..." />
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={runSearch}>Search</button>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Display Name</th>
                  <th>Base Unit</th>
                  <th>COGS</th>
                  <th>Asset</th>
                  <th>Income</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>No job types found.</td></tr>
                )}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.display_name}</td>
                    <td>{row.base_unit}</td>
                    <td>{row.cogs_account_name || '—'}</td>
                    <td>{row.asset_account_name || '—'}</td>
                    <td>{row.income_account_name || '—'}</td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      {can('/job-types', 'can_edit') && <Link className="btn btn-sm btn-primary" to={`/job-types/${row.id}/edit`}>Edit</Link>}
                      {can('/job-types', 'can_delete') && <button className="btn btn-sm btn-danger" onClick={() => handleDelete(row)}>Delete</button>}
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
