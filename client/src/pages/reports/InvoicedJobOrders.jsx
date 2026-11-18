import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import Pagination from '../../components/Pagination';
import SearchInput from '../../components/SearchInput';
import { CustomerLink } from '../../components/PartyLink';
import { downloadFile } from '../../utils/downloadFile';
import { DateFilter, RepPicker, fmtDate, monthStart, money, today, useLookups } from './CommissionCommon';

const PAGE_SIZE = 25;
// Opens on this month's invoices. Date Created and Need By Date start blank (no filter): "As of today"
// on Need By would quietly drop every JO due after today.
const blank = () => ({
  search: '', customer: '', status: '', salesRepId: '', divisionId: '', locationId: '', officeLocationId: '',
  created: { filter: 'as of', d1: '', d2: '' },
  need: { filter: 'as of', d1: '', d2: '' },
  invoice: { filter: 'period from', d1: monthStart(), d2: today() },
});

// Accounting > Reports > Invoiced Job Orders (2026-10-22): the source's #/invoiced-job-orders -- every
// invoice line that bills a Job Order -- with Invoice Date in place of its SO Date filter.
export default function InvoicedJobOrders() {
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
    search: f.search || undefined, customer: f.customer || undefined, status: f.status || undefined,
    sales_rep_id: f.salesRepId || undefined, sales_division_id: f.divisionId || undefined,
    location_id: f.locationId || undefined, office_location_id: f.officeLocationId || undefined,
    created_filter: f.created.filter, created_from: f.created.d1 || undefined, created_to: f.created.d2 || undefined,
    need_filter: f.need.filter, need_from: f.need.d1 || undefined, need_to: f.need.d2 || undefined,
    invoice_date_filter: f.invoice.filter, invoice_from: f.invoice.d1 || undefined, invoice_to: f.invoice.d2 || undefined,
  });

  useEffect(() => {
    let live = true;
    setLoading(true); setError('');
    api.get('/reports/invoiced-job-orders', { params: { ...params(applied), page, limit: PAGE_SIZE } })
      .then(({ data: d }) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e.response?.data?.error || 'Could not load the report.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [applied, page]); // eslint-disable-line react-hooks/exhaustive-deps

  function search() { setApplied({ ...form }); setPage(1); }
  async function download() {
    setDownloading(true);
    try { await downloadFile('/reports/invoiced-job-orders', { ...params(applied), format: 'xlsx' }, 'Invoiced-Job-Orders-Report.xlsx'); }
    catch (e) { setError(e.response?.data?.error || 'Could not download the report.'); }
    setDownloading(false);
  }

  const locationSelect = (key) => (
    <select value={form[key]} onChange={(e) => set(key, e.target.value)}>
      <option value="">— All —</option>
      {lk.locations.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
    </select>
  );

  return (
    <div>
      <div className="page-header">
        <h1>Invoiced Job Orders</h1>
        <button className="btn btn-primary" disabled={downloading || !data.total} onClick={download}>{downloading ? 'Preparing…' : 'Download'}</button>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        {/* Four even columns: who and where on the first two rows, the three dates (two columns
            each) below, then Search. */}
        <div className="report-filters">
          <div className="field">
            <label>General Searching</label>
            <SearchInput placeholder="Search" value={form.search} onChange={(e) => set('search', e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') search(); }} />
          </div>
          <div className="field">
            <label>Customer</label>
            <input placeholder="Customer" value={form.customer} onChange={(e) => set('customer', e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') search(); }} />
          </div>
          <div className="field">
            <label>Sales Division</label>
            <select value={form.divisionId} onChange={(e) => set('divisionId', e.target.value)}>
              <option value="">— All —</option>
              {lk.divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Sales Rep</label>
            <RepPicker reps={lk.reps} value={form.salesRepId} onChange={(v) => set('salesRepId', v)} />
          </div>
          <div className="field"><label>Location</label>{locationSelect('locationId')}</div>
          <div className="field"><label>Office Location</label>{locationSelect('officeLocationId')}</div>
          <div className="field">
            <label>Status</label>
            <select value={form.status} onChange={(e) => set('status', e.target.value)}>
              <option value="">— All —</option><option value="OPEN">OPEN</option><option value="PAID IN FULL">PAID IN FULL</option><option value="VOID">VOID</option>
            </select>
          </div>
          <div />
          <div className="span-2"><DateFilter label="Date Created" value={form.created} onChange={(v) => set('created', v)} /></div>
          <div className="span-2"><DateFilter label="Need By Date" value={form.need} onChange={(v) => set('need', v)} /></div>
          <div className="span-2"><DateFilter label="Invoice Date" value={form.invoice} onChange={(v) => set('invoice', v)} /></div>
          <div className="field" style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={search}>Search</button>
            <button className="btn" onClick={() => { const b = blank(); setForm(b); setApplied(b); setPage(1); }}>Clear</button>
          </div>
        </div>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <>
            <div className="muted" style={{ marginBottom: 8 }}>{data.total.toLocaleString()} row(s)</div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Invc #</th><th>Invc Date</th><th>SO #</th><th>SO Date</th><th>JO #</th><th>Sales Rep</th>
                    <th className="text-right">GP</th><th>Date Needed</th><th>Office Location</th><th>Location</th><th>Customer</th>
                    <th>Description</th><th>Contract Desc.</th><th className="text-right">Qty</th><th className="text-right">Rate</th>
                    <th className="text-right">Net of Tax</th><th className="text-right">Tax Amount</th><th className="text-right">Gross Amount</th>
                    <th>Status</th><th>Term</th><th>Department</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r, i) => (
                    <tr key={`${r.invoice_id}-${r.job_order_id}-${i}`}>
                      <td><Link to={`/sales-invoices/${r.invoice_id}`}>{r.invoice_no}</Link></td>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.invoice_date)}</td>
                      <td>
                        {/* Invoiced from a Delivery Ticket: the DT and its date stand in for the SO, as on the source. */}
                        {r.dt_id ? <Link to={`/delivery-tickets/${r.dt_id}`}>{r.so_no}</Link>
                          : r.so_id ? <Link to={`/sales-orders/${r.so_id}`}>{r.so_no}</Link>
                          : r.nsso_id ? <Link to={`/non-standard-sales-orders/${r.nsso_id}`}>{r.so_no}</Link> : r.so_no}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.so_date)}</td>
                      {/* An NSSO's job orders (NSJO-…) are job_orders rows too -- same view. */}
                      <td><Link to={`/job-orders/${r.job_order_id}`}>{r.job_order_no}</Link></td>
                      <td>{r.sales_rep}</td>
                      <td className="text-right">{r.gp_rate == null ? '' : `${Number(r.gp_rate).toFixed(2)}%`}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.date_needed)}</td>
                      <td>{r.office_location}</td><td>{r.location}</td>
                      <td><CustomerLink id={r.customer_id} name={r.customer_name} /></td>
                      <td style={{ minWidth: 220 }}>{r.description}</td>
                      <td style={{ minWidth: 220 }}>{r.contract_description}</td>
                      <td className="text-right">{money(r.quantity)}</td><td className="text-right">{money(r.rate)}</td>
                      <td className="text-right">{money(r.net_of_tax)}</td><td className="text-right">{money(r.tax_amount)}</td>
                      <td className="text-right">{money(r.gross_amount)}</td>
                      <td>{r.status_label}</td><td>{r.term}</td><td>{r.department}</td>
                    </tr>
                  ))}
                  {!data.rows.length && <tr><td colSpan={21} className="muted" style={{ textAlign: 'center', padding: 16 }}>Nothing for these filters.</td></tr>}
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
