import { useEffect, useState } from 'react';
import api from '../api/client';
import EntityPicker from './EntityPicker';
import LoadingSpinner from './LoadingSpinner';
import { displayDate } from '../utils/dates';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? displayDate(v) : '—'; }

// The real modal's Receipt and Payment Type are plain selects with a fixed set of
// options, not master-list lookups -- stored as their label on the payment.
const RECEIPT_TYPES = ['Official Receipt', 'Collection Receipt', 'Provisional Receipt'];
const PAYMENT_TYPES = ['Full Payment', 'Partial Payment', 'Down Payment', 'Balance Payment'];

// Mirrors the real "Customer Payment" popup, reached from an Open Invoice's "Accept
// Payment" button. Every one of this customer's still-open invoices is listed in APPLY,
// not just the one the button was pressed from -- a single payment routinely settles
// several at once -- with the source invoice ticked by default. CREDITS offsets the
// payment with the customer's own open Credit Memos, which move no cash.
// Two ways in, one form. `invoiceId` is the Accept Payment button on an open invoice, which ticks
// that invoice for its full balance because settling exactly it is the overwhelmingly common case.
// `customerId` is Add on the Customer Payments list: the customer handed over money and nothing
// has singled out an invoice, so every open one is listed and none is ticked.
// Cheques are the one method whose extra fields cannot be driven off the master list's
// requires_reference flag -- a bank, a cheque number and a cheque date are cheque-specific by
// nature. Matched on the name rather than an id, which differs between environments, and
// loosely enough to cover "CHECK" and "Cheque" being spelled either way.
const isCheque = (method) => /^che(ck|que)$/.test(String(method?.name || '').trim().toLowerCase());

// `paymentId` puts the form into EDIT mode: it opens on the payment as saved and PUTs back.
// Only offered for a payment that has not been deposited -- see the route for why.
export default function CustomerPaymentModal({ invoiceId, customerId, paymentId, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [dateCreated, setDateCreated] = useState(new Date().toISOString().slice(0, 10));
  const [department, setDepartment] = useState(null);
  const [receiptType, setReceiptType] = useState('');
  const [orNo, setOrNo] = useState('');
  const [siBsNo, setSiBsNo] = useState('');
  const [paymentType, setPaymentType] = useState('');
  const [issuedBy, setIssuedBy] = useState(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState(null);
  // How the money arrived. Only ever one set of these is on screen -- see the method picker.
  const [referenceNo, setReferenceNo] = useState('');
  const [bankName, setBankName] = useState('');
  const [chequeNo, setChequeNo] = useState('');
  const [chequeDate, setChequeDate] = useState('');
  const [depositAccount, setDepositAccount] = useState(null);
  const [memo, setMemo] = useState('');
  // Where the payment is taken: the creating user's default location, falling back to the
  // invoice's when the user has none. An edit keeps the location saved on the payment.
  const [officeLocation, setOfficeLocation] = useState(null);
  const [locations, setLocations] = useState([]);
  const [tab, setTab] = useState('apply');
  const [applyAmounts, setApplyAmounts] = useState({});   // sales_invoice_id -> string
  // Entered from the customer end the list is every open invoice they have -- hundreds, for a
  // regular account. The filter narrows what is DRAWN only: anything already ticked stays in the
  // payment whether or not the filter is hiding it, and the APPLY tab total keeps showing it.
  const [applyFilter, setApplyFilter] = useState('');
  const [creditAmounts, setCreditAmounts] = useState({}); // credit_memo_id -> string
  // Customer Refunds as open items (2026-11-05): a refund debits A/R, so a payment can settle it.
  const [refundAmounts, setRefundAmounts] = useState({}); // customer_refund_id -> string
  const [departments, setDepartments] = useState([]);
  const [users, setUsers] = useState([]);
  const [methods, setMethods] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      // In edit mode the open-items list is asked for on behalf of THIS payment, so the invoices
      // and credits it already settled come back even though they have no balance left -- see
      // for-customer's payment_id note. Without that the form could not show, or reduce, what
      // the payment is currently applying.
      api.get(paymentId
        ? `/customer-payments/for-customer/${customerId}?payment_id=${paymentId}`
        : invoiceId
          ? `/customer-payments/for-invoice/${invoiceId}`
          : `/customer-payments/for-customer/${customerId}`),
      paymentId ? api.get(`/customer-payments/${paymentId}`) : Promise.resolve(null),
      api.get('/lookups/departments'),
      // Names for the Issued By picker, served by this page rather than by the users admin page --
      // taking a payment must not require the right to administer accounts.
      api.get('/customer-payments/meta/issuers'),
      api.get('/lookups/payment-methods'),
      api.get('/lookups/chart-of-accounts'),
      api.get('/customer-payments/meta/locations').catch(() => ({ data: [] })),
    ]).then(([srcRes, payRes, deptRes, userRes, methodRes, acctRes, locRes]) => {
      setLocations(locRes.data || []);
      const d = srcRes.data;
      setData(d);
      setDepartments(deptRes.data);
      setUsers(Array.isArray(userRes.data) ? userRes.data : (userRes.data?.rows || []));
      setMethods(methodRes.data);
      setAccounts(Array.isArray(acctRes.data) ? acctRes.data : (acctRes.data?.rows || []));
      setMemo(d.memo || '');
      setOfficeLocation(d.creator_location
        || (d.office_location_id ? { id: d.office_location_id, location_name: d.office_location_name } : null));
      if (d.department_id) setDepartment({ id: d.department_id, name: d.department_name });
      // The invoice the button was pressed from starts ticked for its full remaining
      // balance -- the overwhelmingly common case is settling exactly that. Started from the
      // customer instead, nothing is ticked and the amount is left blank: presuming which
      // invoices a walk-in payment settles is exactly the guess that produces a misapplied one.
      if (d.sales_invoice_id) {
        setApplyAmounts({ [d.sales_invoice_id]: String(Number(d.amount_due).toFixed(2)) });
        setPaymentAmount(String(Number(d.amount_due).toFixed(2)));
      }

      // Editing: fill the form from the payment as saved, so what opens is what is recorded and
      // any field left alone is saved back unchanged.
      if (payRes) {
        const p = payRes.data;
        setDateCreated(String(p.date_created).slice(0, 10));
        setReceiptType(p.receipt_type || '');
        setOrNo(p.or_no || '');
        setSiBsNo(p.si_bs_no || '');
        setPaymentType(p.payment_type || '');
        setMemo(p.memo || '');
        setPaymentAmount(String(Number(p.payment_amount).toFixed(2)));
        setReferenceNo(p.reference_no || '');
        setBankName(p.bank_name || '');
        setChequeNo(p.cheque_no || '');
        setChequeDate(p.cheque_date ? String(p.cheque_date).slice(0, 10) : '');
        if (p.department_id) setDepartment({ id: p.department_id, name: p.department_name });
        if (p.office_location_id) setOfficeLocation({ id: p.office_location_id, location_name: p.office_location_name });
        if (p.issued_by_user_id) setIssuedBy({ id: p.issued_by_user_id, display_name: p.issued_by_name });
        if (p.payment_method_id) setPaymentMethod({ id: p.payment_method_id, name: p.payment_method_name, requires_reference: methodRes.data.find((m) => m.id === p.payment_method_id)?.requires_reference });
        if (p.deposit_account_id) setDepositAccount({ id: p.deposit_account_id, account_code: p.deposit_account_code, account_name: p.deposit_account_name });
        const applied = {};
        const credited = {};
        const refunded = {};
        for (const l of p.lines || []) {
          if (l.customer_refund_id) refunded[l.customer_refund_id] = String(Number(l.applied_amount).toFixed(2));
          if (l.sales_invoice_id) applied[l.sales_invoice_id] = String(Number(l.applied_amount).toFixed(2));
          if (l.credit_memo_id) credited[l.credit_memo_id] = String(Number(l.applied_amount).toFixed(2));
        }
        setApplyAmounts(applied);
        setCreditAmounts(credited);
        setRefundAmounts(refunded);
      }
      setLoading(false);
    }).catch((err) => {
      setError(err.response?.data?.error
        || (invoiceId ? 'Could not load this Invoice.' : 'Could not load this Customer.'));
      setLoading(false);
    });
  }, [invoiceId, customerId, paymentId]);

  if (loading) {
    return <div className="modal-overlay"><div className="modal modal-xl"><LoadingSpinner /></div></div>;
  }
  if (!data) {
    return (
      <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal modal-xl">
          <div className="error-banner">{error}</div>
          <div className="modal-actions"><button type="button" className="btn" onClick={onClose}>Close</button></div>
        </div>
      </div>
    );
  }

  // A ticked invoice stays visible even when the filter would hide it, so nothing being paid
  // can scroll out of sight.
  const applyQuery = applyFilter.trim().toLowerCase();
  const visibleApplyLines = !applyQuery ? (data?.apply_lines || []) : (data?.apply_lines || []).filter(
    (l) => applyAmounts[l.sales_invoice_id] !== undefined || String(l.invoice_no || '').toLowerCase().includes(applyQuery)
      || String(l.bs_si_no || '').toLowerCase().includes(applyQuery)
  );
  const received = Number(paymentAmount) || 0;
  const tickedToInvoices = [...Object.values(applyAmounts), ...Object.values(refundAmounts)].reduce((s, v) => s + (Number(v) || 0), 0);
  // What will actually be applied: never more than the payment, since saving fits the ticked
  // invoices to it (fitToPayment below). Shown that way so the panel never reads negative.
  const appliedToInvoices = received > 0 ? Math.min(tickedToInvoices, received) : tickedToInvoices;
  const appliedToCredits = Object.values(creditAmounts).reduce((s, v) => s + (Number(v) || 0), 0);
  const appliedAmount = appliedToInvoices + appliedToCredits;
  // Credits offset the bill without cash changing hands, so only the invoice-applied
  // portion consumes the payment -- the same split the server enforces. Whatever cash is
  // left over sits unapplied, on account.
  const unappliedAmount = received - appliedToInvoices;

  // A payment smaller than what is ticked is a PARTIAL payment, not a mistake: apply what was
  // received and leave the rest owing. Trimmed from the last-ticked invoice backwards, so the
  // invoices ticked first are paid first. The invoice keeps its balance and stays Open; the
  // payment ends fully applied. Only when there is a payment amount to fit to -- a credits-only
  // payment carries none.
  function fitToPayment(lines) {
    if (!(received > 0)) return lines;
    let over = Number((lines.reduce((sum, l) => sum + l.applied_amount, 0) - received).toFixed(2));
    if (over <= 0) return lines;
    const fitted = lines.map((l) => ({ ...l }));
    for (let i = fitted.length - 1; i >= 0 && over > 0; i -= 1) {
      const cut = Math.min(fitted[i].applied_amount, over);
      fitted[i].applied_amount = Number((fitted[i].applied_amount - cut).toFixed(2));
      over = Number((over - cut).toFixed(2));
    }
    return fitted.filter((l) => l.applied_amount > 0);
  }

  async function handleSave() {
    setError('');
    // Invoices and refunds are fitted to the payment together, invoices first.
    const fitted = fitToPayment([
      ...Object.entries(applyAmounts).filter(([, v]) => Number(v) > 0)
        .map(([id, v]) => ({ sales_invoice_id: Number(id), applied_amount: Number(v) })),
      ...Object.entries(refundAmounts).filter(([, v]) => Number(v) > 0)
        .map(([id, v]) => ({ customer_refund_id: Number(id), applied_amount: Number(v) })),
    ]);
    const apply = fitted.filter((l) => l.sales_invoice_id);
    const refunds = fitted.filter((l) => l.customer_refund_id);
    const credits = Object.entries(creditAmounts)
      .filter(([, v]) => Number(v) > 0)
      .map(([id, v]) => ({ credit_memo_id: Number(id), applied_amount: Number(v) }));
    // Everything but Deposit To is required -- the same list, in the same order, the server checks
    // (missingRequired in routes/customerPayments.js). Nothing applied is allowed: the whole
    // amount then sits unapplied, on account. Amount may be zero only for a credits-only payment.
    const cheque = isCheque(paymentMethod);
    const missing = [
      [!dateCreated, 'Date'], [!department, 'Department'], [!memo.trim(), 'Memo'],
      [!receiptType, 'Receipt'], [!orNo.trim(), 'OR #'], [!paymentType, 'Payment Type'], [!issuedBy, 'Issued By'],
      [!(received > 0) && !(credits.length && !apply.length && !refunds.length), 'Payment Amount'], [!paymentMethod, 'Payment Method'],
      [cheque && !bankName.trim(), 'Bank'], [cheque && !chequeDate, 'Cheque Date'], [cheque && !chequeNo.trim(), 'Cheque No'],
      [!cheque && paymentMethod?.requires_reference && !referenceNo.trim(), 'Reference No'],
    ].filter(([bad]) => bad).map(([, label]) => label);
    if (missing.length) { setError(`Required: ${missing.join(', ')}.`); return; }

    setSaving(true);
    try {
      const payload = {
        customer_id: data.customer_id,
        date_created: dateCreated,
        department_id: department?.id || null,
        office_location_id: officeLocation?.id || null,
        deposit_account_id: depositAccount?.id || null,
        receipt_type: receiptType,
        or_no: orNo,
        si_bs_no: siBsNo.trim() || null,
        payment_type: paymentType,
        issued_by_user_id: issuedBy?.id || null,
        payment_method_id: paymentMethod?.id || null,
        payment_amount: received,
        // Only whatever the chosen method actually asks for; the rest were cleared when it was
        // picked, so a cheque number cannot ride along on a GCASH receipt.
        reference_no: referenceNo || null,
        bank_name: bankName || null,
        cheque_no: chequeNo || null,
        cheque_date: chequeDate || null,
        memo,
        apply_lines: apply,
        credit_lines: credits,
        refund_lines: refunds,
      };
      // One payload, two verbs. Editing replaces the whole application rather than patching it,
      // which is why the same body serves both.
      const { data: cp } = paymentId
        ? await api.put(`/customer-payments/${paymentId}`, payload)
        : await api.post('/customer-payments', payload);
      onSaved(cp);
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
          <h2 style={{ margin: 0, color: '#fff' }}>Customer Payment</h2>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 24, lineHeight: 1, cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ padding: 24 }}>
          {error && <div className="error-banner">{error}</div>}

          <div className="review-grid" style={{ gridTemplateColumns: '1fr 1fr 260px' }}>
            <div>
              <div className="field"><label>Date <span className="req">*</span></label><input type="date" value={dateCreated} onChange={(e) => setDateCreated(e.target.value)} /></div>
              <div>Customer : <span className="hi">{data.customer_name}</span></div>
              <div className="field">
                <label>Department <span className="req">*</span></label>
                <EntityPicker
                  label="Department" items={departments} value={department?.id || ''} getLabel={(d) => d.name}
                  columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} onSelect={setDepartment}
                />
              </div>
              <div className="field">
                <label>Office Location</label>
                <EntityPicker
                  label="Office Location" items={locations} value={officeLocation?.id || ''} getLabel={(l) => l.location_name}
                  columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']}
                  onSelect={setOfficeLocation} onClear={() => setOfficeLocation(null)}
                />
              </div>
              <div className="field"><label>Memo <span className="req">*</span></label><textarea rows={5} value={memo} onChange={(e) => setMemo(e.target.value)} /></div>
            </div>
            <div>
              <div className="field">
                <label>Receipt <span className="req">*</span></label>
                <select value={receiptType} onChange={(e) => setReceiptType(e.target.value)}>
                  <option value="">--Select--</option>
                  {RECEIPT_TYPES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div className="field"><label>OR # <span className="req">*</span></label><input value={orNo} onChange={(e) => setOrNo(e.target.value)} /></div>
              <div className="field">
                <label>Payment Type <span className="req">*</span></label>
                <select value={paymentType} onChange={(e) => setPaymentType(e.target.value)}>
                  <option value="">--Select--</option>
                  {PAYMENT_TYPES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Issued By <span className="req">*</span></label>
                <EntityPicker
                  label="Issued By" items={users} value={issuedBy?.id || ''} getLabel={(u) => u.display_name}
                  columns={[{ key: 'display_name', label: 'Name' }, { key: 'email', label: 'Email' }]}
                  searchKeys={['display_name', 'email']} onSelect={setIssuedBy}
                />
              </div>
              <div className="field"><label>Payment Amount <span className="req">*</span></label><input type="number" step="0.01" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} /></div>
              <div className="field">
                <label>Payment Method <span className="req">*</span></label>
                <EntityPicker
                  label="Payment Method" items={methods} value={paymentMethod?.id || ''} getLabel={(m) => m.name}
                  columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']}
                  onSelect={(m) => {
                    setPaymentMethod(m);
                    // Clear what no longer applies, so switching CHECK -> GCASH cannot save a
                    // cheque number against a GCASH receipt.
                    if (!isCheque(m)) { setBankName(''); setChequeNo(''); setChequeDate(''); }
                    if (!m?.requires_reference || isCheque(m)) setReferenceNo('');
                  }}
                />
              </div>

              {/* Nothing extra is asked until a method is chosen -- there is no sensible answer
                  to "reference number" before then. Cash asks for neither, because cash has no
                  reference. Which methods do is read from the payment_methods master list, so
                  adding a sixth is a Master Lists edit and not a code change. */}
              {paymentMethod && isCheque(paymentMethod) && (
                <>
                  <div className="field"><label>Bank <span className="req">*</span></label><input value={bankName} onChange={(e) => setBankName(e.target.value)} /></div>
                  {/* The date the CHEQUE is drawn for, which is not the date the payment was
                      recorded -- a post-dated cheque is the whole reason this is separate. */}
                  <div className="field"><label>Date <span className="req">*</span></label><input type="date" value={chequeDate} onChange={(e) => setChequeDate(e.target.value)} /></div>
                  <div className="field"><label>Cheque No <span className="req">*</span></label><input value={chequeNo} onChange={(e) => setChequeNo(e.target.value)} /></div>
                </>
              )}
              {paymentMethod && paymentMethod.requires_reference && !isCheque(paymentMethod) && (
                <div className="field">
                  <label>Reference No <span className="req">*</span></label>
                  <input
                    value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)}
                    placeholder={`${paymentMethod.name} reference`}
                  />
                </div>
              )}
              <div className="field">
                <label>Deposit To</label>
                <EntityPicker
                  label="Deposit To" items={accounts} value={depositAccount?.id || ''}
                  getLabel={(a) => `${a.account_code} ${a.account_name}`}
                  columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Account' }]}
                  searchKeys={['account_code', 'account_name']} onSelect={setDepositAccount}
                />
              </div>
            </div>
            <div className="card" style={{ background: 'var(--surface-2, #f3f4f6)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Applied Amount</span><span className="hi">{money(appliedAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Unapplied Amount</span><span className="hi">{money(unappliedAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}><span>Total Payments</span><span>{money(received)}</span></div>
            </div>
          </div>

          <div className="status-tabs" style={{ marginTop: 20 }}>
            <button className={`status-tab ${tab === 'apply' ? 'active' : ''}`} onClick={() => setTab('apply')}>APPLY {money(appliedToInvoices)}</button>
            <button className={`status-tab ${tab === 'credits' ? 'active' : ''}`} onClick={() => setTab('credits')}>CREDITS {money(appliedToCredits)}</button>
          </div>

          {tab === 'apply' && (
            <div style={{ marginTop: 12 }}>
              {data.apply_lines.length > 10 && (
                <div className="field" style={{ marginBottom: 8 }}>
                  <input
                    value={applyFilter} onChange={(e) => setApplyFilter(e.target.value)}
                    placeholder={`Find among ${data.apply_lines.length} open invoices...`}
                  />
                </div>
              )}
              <div className="table-wrap" style={{ maxHeight: 380, overflowY: 'auto' }}>
              <table>
                <thead>
                  <tr><th></th><th>Invoice #</th><th>Customer</th><th>SI# / BS#</th><th>Date Created</th><th>Original Amount</th><th>Amount Due</th><th>Applied Amount</th></tr>
                </thead>
                <tbody>
                  {data.apply_lines.length === 0 && (
                    <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>This customer has no open invoices.</td></tr>
                  )}
                  {data.apply_lines.length > 0 && visibleApplyLines.length === 0 && (
                    <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>No invoice matches "{applyFilter}".</td></tr>
                  )}
                  {visibleApplyLines.map((l) => {
                    const checked = applyAmounts[l.sales_invoice_id] !== undefined;
                    return (
                      <tr key={l.sales_invoice_id}>
                        <td>
                          <input
                            type="checkbox" checked={checked}
                            onChange={() => setApplyAmounts((prev) => {
                              const next = { ...prev };
                              if (checked) delete next[l.sales_invoice_id];
                              else {
                                // What is left of the payment, if a payment amount is keyed in --
                                // ticking an invoice then takes only what the money covers.
                                const already = [...Object.values(prev), ...Object.values(refundAmounts)].reduce((sum, v) => sum + (Number(v) || 0), 0);
                                const left = received > 0 ? Math.max(0, received - already) : Infinity;
                                next[l.sales_invoice_id] = String(Math.min(Number(l.amount_due), left).toFixed(2));
                              }
                              return next;
                            })}
                          />
                        </td>
                        <td>{l.invoice_no}</td>
                        <td>{l.customer_name}</td>
                        {/* Each invoice's own SI# / BS# (the printed form number), in place of the one
                            header field the payment used to carry for all of them. */}
                        <td>{l.bs_si_no || ''}</td>
                        <td>{formatDate(l.date_created)}</td>
                        <td>{money(l.gross_amount)}</td>
                        <td>{money(l.amount_due)}</td>
                        <td>
                          <input
                            type="number" step="0.01" style={{ width: 120 }} disabled={!checked}
                            value={applyAmounts[l.sales_invoice_id] ?? ''}
                            onChange={(e) => setApplyAmounts((prev) => ({ ...prev, [l.sales_invoice_id]: e.target.value }))}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
              {(data.refund_lines || []).length > 0 && (
                <div className="table-wrap" style={{ marginTop: 14 }}>
                  <table>
                    <thead>
                      <tr><th></th><th>Customer Refund #</th><th>Customer</th><th>Date Created</th><th>Original Amount</th><th>Amount Due</th><th>Applied Amount</th></tr>
                    </thead>
                    <tbody>
                      {data.refund_lines.map((l) => {
                        const checked = refundAmounts[l.customer_refund_id] !== undefined;
                        return (
                          <tr key={`r${l.customer_refund_id}`}>
                            <td>
                              <input
                                type="checkbox" checked={checked}
                                onChange={() => setRefundAmounts((prev) => {
                                  const next = { ...prev };
                                  if (checked) delete next[l.customer_refund_id];
                                  else {
                                    const already = [...Object.values(applyAmounts), ...Object.values(prev)].reduce((sum, v) => sum + (Number(v) || 0), 0);
                                    const left = received > 0 ? Math.max(0, received - already) : Infinity;
                                    const due = Number(l.amount_due) + Number(l.applied_by_this_payment || 0) * (paymentId ? 1 : 0);
                                    next[l.customer_refund_id] = String(Math.min(due, left).toFixed(2));
                                  }
                                  return next;
                                })}
                              />
                            </td>
                            <td>{l.customer_refund_no}</td>
                            <td>{l.customer_name}</td>
                            <td>{formatDate(l.date_created)}</td>
                            <td>{money(l.refund_amount)}</td>
                            <td>{money(l.amount_due)}</td>
                            <td>
                              <input
                                type="number" step="0.01" style={{ width: 120 }} disabled={!checked}
                                value={refundAmounts[l.customer_refund_id] ?? ''}
                                onChange={(e) => setRefundAmounts((prev) => ({ ...prev, [l.customer_refund_id]: e.target.value }))}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {tab === 'credits' && (
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table>
                <thead>
                  <tr><th></th><th>Credit Memo #</th><th>Date Created</th><th>Original Amount</th><th>Remaining</th><th>Applied Amount</th></tr>
                </thead>
                <tbody>
                  {data.credit_lines.length === 0 && (
                    <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>This customer has no open credit memos.</td></tr>
                  )}
                  {data.credit_lines.map((l) => {
                    const checked = creditAmounts[l.credit_memo_id] !== undefined;
                    return (
                      <tr key={l.credit_memo_id}>
                        <td>
                          <input
                            type="checkbox" checked={checked}
                            onChange={() => setCreditAmounts((prev) => {
                              const next = { ...prev };
                              if (checked) delete next[l.credit_memo_id];
                              else next[l.credit_memo_id] = String(Number(l.remaining).toFixed(2));
                              return next;
                            })}
                          />
                        </td>
                        <td>{l.credit_memo_no}</td>
                        <td>{formatDate(l.date_created)}</td>
                        <td>{money(l.gross_amount)}</td>
                        <td>{money(l.remaining)}</td>
                        <td>
                          <input
                            type="number" step="0.01" style={{ width: 120 }} disabled={!checked}
                            value={creditAmounts[l.credit_memo_id] ?? ''}
                            onChange={(e) => setCreditAmounts((prev) => ({ ...prev, [l.credit_memo_id]: e.target.value }))}
                          />
                        </td>
                      </tr>
                    );
                  })}
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
