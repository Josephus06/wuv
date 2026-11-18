import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import { displayDate } from '../utils/dates';
import { headerDepartmentError } from '../utils/requireDepartment';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
}
function formatDate(v) { return v ? displayDate(v) : ''; }

// Standalone create form for a Customer Refund (the live #/customer_refund_crud screen): pick a
// customer, then how much of each of their payments to refund. Total Refunds drives the header
// Refund Amount, and the whole thing posts DR A/R Trade / CR Customer Refund on save.
export default function CustomerRefundEdit() {
  const navigate = useNavigate();
  const [customers, setCustomers] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [locations, setLocations] = useState([]);
  const [methods, setMethods] = useState([]);

  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [customer, setCustomer] = useState(null);
  const [department, setDepartment] = useState(null);
  const [location, setLocation] = useState(null);
  const [method, setMethod] = useState(null);
  const [memo, setMemo] = useState('');
  const [accounts, setAccounts] = useState(null); // { account_id/name, ar_account_id/name }
  const [payments, setPayments] = useState([]);    // refundable payments for the customer
  const [refunds, setRefunds] = useState({});       // customer_payment_id -> refund_amount string

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/customers').then(({ data }) => setCustomers(data)).catch(() => {});
    api.get('/lookups/departments').then(({ data }) => setDepartments(data)).catch(() => {});
    api.get('/lookups/locations').then(({ data }) => setLocations(data)).catch(() => {});
    api.get('/lookups/payment-methods').then(({ data }) => setMethods(data)).catch(() => {});
  }, []);

  async function onCustomerSelect(c) {
    setCustomer(c);
    setPayments([]); setRefunds({}); setAccounts(null);
    if (!c) return;
    try {
      const { data } = await api.get(`/customer-refunds/for-customer/${c.id}`);
      setPayments(data.payments || []);
      setAccounts({
        account_id: data.account_id, account_name: data.account_name,
        ar_account_id: data.ar_account_id, ar_account_name: data.ar_account_name,
      });
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load this customer\'s payments.');
    }
  }

  function setRefund(paymentId, value) {
    setRefunds((prev) => ({ ...prev, [paymentId]: value }));
  }

  const totalRefund = useMemo(
    () => payments.reduce((s, p) => s + (Number(refunds[p.customer_payment_id]) || 0), 0),
    [payments, refunds]
  );

  async function handleSave() {
    setError('');
    if (!customer) { setError('Select a customer.'); return; }
    const deptError = headerDepartmentError(department?.id);
    if (deptError) { setError(deptError); return; }
    const lines = payments
      .map((p) => ({ customer_payment_id: p.customer_payment_id, refund_amount: Number(refunds[p.customer_payment_id]) || 0 }))
      .filter((l) => l.refund_amount > 0);
    if (!lines.length) { setError('Enter a refund amount for at least one payment.'); return; }
    setSaving(true);
    try {
      const { data } = await api.post('/customer-refunds', {
        customer_id: customer.id,
        date_created: date,
        department_id: department?.id || null,
        office_location_id: location?.id || null,
        account_id: accounts?.account_id || null,
        ar_account_id: accounts?.ar_account_id || null,
        payment_method_id: method?.id || null,
        memo: memo || null,
        lines,
      });
      navigate(`/customer-refunds/${data.id}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed.');
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Customer Refund</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={'/customer-refunds'}>Back to Lists</Link>
          <button className="btn btn-sm btn-primary" disabled={saving} onClick={handleSave}>Save</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Date Created</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field">
            <label>Refund Amount</label>
            <input value={money(totalRefund)} readOnly />
          </div>
          <div className="field">
            <label>Payment Method</label>
            <EntityPicker
              label="Payment Method" items={methods} value={method?.id || ''} getLabel={(m) => m.name}
              columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} placeholder="--Select--"
              onSelect={setMethod}
            />
          </div>
          <div className="field">
            <label>Customer</label>
            <EntityPicker
              label="Customer" items={customers} value={customer?.id || ''} getLabel={(c) => c.name}
              columns={[{ key: 'name', label: 'Name' }, { key: 'tin', label: 'TIN' }]} searchKeys={['name', 'tin']}
              placeholder="--Select--" onSelect={onCustomerSelect}
            />
          </div>
          <div className="field">
            <label>Account</label>
            <input value={accounts?.account_name || 'Customer Refund'} readOnly />
          </div>
          <div className="field">
            <label>A/R Account</label>
            <input value={accounts?.ar_account_name || 'Accounts Receivable Trade'} readOnly />
          </div>
          <div className="field">
            <label>Department *</label>
            <EntityPicker
              label="Department" items={departments} value={department?.id || ''} getLabel={(d) => d.name}
              columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} placeholder="--Select--"
              onSelect={setDepartment}
            />
          </div>
          <div className="field">
            <label>Office Location</label>
            <EntityPicker
              label="Office Location" items={locations} value={location?.id || ''} getLabel={(l) => l.location_name}
              columns={[{ key: 'location_name', label: 'Name' }, { key: 'location_code', label: 'Code' }]}
              searchKeys={['location_name', 'location_code']} placeholder="--Select--" onSelect={setLocation}
            />
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Memo</label>
            <textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={2} />
          </div>
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <strong>Payments</strong>
          <strong>Total Refunds: {money(totalRefund)}</strong>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Payment #</th><th>Date</th><th>Name</th><th style={{ textAlign: 'right' }}>Original Amount</th><th>Refund Amount</th></tr>
            </thead>
            <tbody>
              {!customer && (
                <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>Select a customer to see refundable payments.</td></tr>
              )}
              {customer && payments.length === 0 && (
                <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>This customer has no refundable payments.</td></tr>
              )}
              {payments.map((p) => (
                <tr key={p.customer_payment_id}>
                  <td>{p.customer_payment_no}</td>
                  <td>{formatDate(p.date_created)}</td>
                  <td>{customer?.name}</td>
                  <td style={{ textAlign: 'right' }}>{money(p.payment_amount)}</td>
                  <td>
                    <input
                      type="number" min="0" step="0.01" max={p.payment_amount}
                      value={refunds[p.customer_payment_id] ?? ''}
                      onChange={(e) => setRefund(p.customer_payment_id, e.target.value)}
                      style={{ width: 140 }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
