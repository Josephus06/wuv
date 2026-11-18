import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDate } from '../utils/dates';
import useAutoSearch from '../utils/useAutoSearch';
import SearchInput from '../components/SearchInput';

const PAGE_SIZE = 10;
function formatDate(v) { return v ? displayDate(String(v).slice(0, 10)) : ''; }

// Mirrors the real Commission > Setups > Commission Table: a list of named rate schemes
// (Sales Manager, Account Officer, ...). Each opens to its own bracket ladder.
export default function CommissionSchemes() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState('');

  async function load(searchValue = search) {
    setLoading(true);
    const { data } = await api.get('/commission-schemes', { params: searchValue ? { search: searchValue } : {} });
    setRows(data);
    setLoading(false);
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function runSearch() { setPage(1); load(search); }
  useAutoSearch(search, runSearch);

  async function createScheme() {
    setError('');
    if (!newName.trim()) { setError('Enter a scheme name.'); return; }
    try {
      const { data } = await api.post('/commission-schemes', { name: newName.trim() });
      setAdding(false);
      setNewName('');
      navigate(`/commission-schemes/${data.id}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Create failed');
    }
  }

  async function handleDelete(row) {
    if (!confirm(`Delete commission scheme "${row.name}"? Its brackets go with it.`)) return;
    try {
      await api.delete(`/commission-schemes/${row.id}`);
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
        <h1>Commission Table</h1>
        {can('/commission-schemes', 'can_add') && <button className="btn btn-primary" onClick={() => setAdding(true)}>Add Scheme</button>}
      </div>

      {adding && (
        <div className="card" style={{ marginBottom: 16 }}>
          {error && <div className="error-banner">{error}</div>}
          <div className="filter-grid">
            <div className="field">
              <label>Scheme Name</label>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && createScheme()} placeholder="e.g. Account Officer" autoFocus />
            </div>
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={createScheme}>Create</button>
            <button className="btn" onClick={() => { setAdding(false); setNewName(''); setError(''); }}>Cancel</button>
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="Scheme name..." />
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={runSearch}>Search</button>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr><th>Scheme Name</th><th>Brackets</th><th>Status</th><th>Created</th><th></th></tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No commission schemes yet.</td></tr>
                )}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Scheme Name">{row.name}</td>
                    <td data-label="Brackets">{row.bracket_count}</td>
                    <td data-label="Status">{row.is_active ? 'Active' : 'Inactive'}</td>
                    <td data-label="Created">{formatDate(row.created_at)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <Link className="btn btn-sm btn-primary" style={{ marginRight: 4 }} to={`/commission-schemes/${row.id}`}>View</Link>
                      {can('/commission-schemes', 'can_delete') && <button className="btn btn-sm btn-warning" onClick={() => handleDelete(row)}>Delete</button>}
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
