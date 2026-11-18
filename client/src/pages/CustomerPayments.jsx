import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { headOfficeLocationId } from '../utils/useHeadOffice';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import EntityPicker from '../components/EntityPicker';
import CustomerPaymentModal from '../components/CustomerPaymentModal';
import { useAuth } from '../context/useAuth';

import { displayDate } from '../utils/dates';
import useAutoSearch from '../utils/useAutoSearch';
import { CustomerLink } from '../components/PartyLink';
import FilterPicker from '../components/FilterPicker';
import SearchInput from '../components/SearchInput';

const PAGE_SIZE = 10;
const NO_FILTERS = { search: '', status: '', departmentId: '', locationId: '', dateFrom: '', dateTo: '' };
// A saved payment sits NOT DEPOSITED until a bank deposit sweeps it into the bank.
const STATUS_LABELS = { not_deposited: 'Not Deposited', deposited: 'Deposited', voided: 'Void' };
// The source list's Receipt column shows the short code.
const RECEIPT_CODES = { 'Official Receipt': 'OR', 'Collection Receipt': 'CR', 'Provisional Receipt': 'PR' };
const receiptCode = (t) => RECEIPT_CODES[t] || t || '';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? displayDate(String(v).slice(0, 10)) : ''; }

export default function CustomerPayments() {
  const { can } = useAuth();
  // Raising a payment starts with the CUSTOMER, because that is the only thing known when someone
  // walks in and hands money over. Which invoices it settles is decided in the form afterwards.
  const [customers, setCustomers] = useState([]);
  const [newFor, setNewFor] = useState(null);
  const [rows, setRows] = useState([]);
  // How many match the current filter, which is no longer the same as how many were downloaded.
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  // Two copies of the filters on purpose. `form` is what the controls show as they are typed;
  // `applied` is what the last fetch actually used. Without the split, every keystroke in the
  // search box or a half-typed year in a date field would be a query against 130,000 rows.
  const [form, setForm] = useState(NO_FILTERS);
  const [applied, setApplied] = useState(NO_FILTERS);
  const [departments, setDepartments] = useState([]);
  const [locations, setLocations] = useState([]);
  const [page, setPage] = useState(1);

  // Applying a filter always returns to page 1: page 9,000 of "all" is not page 9,000 of
  // "deposited", and landing past the end of the filtered list would show an empty table.
  function apply(next) {
    setForm(next);
    setApplied(next);
    setPage(1);
  }
  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  // Bumped to re-run the fetch when nothing about the page or the filters changed but the data
  // did -- saving a new payment. Re-applying the same filter object would not do it: React skips
  // a state update that sets the identical value.
  const [refreshKey, setRefreshKey] = useState(0);

  // One effect is the only thing that fetches, keyed on the page and the applied filters. Every
  // control changes one of those two and nothing else, so there is no path that sets state and
  // forgets to reload, and none that reloads twice for one click.
  // Location starts on Head Office (2026-10-14; utils/useHeadOffice); the list waits for it.
  const [hoReady, setHoReady] = useState(false);
  useEffect(() => {
    headOfficeLocationId().then((id) => {
      if (id) { setForm((f) => ({ ...f, locationId: id })); setApplied((a) => ({ ...a, locationId: id })); }
      setHoReady(true);
    });
  }, []);

  useEffect(() => {
    if (!hoReady) return undefined;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const params = { page, page_size: PAGE_SIZE };
      if (applied.status) params.status = applied.status;
      if (applied.search) params.search = applied.search;
      if (applied.departmentId) params.department_id = applied.departmentId;
      if (applied.locationId) params.office_location_id = applied.locationId;
      if (applied.dateFrom) params.date_from = applied.dateFrom;
      if (applied.dateTo) params.date_to = applied.dateTo;
      try {
        const { data } = await api.get('/customer-payments', { params });
        // A slow page 1 must not overwrite a fast page 2 that was asked for after it.
        if (cancelled) return;
        setRows(data.rows || []);
        setTotal(Number(data.total) || 0);
      } finally {
        // In a finally so a failed request cannot leave the page spinning forever, which is what
        // the old `setLoading(false)` after the await would have done on any error.
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [page, applied, refreshKey, hoReady]);

  // The two dropdowns' options. Lookups, not the admin lists -- a handful of rows each, needing
  // no permission beyond seeing this page. Failures are swallowed: a filter that cannot offer its
  // options is a missing dropdown, not a reason to take the list down with it.
  useEffect(() => {
    const pick = (data) => (Array.isArray(data) ? data : (data?.rows || []));
    api.get('/lookups/departments').then(({ data }) => setDepartments(pick(data))).catch(() => {});
    api.get('/lookups/locations').then(({ data }) => setLocations(pick(data))).catch(() => {});
  }, []);

  // Only for the Add picker, and only when the button is there to use it.
  useEffect(() => {
    if (!can('/customer-payments', 'can_add')) return;
    // The slim list (id, code, name) -- see /customer-payments/meta/customers.
    api.get('/customer-payments/meta/customers').then(({ data }) => setCustomers(Array.isArray(data) ? data : [])).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const hasFilters = Object.values(applied).some(Boolean) || Object.values(form).some(Boolean);

  // Every payment with money still unapplied, as a workbook, under the filters the list is showing
  // -- pick a Location first to get one branch's. Uses `applied`, not `form`, so the file matches
  // the table on screen rather than a half-typed filter.
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  // Extract / Extract Unapplied: the same filters, two downloads -- every payment the list holds,
  // or just those with money still on account.
  async function exportUnapplied() { return runExport('unapplied'); }
  async function runExport(kind) {
    setExporting(kind); setExportError('');
    const params = {};
    if (applied.status) params.status = applied.status;
    if (applied.search) params.search = applied.search;
    if (applied.departmentId) params.department_id = applied.departmentId;
    if (applied.locationId) params.office_location_id = applied.locationId;
    if (applied.dateFrom) params.date_from = applied.dateFrom;
    if (applied.dateTo) params.date_to = applied.dateTo;
    try {
      const { data } = await api.get(kind === 'all' ? '/customer-payments/export' : '/customer-payments/export-unapplied', { params, responseType: 'blob' });
      const loc = locations.find((l) => String(l.id) === String(applied.locationId));
      const slug = loc ? `-${String(loc.location_name || loc.name).replace(/[^A-Za-z0-9]+/g, '-')}` : '';
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url; a.download = `${kind === 'all' ? 'customer-payments' : 'unapplied-customer-payments'}${slug}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setExportError(kind === 'all' ? 'Could not extract the payments.' : 'Could not extract the unapplied payments.');
    } finally {
      setExporting(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useAutoSearch(form.search, () => apply(form));
  return (
    <div>
      <div className="page-header">
        <h1>Customer Payments</h1>
        {can('/customer-payments', 'can_add') && (
          <EntityPicker
            label="Customer" items={customers} value="" getLabel={(c) => c?.name}
            columns={[{ key: 'customer_code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'list_address', label: 'Address', render: (c) => c.list_address || c.address || '' }]}
            searchKeys={['customer_code', 'name', 'list_address']}
            onSelect={(c) => setNewFor(c)}
            triggerLabel="Add Customer Payment"
            triggerClassName="btn btn-primary"
          />
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <SearchInput
              value={form.search} onChange={(e) => setField('search', e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && apply(form)}
              placeholder="CPAY #, OR #, SI#/BS#, Customer or Total Amount..."
            />
          </div>
          <div className="field">
            <label>Status</label>
            {/* A dropdown applies on pick -- there is nothing half-chosen about it, unlike a
                date being keyed in or a name being typed. */}
            <select value={form.status} onChange={(e) => apply({ ...form, status: e.target.value })}>
              <option value="">--ALL--</option>
              <option value="not_deposited">Not Deposited</option>
              <option value="deposited">Deposited</option>
              <option value="voided">Void</option>
              <option value="unapplied">Unapplied</option>
              <option value="applied">Applied</option>
            </select>
          </div>
          <div className="field">
            <label>Location</label>
            <FilterPicker label="Location" items={locations} value={form.locationId} onChange={(v) => apply({ ...form, locationId: v })}
              getLabel={(l) => l.location_name || l.name} allLabel="--ALL--" />
          </div>
          <div className="field">
            <label>Department</label>
            <FilterPicker label="Department" items={departments} value={form.departmentId} onChange={(v) => apply({ ...form, departmentId: v })}
              getLabel={(d) => d.name} allLabel="--ALL--" />
          </div>
          <div className="field">
            <label>Date From</label>
            <input
              type="date" value={form.dateFrom} max={form.dateTo || undefined}
              onChange={(e) => setField('dateFrom', e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && apply(form)}
            />
          </div>
          <div className="field">
            <label>Date To</label>
            <input
              type="date" value={form.dateTo} min={form.dateFrom || undefined}
              onChange={(e) => setField('dateTo', e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && apply(form)}
            />
          </div>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={() => apply(form)}>Search</button>
          {hasFilters && <button className="btn" onClick={() => apply(NO_FILTERS)}>Clear</button>}
          <button className="btn" disabled={!!exporting} onClick={() => runExport('all')}
            title="Download every payment under the filters above">
            {exporting === 'all' ? 'Extracting...' : 'Extract'}
          </button>
          <button className="btn" disabled={!!exporting} onClick={exportUnapplied}
            title="Download every payment with an unapplied amount, under the filters above">
            {exporting === 'unapplied' ? 'Extracting...' : 'Extract Unapplied'}
          </button>
          {exportError && <span style={{ color: 'var(--danger)' }}>{exportError}</span>}
          {/* The row count is the only way to tell "this department has no payments" apart from
              "the filter did not apply", now that the table shows ten rows either way. */}
          {!loading && <span className="muted">{total.toLocaleString()} payment{total === 1 ? '' : 's'} found</span>}
        </div>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Customer Payment No</th>
                  <th>Date Created</th>
                  <th>Customer</th>
                  <th>Location</th>
                  <th>Prepared By</th>
                  <th>Issued By</th>
                  <th>Payment Method</th>
                  <th>Receipt</th>
                  <th>OR/CR</th>
                  <th>PR</th>
                  <th>Applied Payment</th>
                  <th>Unapplied Payment</th>
                  <th>Total Amount</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={15} className="muted" style={{ textAlign: 'center', padding: 20 }}>No customer payments found.</td></tr>
                )}
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Customer Payment No">{row.customer_payment_no}</td>
                    <td data-label="Date Created">{formatDate(row.date_created)}</td>
                    <td data-label="Customer"><CustomerLink id={row.customer_id} name={row.customer_name} /></td>
                    <td data-label="Location">{row.office_location_name}</td>
                    <td data-label="Prepared By">{row.prepared_by_name}</td>
                    <td data-label="Issued By">{row.issued_by_name}</td>
                    <td data-label="Payment Method">{row.payment_method_name}</td>
                    <td data-label="Receipt">{receiptCode(row.receipt_type)}</td>
                    {/* One number per payment, shown under OR/CR or under PR by its receipt type -- the source's two columns. */}
                    <td data-label="OR/CR">{receiptCode(row.receipt_type) === 'PR' ? '' : row.or_no}</td>
                    <td data-label="PR">{receiptCode(row.receipt_type) === 'PR' ? row.or_no : ''}</td>
                    <td data-label="Applied Payment">{money(row.applied_amount)}</td>
                    <td data-label="Unapplied Payment">{money(row.unapplied_amount)}</td>
                    <td data-label="Total Amount">{money(row.payment_amount)}</td>
                    <td data-label="Status">{(STATUS_LABELS[row.status] || row.status || '').toUpperCase()}</td>
                    <td><Link className="btn btn-sm btn-primary" to={`/customer-payments/${row.id}`}>View</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} totalPages={totalPages} onChange={setPage} />
      </div>

      {/* The same form an invoice's Accept Payment button opens, entered from the customer end. */}
      {newFor && (
        <CustomerPaymentModal
          customerId={newFor.id}
          onClose={() => setNewFor(null)}
          // The new payment has the highest id and the list is newest-first, so it is on page 1.
          onSaved={() => { setNewFor(null); setPage(1); setRefreshKey((k) => k + 1); }}
        />
      )}
    </div>
  );
}
