import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDate } from '../utils/dates';
import { lineDepartmentError } from '../utils/requireDepartment';

function money(v) { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'; }
function today() { return new Date().toISOString().slice(0, 10); }
const PAYEE_TYPES = [{ v: 'VENDOR', l: 'Vendor' }, { v: 'CUSTOMER', l: 'Customer' }, { v: 'EMPLOYEE', l: 'Employee' }];
// Cheques imported before the fix stored these lower-case names; read them as the form's codes.
const PAYEE_TYPE_ALIASES = { supplier: 'VENDOR', customer: 'CUSTOMER', employee: 'EMPLOYEE' };
const EMPTY_LINE = { account_id: '', account_label: '', department_id: '', description: '', amount: '', tax_code_id: '', apply_withholding_tax: false, withholding_tax_amount: '' };

// Create a Cheque (or, at /cheques/:id/edit, edit a saved one) -- mirrors the live form: header (Date/Payee/Account/Cheque details/Currency/Memo),
// a running totals panel, and an Expenses grid. GL: DR each expense account / CR the bank Account.
export default function ChequeForm() {
  const navigate = useNavigate();
  const { id } = useParams();
  const editing = !!id;
  // ?ftr=<form id>: Create Check Voucher on an approved Fund Transfer Request (2026-10-14). The cheque
  // starts filled from it -- drawn on the From bank, one line per request line debiting its To bank --
  // and is saved against it, so the request shows it and stops offering the button once covered.
  const [searchParams] = useSearchParams();
  const ftrId = editing ? null : Number(searchParams.get('ftr')) || null;
  const [ftr, setFtr] = useState(null);
  const [chequeNo, setChequeNo] = useState('');
  const [meta, setMeta] = useState(null);
  const [header, setHeader] = useState({
    date_created: today(), payee_type: 'VENDOR', payee_id: '', payee_name: '', office_location_id: '',
    account_id: '', cheque_date: today(), cheque_number: '', currency: 'PHP', conversion_rate: 1, memo: '', date_released: '',
  });
  const [lines, setLines] = useState([{ ...EMPTY_LINE }]);
  // The Vendor payee's open Bill Credits, each with what this cheque applies of it.
  const [credits, setCredits] = useState([]);
  const [tab, setTab] = useState('expenses');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.get('/cheques/meta'), editing ? api.get(`/cheques/${id}`) : Promise.resolve(null),
      ftrId ? api.get(`/forms/${ftrId}`) : Promise.resolve(null)])
      .then(([m, ch, fr]) => {
        setMeta(m.data);
        if (fr) {
          const f = fr.data;
          const d = f.detail || {};
          const items = (f.items || []).filter((it) => Number(it.amount) !== 0);
          const first = items[0] || {};
          setFtr(f);
          setHeader((h) => ({
            ...h,
            payee_type: 'VENDOR', payee_id: f.voucher_supplier?.id || '', payee_name: f.voucher_supplier?.name || d.payable_to || '',
            account_id: d.from_account_id || first.from_account_id || '',
            memo: [f.request_no, ...items.map((it) => it.particulars).filter(Boolean)].join(' -- ').slice(0, 1000),
          }));
          const toLine = (it, amount) => ({
            ...EMPTY_LINE,
            account_id: it.to_account_id || d.to_account_id || '',
            account_label: it.to_account_code ? `${it.to_account_code} — ${it.to_account_name}` : '',
            department_id: f.department_id || '', description: it.particulars || f.request_no, amount,
          });
          // Nothing posted yet: every line as filed. Partly posted: one line for what is left.
          setLines(Number(f.voucher_posted) > 0
            ? [toLine(first, Number(f.voucher_remaining))]
            : (items.length ? items.map((it) => toLine(it, Number(it.amount))) : [{ ...EMPTY_LINE }]));
        }
        if (ch) {
          const c = ch.data;
          const day = (v) => (v ? String(v).slice(0, 10) : '');
          setChequeNo(c.cheque_no);
          setHeader({
            date_created: day(c.date_created), payee_type: PAYEE_TYPE_ALIASES[c.payee_type] || c.payee_type || 'VENDOR', payee_id: c.payee_id || '', payee_name: c.payee_name || '',
            office_location_id: c.office_location_id || '', account_id: c.account_id || '', cheque_date: day(c.cheque_date),
            cheque_number: c.cheque_number || '', currency: c.currency || 'PHP', conversion_rate: Number(c.conversion_rate) || 1,
            memo: c.memo || '', date_released: day(c.date_released),
          });
          setLines((c.lines || []).map((l) => ({
            account_id: l.account_id || '', account_label: l.account_code ? `${l.account_code} — ${l.account_name}` : '',
            department_id: l.department_id || '', description: l.description || '', amount: Number(l.amount) || '',
            tax_code_id: l.tax_code_id || '', apply_withholding_tax: !!l.apply_withholding_tax,
            withholding_tax_amount: Number(l.withholding_tax_amount) || '',
          })));
        }
        setLoading(false);
      })
      .catch((e) => { setError(e.response?.data?.error || 'Failed to load.'); setLoading(false); });
  }, [id, editing, ftrId]);

  // Reload the vendor's credits whenever the payee changes; a non-vendor payee has none.
  const vendorId = header.payee_type === 'VENDOR' ? header.payee_id : '';
  useEffect(() => {
    if (loading || !vendorId) { setCredits([]); return; }
    let alive = true;
    api.get('/cheques/vendor-credits', { params: { supplier_id: vendorId, cheque_id: editing ? id : undefined } })
      .then(({ data }) => { if (alive) setCredits(data.map((x) => ({ ...x, applied: x.applied_amount ? String(x.applied_amount) : '' }))); })
      .catch(() => { if (alive) setCredits([]); });
    return () => { alive = false; };
  }, [vendorId, loading, editing, id]);
  const setCredit = (i, applied) => setCredits((cs) => cs.map((x, idx) => (idx === i ? { ...x, applied } : x)));

  const setH = (patch) => setHeader((h) => ({ ...h, ...patch }));
  const setLine = (i, patch) => setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, { ...EMPTY_LINE }]);
  const delLine = (i) => setLines((ls) => ls.filter((_, idx) => idx !== i));

  function payeeItems(type) {
    if (type === 'VENDOR') return meta.vendors;
    if (type === 'CUSTOMER') return meta.customers;
    if (type === 'EMPLOYEE') return meta.employees;
    return [];
  }
  function taxRate(taxCodeId) { const t = (meta?.taxes || []).find((x) => String(x.id) === String(taxCodeId)); return t ? Number(t.rate) : 0; }

  // Per-line derived figures.
  const computed = useMemo(() => lines.map((l) => {
    const amount = Number(l.amount) || 0;
    const tax = amount * (taxRate(l.tax_code_id) / 100);
    const wtax = Number(l.withholding_tax_amount) || 0;
    const gross = amount + tax;
    return { tax, wtax, gross, total: gross - wtax };
  }), [lines, meta]); // eslint-disable-line react-hooks/exhaustive-deps

  const totals = useMemo(() => {
    const net = computed.reduce((s, c, i) => s + (Number(lines[i].amount) || 0), 0);
    const tax = computed.reduce((s, c) => s + c.tax, 0);
    const wtax = computed.reduce((s, c) => s + c.wtax, 0);
    const gross = net + tax;
    const credit = credits.reduce((s, x) => s + (Number(x.applied) || 0), 0);
    return { net, tax, wtax, gross, credit, total: gross - wtax - credit };
  }, [computed, lines, credits]);

  async function save() {
    setError('');
    if (!header.account_id) { setError('Select the bank Account to draw the cheque against.'); return; }
    const payload = lines
      .map((l, i) => ({ ...l, tax_amount: computed[i].tax, withholding_tax_amount: Number(l.withholding_tax_amount) || 0 }))
      // Negative lines are allowed: a reversal (asked 2026-10-03).
      .filter((l) => l.account_id && Number(l.amount) !== 0)
      .map((l) => ({
        account_id: l.account_id, department_id: l.department_id || null, description: l.description,
        amount: Number(l.amount), tax_code_id: l.tax_code_id || null, tax_amount: l.tax_amount,
        apply_withholding_tax: l.apply_withholding_tax, withholding_tax_amount: l.withholding_tax_amount,
      }));
    if (!payload.length) { setError('Add at least one expense line with an account and amount.'); return; }
    const deptError = lineDepartmentError(payload);
    if (deptError) { setError(deptError); return; }
    const creditPayload = credits.filter((x) => Number(x.applied) > 0).map((x) => ({ bill_credit_id: x.bill_credit_id, applied_amount: Number(x.applied) }));
    const over = credits.find((x) => Number(x.applied) > x.remaining + 0.001);
    if (over) { setError(`${over.bill_credit_no} has only ${money(over.remaining)} left to apply.`); setTab('credits'); return; }
    if (creditPayload.length && totals.total <= 0) { setError('The bill credits applied must be less than the amount the cheque pays.'); setTab('credits'); return; }
    setSaving(true);
    try {
      const body = { ...header, lines: payload, credits: creditPayload, ...(ftrId ? { form_request_id: ftrId } : {}) };
      const { data } = editing ? await api.put(`/cheques/${id}`, body) : await api.post('/cheques', body);
      navigate(`/cheques/${data.id}`);
    } catch (e) { setError(e.response?.data?.error || 'Save failed.'); setSaving(false); }
  }

  if (loading || !meta) return <LoadingSpinner />;
  const TotalsRow = ({ label, value }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px dashed var(--border)' }}>
      <span className="muted">{label}</span><span style={{ color: 'var(--accent)' }}>{money(value)}</span>
    </div>
  );

  return (
    <div>
      <div className="page-header">
        <div style={{ fontWeight: 600 }}>Cheque <span className="muted">/ {editing ? `Edit ${chequeNo}` : ftr ? `Create from ${ftr.request_no}` : 'Create'}</span></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={editing ? `/cheques/${id}` : '/cheques'}>{editing ? 'Cancel' : 'Back to Lists'}</Link>
          <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 300px', gap: 20, alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="field"><label>Date</label><input type="date" value={header.date_created} onChange={(e) => setH({ date_created: e.target.value })} /></div>
            <div className="field">
              <label>Payee</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <select value={header.payee_type} onChange={(e) => setH({ payee_type: e.target.value, payee_id: '', payee_name: '' })} style={{ width: 110 }}>
                  {PAYEE_TYPES.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
                </select>
                <div style={{ flex: 1 }}>
                  <EntityPicker label="Payee" items={payeeItems(header.payee_type)} value={header.payee_id} getLabel={(x) => x.name}
                    columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} placeholder={header.payee_name || '--Select--'}
                    onSelect={(x) => setH({ payee_id: x?.id || '', payee_name: x?.name || '' })} />
                </div>
              </div>
            </div>
            <div className="field"><label>Payee Name</label><input value={header.payee_name} onChange={(e) => setH({ payee_name: e.target.value })} /></div>
            <div className="field">
              <label>Office Location</label>
              <EntityPicker label="Office Location" items={meta.locations} value={header.office_location_id} getLabel={(l) => l.location_name}
                columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']} placeholder="--Select--" onSelect={(l) => setH({ office_location_id: l?.id || '' })} />
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="field">
              <label>Account</label>
              <EntityPicker label="Bank Account" items={meta.bankAccounts} value={header.account_id} getLabel={(a) => `${a.account_code} — ${a.account_name}`}
                columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }]} searchKeys={['account_code', 'account_name']} placeholder="--Select--" onSelect={(a) => setH({ account_id: a?.id || '' })} />
            </div>
            <div className="field"><label>Cheque Date</label><input type="date" value={header.cheque_date} onChange={(e) => setH({ cheque_date: e.target.value })} /></div>
            <div className="field"><label>Cheque No</label><input value={header.cheque_number} onChange={(e) => setH({ cheque_number: e.target.value })} /></div>
            {editing && <div className="field"><label>Date Released</label><input type="date" value={header.date_released} onChange={(e) => setH({ date_released: e.target.value })} /></div>}
            <div style={{ display: 'flex', gap: 10 }}>
              {/* PHP or USD (USD added 2026-10-22). Back to PHP resets the rate to 1. A cheque saved
                  earlier with some other code keeps it as an option rather than losing it. */}
              <div className="field" style={{ flex: 1 }}>
                <label>Currency</label>
                <select value={header.currency || 'PHP'}
                  onChange={(e) => setH(e.target.value === 'PHP' ? { currency: 'PHP', conversion_rate: 1 } : { currency: e.target.value })}>
                  {[...new Set(['PHP', 'USD', header.currency || 'PHP'])].map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="field" style={{ flex: 1 }}><label>Conversion Rate</label><input type="number" step="0.000001" value={header.conversion_rate} onChange={(e) => setH({ conversion_rate: e.target.value })} /></div>
            </div>
          </div>

          <div className="field"><label>Memo</label><textarea rows={8} value={header.memo} onChange={(e) => setH({ memo: e.target.value })} style={{ height: '100%' }} /></div>

          <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 18px' }}>
            <TotalsRow label="Sub Total" value={totals.net} />
            <TotalsRow label="Discount Amount" value={0} />
            <TotalsRow label="Net of Tax" value={totals.net} />
            <TotalsRow label="Tax Amount" value={totals.tax} />
            <TotalsRow label="Withholding Tax Amount" value={totals.wtax} />
            <TotalsRow label="Gross Amount" value={totals.gross} />
            {totals.credit > 0 && <TotalsRow label="Less: Bill Credits" value={totals.credit} />}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0 0', fontWeight: 700 }}>
              <span>Total Amount</span><span style={{ color: 'var(--accent)' }}>{money(totals.total)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="status-tabs" style={{ marginBottom: 8 }}>
          <button type="button" className={`status-tab ${tab === 'expenses' ? 'active' : ''}`} onClick={() => setTab('expenses')}>Expenses</button>
          <button type="button" className={`status-tab ${tab === 'credits' ? 'active' : ''}`} onClick={() => setTab('credits')}>
            Bill Credits{credits.length ? ` (${credits.length})` : ''}
          </button>
        </div>
        {tab === 'credits' && (
          <div className="table-wrap">
            {!vendorId ? (
              <div className="muted" style={{ padding: 16 }}>Choose a Vendor as the Payee to apply that vendor&rsquo;s open bill credits.</div>
            ) : (
              <table>
                <thead><tr>
                  <th>Bill Credit #</th><th>Date</th><th>Memo</th><th style={{ textAlign: 'right' }}>Original</th>
                  <th style={{ textAlign: 'right' }}>Remaining</th><th style={{ textAlign: 'right' }}>Apply</th>
                </tr></thead>
                <tbody>
                  {credits.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 16 }}>This vendor has no open bill credits.</td></tr>}
                  {credits.map((x, i) => (
                    <tr key={x.bill_credit_id}>
                      <td>{x.bill_credit_no}</td>
                      <td>{x.date_created ? displayDate(String(x.date_created).slice(0, 10)) : ''}</td>
                      <td>{x.memo || ''}</td>
                      <td style={{ textAlign: 'right' }}>{money(x.total_amount)}</td>
                      <td style={{ textAlign: 'right' }}>{money(x.remaining)}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <input type="number" step="0.01" min="0" style={{ width: 110, textAlign: 'right' }} value={x.applied} onChange={(e) => setCredit(i, e.target.value)} />
                        <button type="button" className="btn btn-sm" style={{ marginLeft: 6 }} onClick={() => setCredit(i, String(x.remaining))}>Full</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                {totals.credit > 0 && <tfoot><tr style={{ fontWeight: 700 }}><td colSpan={5} style={{ textAlign: 'right' }}>Total applied</td><td style={{ textAlign: 'right' }}>{money(totals.credit)}</td></tr></tfoot>}
              </table>
            )}
          </div>
        )}
        {tab === 'expenses' && (<>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th></th><th>Account</th><th>Description</th><th title="Required on every line">Department *</th><th style={{ textAlign: 'right' }}>Amount</th>
                <th>Tax Code</th><th style={{ textAlign: 'right' }}>Tax Amount</th><th>Apply WTax</th>
                <th style={{ textAlign: 'right' }}>Gross</th><th style={{ textAlign: 'right' }}>Withholding Tax</th><th style={{ textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td><button type="button" className="btn btn-sm btn-warning" onClick={() => delLine(i)}>✕</button></td>
                  <td style={{ minWidth: 230 }}>
                    <EntityPicker label="Account" items={meta.accounts} value={l.account_id} getLabel={(a) => `${a.account_code} — ${a.account_name}`}
                      columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Title' }]} searchKeys={['account_code', 'account_name']}
                      placeholder={l.account_label || '--Select--'} onSelect={(a) => setLine(i, { account_id: a?.id || '', account_label: a ? `${a.account_code} — ${a.account_name}` : '' })} />
                  </td>
                  <td><input style={{ width: 150 }} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></td>
                  <td style={{ minWidth: 140 }}>
                    <EntityPicker label="Department" items={meta.departments} value={l.department_id} getLabel={(d) => d.name}
                      columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} placeholder="--Select--" onSelect={(d) => setLine(i, { department_id: d?.id || '' })} />
                  </td>
                  <td><input type="number" step="0.01" style={{ width: 100, textAlign: 'right' }} value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} /></td>
                  <td>
                    <select value={l.tax_code_id} onChange={(e) => setLine(i, { tax_code_id: e.target.value })}>
                      <option value="">--None--</option>
                      {meta.taxes.map((t) => <option key={t.id} value={t.id}>{t.code} ({Number(t.rate)}%)</option>)}
                    </select>
                  </td>
                  <td style={{ textAlign: 'right' }}>{money(computed[i].tax)}</td>
                  <td style={{ textAlign: 'center' }}><input type="checkbox" checked={l.apply_withholding_tax} onChange={(e) => setLine(i, { apply_withholding_tax: e.target.checked })} /></td>
                  <td style={{ textAlign: 'right' }}>{money(computed[i].gross)}</td>
                  <td><input type="number" step="0.01" style={{ width: 90, textAlign: 'right' }} value={l.withholding_tax_amount} onChange={(e) => setLine(i, { withholding_tax_amount: e.target.value })} disabled={!l.apply_withholding_tax} /></td>
                  <td style={{ textAlign: 'right' }}>{money(computed[i].total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button className="btn btn-sm btn-primary" style={{ marginTop: 10 }} onClick={addLine}>Add Expense</button>
        </>)}
      </div>
    </div>
  );
}
