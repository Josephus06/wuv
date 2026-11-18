import { useCallback, useEffect, useState } from 'react';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import EntityPicker from '../../components/EntityPicker';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
const day = (v) => (v ? String(v).slice(0, 10) : '');

// The month just gone -- what you actually want open when you run this in early October.
function lastMonth() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: iso(first), to: iso(last), payeeType: '', payee: null };
}

// The filters as query params. Payee Type alone narrows to all suppliers or all employees; a
// chosen Payee narrows to that one.
const filterParams = (r) => ({
  from: r.from, to: r.to,
  ...(r.payeeType ? { payee_type: r.payeeType } : {}),
  ...(r.payeeType && r.payee ? { payee_id: r.payee.id } : {}),
});

// Every disbursement that left the company in a date range -- Cheques and Bill Payments together,
// on the day the money was RELEASED rather than the day the document was raised.
export default function DisbursementReport() {
  const [range, setRange] = useState(lastMonth);
  const [applied, setApplied] = useState(lastMonth);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Suppliers / employees who have been paid, for the Payee picker; reloaded when the type changes.
  const [payees, setPayees] = useState([]);

  useEffect(() => {
    setPayees([]);
    if (!range.payeeType) return;
    api.get('/reports/disbursement/payees', { params: { type: range.payeeType } })
      .then(({ data: d }) => setPayees(Array.isArray(d) ? d : []))
      .catch(() => setPayees([]));
  }, [range.payeeType]);

  const load = useCallback(async (r) => {
    setLoading(true); setError('');
    try {
      const { data: d } = await api.get('/reports/disbursement', { params: filterParams(r) });
      setData(d);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not load the report.');
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(applied); }, [load, applied]);

  async function download() {
    const res = await api.get('/reports/disbursement/export', {
      params: filterParams(applied),
      responseType: 'blob',
    });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = `disbursement-${applied.from}-to-${applied.to}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const rows = data?.rows || [];
  const pending = data?.bill_payments_without_release_date || 0;

  return (
    <div>
      <div className="page-header">
        <h1>Disbursement Report</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" disabled={loading || !rows.length} onClick={download}>
            Export to Excel
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Date Released From</label>
            <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          </div>
          <div className="field">
            <label>To</label>
            <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
          </div>
          <div className="field">
            <label>Payee Type</label>
            <select value={range.payeeType} onChange={(e) => setRange({ ...range, payeeType: e.target.value, payee: null })}>
              <option value="">All</option>
              <option value="supplier">Supplier</option>
              <option value="employee">Employee</option>
            </select>
          </div>
          {range.payeeType && (
            <div className="field">
              <label>{range.payeeType === 'supplier' ? 'Supplier' : 'Employee'}</label>
              <EntityPicker
                label={range.payeeType === 'supplier' ? 'Supplier' : 'Employee'}
                items={payees} value={range.payee?.id || ''} getLabel={(x) => x?.name}
                columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']}
                placeholder={`All ${range.payeeType === 'supplier' ? 'suppliers' : 'employees'}`}
                onSelect={(x) => setRange({ ...range, payee: x })}
                onClear={() => setRange({ ...range, payee: null })}
              />
            </div>
          )}
          <div className="field" style={{ alignSelf: 'end' }}>
            <button className="btn btn-primary" onClick={() => setApplied({ ...range })}>Generate</button>
          </div>
        </div>
      </div>

      {/* A payment with no Date Released has not been released as far as this system knows, so it
          is correctly absent -- but anyone reconciling a month has to be told that rather than
          left to assume the report is complete. Cheques all carry one; bill payments only have it
          once somebody fills it in, because the source system does not supply it. */}
      {pending > 0 && (
        <div className="warning-banner" style={{ marginBottom: 8 }}>
          {pending} bill payment{pending === 1 ? ' has' : 's have'} no Date Released and
          {pending === 1 ? ' is' : ' are'} not included in any date range. Set it on the Bill
          Payment screen for {pending === 1 ? 'it' : 'them'} to appear here.
        </div>
      )}

      {loading ? <LoadingSpinner /> : (
        <div className="card">
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            {rows.length} disbursement{rows.length === 1 ? '' : 's'} released {applied.from} to {applied.to}
            {applied.payeeType && <> to {applied.payee ? applied.payee.name : `all ${applied.payeeType === 'supplier' ? 'suppliers' : 'employees'}`}</>}
            {rows.length > 0 && <> — total {money(data?.total_amount)}</>}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date released</th><th>Payee</th><th>Date Created</th><th>Cheque No.</th>
                  <th>Account</th><th>Memo</th><th>Source</th><th style={{ textAlign: 'right' }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    Nothing was released in this range.
                  </td></tr>
                )}
                {rows.map((r, i) => (
                  <tr key={`${r.source}-${r.doc_no}-${i}`}>
                    <td>{day(r.date_released)}</td>
                    <td>{r.payee || '—'}</td>
                    <td>{day(r.date_created)}</td>
                    <td>{r.cheque_no || '—'}</td>
                    <td>{r.account_code ? `${r.account_code} — ${r.account_name}` : (r.account_name || '—')}</td>
                    <td>{r.memo || ''}</td>
                    <td>{r.source}</td>
                    <td style={{ textAlign: 'right' }}>{money(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
