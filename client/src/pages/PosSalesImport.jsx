import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

function money(v) { return Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// Sales Invoices > Import POS Sales: each POS shift becomes one Sales Invoice, the way it is done in
// Odoo -- the shift's CATEGORY SALES report gives the invoice lines (one per item, revenue to each
// item's own account, stock taken off the branch), and the same shift's Z-READING pays it (cash and
// GCash, waiting in Undeposited Funds for the Bank Deposit). Pick both PDFs of every shift together;
// they are matched by shift. Nothing is saved until Import. (server: routes/posSalesImport.js)
export default function PosSalesImport() {
  const [customers, setCustomers] = useState([]);
  const [locations, setLocations] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [customer, setCustomer] = useState(null);
  const [location, setLocation] = useState(null);
  const [department, setDepartment] = useState(null);
  const [files, setFiles] = useState([]);
  const [preview, setPreview] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    // One call under this page's own permission (server routes/posSalesImport.js /options), so a
    // cashier without Customers / Lookups rights still gets every picker filled.
    api.get('/pos-sales-import/options').then(({ data }) => {
      setCustomers(data.customers || []);
      setLocations((data.branches || []).map((b) => ({ ...b, company_name: b.company_name || '' })));
      setDepartments(data.departments || []);
    }).catch((e) => setError(e.response?.data?.error || 'Could not load the branches, customers and departments'));
  }, []);

  const form = (extra = {}) => {
    const body = new FormData();
    files.forEach((f) => body.append('files', f));
    Object.entries(extra).forEach(([k, v]) => { if (v != null) body.append(k, v); });
    return body;
  };

  async function readFiles(list) {
    setFiles(list); setPreview(null); setResults(null); setError('');
    if (!list.length) return;
    setBusy('Reading...');
    try {
      const body = new FormData();
      list.forEach((f) => body.append('files', f));
      const { data } = await api.post('/pos-sales-import/preview', body);
      setPreview(data);
    } catch (e) { setError(e.response?.data?.error || 'Could not read the files.'); }
    finally { setBusy(''); }
  }

  async function doImport() {
    setError('');
    if (!customer || !location || !department) { setError('Pick the branch, the customer and the department first.'); return; }
    setBusy('Importing...');
    try {
      const { data } = await api.post('/pos-sales-import', form({
        customer_id: customer.id, office_location_id: location.id, department_id: department.id,
      }));
      setResults(data.results);
    } catch (e) { setError(e.response?.data?.error || 'Import failed.'); }
    finally { setBusy(''); }
  }

  const shifts = preview?.shifts || [];
  const ready = shifts.filter((s) => s.ok);
  const toggle = (k) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  return (
    <div>
      <div className="page-header">
        <h1>Import POS Sales</h1>
        <Link className="btn btn-sm" to="/sales-invoices">Back to Invoices</Link>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <p className="muted" style={{ marginTop: 0 }}>
          Pick each shift&apos;s <strong>CATEGORY SALES</strong> report and its <strong>Z READING</strong> together (several shifts at once is fine).
          Each shift becomes one invoice: the Category Sales lines are the items sold (new POS items are added to Master Lists),
          the products leave the branch&apos;s stock, and the Z-Reading&apos;s cash and GCash pay the invoice.
        </p>
        <p className="muted">
          For the salons (Cuts For Tots), pick the month&apos;s <strong>Daily Sales Reports</strong> workbook (.xlsx) together with the POS
          <strong> BIR Sales Summary</strong> (PDF) for the same month. Each day becomes one Open invoice: the sheet gives its services, products
          and certificates, the POS report its VAT, VAT-exempt (senior / PWD) sales and receipt numbers -- and the two must agree on the day&apos;s
          net sales. Record the day&apos;s money with Accept Payment on the invoice. A day already imported without VAT gets its VAT added.
          No daily sheet for the month? The BIR Sales Summary can be imported on its own: each day becomes one invoice with a Hair Salon
          Services line (and a VAT-exempt line), with the exact VAT and receipt numbers. A day is never booked twice for a branch.
        </p>
        <div className="filter-grid">
          <div className="field">
            <label>Branch *</label>
            <EntityPicker label="Branch" items={locations} value={location?.id || ''}
              getLabel={(l) => (l ? `${l.company_name ? `${l.company_name} — ` : ''}${l.location_name}` : '')}
              columns={[{ key: 'location_name', label: 'Branch' }, { key: 'company_name', label: 'Company' }]}
              searchKeys={['location_name', 'company_name']} onSelect={setLocation} />
          </div>
          <div className="field">
            <label>Customer *</label>
            <EntityPicker label="Customer" items={customers} value={customer?.id || ''} getLabel={(c) => c?.name}
              columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} onSelect={setCustomer} />
          </div>
          <div className="field">
            <label>Department *</label>
            <EntityPicker label="Department" items={departments} value={department?.id || ''} getLabel={(d) => d?.name}
              columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} onSelect={setDepartment} />
          </div>
          <div className="field">
            <label>POS reports (PDF) and/or daily sales sheet (.xlsx)</label>
            <input type="file" accept="application/pdf,.pdf,.xlsx" multiple onChange={(e) => readFiles([...(e.target.files || [])])} />
          </div>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {busy && <LoadingSpinner label={busy} />}

      {(preview?.problems || []).map((p) => (
        <div key={p.source_file} className="error-banner">{p.source_file}: {p.errors.join(' ')}</div>
      ))}

      {shifts.length > 0 && !results && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <strong style={{ marginRight: 'auto' }}>{shifts.length} shift{shifts.length === 1 ? '' : 's'} — {ready.length} ready to import</strong>
            <button className="btn btn-primary" disabled={!!busy || !ready.length} onClick={doImport}>
              Import {ready.length} invoice{ready.length === 1 ? '' : 's'}
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th></th><th>Shift</th><th>Date</th><th>Store</th><th style={{ textAlign: 'right' }}>Sales</th><th style={{ textAlign: 'right' }}>VAT</th>
                  <th style={{ textAlign: 'right' }}>Cash</th><th style={{ textAlign: 'right' }}>GCash</th>
                  <th style={{ textAlign: 'right' }}>Unpaid</th><th>New items</th><th>Status</th></tr>
              </thead>
              <tbody>
                {shifts.map((s) => (
                  <Fragment key={s.key}>
                    <tr>
                      <td><button type="button" className="btn btn-sm" onClick={() => toggle(s.key)} disabled={!s.lines}>{open.has(s.key) ? '−' : '+'}</button></td>
                      <td>{s.branch_code}/{s.shift}</td>
                      <td>{s.date}</td>
                      <td>{s.store}</td>
                      <td style={{ textAlign: 'right' }}>{s.total != null ? money(s.total) : ''}</td>
                      <td style={{ textAlign: 'right' }} title={s.vat?.si_range ? `POS receipts ${s.vat.si_range}` : undefined}>{s.vat ? money(s.vat.vat) : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{s.payment ? money(s.payment.cash) : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{s.payment ? money(s.payment.gcash) : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{s.payment ? money(s.payment.unpaid) : s.total != null ? money(s.total) : ''}</td>
                      <td>{(s.new_items || []).length || ''}</td>
                      <td>
                        {s.ok ? <span style={{ color: 'var(--success)' }}>{s.mode === 'add_vat' ? 'Ready: add VAT' : 'Ready'}</span> : <span style={{ color: 'var(--danger)' }}>{(s.errors || []).join(' ')}</span>}
                        {(s.warnings || []).map((w) => <div key={w} className="muted" style={{ fontSize: 12, color: 'var(--warning)' }}>{w}</div>)}
                      </td>
                    </tr>
                    {open.has(s.key) && (
                      <tr>
                        <td />
                        <td colSpan={10}>
                          <table>
                            <thead><tr><th>Category</th><th>Item</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Price</th><th style={{ textAlign: 'right' }}>Amount</th><th>Type</th><th style={{ textAlign: 'right' }}>Unit cost</th></tr></thead>
                            <tbody>
                              {s.lines.map((l, i) => (
                                <tr key={i}>
                                  <td>{l.pos_category}</td>
                                  <td>{l.description}{l.new_item && <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>(new item)</span>}</td>
                                  <td style={{ textAlign: 'right' }}>{l.quantity}</td>
                                  <td style={{ textAlign: 'right' }}>{money(l.unit_price)}</td>
                                  <td style={{ textAlign: 'right' }}>{money(l.amount)}</td>
                                  <td>{l.item_type}</td>
                                  <td style={{ textAlign: 'right' }}>{l.unit_cost ? money(l.unit_cost) : ''}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {results && (
        <div className="card">
          <strong>Imported</strong>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table>
              <thead><tr><th>Shift</th><th>Invoice</th><th style={{ textAlign: 'right' }}>Total</th><th style={{ textAlign: 'right' }}>VAT added</th><th>Payments</th><th>Cash short / over</th><th>Result</th></tr></thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.key}>
                    <td>{r.key}</td>
                    <td>{r.invoice ? <Link to={`/sales-invoices/${r.invoice.id}`}>{r.invoice.invoice_no}</Link> : ''}</td>
                    <td style={{ textAlign: 'right' }}>{r.invoice ? money(r.invoice.total) : ''}</td>
                    <td style={{ textAlign: 'right' }}>{r.invoice?.vat_added ? money(r.invoice.vat_added) : ''}</td>
                    <td>{(r.invoice?.payments || []).map((p) => (
                      <div key={p.id}><Link to={`/customer-payments/${p.id}`}>{p.customer_payment_no}</Link> {p.method} {money(p.amount)}</div>
                    ))}</td>
                    <td>{r.invoice?.journal ? <Link to={`/journals/${r.invoice.journal.id}`}>{r.invoice.journal.journal_no} {money(r.invoice.journal.amount)}</Link> : ''}</td>
                    <td>{r.ok ? <span style={{ color: 'var(--success)' }}>Done</span> : <span style={{ color: 'var(--danger)' }}>{(r.errors || []).join(' ')}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
