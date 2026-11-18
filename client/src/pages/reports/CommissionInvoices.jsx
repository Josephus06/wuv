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
// Opens on this month, Period from: "As of" today is every invoice ever, which takes several seconds.
const blank = () => ({
  search: '', customer: '', type: '', status: '', salesRepId: '', divisionId: '', locationId: '',
  soDate: { filter: 'period from', d1: monthStart(), d2: today() }, docDate: { filter: 'as of', d1: today(), d2: today() },
});

// Accounting > Reports > Invoices (Commission) (2026-10-22): the source's #/commission-invoices -- each
// invoice raised from a Sales Order (with its delivery ticket), and each delivery ticket not yet
// invoiced, beside the SO's own amounts (shown once per SO).
export default function CommissionInvoices() {
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
    search: f.search || undefined, customer: f.customer || undefined, type: f.type || undefined, status: f.status || undefined,
    sales_rep_id: f.salesRepId || undefined, sales_division_id: f.divisionId || undefined, location_id: f.locationId || undefined,
    so_date_filter: f.soDate.filter, so_from: f.soDate.d1, so_to: f.soDate.d2,
    doc_date_filter: f.docDate.filter, doc_from: f.docDate.d1, doc_to: f.docDate.d2,
  });

  useEffect(() => {
    let live = true;
    setLoading(true); setError('');
    api.get('/reports/commission/invoices', { params: { ...params(applied), page, limit: PAGE_SIZE } })
      .then(({ data: d }) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e.response?.data?.error || 'Could not load the report.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [applied, page]); // eslint-disable-line react-hooks/exhaustive-deps

  function search() { setApplied({ ...form }); setPage(1); }
  async function download() {
    setDownloading(true);
    try { await downloadFile('/reports/commission/invoices', { ...params(applied), format: 'xlsx' }, 'Invoice-Report.xlsx'); }
    catch (e) { setError(e.response?.data?.error || 'Could not download the report.'); }
    setDownloading(false);
  }

  return (
    <div>
      <div className="page-header">
        <h1>Invoices (Commission)</h1>
        <button className="btn btn-primary" disabled={downloading || !data.total} onClick={download}>{downloading ? 'Preparing…' : 'Download'}</button>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <SearchInput placeholder="Search" value={form.search} onChange={(e) => set('search', e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') search(); }} />
          </div>
          <div className="field">
            <label>Customer</label>
            <input placeholder="Customer" value={form.customer} onChange={(e) => set('customer', e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') search(); }} />
          </div>
          <div className="field">
            <label>Type</label>
            <select value={form.type} onChange={(e) => set('type', e.target.value)}>
              <option value="">— All —</option><option value="bs">BS</option><option value="dr">DR</option>
            </select>
          </div>
          <div className="field">
            <label>Status</label>
            <select value={form.status} onChange={(e) => set('status', e.target.value)}>
              <option value="">— All —</option><option value="OPEN">OPEN</option><option value="PAID IN FULL">PAID IN FULL</option><option value="VOID">VOID</option>
            </select>
          </div>
          <DateFilter label="SO Date Created" value={form.soDate} onChange={(v) => set('soDate', v)} />
          <div className="field"><RepPicker reps={lk.reps} value={form.salesRepId} onChange={(v) => set('salesRepId', v)} /></div>
          <div className="field">
            <label>Sales Division</label>
            <select value={form.divisionId} onChange={(e) => set('divisionId', e.target.value)}>
              <option value="">— All —</option>
              {lk.divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Location</label>
            <select value={form.locationId} onChange={(e) => set('locationId', e.target.value)}>
              <option value="">— All —</option>
              {lk.locations.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
            </select>
          </div>
          <DateFilter label="DT/Invoice Date Created" value={form.docDate} onChange={(v) => set('docDate', v)} />
        </div>
        <button className="btn btn-primary" style={{ marginTop: 10 }} onClick={search}>Search</button>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <>
            <div className="muted" style={{ marginBottom: 8 }}>{data.total.toLocaleString()} row(s)</div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>SO No.</th><th>SO Date</th><th className="text-right">SO Net of Tax Amount</th><th className="text-right">SO Tax Amount</th><th className="text-right">SO Amount</th>
                    <th>DT No.</th><th>DT Date</th><th className="text-right">DT Amount</th><th>DT Status</th><th>Customer</th>
                    <th>Invoice No.</th><th>Invoice Date</th><th className="text-right">Net of Tax</th><th className="text-right">Tax Amount</th>
                    <th className="text-right">Total Amount</th><th className="text-right">Amount Due</th><th>Sales Rep.</th><th>Sales Division</th><th>Location</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r, i) => {
                    // The SO's own amounts once per SO, as on the source.
                    const first = i === 0 || data.rows[i - 1].so_no !== r.so_no;
                    return (
                      <tr key={`${r.so_no}-${r.invoice_no || ''}-${r.dt_no || ''}-${i}`}>
                        <td>{r.so_no}</td><td>{fmtDate(r.so_date)}</td>
                        <td className="text-right">{first ? money(r.so_net) : ''}</td><td className="text-right">{first ? money(r.so_tax) : ''}</td><td className="text-right">{first ? money(r.so_amount) : ''}</td>
                        <td>{r.dt_no}</td><td>{fmtDate(r.dt_date)}</td><td className="text-right">{money(r.dt_amount)}</td><td>{r.dt_status}</td>
                        <td><CustomerLink id={r.customer_id} name={r.customer_name} /></td>
                        <td>{r.invoice_id ? <Link to={`/sales-invoices/${r.invoice_id}`}>{r.invoice_no}</Link> : ''}</td><td>{fmtDate(r.invoice_date)}</td>
                        <td className="text-right">{money(r.invoice_net)}</td><td className="text-right">{money(r.invoice_tax)}</td>
                        <td className="text-right">{money(r.invoice_amount)}</td><td className="text-right">{money(r.amount_due)}</td>
                        <td>{r.sales_rep}</td><td>{r.sales_division}</td><td>{r.location_name}</td><td>{r.status_label}</td>
                      </tr>
                    );
                  })}
                  {!data.rows.length && <tr><td colSpan={20} className="muted" style={{ textAlign: 'center', padding: 16 }}>Nothing for these filters.</td></tr>}
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
