import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import { SupplierLink } from '../components/PartyLink';
import { displayDate } from '../utils/dates';
import useAutoSearch from '../utils/useAutoSearch';
import SearchInput from '../components/SearchInput';

// Mirrors the real "Saved Purchase Orders" list -- status tabs are a read-only bucket
// derived from status + receipt_status + bill_status together (see purchaseOrders.js's
// LIST_STATUS_CASE), not a single column, so they can't just be STATUS_VALUES off the
// row itself the way most other list pages' tabs are.
const STATUS_TABS = [
  { key: 'pending_approval', label: 'Pending Approval' },
  { key: 'pending_approval_gm', label: 'Pending Approval (GM)' },
  { key: 'pending_receipt', label: 'Pending Receipt' },
  { key: 'partially_received', label: 'Partially Received' },
  { key: 'pending_billing', label: 'Pending Billing' },
  { key: 'partially_billed', label: 'Partially Billed' },
  { key: 'fully_billed', label: 'Fully Billed' },
  { key: 'cancelled', label: 'Cancelled' },
];

const STATUS_LABELS = Object.fromEntries(STATUS_TABS.map((t) => [t.key, t.label]));
const ITEM_STATUS_LABELS = { not_received: '', partially_received: 'Partially Received', fully_received: 'Fully Received' };

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? displayDate(String(v).slice(0, 10)) : ''; }

export default function PurchaseOrders() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [showFilters, setShowFilters] = useState(true); // shown by default; Toggle Filter hides them (asked 2026-10-06)

  const [status, setStatus] = useState('pending_approval');
  const [search, setSearch] = useState('');
  const [supplier, setSupplier] = useState(null);
  // Period From / Date Created (As of): inclusive bounds on Date Created, applied on Search.
  const [dateFrom, setDateFrom] = useState('');
  const [asOf, setAsOf] = useState('');
  const [page, setPage] = useState(1);
  const limit = 10;

  const [suppliers, setSuppliers] = useState([]);

  function listParams() {
    const params = { status };
    if (search) params.search = search;
    if (supplier) params.supplier_id = supplier.id;
    if (dateFrom) params.date_from = dateFrom;
    if (asOf) params.as_of = asOf;
    return params;
  }

  // Extract: every purchase order under the filters and status tab above, as a workbook
  // (same params as the list).
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  async function runExport() {
    setExporting(true); setExportError('');
    try {
      const { data } = await api.get('/purchase-orders/export', { params: listParams(), responseType: 'blob' });
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url; a.download = 'purchase-orders.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setExportError('Could not extract the purchase orders.');
    } finally {
      setExporting(false);
    }
  }

  async function load() {
    setLoading(true);
    const params = { ...listParams(), page, limit };
    const { data } = await api.get('/purchase-orders', { params });
    setRows(data.rows);
    setTotal(data.total);
    setCounts(data.counts);
    setLoading(false);
  }

  useEffect(() => { api.get('/suppliers').then(({ data }) => setSuppliers(data)); }, []);
  useEffect(() => { load(); }, [status, page]); // eslint-disable-line react-hooks/exhaustive-deps

  function runSearch() {
    setPage(1);
    load();
  }
  useAutoSearch(search, runSearch);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
          <h1 style={{ fontSize: 16, textTransform: 'uppercase', margin: 0 }}>Saved Purchase Orders</h1>
          <span className="muted">Lists</span>
          <button type="button" className="link-btn" onClick={() => setShowFilters((s) => !s)}>Toggle Filter</button>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-primary" to={'/purchase-orders/new'}>Add Purchase Order</Link>
        </div>
      </div>

      {showFilters && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="filter-grid">
            <div className="field">
              <label>General Searching</label>
              <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="Search..." />
            </div>
            <div className="field">
              <label>Supplier</label>
              <div style={{ display: 'flex', gap: 4 }}>
                <div style={{ flex: 1 }}>
                  <EntityPicker
                    label="Supplier" items={suppliers} value={supplier?.id || ''} getLabel={(s) => s?.name}
                    columns={[{ key: 'name', label: 'Name' }, { key: 'address', label: 'Address', render: (s) => s.address || '—' }]} searchKeys={['name', 'address']}
                    onSelect={setSupplier}
                  />
                </div>
                {supplier && <button type="button" className="btn" title="Clear Supplier" onClick={() => setSupplier(null)}>×</button>}
              </div>
            </div>
            <div className="field">
              <label>Period From</label>
              <input type="date" value={dateFrom} max={asOf || undefined} onChange={(e) => setDateFrom(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} />
            </div>
            <div className="field">
              <label>Date Created (As of)</label>
              <input type="date" value={asOf} min={dateFrom || undefined} onChange={(e) => setAsOf(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} />
            </div>
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={runSearch}>Search</button>
            <button className="btn" disabled={exporting} onClick={runExport} title="Download every purchase order under the filters and status tab above">
              {exporting ? 'Extracting...' : 'Extract'}
            </button>
            {exportError && <span style={{ color: 'var(--danger)' }}>{exportError}</span>}
          </div>
        </div>
      )}

      <div className="status-tabs">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            className={`status-tab ${status === t.key ? 'active' : ''}`}
            onClick={() => { setStatus(t.key); setPage(1); }}
          >
            {t.label} {counts[t.key] > 0 && <span className="badge badge-muted">{counts[t.key]}</span>}
          </button>
        ))}
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <>
            <div className="table-wrap">
              <table className="responsive-cards">
                <thead>
                  <tr>
                    <th>PO No</th>
                    <th>Ref. No</th>
                    <th>Date Created</th>
                    <th>Supplier</th>
                    <th>Discount Amt</th>
                    <th>Total Amt (Net of VAT)</th>
                    <th>Tax Amt</th>
                    <th>Total Amt</th>
                    <th>Prepared By</th>
                    <th>Status</th>
                    <th>Item Status</th>
                    <th>PO Type</th>
                    <th>Memo</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={14} className="muted" style={{ textAlign: 'center', padding: 20 }}>No purchase orders found.</td></tr>
                  )}
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td data-label="PO No">{row.po_no}</td>
                      <td data-label="Ref. No">{row.ref_no}</td>
                      <td data-label="Date Created">{formatDate(row.date_created)}</td>
                      <td data-label="Supplier"><SupplierLink id={row.supplier_id} name={row.supplier_name} /></td>
                      <td data-label="Discount Amt">{money(row.discount_amount)}</td>
                      <td data-label="Total Amt (Net of VAT)">{money(row.net_of_tax)}</td>
                      <td data-label="Tax Amt">{money(row.tax_amount)}</td>
                      <td data-label="Total Amt">{money(row.total_amount)}</td>
                      <td data-label="Prepared By">{row.created_by_name}</td>
                      <td data-label="Status">{STATUS_LABELS[row.list_status] || row.list_status}</td>
                      <td data-label="Item Status">{ITEM_STATUS_LABELS[row.receipt_status]}</td>
                      <td data-label="PO Type">{row.type}</td>
                      <td data-label="Memo">{row.memo}</td>
                      <td><Link className="btn btn-sm btn-primary" to={`/purchase-orders/${row.id}`}>View</Link></td>
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
