import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import useAutoSearch from '../utils/useAutoSearch';
import SearchInput from '../components/SearchInput';

const PAGE_SIZE = 10;

// Mirrors the real Commission > Setups > Employee Quota: the list is the employees, each
// opening to its own per-month quota grid.
export default function EmployeeQuotas() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  async function load(searchValue = search) {
    setLoading(true);
    const { data } = await api.get('/employee-quotas', { params: searchValue ? { search: searchValue } : {} });
    setRows(data);
    setLoading(false);
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function runSearch() { setPage(1); load(search); }
  useAutoSearch(search, runSearch);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <div className="page-header">
        <h1>Employee Quota</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="Employee name or code..." />
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={runSearch}>Search</button>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr><th>Employee</th><th>Code</th><th>Position</th><th>Department</th><th>Quota Rows</th><th></th></tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>No employees found.</td></tr>
                )}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Employee">{row.employee_name}</td>
                    <td data-label="Code">{row.employee_code}</td>
                    <td data-label="Position">{row.position_title}</td>
                    <td data-label="Department">{row.department_name}</td>
                    <td data-label="Quota Rows">{row.quota_count}</td>
                    <td><Link className="btn btn-sm btn-primary" to={`/employee-quotas/${row.id}`}>View</Link></td>
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
