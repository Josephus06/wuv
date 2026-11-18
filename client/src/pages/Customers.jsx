import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';
import MergePartyModal from '../components/MergePartyModal';
import SearchInput from '../components/SearchInput';

// Adding and editing a customer happen on their own page (CustomerForm.jsx), laid out as the old
// system's "Setup Your Customer" screen.
export default function Customers() {
  const { can, user } = useAuth();
  const [merging, setMerging] = useState(false);
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  // Filtered here rather than at the server: the list endpoint hands over every customer
  // anyway, so narrowing in the browser is instant and costs no round-trip per keystroke.
  const [search, setSearch] = useState('');

  async function load() {
    setLoading(true);
    const { data } = await api.get('/customers');
    setRows(data);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleDelete(row) {
    if (!confirm(`Delete customer "${row.name}"?`)) return;
    try {
      await api.delete(`/customers/${row.id}`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Delete failed');
    }
  }

  // Code, name, company and TIN -- the four things anyone actually has to hand when looking
  // a customer up. Every term must match somewhere, so "ACME 123" narrows rather than widens.
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visibleRows = terms.length === 0 ? rows : rows.filter((r) => {
    const hay = [r.customer_code, r.name, r.company_name, r.tin, r.list_address].map((v) => String(v || '').toLowerCase()).join(' ');
    return terms.every((t) => hay.includes(t));
  });

  const columns = [
    { key: 'customer_code', label: 'Code' },
    { key: 'name', label: 'Name' },
    { key: 'company_name', label: 'Company' },
    { key: 'list_address', label: 'Address', render: (r) => <span style={{ whiteSpace: 'normal', display: 'inline-block', maxWidth: 320 }}>{r.list_address || ''}</span> },
    { key: 'payment_term_name', label: 'Payment Term' },
    { key: 'credit_limit', label: 'Credit Limit' },
    { key: 'is_active', label: 'Status', render: (r) => (r.is_active ? <span className="badge badge-success">Active</span> : <span className="badge badge-muted">Inactive</span>) },
  ];

  return (
    <div>
      <div className="page-header">
        <h1>Customers</h1>
        {can('/customers', 'can_add') && <Link className="btn btn-primary" to={'/customers/new'}>Add Customer</Link>}
        {/* System Admin only, as the server is: a merge cannot be undone. */}
        {user?.account_type === 'System Admin' && (
          <button type="button" className="btn" style={{ marginLeft: 8 }} onClick={() => setMerging(true)}>Merge Customers</button>
        )}
      </div>
      {merging && (
        <MergePartyModal kind="customer" items={rows} onClose={() => setMerging(false)}
          onMerged={() => { setMerging(false); load(); }} />
      )}
      {!loading && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="filter-grid">
            <div className="field">
              <label>General Searching</label>
              <SearchInput
                value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Code, Name, Company, TIN or Address..."
              />
            </div>
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            {terms.length === 0
              ? `${rows.length.toLocaleString()} customers`
              : `${visibleRows.length.toLocaleString()} of ${rows.length.toLocaleString()} customers`}
          </div>
        </div>
      )}

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <DataTable
            paginate
            columns={columns}
            rows={visibleRows}
            emptyLabel={terms.length ? `No customer matches "${search.trim()}".` : 'No customers yet.'}
            actions={(row) => (
              <>
                <Link className="btn btn-sm btn-primary" to={`/customers/${row.id}`}>View</Link>
                {can('/customers', 'can_edit') && <Link className="btn btn-sm" to={`/customers/${row.id}/edit`}>Edit</Link>}
                {can('/customers', 'can_delete') && <button className="btn btn-sm btn-danger" onClick={() => handleDelete(row)}>Delete</button>}
              </>
            )}
          />
        )}
      </div>
    </div>
  );
}
