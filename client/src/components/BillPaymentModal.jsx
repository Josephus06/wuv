import { useEffect, useState } from 'react';
import api from '../api/client';
import EntityPicker from './EntityPicker';
import LoadingSpinner from './LoadingSpinner';
import { displayDate } from '../utils/dates';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? displayDate(String(v).slice(0, 10)) : ''; }
function accountLabel(a) { return a ? `${a.account_code} — ${a.account_name}` : ''; }
function pmLabel(p) { return p ? p.name : ''; }

const PAYMENT_TYPES = ['full', 'partial', 'balance', 'downpayment'];

// Mirrors the real "Bill Payment" popup, reached from an Open Vendor Bill's "Bill
// Payment" button -- confirmed field-for-field against the live system. A single payment
// can settle several of the vendor's open bills at once (Apply tab) and/or offset the
// payment with the vendor's own existing open Bill Credits (Debits tab). Selecting
// Payment Method = CHECK swaps in Check Date/Check No in place of the generic Reference #,
// matching the real modal's conditional sub-fields.
//
// With `paymentId` instead of `vendorBillId` it EDITS that saved payment: the same form, filled
// in, offering the vendor's open bills/credits plus the ones this payment already settles (their
// Amount Due shown as it would be without this payment). Save then re-applies it server-side.
export default function BillPaymentModal({ vendorBillId, paymentId, onClose, onSaved }) {
  const editing = !!paymentId;
  const [data, setData] = useState(null);
  const [dateCreated, setDateCreated] = useState(new Date().toISOString().slice(0, 10));
  const [paymentType, setPaymentType] = useState('full');
  const [payeeName, setPayeeName] = useState('');
  const [officeLocation, setOfficeLocation] = useState(null);
  const [apAccount, setApAccount] = useState(null);
  const [bankAccount, setBankAccount] = useState(null);
  const [paymentMethod, setPaymentMethod] = useState(null);
  const [referenceNo, setReferenceNo] = useState('');
  const [checkDate, setCheckDate] = useState(new Date().toISOString().slice(0, 10));
  const [checkNo, setCheckNo] = useState('');
  const [memo, setMemo] = useState('');
  const [tab, setTab] = useState('apply');
  const [applyAmounts, setApplyAmounts] = useState({});
  const [debitAmounts, setDebitAmounts] = useState({});
  const [accounts, setAccounts] = useState([]);
  const [locations, setLocations] = useState([]);
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      editing ? api.get(`/bill-payments/${paymentId}/edit-options`) : api.get(`/bill-payments/for-vendor-bill/${vendorBillId}`),
      api.get('/lookups/chart-of-accounts'),
      api.get('/lookups/locations'),
      api.get('/lookups/payment-methods'),
    ]).then(([bpRes, acctRes, locRes, pmRes]) => {
      const d = bpRes.data;
      setData(d);
      setAccounts(acctRes.data);
      setLocations(locRes.data);
      setPaymentMethods(pmRes.data);
      if (editing) {
        const day = (v) => (v ? String(v).slice(0, 10) : '');
        setDateCreated(day(d.date_created));
        setPaymentType(d.payment_type || 'full');
        setPayeeName(d.payee_name || '');
        setMemo(d.memo || '');
        setReferenceNo(d.reference_no || '');
        setCheckDate(day(d.check_date) || day(d.date_created));
        setCheckNo(d.check_no || '');
        if (d.ap_account_id) setApAccount({ id: d.ap_account_id, account_code: d.ap_account_code, account_name: d.ap_account_name });
        if (d.bank_account_id) setBankAccount({ id: d.bank_account_id, account_code: d.bank_account_code, account_name: d.bank_account_name });
        if (d.payment_method_id) setPaymentMethod({ id: d.payment_method_id, name: d.payment_method_name });
        if (d.office_location_id) setOfficeLocation({ id: d.office_location_id, location_name: d.office_location_name });
        setApplyAmounts(Object.fromEntries(d.apply_lines.filter((l) => Number(l.applied_amount) > 0).map((l) => [l.vendor_bill_id, l.applied_amount])));
        setDebitAmounts(Object.fromEntries(d.debit_lines.filter((l) => Number(l.applied_amount) > 0).map((l) => [l.bill_credit_id, l.applied_amount])));
      } else {
        setPayeeName(d.supplier_name || '');
        setMemo(d.memo || '');
        if (d.ap_account_id) setApAccount({ id: d.ap_account_id, account_code: d.account_code, account_name: d.account_name });
        if (d.office_location_id) setOfficeLocation({ id: d.office_location_id });
        setApplyAmounts({ [vendorBillId]: d.apply_lines.find((l) => l.vendor_bill_id === Number(vendorBillId))?.amount_due || 0 });
      }
      setLoading(false);
    }).catch((e) => { setError(e.response?.data?.error || 'Could not load the payment.'); setLoading(false); });
  }, [vendorBillId, paymentId, editing]);

  if (loading || !data) {
    return (
      <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal modal-xl">{error ? <div className="error-banner">{error}</div> : <LoadingSpinner />}</div>
      </div>
    );
  }

  const applyTotal = Object.values(applyAmounts).reduce((s, v) => s + (Number(v) || 0), 0);
  const debitTotal = Object.values(debitAmounts).reduce((s, v) => s + (Number(v) || 0), 0);
  const totalPayments = applyTotal + debitTotal;
  const isCheck = paymentMethod?.name === 'CHECK';

  async function handleSave() {
    setError('');
    if (!bankAccount) { setError('Bank Account is required.'); return; }
    if (!paymentMethod) { setError('Payment Method is required.'); return; }
    const applyLines = Object.entries(applyAmounts).filter(([, v]) => Number(v) > 0).map(([id, v]) => ({ vendor_bill_id: Number(id), applied_amount: Number(v) }));
    const debitLines = Object.entries(debitAmounts).filter(([, v]) => Number(v) > 0).map(([id, v]) => ({ bill_credit_id: Number(id), applied_amount: Number(v) }));
    if (!applyLines.length && !debitLines.length) { setError('Apply at least one amount to a bill or credit.'); return; }

    setSaving(true);
    try {
      const save = (body) => (editing ? api.put(`/bill-payments/${paymentId}`, body) : api.post('/bill-payments', body));
      const { data: bp } = await save({
        supplier_id: data.supplier_id,
        date_created: dateCreated,
        payment_type: paymentType,
        payee_name: payeeName,
        office_location_id: officeLocation?.id || null,
        ap_account_id: apAccount?.id || null,
        bank_account_id: bankAccount?.id,
        payment_method_id: paymentMethod?.id,
        reference_no: isCheck ? '' : referenceNo,
        check_date: isCheck ? checkDate : null,
        check_no: isCheck ? checkNo : null,
        memo,
        apply_lines: applyLines,
        debit_lines: debitLines,
      });
      onSaved(bp);
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
          <h2 style={{ margin: 0, color: '#fff' }}>{editing ? `Edit Bill Payment ${data.bill_payment_no || ''}` : 'Bill Payment'}</h2>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 24, lineHeight: 1, cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ padding: 24 }}>
          {error && <div className="error-banner">{error}</div>}
          {editing && data.reconciled && (
            <div className="muted" style={{ marginBottom: 8 }}>
              This payment is matched on a bank reconciliation: its date, bank account and amounts are locked. Memo, payee,
              reference and the other details can still change.
            </div>
          )}

          <div className="review-grid" style={{ gridTemplateColumns: '1fr 1fr 260px' }}>
            <div>
              <div className="field"><label>Date</label><input type="date" value={dateCreated} onChange={(e) => setDateCreated(e.target.value)} /></div>
              <div>Vendor : <span className="hi">{data.supplier_name}</span></div>
              <div className="field"><label>Payee Name</label><input value={payeeName} onChange={(e) => setPayeeName(e.target.value)} /></div>
              <div className="field">
                <label>AP Account</label>
                <EntityPicker
                  label="AP Account" items={accounts} value={apAccount?.id || ''} getLabel={accountLabel}
                  columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }]}
                  searchKeys={['account_code', 'account_name']}
                  onSelect={setApAccount}
                />
              </div>
              <div className="field">
                <label>Bank Account *</label>
                <EntityPicker
                  label="Bank Account" items={accounts} value={bankAccount?.id || ''} getLabel={accountLabel}
                  columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }, { key: 'account_type', label: 'Type' }]}
                  searchKeys={['account_code', 'account_name']}
                  onSelect={setBankAccount}
                />
              </div>
            </div>
            <div>
              <div className="field">
                <label>Payment Type</label>
                <select value={paymentType} onChange={(e) => setPaymentType(e.target.value)}>
                  {PAYMENT_TYPES.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Payment Method *</label>
                <EntityPicker
                  label="Payment Method" items={paymentMethods} value={paymentMethod?.id || ''} getLabel={pmLabel}
                  columns={[{ key: 'name', label: 'Method' }]} searchKeys={['name']}
                  onSelect={setPaymentMethod}
                />
              </div>
              {isCheck ? (
                <>
                  <div className="field"><label>Check Date</label><input type="date" value={checkDate} onChange={(e) => setCheckDate(e.target.value)} /></div>
                  <div className="field"><label>Check No</label><input value={checkNo} onChange={(e) => setCheckNo(e.target.value)} /></div>
                </>
              ) : (
                <div className="field"><label>Reference #</label><input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} /></div>
              )}
              <div className="field">
                <label>Office Location</label>
                <EntityPicker
                  label="Office Location" items={locations} value={officeLocation?.id || ''} getLabel={(l) => l.location_name}
                  columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']}
                  onSelect={setOfficeLocation}
                />
              </div>
            </div>
            <div className="card" style={{ background: 'var(--surface-2, #f3f4f6)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}><span>Total Payments</span><span>{money(totalPayments)}</span></div>
            </div>
          </div>

          <div className="field" style={{ marginTop: 8 }}><label>Memo</label><textarea rows={2} value={memo} onChange={(e) => setMemo(e.target.value)} /></div>

          <div className="status-tabs" style={{ marginTop: 20 }}>
            <button className={`status-tab ${tab === 'apply' ? 'active' : ''}`} onClick={() => setTab('apply')}>Apply {money(applyTotal)}</button>
            <button className={`status-tab ${tab === 'debits' ? 'active' : ''}`} onClick={() => setTab('debits')}>Debits {money(debitTotal)}</button>
          </div>

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
                          onChange={(e) => setApplyAmounts((prev) => ({ ...prev, [l.vendor_bill_id]: e.target.checked ? l.amount_due : 0 }))}
                        />
                      </td>
                      <td>{l.bill_no}</td>
                      <td>{formatDate(l.date_created)}</td>
                      <td>{formatDate(l.date_due)}</td>
                      <td>{money(l.gross_amount)}</td>
                      <td>{money(l.amount_due)}</td>
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

          {tab === 'debits' && (
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table>
                <thead>
                  <tr><th></th><th>Bill Credit #</th><th>Date</th><th>Total Amount</th><th>Remaining</th><th>Applied Amount</th></tr>
                </thead>
                <tbody>
                  {(!data.debit_lines || data.debit_lines.length === 0) && (
                    <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>No open credits for this vendor.</td></tr>
                  )}
                  {(data.debit_lines || []).map((l) => (
                    <tr key={l.bill_credit_id}>
                      <td>
                        <input
                          type="checkbox" checked={Number(debitAmounts[l.bill_credit_id] || 0) > 0}
                          onChange={(e) => setDebitAmounts((prev) => ({ ...prev, [l.bill_credit_id]: e.target.checked ? l.remaining : 0 }))}
                        />
                      </td>
                      <td>{l.bill_credit_no}</td>
                      <td>{formatDate(l.date_created)}</td>
                      <td>{money(l.total_amount)}</td>
                      <td>{money(l.remaining)}</td>
                      <td>
                        <input
                          type="number" step="0.01" style={{ width: 100 }}
                          value={debitAmounts[l.bill_credit_id] ?? 0}
                          onChange={(e) => setDebitAmounts((prev) => ({ ...prev, [l.bill_credit_id]: e.target.value }))}
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
            <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}>
              {saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
