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

// Mirrors the real Master Lists > Non-Inventories list, column for column: Item Code, Display
// Name, the two descriptions, Unit Title / Stock / Purchase / Sales Unit, Is W/ JO, Is PO and
// the Expense account.
//
// Same underlying `inventories` table as Inventory Items and Service Items, filtered to
// item_type = 'Non-Inventory'. It is deliberately NOT the four-column `non_inventories` lookup
// table: a non-inventory item is a full item master record -- units, accounts, JO/PO flags,
// last purchase price -- and purchase order, receipt and vendor bill lines all point at
// `inventories`, so that is where the record has to live. View/Edit reuse /inventory/:id since
// it is the same record shape.
export default function NonInventories() {
  const { can } = useAuth();
  const navigate = useNavigate();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  async function load() {
    setLoading(true);
    const params = { item_type: 'Non-Inventory' };
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
        <h1>Non-Inventories</h1>
        {can('/non-inventories', 'can_add') && <Link className="btn btn-primary" to={'/non-inventories/new'}>Add New</Link>}
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
                  <th>Unit Title</th>
                  <th>Stock Unit</th>
                  <th>Purchase Unit</th>
                  <th>Sales Unit</th>
                  <th>Is W/ JO</th>
                  <th>Is PO</th>
                  <th>Expense</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={12} className="muted" style={{ textAlign: 'center', padding: 20 }}>No non-inventory items found.</td></tr>
                )}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Item Code">{row.item_code}</td>
                    <td data-label="Display Name">{row.display_name}</td>
                    <td data-label="Sales Desc.">{row.sales_description}</td>
                    <td data-label="Purchase Desc.">{row.purchase_description}</td>
                    <td data-label="Unit Title">{row.base_unit_code}</td>
                    <td data-label="Stock Unit">{row.stock_unit_code || row.base_unit_code}</td>
                    <td data-label="Purchase Unit">{row.purchase_unit_code || row.base_unit_code}</td>
                    <td data-label="Sales Unit">{row.sales_unit_code || row.base_unit_code}</td>
                    <td data-label="Is W/ JO">{YES_NO(row.is_with_jo)}</td>
                    <td data-label="Is PO">{YES_NO(row.is_po)}</td>
                    <td data-label="Expense">{row.expense_account_name}</td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      {can('/non-inventories', 'can_edit') && <Link className="btn btn-sm" to={`/non-inventories/${row.id}/edit`}>Update</Link>}
                      <Link className="btn btn-sm btn-primary" to={`/inventory/${row.id}`}>View</Link>
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
