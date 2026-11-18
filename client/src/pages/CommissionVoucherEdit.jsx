import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import { displayMonth } from '../utils/dates';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
}
function formatMonth(v) { return v ? displayMonth(v) : ''; }
function formatDate(v) { return v ? String(v).slice(0, 10) : ''; }

// Only an expense on Commission Payable may be pointed at a month. Matched on the account code
// rather than an id, the same way the server resolves it -- the id differs between databases.
const COMMISSION_PAYABLE_CODE = '24200';
const isCommissionPayable = (account) => account?.account_code === COMMISSION_PAYABLE_CODE;

// Create form for a Commission Voucher (the live #/commission_voucher_crud screen): pick an
// employee, choose which of their unpaid/partial Commission Payables to release and how much, add
// optional expense adjustments, pick the cash/bank account, and Save. Settles the payables and
// posts DR 24200 / (+/- expenses) / CR cash.
export default function CommissionVoucherEdit() {
  const navigate = useNavigate();
  const { id } = useParams();
  const isEdit = !!id;
  const [employees, setEmployees] = useState([]);
  const [employee, setEmployee] = useState(null);

  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [dateReleased, setDateReleased] = useState('');
  const [paymentType, setPaymentType] = useState('full');
  const [payeeName, setPayeeName] = useState('');
  const [refNo, setRefNo] = useState('');
  const [memo, setMemo] = useState('');
  const [method, setMethod] = useState(null);
  const [cashAccount, setCashAccount] = useState(null);

  const [payables, setPayables] = useState([]);       // releasable commission payables
  const [checked, setChecked] = useState({});          // cp_id -> bool
  const [released, setReleased] = useState({});        // cp_id -> string
  const [expenses, setExpenses] = useState([]);        // { account, description, amount }
  const [methods, setMethods] = useState([]);
  const [cashAccounts, setCashAccounts] = useState([]);
  const [expenseAccounts, setExpenseAccounts] = useState([]);

  const [tab, setTab] = useState('commissions');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { api.get('/commission-vouchers/employees').then(({ data }) => setEmployees(data)).catch(() => {}); }, []);

  // Edit mode: load the voucher, pull the employee's payables (with ?voucherId so its own releases
  // are shown and their room given back), and prefill every field.
  useEffect(() => {
    if (!isEdit) return;
    (async () => {
      try {
        const { data: cv } = await api.get(`/commission-vouchers/${id}`);
        setDate(formatDate(cv.date_created) || new Date().toISOString().slice(0, 10));
        setDateReleased(formatDate(cv.date_released));
        setPaymentType(cv.payment_type || 'full');
        setPayeeName(cv.payee_name || cv.employee_name || '');
        setRefNo(cv.reference_no || '');
        setMemo(cv.memo || '');
        setEmployee({ id: cv.employee_id, name: cv.employee_name });
        const { data } = await api.get(`/commission-vouchers/for-employee/${cv.employee_id}?voucherId=${id}`);
        setPayables(data.payables || []);
        setMethods(data.payment_methods || []);
        setCashAccounts(data.cash_accounts || []);
        setExpenseAccounts(data.expense_accounts || []);
        const ck = {}; const rl = {};
        (data.payables || []).forEach((p) => { rl[p.commission_payable_id] = '0'; });
        (cv.lines || []).forEach((l) => { ck[l.commission_payable_id] = true; rl[l.commission_payable_id] = String(l.released_amount); });
        setChecked(ck); setReleased(rl);
        setMethod(cv.payment_method_id ? { id: cv.payment_method_id, name: cv.payment_method_name } : null);
        setCashAccount(cv.cash_bank_account_id ? { id: cv.cash_bank_account_id, account_code: cv.cash_account_code, account_name: cv.cash_account_name } : null);
        setExpenses((cv.expenses || []).map((e) => ({
          account: { id: e.account_id, account_code: e.account_code, account_name: e.account_name },
          description: e.description || '', amount: String(e.amount),
          applies_to_payable_id: e.applies_to_payable_id || null,
        })));
      } catch (err) {
        setError(err.response?.data?.error || 'Could not load this voucher.');
      }
    })();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function onEmployeeSelect(e) {
    setEmployee(e); setPayables([]); setChecked({}); setReleased({});
    if (!e) return;
    try {
      const { data } = await api.get(`/commission-vouchers/for-employee/${e.id}`);
      setPayables(data.payables || []);
      setMethods(data.payment_methods || []);
      setCashAccounts(data.cash_accounts || []);
      setExpenseAccounts(data.expense_accounts || []);
      setPayeeName(e.name);
      // Default: nothing checked, released 0 -- ticking a commission fills in its full amount
      // (toggleCommission); a refund-only voucher clears it back to 0 and adds a positive expense.
      const rl = {};
      (data.payables || []).forEach((p) => { rl[p.commission_payable_id] = '0'; });
      setChecked({}); setReleased(rl);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load this employee\'s commissions.');
    }
  }

  // Ticking a commission releases all of it (Released = its commissionable); unticking puts it back
  // to 0. The Commissionable column shows what is left after this release -- 0 when released in
  // full, 2,347.54 when 1,000.00 of CP-27's 3,347.54 is. A refund-only row is ticked and cleared to 0.
  function toggleCommission(p, on) {
    setChecked((c) => ({ ...c, [p.commission_payable_id]: on }));
    setReleased((r) => ({ ...r, [p.commission_payable_id]: on ? String(Number(p.commissionable_amount).toFixed(2)) : '0' }));
  }
  const remaining = (p) => Number(p.commissionable_amount)
    - (checked[p.commission_payable_id] ? (Number(released[p.commission_payable_id]) || 0) : 0);

  function addExpense() { setExpenses((x) => [...x, { account: null, description: '', amount: '', applies_to_payable_id: null }]); }
  // Switching the account away from Commission Payable drops any month it was pointed at: the
  // field disappears from the row, and a target stranded on another account is exactly what
  // the server rejects on save.
  function setExpense(i, patch) {
    setExpenses((x) => x.map((e, idx) => {
      if (idx !== i) return e;
      const next = { ...e, ...patch };
      if ('account' in patch && !isCommissionPayable(next.account)) next.applies_to_payable_id = null;
      return next;
    }));
  }
  function removeExpense(i) { setExpenses((x) => x.filter((_, idx) => idx !== i)); }

  const totalReleased = useMemo(
    () => payables.reduce((s, p) => s + (checked[p.commission_payable_id] ? (Number(released[p.commission_payable_id]) || 0) : 0), 0),
    [payables, checked, released]
  );
  const expenseSum = useMemo(() => expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0), [expenses]);
  const totalPayments = Number((totalReleased + expenseSum).toFixed(2));

  async function handleSave() {
    setError('');
    if (!employee) { setError('Select an employee.'); return; }
    const lines = payables
      .filter((p) => checked[p.commission_payable_id])
      .map((p) => ({ commission_payable_id: p.commission_payable_id, released_amount: Number(released[p.commission_payable_id]) || 0 }));
    const exp = expenses.filter((e) => e.account && Number(e.amount) !== 0)
      .map((e) => ({
        account_id: e.account.id, description: e.description || null, amount: Number(e.amount),
        applies_to_payable_id: isCommissionPayable(e.account) ? (e.applies_to_payable_id || null) : null,
      }));
    // A voucher needs at least a commission line OR an expense -- an expense-only voucher is a
    // pure refund (no commission released).
    if (!lines.length && !exp.length) { setError('Select a commission or add an expense.'); return; }
    // A release above that commission's commissionable (its unpaid amount) is asked about, not refused
    // (2026-10-26): T1S's figure can trail the source's. What this voucher already released counts as
    // within it -- kept or lowered needs no question. Confirmed, the server records each one.
    const ceilingOf = (p) => Math.max(Number(p.commissionable_amount), Number(p.already_released) || 0);
    const overs = payables.filter((p) => checked[p.commission_payable_id]
      && (Number(released[p.commission_payable_id]) || 0) > ceilingOf(p) + 0.005);
    if (overs.length) {
      const list = overs.map((p) => {
        const r = Number(released[p.commission_payable_id]) || 0;
        return `${p.commission_payable_no}: releasing ${money(r)}, commissionable ${money(ceilingOf(p))} (over by ${money(r - ceilingOf(p))})`;
      }).join('\n');
      if (!confirm(`Released more than the commissionable:\n\n${list}\n\nSave anyway?`)) return;
    }
    setError('');
    setSaving(true);
    try {
      const payload = {
        employee_id: employee.id, date_created: date, date_released: dateReleased || null, payment_type: paymentType,
        payee_name: payeeName || employee.name, reference_no: refNo || null, memo: memo || null,
        payment_method_id: method?.id || null, cash_bank_account_id: cashAccount?.id || null, lines, expenses: exp,
        allow_over_release: overs.length > 0,
      };
      const { data } = isEdit
        ? await api.put(`/commission-vouchers/${id}`, payload)
        : await api.post('/commission-vouchers', payload);
      navigate(`/commission-vouchers/${isEdit ? id : data.id}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed.');
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Commission Voucher{isEdit && employee ? ` · ${employee.name}` : ''}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={'/commission-vouchers'}>Back to Lists</Link>
          <button className="btn btn-sm btn-primary" disabled={saving} onClick={handleSave}>{isEdit ? 'Update' : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field">
            <label>Payment Type</label>
            <select value={paymentType} onChange={(e) => setPaymentType(e.target.value)}>
              <option value="full">Full</option>
              <option value="partial">Partial</option>
            </select>
          </div>
          <div className="field">
            <label>Total Payments</label>
            <input value={money(totalPayments)} readOnly />
          </div>
          <div className="field">
            <label>Employee</label>
            <EntityPicker
              label="Employee" items={employee ? [employee, ...employees.filter((e) => e.id !== employee.id)] : employees}
              value={employee?.id || ''} getLabel={(e) => e.name}
              columns={[{ key: 'name', label: 'Name' }, { key: 'department_name', label: 'Department' }]}
              searchKeys={['name', 'department_name']} placeholder="--Select--" onSelect={onEmployeeSelect} disabled={isEdit}
            />
          </div>
          <div className="field">
            <label>Payment Method</label>
            <EntityPicker
              label="Payment Method" items={methods} value={method?.id || ''} getLabel={(m) => m.name}
              columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} placeholder="--Select--" onSelect={setMethod}
            />
          </div>
          <div className="field">
            <label>Cash/Bank Account</label>
            <EntityPicker
              label="Cash/Bank Account" items={cashAccounts} value={cashAccount?.id || ''} getLabel={(a) => `${a.account_code} ${a.account_name}`}
              columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }]}
              searchKeys={['account_code', 'account_name']} placeholder="--Select--" onSelect={setCashAccount}
            />
          </div>
          <div className="field">
            <label>Payee Name</label>
            <input value={payeeName} onChange={(e) => setPayeeName(e.target.value)} />
          </div>
          <div className="field">
            <label>Ref No</label>
            <input value={refNo} onChange={(e) => setRefNo(e.target.value)} />
          </div>
          <div className="field">
            <label>Date Released</label>
            <input type="date" value={dateReleased} onChange={(e) => setDateReleased(e.target.value)} />
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Memo</label>
            <textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={2} />
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginBottom: 12 }}>
        <button className={`status-tab ${tab === 'commissions' ? 'active' : ''}`} onClick={() => setTab('commissions')}>Commissions</button>
        <button className={`status-tab ${tab === 'expenses' ? 'active' : ''}`} onClick={() => setTab('expenses')}>Expenses</button>
      </div>

      {tab === 'commissions' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th></th><th>Trans #</th><th>Trans Date</th><th>Commission Date</th>
                <th style={{ textAlign: 'right' }}>Commissionable</th><th>Released Amount</th>
              </tr></thead>
              <tbody>
                {!employee && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>Select an employee to see their releasable commissions.</td></tr>}
                {employee && payables.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>This employee has no unpaid commissions.</td></tr>}
                {payables.map((p) => (
                  <tr key={p.commission_payable_id}>
                    <td><input type="checkbox" checked={!!checked[p.commission_payable_id]} onChange={(e) => toggleCommission(p, e.target.checked)} /></td>
                    <td>{p.commission_payable_no}</td>
                    <td>{formatDate(p.date_created)}</td>
                    <td>{formatMonth(p.period_from)}</td>
                    <td style={{ textAlign: 'right' }}>{money(remaining(p))}</td>
                    <td>
                      <input type="number" min="0" step="0.01" max={Math.max(Number(p.commissionable_amount), Number(p.already_released) || 0)}
                        value={released[p.commission_payable_id] ?? ''}
                        onChange={(e) => setReleased((r) => ({ ...r, [p.commission_payable_id]: e.target.value }))}
                        style={{ width: 140 }} disabled={!checked[p.commission_payable_id]} />
                    </td>
                  </tr>
                ))}
                {payables.length > 0 && (
                  <tr><td colSpan={5} style={{ textAlign: 'right' }}><strong>Total Released</strong></td>
                    <td><strong>{money(totalReleased)}</strong></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'expenses' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Account</th><th>Applies To</th><th>Description</th><th style={{ textAlign: 'right' }}>Amount</th><th></th></tr></thead>
              <tbody>
                {expenses.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 12 }}>No expenses. A negative amount credits the account; a positive amount debits it.</td></tr>}
                {expenses.map((e, i) => (
                  <tr key={i}>
                    <td style={{ minWidth: 260 }}>
                      <EntityPicker
                        label="Account" items={expenseAccounts} value={e.account?.id || ''} getLabel={(a) => `${a.account_code} ${a.account_name}`}
                        columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }]}
                        searchKeys={['account_code', 'account_name']} placeholder="--Select--" onSelect={(a) => setExpense(i, { account: a })}
                      />
                    </td>
                    {/* Only Commission Payable can be pointed at a month -- doing so makes the
                        expense a payback that reduces that month's Released Commission and
                        settles an overpayment, instead of joining the refund pool. The server
                        rejects a target on any other account, so this stays in step with it. */}
                    <td style={{ minWidth: 170 }}>
                      {isCommissionPayable(e.account) ? (
                        <select
                          value={e.applies_to_payable_id || ''}
                          onChange={(ev) => setExpense(i, { applies_to_payable_id: ev.target.value || null })}
                          style={{ width: '100%' }}
                        >
                          <option value="">Not applied to a month</option>
                          {/* commission_payable_id, not id -- /for-employee returns the payable
                              as `SELECT id AS commission_payable_id`, and an undefined value
                              here makes the browser submit the option's TEXT instead. */}
                          {payables.map((p) => (
                            <option key={p.commission_payable_id} value={p.commission_payable_id}>
                              {formatMonth(p.period_from)}
                            </option>
                          ))}
                        </select>
                      ) : <span className="muted">—</span>}
                    </td>
                    <td><input value={e.description} onChange={(ev) => setExpense(i, { description: ev.target.value })} style={{ width: '100%' }} /></td>
                    <td><input type="number" step="0.01" value={e.amount} onChange={(ev) => setExpense(i, { amount: ev.target.value })} style={{ width: 140, textAlign: 'right' }} /></td>
                    <td><button className="btn btn-sm btn-warning" onClick={() => removeExpense(i)}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="btn btn-sm btn-primary" style={{ marginTop: 12 }} onClick={addExpense}>Add Expense</button>
        </div>
      )}
    </div>
  );
}
