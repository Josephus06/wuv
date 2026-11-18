import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import EntityPicker from '../components/EntityPicker';
import { CustomerLink, SupplierLink } from '../components/PartyLink';
import { displayDate } from '../utils/dates';
import useAutoSearch from '../utils/useAutoSearch';
import SearchInput from '../components/SearchInput';

// The Payee opens its Master List record when it is a supplier or a customer; an employee (or a
// cheque with no linked payee) stays plain text.
function PayeeLink({ type, id, name }) {
  if (['VENDOR', 'supplier'].includes(type)) return <SupplierLink id={id} name={name} />;
  if (['CUSTOMER', 'customer'].includes(type)) return <CustomerLink id={id} name={name} />;
  return <>{name}</>;
}

const PAGE_SIZE = 15;
const STATUS_LABELS = { open: 'Open', fully_applied: 'Fully Applied', void: 'Void' };
const PAYEE_TYPES = [{ v: 'VENDOR', l: 'Supplier' }, { v: 'EMPLOYEE', l: 'Employee' }, { v: 'CUSTOMER', l: 'Customer' }];
function money(v) { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'; }
function formatDate(v) { return v ? displayDate(v) : ''; }

export default function Cheques() {
  const { can } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  // Period From / As of Date: inclusive bounds on Date Created, applied on Search.
  const [dateFrom, setDateFrom] = useState('');
  const [asOf, setAsOf] = useState('');
  // Payee (a supplier / employee / customer -- every one that has cheques, inactive included) and
  // whether the cheque has been released, so all cheques issued to one payee, released or still in
  // hand, can be read off together with their totals.
  const [payees, setPayees] = useState([]);
  const [payeeType, setPayeeType] = useState('');
  const [payee, setPayee] = useState(null);
  const [released, setReleased] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => { api.get('/cheques/payees').then(({ data }) => setPayees(data)).catch(() => setPayees([])); }, []);

  function listParams() {
    const params = {};
    if (search) params.search = search;
    if (status) params.status = status;
    if (dateFrom) params.date_from = dateFrom;
    if (asOf) params.as_of = asOf;
    if (payeeType) params.payee_type = payeeType;
    if (payee) { params.payee_type = payee.payee_type; params.payee_id = payee.payee_id; }
    if (released) params.released = released;
    return params;
  }

  // Extract: every row under the filters above, as a workbook (same params as the list).
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  async function runExport() {
    setExporting(true); setExportError('');
    try {
      const { data } = await api.get('/cheques/export', { params: listParams(), responseType: 'blob' });
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url; a.download = 'cheques.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setExportError('Could not extract the cheques.');
    } finally {
      setExporting(false);
    }
  }

  async function load() {
    setLoading(true);
    const params = listParams();
    const { data } = await api.get('/cheques', { params });
    setRows(data);
    setLoading(false);
  }

  useEffect(() => { setPage(1); load(); }, [status, payeeType, payee, released]); // eslint-disable-line react-hooks/exhaustive-deps
  function runSearch() { setPage(1); load(); }
  useAutoSearch(search, runSearch);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  // Totals over everything the filters return (not just this page). Void cheques were never paid,
  // so they count toward none of the three.
  const live = rows.filter((r) => r.status !== 'void');
  const sum = (list) => list.reduce((s, r) => s + Number(r.total_amount || 0), 0);
  const issued = live; const isReleased = live.filter((r) => r.date_released); const notReleased = live.filter((r) => !r.date_released);
  const payeeOptions = payeeType ? payees.filter((p) => p.payee_type === payeeType) : payees;
  const typeLabel = (t) => PAYEE_TYPES.find((x) => x.v === t)?.l || '';

  return (
    <div>
      <div className="page-header">
        <h1>Saved Cheques</h1>
        {can('/cheques', 'can_add') && <Link className="btn btn-primary" to="/cheques/new">Add New</Link>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="Cheque No, Payee, Cheque # or Memo..." />
          </div>
          <div className="field">
            <label>Payee Type</label>
            <select value={payeeType} onChange={(e) => { setPayeeType(e.target.value); setPayee(null); }}>
              <option value="">--ALL--</option>
              {PAYEE_TYPES.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Payee</label>
            <EntityPicker
              label="Payee" items={payeeOptions.map((p) => ({ ...p, id: `${p.payee_type}-${p.payee_id}` }))}
              value={payee ? `${payee.payee_type}-${payee.payee_id}` : ''} getLabel={(p) => p.name}
              columns={[{ key: 'name', label: 'Name' }, { key: 'type', label: 'Type', render: (p) => typeLabel(p.payee_type) }, { key: 'cheques', label: 'Cheques' }]}
              searchKeys={['name']} placeholder="All payees..."
              onSelect={(p) => setPayee(p)} onClear={() => setPayee(null)}
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
              <option value="fully_applied">Fully Applied</option>
              <option value="void">Void</option>
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
          <button className="btn" disabled={exporting} onClick={runExport} title="Download every cheque under the filters above">
            {exporting ? 'Extracting...' : 'Extract'}
          </button>
          {exportError && <span style={{ color: 'var(--danger)' }}>{exportError}</span>}
        </div>
      </div>

      {!loading && (
        <div className="card" style={{ marginBottom: 16, display: 'flex', gap: 32, flexWrap: 'wrap' }}>
          {payee && <div><div className="muted">Payee</div><div className="hi" style={{ fontWeight: 600 }}>{payee.name} ({typeLabel(payee.payee_type)})</div></div>}
          {[['Issued', issued], ['Released', isReleased], ['Not Released', notReleased]].map(([label, list]) => (
            <div key={label}>
              <div className="muted">{label}</div>
              <div style={{ fontWeight: 600 }}>{list.length} cheque{list.length === 1 ? '' : 's'} · {money(sum(list))}</div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr><th>Cheque No</th><th>Date</th><th>Cheque #</th><th>Payee</th><th>Account</th><th style={{ textAlign: 'right' }}>Total</th><th>Released</th><th>Status</th><th>Memo</th><th></th></tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 20 }}>No cheques found.</td></tr>}
                {pageRows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Cheque No">{row.cheque_no}</td>
                    <td data-label="Date">{formatDate(row.date_created)}</td>
                    <td data-label="Cheque #">{row.cheque_number}</td>
                    <td data-label="Payee"><PayeeLink type={row.payee_type} id={row.payee_id} name={row.payee_account_name || row.payee_name} /></td>
                    <td data-label="Account">{row.account_name}</td>
                    <td data-label="Total" style={{ textAlign: 'right' }}>{money(row.total_amount)}</td>
                    <td data-label="Released">{row.date_released ? formatDate(row.date_released) : <span className="muted">Not released</span>}</td>
                    <td data-label="Status">{STATUS_LABELS[row.status] || row.status}</td>
                    {/* Memo right after Status (asked 2026-10-06; it had taken the Cheque Date column's place). */}
                    <td data-label="Memo" style={{ whiteSpace: 'normal', maxWidth: 320 }}>{row.memo || ''}</td>
                    <td><Link className="btn btn-sm btn-primary" to={`/cheques/${row.id}`}>View</Link></td>
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
