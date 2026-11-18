import { useEffect, useState } from 'react';
import BirCompanyPicker from '../../components/BirCompanyPicker';
import api from '../../api/client';
import { SupplierLink } from '../../components/PartyLink';
import Pagination from '../../components/Pagination';
import LoadingSpinner from '../../components/LoadingSpinner';
import EntityPicker from '../../components/EntityPicker';
import SearchInput from '../../components/SearchInput';

const PAGE_SIZE = 25;
const NO_FILTERS = { search: '', supplierId: '', vat: '', dateFilter: 'period from', from: '', to: '' };

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
// A DATE column -- slice it rather than putting it through a Date, which would shift the day.
const day = (v) => (v ? String(v).slice(0, 10) : '');

// BIR Reports > Purchase Report -- one row per vendor bill, carrying the VAT split the filing
// needs. The live page offers only Supplier and a date range; there is no status or location
// filter there, and adding one here would make the two disagree about what a period contains.
// Only VAT12 and 0-VAT bills of suppliers with a TIN (2026-11-07) -- the server leaves the rest out.
export default function BirPurchaseReport() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [form, setForm] = useState(NO_FILTERS);
  const [applied, setApplied] = useState(NO_FILTERS);
  const [page, setPage] = useState(1);
  const [suppliers, setSuppliers] = useState([]);

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    api.get('/suppliers')
      .then(({ data }) => setSuppliers(Array.isArray(data) ? data : (data?.rows || [])))
      .catch(() => {});
  }, []);

  function queryParams(f) {
    return {
      search: f.search || undefined,
      supplier_id: f.supplierId || undefined,
      vat: f.vat || undefined,
      date_filter: f.dateFilter || undefined,
      from: f.from || undefined,
      to: f.to || undefined,
    };
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError('');
      try {
        const { data } = await api.get('/reports/bir/purchase', {
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
  }, [applied, page]);

  function search() {
    setApplied({ ...form });
    setPage(1);
  }

  async function download() {
    setDownloading(true);
    try {
      const res = await api.get('/reports/bir/purchase', {
        params: { ...queryParams(applied), format: 'csv' },
        responseType: 'blob',
      });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bir-purchase-report-${new Date().toISOString().slice(0, 10)}.csv`;
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
        <h1>Purchase Report</h1>
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
              label="Supplier" items={suppliers} value={form.supplierId}
              getLabel={(s) => s.name}
              columns={[{ key: 'supplier_code', label: 'Code' }, { key: 'name', label: 'Name' }]}
              searchKeys={['name', 'supplier_code']}
              placeholder="Supplier"
              onSelect={(s) => setField('supplierId', s ? s.id : '')}
              onClear={() => setField('supplierId', '')}
            />
          </div>
          <div className="field">
            <label>Tax Code</label>
            <select value={form.vat} onChange={(e) => setField('vat', e.target.value)}>
              <option value="">VAT12 and 0-VAT</option>
              <option value="VAT12">VAT12</option>
              <option value="0-VAT">0-VAT</option>
            </select>
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
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          VAT12 and 0-VAT purchases from suppliers with a TIN only. A supplier with no TIN is left out -- add it on the supplier to include their bills.
        </div>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Vendor Bill No</th>
                    <th>Created From</th>
                    <th>Reference No</th>
                    <th>Date Created</th>
                    <th>Vendor</th>
                    <th>Tax Code</th>
                    <th className="text-right">Net of Tax</th>
                    <th className="text-right">Tax Amount</th>
                    <th className="text-right">Total Amount</th>
                    <th className="text-right">Withholding Tax Amount</th>
                    <th className="text-right">Net Amount</th>
                    <th>Supplier TIN</th>
                    <th>Supplier Address</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={13} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                        No vendor bills match this filter.
                      </td>
                    </tr>
                  )}
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.bill_no}</td>
                      <td>{r.created_from}</td>
                      <td>{r.reference_no}</td>
                      <td>{day(r.date_created)}</td>
                      <td><SupplierLink id={r.supplier_id} name={r.supplier_name} /></td>
                      <td>{r.tax_code}</td>
                      <td className="text-right">{money(r.net_of_tax)}</td>
                      <td className="text-right">{money(r.tax_amount)}</td>
                      <td className="text-right">{money(r.total_amount)}</td>
                      <td className="text-right">{money(r.wtax_amount)}</td>
                      <td className="text-right">{money(r.net_amount)}</td>
                      <td>{r.supplier_tin}</td>
                      <td>{r.supplier_address}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
              <span className="muted">{total.toLocaleString()} bill{total === 1 ? '' : 's'}</span>
              <Pagination page={page} totalPages={totalPages} onChange={setPage} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
