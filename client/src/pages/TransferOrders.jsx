import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Pagination from '../components/Pagination';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDate } from '../utils/dates';
import useAutoSearch from '../utils/useAutoSearch';
import SearchInput from '../components/SearchInput';
import { downloadFile } from '../utils/downloadFile';

const PAGE_SIZE = 10;

const STATUS_TABS = [
  { key: 'pending_fulfillment', label: 'Pending Fulfillment' },
  { key: 'partially_fulfilled', label: 'Partially Fulfilled' },
  { key: 'pending_receipt', label: 'Pending Receipt' },
  { key: 'pending_receipt_partially_fulfilled', label: 'Pending Receipt / Partially Fulfilled' },
  { key: 'received', label: 'Received' },
  { key: 'cancelled', label: 'Cancelled' },
];

const STATUS_LABELS = Object.fromEntries(STATUS_TABS.map((t) => [t.key, t.label]));

function formatDate(v) { return v ? displayDate(String(v).slice(0, 10)) : ''; }
function locationLabel(l) { return l ? l.location_name : ''; }

// The old system's date filter: "As of" a day (on or before it), or a "Period from" one day to
// another. Blank dates filter nothing.
const EMPTY_RANGE = { mode: 'as_of', from: '', to: '' };
function rangeParams(range, prefix, params) {
  if (range.mode === 'period' && range.from) params[`${prefix}_from`] = range.from;
  if (range.to) params[`${prefix}_to`] = range.to;
}

function DateRangeField({ label, value, onChange }) {
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <div className="field">
      <label>{label}</label>
      <div style={{ display: 'flex', gap: 6 }}>
        <select value={value.mode} onChange={(e) => set({ mode: e.target.value })} style={{ flex: '0 0 120px' }}>
          <option value="as_of">As of</option>
          <option value="period">Period from</option>
        </select>
        {value.mode === 'period' && (
          <input type="date" value={value.from} onChange={(e) => set({ from: e.target.value })} aria-label={`${label} from`} />
        )}
        <input type="date" value={value.to} onChange={(e) => set({ to: e.target.value })} aria-label={value.mode === 'period' ? `${label} to` : `${label} as of`} />
      </div>
    </div>
  );
}

function LocationField({ label, value, onChange, locations }) {
  return (
    <div className="field">
      <label>{label}</label>
      <div style={{ display: 'flex', gap: 4 }}>
        <div style={{ flex: 1 }}>
          <EntityPicker
            label={label} items={locations} value={value?.id || ''} getLabel={locationLabel}
            columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']}
            onSelect={onChange}
          />
        </div>
        {value && <button type="button" className="btn" title="Clear" onClick={() => onChange(null)}>×</button>}
      </div>
    </div>
  );
}

// Mirrors the real system's "Transfer Order" list -- how stock gets withdrawn from one
// warehouse (almost always Warehouse - Central) into whichever warehouse a Job Order's
// materials are actually short at. Most rows here are raised via the "Create TO" button
// on a Job Order's Production view rather than "Add New" here directly.
export default function TransferOrders() {
  const { can } = useAuth();
  const navigate = useNavigate();

  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('pending_fulfillment');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [withdrawFrom, setWithdrawFrom] = useState(null);
  const [transferTo, setTransferTo] = useState(null);
  const [created, setCreated] = useState(EMPTY_RANGE);
  const [needed, setNeeded] = useState(EMPTY_RANGE);
  const [locations, setLocations] = useState([]);

  useEffect(() => { api.get('/lookups/locations').then(({ data }) => setLocations(data)); }, []);

  // The filters as the server takes them -- shared by the list and the Extract.
  function filterParams() {
    const params = { status };
    if (search) params.search = search;
    if (withdrawFrom) params.withdraw_from = withdrawFrom.id;
    if (transferTo) params.transfer_to = transferTo.id;
    rangeParams(created, 'created', params);
    rangeParams(needed, 'needed', params);
    return params;
  }

  // Extract (asked 2026-11-09): every transfer order in the open tab under the filters, not just this page.
  const [extracting, setExtracting] = useState(false);
  async function extract() {
    setExtracting(true);
    try {
      await downloadFile('/transfer-orders', { ...filterParams(), format: 'xlsx' }, `transfer-orders-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch {
      alert('Extract failed. Please try again.');
    } finally {
      setExtracting(false);
    }
  }

  async function load() {
    setLoading(true);
    const params = filterParams();
    const [{ data }, { data: countData }] = await Promise.all([
      api.get('/transfer-orders', { params }),
      api.get('/transfer-orders/status-counts'),
    ]);
    setRows(data);
    setCounts(countData);
    setLoading(false);
  }

  useEffect(() => { setPage(1); load(); }, [status]);

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
        <h1>Transfer Orders</h1>
        {can('/transfer-orders', 'can_add') && <Link className="btn btn-primary" to={'/transfer-orders/new'}>Add New</Link>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="TO No., Job Order No. or Memo..." />
          </div>
          <DateRangeField label="Date Created" value={created} onChange={setCreated} />
          <LocationField label="Withdraw From" value={withdrawFrom} onChange={setWithdrawFrom} locations={locations} />
          <LocationField label="Transfer To" value={transferTo} onChange={setTransferTo} locations={locations} />
          <DateRangeField label="Delivery Date" value={needed} onChange={setNeeded} />
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" onClick={runSearch}>Search</button>
          <button type="button" className="btn" onClick={extract} disabled={extracting} title="Download every transfer order in this tab under the filters above">
            {extracting ? 'Extracting...' : 'Extract'}
          </button>
        </div>
      </div>

      <div className="status-tabs">
        {STATUS_TABS.map((t) => (
          <button key={t.key} className={`status-tab ${status === t.key ? 'active' : ''}`} onClick={() => setStatus(t.key)}>
            {t.label}{counts[t.key] ? <span className="badge badge-success" style={{ marginLeft: 6 }}>{counts[t.key]}</span> : null}
          </button>
        ))}
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>TO No.</th>
                  <th>Date Created</th>
                  <th>Date Needed</th>
                  <th>Withdraw From</th>
                  <th>Transfer To</th>
                  <th>Job Order</th>
                  <th>Requestor</th>
                  <th>Memo</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 20 }}>No transfer orders found.</td></tr>
                )}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="TO No.">{row.to_no}</td>
                    <td data-label="Date Created">{formatDate(row.date_created)}</td>
                    <td data-label="Date Needed">{formatDate(row.date_needed)}</td>
                    <td data-label="Withdraw From">{row.withdraw_from_name}</td>
                    <td data-label="Transfer To">{row.transfer_to_name}</td>
                    <td data-label="Job Order">{row.job_order_no || '—'}</td>
                    <td data-label="Requestor">{row.requestor_name || '—'}</td>
                    <td data-label="Memo" style={{ whiteSpace: 'pre-wrap', maxWidth: 280 }}>{row.memo || '—'}</td>
                    <td data-label="Status">{STATUS_LABELS[row.status] || row.status}</td>
                    <td><Link className="btn btn-sm btn-primary" to={`/transfer-orders/${row.id}`}>View</Link></td>
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
