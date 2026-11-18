import { useEffect, useState } from 'react';
import BirCompanyPicker from '../../components/BirCompanyPicker';
import api from '../../api/client';
import { headOfficeLocationId } from '../../utils/useHeadOffice';
import { CustomerLink } from '../../components/PartyLink';
import Pagination from '../../components/Pagination';
import LoadingSpinner from '../../components/LoadingSpinner';
import EntityPicker from '../../components/EntityPicker';
import SearchInput from '../../components/SearchInput';

const PAGE_SIZE = 25;
const NO_FILTERS = {
  search: '', customerId: '', locationId: '', status: '',
  dateFilter: 'period from', from: '', to: '',
};

// The live page's Status dropdown, verbatim. Applied/Unapplied and Deposited/Not Deposited ask
// two different questions about the same payment; the server maps each onto the column that
// answers it (see routes/birReports.js).
const STATUSES = ['APPLIED', 'UNAPPLIED', 'DEPOSITED', 'NOT DEPOSITED', 'VOID'];

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
// date_created is a DATE column, so it carries no time and no timezone -- slice it rather than
// putting it through a Date, which would shift it a day in any zone behind UTC.
const day = (v) => (v ? String(v).slice(0, 10) : '');

// BIR Reports > Sales Report -- one row per customer payment, with the OR number and the
// customer's tax identity beside it. Mirrors the live page column for column.
export default function BirSalesReport() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  // Two copies of the filters, same reason as the Customer Payments list: `form` is what the
  // controls show as they are typed, `applied` is what the last fetch used. Without the split
  // every keystroke would be a query against 130,000 payments.
  const [form, setForm] = useState(NO_FILTERS);
  const [applied, setApplied] = useState(NO_FILTERS);
  const [page, setPage] = useState(1);
  const [customers, setCustomers] = useState([]);
  const [locations, setLocations] = useState([]);

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    const pick = (d) => (Array.isArray(d) ? d : (d?.rows || []));
    api.get('/customers').then(({ data }) => setCustomers(pick(data))).catch(() => {});
    api.get('/lookups/locations').then(({ data }) => setLocations(pick(data))).catch(() => {});
  }, []);

  function queryParams(f) {
    return {
      search: f.search || undefined,
      customer_id: f.customerId || undefined,
      location_id: f.locationId || undefined,
      status: f.status || undefined,
      date_filter: f.dateFilter || undefined,
      from: f.from || undefined,
      to: f.to || undefined,
    };
  }

  // Location starts on Head Office (2026-10-14; utils/useHeadOffice); the report waits for it.
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
      setLoading(true); setError('');
      try {
        const { data } = await api.get('/reports/bir/sales', {
          params: { ...queryParams(applied), page, limit: PAGE_SIZE },
        });
        if (cancelled) return;
        setRows(data.rows || []);
        setTotal(data.total || 0);
      } catch (e) {
        if (!cancelled) setError(e.response?.data?.error || 'Could not load the report.');
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [applied, page, hoReady]);

  // Applying a filter always returns to page 1 -- page 40 of "all" is not page 40 of "VOID".
  function search() {
    setApplied({ ...form });
    setPage(1);
  }

  async function download() {
    setDownloading(true);
    try {
      const res = await api.get('/reports/bir/sales', {
        params: { ...queryParams(applied), format: 'csv' },
        responseType: 'blob',
      });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bir-sales-report-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not download the report.');
    }
    setDownloading(false);
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div className="page-header">
        <h1>Sales Report</h1>
        <BirCompanyPicker />
        <button className="btn btn-primary" disabled={downloading || !total} onClick={download}>
          {downloading ? 'Preparing…' : 'Download CSV'}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <SearchInput
              placeholder="Search" value={form.search}
              onChange={(e) => setField('search', e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
            />
          </div>
          <div className="field">
            <EntityPicker
              label="Customer" items={customers} value={form.customerId}
              getLabel={(c) => c.name}
              columns={[{ key: 'customer_code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'list_address', label: 'Address', render: (c) => c.list_address || c.address || '' }]}
              searchKeys={['name', 'customer_code', 'list_address']}
              placeholder="Customer"
              onSelect={(c) => setField('customerId', c ? c.id : '')}
              onClear={() => setField('customerId', '')}
            />
          </div>
          <div className="field">
            <label>Status</label>
            <select value={form.status} onChange={(e) => setField('status', e.target.value)}>
              <option value="">All</option>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="field">
            <EntityPicker
              label="Location" items={locations} value={form.locationId}
              getLabel={(l) => l.location_name}
              columns={[{ key: 'location_code', label: 'Code' }, { key: 'location_name', label: 'Name' }]}
              searchKeys={['location_name', 'location_code']}
              placeholder="Location"
              onSelect={(l) => setField('locationId', l ? l.id : '')}
              onClear={() => setField('locationId', '')}
            />
          </div>
          <div className="field">
            <label>Date Created</label>
            <select value={form.dateFilter} onChange={(e) => setField('dateFilter', e.target.value)}>
              <option value="as of">As of</option>
              <option value="period from">Period from</option>
            </select>
          </div>
          {form.dateFilter === 'period from' && (
            <div className="field">
              <label>From</label>
              <input type="date" value={form.from} onChange={(e) => setField('from', e.target.value)} />
            </div>
          )}
          <div className="field">
            <label>{form.dateFilter === 'as of' ? 'As of' : 'To'}</label>
            <input type="date" value={form.to} onChange={(e) => setField('to', e.target.value)} />
          </div>
          <div className="field" style={{ alignSelf: 'end' }}>
            <button className="btn btn-primary" onClick={search}>Search</button>
          </div>
        </div>
        {/* 2026-11-07: the server lists only VAT12 / zero-rated receipts (routes/birReports.js /sales). */}
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          VAT12 and zero-rated (ZRATE) sales only: each payment at the part applied to VAT12 / ZRATE invoices.
          0-VAT, VAT-exempt, Delivery Receipts and unapplied balances are left out.
        </div>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Customer Payment No</th>
                    <th>Date Created</th>
                    <th>Customer</th>
                    <th>Location</th>
                    <th>OR</th>
                    <th className="text-right">Total Amount</th>
                    <th>Customer Tax Code</th>
                    <th>Customer TIN</th>
                    <th>Customer Address</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                        No payments match this filter.
                      </td>
                    </tr>
                  )}
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.customer_payment_no}</td>
                      <td>{day(r.date_created)}</td>
                      <td><CustomerLink id={r.customer_id} name={r.customer_name} /></td>
                      <td>{r.location_name}</td>
                      <td>{r.or_no}</td>
                      <td className="text-right">{money(r.total_amount)}</td>
                      <td>{r.customer_tax_code}</td>
                      <td>{r.customer_tin}</td>
                      <td>{r.customer_address}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
              <span className="muted">{total.toLocaleString()} payment{total === 1 ? '' : 's'}</span>
              <Pagination page={page} totalPages={totalPages} onChange={setPage} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
