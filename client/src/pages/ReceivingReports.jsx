import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useHeadOfficeFilter } from '../utils/useHeadOffice';
import EntityPicker from '../components/EntityPicker';
import FilterPicker from '../components/FilterPicker';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import { SupplierLink } from '../components/PartyLink';
import { displayDate } from '../utils/dates';
import useAutoSearch from '../utils/useAutoSearch';
import SearchInput from '../components/SearchInput';

// Purchasing > Receiving Report -- every RR raised against every Purchase Order.
//
// Read-only by design: a Receiving Report is created by receiving a PO, so there is no "Add"
// here. This answers "what did we receive, from whom, and when" without opening POs one at a
// time.
//
// Deliberately no status column: a Receiving Report has none of its own, and the parent PO's
// receipt_status is stale for everything that came in through the importer (19,100 of 19,103
// POs with receipts still read 'not_received'). Showing it would be showing a wrong answer,
// so the list reports the receipt's own line count and quantity instead.

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '';
}
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? displayDate(String(v).slice(0, 10)) : ''; }

export default function ReceivingReports() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalAmount, setTotalAmount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showFilters, setShowFilters] = useState(true); // shown by default; Toggle Filter hides them (asked 2026-10-06)

  const [search, setSearch] = useState('');
  const [supplier, setSupplier] = useState(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // Location, Department, Item and an As of / Period date (asked 2026-10-13).
  // As of today by default (2026-11-11), as the source's Received Purchase Orders screen opens.
  const [dateMode, setDateMode] = useState('as_of');
  const [asOf, setAsOf] = useState(() => new Date().toLocaleDateString('en-CA'));
  const [locationId, setLocationId] = useHeadOfficeFilter(); // Head Office by default (2026-10-14); null until known
  const [departmentId, setDepartmentId] = useState('');
  const [item, setItem] = useState(null);
  const [options, setOptions] = useState({ locations: [], departments: [] });
  const [itemOptions, setItemOptions] = useState([]);
  const [page, setPage] = useState(1);
  const limit = 20;

  const [suppliers, setSuppliers] = useState([]);

  // The filters as request params -- the list and its Extract send the same ones.
  function listParams() {
    const params = {};
    if (search) params.search = search;
    if (supplier) params.supplier_id = supplier.id;
    if (dateMode === 'as_of') {
      params.date_mode = 'as_of';
      if (asOf) params.as_of = asOf;
    } else {
      if (from) params.from = from;
      if (to) params.to = to;
    }
    if (locationId) params.location_id = locationId;
    if (departmentId) params.department_id = departmentId;
    if (item) params.item_id = item.id;
    return params;
  }

  // Extract (asked 2026-11-05): every receiving report under the filters, as a workbook.
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  async function runExport() {
    setExporting(true); setExportError('');
    try {
      const { data } = await api.get('/receiving-reports/export', { params: listParams(), responseType: 'blob' });
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url; a.download = 'receiving-reports.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setExportError('Could not extract the receiving reports.');
    } finally {
      setExporting(false);
    }
  }

  async function load() {
    setLoading(true);
    try {
      const params = { ...listParams(), limit, offset: (page - 1) * limit };
      const { data } = await api.get('/receiving-reports', { params });
      setRows(data.rows);
      setTotal(data.total);
      setTotalAmount(data.total_amount);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { api.get('/suppliers').then(({ data }) => setSuppliers(data)).catch(() => setSuppliers([])); }, []);
  useEffect(() => {
    api.get('/receiving-reports/filter-options').then(({ data }) => setOptions(data)).catch(() => {});
    searchItems('');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // The Item picker asks the server (received items only); the chosen one is kept in the list.
  function searchItems(text) {
    api.get('/receiving-reports/items', { params: { q: (text || '').trim() } })
      .then(({ data }) => setItemOptions(item && !data.some((i) => i.id === item.id) ? [item, ...data] : data))
      .catch(() => {});
  }
  useEffect(() => { if (locationId === null) return; load(); }, [page, locationId === null]); // eslint-disable-line react-hooks/exhaustive-deps

  function runSearch() {
    // Reset to page 1 and load once: setPage(1) alone would not re-fire when already on 1.
    if (page === 1) load(); else setPage(1);
  }
  useAutoSearch(search, runSearch);

  function clearFilters() {
    setSearch(''); setSupplier(null); setFrom(''); setTo('');
    setAsOf(new Date().toLocaleDateString('en-CA')); setDateMode('as_of'); setLocationId(''); setDepartmentId(''); setItem(null);
    if (page === 1) load(); else setPage(1);
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
          <h1 style={{ fontSize: 16, textTransform: 'uppercase', margin: 0 }}>Receiving Reports</h1>
          <span className="muted">Lists</span>
          <button type="button" className="link-btn" onClick={() => setShowFilters((s) => !s)}>Toggle Filter</button>
        </div>
      </div>

      {showFilters && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="filter-grid">
            <div className="field">
              <label>General Searching</label>
              <SearchInput
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runSearch()}
                placeholder="RR #, PO #, Supplier, Ref #, Memo, Item"
              />
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
              <label>Location</label>
              <FilterPicker label="Location" items={options.locations} value={locationId ?? ''} onChange={setLocationId}
                getLabel={(l) => l.name} allLabel="All" />
            </div>
            <div className="field">
              <label>Department</label>
              <FilterPicker label="Department" items={options.departments} value={departmentId} onChange={setDepartmentId}
                getLabel={(d) => d.name} allLabel="All" />
            </div>
            <div className="field">
              <label>Item</label>
              <EntityPicker
                label="Item" items={itemOptions} value={item?.id ?? ''} getLabel={(i) => `${i.item_code ? `${i.item_code} — ` : ''}${i.display_name}`}
                columns={[{ key: 'item_code', label: 'Code' }, { key: 'display_name', label: 'Item' }]} searchKeys={['item_code', 'display_name']}
                placeholder="All" onSearch={searchItems}
                onSelect={(i) => setItem(i || null)} onClear={() => setItem(null)}
              />
            </div>
            <div className="field">
              <label>Date</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <select value={dateMode} onChange={(e) => setDateMode(e.target.value)} style={{ width: 'auto' }}>
                  <option value="as_of">As of</option>
                  <option value="range">Period</option>
                </select>
                {dateMode === 'as_of' ? (
                  <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
                ) : (
                  <>
                    <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} title="From" />
                    <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} title="To" />
                  </>
                )}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={runSearch}>Search</button>
            <button className="btn" onClick={clearFilters}>Clear</button>
            <button className="btn" disabled={exporting} onClick={runExport} title="Download every receiving report under the filters above">
              {exporting ? 'Extracting...' : 'Extract'}
            </button>
            {exportError && <span style={{ color: 'var(--danger)' }}>{exportError}</span>}
          </div>
        </div>
      )}

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  {/* One row per line received (2026-11-11), the source's Received Purchase Orders columns. */}
                  <tr>
                    <th>RR #</th>
                    <th>RR Date</th>
                    <th>Ref #</th>
                    <th>PO #</th>
                    <th>PO Date</th>
                    <th>Name</th>
                    <th>Memo</th>
                    <th>Item</th>
                    <th>Type</th>
                    <th>Description</th>
                    <th style={{ textAlign: 'right' }}>Qty</th>
                    <th>Units</th>
                    <th style={{ textAlign: 'right' }}>Rate</th>
                    <th style={{ textAlign: 'right' }}>Discount</th>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                    <th>Department</th>
                    <th>Location</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={18} className="muted" style={{ textAlign: 'center', padding: 20 }}>No receiving reports found.</td></tr>
                  )}
                  {rows.map((r) => (
                    <tr key={r.line_id}>
                      <td style={{ whiteSpace: 'nowrap' }}><Link className="link-btn" to={`/receiving-reports/${r.id}`}>{r.receipt_no}</Link></td>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatDate(r.date_created)}</td>
                      <td>{r.ref_no || ''}</td>
                      <td style={{ whiteSpace: 'nowrap' }}><Link className="link-btn" to={`/purchase-orders/${r.purchase_order_id}`}>{r.po_no}</Link></td>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatDate(r.po_date)}</td>
                      <td>{r.supplier_name ? <SupplierLink id={r.supplier_id} name={r.supplier_name} /> : '—'}</td>
                      <td>{r.memo || ''}</td>
                      <td>{r.item_name || ''}</td>
                      <td>{r.item_type || ''}</td>
                      <td>{r.description || ''}</td>
                      <td style={{ textAlign: 'right' }}>{qty(r.qty_received)}</td>
                      <td>{r.units || ''}</td>
                      <td style={{ textAlign: 'right' }}>{money(r.rate)}</td>
                      <td style={{ textAlign: 'right' }}>{Number(r.disc_percent) ? qty(r.disc_percent) : ''}</td>
                      <td style={{ textAlign: 'right' }}>{money(r.net_of_tax)}</td>
                      <td>{r.department_name || ''}</td>
                      <td>{r.location_name || ''}</td>
                      <td><button type="button" className="btn btn-sm btn-primary" onClick={() => navigate(`/receiving-reports/${r.id}`)}>View</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, flexWrap: 'wrap', gap: 8 }}>
              <span className="muted">
                {total.toLocaleString()} line{total === 1 ? '' : 's'} received · {money(totalAmount)} total (net of VAT)
              </span>
            </div>

            <Pagination page={page} totalPages={totalPages} onChange={setPage} />
          </>
        )}
      </div>
    </div>
  );
}
