import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import EntityPicker from '../components/EntityPicker';
import { SupplierLink } from '../components/PartyLink';
import { displayDate } from '../utils/dates';
import useAutoSearch from '../utils/useAutoSearch';
import SearchInput from '../components/SearchInput';

const PAGE_SIZE = 15;
const STATUS_LABELS = { open: 'Open', posted: 'Posted', voided: 'Voided' };

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? displayDate(String(v).slice(0, 10)) : ''; }

// The same filters and figures as the Cheque list (pages/Cheques.jsx), asked for 2026-10-02: a
// Vendor (every supplier with payments, inactive included), Released / Not Released, a date period,
// and Issued / Released / Not Released totals over everything the filters return. Newest first.
export default function BillPayments() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [vendors, setVendors] = useState([]);
  const [vendor, setVendor] = useState(null);
  const [released, setReleased] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [asOf, setAsOf] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => { api.get('/bill-payments/payees').then(({ data }) => setVendors(data)).catch(() => setVendors([])); }, []);

  function listParams() {
    const params = {};
    if (status) params.status = status;
    if (search) params.search = search;
    if (vendor) params.supplier_id = vendor.id;
    if (released) params.released = released;
    if (dateFrom) params.date_from = dateFrom;
    if (asOf) params.as_of = asOf;
    return params;
  }

  // Extract: every row under the filters above, as a workbook (same params as the list).
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  async function runExport() {
    setExporting(true); setExportError('');
    try {
      const { data } = await api.get('/bill-payments/export', { params: listParams(), responseType: 'blob' });
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url; a.download = 'bill-payments.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setExportError('Could not extract the bill payments.');
    } finally {
      setExporting(false);
    }
  }

  async function load() {
    setLoading(true);
    const params = listParams();
    const { data } = await api.get('/bill-payments', { params });
    setRows(data);
    setLoading(false);
  }

  useEffect(() => { setPage(1); load(); }, [status, vendor, released]); // eslint-disable-line react-hooks/exhaustive-deps

  function runSearch() {
    setPage(1);
    load();
  }
  useAutoSearch(search, runSearch);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  // Voided payments were never paid, so they count toward none of the totals.
  const live = rows.filter((r) => r.status !== 'voided');
  const sum = (list) => list.reduce((s, r) => s + Number(r.total_amount || 0), 0);
  const isReleased = live.filter((r) => r.date_released); const notReleased = live.filter((r) => !r.date_released);

  return (
    <div>
      <div className="page-header">
        <h1>Bill Payments</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="Payment #, Vendor, Payee, Check #, Reference or Memo..." />
          </div>
          <div className="field">
            <label>Vendor</label>
            <EntityPicker
              label="Vendor" items={vendors} value={vendor?.id || ''} getLabel={(v) => v.name}
              columns={[{ key: 'name', label: 'Name' }, { key: 'payments', label: 'Payments' }]}
              searchKeys={['name']} placeholder="All vendors..."
              onSelect={(v) => setVendor(v)} onClear={() => setVendor(null)}
            />
          </div>
          <div className="field">
            <label>Released</label>
            <select value={released} onChange={(e) => setReleased(e.target.value)}>
              <option value="">--ALL--</option>
              <option value="released">Released</option>
              <option value="not_released">Not Released</option>
            </select>
          </div>
          <div className="field">
            <label>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">--ALL--</option>
              <option value="open">Open</option>
              <option value="voided">Voided</option>
            </select>
          </div>
          <div className="field">
            <label>Period From</label>
            <input type="date" value={dateFrom} max={asOf || undefined} onChange={(e) => setDateFrom(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} />
          </div>
          <div className="field">
            <label>As of Date</label>
            <input type="date" value={asOf} min={dateFrom || undefined} onChange={(e) => setAsOf(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} />
          </div>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={runSearch}>Search</button>
          <button className="btn" disabled={exporting} onClick={runExport} title="Download every bill payment under the filters above">
            {exporting ? 'Extracting...' : 'Extract'}
          </button>
          {exportError && <span style={{ color: 'var(--danger)' }}>{exportError}</span>}
        </div>
      </div>

      {!loading && (
        <div className="card" style={{ marginBottom: 16, display: 'flex', gap: 32, flexWrap: 'wrap' }}>
          {vendor && <div><div className="muted">Vendor</div><div className="hi" style={{ fontWeight: 600 }}>{vendor.name}</div></div>}
          {[['Issued', live], ['Released', isReleased], ['Not Released', notReleased]].map(([label, list]) => (
            <div key={label}>
              <div className="muted">{label}</div>
              <div style={{ fontWeight: 600 }}>{list.length} payment{list.length === 1 ? '' : 's'} · {money(sum(list))}</div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Payment #</th><th>Date</th><th>Memo</th><th>Check #</th><th>Vendor</th><th>Account</th><th>Payment Method</th>
                  <th style={{ textAlign: 'right' }}>Total Amount</th><th>Released</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={11} className="muted" style={{ textAlign: 'center', padding: 20 }}>No payments found.</td></tr>
                )}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Payment #">{row.bill_payment_no}</td>
                    <td data-label="Date">{formatDate(row.date_created)}</td>
                    <td data-label="Memo" style={{ whiteSpace: 'normal', maxWidth: 280 }}>{row.memo || ''}</td>
                    <td data-label="Check #">{row.check_no || ''}</td>
                    <td data-label="Vendor">{row.supplier_name ? <SupplierLink id={row.supplier_id} name={row.supplier_name} /> : row.payee_name}</td>
                    <td data-label="Account">{row.bank_account_name || ''}</td>
                    <td data-label="Payment Method">{row.payment_method_name}</td>
                    <td data-label="Total Amount" style={{ textAlign: 'right' }}>{money(row.total_amount)}</td>
                    <td data-label="Released">{row.date_released ? formatDate(row.date_released) : <span className="muted">Not released</span>}</td>
                    <td data-label="Status">{STATUS_LABELS[row.status] || row.status}</td>
                    <td><Link className="btn btn-sm btn-primary" to={`/bill-payments/${row.id}`}>View</Link></td>
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
