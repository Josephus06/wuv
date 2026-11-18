import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import EntityPicker from './EntityPicker';
import LoadingSpinner from './LoadingSpinner';
import { lineDepartmentError } from '../utils/requireDepartment';
import { displayDate } from '../utils/dates';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? displayDate(String(v).slice(0, 10)) : ''; }
function accountLabel(a) { return a ? `${a.account_code} — ${a.account_name}` : ''; }
function wtaxLabel(w) { return w ? `${w.code} — ${w.name} (${w.rate}%)` : ''; }

function computeLine(l, wtaxRate) {
  const amount = Number(l.amount) || 0;
  const taxRate = Number(l.tax_rate) || 0;
  const taxAmount = amount * (taxRate / 100);
  const grossAmount = amount + taxAmount;
  const wtaxAmount = l.is_withhold ? amount * (Number(wtaxRate || 0) / 100) : 0;
  return { tax_amount: taxAmount, gross_amount: grossAmount, wtax_amount: wtaxAmount, amount_due: grossAmount - wtaxAmount };
}

// Mirrors the real "Bill Credit" popup, reached from an Open Vendor Bill's "Bill Credit"
// button -- confirmed field-for-field against the live system. Unlike Vendor Bill, its
// lines aren't tied to the source bill's own items -- they're general-ledger expense lines
// against arbitrary Chart of Accounts entries (a return, an overcharge correction, a
// rebate), then applied against one or more of the vendor's open bills. Applied Amount is
// capped at this credit's own Total Amount and rejected (not clamped) if exceeded -- see
// schema.sql's comment on bill_credits for why this deliberately differs from the real
// system's own (buggy) default.
// Opened from a Vendor Bill (vendorBillId) or from a Cheque to a vendor (chequeId) -- the cheque
// screen has the same "Bill Credit" button; such a credit records the vendor itself, not a bill.
// Or opened on a saved credit (billCreditId) to edit it: the same form, filled from the credit,
// saved with PUT. The server refuses the edit once the credit is spent (see in_use).
export default function BillCreditModal({ vendorBillId, chequeId, billCreditId, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [dateCreated, setDateCreated] = useState(new Date().toISOString().slice(0, 10));
  const [officeLocation, setOfficeLocation] = useState(null);
  const [apAccount, setApAccount] = useState(null);
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState([]);
  // A credit with no expense lines is entered as an Amount, as the source raises them (BC-7431).
  const [typedAmount, setTypedAmount] = useState('');
  const [wtax, setWtax] = useState(null);
  const [tab, setTab] = useState('expenses');
  const [applyAmounts, setApplyAmounts] = useState({});
  const [accounts, setAccounts] = useState([]);
  const [locations, setLocations] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [taxes, setTaxes] = useState([]);
  const [withholdingTaxes, setWithholdingTaxes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get(billCreditId ? `/bill-credits/${billCreditId}/edit-form`
        : chequeId ? `/bill-credits/for-cheque/${chequeId}` : `/bill-credits/for-vendor-bill/${vendorBillId}`),
      api.get('/lookups/chart-of-accounts'),
      api.get('/lookups/locations'),
      api.get('/lookups/departments'),
      api.get('/lookups/taxes'),
      api.get('/lookups/withholding-taxes'),
    ]).then(([bcRes, acctRes, locRes, deptRes, taxRes, wtaxRes]) => {
      const d = bcRes.data;
      setData(d);
      setAccounts(acctRes.data);
      setLocations(locRes.data);
      setDepartments(deptRes.data);
      setTaxes(taxRes.data);
      setWithholdingTaxes(wtaxRes.data);
      setMemo(d.memo || '');
      if (d.ap_account_id) setApAccount({ id: d.ap_account_id });
      if (d.office_location_id) setOfficeLocation({ id: d.office_location_id });
      // From a cheque, its expense lines come pre-filled (see /for-cheque); a bill sends none.
      if (Array.isArray(d.lines) && d.lines.length) {
        setLines(d.lines.map((l, i) => ({
          key: `src-${i}`, account_id: l.account_id, account_label: '', department_id: l.department_id || null,
          amount: Number(l.amount) || 0, tax_code_id: l.tax_code_id || null, tax_rate: Number(l.tax_rate) || 0,
          is_withhold: !!l.is_withhold,
        })));
      }
      if (billCreditId) {
        if (d.date_created) setDateCreated(String(d.date_created).slice(0, 10));
        if (d.wtax_id) setWtax({ id: d.wtax_id, rate: d.wtax_rate, name: d.wtax_name });
        setApplyAmounts(Object.fromEntries((d.apply_lines || [])
          .filter((a) => Number(a.applied_amount) > 0).map((a) => [a.vendor_bill_id, Number(a.applied_amount)])));
        if (d.in_use) setError(d.in_use);
        if (!(d.lines || []).length && Number(d.total_amount) > 0) setTypedAmount(String(Number(d.total_amount)));
      }
      setLoading(false);
    }).catch((e) => { setError(e.response?.data?.error || 'Could not load.'); setLoading(false); });
  }, [vendorBillId, chequeId, billCreditId]);

  const wtaxRate = wtax ? Number(wtax.rate) : 0;
  const computedLines = useMemo(() => lines.map((l) => ({ ...l, ...computeLine(l, wtaxRate) })), [lines, wtaxRate]);
  // Expense lines decide the total when there are any; otherwise the typed Amount does.
  const hasLines = lines.some((l) => l.account_id && Number(l.amount) > 0);
  const applyTotalNow = Object.values(applyAmounts).reduce((s, v) => s + (Number(v) || 0), 0);
  // Left blank, the Amount is what is being applied -- so crediting a bill in full needs nothing
  // typed twice (VB-24638, 2026-10-06). Typed, it stands, and may exceed what is applied.
  const amountOnly = hasLines ? 0 : (String(typedAmount).trim() === '' ? applyTotalNow : (Number(typedAmount) || 0));
  const subtotal = hasLines ? computedLines.reduce((s, l) => s + (Number(l.amount) || 0), 0) : amountOnly;
  const taxAmount = hasLines ? computedLines.reduce((s, l) => s + l.tax_amount, 0) : 0;
  const wtaxAmountTotal = hasLines ? computedLines.reduce((s, l) => s + l.wtax_amount, 0) : 0;
  const totalAmount = subtotal + taxAmount;
  const applyTotal = Object.values(applyAmounts).reduce((s, v) => s + (Number(v) || 0), 0);

  if (loading || !data) {
    return (
      <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal modal-xl">
          {loading ? <LoadingSpinner /> : (
            <>
              <div className="error-banner">{error || 'Could not load.'}</div>
              <div className="modal-actions"><button type="button" className="btn" onClick={onClose}>Close</button></div>
            </>
          )}
        </div>
      </div>
    );
  }

  function addLine() {
    setLines((prev) => [...prev, { key: Date.now(), account_id: '', account_label: '', department_id: null, amount: 0, tax_code_id: null, tax_rate: 0, is_withhold: false }]);
  }
  function updateLine(key, patch) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function removeLine(key) {
    setLines((prev) => prev.filter((l) => l.key !== key));
  }


  async function handleSave() {
    setError('');
    const submittedLines = lines.filter((l) => l.account_id && Number(l.amount) > 0);
    const deptError = lineDepartmentError(submittedLines);
    if (deptError) { setError(deptError); return; }
    // No expense lines is allowed (asked 2026-10-06): the credit saves at 0.00 and can be given its
    // lines later by Edit. What it cannot do is apply anything until it has them (checked below).
    const applyLines = Object.entries(applyAmounts).filter(([, v]) => Number(v) > 0).map(([id, v]) => ({ vendor_bill_id: Number(id), applied_amount: Number(v) }));
    // A credit entered as an Amount credits back what its bills debited, so it must apply to one.
    if (!hasLines && amountOnly > 0 && !applyLines.length) {
      setError('A credit entered as an Amount must be applied to at least one bill (Apply tab).');
      return;
    }
    // A credit can never apply more than it is worth.
    if (applyTotal > totalAmount + 0.005) {
      setError(`Applied ${money(applyTotal)} is more than this credit's Total Amount of ${money(totalAmount)}. Enter the Amount (or add expense lines) worth at least that much, or lower the Applied Amounts.`);
      return;
    }

    setSaving(true);
    try {
      const payload = {
        date_created: dateCreated,
        office_location_id: officeLocation?.id || null,
        ap_account_id: apAccount?.id || null,
        memo,
        wtax_id: wtax?.id || null,
        expense_lines: submittedLines.map((l) => ({
          account_id: l.account_id, department_id: l.department_id, amount: l.amount, tax_code_id: l.tax_code_id, is_withhold: l.is_withhold,
        })),
        apply_lines: applyLines,
        amount: hasLines ? undefined : amountOnly,
      };
      const { data: bc } = billCreditId
        ? await api.put(`/bill-credits/${billCreditId}`, payload)
        : await api.post('/bill-credits', { ...payload, vendor_bill_id: chequeId ? null : vendorBillId, cheque_id: chequeId || null });
      onSaved(bc);
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
          <h2 style={{ margin: 0, color: '#fff' }}>{billCreditId ? `Edit ${data.bill_credit_no || 'Bill Credit'}` : 'Bill Credit'}</h2>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 24, lineHeight: 1, cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ padding: 24 }}>
          {error && <div className="error-banner">{error}</div>}

          <div className="review-grid" style={{ gridTemplateColumns: '1fr 1fr 260px' }}>
            <div>
              <div className="field"><label>Date</label><input type="date" value={dateCreated} onChange={(e) => setDateCreated(e.target.value)} /></div>
              <div>Vendor : <span className="hi">{data.supplier_name}</span></div>
              <div className="field">
                <label>Office Location</label>
                <EntityPicker
                  label="Office Location" items={locations} value={officeLocation?.id || ''} getLabel={(l) => l.location_name}
                  columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']}
                  onSelect={setOfficeLocation}
                />
              </div>
              <div className="field">
                <label>AP Account</label>
                <EntityPicker
                  label="AP Account" items={accounts} value={apAccount?.id || ''} getLabel={accountLabel}
                  columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }]}
                  searchKeys={['account_code', 'account_name']}
                  onSelect={setApAccount}
                />
              </div>
            </div>
            <div>
              <div>Created From : <span className="hi">{data.bill_no}</span></div>
              <div className="field"><label>Memo</label><textarea rows={3} value={memo} onChange={(e) => setMemo(e.target.value)} /></div>
              <div className="field">
                <label>Amount</label>
                <input type="number" step="0.01" min="0" value={hasLines ? '' : typedAmount} disabled={hasLines}
                  placeholder={hasLines ? 'Set by the expense lines' : `${money(applyTotalNow)} -- the amount applied, unless you type another`}
                  onChange={(e) => setTypedAmount(e.target.value)} />
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  {hasLines ? 'The expense lines decide the total.' : 'With no expense lines the credit is this amount; it credits back the accounts of the bills it is applied to.'}
                </div>
              </div>
            </div>
            <div className="card" style={{ background: 'var(--surface-2, #f3f4f6)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Net of TAX</span><span className="hi">{money(subtotal)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Tax Amount</span><span className="hi">{money(taxAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Gross Amount</span><span className="hi">{money(totalAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Withholding Tax Amount</span><span className="hi">{money(wtaxAmountTotal)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}><span>Total Amount</span><span>{money(totalAmount)}</span></div>
            </div>
          </div>

          <div className="status-tabs" style={{ marginTop: 20 }}>
            <button className={`status-tab ${tab === 'expenses' ? 'active' : ''}`} onClick={() => setTab('expenses')}>Expenses {money(totalAmount)}</button>
            <button className={`status-tab ${tab === 'wtax' ? 'active' : ''}`} onClick={() => setTab('wtax')}>Withholding Tax</button>
            <button className={`status-tab ${tab === 'apply' ? 'active' : ''}`} onClick={() => setTab('apply')}>Apply {money(applyTotal)}</button>
          </div>

          {tab === 'expenses' && (
            <div style={{ marginTop: 12 }}>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Account</th><th>Department *</th><th>Amount</th><th>Tax Code</th><th>Withhold?</th><th>Amount Due</th><th></th></tr>
                  </thead>
                  <tbody>
                    {computedLines.length === 0 && (
                      <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No expense lines yet.</td></tr>
                    )}
                    {computedLines.map((l) => (
                      <tr key={l.key}>
                        <td>
                          <EntityPicker
                            label="Account" items={accounts} value={l.account_id} getLabel={accountLabel}
                            columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }, { key: 'account_type', label: 'Type' }]}
                            searchKeys={['account_code', 'account_name']}
                            onSelect={(a) => updateLine(l.key, { account_id: a.id })}
                          />
                        </td>
                        <td>
                          <EntityPicker
                            label="Department" items={departments} value={l.department_id || ''} getLabel={(d) => d.name}
                            columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']}
                            onSelect={(d) => updateLine(l.key, { department_id: d.id })}
                          />
                        </td>
                        <td>
                          <input
                            type="number" step="0.01" style={{ width: 100 }}
                            value={l.amount}
                            onChange={(e) => updateLine(l.key, { amount: e.target.value })}
                          />
                        </td>
                        <td>
                          <EntityPicker
                            label="Tax Code" items={taxes} value={l.tax_code_id || ''} getLabel={(t) => `${t.code} (${t.rate}%)`}
                            columns={[{ key: 'code', label: 'Code' }, { key: 'rate', label: 'Rate %' }]} searchKeys={['code']}
                            onSelect={(t) => updateLine(l.key, { tax_code_id: t.id, tax_rate: t.rate })}
                          />
                        </td>
                        <td>
                          <input
                            type="checkbox" checked={!!l.is_withhold}
                            onChange={(e) => updateLine(l.key, { is_withhold: e.target.checked })}
                          />
                        </td>
                        <td>{money(l.amount_due)}</td>
                        <td><button type="button" className="btn btn-sm btn-danger" onClick={() => removeLine(l.key)}>Remove</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="button" className="btn btn-primary" style={{ marginTop: 10 }} onClick={addLine}>Add</button>
            </div>
          )}

          {tab === 'wtax' && (
            <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: 12 }}>
              <div className="field">
                <label>Withholding Tax</label>
                <EntityPicker
                  label="Withholding Tax" items={withholdingTaxes} value={wtax?.id || ''} getLabel={wtaxLabel}
                  columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'rate', label: 'Rate %' }]}
                  searchKeys={['code', 'name']}
                  onSelect={setWtax}
                />
              </div>
              <div className="field"><label>Withholding Tax Description</label><input readOnly tabIndex={-1} value={wtax?.name || ''} /></div>
              <div className="field"><label>Withholding Tax Amount</label><input readOnly tabIndex={-1} value={money(wtaxAmountTotal)} /></div>
            </div>
          )}

          {tab === 'apply' && (
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table>
                <thead>
                  <tr><th></th><th>Vendor Bill #</th><th>Date</th><th>Date Due</th><th>Original Amount</th><th>Amount Due</th><th>Applied Amount</th></tr>
                </thead>
                <tbody>
                  {data.apply_lines.length === 0 && (
                    <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No open bills for this vendor.</td></tr>
                  )}
                  {data.apply_lines.map((l) => (
                    <tr key={l.vendor_bill_id}>
                      <td>
                        <input
                          type="checkbox" checked={Number(applyAmounts[l.vendor_bill_id] || 0) > 0}
                          // Ticking moves the bill's whole Amount Due into Applied Amount (Amount Due then
                          // reads 0); the save still refuses more than the credit's own Total Amount.
                          onChange={(e) => setApplyAmounts((prev) => ({ ...prev, [l.vendor_bill_id]: e.target.checked ? Number(l.amount_due) : 0 }))}
                        />
                      </td>
                      <td>{l.bill_no}</td>
                      <td>{formatDate(l.date_created)}</td>
                      <td>{formatDate(l.date_due)}</td>
                      <td>{money(l.gross_amount)}</td>
                      <td>{money(Math.max(0, Number(l.amount_due) - (Number(applyAmounts[l.vendor_bill_id]) || 0)))}</td>
                      <td>
                        <input
                          type="number" step="0.01" style={{ width: 100 }}
                          value={applyAmounts[l.vendor_bill_id] ?? 0}
                          onChange={(e) => setApplyAmounts((prev) => ({ ...prev, [l.vendor_bill_id]: e.target.value }))}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={saving || !!data.in_use} onClick={handleSave}>
              {saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
