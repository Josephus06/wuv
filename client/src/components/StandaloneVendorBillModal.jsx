import { useEffect, useState } from 'react';
import api from '../api/client';
import EntityPicker from './EntityPicker';
import LoadingSpinner from './LoadingSpinner';

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
// A line's Amount is net of VAT; tax is added on top and withholding taken on the net -- the source
// bills the same way (VB-24532: 2,223.21 + 266.79 VAT = 2,490.00, 2% withheld = 44.46). A preview
// only: the server recomputes every figure on save.
function lineAmounts(l, taxRate, wtaxRate) {
  const net = round2(Number(l.amount || 0));
  // A typed Tax Amount (tax_typed) stands; otherwise Net x the tax code's rate.
  const taxTyped = l.tax_typed !== undefined && l.tax_typed !== '';
  const tax = taxTyped ? round2(Number(l.tax_typed)) : round2(net * (Number(taxRate || 0) / 100));
  const gross = round2(net + tax);
  const wtax = l.is_withhold ? round2(net * (Number(wtaxRate || 0) / 100)) : 0;
  return { net, tax, gross, wtax, due: round2(gross - wtax) };
}
const blankLine = () => ({ key: Math.random().toString(36).slice(2), account: null, description: '', department_id: '', amount: '', tax_code_id: '', is_withhold: false });

// Create New on the Vendor Bills list: a supplier's bill with no Purchase Order behind it -- rent,
// utilities, freight, professional fees. Laid out as the source's Vendor Bill > Create screen:
// header, an Expenses tab of account lines, and a Withholding Tax tab. Each line debits its
// account; the bill credits the header Account (Accounts Payable - Trade unless changed) and is
// paid through Bill Payment like any other.
// `replicateFrom` is a vendor bill id to start from -- Replicate on the Vendor Bill view, the same
// move the Journal screen has had. Everything that describes the EXPENSE is copied (vendor, A/P
// account, term, office location, withholding tax, memo and every line); everything that belongs
// to the original document is not. It is dated today, it takes its own VB- number on save, and
// Reference # starts empty because that is the SUPPLIER's own bill number -- copying it would file
// two of ours against one of theirs.
//
// Prepared By needs no handling here, which is the point: nothing in this modal sets it. The bill
// is created through the ordinary POST /vendor-bills, which stamps created_by_user_id from the
// session, so a replica is prepared by whoever replicated it rather than by whoever raised the
// original.
//
// `fromLiquidation` is an approved Liquidation or Request for Payment (the form as GET /forms/:id
// returns it; an RFP's items carry no account, so Accounting picks each line's) -- Create
// Vendor Bill on the form. Its items become the expense lines (each item's account, particulars and
// amount, under the filer's department), the form's credit account is the header Account (13305
// Advances To Employees - For Liquidation unless AP chose another) and the filer is the vendor. The
// bill is saved with form_request_id so the form shows it and cannot be billed twice.
export default function StandaloneVendorBillModal({ onClose, onSaved, replicateFrom, fromLiquidation }) {
  const [replicatedFrom, setReplicatedFrom] = useState('');
  const [meta, setMeta] = useState(null);
  const [locations, setLocations] = useState([]);
  const [paymentTerms, setPaymentTerms] = useState([]);
  const [supplier, setSupplier] = useState(null);
  const [apAccount, setApAccount] = useState(null);
  const [dateCreated, setDateCreated] = useState(new Date().toISOString().slice(0, 10));
  const [dateDue, setDateDue] = useState(new Date().toISOString().slice(0, 10));
  const [paymentTerm, setPaymentTerm] = useState(null);
  const [term, setTerm] = useState('');
  const [referenceNo, setReferenceNo] = useState('');
  const [officeLocation, setOfficeLocation] = useState(null);
  const [memo, setMemo] = useState('');
  const [wtaxId, setWtaxId] = useState('');
  const [tab, setTab] = useState('expenses');
  const [lines, setLines] = useState([blankLine()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.get('/vendor-bills/standalone-meta'), api.get('/lookups/locations'), api.get('/lookups/payment-terms')])
      .then(([m, loc, terms]) => {
        setMeta(m.data);
        setLocations(loc.data);
        setPaymentTerms(terms.data || []);
        if (m.data.ap_account) setApAccount(m.data.ap_account);
        if (replicateFrom) prefillFrom(m.data, loc.data, terms.data || []);
        else if (fromLiquidation) prefillFromLiquidation(m.data, loc.data, terms.data || []);
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not load the form.'));
  }, [replicateFrom, fromLiquidation]); // eslint-disable-line react-hooks/exhaustive-deps

  function prefillFromLiquidation(metaData, locs, terms) {
    const f = fromLiquidation;
    const findAcct = (id) => (metaData.accounts || []).find((a) => String(a.id) === String(id)) || null;
    const sup = (metaData.suppliers || []).find((x) => String(x.id) === String(f.vendor_bill_supplier_id)) || null;
    if (sup) {
      setSupplier(sup);
      const t = terms.find((x) => x.term_name === sup.term_name) || null;
      setPaymentTerm(t);
      setTerm(t ? t.term_name : (sup.term_name || ''));
      const days = t ? Number(t.no_of_days) : (sup.no_of_days != null ? Number(sup.no_of_days) : null);
      if (days != null) setDateDue(addDays(new Date().toISOString().slice(0, 10), days || 0));
    }
    // A Request for Payment (2026-10-12) is an ordinary payable: Accounts Payable - Trade, with its
    // Payable To in the memo. A liquidation clears the employee's advance (13305 unless AP chose
    // another credit account on the form).
    const isRfp = f.type === 'payment';
    setApAccount(isRfp
      ? (metaData.ap_account || null)
      : ((f.credit_account_id && findAcct(f.credit_account_id))
        || (metaData.accounts || []).find((a) => a.account_code === '13305') || metaData.ap_account || null));
    setOfficeLocation(locs.find((l) => /head office/i.test(l.location_name || '')) || null);
    setMemo(isRfp
      ? `Request for Payment ${f.request_no}${f.detail?.payable_to ? ` -- ${f.detail.payable_to}` : ''}`
      : `Liquidation ${f.request_no}${f.name ? ` -- ${f.name}` : ''}`);
    // A liquidation's bill goes under the department of whoever filed it (2026-10-28), off their
    // employee record; the form's own Department only when they have none.
    const isDept = (id) => id && (metaData.departments || []).some((d) => String(d.id) === String(id));
    const deptId = !isRfp && isDept(f.owner_department_id) ? f.owner_department_id : (isDept(f.department_id) ? f.department_id : '');
    // Only the items not on a bill yet: a liquidation can be split across bills by item (2026-10-12).
    // Each line remembers its item, so removing a line leaves that item for another bill.
    const copied = (f.items || []).filter((it) => Number(it.amount) && !f.billed_items?.[it.id]).map((it) => ({
      ...blankLine(),
      form_request_item_id: it.id,
      account: findAcct(it.cogs_account_id)
        || (it.cogs_account_id ? { id: it.cogs_account_id, account_code: it.cogs_account_code, account_name: it.cogs_account_name } : null),
      description: it.particulars || '',
      department_id: deptId ? String(deptId) : '',
      amount: String(Number(it.amount)),
    }));
    if (copied.length) setLines(copied);
  }

  // Run only once the lookups are in hand: the pickers hold whole records, not ids, so each one
  // has to be found in the list it is chosen from.
  async function prefillFrom(metaData, locs, terms) {
    try {
      const { data: vb } = await api.get(`/vendor-bills/${replicateFrom}`);
      setReplicatedFrom(vb.bill_no);
      setSupplier((metaData.suppliers || []).find((x) => String(x.id) === String(vb.supplier_id)) || null);
      if (vb.account_id) {
        setApAccount((metaData.accounts || []).find((a) => String(a.id) === String(vb.account_id))
          || { id: vb.account_id, account_code: vb.account_code, account_name: vb.account_name });
      }
      setOfficeLocation(locs.find((l) => String(l.id) === String(vb.office_location_id)) || null);
      const t = terms.find((x) => x.term_name === vb.term) || null;
      setPaymentTerm(t);
      setTerm(vb.term || '');
      // Today's date with the ORIGINAL's term: a 30-day bill replicated today falls due in 30
      // days' time, not on the date the first one did.
      if (t) setDateDue(addDays(new Date().toISOString().slice(0, 10), Number(t.no_of_days) || 0));
      setMemo(vb.memo || '');
      setWtaxId(vb.wtax_id || '');
      const copied = (vb.lines || []).map((l) => ({
        ...blankLine(),
        account: (metaData.accounts || []).find((a) => String(a.id) === String(l.account_id))
          || (l.account_id ? { id: l.account_id, account_code: l.line_account_code, account_name: l.line_account_name } : null),
        description: l.description || '',
        department_id: l.department_id || '',
        // net_of_tax is the figure this form calls Amount -- tax is added on top of it, so taking
        // the gross back would inflate the replica by one VAT every time it was copied.
        amount: Number(l.net_of_tax) ? String(Number(l.net_of_tax)) : '',
        tax_code_id: l.tax_code_id || '',
        is_withhold: !!l.is_withhold,
      }));
      if (copied.length) setLines(copied);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load the bill to replicate.');
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
  const wtax = meta.wtaxes.find((w) => String(w.id) === String(wtaxId));
  const wtaxRate = Number(wtax?.rate || 0);
  const priced = lines.map((l) => ({ ...l, amt: lineAmounts(l, taxRate(l.tax_code_id), wtaxRate) }));
  const sum = (k) => priced.reduce((s, l) => s + l.amt[k], 0);
  // A new Amount or tax code puts the tax back on Net x rate.
  const setLine = (key, patch) => setLines((ls) => ls.map((l) => {
    if (l.key !== key) return l;
    const next = { ...l, ...patch };
    if (('amount' in patch || 'tax_code_id' in patch) && !('tax_typed' in patch)) next.tax_typed = undefined;
    return next;
  }));
  const allWithheld = lines.length > 0 && lines.every((l) => l.is_withhold);
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

  function pickSupplier(s) {
    setSupplier(s);
    const t = s ? paymentTerms.find((x) => norm(x.term_name) === norm(s.term_name)) : null;
    setPaymentTerm(t || null);
    setTerm(t ? t.term_name : (s?.term_name || ''));
    const days = t ? Number(t.no_of_days) : (s && s.no_of_days != null ? Number(s.no_of_days) : null);
    if (days != null) setDateDue(addDays(dateCreated, days || 0));
  }

  async function handleSave() {
    setError('');
    if (!supplier) { setError('Choose a vendor.'); return; }
    const payload = lines.filter((l) => l.account || l.description.trim() || Number(l.amount));
    if (!payload.length) { setError('Add at least one expense.'); return; }
    const noAcct = payload.findIndex((l) => !l.account);
    if (noAcct >= 0) { setError(`Choose an account on expense ${noAcct + 1}.`); setTab('expenses'); return; }
    const noDept = payload.findIndex((l) => !l.department_id);
    if (noDept >= 0) { setError(`Choose a department on expense ${noDept + 1}.`); setTab('expenses'); return; }
    if (payload.some((l) => l.is_withhold) && !wtaxId) { setError('Choose the withholding tax on the Withholding Tax tab.'); setTab('wtax'); return; }
    setSaving(true);
    try {
      const { data: vb } = await api.post('/vendor-bills', {
        supplier_id: supplier.id,
        account_id: apAccount?.id || null,
        date_created: dateCreated,
        date_due: dateDue,
        term,
        reference_no: referenceNo,
        office_location_id: officeLocation?.id || null,
        memo,
        wtax_id: wtaxId || null,
        form_request_id: fromLiquidation?.id || null,
        ...(fromLiquidation ? { form_request_item_ids: [...new Set(payload.map((l) => l.form_request_item_id).filter(Boolean))] } : {}),
        lines: payload.map((l) => ({
          account_id: l.account.id, form_request_item_id: l.form_request_item_id || null, description: l.description, department_id: Number(l.department_id),
          qty: 1, unit_price: Number(l.amount || 0), tax_code_id: l.tax_code_id || null, is_withhold: l.is_withhold,
          tax_amount: l.tax_typed !== undefined && l.tax_typed !== '' ? Number(l.tax_typed) : undefined,
        })),
      });
      onSaved(vb);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  const postable = meta.accounts;
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-xl" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="estimate-banner" style={{ borderRadius: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <h2 style={{ margin: 0, color: '#fff' }}>
            Vendor Bill — Create
            {replicatedFrom && <span style={{ fontSize: '0.6em', opacity: 0.85, marginLeft: 10 }}>replicated from {replicatedFrom}</span>}
            {fromLiquidation && <span style={{ fontSize: '0.6em', opacity: 0.85, marginLeft: 10 }}>from {fromLiquidation.request_no}</span>}
          </h2>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 24, lineHeight: 1, cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ padding: 24 }}>
          {error && <div className="error-banner">{error}</div>}

          <div className="review-grid" style={{ gridTemplateColumns: '1fr 1fr 280px' }}>
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="field">
                  <label>Date</label>
                  <input type="date" value={dateCreated} onChange={(e) => {
                    setDateCreated(e.target.value);
                    if (paymentTerm && e.target.value) setDateDue(addDays(e.target.value, Number(paymentTerm.no_of_days) || 0));
                  }} />
                </div>
                <div className="field"><label>Date Due</label><input type="date" value={dateDue} onChange={(e) => setDateDue(e.target.value)} /></div>
              </div>
              <div className="field">
                <label>Vendor</label>
                <EntityPicker
                  label="Vendor" items={meta.suppliers} value={supplier?.id || ''} getLabel={(s) => s.name}
                  columns={[{ key: 'name', label: 'Name' }, { key: 'supplier_code', label: 'Code' }, { key: 'tin', label: 'TIN' }]}
                  searchKeys={['name', 'supplier_code', 'tin']} placeholder="Select Vendor..." onSelect={pickSupplier}
                />
              </div>
              <div className="field">
                <label>Account</label>
                <EntityPicker
                  label="Account" items={postable} value={apAccount?.id || ''} getLabel={(a) => a.account_name}
                  columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Account' }, { key: 'account_type', label: 'Type' }]}
                  searchKeys={['account_code', 'account_name']} onSelect={setApAccount}
                />
              </div>
              <div className="field"><label>Reference #</label><input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} /></div>
            </div>
            <div>
              <div className="field">
                <label>Office Location</label>
                <EntityPicker
                  label="Office Location" items={locations} value={officeLocation?.id || ''} getLabel={(l) => l.location_name}
                  columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']} onSelect={setOfficeLocation}
                />
              </div>
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
              <div className="field"><label>Memo</label><textarea rows={4} value={memo} onChange={(e) => setMemo(e.target.value)} /></div>
            </div>
            <div className="card" style={{ background: 'var(--surface-2, #f3f4f6)' }}>
              {[
                ['Sub Total', sum('net')], ['Discount Amount', 0], ['Net of Tax', sum('net')], ['Tax Amount', sum('tax')],
                ['Gross Amount', sum('gross')], ['Withholding Tax Amount', sum('wtax')], ['Amount', sum('gross')],
              ].map(([label, v]) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">{label}</span><span className="hi">{money(v)}</span></div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}><span>Amount Due</span><span>{money(sum('due'))}</span></div>
            </div>
          </div>

          <div className="status-tabs" style={{ marginTop: 20 }}>
            <button type="button" className={`status-tab ${tab === 'expenses' ? 'active' : ''}`} onClick={() => setTab('expenses')}>Expenses</button>
            <button type="button" className={`status-tab ${tab === 'wtax' ? 'active' : ''}`} onClick={() => setTab('wtax')}>Withholding Tax{wtax ? ` (${wtax.code} ${Number(wtax.rate)}%)` : ''}</button>
          </div>

          {tab === 'expenses' && (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th style={{ minWidth: 160 }}>Account Code</th><th>Account Title</th><th style={{ minWidth: 200 }}>Description</th><th>Department *</th>
                      <th>Amount (net of VAT)</th><th>Tax Code</th><th>Tax Amount</th><th>Gross Amount</th>
                      <th>
                        Apply Withholding Tax{' '}
                        <input type="checkbox" checked={allWithheld} title="Apply to every line"
                          onChange={(e) => setLines((ls) => ls.map((l) => ({ ...l, is_withhold: e.target.checked })))} />
                      </th>
                      <th>Withholding Tax Amount</th><th>Amount Due</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {priced.map((l) => (
                      <tr key={l.key}>
                        <td>
                          <EntityPicker
                            label="Account" items={postable} value={l.account?.id || ''} getLabel={(a) => a.account_code}
                            columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Account' }, { key: 'account_type', label: 'Type' }]}
                            searchKeys={['account_code', 'account_name']} placeholder="Select..."
                            onSelect={(a) => setLine(l.key, { account: a })}
                          />
                        </td>
                        <td>{l.account?.account_name || ''}</td>
                        <td><input value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} /></td>
                        <td>
                          <select value={l.department_id} onChange={(e) => setLine(l.key, { department_id: e.target.value })}>
                            <option value="">Select Department</option>
                            {meta.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                          </select>
                        </td>
                        <td><input type="number" step="any" style={{ width: 120 }} value={l.amount} onChange={(e) => setLine(l.key, { amount: e.target.value })} /></td>
                        <td>
                          <select value={l.tax_code_id} onChange={(e) => setLine(l.key, { tax_code_id: e.target.value })}>
                            <option value="">Select Tax</option>
                            {meta.taxes.map((t) => <option key={t.id} value={t.id}>{t.code} ({Number(t.rate)}%)</option>)}
                          </select>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <input type="number" step="0.01" style={{ width: 100 }} title="Tax for this line -- Net x the tax code's rate unless typed"
                            value={l.tax_typed !== undefined ? l.tax_typed : l.amt.tax} onChange={(e) => setLine(l.key, { tax_typed: e.target.value })} />
                        </td>
                        <td style={{ textAlign: 'right' }}>{money(l.amt.gross)}</td>
                        <td style={{ textAlign: 'center' }}>
                          <input type="checkbox" checked={l.is_withhold} onChange={(e) => setLine(l.key, { is_withhold: e.target.checked })} />
                        </td>
                        <td style={{ textAlign: 'right' }}>{money(l.amt.wtax)}</td>
                        <td style={{ textAlign: 'right' }}>{money(l.amt.due)}</td>
                        <td>{lines.length > 1 && <button type="button" className="btn btn-sm btn-danger" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>Delete</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 8 }} onClick={() => setLines((ls) => [...ls, blankLine()])}>Add Expense</button>
            </>
          )}

          {tab === 'wtax' && (
            <div className="field" style={{ maxWidth: 720 }}>
              <label>Withholding Tax (applied to the lines ticked "Apply Withholding Tax")</label>
              <select value={wtaxId} onChange={(e) => setWtaxId(e.target.value)}>
                <option value="">None</option>
                {meta.wtaxes.map((w) => <option key={w.id} value={w.id}>{w.code} — {Number(w.rate)}% — {w.name}</option>)}
              </select>
            </div>
          )}

          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>Back to Lists</button>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? 'Saving...' : 'SAVE'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
