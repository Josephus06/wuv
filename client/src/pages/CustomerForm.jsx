import { useEffect, useState, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import LoadingSpinner from '../components/LoadingSpinner';
import EntityPicker from '../components/EntityPicker';
import { displayDate } from '../utils/dates';

// "Setup Your Customer" -- the add/edit customer form, laid out as the old system's customer
// screen: three columns of header fields, then tabs for Contact Persons, Shipping Addresses,
// Transactions, Relationships, Financial and Billing and Collection. The editable tabs save with
// the header in one Save; the others are read-only views of the customer's documents and balance.
const EMPTY = {
  name: '', address: '', tax_id: '', tin: '', business_style_id: '',
  birthdate: '', gender: '', contact_no: '', customer_type: '',
  is_charge_to_location: false, is_ewt: false, is_final_tax: false, is_charge_to: false, include_90_commission: false,
  credit_limit: '', payment_term_id: '', bill_to_name: '', bill_to_address: '', bill_to_contact_no: '',
  contacts: [], addresses: [], relationships: [], billing_contacts: [],
};
const EMPTY_CONTACT = { contact_name: '', address: '', email: '', title: '', phone: '', is_primary: false, is_default_bill_to: false, is_approver: false, is_certifier: false };
const EMPTY_ADDRESS = { address_type: 'Shipping', address_line: '', is_default: false };
// Billing and Collection rows (2026-10-21), as on the source system's customer page.
const EMPTY_BILLING = {
  contact_person: '', contact_number: '', email: '', address: '', billing_collection: '',
  billing_requirements: '', releasing_schedule: '', releasing_location: '', payment_method: '', other_info: '',
};
export const BILLING_COLUMNS = [
  ['contact_person', 'Contact Person'], ['contact_number', 'Contact number'], ['email', 'Email Address'], ['address', 'Address'],
  ['billing_collection', 'Billing / Collection'], ['billing_requirements', 'Billing Requirements'], ['releasing_schedule', 'Releasing Schedule'],
  ['releasing_location', 'Releasing Location'], ['payment_method', 'Payment Method'], ['other_info', 'Other Info'],
];
const BILLING_COLLECTION_OPTIONS = ['Billing', 'Collection', 'Billing & Collection'];
// A relationship is another customer from the list (2026-10-19): a payment from this customer may
// then be applied to that customer's invoices (server: lib/customerRelations.js).
const EMPTY_RELATIONSHIP = { related_customer_id: '', name: '', address: '', contact_no: '' };
const FLAGS = [
  ['is_charge_to_location', 'Is Charge To Location'],
  ['is_ewt', 'Expanded Withholding Tax'],
  ['is_final_tax', 'Final Tax'],
  ['is_charge_to', 'Is Charge To'],
  ['include_90_commission', 'Include in 90% Commission'],
];
const TABS = [
  ['contacts', 'Contact Persons'], ['addresses', 'Shipping Addresses'], ['transactions', 'Transactions'],
  ['relationships', 'Relationships'], ['financial', 'Financial'], ['billing', 'Billing and Collection'],
];
const money = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toLocaleDateString('en-CA');

export default function CustomerForm() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const { can } = useAuth();
  const [form, setForm] = useState(EMPTY);
  const [lookups, setLookups] = useState({ styles: [], terms: [], taxes: [], reps: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Set at once on the first click, before React re-renders the button disabled -- a fast double
  // click otherwise sent two creates.
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // The customer this name would duplicate, if any -- looked up when the Name field is left, and
  // again from the server's own refusal on Save. Held as a record rather than a message so the
  // form can offer to OPEN that customer, which is what the person typing actually wants.
  // `exact` is set when name, TIN and address all match it (Save is refused); otherwise it only
  // shares the name, which is allowed -- a TIN or address tells the two apart.
  const [duplicate, setDuplicate] = useState(null);
  const [tab, setTab] = useState('contacts');
  const canSave = isNew ? can('/customers', 'can_add') : can('/customers', 'can_edit');

  useEffect(() => {
    (async () => {
      const [bs, pt, tx] = await Promise.all([
        api.get('/lookups/business-styles'), api.get('/lookups/payment-terms'), api.get('/lookups/taxes'),
      ]);
      const reps = await api.get('/employees').then((r) => r.data).catch(() => []);
      setLookups({ styles: bs.data, terms: pt.data, taxes: tx.data, reps });
      if (!isNew) {
        const { data } = await api.get(`/customers/${id}`);
        const d = { ...data };
        for (const k of Object.keys(EMPTY)) if (d[k] === null || d[k] === undefined) d[k] = EMPTY[k];
        d.birthdate = d.birthdate ? String(d.birthdate).slice(0, 10) : '';
        for (const [k] of FLAGS) d[k] = !!Number(d[k]);
        d.contacts = (data.contacts || []).map((c) => ({ ...EMPTY_CONTACT, ...c, is_primary: !!c.is_primary, is_default_bill_to: !!c.is_default_bill_to, is_approver: !!c.is_approver, is_certifier: !!c.is_certifier }));
        d.addresses = (data.addresses || []).filter((a) => String(a.address_type || '').toLowerCase() !== 'billing');
        d.billingAddresses = (data.addresses || []).filter((a) => String(a.address_type || '').toLowerCase() === 'billing');
        d.billing_contacts = (data.billing_contacts || []).map((r) => ({ ...EMPTY_BILLING, ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v ?? ''])) }));
        setForm(d);
      }
      setLoading(false);
    })().catch((e) => { setError(e.response?.data?.error || 'Could not load the customer.'); setLoading(false); });
  }, [id, isNew]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  // The customer list for the Relationships picker, loaded the first time that tab opens.
  const [allCustomers, setAllCustomers] = useState(null);
  useEffect(() => {
    if (tab === 'relationships' && allCustomers === null) {
      api.get('/customers').then((r) => setAllCustomers(Array.isArray(r.data) ? r.data : (r.data?.rows || []))).catch(() => setAllCustomers([]));
    }
  }, [tab, allCustomers]);
  const pickRelated = (idx, c) => setForm((f) => ({
    ...f,
    relationships: f.relationships.map((r, i) => (i === idx
      ? { ...r, related_customer_id: c.id, name: c.name, address: c.address || '', contact_no: c.contact_no || '' } : r)),
  }));
  const setRow = (list, idx, k, v) => setForm((f) => ({ ...f, [list]: f[list].map((r, i) => (i === idx ? { ...r, [k]: v } : r)) }));
  const addRow = (list, empty) => setForm((f) => ({ ...f, [list]: [...f[list], { ...empty }] }));
  const removeRow = (list, idx) => setForm((f) => ({ ...f, [list]: f[list].filter((_, i) => i !== idx) }));
  // One default contact / one default bill-to contact: ticking one clears the others.
  const setExclusive = (idx, k, v) => setForm((f) => ({ ...f, contacts: f.contacts.map((c, i) => ({ ...c, [k]: i === idx ? v : (v ? false : c[k]) })) }));

  async function save() {
    setError(''); setNotice('');
    if (!form.name.trim()) { setError('Name is required.'); return; }
    setDuplicate(null);
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    const payload = {
      ...form,
      business_style_id: form.business_style_id || null, payment_term_id: form.payment_term_id || null, tax_id: form.tax_id || null,
      // Billing-type addresses are not on this form; they are sent back untouched so a save keeps them.
      addresses: [...form.addresses, ...(form.billingAddresses || [])],
    };
    delete payload.billingAddresses;
    try {
      if (isNew) {
        const { data } = await api.post('/customers', payload);
        navigate(`/customers/${data.id}/edit`, { replace: true });
        setNotice('Customer saved.');
      } else {
        const { data } = await api.put(`/customers/${id}`, payload);
        setNotice(data.kept?.length ? `Saved. Kept because other documents use them: ${data.kept.join('; ')}.` : 'Customer saved.');
        const fresh = await api.get(`/customers/${id}`);
        setForm((f) => ({
          ...f,
          contacts: fresh.data.contacts.map((c) => ({ ...EMPTY_CONTACT, ...c, is_primary: !!c.is_primary, is_default_bill_to: !!c.is_default_bill_to, is_approver: !!c.is_approver, is_certifier: !!c.is_certifier })),
          addresses: fresh.data.addresses.filter((a) => String(a.address_type || '').toLowerCase() !== 'billing'),
          billingAddresses: fresh.data.addresses.filter((a) => String(a.address_type || '').toLowerCase() === 'billing'),
          relationships: fresh.data.relationships,
          billing_contacts: (fresh.data.billing_contacts || []).map((r) => ({ ...EMPTY_BILLING, ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v ?? ''])) })),
        }));
      }
    } catch (e) {
      setError(e.response?.data?.error || 'Save failed.');
      // The server refuses a duplicate name whatever the form believed. Re-asking rather than
      // building a record out of the typed name means the banner names the customer ON FILE,
      // spelled its way -- which is the one to open, and often not spelled quite as typed.
      if (e.response?.data?.existing_customer_id) checkName();
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  if (loading) return <LoadingSpinner />;

  const input = (k, props = {}) => <input value={form[k] ?? ''} onChange={(e) => set(k, e.target.value)} {...props} />;

  // Asked on blur of Name, TIN or Address, not on every keystroke: the answer is only useful once a
  // whole value is typed, and 35,000 customers is not a list to re-scan per character. A failed check
  // never blocks the form -- the Save is checked by the server regardless, which is where the rule lives.
  async function checkName(over = {}) {
    const q = { name: form.name, tin: form.tin, address: form.address, ...over };
    if (!String(q.name || '').trim()) { setDuplicate(null); return; }
    try {
      const { data } = await api.get('/customers/check-name', { params: { ...q, exclude_id: id || undefined } });
      setDuplicate(data.existing ? { ...data.existing, exact: data.duplicate } : null);
    } catch {
      setDuplicate(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Customer</h1>
        <Link className="btn btn-sm" to={'/customers'}>Back</Link>
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Setup Your Customer</h2>
        {error && <div className="error-banner">{error}</div>}
        {notice && <div className="muted" style={{ color: 'var(--success, #15803d)', fontWeight: 600, marginBottom: 8 }}>{notice}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0 24px' }}>
          <div>
            <div className="field">
              <label>Name</label>
              {input('name', { required: true, onBlur: (e) => checkName({ name: e.target.value }) })}
              {duplicate?.exact && (
                <div className="error-banner" style={{ marginTop: 6 }}>
                  <strong>{duplicate.name}</strong>{duplicate.customer_code ? ` (${duplicate.customer_code})` : ''} is
                  already on file with the same TIN and address. Use that customer, or enter this one's own TIN or address.{' '}
                  <Link className="link-btn" to={`/customers/${duplicate.id}/edit`}>
                    Open it
                  </Link>
                </div>
              )}
              {duplicate && !duplicate.exact && (
                <div className="muted" style={{ marginTop: 6 }}>
                  <strong>{duplicate.name}</strong>{duplicate.customer_code ? ` (${duplicate.customer_code})` : ''} already
                  has this name. Saving is fine if this is a different customer with its own TIN or address.{' '}
                  <Link className="link-btn" to={`/customers/${duplicate.id}/edit`}>
                    Open it
                  </Link>
                </div>
              )}
            </div>
            <div className="field"><label>Address</label><textarea rows={4} value={form.address ?? ''} onChange={(e) => set('address', e.target.value)} onBlur={(e) => checkName({ address: e.target.value })} /></div>
            <div className="field">
              <label>Tax Code</label>
              <select value={form.tax_id ?? ''} onChange={(e) => set('tax_id', e.target.value)}>
                <option value="" />
                {lookups.taxes.filter((t) => t.is_active !== 0).map((t) => <option key={t.id} value={t.id}>{t.code}{t.name ? ` — ${t.name}` : ''}</option>)}
              </select>
            </div>
            <div className="field"><label>TIN</label>{input('tin', { onBlur: (e) => checkName({ tin: e.target.value }) })}</div>
            <div className="field">
              <label>Business Style</label>
              <select value={form.business_style_id ?? ''} onChange={(e) => set('business_style_id', e.target.value)}>
                <option value="" />
                {lookups.styles.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
          </div>

          <div>
            <div className="field"><label>Birthdate</label>{input('birthdate', { type: 'date' })}</div>
            <div className="field">
              <label>Gender</label>
              <select value={form.gender ?? ''} onChange={(e) => set('gender', e.target.value)}>
                <option value="" /><option>Male</option><option>Female</option>
              </select>
            </div>
            <div className="field"><label>Contact No</label>{input('contact_no')}</div>
            <div className="field">
              <label>Customer Type</label>
              <select value={form.customer_type ?? ''} onChange={(e) => set('customer_type', e.target.value)}>
                <option value="" /><option>Company</option><option>Individual</option>
              </select>
            </div>
            {FLAGS.map(([k, label]) => (
              <div className="field-checkbox" key={k}>
                <input type="checkbox" id={`cust-${k}`} checked={!!form[k]} onChange={(e) => set(k, e.target.checked)} />
                <label htmlFor={`cust-${k}`}>{label}</label>
              </div>
            ))}
          </div>

          <div>
            <div className="field"><label>Credit Limit</label>{input('credit_limit', { type: 'number', step: '0.01', min: 0 })}</div>
            <div className="field">
              <label>Credit Term</label>
              <select value={form.payment_term_id ?? ''} onChange={(e) => set('payment_term_id', e.target.value)}>
                <option value="" />
                {lookups.terms.map((p) => <option key={p.id} value={p.id}>{p.term_name}</option>)}
              </select>
            </div>
            <div className="field"><label>Bill To Name</label>{input('bill_to_name')}</div>
            <div className="field"><label>Bill To Address</label>{input('bill_to_address')}</div>
            <div className="field"><label>Bill To Contact No</label>{input('bill_to_contact_no')}</div>
          </div>
        </div>

        <div className="status-tabs" style={{ marginTop: 20 }}>
          {TABS.map(([k, label]) => (
            <button type="button" key={k} className={`status-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>

        <div style={{ marginTop: 12 }}>
          {tab === 'contacts' && (
            <>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Name</th><th>Address</th><th>Email</th><th>Title</th><th>Contact Nos.</th><th>Default Contact Person</th><th>Default Bill to Contact</th><th>Approver</th><th>Certifier</th><th /></tr></thead>
                  <tbody>
                    {form.contacts.map((c, i) => (
                      <tr key={c.id || `n${i}`}>
                        <td><input value={c.contact_name ?? ''} onChange={(e) => setRow('contacts', i, 'contact_name', e.target.value)} /></td>
                        <td><input value={c.address ?? ''} onChange={(e) => setRow('contacts', i, 'address', e.target.value)} /></td>
                        <td><input type="email" value={c.email ?? ''} onChange={(e) => setRow('contacts', i, 'email', e.target.value)} /></td>
                        <td><input value={c.title ?? ''} onChange={(e) => setRow('contacts', i, 'title', e.target.value)} /></td>
                        <td><input value={c.phone ?? ''} onChange={(e) => setRow('contacts', i, 'phone', e.target.value)} /></td>
                        <td style={{ textAlign: 'center' }}><input type="checkbox" checked={!!c.is_primary} onChange={(e) => setExclusive(i, 'is_primary', e.target.checked)} /></td>
                        <td style={{ textAlign: 'center' }}><input type="checkbox" checked={!!c.is_default_bill_to} onChange={(e) => setExclusive(i, 'is_default_bill_to', e.target.checked)} /></td>
                        <td style={{ textAlign: 'center' }}><input type="checkbox" checked={!!c.is_approver} onChange={(e) => setRow('contacts', i, 'is_approver', e.target.checked)} /></td>
                        <td style={{ textAlign: 'center' }}><input type="checkbox" checked={!!c.is_certifier} onChange={(e) => setRow('contacts', i, 'is_certifier', e.target.checked)} /></td>
                        <td><button type="button" className="btn btn-sm btn-danger" onClick={() => removeRow('contacts', i)}>✕</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="button" className="btn btn-primary" style={{ marginTop: 8 }} onClick={() => addRow('contacts', EMPTY_CONTACT)}>Add Contact Person</button>
            </>
          )}

          {tab === 'addresses' && (
            <>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Address</th><th>Default</th><th /></tr></thead>
                  <tbody>
                    {form.addresses.map((a, i) => (
                      <tr key={a.id || `n${i}`}>
                        <td><input value={a.address_line ?? ''} onChange={(e) => setRow('addresses', i, 'address_line', e.target.value)} /></td>
                        <td style={{ textAlign: 'center' }}><input type="checkbox" checked={!!a.is_default} onChange={(e) => setRow('addresses', i, 'is_default', e.target.checked)} /></td>
                        <td><button type="button" className="btn btn-sm btn-danger" onClick={() => removeRow('addresses', i)}>✕</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="button" className="btn btn-primary" style={{ marginTop: 8 }} onClick={() => addRow('addresses', EMPTY_ADDRESS)}>Add Shipping Address</button>
            </>
          )}

          {tab === 'transactions' && (isNew ? <p className="muted">Save the customer first — its transactions show here.</p> : <Transactions customerId={id} reps={lookups.reps} />)}

          {tab === 'relationships' && (
            <>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Customer</th><th>Address</th><th>Contact No.</th><th /></tr></thead>
                  <tbody>
                    {form.relationships.map((r, i) => (
                      <tr key={r.id || `n${i}`}>
                        <td style={{ minWidth: 260 }}>
                          <EntityPicker
                            label="Customer"
                            items={(allCustomers || []).filter((c) => String(c.id) !== String(id)
                              && !form.relationships.some((o, j) => j !== i && String(o.related_customer_id) === String(c.id)))
                              .concat(r.related_customer_id && !(allCustomers || []).some((c) => String(c.id) === String(r.related_customer_id))
                                ? [{ id: r.related_customer_id, name: r.name }] : [])}
                            value={r.related_customer_id || ''} getLabel={(c) => c?.name}
                            columns={[{ key: 'name', label: 'Name' }, { key: 'customer_code', label: 'Code' }]} searchKeys={['name', 'customer_code']}
                            placeholder={r.related_customer_id ? r.name : (allCustomers === null ? 'Loading customers…' : '--Select customer--')}
                            onSelect={(c) => pickRelated(i, c)}
                          />
                          {!r.related_customer_id && r.name && <div className="muted" style={{ fontSize: 11 }}>Was typed as "{r.name}" -- pick the customer.</div>}
                        </td>
                        <td>{r.address || <span className="muted">—</span>}</td>
                        <td>{r.contact_no || <span className="muted">—</span>}</td>
                        <td><button type="button" className="btn btn-sm btn-danger" onClick={() => removeRow('relationships', i)}>✕</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="button" className="btn btn-primary" style={{ marginTop: 8 }} onClick={() => addRow('relationships', EMPTY_RELATIONSHIP)}>Add Relationship</button>
              <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                A Customer Payment from this customer can also be applied to the invoices of the customers listed here.
              </div>
            </>
          )}

          {tab === 'financial' && (isNew ? <p className="muted">Save the customer first — its balance shows here.</p> : <Financial customerId={id} />)}
          {tab === 'billing' && (
            <>
              {/* Who to bill / collect from, and how (2026-10-21) -- saved with the customer. */}
              <div className="table-wrap">
                <table>
                  <thead><tr>{BILLING_COLUMNS.map(([k, label]) => <th key={k}>{label}</th>)}<th /></tr></thead>
                  <tbody>
                    {form.billing_contacts.length === 0 && (
                      <tr><td colSpan={BILLING_COLUMNS.length + 1} className="muted" style={{ textAlign: 'center', padding: 12 }}>No billing / collection contacts yet.</td></tr>
                    )}
                    {form.billing_contacts.map((r, i) => (
                      <tr key={r.id || `b${i}`}>
                        {BILLING_COLUMNS.map(([k]) => (
                          <td key={k} style={{ minWidth: k === 'billing_collection' ? 150 : 130 }}>
                            {k === 'billing_collection' ? (
                              <select value={r[k] ?? ''} onChange={(e) => setRow('billing_contacts', i, k, e.target.value)}>
                                <option value="" />
                                {BILLING_COLLECTION_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                                {r[k] && !BILLING_COLLECTION_OPTIONS.includes(r[k]) && <option value={r[k]}>{r[k]}</option>}
                              </select>
                            ) : (
                              <input type={k === 'email' ? 'email' : 'text'} value={r[k] ?? ''} onChange={(e) => setRow('billing_contacts', i, k, e.target.value)} />
                            )}
                          </td>
                        ))}
                        <td><button type="button" className="btn btn-sm btn-danger" onClick={() => removeRow('billing_contacts', i)}>Delete</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="button" className="btn btn-primary" style={{ marginTop: 8 }} onClick={() => addRow('billing_contacts', EMPTY_BILLING)}>Add</button>
              <h4 style={{ margin: '20px 0 8px' }}>Open Invoices</h4>
              {isNew ? <p className="muted">Save the customer first — its open invoices show here.</p> : <Billing customerId={id} />}
            </>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          {canSave && <button type="button" className="btn btn-primary" disabled={saving} onClick={save} style={{ minWidth: 110 }}>{saving ? 'Saving…' : 'SAVE'}</button>}
        </div>
      </div>
    </div>
  );
}

function Transactions({ customerId, reps }) {
  const [f, setF] = useState({ doc_no: '', mode: 'as_of', as_of: today(), date_from: '', date_to: '', sales_rep_id: '', status: '' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  useEffect(() => {
    const t = setTimeout(() => {
      const params = { page, limit: 10, doc_no: f.doc_no || undefined, sales_rep_id: f.sales_rep_id || undefined, status: f.status || undefined };
      if (f.mode === 'as_of') params.as_of = f.as_of || undefined; else { params.date_from = f.date_from || undefined; params.date_to = f.date_to || undefined; }
      api.get(`/customers/${customerId}/transactions`, { params }).then((r) => setData(r.data)).catch(() => setData({ rows: [], total: 0 }));
    }, 300);
    return () => clearTimeout(t);
  }, [customerId, f, page]);
  const upd = (k, v) => { setPage(1); setF((x) => ({ ...x, [k]: v })); };
  const pages = data ? Math.max(1, Math.ceil(data.total / 10)) : 1;
  return (
    <>
      <div className="filter-grid" style={{ marginBottom: 8 }}>
        <div className="field"><label>Transaction #</label><input value={f.doc_no} onChange={(e) => upd('doc_no', e.target.value)} /></div>
        <div className="field">
          <label>Date</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <select value={f.mode} onChange={(e) => upd('mode', e.target.value)} style={{ maxWidth: 110 }}><option value="as_of">As of</option><option value="range">Range</option></select>
            {f.mode === 'as_of'
              ? <input type="date" value={f.as_of} onChange={(e) => upd('as_of', e.target.value)} />
              : <><input type="date" value={f.date_from} onChange={(e) => upd('date_from', e.target.value)} /><input type="date" value={f.date_to} onChange={(e) => upd('date_to', e.target.value)} /></>}
          </div>
        </div>
        <div className="field">
          <label>Sales Rep</label>
          <select value={f.sales_rep_id} onChange={(e) => upd('sales_rep_id', e.target.value)}>
            <option value="">All</option>
            {reps.map((r) => <option key={r.id} value={r.id}>{r.first_name} {r.last_name}</option>)}
          </select>
        </div>
        <div className="field"><label>Status</label><input value={f.status} onChange={(e) => upd('status', e.target.value)} /></div>
      </div>
      {!data ? <LoadingSpinner /> : (
        <>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Transaction #</th><th>Type</th><th>Date</th><th>Sales Rep</th><th>Status</th><th className="text-right">Amount</th></tr></thead>
              <tbody>
                {data.rows.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 16 }}>No transactions.</td></tr>}
                {data.rows.map((r) => (
                  <tr key={`${r.doc_type}-${r.id}`}>
                    <td>{r.doc_no}</td><td>{r.doc_type}</td><td>{displayDate(r.doc_date)}</td><td>{r.sales_rep_name || ''}</td>
                    <td>{String(r.status || '').replace(/_/g, ' ')}</td><td className="text-right">{money(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 8, alignItems: 'center' }}>
            <span className="muted">{data.total.toLocaleString()} transaction{data.total === 1 ? '' : 's'}</span>
            <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(1)}>«</button>
            <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
            <span>{page} / {pages}</span>
            <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
            <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(pages)}>»</button>
          </div>
        </>
      )}
    </>
  );
}

// Shared with the customer view page (CustomerView.jsx), read-only there.
export function Financial({ customerId }) {
  const [d, setD] = useState(null);
  useEffect(() => { api.get(`/customers/${customerId}/financial`).then((r) => setD(r.data)).catch(() => setD({})); }, [customerId]);
  if (!d) return <LoadingSpinner />;
  const item = (label, value, strong) => (
    <div><span className="muted">{label}</span><div className={strong ? 'hi-lg' : undefined} style={{ fontWeight: strong ? 700 : 500 }}>{value}</div></div>
  );
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
      {item('Credit Limit', d.credit_limit ? money(d.credit_limit) : 'None set')}
      {item('Credit Term', d.credit_term || '—')}
      {item('Outstanding Balance', money(d.balance), true)}
      {item('Overdue', money(d.overdue))}
      {item('Available Credit', d.available_credit == null ? '—' : money(d.available_credit))}
      {item('Open Invoices', (d.open_invoices || 0).toLocaleString())}
      {item('Unapplied Payments', money(d.unapplied_payments))}
      {item('Last Payment', d.last_payment ? `${money(d.last_payment.payment_amount)} on ${displayDate(d.last_payment.date_created)}` : '—')}
      {item('Sales This Year', money(d.sales_this_year))}
    </div>
  );
}

export function Billing({ customerId }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get(`/customers/${customerId}/open-invoices`).then((r) => setRows(r.data)).catch(() => setRows([])); }, [customerId]);
  if (!rows) return <LoadingSpinner />;
  const total = rows.reduce((s, r) => s + Number(r.amount_due || 0), 0);
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Invoice #</th><th>BS/SI #</th><th>Date</th><th>Due Date</th><th className="text-right">Days Overdue</th><th className="text-right">Gross</th><th className="text-right">Amount Due</th><th>Collection Forecast</th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 16 }}>No open invoices.</td></tr>}
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.invoice_no}</td><td>{r.bs_si_no || ''}</td><td>{displayDate(r.date_created)}</td><td>{displayDate(r.date_due)}</td>
              <td className="text-right" style={Number(r.days_overdue) > 0 ? { color: 'var(--danger, #b91c1c)' } : undefined}>{Number(r.days_overdue) > 0 ? r.days_overdue : ''}</td>
              <td className="text-right">{money(r.gross_amount)}</td><td className="text-right">{money(r.amount_due)}</td>
              <td>{r.collection_forecast_date ? displayDate(r.collection_forecast_date) : ''}</td>
            </tr>
          ))}
          {rows.length > 0 && <tr style={{ fontWeight: 700 }}><td colSpan={6}>Total</td><td className="text-right">{money(total)}</td><td /></tr>}
        </tbody>
      </table>
    </div>
  );
}
