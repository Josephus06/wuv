import { useEffect, useState } from 'react';
import api from '../api/client';
import EntityPicker from './EntityPicker';
import LoadingSpinner from './LoadingSpinner';
import { headerDepartmentError } from '../utils/requireDepartment';
import { useAuth } from '../context/useAuth';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
const round2 = (n) => Math.round(n * 100) / 100;
// Same arithmetic the server does (computeBillableLineAmounts), so the totals shown are the totals
// saved. The server recomputes them regardless -- these are only the preview.
function lineAmounts(l, taxRate) {
  const subtotal = round2(Number(l.price_per_unit || 0) * Number(l.quantity || 0));
  const disc = round2(subtotal * (Number(l.disc_percent || 0) / 100));
  const net = round2(subtotal - disc);
  const tax = round2(net * (Number(taxRate || 0) / 100));
  return { subtotal, disc, net, tax, gross: round2(net + tax) };
}
const blankLine = () => ({ key: Math.random().toString(36).slice(2), item: null, description: '', quantity: 1, units: '', price_per_unit: '', disc_percent: 0, tax_code_id: '' });

// Create New on the invoice list: an invoice billed straight to a customer, with item lines and no
// order behind it -- how monthly rent is billed (RENTAL, 1 LOT x 15,000, withholding deducted).
// Nothing is delivered against it and no Job Order moves; the lines are what is typed here.
//
// `replicateFrom` is an invoice id to start from -- Replicate on the invoice view (asked 2026-10-05),
// as the Vendor Bill and Journal screens have it. What describes the SALE is copied: customer, type,
// term, PO #, sales rep, office location, department, bill-to address, memo, withholding and every
// line. What belongs to the original document is not: it is dated today (due by the original's term
// from today), it takes its own number on save, and BS/SI # starts empty -- that is the serial of the
// printed form, and two invoices cannot share one. Only an invoice with no order behind it is
// offered this (see SalesInvoiceView).
export default function StandaloneInvoiceModal({ onClose, onSaved, replicateFrom }) {
  // A replica keeps the original's Sales Rep, Office Location and Department; only a System Admin
  // changes them (asked 2026-10-24). A new standalone invoice has no order to take them from.
  const { user } = useAuth();
  const lockHeader = !!replicateFrom && user?.account_type !== 'System Admin';
  const [replicatedFrom, setReplicatedFrom] = useState('');
  const [meta, setMeta] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [locations, setLocations] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [paymentTerms, setPaymentTerms] = useState([]);
  const [customer, setCustomer] = useState(null);
  const [invoiceType, setInvoiceType] = useState('SI');
  const [dateCreated, setDateCreated] = useState(new Date().toISOString().slice(0, 10));
  const [dateDue, setDateDue] = useState('');
  const [paymentTerm, setPaymentTerm] = useState(null);
  const [term, setTerm] = useState('');
  const [bsSiNo, setBsSiNo] = useState('');
  const [poNo, setPoNo] = useState('');
  const [salesRep, setSalesRep] = useState(null);
  const [officeLocation, setOfficeLocation] = useState(null);
  const [department, setDepartment] = useState(null);
  const [billToAddress, setBillToAddress] = useState('');
  const [memo, setMemo] = useState('');
  const [withholdingPct, setWithholdingPct] = useState(0);
  const [lines, setLines] = useState([blankLine()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get('/sales-invoices/standalone-meta'),
      api.get('/employees'),
      api.get('/lookups/locations'),
      api.get('/lookups/departments'),
      api.get('/lookups/payment-terms'),
    ]).then(async ([m, emp, loc, dept, terms]) => {
      if (replicateFrom) await prefillFrom(m.data, emp.data, loc.data, dept.data, terms.data || []);
      setMeta(m.data);
      setEmployees(emp.data);
      setLocations(loc.data);
      setDepartments(dept.data);
      setPaymentTerms(terms.data || []);
    }).catch((err) => setError(err.response?.data?.error || 'Could not load the form.'));
  }, [replicateFrom]); // eslint-disable-line react-hooks/exhaustive-deps

  // Run with the lookups in hand: the pickers hold whole records, so each is found in its own list.
  async function prefillFrom(m, emps, locs, depts, terms) {
    try {
      const { data: si } = await api.get(`/sales-invoices/${replicateFrom}`);
      setReplicatedFrom(si.invoice_no);
      const same = (a, b) => a != null && String(a) === String(b);
      setCustomer((m.customers || []).find((c) => same(c.id, si.customer_id)) || null);
      setInvoiceType(si.invoice_type === 'DR' ? 'DR' : 'SI');
      const t = terms.find((x) => x.term_name === si.term) || null;
      setPaymentTerm(t);
      setTerm(si.term || '');
      // Today's date with the original's term: a 30-day invoice replicated today falls due in 30
      // days' time, not on the date the first one did.
      if (t) setDateDue(addDays(new Date().toISOString().slice(0, 10), Number(t.no_of_days) || 0));
      setPoNo(si.po_no || '');
      setSalesRep(emps.find((e) => same(e.id, si.sales_rep_id)) || null);
      setOfficeLocation(locs.find((l) => same(l.id, si.office_location_id)) || null);
      setDepartment(depts.find((d) => same(d.id, si.department_id)) || null);
      setBillToAddress(si.bill_to_address || '');
      setMemo(si.memo || '');
      setWithholdingPct(Number(si.withholding_tax_pct || 0));
      // A line's tax is stored as its code. Match it to a tax by code, else by the rate the line was
      // actually billed at (tax / net) -- migrated lines carry codes (VAT_PH:VATIN-12) the list lacks.
      const taxes = m.taxes || [];
      const taxFor = (l) => {
        const byCode = taxes.find((x) => x.code === l.tax_code);
        if (byCode) return byCode.id;
        const net = Number(l.net_of_tax || 0);
        if (!net || !Number(l.tax_amount)) return '';
        const rate = (Number(l.tax_amount) / net) * 100;
        const byRate = taxes.find((x) => Math.abs(Number(x.rate) - rate) < 0.05);
        return byRate ? byRate.id : '';
      };
      const copied = (si.lines || []).map((l) => ({
        ...blankLine(),
        item: (m.items || []).find((i) => same(i.id, l.item_id)) || null,
        description: l.description || '',
        quantity: Number(l.quantity) || 1,
        units: l.units || '',
        price_per_unit: l.price_per_unit != null ? String(Number(l.price_per_unit)) : '',
        disc_percent: Number(l.disc_percent || 0),
        tax_code_id: taxFor(l),
      }));
      if (copied.length) setLines(copied);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load the invoice to replicate.');
    }
  }

  if (!meta) {
    return (
      <div className="modal-overlay">
        <div className="modal modal-xl">{error ? <div className="error-banner">{error}</div> : <LoadingSpinner />}</div>
      </div>
    );
  }

  const taxRate = (id) => Number((meta.taxes.find((t) => String(t.id) === String(id)) || {}).rate || 0);
  const priced = lines.map((l) => ({ ...l, amt: lineAmounts(l, taxRate(l.tax_code_id)) }));
  const subtotal = priced.reduce((s, l) => s + l.amt.subtotal, 0);
  const discountAmount = priced.reduce((s, l) => s + l.amt.disc, 0);
  const netOfTax = priced.reduce((s, l) => s + l.amt.net, 0);
  const taxAmount = priced.reduce((s, l) => s + l.amt.tax, 0);
  const grossAmount = priced.reduce((s, l) => s + l.amt.gross, 0);
  const ewtAmount = round2(netOfTax * (Number(withholdingPct || 0) / 100));
  const amountDue = grossAmount - ewtAmount;

  const setLine = (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

  function pickCustomer(c) {
    setCustomer(c);
    setBillToAddress(c?.address || '');
    // The customer's agreed term, and the due date it implies -- the same default the order-based
    // invoice form gives.
    const t = c ? paymentTerms.find((x) => norm(x.term_name) === norm(c.customer_term)) : null;
    setPaymentTerm(t || null);
    setTerm(t ? t.term_name : (c?.customer_term || ''));
    setDateDue(t ? addDays(dateCreated, Number(t.no_of_days) || 0) : '');
  }

  async function handleSave() {
    setError('');
    if (!customer) { setError('Choose a customer.'); return; }
    const payloadLines = lines
      .filter((l) => Number(l.quantity) > 0 && (l.item || l.description.trim()))
      .map((l) => ({
        item_id: l.item?.id || null, description: l.description.trim(), quantity: Number(l.quantity), units: l.units || null,
        price_per_unit: Number(l.price_per_unit || 0), disc_percent: Number(l.disc_percent || 0), tax_code_id: l.tax_code_id || null,
      }));
    if (!payloadLines.length) { setError('Add at least one item with a quantity.'); return; }
    const deptError = headerDepartmentError(department?.id);
    if (deptError) { setError(deptError); return; }
    setSaving(true);
    try {
      const { data: si } = await api.post('/sales-invoices', {
        customer_id: customer.id,
        invoice_type: invoiceType,
        date_created: dateCreated,
        date_due: dateDue,
        term,
        bs_si_no: invoiceType === 'DR' ? '' : bsSiNo,
        po_no: poNo,
        sales_rep_id: salesRep?.id || null,
        office_location_id: officeLocation?.id || null,
        department_id: department?.id || null,
        bill_to_address: billToAddress,
        memo,
        withholding_tax_pct: Number(withholdingPct || 0),
        lines: payloadLines,
      });
      onSaved(si);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-xl" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="estimate-banner" style={{ borderRadius: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <h2 style={{ margin: 0, color: '#fff' }}>
            Create Invoice
            {replicatedFrom && <span style={{ fontSize: '0.6em', opacity: 0.85, marginLeft: 10 }}>replicated from {replicatedFrom}</span>}
          </h2>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 24, lineHeight: 1, cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ padding: 24 }}>
          {error && <div className="error-banner">{error}</div>}

          <div className="review-grid" style={{ gridTemplateColumns: '1fr 1fr 260px' }}>
            <div>
              <div className="field">
                <label>Customer</label>
                <EntityPicker
                  label="Customer" items={meta.customers} value={customer?.id || ''} getLabel={(c) => c.name}
                  columns={[{ key: 'name', label: 'Name' }, { key: 'tin', label: 'TIN' }]}
                  searchKeys={['name', 'company_name', 'customer_code', 'tin']}
                  placeholder="Select Customer..." onSelect={pickCustomer}
                />
              </div>
              <div className="field">
                <label>Type</label>
                <select value={invoiceType} onChange={(e) => setInvoiceType(e.target.value)}>
                  <option value="SI">SI — Sales/Service Invoice</option>
                  <option value="DR">DR — Delivery Receipt</option>
                </select>
              </div>
              <div className="field">
                <label>Date</label>
                <input
                  type="date" value={dateCreated}
                  onChange={(e) => {
                    setDateCreated(e.target.value);
                    if (paymentTerm && e.target.value) setDateDue(addDays(e.target.value, Number(paymentTerm.no_of_days) || 0));
                  }}
                />
              </div>
              <div className="field"><label>Date Due</label><input type="date" value={dateDue} onChange={(e) => setDateDue(e.target.value)} /></div>
              <div className="field">
                <label>Sales Rep</label>
                <EntityPicker
                  label="Sales Rep" items={employees} value={salesRep?.id || ''} disabled={lockHeader && !!salesRep}
                  getLabel={(e) => `${e.first_name} ${e.last_name}`}
                  columns={[{ key: 'name', label: 'Name', render: (e) => `${e.first_name} ${e.last_name}` }]}
                  searchKeys={['first_name', 'last_name']} onSelect={setSalesRep}
                />
              </div>
              <div className="field">
                <label>Office Location</label>
                <EntityPicker
                  label="Office Location" items={locations} value={officeLocation?.id || ''} getLabel={(l) => l.location_name} disabled={lockHeader && !!officeLocation}
                  columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']} onSelect={setOfficeLocation}
                />
              </div>
              <div className="field">
                <label>Department *</label>
                <EntityPicker
                  label="Department" items={departments} value={department?.id || ''} getLabel={(d) => d.name} disabled={lockHeader && !!department}
                  columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} onSelect={setDepartment}
                />
              </div>
              {/* A rate, not the 1/2/5 checkboxes of the order form: rent is withheld at rates
                  those do not offer. */}
              <div className="field">
                <label>Withholding Tax %</label>
                <input type="number" min="0" max="100" step="0.01" value={withholdingPct} onChange={(e) => setWithholdingPct(e.target.value)} />
              </div>
            </div>
            <div>
              <div className="field">
                <label>Term</label>
                <EntityPicker
                  label="Term" items={paymentTerms} value={paymentTerm?.id || ''} getLabel={(t) => t.term_name}
                  columns={[{ key: 'term_name', label: 'Term' }, { key: 'no_of_days', label: 'Days', render: (t) => Number(t.no_of_days || 0) }]}
                  searchKeys={['term_name']} placeholder={term || 'Select Term...'}
                  onSelect={(t) => { setPaymentTerm(t); setTerm(t ? t.term_name : ''); if (t) setDateDue(addDays(dateCreated, Number(t.no_of_days) || 0)); }}
                  onClear={() => { setPaymentTerm(null); setTerm(''); }}
                />
              </div>
              {/* A DR carries no BS/SI # (asked 2026-11-10): the field is not shown on a DR. */}
              {invoiceType !== 'DR' && <div className="field"><label>BS/SI #</label><input value={bsSiNo} onChange={(e) => setBsSiNo(e.target.value)} /></div>}
              <div className="field"><label>PO #</label><input value={poNo} onChange={(e) => setPoNo(e.target.value)} /></div>
              <div className="field"><label>Bill to Address</label><input value={billToAddress} onChange={(e) => setBillToAddress(e.target.value)} /></div>
              <div className="field"><label>Memo</label><textarea rows={4} value={memo} onChange={(e) => setMemo(e.target.value)} /></div>
            </div>
            <div className="card" style={{ background: 'var(--surface-2, #f3f4f6)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Sub Total</span><span className="hi">{money(subtotal)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Discount Amount</span><span className="hi">{money(discountAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Net of Tax</span><span className="hi">{money(netOfTax)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Expanded Withholding Tax</span><span className="hi">{money(ewtAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Tax Amount</span><span className="hi">{money(taxAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Gross Amount</span><span className="hi">{money(grossAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}><span>Amount Due</span><span>{money(amountDue)}</span></div>
            </div>
          </div>

          <div className="table-wrap" style={{ marginTop: 20 }}>
            <table>
              <thead>
                <tr>
                  <th>#</th><th style={{ minWidth: 180 }}>Item</th><th style={{ minWidth: 200 }}>Description</th><th>Qty</th><th>Unit</th>
                  <th>Price/Unit</th><th>Disc.%</th><th>Net of Tax</th><th>Tax Code</th><th>Tax Amt</th><th>Gross Amt</th><th></th>
                </tr>
              </thead>
              <tbody>
                {priced.map((l, idx) => (
                  <tr key={l.key}>
                    <td>{idx + 1}</td>
                    <td>
                      <EntityPicker
                        label="Item" items={meta.items} value={l.item?.id || ''} getLabel={(i) => i.item_code}
                        columns={[{ key: 'item_code', label: 'Code' }, { key: 'display_name', label: 'Name' }, { key: 'item_type', label: 'Type' }]}
                        searchKeys={['item_code', 'display_name']} placeholder="Select Item..."
                        onSelect={(i) => setLine(l.key, {
                          item: i,
                          description: l.description || i?.display_name || '',
                          units: l.units || i?.unit || '',
                          price_per_unit: l.price_per_unit === '' && i?.selling_price != null ? Number(i.selling_price) : l.price_per_unit,
                        })}
                        onClear={() => setLine(l.key, { item: null })}
                      />
                    </td>
                    <td><input value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} /></td>
                    <td><input type="number" min="0" step="any" style={{ width: 80 }} value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} /></td>
                    <td><input style={{ width: 70 }} value={l.units} onChange={(e) => setLine(l.key, { units: e.target.value })} /></td>
                    <td><input type="number" min="0" step="any" style={{ width: 110 }} value={l.price_per_unit} onChange={(e) => setLine(l.key, { price_per_unit: e.target.value })} /></td>
                    <td><input type="number" min="0" max="100" step="any" style={{ width: 70 }} value={l.disc_percent} onChange={(e) => setLine(l.key, { disc_percent: e.target.value })} /></td>
                    <td style={{ textAlign: 'right' }}>{money(l.amt.net)}</td>
                    <td>
                      <select value={l.tax_code_id} onChange={(e) => setLine(l.key, { tax_code_id: e.target.value })}>
                        <option value="">No VAT</option>
                        {meta.taxes.map((t) => <option key={t.id} value={t.id}>{t.code} ({Number(t.rate)}%)</option>)}
                      </select>
                    </td>
                    <td style={{ textAlign: 'right' }}>{money(l.amt.tax)}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.amt.gross)}</td>
                    <td>
                      {lines.length > 1 && (
                        <button type="button" className="btn btn-sm" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>Delete</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setLines((ls) => [...ls, blankLine()])}>+ Add Item</button>

          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? 'Saving...' : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
