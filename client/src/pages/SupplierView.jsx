import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import DataTable from '../components/DataTable';

import { displayDate, displayAuditTime } from '../utils/dates';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
}

function formatDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : displayDate(d);
}

// Where each kind of document on the ledger opens. Kept beside the ledger rather than derived from
// the document number, because the number's prefix is data from the live system and the route is
// this app's own -- reading one off the other would break the day a prefix is renamed.
const DOC_ROUTE = {
  PO: (r) => `/purchase-orders/${r.doc_id}`,
  RR: (r) => `/receiving-reports/${r.doc_id}`,
  VB: (r) => `/vendor-bills/${r.doc_id}`,
  BPAY: (r) => `/bill-payments/${r.doc_id}`,
};

const DOC_LABEL = { PO: 'Purchase Order', RR: 'Receiving Report', VB: 'Vendor Bill', BPAY: 'Bill Payment' };

const PAGE_SIZE = 20;

// The supplier's own page: who they are, how they are paid, and every document they appear on.
//
// The Transactions tab is the point of it. A supplier's history is spread across four documents --
// the order, what arrived, what was billed and what was paid -- and answering "what happened with
// this supplier" used to mean opening four modules and filtering each by hand. Here it is one
// list, newest first, straight from GET /suppliers/:id/transactions.
//
// Tabs that exist on the live screen and NOT here -- Financial and Preferences -- are left out
// rather than stubbed: nothing in this schema backs them, and an empty tab claiming to hold
// financial settings is worse than no tab. Birthdate, Gender, Supplier Type, Credit Limit and Tax
// Code are absent from the header for the same reason: `suppliers` has no such columns.
export default function SupplierView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [supplier, setSupplier] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [tab, setTab] = useState('transactions');
  // Who changed what on this supplier (2026-10-19), loaded when System Information is opened.
  const [auditLogs, setAuditLogs] = useState([]);
  useEffect(() => {
    if (tab === 'system') api.get(`/suppliers/${id}/audit-logs`).then(({ data }) => setAuditLogs(data || [])).catch(() => setAuditLogs([]));
  }, [tab, id]);

  const [ledger, setLedger] = useState({ rows: [], total: 0 });
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [page, setPage] = useState(1);
  // Mirrors the filter row under the column headings on the live screen. `as_of` is the one that
  // changes what the list means rather than just narrowing it -- "where did this supplier stand on
  // that date" -- so it sits under the Date column and defaults to today.
  const [filters, setFilters] = useState({
    doc_no: '', doc_type: '', status: '', reference_no: '', memo: '',
    as_of: new Date().toISOString().slice(0, 10), date_from: '',
  });
  // As of: up to the date. Period from: date_from .. as_of (2026-11-11), as on Sales Orders.
  const [dateMode, setDateMode] = useState('as of');

  useEffect(() => {
    api.get(`/suppliers/${id}`)
      .then(({ data }) => setSupplier(data))
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [id]);

  const loadLedger = useCallback(() => {
    setLedgerLoading(true);
    const params = { page, limit: PAGE_SIZE };
    Object.entries(filters).forEach(([k, v]) => { if (v) params[k] = v; });
    if (dateMode !== 'period from') delete params.date_from;
    api.get(`/suppliers/${id}/transactions`, { params })
      .then(({ data }) => setLedger(data))
      .catch(() => setLedger({ rows: [], total: 0 }))
      .finally(() => setLedgerLoading(false));
  }, [id, page, filters, dateMode]);

  useEffect(() => { if (tab === 'transactions') loadLedger(); }, [tab, loadLedger]);

  // Any filter change returns to page 1 -- staying on page 14 of a list that now has two pages
  // shows an empty table and reads as "no results" rather than "you are past the end".
  function setFilter(key, value) {
    setPage(1);
    setFilters((f) => ({ ...f, [key]: value }));
  }

  if (loading) return <LoadingSpinner />;
  if (notFound || !supplier) return <div className="empty-state">Supplier not found.</div>;

  const pages = Math.max(1, Math.ceil(ledger.total / PAGE_SIZE));
  // A blank credit limit means none has been agreed, which is not the same as a limit of zero --
  // so "remaining" is only shown once a figure has actually been set. It can go negative, and it
  // is left negative on purpose: a supplier already past their limit is the case worth seeing.
  const creditLimit = supplier.credit_limit === null || supplier.credit_limit === undefined || supplier.credit_limit === ''
    ? null : Number(supplier.credit_limit);
  const hasLimit = creditLimit !== null && Number.isFinite(creditLimit) && creditLimit > 0;
  const remainingCredit = hasLimit ? creditLimit - Number(supplier.balance || 0) : null;
  const contacts = supplier.contacts || [];
  const addresses = supplier.addresses || [];
  const items = supplier.items || [];

  return (
    <div>
      <div className="page-header">
        <div />
        <Link className="btn btn-sm" to={'/suppliers'}>Back</Link>
      </div>

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>{supplier.name}</h1>
          <span className="estimate-no">{supplier.supplier_code || '—'}</span>
        </div>
        <div className="estimate-status">
          {supplier.company_name || ''}
          {!supplier.is_active && <span style={{ opacity: 0.7 }}> · Inactive</span>}
        </div>
        <div className="estimate-detail-grid">
          <div>
            <div>Address : <span className="hi">{supplier.address || '—'}</span></div>
            <div>TIN : <span className="hi">{supplier.tin || '—'}</span></div>
          </div>
          <div>
            <div>Contact No : <span className="hi">{supplier.contact_no || supplier.mobile_no || '—'}</span></div>
            <div>Email : <span className="hi">{supplier.email || '—'}</span></div>
          </div>
          <div>
            <div>Credit Term : <span className="hi">{supplier.payment_term_name || supplier.credit_term || '—'}</span></div>
            {/* What is still owed, not what has ever been spent -- read off the bills' own
                remaining Amount Due, the same figure the Bill Payment screen pays against. */}
            <div>Balance : <span className="hi">{money(supplier.balance)}</span></div>
          </div>
          <div>
            <div>Credit Limit : <span className="hi">{hasLimit ? money(creditLimit) : 'Not set'}</span></div>
            {hasLimit && (
              <div>
                Remaining :{' '}
                <span className="hi" style={remainingCredit < 0 ? { color: 'var(--color-danger-text, #b91c1c)' } : undefined}>
                  {money(remainingCredit)}
                </span>
                {remainingCredit < 0 && <span className="muted" style={{ fontSize: 12 }}> · over limit</span>}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'transactions' ? 'active' : ''}`} onClick={() => setTab('transactions')}>Transactions</button>
        <button className={`status-tab ${tab === 'contacts' ? 'active' : ''}`} onClick={() => setTab('contacts')}>Contact Persons ({contacts.length})</button>
        <button className={`status-tab ${tab === 'addresses' ? 'active' : ''}`} onClick={() => setTab('addresses')}>Shipping Addresses ({addresses.length})</button>
        <button className={`status-tab ${tab === 'bank' ? 'active' : ''}`} onClick={() => setTab('bank')}>Bank</button>
        <button className={`status-tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>Items ({items.length})</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Information</button>
      </div>

      {tab === 'transactions' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Transaction #</th><th>Type</th><th>Date</th><th>Status</th>
                  <th>Reference #</th><th>Memo</th><th style={{ textAlign: 'right' }}>Amount</th>
                </tr>
                <tr>
                  <th><input style={{ width: 110 }} value={filters.doc_no} onChange={(e) => setFilter('doc_no', e.target.value)} /></th>
                  <th>
                    <select value={filters.doc_type} onChange={(e) => setFilter('doc_type', e.target.value)}>
                      <option value="">All</option>
                      {Object.entries(DOC_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </th>
                  <th>
                    {/* Fixed widths: a header-row select/input otherwise stretches to the cell and the
                        date boxes spill into the next column. */}
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400, whiteSpace: 'nowrap' }}>
                      <select value={dateMode} style={{ width: 120, flex: '0 0 120px' }} onChange={(e) => { setDateMode(e.target.value); setPage(1); }}>
                        <option value="as of">As of</option>
                        <option value="period from">Period from</option>
                      </select>
                      {dateMode === 'period from' && (
                        <>
                          <input type="date" style={{ width: 140, flex: '0 0 140px' }} value={filters.date_from} onChange={(e) => setFilter('date_from', e.target.value)} title="From" />
                          <span className="muted">to</span>
                        </>
                      )}
                      <input type="date" style={{ width: 140, flex: '0 0 140px' }} value={filters.as_of} onChange={(e) => setFilter('as_of', e.target.value)}
                        title={dateMode === 'period from' ? 'To' : 'As of'} />
                    </div>
                  </th>
                  <th><input style={{ width: 100 }} value={filters.status} onChange={(e) => setFilter('status', e.target.value)} /></th>
                  <th><input style={{ width: 120 }} value={filters.reference_no} onChange={(e) => setFilter('reference_no', e.target.value)} /></th>
                  <th><input style={{ width: 140 }} value={filters.memo} onChange={(e) => setFilter('memo', e.target.value)} /></th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ledgerLoading && (
                  <tr><td colSpan={7} style={{ textAlign: 'center', padding: 20 }}><LoadingSpinner inline label="Loading..." size="sm" /></td></tr>
                )}
                {!ledgerLoading && ledger.rows.length === 0 && (
                  <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No transactions for this supplier.</td></tr>
                )}
                {!ledgerLoading && ledger.rows.map((r) => (
                  <tr key={`${r.doc_type}-${r.doc_id}`}>
                    <td><Link to={DOC_ROUTE[r.doc_type](r)}>{r.doc_no}</Link></td>
                    <td>{DOC_LABEL[r.doc_type] || r.doc_type}</td>
                    <td>{formatDate(r.doc_date)}</td>
                    <td>{r.status || '—'}</td>
                    <td>{r.reference_no || '—'}</td>
                    <td>{r.memo || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{money(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
            <span className="muted">
              {ledger.total} transaction{ledger.total === 1 ? '' : 's'}
              {ledger.total > 0 && ` · page ${page} of ${pages}`}
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(1)}>{'<<'}</button>
              <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
              <button className="btn btn-sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</button>
              <button className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(pages)}>{'>>'}</button>
            </div>
          </div>
        </div>
      )}

      {tab === 'contacts' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Title</th><th>Email</th><th>Phone</th></tr></thead>
              <tbody>
                {contacts.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No contact persons yet.</td></tr>}
                {contacts.map((c) => (
                  <tr key={c.id}>
                    <td>{c.contact_name}{c.is_primary ? ' ★' : ''}</td>
                    <td>{c.title || '—'}</td><td>{c.email || '—'}</td><td>{c.phone || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'addresses' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Address</th><th>Default</th></tr></thead>
              <tbody>
                {addresses.length === 0 && <tr><td colSpan={2} className="muted" style={{ textAlign: 'center', padding: 20 }}>No shipping addresses yet.</td></tr>}
                {addresses.map((a) => (
                  <tr key={a.id}><td>{a.address_line}</td><td>{a.is_default ? 'Yes' : '—'}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'bank' && (
        <div className="card">
          <div className="field-row">
            <div className="field"><label>Payee Name</label><div>{supplier.payee_name || '—'}</div></div>
            <div className="field"><label>Bank Name</label><div>{supplier.bank_name || '—'}</div></div>
          </div>
          <div className="field-row">
            <div className="field"><label>Account Name</label><div>{supplier.bank_account_name || '—'}</div></div>
            <div className="field"><label>Account No</label><div>{supplier.bank_account_no || '—'}</div></div>
          </div>
        </div>
      )}

      {tab === 'items' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Item Code</th><th>Description</th><th>Type</th><th>Last Purchase</th><th>Ref #</th><th style={{ textAlign: 'right' }}>Price</th></tr></thead>
              <tbody>
                {items.length === 0 && (
                  <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    No items recorded against this supplier.
                  </td></tr>
                )}
                {items.map((i) => (
                  <tr key={i.id}>
                    <td>{i.item_code}</td><td>{i.display_name}</td><td>{i.item_type || '—'}</td>
                    <td>{formatDate(i.last_purchase_date)}</td><td>{i.ref_no || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{money(i.price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'system' && (
        <div className="card">
          <div className="field-row">
            <div className="field"><label>Created</label><div>{formatDate(supplier.created_at)}</div></div>
            <div className="field"><label>Last Updated</label><div>{formatDate(supplier.updated_at)}</div></div>
          </div>
          <div className="field-row">
            <div className="field"><label>Status</label><div>{supplier.is_active ? 'Active' : 'Inactive'}</div></div>
            {/* The link back to the record this was imported from. Shown because when a figure
                here and on the live system disagree, the first question is always which live row
                this is -- and it is set by the importer alone, never typed. */}
            <div className="field"><label>Live Record</label><div>{supplier.live_id || supplier.live_pk || '—'}</div></div>
          </div>
          <h4 style={{ margin: '16px 0 8px' }}>Change History</h4>
          <DataTable
            columns={[
              { key: 'set_at', label: 'When', render: (r) => displayAuditTime(r.set_at) },
              { key: 'set_by_name', label: 'Changed By' }, { key: 'event_type', label: 'Type' },
              { key: 'field_name', label: 'Field' }, { key: 'old_value', label: 'Old Value' }, { key: 'new_value', label: 'New Value' },
            ]}
            rows={auditLogs}
            emptyLabel="No changes recorded yet. Changes are recorded from 19 Oct 2026."
          />
        </div>
      )}
    </div>
  );
}
