import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import { formatDate, formatPeriod, peso, standardPeriod } from '../utils/payroll';

// The cutoff that most likely needs running now: the one that just ended.
function suggestedCutoff() {
  const d = new Date();
  let year = d.getFullYear();
  let month = d.getMonth() + 1;
  let cutoff;
  if (d.getDate() <= 15) {
    // 1st cutoff of this month still running -> last month's 2nd cutoff
    cutoff = 2;
    month -= 1;
    if (month === 0) { month = 12; year -= 1; }
  } else {
    cutoff = 1;
  }
  const m = `${year}-${String(month).padStart(2, '0')}`;
  return { month: m, cutoff, ...standardPeriod(m, cutoff) };
}

export default function Payroll() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [filters, setFilters] = useState({ company_id: '', year: String(new Date().getFullYear()) });
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function load(f = filters) {
    setLoading(true);
    const params = Object.fromEntries(Object.entries(f).filter(([, v]) => v));
    const { data } = await api.get('/payroll', { params });
    setRows(data);
    setLoading(false);
  }

  useEffect(() => {
    load();
    api.get('/payroll-setup/companies').then(({ data }) => setCompanies(data)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function openCreate() {
    setCreating({ company_id: companies.length === 1 ? String(companies[0].id) : '', ...suggestedCutoff(), pay_date: '', notes: '' });
    setError('');
  }

  async function handleCreate(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const [year, month] = creating.month.split('-').map(Number);
    try {
      const { data } = await api.post('/payroll', {
        company_id: creating.company_id, year, month, cutoff: creating.cutoff,
        period_start: creating.period_start, period_end: creating.period_end,
        pay_date: creating.pay_date || undefined, notes: creating.notes,
      });
      navigate(`/payroll/${data.id}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create the payroll');
      setBusy(false);
    }
  }

  // A new month or cutoff resets the dates to its standard 1st–15th / 16th–end.
  function setCutoff(changes) {
    const next = { ...creating, ...changes };
    if (next.month) Object.assign(next, standardPeriod(next.month, next.cutoff));
    setCreating(next);
  }

  function setFilter(k, v) {
    const f = { ...filters, [k]: v };
    setFilters(f);
    load(f);
  }

  const columns = [
    { key: 'company_name', label: 'Company' },
    { key: 'period', label: 'Cutoff', render: (r) => <><strong>{formatPeriod(r.period_start, r.period_end)}</strong><div className="muted" style={{ fontSize: 11 }}>{r.cutoff === 1 ? '1st cutoff' : '2nd cutoff'}</div></> },
    { key: 'pay_date', label: 'Pay Date', render: (r) => formatDate(r.pay_date) },
    { key: 'employee_count', label: 'Employees' },
    { key: 'total_gross', label: 'Gross', render: (r) => <span className="num">{peso(r.total_gross)}</span> },
    { key: 'total_deductions', label: 'Deductions', render: (r) => <span className="num">{peso(r.total_deductions)}</span> },
    { key: 'total_net', label: 'Net Pay', render: (r) => <strong className="num">{peso(r.total_net)}</strong> },
    {
      key: 'status',
      label: 'Status',
      render: (r) => (
        <>
          {r.status === 'approved' ? <span className="badge badge-success">Approved</span> : <span className="badge badge-info">Draft</span>}
          {r.warnings?.length > 0 && <span className="badge badge-warning" style={{ marginLeft: 6 }} title={r.warnings.join('\n')}>{r.warnings.length} note{r.warnings.length > 1 ? 's' : ''}</span>}
        </>
      ),
    },
  ];

  const years = [];
  for (let y = new Date().getFullYear() + 1; y >= 2026; y -= 1) years.push(String(y));

  return (
    <div>
      <div className="page-header">
        <h1>Payroll</h1>
        {can('/payroll', 'can_add') && <button className="btn btn-primary" onClick={openCreate}>New Payroll</button>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Company</label>
            <select value={filters.company_id} onChange={(e) => setFilter('company_id', e.target.value)}>
              <option value="">All companies</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Year</label>
            <select value={filters.year} onChange={(e) => setFilter('year', e.target.value)}>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <DataTable
            paginate
            columns={columns}
            rows={rows}
            emptyLabel="No payrolls yet. Click New Payroll to compute the first cutoff."
            actions={(row) => <button className="btn btn-sm" onClick={() => navigate(`/payroll/${row.id}`)}>Open</button>}
          />
        )}
      </div>

      {creating && (
        <Modal title="New Payroll" onClose={() => setCreating(null)}>
          <form onSubmit={handleCreate}>
            {error && <div className="error-banner">{error}</div>}
            <div className="field">
              <label>Company</label>
              <select required value={creating.company_id} onChange={(e) => setCreating({ ...creating, company_id: e.target.value })}>
                <option value="">— Choose —</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Month</label>
                <input type="month" required value={creating.month} onChange={(e) => setCutoff({ month: e.target.value })} />
              </div>
              <div className="field">
                <label>Cutoff</label>
                <select value={creating.cutoff} onChange={(e) => setCutoff({ cutoff: Number(e.target.value) })}>
                  <option value={1}>1st – 15th</option>
                  <option value={2}>16th – end of month</option>
                </select>
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>From</label>
                <input type="date" required value={creating.period_start} onChange={(e) => setCreating({ ...creating, period_start: e.target.value })} />
              </div>
              <div className="field">
                <label>To</label>
                <input type="date" required min={creating.period_start} value={creating.period_end} onChange={(e) => setCreating({ ...creating, period_end: e.target.value })} />
              </div>
            </div>
            <p className="muted" style={{ marginTop: -4 }}>
              Attendance from these dates is paid. Change them if this company&apos;s cutoff runs on other dates, e.g. the
              12th–26th. The cutoff above decides which half of the month&apos;s SSS, PhilHealth, Pag-IBIG and tax is deducted.
            </p>
            <div className="field-row">
              <div className="field">
                <label>Pay Date (optional)</label>
                <input type="date" value={creating.pay_date} onChange={(e) => setCreating({ ...creating, pay_date: e.target.value })} />
              </div>
              <div className="field">
                <label>Notes</label>
                <input value={creating.notes} onChange={(e) => setCreating({ ...creating, notes: e.target.value })} />
              </div>
            </div>
            <p className="muted">
              Computes every employee of the company from their attendance, pay rate, allowances and loans.
              It stays a draft you can review, adjust and recompute until it is approved.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setCreating(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Computing…' : 'Compute Payroll'}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
