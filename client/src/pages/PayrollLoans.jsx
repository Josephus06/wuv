import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import { formatDate, formatPeriod, peso, todayIso } from '../utils/payroll';

const ROUTE = '/payroll-loans';
const LOAN_TYPES = ['SSS Salary Loan', 'SSS Calamity Loan', 'Pag-IBIG Multi-Purpose Loan', 'Pag-IBIG Calamity Loan', 'Company Loan', 'Cash Advance'];
const emptyForm = () => ({
  employee_id: '', loan_type: '', reference_no: '', loan_amount: '', amortization: '', start_date: todayIso(), status: 'active', remarks: '',
});

function statusBadge(r) {
  if (r.is_paid) return <span className="badge badge-success">Paid</span>;
  if (r.status === 'paused') return <span className="badge badge-warning">Paused</span>;
  if (r.status === 'cancelled') return <span className="badge badge-muted">Cancelled</span>;
  return <span className="badge badge-info">Active</span>;
}

export default function PayrollLoans() {
  const { can } = useAuth();
  const [rows, setRows] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('open');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [history, setHistory] = useState(null);

  async function load() {
    setLoading(true);
    const { data } = await api.get('/payroll-setup/loans');
    setRows(data);
    setLoading(false);
  }

  useEffect(() => {
    load();
    api.get('/payroll-setup/employees').then(({ data }) => setEmployees(data)).catch(() => {});
  }, []);

  function open(row) {
    setForm(row ? {
      employee_id: row.employee_id, loan_type: row.loan_type, reference_no: row.reference_no || '', loan_amount: row.loan_amount,
      amortization: row.amortization, start_date: row.start_date, status: row.status, remarks: row.remarks || '',
    } : emptyForm());
    setEditing(row || 'new');
    setError('');
  }

  async function save(e) {
    e.preventDefault();
    setError('');
    try {
      if (editing === 'new') await api.post('/payroll-setup/loans', form);
      else await api.put(`/payroll-setup/loans/${editing.id}`, form);
      setEditing(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    }
  }

  async function remove(row) {
    if (!confirm(`Delete ${row.employee_name}'s ${row.loan_type}?`)) return;
    try {
      await api.delete(`/payroll-setup/loans/${row.id}`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Delete failed');
    }
  }

  async function openHistory(row) {
    const { data } = await api.get(`/payroll-setup/loans/${row.id}/payments`);
    setHistory({ loan: row, payments: data });
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      const isOpen = !r.is_paid && r.status !== 'cancelled';
      if (tab === 'open' && !isOpen) return false;
      if (tab === 'closed' && isOpen) return false;
      return !q || [r.employee_name, r.employee_code, r.loan_type, r.reference_no, r.company_name].filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }, [rows, tab, search]);

  const amount = Number(form.loan_amount) || 0;
  const amort = Number(form.amortization) || 0;
  const payrolls = amount && amort ? Math.ceil(amount / amort) : 0;

  const columns = [
    { key: 'employee_name', label: 'Employee', render: (r) => <>{r.employee_name}<div className="muted" style={{ fontSize: 11 }}>{[r.employee_code, r.company_name].filter(Boolean).join(' · ')}</div></> },
    { key: 'loan_type', label: 'Loan', render: (r) => <>{r.loan_type}{r.reference_no && <div className="muted" style={{ fontSize: 11 }}>#{r.reference_no}</div>}</> },
    { key: 'loan_amount', label: 'Amount', render: (r) => <span className="num">{peso(r.loan_amount)}</span> },
    { key: 'amortization', label: 'Per Payroll', render: (r) => <span className="num">{peso(r.amortization)}</span> },
    {
      key: 'balance',
      label: 'Balance',
      render: (r) => {
        const pct = Math.min(100, Math.round((r.paid / Number(r.loan_amount)) * 100));
        return (
          <div style={{ minWidth: 120 }}>
            <strong className="num">{peso(Math.max(0, r.balance))}</strong>
            <div className="loan-progress"><span style={{ width: `${pct}%` }} /></div>
            <div className="muted" style={{ fontSize: 11 }}>{peso(r.paid)} paid</div>
          </div>
        );
      },
    },
    { key: 'start_date', label: 'Starts', render: (r) => formatDate(r.start_date) },
    { key: 'status', label: 'Status', render: statusBadge },
  ];

  return (
    <div>
      <div className="page-header">
        <h1>Loans</h1>
        {can(ROUTE, 'can_add') && <button className="btn btn-primary" onClick={() => open(null)}>Add Loan</button>}
      </div>

      <div className="status-tabs">
        {[['open', 'Active'], ['closed', 'Paid / Cancelled'], ['all', 'All']].map(([v, l]) => (
          <button key={v} className={`status-tab ${tab === v ? 'active' : ''}`} onClick={() => setTab(v)}>{l}</button>
        ))}
      </div>

      <div className="card" style={{ margin: '16px 0' }}>
        <div className="filter-grid">
          <div className="field">
            <label>Search</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Employee, loan, reference..." />
          </div>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Each payroll deducts the amount per payroll until the loan is repaid. A deduction only counts once its payroll is
          approved, so the balance never moves on a draft.
        </p>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <DataTable
            paginate
            columns={columns}
            rows={filtered}
            emptyLabel="No loans here."
            actions={(row) => (
              <>
                <button className="btn btn-sm" onClick={() => openHistory(row)}>Payments</button>
                {can(ROUTE, 'can_edit') && <button className="btn btn-sm" onClick={() => open(row)}>Edit</button>}
                {can(ROUTE, 'can_delete') && row.paid === 0 && <button className="btn btn-sm btn-danger" onClick={() => remove(row)}>Delete</button>}
              </>
            )}
          />
        )}
      </div>

      {editing && (
        <Modal title={editing === 'new' ? 'Add Loan' : 'Edit Loan'} onClose={() => setEditing(null)}>
          <form onSubmit={save}>
            {error && <div className="error-banner">{error}</div>}
            <div className="field">
              <label>Employee</label>
              <select required value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })}>
                <option value="">— Choose —</option>
                {employees.map((emp) => <option key={emp.id} value={emp.id}>{emp.name}{emp.company_name ? ` (${emp.company_name})` : ''}</option>)}
              </select>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Loan Type</label>
                <input required list="loan-types" value={form.loan_type} onChange={(e) => setForm({ ...form, loan_type: e.target.value })} />
                <datalist id="loan-types">{LOAN_TYPES.map((t) => <option key={t} value={t} />)}</datalist>
              </div>
              <div className="field">
                <label>Reference No.</label>
                <input value={form.reference_no} onChange={(e) => setForm({ ...form, reference_no: e.target.value })} />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Total to Repay</label>
                <input type="number" step="0.01" min="0.01" required value={form.loan_amount} onChange={(e) => setForm({ ...form, loan_amount: e.target.value })} />
              </div>
              <div className="field">
                <label>Deduct per Payroll</label>
                <input type="number" step="0.01" min="0.01" required value={form.amortization} onChange={(e) => setForm({ ...form, amortization: e.target.value })} />
              </div>
            </div>
            {payrolls > 0 && <p className="muted" style={{ marginTop: -4 }}>Repaid over {payrolls} payroll{payrolls > 1 ? 's' : ''} (about {Math.ceil(payrolls / 2)} month{payrolls > 2 ? 's' : ''}).</p>}
            <div className="field-row">
              <div className="field">
                <label>First Deduction From</label>
                <input type="date" required value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
              </div>
              <div className="field">
                <label>Status</label>
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                  <option value="active">Active</option>
                  <option value="paused">Paused (skip deductions for now)</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label>Remarks</label>
              <input value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Save</button>
            </div>
          </form>
        </Modal>
      )}

      {history && (
        <Modal title={`${history.loan.loan_type} · ${history.loan.employee_name}`} onClose={() => setHistory(null)}>
          <p className="muted">
            {peso(history.loan.loan_amount)} loan · {peso(history.loan.paid)} paid · {peso(Math.max(0, history.loan.balance))} balance
          </p>
          {history.payments.length === 0 ? <div className="empty-state">No deductions yet.</div> : (
            <table className="payslip-table">
              <thead><tr><th>Cutoff</th><th>Pay Date</th><th>Status</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {history.payments.map((p) => (
                  <tr key={p.run_id}>
                    <td>{formatPeriod(p.period_start, p.period_end)}</td>
                    <td>{formatDate(p.pay_date)}</td>
                    <td>{p.status === 'approved' ? <span className="badge badge-success">Approved</span> : <span className="badge badge-info">Draft — not counted yet</span>}</td>
                    <td className="num">{peso(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal>
      )}
    </div>
  );
}
