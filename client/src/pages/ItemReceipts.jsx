import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import Pagination from '../components/Pagination';
import { displayDate } from '../utils/dates';
import { downloadFile } from '../utils/downloadFile';
import useAutoSearch from '../utils/useAutoSearch';
import SearchInput from '../components/SearchInput';

function formatDate(v) { return v ? displayDate(String(v).slice(0, 10)) : ''; }
function locationLabel(l) { return l ? l.location_name : ''; }
function employeeLabel(e) { return e ? `${e.first_name} ${e.last_name}` : ''; }

// Global "Saved Item Receipts" list -- every Item Receipt across every Transfer Order /
// Item Fulfillment, filterable the same way the real system's own screen is. Previously
// these were only reachable one Item Fulfillment at a time (its Related Records tab);
// this gives the same standalone browse the real system has. Creating one still only
// happens via a specific OPEN Item Fulfillment's "Receive" flow -- that flow already
// exists and doesn't need a second entry point here.
export default function ItemReceipts() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const limit = 10;

  const [search, setSearch] = useState('');
  const [withdrawFrom, setWithdrawFrom] = useState(null);
  const [transferTo, setTransferTo] = useState(null);
  const [requestor, setRequestor] = useState(null);
  const [asOf, setAsOf] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [extracting, setExtracting] = useState(false);

  const [locations, setLocations] = useState([]);
  const [employees, setEmployees] = useState([]);

  useEffect(() => {
    api.get('/lookups/locations').then(({ data }) => setLocations(data));
    api.get('/employees').then(({ data }) => setEmployees(data));
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch when the page changes. runSearch resets to page 1, which fires this too --
  // guarded there so a search from page 1 still reloads.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  function runSearch() {
    if (page === 1) load(); else setPage(1);
  }
  useAutoSearch(search, runSearch);

  // The filters as the server takes them -- shared by the list and the Extract.
  function filterParams() {
    const params = {};
    if (search) params.search = search;
    if (withdrawFrom) params.withdraw_from = withdrawFrom.id;
    if (transferTo) params.transfer_to = transferTo.id;
    if (requestor) params.requestor_id = requestor.id;
    if (asOf) params.as_of = asOf;
    if (dateFrom) params.date_from = dateFrom;
    if (dateTo) params.date_to = dateTo;
    return params;
  }

  async function load() {
    setLoading(true);
    const params = { page, limit, ...filterParams() };
    const { data } = await api.get('/transfer-orders/item-receipts', { params });
    setRows(data.rows);
    setTotal(data.total);
    setLoading(false);
  }

  // Extract: every row under the current filters (not just this page) as an Excel workbook.
  async function extract() {
    setExtracting(true);
    try {
      await downloadFile('/transfer-orders/item-receipts', { ...filterParams(), format: 'xlsx' }, `item-receipts-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch {
      alert('Extract failed. Please try again.');
    } finally {
      setExtracting(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
          <h1 style={{ fontSize: 16, textTransform: 'uppercase', margin: 0 }}>Saved Item Receipts</h1>
        </div>
        <button type="button" className="btn" onClick={extract} disabled={extracting}>{extracting ? 'Extracting...' : 'Extract'}</button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="IR No., IF No., TO No., JO No. or item..." />
          </div>
          <div className="field">
            <label>Withdraw From</label>
            <div style={{ display: 'flex', gap: 4 }}>
              <div style={{ flex: 1 }}>
                <EntityPicker
                  label="Withdraw From" items={locations} value={withdrawFrom?.id || ''} getLabel={locationLabel}
                  columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']}
                  onSelect={setWithdrawFrom}
                />
              </div>
              {withdrawFrom && <button type="button" className="btn" title="Clear" onClick={() => setWithdrawFrom(null)}>×</button>}
            </div>
          </div>
          <div className="field">
            <label>Transfer To</label>
            <div style={{ display: 'flex', gap: 4 }}>
              <div style={{ flex: 1 }}>
                <EntityPicker
                  label="Transfer To" items={locations} value={transferTo?.id || ''} getLabel={locationLabel}
                  columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']}
                  onSelect={setTransferTo}
                />
              </div>
              {transferTo && <button type="button" className="btn" title="Clear" onClick={() => setTransferTo(null)}>×</button>}
            </div>
          </div>
          <div className="field">
            <label>Requestor</label>
            <div style={{ display: 'flex', gap: 4 }}>
              <div style={{ flex: 1 }}>
                <EntityPicker
                  label="Requestor" items={employees} value={requestor?.id || ''} getLabel={employeeLabel}
                  columns={[{ key: 'name', label: 'Name', render: employeeLabel }]} searchKeys={['first_name', 'last_name']}
                  onSelect={setRequestor}
                />
              </div>
              {requestor && <button type="button" className="btn" title="Clear" onClick={() => setRequestor(null)}>×</button>}
            </div>
          </div>
          <div className="field">
            <label>Date (As of)</label>
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </div>
          <div className="field">
            <label>Date From</label>
            <input type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} />
          </div>
          <div className="field">
            <label>Date To</label>
            <input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} />
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
                  <th>IR #</th>
                  <th>IR Date</th>
                  <th>TO #</th>
                  <th>TO Date</th>
                  <th>JO #</th>
                  <th>Memo</th>
                  <th>Item</th>
                  <th>Description</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th>Units</th>
                  <th>From Location</th>
                  <th>To Location</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={13} className="muted" style={{ textAlign: 'center', padding: 20 }}>No item receipts found.</td></tr>
                )}
                {rows.map((row) => (
                  // One row per item received (asked 2026-11-10, as the old system lists them).
                  <tr key={row.line_id}>
                    <td data-label="IR #">{row.receipt_no}</td>
                    <td data-label="IR Date">{formatDate(row.date_created)}</td>
                    <td data-label="TO #">{row.to_no}</td>
                    <td data-label="TO Date">{formatDate(row.to_date)}</td>
                    <td data-label="JO #">{row.job_order_no || '—'}</td>
                    <td data-label="Memo">{row.memo}</td>
                    <td data-label="Item">{row.item_code}</td>
                    <td data-label="Description">{row.item_name}</td>
                    <td data-label="Qty" style={{ textAlign: 'right' }}>{row.qty_received == null ? '' : Number(row.qty_received).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
                    <td data-label="Units">{row.units}</td>
                    <td data-label="From Location">{row.withdraw_from_name}</td>
                    <td data-label="To Location">{row.transfer_to_name}</td>
                    <td><Link className="btn btn-sm btn-primary" to={`/transfer-orders/item-receipts/${row.id}`}>View</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!loading && (
          <>
            <div className="muted" style={{ marginTop: 12 }}>
              {total.toLocaleString()} item{total === 1 ? '' : 's'} received
            </div>
            <Pagination page={page} totalPages={Math.max(1, Math.ceil(total / limit))} onChange={setPage} />
          </>
        )}
      </div>
    </div>
  );
}
