import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useHeadOfficeFilter } from '../utils/useHeadOffice';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import StandaloneInvoiceModal from '../components/StandaloneInvoiceModal';
import { useAuth } from '../context/useAuth';

import { displayDate } from '../utils/dates';
import useAutoSearch from '../utils/useAutoSearch';
import { CustomerLink } from '../components/PartyLink';
import FilterPicker from '../components/FilterPicker';
import SearchInput from '../components/SearchInput';

const PAGE_SIZE = 10;
const STATUS_LABELS = { saved: 'Open', cancelled: 'Void' };

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? displayDate(String(v).slice(0, 10)) : ''; }

// No. of days overdue: whole days from Date Due to the cut-off -- the Date To the list was searched
// with, or today without one. Negative while not yet due (-4 = due in 4 days), 0 on the due date.
// Blank for a Void invoice or one with no Amount Due left. Same rule as the extract.
function daysOverdue(row, cutOff) {
  if (!row.date_due || row.status === 'cancelled' || !(Number(row.amount_due) > 0)) return '';
  const [y, m, d] = String(row.date_due).slice(0, 10).split('-').map(Number);
  let asOf;
  if (cutOff) {
    const [cy, cm, cd] = cutOff.split('-').map(Number);
    asOf = Date.UTC(cy, cm - 1, cd);
  } else {
    const now = new Date();
    asOf = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  }
  return Math.round((asOf - Date.UTC(y, m - 1, d)) / 86400000);
}

// Mirrors the real system's "Saved Invoices" list -- reached from Accounting > Invoice
// on the real site. Only Sales Invoices exist in this build (no BS/DR/DT transaction
// types), so Type always reads "SI" and there's no Type filter -- everything else
// (columns, Status filter, search) mirrors the real screen.
export default function SalesInvoices() {
  const navigate = useNavigate();
  const { can } = useAuth();
  // can_add, matching what the server asks of this path: raising an invoice against an Estimate
  // is creating a new document, not amending one. Billing a Sales Order or a Delivery Ticket
  // still needs can_edit, because those move quantities and statuses on records that already
  // exist -- see requireInvoiceCreatePermission in routes/salesInvoices.js.
  const mayCreate = can('/sales-invoices', 'can_add');
  const [showCreate, setShowCreate] = useState(false);

  const [rows, setRows] = useState([]);
  // The server now decides the page, so the total has to come from it too -- rows.length is
  // only ever the ten rows on screen.
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  // Date Created, both ends optional and both inclusive. Held as plain yyyy-mm-dd strings, which
  // is what <input type="date"> gives and what the server compares against a DATE column -- no
  // Date object in between to drag the value through a timezone on the way.
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // The Date To the rows on screen were loaded with: the overdue cut-off. Not `to` itself, so
  // typing a date doesn't change the column before Search is pressed.
  const [cutOff, setCutOff] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  // Head Office by default (2026-10-14; utils/useHeadOffice); null until known, and the list waits for it.
  const [locationId, setLocationId] = useHeadOfficeFilter();
  const [locations, setLocations] = useState([]);
  const [invoiceType, setInvoiceType] = useState(''); // '' = all, 'SI' or 'DR'
  const [departments, setDepartments] = useState([]);
  const [page, setPage] = useState(1);

  // From the invoice module's own meta route, not /lookups/departments: a third of the people who
  // can read this page cannot read /lookups, and they would have got an empty dropdown with no
  // sign of why. See the /meta route in routes/salesInvoices.js.
  useEffect(() => {
    api.get('/sales-invoices/meta')
      .then(({ data }) => { setDepartments(data.departments || []); setLocations(data.locations || []); })
      .catch(() => { setDepartments([]); setLocations([]); });
  }, []);

  // Asks the server for ONE page. This used to fetch every row and slice it here, which meant
  // downloading the whole table to display ten of it -- and it made the search box a lie, since
  // it could only match rows already downloaded. Both now happen server-side.
  async function load(toPage = page) {
    setLoading(true);
    const params = { page: toPage, limit: PAGE_SIZE };
    if (status) params.status = status;
    if (search) params.search = search;
    if (from) params.from = from;
    if (to) params.to = to;
    if (departmentId) params.department_id = departmentId;
    if (locationId) params.location_id = locationId;
    if (invoiceType) params.type = invoiceType;
    try {
      const { data } = await api.get('/sales-invoices', { params });
      setRows(data.rows || []);
      setTotal(Number(data.total) || 0);
      setCutOff(to || '');
    } finally {
      setLoading(false);
    }
  }

  // Every one of these changes which rows the SERVER should return, so each has to refetch --
  // paging is no longer something the browser can answer out of what it already holds.
  // The two dropdowns apply themselves; the dates and the search box wait for Search. A <select>
  // is one deliberate act, but a date input fires onChange on the way to a complete date, so
  // refetching on it would run a query per keystroke against half-typed years.
  useEffect(() => { if (locationId === null) return; setPage(1); load(1); }, [status, departmentId, locationId, invoiceType]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (locationId === null) return; load(page); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  function runSearch() {
    setPage(1);
    load(1);
  }
  useAutoSearch(search, runSearch);

  // Cleared in one go rather than field by field: four filters can combine into an empty list
  // whose cause is off-screen, and hunting for which one did it is the moment people give up on
  // a filter bar. The fetch is issued with the cleared values directly -- setState has not landed
  // yet when load() reads them.
  function clearFilters() {
    setStatus(''); setSearch(''); setFrom(''); setTo(''); setDepartmentId(''); setLocationId(''); setInvoiceType('');
    setPage(1);
    setLoading(true);
    api.get('/sales-invoices', { params: { page: 1, limit: PAGE_SIZE } })
      .then(({ data }) => { setRows(data.rows || []); setTotal(Number(data.total) || 0); setCutOff(''); })
      .finally(() => setLoading(false));
  }

  // Extract: the invoices under the filters on screen, as an Excel file. Open to everyone who can
  // view this page -- the server gates it on the same can_view and the same Sales Rep scope as
  // the list, so nobody can download an invoice the list would not show them.
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState('');
  async function extract() {
    setExtracting(true); setExtractError('');
    const params = {};
    if (status) params.status = status;
    if (search) params.search = search;
    if (from) params.from = from;
    if (to) params.to = to;
    if (departmentId) params.department_id = departmentId;
    if (locationId) params.location_id = locationId;
    if (invoiceType) params.type = invoiceType;
    try {
      const { data } = await api.get('/sales-invoices/export', { params, responseType: 'blob' });
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url; a.download = `sales-invoices${from || to ? `-${from || 'start'}-to-${to || 'today'}` : ''}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setExtractError('Could not extract the invoices.');
    } finally {
      setExtracting(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageRows = rows;

  return (
    <div>
      <div className="page-header">
        <h1>Saved Invoices</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {mayCreate && (
            <button className="btn btn-primary" onClick={() => setShowCreate(true)}>Create New</button>
          )}
        </div>
      </div>

      {showCreate && (
        // Create New bills a customer directly, with item lines and no order behind it (rent and
        // other one-off charges). Order-based invoices are raised from the order itself.
        <StandaloneInvoiceModal
          onClose={() => setShowCreate(false)}
          onSaved={(si) => { setShowCreate(false); navigate(`/sales-invoices/${si.id}`); }}
        />
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="Invoice #, BS/SI #, PO #, SO # or Customer..." />
          </div>
          <div className="field">
            <label>Type</label>
            <select value={invoiceType} onChange={(e) => setInvoiceType(e.target.value)}>
              <option value="">--ALL--</option>
              <option value="SI">SI</option>
              <option value="DR">DR</option>
            </select>
          </div>
          <div className="field">
            <label>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">--ALL--</option>
              <option value="saved">Open</option>
              <option value="cancelled">Void</option>
            </select>
          </div>
          <div className="field">
            <label>Department</label>
            <FilterPicker label="Department" items={departments} value={departmentId} onChange={(v) => setDepartmentId(v)}
              getLabel={(d) => d.name} allLabel="--ALL--" />
          </div>
          <div className="field">
            <label>Location</label>
            <FilterPicker label="Location" items={locations} value={locationId ?? ''} onChange={(v) => setLocationId(v)}
              getLabel={(l) => l.name} allLabel="--ALL--" />
          </div>
          <div className="field">
            <label>Date From</label>
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <label>Date To</label>
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn-primary" onClick={runSearch}>Search</button>
          <button className="btn" onClick={clearFilters}>Clear</button>
          <button className="btn" disabled={extracting} onClick={extract}
            title="Download every invoice under the filters above as an Excel file">
            {extracting ? 'Extracting...' : 'Extract'}
          </button>
          {extractError && <span style={{ color: 'var(--danger)' }}>{extractError}</span>}
        </div>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Invoice #</th>
                  <th>SO #</th>
                  <th>Date Created</th>
                  <th>Date Due</th>
                  <th>No. of days overdue</th>
                  <th>DT #</th>
                  <th>DT Date Created</th>
                  <th>Office Location</th>
                  <th>Customer</th>
                  <th>Sales Rep</th>
                  <th>Department</th>
                  <th>Net of Tax</th>
                  <th>Tax Amount</th>
                  <th>Gross Amount</th>
                  <th>Amount Due</th>
                  <th>Type</th>
                  <th>BS/SI #</th>
                  <th>Term</th>
                  <th>Received by Logistics</th>
                  <th>Status</th>
                  <th>Memo</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={22} className="muted" style={{ textAlign: 'center', padding: 20 }}>No invoices found.</td></tr>
                )}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Invoice #">{row.invoice_no}</td>
                    <td data-label="SO #">{row.sales_order_no}</td>
                    <td data-label="Date Created">{formatDate(row.date_created)}</td>
                    <td data-label="Date Due">{formatDate(row.date_due)}</td>
                    <td data-label="No. of days overdue">{daysOverdue(row, cutOff)}</td>
                    <td data-label="DT #">{row.dt_no}</td>
                    <td data-label="DT Date Created">{formatDate(row.dt_date_created)}</td>
                    <td data-label="Office Location">{row.office_location_name}</td>
                    <td data-label="Customer"><CustomerLink id={row.customer_id} name={row.customer_name} /></td>
                    <td data-label="Sales Rep">{row.sales_rep_name}</td>
                    <td data-label="Department">{row.department_name}</td>
                    <td data-label="Net of Tax">{money(row.net_of_tax)}</td>
                    <td data-label="Tax Amount">{money(row.tax_amount)}</td>
                    <td data-label="Gross Amount">{money(row.gross_amount)}</td>
                    <td data-label="Amount Due">{money(row.amount_due)}</td>
                    <td data-label="Type">{row.invoice_type || 'SI'}</td>
                    <td data-label="BS/SI #">{row.bs_si_no}</td>
                    <td data-label="Term">{row.term}</td>
                    <td data-label="Received by Logistics">{formatDate(row.logistics_received_date)}</td>
                    <td data-label="Status">{STATUS_LABELS[row.status] || row.status}</td>
                    <td data-label="Memo">{row.memo}</td>
                    <td><Link className="btn btn-sm btn-primary" to={`/sales-invoices/${row.id}`}>View</Link></td>
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
