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
const STATUS_TABS = [
  { key: 'pending_request', label: 'Pending Request' },
  { key: 'request_in_process', label: 'Request In-Process' },
  { key: 'partially_served', label: 'Partially Served' },
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
];
const STATUS_LABELS = Object.fromEntries(STATUS_TABS.map((t) => [t.key, t.label]));

function formatDate(v) { return v ? displayDate(String(v).slice(0, 10)) : ''; }

// Mirrors the real system's "Saved Purchase Requisitions" list. Request In-Process /
// Partially Served / Completed all depend on a Purchase Order having picked the PR's
// lines up -- no Purchase Order module exists in this build yet, so every PR here sits
// at Pending Request until it's Cancelled.
export default function PurchaseRequisitions() {
  const { can } = useAuth();
  const navigate = useNavigate();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('pending_request');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  async function load() {
    setLoading(true);
    const params = { status };
    if (search) params.search = search;
    const { data } = await api.get('/purchase-requisitions', { params });
    setRows(data);
    setLoading(false);
  }

  useEffect(() => { setPage(1); load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  function runSearch() {
    setPage(1);
    load();
  }
  useAutoSearch(search, runSearch);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <div className="page-header">
        <h1>Saved Purchase Requisitions</h1>
        {can('/purchase-requisitions', 'can_add') && <Link className="btn btn-primary" to={'/purchase-requisitions/new'}>Add New</Link>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="PR No..." />
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={runSearch}>Search</button>
      </div>

      <div className="status-tabs">
        {STATUS_TABS.map((t) => (
          <button key={t.key} className={`status-tab ${status === t.key ? 'active' : ''}`} onClick={() => setStatus(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>PR No</th>
                  <th>Date Created</th>
                  <th>Department</th>
                  <th>Requestor</th>
                  <th>Prepared By</th>
                  <th>Status</th>
                  <th>Item Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>No purchase requisitions found.</td></tr>
                )}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="PR No">{row.pr_no}</td>
                    <td data-label="Date Created">{formatDate(row.date_created)}</td>
                    <td data-label="Department">{row.department_name}</td>
                    <td data-label="Requestor">{row.requestor_name}</td>
                    <td data-label="Prepared By">{row.prepared_by_name}</td>
                    <td data-label="Status">{STATUS_LABELS[row.status] || row.status}</td>
                    <td data-label="Item Status">{row.item_status}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <Link className="btn btn-sm btn-primary" to={`/purchase-requisitions/${row.id}`}>View</Link>
                      {can('/purchase-requisitions', 'can_edit') && row.status !== 'cancelled' && (
                        <Link className="btn btn-sm" style={{ marginLeft: 6 }} to={`/purchase-requisitions/${row.id}/edit`}>Edit</Link>
                      )}
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
