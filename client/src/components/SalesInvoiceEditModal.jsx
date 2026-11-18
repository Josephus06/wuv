import { useEffect, useState } from 'react';
import api from '../api/client';
import Modal from './Modal';
import EntityPicker from './EntityPicker';
import LoadingSpinner from './LoadingSpinner';
import { headerDepartmentError } from '../utils/requireDepartment';
import { useAuth } from '../context/useAuth';

// Editing an OPEN invoice: the header, and the items.
//
// The items were left out at first because billing them moved running totals on the job orders
// and the Sales Order's status. They are in now, and the server moves those totals with them --
// a quantity change applies its delta to job_orders.quantity_invoiced, is refused if it exceeds
// what the job order actually delivered, and re-derives the order's status. See PUT
// /sales-invoices/:id.
//
// Every figure the edit can move is recomputed live here, with the same arithmetic the server
// uses, so nothing about the totals is a surprise after saving.
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
}

function addDays(dateStr, days) {
  if (!dateStr) return '';
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const day = (v) => (v ? String(v).slice(0, 10) : '');

// The per-unit price a line actually bills at: its Unit Price, unless Qty x Unit Price misses the
// stored Subtotal, then Subtotal / Qty to the 4 decimals the column holds.
function billedPrice(l) {
  const qty = Number(l.quantity || 0);
  const price = Number(l.price_per_unit || 0);
  const subtotal = Number(l.subtotal);
  if (!qty || !Number.isFinite(subtotal) || Math.abs(Number((price * qty).toFixed(2)) - subtotal) < 0.005) return price;
  return Number((subtotal / qty).toFixed(4));
}

// What the line opened with, which "changed" is measured against.
const sameAsOpened = (it) => it.description === (it.original.description || '')
  && Number(it.quantity) === Number(it.original.quantity || 0)
  && Number(it.price_per_unit) === billedPrice(it.original)
  && Number(it.disc_percent) === Number(it.original.disc_percent || 0)
  && it.tax_code === (it.original.tax_code || '')
  && it.tax_override === '';

// The invoice's own pick stays selectable, and shown, even when its list did not load.
const withCurrent = (list, cur) => (cur && !list.some((x) => Number(x.id) === Number(cur.id)) ? [...list, cur] : list);

export default function SalesInvoiceEditModal({ invoice, onClose, onSaved }) {
  // Sales Rep, Office Location and Department come from the order the invoice bills; only a System
  // Admin changes them (asked 2026-10-24) -- one the invoice has none of stays open to fill.
  const { user } = useAuth();
  const isAdmin = user?.account_type === 'System Admin';
  const [dateCreated, setDateCreated] = useState(day(invoice.date_created));
  const [dateDue, setDateDue] = useState(day(invoice.date_due));
  const [term, setTerm] = useState(invoice.term || '');
  const [paymentTerm, setPaymentTerm] = useState(null);
  const [paymentTerms, setPaymentTerms] = useState([]);
  const [bsSiNo, setBsSiNo] = useState(invoice.bs_si_no || '');
  const [poNo, setPoNo] = useState(invoice.po_no || '');
  const [salesRep, setSalesRep] = useState(
    invoice.sales_rep_id ? { id: invoice.sales_rep_id, name: invoice.sales_rep_name } : null,
  );
  const [officeLocation, setOfficeLocation] = useState(
    invoice.office_location_id ? { id: invoice.office_location_id, location_name: invoice.office_location_name } : null,
  );
  const [department, setDepartment] = useState(
    invoice.department_id ? { id: invoice.department_id, name: invoice.department_name } : null,
  );
  const [billToAddress, setBillToAddress] = useState(invoice.bill_to_address || '');
  const [memo, setMemo] = useState(invoice.memo || '');
  const [withholdingPct, setWithholdingPct] = useState(Number(invoice.withholding_tax_pct || 0));
  // `original` rides along so the line's tax rate can be recovered and the audit shows what moved.
  //
  // A line imported from the source can bill a Subtotal that is not Qty x Unit Price (10 x 250.00
  // billed at 2,500.02 -- the source kept more decimals of the price). Its Unit Price opens at what
  // the line really bills per unit (250.002), so typing 250 is a change that is saved, and an
  // untouched line previews its stored figures -- the preview never promises a total the save
  // will not give.
  const [items, setItems] = useState(() => (invoice.lines || []).map((l) => ({
    id: l.id,
    description: l.description || '',
    quantity: Number(l.quantity || 0),
    units: l.units || '',
    price_per_unit: billedPrice(l),
    disc_percent: Number(l.disc_percent || 0),
    tax_code: l.tax_code || '',
    // A Tax Amount typed by hand; '' means "computed from the rate".
    tax_override: '',
    job_order_no: l.job_order_no || '',
    // Marked for removal: struck through, out of the totals, sent as removed_line_ids on save.
    removed: false,
    original: l,
  })));
  const [employees, setEmployees] = useState([]);
  const [locations, setLocations] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [taxes, setTaxes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Each list loads on its own: one that is refused (a permission, a timeout) leaves its picker
  // showing just the invoice's current value, instead of failing the whole edit. The banner names
  // the lists that did not load.
  useEffect(() => {
    const failed = [];
    const load = (url, name) => api.get(url).catch(() => { failed.push(name); return { data: [] }; });
    Promise.all([
      load('/employees', 'Sales Reps'),
      load('/lookups/locations', 'Office Locations'),
      load('/lookups/departments', 'Departments'),
      load('/lookups/payment-terms', 'Terms'),
      load('/lookups/taxes', 'Tax Codes'),
    ]).then(([empRes, locRes, deptRes, termRes, taxRes]) => {
      setTaxes((taxRes.data || []).filter((t) => t.is_active !== 0 && t.is_active !== false));
      setEmployees(empRes.data || []);
      setLocations(locRes.data || []);
      setDepartments(deptRes.data || []);
      if (failed.length) setError(`Could not load: ${failed.join(', ')}. Those keep their current value.`);
      const terms = termRes.data || [];
      setPaymentTerms(terms);
      // Open the picker on the term the invoice already carries. Matched case- and
      // space-insensitively, like the create modal, because these strings were typed by hand for
      // years before the list existed; one that matches nothing keeps its text rather than
      // blanking an agreed term.
      const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
      setPaymentTerm(terms.find((t) => norm(t.term_name) === norm(invoice.term)) || null);
      setLoading(false);
    });
  }, [invoice.term]);

  // The same arithmetic the server does, line by line, so the preview cannot say one thing and
  // the save another. A line's tax RATE is not sent to the client, so it is recovered from what
  // the line was billed at (tax / net) -- exact for every rate in this data, and 0 for the
  // zero-rated and exempt lines where there is nothing to recover.
  const priced = items.map((it) => {
    if (sameAsOpened(it)) {
      const o = it.original;
      const subtotal = Number(o.subtotal || 0);
      const net = Number(o.net_of_tax || 0);
      const tax = Number(o.tax_amount || 0);
      return {
        ...it, subtotal, discAmount: Number(o.disc_amount ?? subtotal - net), net, tax,
        gross: Number(o.gross_amount ?? net + tax),
      };
    }
    const qty = Number(it.quantity) || 0;
    const price = Number(it.price_per_unit) || 0;
    const disc = Number(it.disc_percent) || 0;
    const subtotal = Number((price * qty).toFixed(2));
    const discAmount = Number((subtotal * (disc / 100)).toFixed(2));
    const net = Number((subtotal - discAmount).toFixed(2));
    // A Tax Code changed here sets the rate outright -- that code's rate, or 0% for none --
    // exactly as the server prices it.
    const rate = it.tax_code !== (it.original.tax_code || '')
      ? Number(taxes.find((t) => t.code === it.tax_code)?.rate || 0)
      : Number(it.original.net_of_tax) > 0
        ? (Number(it.original.tax_amount) / Number(it.original.net_of_tax)) * 100 : 0;
    const tax = it.tax_override !== ''
      ? Number((Number(it.tax_override) || 0).toFixed(2))
      : Number((net * (rate / 100)).toFixed(2));
    return { ...it, subtotal, discAmount, net, tax, gross: Number((net + tax).toFixed(2)) };
  });

  const kept = priced.filter((l) => !l.removed);
  // Delivery Ticket conversions bill whole, so the server refuses removing their items.
  const canRemove = !invoice.delivery_ticket_id;
  const pct = Number(withholdingPct) || 0;
  const netOfTax = Number(kept.reduce((s, l) => s + l.net, 0).toFixed(2));
  const taxAmount = Number(kept.reduce((s, l) => s + l.tax, 0).toFixed(2));
  const grossAmount = Number(kept.reduce((s, l) => s + l.gross, 0).toFixed(2));
  const ewt = Number((netOfTax * (pct / 100)).toFixed(2));
  const amountDue = Number((grossAmount - ewt).toFixed(2));
  const pctValid = Number.isFinite(pct) && pct >= 0 && pct <= 100;
  // A quantity of zero or less has no meaning on an invoice line, and the server refuses it.
  const itemsValid = kept.length > 0 && kept.every((l) => Number(l.quantity) > 0
    && Number(l.price_per_unit) >= 0
    && Number(l.disc_percent) >= 0 && Number(l.disc_percent) <= 100
    && (l.tax_override === '' || Number(l.tax_override) >= 0));

  // Changing anything the tax is computed from drops a hand-typed Tax Amount, so the tax follows
  // the new figures rather than silently staying at an amount typed for the old ones.
  function setItem(id, patch) {
    const recompute = ['quantity', 'price_per_unit', 'disc_percent', 'tax_code'].some((k) => k in patch);
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch, ...(recompute ? { tax_override: '' } : {}) } : it)));
  }

  async function save() {
    if (!pctValid) { setError('Withholding Tax % must be between 0 and 100.'); return; }
    if (!kept.length) { setError('An Invoice needs at least one item. Void it instead of removing them all.'); return; }
    if (!itemsValid) { setError('Check the item quantities, prices and discounts.'); return; }
    const deptError = headerDepartmentError(department?.id);
    if (deptError) { setError(deptError); return; }
    setSaving(true);
    setError('');
    try {
      const { data } = await api.put(`/sales-invoices/${invoice.id}`, {
        date_created: dateCreated,
        date_due: dateDue || null,
        term: term || null,
        bs_si_no: bsSiNo,
        po_no: poNo,
        sales_rep_id: salesRep?.id || null,
        office_location_id: officeLocation?.id || null,
        department_id: department?.id || null,
        bill_to_address: billToAddress,
        memo,
        withholding_tax_pct: pct,
        // Only the items that actually moved, so an untouched invoice sends no line work at all.
        removed_line_ids: items.filter((it) => it.removed).map((it) => it.id),
        lines: items
          .filter((it) => !it.removed)
          .filter((it) => !sameAsOpened(it))
          .map((it) => ({
            id: it.id,
            description: it.description,
            quantity: Number(it.quantity),
            price_per_unit: Number(it.price_per_unit),
            disc_percent: Number(it.disc_percent),
            tax_code: it.tax_code || null,
            ...(it.tax_override !== '' ? { tax_amount: Number(it.tax_override) } : {}),
          })),
      });
      onSaved(data);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not save the Invoice.');
      setSaving(false);
    }
  }

  return (
    <Modal title={`Edit Invoice — ${invoice.invoice_no}`} onClose={onClose} large>
      {loading ? <LoadingSpinner /> : (
        <>
          {error && <div className="error-banner">{error}</div>}

          <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
            {/* The term counts its days from the invoice date, so moving the date moves the due
                date with it -- the same rule the create form follows. */}
            <div className="field">
              <label>Date</label>
              <input
                type="date" value={dateCreated}
                onChange={(e) => {
                  setDateCreated(e.target.value);
                  if (paymentTerm && e.target.value) {
                    setDateDue(addDays(e.target.value, Number(paymentTerm.no_of_days) || 0));
                  }
                }}
              />
            </div>
            <div className="field">
              <label>Date Due</label>
              <input
                type="date" value={dateDue} onChange={(e) => setDateDue(e.target.value)}
                title={paymentTerm
                  ? `${paymentTerm.term_name} — ${Number(paymentTerm.no_of_days) || 0} day(s) from the invoice date`
                  : 'No term selected, so there is no basis for a due date'}
              />
            </div>
            <div className="field">
              <label>Term</label>
              <EntityPicker
                label="Term" items={paymentTerms} value={paymentTerm?.id || ''}
                getLabel={(t) => t.term_name}
                columns={[
                  { key: 'term_name', label: 'Term' },
                  { key: 'no_of_days', label: 'Days', render: (t) => Number(t.no_of_days || 0) },
                ]}
                searchKeys={['term_name']}
                placeholder={term || 'Select Term...'}
                onSelect={(t) => {
                  setPaymentTerm(t);
                  setTerm(t ? t.term_name : '');
                  if (t) setDateDue(addDays(dateCreated, Number(t.no_of_days) || 0));
                }}
                onClear={() => { setPaymentTerm(null); setTerm(''); }}
              />
            </div>
            {/* A DR carries no BS/SI # (asked 2026-11-10): the field is not shown on a DR. */}
            {invoice?.invoice_type !== 'DR' && <div className="field"><label>BS/SI #</label><input value={bsSiNo} onChange={(e) => setBsSiNo(e.target.value)} /></div>}
            <div className="field"><label>PO #</label><input value={poNo} onChange={(e) => setPoNo(e.target.value)} /></div>
            <div className="field">
              <label>Sales Rep</label>
              <EntityPicker
                label="Sales Rep" items={withCurrent(employees, salesRep)} value={salesRep?.id || ''} disabled={!isAdmin && !!invoice.sales_rep_id}
                getLabel={(e) => (e.name ? e.name : `${e.first_name} ${e.last_name}`)}
                columns={[{ key: 'name', label: 'Name', render: (e) => `${e.first_name} ${e.last_name}` }]}
                searchKeys={['first_name', 'last_name']}
                onSelect={setSalesRep}
                onClear={() => setSalesRep(null)}
              />
            </div>
            <div className="field">
              <label>Office Location</label>
              <EntityPicker
                label="Office Location" items={withCurrent(locations, officeLocation)} value={officeLocation?.id || ''} disabled={!isAdmin && !!invoice.office_location_id}
                getLabel={(l) => l.location_name}
                columns={[{ key: 'location_name', label: 'Location' }]}
                searchKeys={['location_name']}
                onSelect={setOfficeLocation}
                onClear={() => setOfficeLocation(null)}
              />
            </div>
            <div className="field">
              <label>Department *</label>
              <EntityPicker
                label="Department" items={withCurrent(departments, department)} value={department?.id || ''} disabled={!isAdmin && !!invoice.department_id}
                getLabel={(d) => d.name}
                columns={[{ key: 'name', label: 'Department' }]}
                searchKeys={['name']}
                onSelect={setDepartment}
                onClear={() => setDepartment(null)}
              />
            </div>
            <div className="field"><label>Bill to Address</label><input value={billToAddress} onChange={(e) => setBillToAddress(e.target.value)} /></div>
            <div className="field">
              <label>Withholding Tax %</label>
              <input
                type="number" min="0" max="100" step="0.01" value={withholdingPct}
                onChange={(e) => setWithholdingPct(e.target.value)}
              />
              {!pctValid && <span style={{ color: '#b91c1c', fontSize: 12 }}>Must be between 0 and 100.</span>}
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Memo</label>
              <textarea rows={3} value={memo} onChange={(e) => setMemo(e.target.value)} />
            </div>
          </div>

          {/* The items. Qty is the one that reaches outside this invoice -- the server moves the
              job order's invoiced total with it and refuses more than was delivered -- so the
              job order is named on each row. */}
          <h3 className="subsection" style={{ marginTop: 16 }}>Items</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {canRemove && <th />}
                  <th>JO #</th>
                  <th>Description</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th>Unit</th>
                  <th style={{ textAlign: 'right' }}>Unit Price</th>
                  <th style={{ textAlign: 'right' }}>Disc %</th>
                  <th>Tax Code</th>
                  <th style={{ textAlign: 'right' }}>Net</th>
                  <th style={{ textAlign: 'right' }}>Tax</th>
                  <th style={{ textAlign: 'right' }}>Gross</th>
                </tr>
              </thead>
              <tbody>
                {priced.length === 0 && (
                  <tr><td colSpan={canRemove ? 11 : 10} className="muted" style={{ textAlign: 'center', padding: 16 }}>This invoice has no items.</td></tr>
                )}
                {priced.map((l) => (
                  <tr key={l.id} style={l.removed ? { opacity: 0.45, textDecoration: 'line-through' } : undefined}>
                    {canRemove && (
                      <td>
                        <button type="button" className={`btn btn-sm${l.removed ? '' : ' btn-danger'}`}
                          title={l.removed ? 'Keep this item' : 'Remove this item from the invoice; the totals follow'}
                          onClick={() => setItems((prev) => prev.map((it) => (it.id === l.id ? { ...it, removed: !it.removed } : it)))}>
                          {l.removed ? 'Undo' : 'Delete'}
                        </button>
                      </td>
                    )}
                    <td style={{ whiteSpace: 'nowrap' }}>{l.job_order_no || '--'}</td>
                    <td><input value={l.description} onChange={(e) => setItem(l.id, { description: e.target.value })} style={{ minWidth: 220 }} /></td>
                    <td>
                      <input
                        type="number" min="0" step="0.0001" value={l.quantity}
                        onChange={(e) => setItem(l.id, { quantity: e.target.value })}
                        style={{ width: 90, textAlign: 'right' }}
                      />
                    </td>
                    <td>{l.units}</td>
                    <td>
                      <input
                        type="number" min="0" step="0.0001" value={l.price_per_unit}
                        onChange={(e) => setItem(l.id, { price_per_unit: e.target.value })}
                        style={{ width: 110, textAlign: 'right' }}
                      />
                    </td>
                    <td>
                      <input
                        type="number" min="0" max="100" step="0.01" value={l.disc_percent}
                        onChange={(e) => setItem(l.id, { disc_percent: e.target.value })}
                        style={{ width: 80, textAlign: 'right' }}
                      />
                    </td>
                    <td>
                      <select value={l.tax_code} onChange={(e) => setItem(l.id, { tax_code: e.target.value })} style={{ minWidth: 120 }}>
                        <option value="">None</option>
                        {/* A migrated line can carry the old system's code (VAT_PH:VATIN-12), which
                            is not in the list -- kept as an option so it stays selected. */}
                        {l.original.tax_code && !taxes.some((t) => t.code === l.original.tax_code) && (
                          <option value={l.original.tax_code}>{l.original.tax_code}</option>
                        )}
                        {taxes.map((t) => <option key={t.id} value={t.code}>{t.code} ({Number(t.rate)}%)</option>)}
                      </select>
                    </td>
                    <td style={{ textAlign: 'right' }}>{money(l.net)}</td>
                    <td>
                      {/* Computed from the rate until typed over; the typed figure is kept until
                          qty, price, discount or tax code changes. */}
                      <input
                        type="number" min="0" step="0.01"
                        value={l.tax_override !== '' ? l.tax_override : l.tax}
                        onChange={(e) => setItem(l.id, { tax_override: e.target.value })}
                        style={{ width: 100, textAlign: 'right', fontWeight: l.tax_override !== '' ? 600 : undefined }}
                        title={l.tax_override !== '' ? 'Typed by hand' : 'Computed from the tax code'}
                      />
                    </td>
                    <td style={{ textAlign: 'right' }}>{money(l.gross)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!itemsValid && (
            <div style={{ color: '#b91c1c', fontSize: 12, marginTop: 4 }}>
              Qty must be greater than 0, price and tax cannot be negative, and discount must be between 0 and 100.
            </div>
          )}

          {/* What the edit will do to the money, before it is saved. */}
          <div className="card" style={{ background: 'var(--surface-2, #f3f4f6)', marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="muted">Net of Tax</span>
              <span className="hi">
                {money(netOfTax)}
                {Number(netOfTax) !== Number(invoice.net_of_tax) && (
                  <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>was {money(invoice.net_of_tax)}</span>
                )}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Tax</span><span className="hi">{money(taxAmount)}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="muted">Gross</span>
              <span className="hi">
                {money(grossAmount)}
                {Number(grossAmount) !== Number(invoice.gross_amount) && (
                  <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>was {money(invoice.gross_amount)}</span>
                )}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="muted">EWT</span>
              <span className="hi">
                {money(ewt)}
                {Number(ewt) !== Number(invoice.ewt_amount) && (
                  <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>was {money(invoice.ewt_amount)}</span>
                )}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
              <span>Amount Due</span>
              <span>
                {money(amountDue)}
                {Number(amountDue) !== Number(invoice.amount_due) && (
                  <span className="muted" style={{ marginLeft: 6, fontSize: 12, fontWeight: 400 }}>was {money(invoice.amount_due)}</span>
                )}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={saving || !pctValid || !itemsValid}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
