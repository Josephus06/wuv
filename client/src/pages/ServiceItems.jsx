import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import useAutoSearch from '../utils/useAutoSearch';
import SearchInput from '../components/SearchInput';

const PAGE_SIZE = 15;
const YES_NO = (v) => (v ? 'YES' : 'NO');

// Mirrors the real Master Lists > Service Items list -- a flat list (no status tabs),
// same underlying `inventories` table as Inventory Items, filtered to item_type =
// 'Service'. View/Edit reuse the existing /inventory/:id routes since it's the same
// record shape.
export default function ServiceItems() {
  const { can } = useAuth();
  const navigate = useNavigate();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  async function load() {
    setLoading(true);
    const params = { item_type: 'Service' };
    if (search) params.search = search;
    const { data } = await api.get('/inventory', { params });
    setRows(data);
    setLoading(false);
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
        <h1>Service Items</h1>
        {can('/service-items', 'can_add') && <Link className="btn btn-primary" to={'/service-items/new'}>Add New</Link>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="Item code, name, description..." />
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={runSearch}>Search</button>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Item Code</th>
                  <th>Display Name</th>
                  <th>Sales Desc.</th>
                  <th>Purchase Desc.</th>
                  <th>Purchase Unit</th>
                  <th>Sales Unit</th>
                  <th>W/JO</th>
                  <th>PO</th>
                  <th>JO</th>
                  <th>Expense</th>
                  <th>COGS</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={12} className="muted" style={{ textAlign: 'center', padding: 20 }}>No service items found.</td></tr>
                )}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Item Code">{row.item_code}</td>
                    <td data-label="Display Name">{row.display_name}</td>
                    <td data-label="Sales Desc.">{row.sales_description}</td>
                    <td data-label="Purchase Desc.">{row.purchase_description}</td>
                    <td data-label="Purchase Unit">{row.purchase_unit_code || row.base_unit_code}</td>
                    <td data-label="Sales Unit">{row.sales_unit_code || row.base_unit_code}</td>
                    <td data-label="W/JO">{YES_NO(row.is_with_jo)}</td>
                    <td data-label="PO">{YES_NO(row.is_po)}</td>
                    <td data-label="JO">{YES_NO(row.is_jo)}</td>
                    <td data-label="Expense">{row.expense_account_name}</td>
                    <td data-label="COGS">{row.cogs_account_name}</td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      <Link className="btn btn-sm btn-primary" to={`/inventory/${row.id}`}>View</Link>
                      {can('/service-items', 'can_edit') && <Link className="btn btn-sm" to={`/service-items/${row.id}/edit`}>Update</Link>}
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
