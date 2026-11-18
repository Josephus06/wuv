import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import MergePartyModal from '../components/MergePartyModal';

const EMPTY = {
  supplier_code: '', name: '', company_name: '', tin: '', payment_term_id: '', is_active: true,
  address: '', contact_no: '', mobile_no: '', office_no: '', fax_no: '', email: '',
  credit_term: '', term_days: '', credit_limit: '', payee_name: '', bank_name: '', bank_account_name: '',
  bank_account_no: '',
};
const EMPTY_CONTACT = { contact_name: '', title: '', email: '', phone: '', is_primary: false };
const EMPTY_ADDRESS = { address_line: '', is_default: false };

export default function Suppliers() {
  const { can, user } = useAuth();
  const [merging, setMerging] = useState(false);
  const [rows, setRows] = useState([]);
  const [paymentTerms, setPaymentTerms] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [newContact, setNewContact] = useState(EMPTY_CONTACT);
  const [newAddress, setNewAddress] = useState(EMPTY_ADDRESS);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  // Period From / As of Date: inclusive bounds on the day the supplier was created (created_at).
  const [dateFrom, setDateFrom] = useState('');
  const [asOf, setAsOf] = useState('');

  // The filters as the server takes them -- for the Extract, which builds its file server-side
  // under the same rules the list below applies in the browser.
  function listParams() {
    const params = {};
    if (search.trim()) params.search = search.trim();
    if (dateFrom) params.date_from = dateFrom;
    if (asOf) params.as_of = asOf;
    return params;
  }

  // Extract: every supplier under the filters above, as a workbook.
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  async function runExport() {
    setExporting(true); setExportError('');
    try {
      const { data } = await api.get('/suppliers/export', { params: listParams(), responseType: 'blob' });
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url; a.download = 'suppliers.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setExportError('Could not extract the suppliers.');
    } finally {
      setExporting(false);
    }
  }

  async function load() {
    setLoading(true);
    const [s, pt] = await Promise.all([api.get('/suppliers'), api.get('/lookups/payment-terms')]);
    setRows(s.data);
    setPaymentTerms(pt.data);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function openCreate() {
    setForm(EMPTY);
    setEditing('new');
    setError('');
  }

  async function openEdit(row) {
    const { data } = await api.get(`/suppliers/${row.id}`);
    // Every key in EMPTY, filled from the record -- so a field the supplier has no value for still
    // renders as a controlled empty input rather than an uncontrolled one.
    setForm(Object.fromEntries(Object.keys(EMPTY).map((k) => (
      k === 'is_active' ? [k, !!data.is_active] : [k, data[k] ?? '']
    ))));
    setEditing(data);
    setNewContact(EMPTY_CONTACT);
    setNewAddress(EMPTY_ADDRESS);
    setError('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const payload = { ...form, payment_term_id: form.payment_term_id || null };
    try {
      if (editing === 'new') {
        await api.post('/suppliers', payload);
        setEditing(null);
      } else {
        // The values as this form loaded them: the server writes only what was changed here, and
        // refuses a change to a field someone else has changed since (a stale tab).
        const original = Object.fromEntries(Object.keys(EMPTY).map((k) => [k, editing[k] ?? null]));
        await api.put(`/suppliers/${editing.id}`, { ...payload, _original: original });
        await openEdit(editing);
      }
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    }
  }

  async function handleDelete(row) {
    if (!confirm(`Delete supplier "${row.name}"?`)) return;
    try {
      await api.delete(`/suppliers/${row.id}`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Delete failed');
    }
  }

  async function addContact() {
    if (!newContact.contact_name) return;
    await api.post(`/suppliers/${editing.id}/contacts`, newContact);
    setNewContact(EMPTY_CONTACT);
    openEdit(editing);
  }

  async function removeContact(contactId) {
    await api.delete(`/suppliers/${editing.id}/contacts/${contactId}`);
    openEdit(editing);
  }

  async function addAddress() {
    if (!newAddress.address_line) return;
    await api.post(`/suppliers/${editing.id}/addresses`, newAddress);
    setNewAddress(EMPTY_ADDRESS);
    openEdit(editing);
  }

  async function removeAddress(addressId) {
    await api.delete(`/suppliers/${editing.id}/addresses/${addressId}`);
    openEdit(editing);
  }

  // Filtered here rather than on the server: the endpoint hands back the whole list in one array
  // and seven other pages rely on that shape for their supplier dropdowns. With 1,700-odd
  // suppliers after the live import, ten to a page, this box is the only practical way to reach
  // one -- paging to it would mean 170-odd pages.
  // The same rules as listFilter() in server/src/routes/suppliers.js, which the Extract uses --
  // keep the two in step. created_at arrives as 'YYYY-MM-DD HH:MM:SS' (dateStrings), so its first
  // ten characters are the day, comparable as a string.
  const filtering = !!(search.trim() || dateFrom || asOf);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q && !dateFrom && !asOf) return rows;
    return rows.filter((r) => {
      const created = String(r.created_at || '').slice(0, 10);
      if (dateFrom && (!created || created < dateFrom)) return false;
      if (asOf && (!created || created > asOf)) return false;
      if (!q) return true;
      return ['supplier_code', 'name', 'company_name', 'tin', 'address', 'contact_no', 'mobile_no', 'email']
        .some((f) => String(r[f] || '').toLowerCase().includes(q));
    });
  }, [rows, search, dateFrom, asOf]);

  const columns = [
    { key: 'supplier_code', label: 'Code' },
    { key: 'name', label: 'Name', render: (r) => <Link to={`/suppliers/${r.id}`}>{r.name}</Link> },
    { key: 'company_name', label: 'Company' },
    { key: 'contact_no', label: 'Contact' },
    // Imported suppliers carry live's free-text credit term and no payment_terms row to point at,
    // so the column falls back to the text rather than showing 820 blanks.
    { key: 'payment_term_name', label: 'Payment Term', render: (r) => r.payment_term_name || r.credit_term || '' },
    { key: 'is_active', label: 'Status', render: (r) => (r.is_active ? <span className="badge badge-success">Active</span> : <span className="badge badge-muted">Inactive</span>) },
  ];

  return (
    <div>
      <div className="page-header">
        <h1>Suppliers</h1>
        {can('/suppliers', 'can_add') && <button className="btn btn-primary" onClick={openCreate}>Add Supplier</button>}
        {/* System Admin only, as the server is: a merge cannot be undone. */}
        {user?.account_type === 'System Admin' && (
          <button type="button" className="btn" style={{ marginLeft: 8 }} onClick={() => setMerging(true)}>Merge Suppliers</button>
        )}
      </div>
      {merging && (
        <MergePartyModal kind="supplier" items={rows} onClose={() => setMerging(false)}
          onMerged={() => { setMerging(false); load(); }} />
      )}
      <div className="card">
        {/* The filters apply as you type; Search (or Enter) re-reads the list from the server so
            suppliers added elsewhere since the page opened show up too. */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '1 1 300px', maxWidth: 380 }}>
            <label>Search</label>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load()}
              placeholder="Name, code, company, TIN, contact or address..."
            />
          </div>
          <div className="field">
            <label>Period From</label>
            <input type="date" value={dateFrom} max={asOf || undefined} onChange={(e) => setDateFrom(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} />
          </div>
          <div className="field">
            <label>As of Date</label>
            <input type="date" value={asOf} min={dateFrom || undefined} onChange={(e) => setAsOf(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} />
          </div>
        </div>
        <div style={{ marginTop: 4, marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={load}>Search</button>
          <button className="btn" disabled={exporting} onClick={runExport} title="Download every supplier under the filters above">
            {exporting ? 'Extracting...' : 'Extract'}
          </button>
          {exportError && <span style={{ color: 'var(--danger)' }}>{exportError}</span>}
        </div>
        {!loading && (
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            {filtering ? `${visible.length} of ${rows.length} suppliers` : `${rows.length} suppliers`}
          </div>
        )}
        {loading ? <LoadingSpinner /> : (
          <DataTable
            paginate
            columns={columns}
            rows={visible}
            actions={(row) => (
              <>
                {can('/suppliers', 'can_edit') && <button className="btn btn-sm" onClick={() => openEdit(row)}>Edit</button>}
                {can('/suppliers', 'can_delete') && <button className="btn btn-sm btn-danger" onClick={() => handleDelete(row)}>Delete</button>}
              </>
            )}
          />
        )}
      </div>

      {editing && (
        <Modal title={editing === 'new' ? 'Add Supplier' : `Edit Supplier — ${editing.name}`} onClose={() => setEditing(null)} large>
          <form onSubmit={handleSubmit}>
            {error && <div className="error-banner">{error}</div>}
            <div className="field-row">
              <div className="field">
                <label>Supplier Code</label>
                <input value={form.supplier_code} onChange={(e) => setForm({ ...form, supplier_code: e.target.value })} />
              </div>
              <div className="field">
                <label>Name</label>
                <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Company Name</label>
                <input value={form.company_name} onChange={(e) => setForm({ ...form, company_name: e.target.value })} />
              </div>
              <div className="field">
                <label>TIN</label>
                <input value={form.tin} onChange={(e) => setForm({ ...form, tin: e.target.value })} />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Payment Term</label>
                <select value={form.payment_term_id} onChange={(e) => setForm({ ...form, payment_term_id: e.target.value })}>
                  <option value="">—</option>
                  {paymentTerms.map((p) => <option key={p.id} value={p.id}>{p.term_name}</option>)}
                </select>
              </div>
              <div className="field field-checkbox" style={{ alignSelf: 'center', marginTop: 18 }}>
                <input type="checkbox" id="sup-active" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
                <label htmlFor="sup-active">Active</label>
              </div>
            </div>
            {/* Everything below came across from the live system with the supplier import. The
                `address` box here is live's single address line; the Addresses list further down
                is this system's own multi-address table and is kept separate on purpose. */}
            <div className="subsection">
              <h3>Contact Details</h3>
              <div className="field">
                <label>Address</label>
                <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Contact No.</label>
                  <input value={form.contact_no} onChange={(e) => setForm({ ...form, contact_no: e.target.value })} />
                </div>
                <div className="field">
                  <label>Mobile No.</label>
                  <input value={form.mobile_no} onChange={(e) => setForm({ ...form, mobile_no: e.target.value })} />
                </div>
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Office No.</label>
                  <input value={form.office_no} onChange={(e) => setForm({ ...form, office_no: e.target.value })} />
                </div>
                <div className="field">
                  <label>Fax No.</label>
                  <input value={form.fax_no} onChange={(e) => setForm({ ...form, fax_no: e.target.value })} />
                </div>
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Email</label>
                  <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                </div>
                <div className="field" />
              </div>
            </div>

            <div className="subsection">
              <h3>Credit Terms</h3>
              <div className="field-row">
                <div className="field">
                  {/* Free text, matching live -- "30 DAYS", "50%DP - 50%DLVRY" and so on. The
                      Payment Term dropdown above is this system's own lookup; a supplier can
                      carry either, and the list shows the dropdown value in preference. */}
                  <label>Credit Term</label>
                  <input value={form.credit_term} onChange={(e) => setForm({ ...form, credit_term: e.target.value })} />
                </div>
                <div className="field">
                  <label>Term (days)</label>
                  <input type="number" min="0" value={form.term_days} onChange={(e) => setForm({ ...form, term_days: e.target.value })} />
                </div>
                <div className="field">
                  <label>Credit Limit</label>
                  {/* How much this supplier lets us owe. Blank means none agreed, which is not the
                      same as zero -- blankToNull on the server keeps the two apart. */}
                  <input
                    type="number" min="0" step="0.01" value={form.credit_limit ?? ''}
                    onChange={(e) => setForm({ ...form, credit_limit: e.target.value })}
                  />
                </div>
              </div>
            </div>

            <div className="subsection">
              <h3>Payee &amp; Bank</h3>
              <div className="field-row">
                <div className="field">
                  <label>Payee Name</label>
                  <input value={form.payee_name} onChange={(e) => setForm({ ...form, payee_name: e.target.value })} />
                </div>
                <div className="field">
                  <label>Bank Name</label>
                  <input value={form.bank_name} onChange={(e) => setForm({ ...form, bank_name: e.target.value })} />
                </div>
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Bank Account Name</label>
                  <input value={form.bank_account_name} onChange={(e) => setForm({ ...form, bank_account_name: e.target.value })} />
                </div>
                <div className="field">
                  <label>Bank Account No.</label>
                  <input value={form.bank_account_no} onChange={(e) => setForm({ ...form, bank_account_no: e.target.value })} />
                </div>
              </div>
            </div>

            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setEditing(null)}>Close</button>
              <button type="submit" className="btn btn-primary">Save</button>
            </div>
          </form>

          {editing !== 'new' && (
            <>
              <div className="subsection">
                <h3>Contacts</h3>
                <DataTable
                  columns={[
                    { key: 'contact_name', label: 'Name' },
                    { key: 'title', label: 'Title' },
                    { key: 'email', label: 'Email' },
                    { key: 'phone', label: 'Phone' },
                  ]}
                  rows={editing.contacts || []}
                  actions={(c) => <button className="btn btn-sm btn-danger" onClick={() => removeContact(c.id)}>Remove</button>}
                  emptyLabel="No contacts yet."
                />
                <div className="inline-form" style={{ marginTop: 10 }}>
                  <div className="field">
                    <label>Name</label>
                    <input value={newContact.contact_name} onChange={(e) => setNewContact({ ...newContact, contact_name: e.target.value })} />
                  </div>
                  <div className="field">
                    <label>Title</label>
                    <input value={newContact.title} onChange={(e) => setNewContact({ ...newContact, title: e.target.value })} />
                  </div>
                  <div className="field">
                    <label>Email</label>
                    <input value={newContact.email} onChange={(e) => setNewContact({ ...newContact, email: e.target.value })} />
                  </div>
                  <div className="field">
                    <label>Phone</label>
                    <input value={newContact.phone} onChange={(e) => setNewContact({ ...newContact, phone: e.target.value })} />
                  </div>
                  <button type="button" className="btn" onClick={addContact}>Add</button>
                </div>
              </div>

              <div className="subsection">
                <h3>Addresses</h3>
                <DataTable
                  columns={[{ key: 'address_line', label: 'Address' }]}
                  rows={editing.addresses || []}
                  actions={(a) => <button className="btn btn-sm btn-danger" onClick={() => removeAddress(a.id)}>Remove</button>}
                  emptyLabel="No addresses yet."
                />
                <div className="inline-form" style={{ marginTop: 10 }}>
                  <div className="field">
                    <label>Address</label>
                    <input value={newAddress.address_line} onChange={(e) => setNewAddress({ ...newAddress, address_line: e.target.value })} />
                  </div>
                  <button type="button" className="btn" onClick={addAddress}>Add</button>
                </div>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
