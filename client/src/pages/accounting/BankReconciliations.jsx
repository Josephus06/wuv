import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import Modal from '../../components/Modal';
import MonthYearPicker from '../../components/MonthYearPicker';
import { useAuth } from '../../context/useAuth';

// A bank statement covers a month, so the month is what gets picked -- and the statement date is
// the LAST DAY of it, which is the date the closing balance belongs to. Typing a date invites
// somebody to enter the 1st and reconcile a month that has not happened.
function monthEnd(year, month) {
  // Day 0 of the next month is the last day of this one, and it gets February right.
  const d = new Date(year, month, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Bank Reconciliation -- the list, and starting a new one.
//
// The opening balance is offered from where the last reconciliation on that account finished, so
// the usual case is confirming a figure rather than looking one up. It stays editable because the
// first reconciliation on an account has nothing before it.
const money = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (v) => (v ? String(v).slice(0, 10) : '');

export default function BankReconciliations() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [rows, setRows] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [month, setMonth] = useState(null);
  const [form, setForm] = useState({ account_id: '', statement_date: '', opening_balance: '', statement_balance: '' });

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/bank-reconciliation', { params: { status: status || undefined } });
      setRows(data);
    } catch (e) { setError(e.response?.data?.error || 'Could not load reconciliations.'); }
    setLoading(false);
  }, [status]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/bank-reconciliation/meta/accounts').then(({ data }) => setAccounts(data)).catch(() => {});
  }, []);

  const chosen = accounts.find((a) => String(a.id) === String(form.account_id));

  function pickAccount(id) {
    const acct = accounts.find((a) => String(a.id) === String(id));
    setForm((f) => ({
      ...f,
      account_id: id,
      // Where the last finished reconciliation left this account. Confirming a figure beats
      // hunting for it, and it is still typed over when the statement disagrees.
      opening_balance: acct?.last_statement_balance != null ? String(acct.last_statement_balance) : '',
    }));
  }

  async function start() {
    setError('');
    try {
      const { data } = await api.post('/bank-reconciliation', form);
      navigate(`/accounting/bank-reconciliation/${data.id}`);
    } catch (e) { setError(e.response?.data?.error || 'Could not start that.'); }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Bank Reconciliation</h1>
        {can('/accounting/bank-reconciliation', 'can_add') && (
          <button className="btn btn-primary" onClick={() => { setForm({ account_id: '', statement_date: '', opening_balance: '', statement_balance: '' }); setMonth(null); setStarting(true); }}>
            New Reconciliation
          </button>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">--ALL--</option>
              <option value="open">Open</option>
              <option value="reconciled">Reconciled</option>
            </select>
          </div>
        </div>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Recon #</th>
                  <th>Bank Account</th>
                  <th>Statement Date</th>
                  <th>Statement Balance</th>
                  <th>Reviewed</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    Nothing reconciled yet.
                  </td></tr>
                )}
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Recon #">{r.recon_no}</td>
                    <td data-label="Bank Account">{r.account_code} {r.account_name}</td>
                    <td data-label="Statement Date">{day(r.statement_date)}</td>
                    <td data-label="Statement Balance">{money(r.statement_balance)}</td>
                    {/* How far through the review somebody is -- the part of the job that takes
                        the time, so it belongs in the list rather than only inside. */}
                    <td data-label="Reviewed">
                      {r.line_count ? `${r.settled_count} / ${r.line_count}` : <span className="muted">not imported</span>}
                    </td>
                    <td data-label="Status">
                      <span className={`badge ${r.status === 'reconciled' ? 'badge-success' : 'badge-warning'}`}>
                        {r.status === 'reconciled' ? 'Reconciled' : 'Open'}
                      </span>
                    </td>
                    <td>
                      <Link className="btn btn-sm btn-primary"
                        to={`/accounting/bank-reconciliation/${r.id}`}>Open</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {starting && (
        <Modal title="New Bank Reconciliation" onClose={() => setStarting(false)}>
          <div className="field">
            <label>Bank Account</label>
            <select value={form.account_id} onChange={(e) => pickAccount(e.target.value)}>
              <option value="">—</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.account_code} {a.account_name}</option>)}
            </select>
            {chosen?.last_statement_date && (
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                Last reconciled to {day(chosen.last_statement_date)} at {money(chosen.last_statement_balance)}.
              </div>
            )}
          </div>
          <div className="field-row">
            <div className="field">
              <label>Statement Month</label>
              <MonthYearPicker
                value={month}
                onChange={(v) => {
                  setMonth(v);
                  setForm((f) => ({ ...f, statement_date: v ? monthEnd(v.year, v.month) : '' }));
                }}
                placeholder="Select month"
              />
              {form.statement_date && (
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  Reconciling to {form.statement_date} — the closing date of that statement.
                </div>
              )}
            </div>
            <div className="field">
              <label>Opening Balance</label>
              <input type="number" step="0.01" value={form.opening_balance}
                onChange={(e) => setForm({ ...form, opening_balance: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label>Closing Balance per Statement</label>
            <input type="number" step="0.01" value={form.statement_balance}
              onChange={(e) => setForm({ ...form, statement_balance: e.target.value })} />
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              The figure the bank says the account ended on. Everything is reconciled back to this.
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setStarting(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={!form.account_id || !form.statement_date} onClick={start}>
              Start
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
