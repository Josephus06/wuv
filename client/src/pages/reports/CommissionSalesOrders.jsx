import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import Pagination from '../../components/Pagination';
import SearchInput from '../../components/SearchInput';
import { CustomerLink } from '../../components/PartyLink';
import { downloadFile } from '../../utils/downloadFile';
import { DateFilter, RepPicker, fmtDate, money, today, useLookups } from './CommissionCommon';

const PAGE_SIZE = 25;
// The source's Status list, plus the stages it had no option for.
const STATUSES = [
  ['', ''], ['billed', 'BILLED'], ['partially_billed', 'PARTIALLY BILLED'],
  ['pending_billing_partially_delivered', 'PENDING BILLING / PARTIALLY DELIVERED'], ['pending_billing', 'PENDING BILLING'],
  ['partially_delivered', 'PARTIALLY DELIVERED'], ['pending_delivery', 'PENDING DELIVERY'], ['jo_in_process', 'JO IN-PROCESS'],
  ['pending_for_jo', 'PENDING FOR JO'], ['cancelled', 'CANCELLED'],
];
const blank = () => ({
  search: '', salesRepId: '', locationId: '', divisionId: '', customer: '', status: '',
  date: { filter: 'as of', d1: today(), d2: today() }, cancel: { filter: 'as of', d1: today(), d2: today() },
});

// Accounting > Reports > Sales Orders (Commission) (2026-10-22): the source's #/commission-sales-orders.
export default function CommissionSalesOrders() {
  const lk = useLookups();
  const [form, setForm] = useState(blank);
  const [applied, setApplied] = useState(blank);
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ rows: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const params = (f) => ({
    search: f.search || undefined, sales_rep_id: f.salesRepId || undefined, location_id: f.locationId || undefined,
    sales_division_id: f.divisionId || undefined, customer: f.customer || undefined, status: f.status || undefined,
    date_filter: f.date.filter, from: f.date.d1, to: f.date.d2,
    ...(f.status === 'cancelled' ? { cancel_filter: f.cancel.filter, cancel_from: f.cancel.d1, cancel_to: f.cancel.d2 } : {}),
  });

  useEffect(() => {
    let live = true;
    setLoading(true); setError('');
    api.get('/reports/commission/sales-orders', { params: { ...params(applied), page, limit: PAGE_SIZE } })
      .then(({ data: d }) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e.response?.data?.error || 'Could not load the report.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [applied, page]); // eslint-disable-line react-hooks/exhaustive-deps

  function search() { setApplied({ ...form }); setPage(1); }
  async function download() {
    setDownloading(true);
    try { await downloadFile('/reports/commission/sales-orders', { ...params(applied), format: 'xlsx' }, 'Sales-Order-Report.xlsx'); }
    catch (e) { setError(e.response?.data?.error || 'Could not download the report.'); }
    setDownloading(false);
  }
  const cancelled = applied.status === 'cancelled';

  return (
    <div>
      <div className="page-header">
        <h1>Sales Orders (Commission)</h1>
        <button className="btn btn-primary" disabled={downloading || !data.total} onClick={download}>{downloading ? 'Preparing…' : 'Download'}</button>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <SearchInput placeholder="Search" value={form.search} onChange={(e) => set('search', e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') search(); }} />
          </div>
          <div className="field"><RepPicker reps={lk.reps} value={form.salesRepId} onChange={(v) => set('salesRepId', v)} /></div>
          <div className="field">
            <label>Location</label>
            <select value={form.locationId} onChange={(e) => set('locationId', e.target.value)}>
              <option value="">— All —</option>
              {lk.locations.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Sales Division</label>
            <select value={form.divisionId} onChange={(e) => set('divisionId', e.target.value)}>
              <option value="">— All —</option>
              {lk.divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Customer</label>
            <input placeholder="Customer" value={form.customer} onChange={(e) => set('customer', e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') search(); }} />
          </div>
          <div className="field">
            <label>Status</label>
            <select value={form.status} onChange={(e) => set('status', e.target.value)}>
              {STATUSES.map(([k, l]) => <option key={k || 'all'} value={k}>{l || '— All —'}</option>)}
            </select>
          </div>
          <DateFilter label="Date Created" value={form.date} onChange={(v) => set('date', v)} />
          {form.status === 'cancelled' && <DateFilter label="Cancellation Date" value={form.cancel} onChange={(v) => set('cancel', v)} />}
        </div>
        <button className="btn btn-primary" style={{ marginTop: 10 }} onClick={search}>Search</button>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <>
            <div className="muted" style={{ marginBottom: 8 }}>{data.total.toLocaleString()} sales order(s)</div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Est. No.</th><th>Est. Date</th><th>Sale Order No.</th><th>Ref No.</th><th>PO No.</th><th>Date</th>
                    <th>Location</th><th>Sales Division</th><th>Customer</th><th>Sales Rep.</th><th>Prepared By</th>
                    <th className="text-right">Net of Tax</th><th className="text-right">Tax Amount</th><th className="text-right">Total Amount</th><th>Status</th>
                    {cancelled && <><th>Cancellation Date</th><th>Reason</th></>}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.estimate_no}</td><td>{fmtDate(r.estimate_date)}</td><td>{r.sales_order_no}</td><td>{r.ref_no}</td><td>{r.po_no}</td>
                      <td>{fmtDate(r.date_created)}</td><td>{r.location_name}</td><td>{r.sales_division}</td>
                      <td><CustomerLink id={r.customer_id} name={r.customer_name} /></td>
                      <td>{r.sales_rep}</td><td>{r.prepared_by}</td>
                      <td className="text-right">{money(r.net_of_tax)}</td><td className="text-right">{money(r.tax_amount)}</td><td className="text-right">{money(r.total_amount)}</td>
                      <td>{r.status_label}</td>
                      {cancelled && <><td>{fmtDate(r.cancelled_at)}</td><td>{r.cancel_reason}</td></>}
                      <td><Link className="btn btn-sm btn-primary" to={`/sales-orders/${r.id}`}>View</Link></td>
                    </tr>
                  ))}
                  {!data.rows.length && <tr><td colSpan={cancelled ? 18 : 16} className="muted" style={{ textAlign: 'center', padding: 16 }}>No sales orders.</td></tr>}
                </tbody>
              </table>
            </div>
            <Pagination page={page} totalPages={Math.max(1, Math.ceil(data.total / PAGE_SIZE))} onChange={setPage} />
          </>
        )}
      </div>
    </div>
  );
}
