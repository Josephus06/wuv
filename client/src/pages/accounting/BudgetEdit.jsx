import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../../api/client';
import { useAuth } from '../../context/useAuth';
import LoadingSpinner from '../../components/LoadingSpinner';
import DeptBudgetEdit from './DeptBudgetEdit';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
const SCOPE = { pl: 'P&L', pl_capex: 'P&L + Capital Spending' };
const STATUS = { draft: 'Draft', approved: 'Approved', superseded: 'Superseded' };
const zeros = () => new Array(12).fill(0);

// One budget: posting accounts down the side, January to December across. Only a draft is
// editable; an approved budget is revised by making a new version of it.
export default function BudgetEdit() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [b, setB] = useState(null);
  const [amounts, setAmounts] = useState({}); // account_id -> [12 strings/numbers]
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pct, setPct] = useState('0');
  const [notes, setNotes] = useState({}); // account_id -> why AI Suggest chose that figure

  async function load() {
    try {
      const { data } = await api.get(`/budgets/${id}`);
      setB(data); setAmounts(data.amounts || {}); setDirty(false);
    } catch (e) { setError(e.response?.data?.error || 'Could not load the budget.'); }
  }
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const editable = b?.status === 'draft' && can('/budgets', 'can_edit');
  const sections = useMemo(() => {
    const out = [];
    for (const a of b?.accounts || []) {
      let s = out.find((x) => x.key === a.section);
      if (!s) { s = { key: a.section, label: a.section_label, accounts: [] }; out.push(s); }
      s.accounts.push(a);
    }
    return out;
  }, [b]);

  const rowOf = (accountId) => amounts[accountId] || zeros();
  const rowTotal = (accountId) => rowOf(accountId).reduce((s, v) => s + (Number(v) || 0), 0);
  function setCell(accountId, i, value) {
    setAmounts((prev) => { const row = [...(prev[accountId] || zeros())]; row[i] = value; return { ...prev, [accountId]: row }; });
    setDirty(true);
  }
  // Type an annual figure into the Total and it is spread evenly, the rounding cent on December.
  function spread(accountId, annual) {
    const total = Math.round((Number(annual) || 0) * 100);
    const each = Math.floor(total / 12);
    const row = Array.from({ length: 12 }, (_, i) => (i < 11 ? each : total - each * 11) / 100);
    setAmounts((prev) => ({ ...prev, [accountId]: row }));
    setDirty(true);
  }
  const sectionMonth = (s, i) => s.accounts.reduce((sum, a) => sum + (Number(rowOf(a.id)[i]) || 0), 0);
  const sectionTotal = (s) => s.accounts.reduce((sum, a) => sum + rowTotal(a.id), 0);

  async function run(label, fn) {
    setBusy(label); setError(''); setNotice('');
    try { await fn(); } catch (e) { setError(e.response?.data?.error || `Could not ${label.toLowerCase()}.`); }
    setBusy('');
  }
  const save = () => run('Save', async () => {
    const payload = {};
    for (const [k, row] of Object.entries(amounts)) payload[k] = row.map((v) => Number(v) || 0);
    const { data } = await api.put(`/budgets/${id}/lines`, { amounts: payload });
    setDirty(false); setNotice(`Saved (${data.saved_lines} non-zero month figures).`);
  });
  const fillFromActuals = () => run('Fill from actuals', async () => {
    if (dirty && !window.confirm('Replace the figures on screen with last year\'s actuals?')) return;
    const { data } = await api.get(`/budgets/${id}/suggest-from-actuals`, { params: { pct } });
    setAmounts(data.amounts); setDirty(true);
    setNotice(`Filled from ${data.from_year} actuals${Number(pct) ? ` ${Number(pct) > 0 ? '+' : ''}${pct}%` : ''}. Review, then Save.`);
  });
  const aiSuggest = () => run('AI Suggest', async () => {
    if (dirty && !window.confirm('Replace the figures on screen with the AI suggestion?')) return;
    const { data } = await api.get(`/budgets/${id}/ai-suggest`);
    setAmounts(data.amounts); setNotes(data.notes || {}); setDirty(true);
    const n = Object.keys(data.amounts || {}).length;
    setNotice(n
      ? `${data.source === 'ai' ? 'AI suggested' : 'Trend-based suggestion for'} ${n} accounts from ${data.based_on.join(', ')} actuals -- last year spread by each account's seasonality, then a growth % (reason under each account). Review, then Save.`
      : 'There were no actuals last year to base a suggestion on.');
  });
  const exportFile = () => run('Export', async () => {
    const { data } = await api.get(`/budgets/${id}/export`, { responseType: 'blob' });
    const url = URL.createObjectURL(data); const a = document.createElement('a');
    a.href = url; a.download = `budget-${b.fiscal_year}-${b.id}.xlsx`; a.click(); URL.revokeObjectURL(url);
  });
  const importFile = (file) => run('Import', async () => {
    if (!file) return;
    const base64 = await new Promise((resolve, reject) => {
      const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.onerror = reject; r.readAsDataURL(file);
    });
    const { data } = await api.post(`/budgets/${id}/import`, { file_base64: base64 });
    await load();
    setNotice(`Imported ${data.saved_lines} month figures.${data.skipped_codes.length ? ` Skipped unknown account codes: ${data.skipped_codes.join(', ')}.` : ''}`);
  });
  const approve = () => run('Approve', async () => {
    if (dirty) { setError('Save your changes before approving.'); return; }
    if (!window.confirm('Approve this budget? It becomes read-only, and replaces any earlier approved budget for the same year and department/location.')) return;
    await api.post(`/budgets/${id}/approve`); await load(); setNotice('Approved.');
  });
  const newVersion = () => run('New version', async () => {
    const { data } = await api.post(`/budgets/${id}/new-version`);
    navigate(`/budgets/${data.id}`);
  });
  const remove = () => run('Delete', async () => {
    if (!window.confirm('Delete this draft budget?')) return;
    await api.delete(`/budgets/${id}`); navigate('/budgets');
  });

  if (!b) return error ? <div className="error-banner" style={{ margin: 20 }}>{error}</div> : <LoadingSpinner />;
  // The accounting workbook's format: one monthly budget per department, plus COGS.
  if (b.kind === 'department') return <DeptBudgetEdit budget={b} onReload={load} />;
  const grand = sections.reduce((s, sec) => s + sectionTotal(sec), 0);

  return (
    <div>
      <div className="page-header">
        <h1>{b.name} <span className="muted" style={{ fontSize: '0.6em' }}>FY {b.fiscal_year} · v{b.version}</span></h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn btn-sm" to={'/budgets'}>Back</Link>
          <button className="btn btn-sm" disabled={!!busy} onClick={exportFile}>Export to Excel</button>
          {editable && (
            <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
              Import Excel
              <input type="file" accept=".xlsx" style={{ display: 'none' }} onChange={(e) => { importFile(e.target.files[0]); e.target.value = ''; }} />
            </label>
          )}
          {editable && <button className="btn btn-sm btn-primary" disabled={!!busy || !dirty} onClick={save}>{busy === 'Save' ? 'Saving...' : 'Save'}</button>}
          {b.status === 'draft' && can('/budgets', 'can_approve') && <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={approve}>Approve</button>}
          {b.status !== 'draft' && can('/budgets', 'can_add') && <button className="btn btn-sm" disabled={!!busy} onClick={newVersion}>New Version</button>}
          {b.status === 'draft' && can('/budgets', 'can_delete') && <button className="btn btn-sm btn-danger" disabled={!!busy} onClick={remove}>Delete</button>}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16, display: 'flex', gap: 32, flexWrap: 'wrap' }}>
        <div><div className="muted">Budgeted by</div><strong>{b.dimension_label}</strong></div>
        <div><div className="muted">Covers</div><strong>{SCOPE[b.scope]}</strong></div>
        <div><div className="muted">Status</div><strong>{STATUS[b.status]}</strong>{b.approved_by_name ? ` by ${b.approved_by_name}` : ''}</div>
        <div><div className="muted">Annual total (all accounts)</div><strong>{money(grand)}</strong></div>
        {editable && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', marginLeft: 'auto' }}>
            <div className="field" style={{ margin: 0 }}>
              <label>Start from {b.fiscal_year - 1} actuals, adjusted by %</label>
              <input type="number" value={pct} onChange={(e) => setPct(e.target.value)} style={{ width: 90 }} />
            </div>
            <button className="btn btn-sm" disabled={!!busy} onClick={fillFromActuals}>{busy === 'Fill from actuals' ? 'Filling...' : 'Fill'}</button>
            <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={aiSuggest} title="Last year's actuals spread by each account's seasonality, with a growth % per account chosen by AI from the past three years">
              {busy === 'AI Suggest' ? 'Thinking...' : 'AI Suggest'}
            </button>
          </div>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="card" style={{ marginBottom: 12, padding: '8px 12px' }}>{notice}</div>}
      {editable && <p className="muted" style={{ margin: '0 0 8px' }}>Type a month, or type a yearly figure in Total to spread it evenly across the twelve months.</p>}

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th style={{ minWidth: 220 }}>Account</th>{MONTHS.map((m) => <th key={m} className="text-right">{m}</th>)}<th className="text-right">Total</th></tr>
            </thead>
            <tbody>
              {sections.map((s) => (
                <Fragment key={s.key}>
                  <tr><td colSpan={14} style={{ fontWeight: 700, background: 'var(--surface-2, #f3f4f6)' }}>{s.label}</td></tr>
                  {s.accounts.map((a) => (
                    <tr key={a.id}>
                      <td>
                        {a.account_code} — {a.account_name}
                        {notes[a.id] && <div className="muted" style={{ fontSize: 11 }}>{notes[a.id]}</div>}
                      </td>
                      {MONTHS.map((m, i) => (
                        <td key={m} className="text-right">
                          {editable
                            ? <input type="number" step="0.01" style={{ width: 92, textAlign: 'right' }} value={rowOf(a.id)[i] || ''} onChange={(e) => setCell(a.id, i, e.target.value)} />
                            : money(rowOf(a.id)[i] || 0)}
                        </td>
                      ))}
                      <td className="text-right">
                        {editable
                          ? <input type="number" step="0.01" style={{ width: 110, textAlign: 'right', fontWeight: 600 }} value={rowTotal(a.id) ? Math.round(rowTotal(a.id) * 100) / 100 : ''} onChange={(e) => spread(a.id, e.target.value)} />
                          : <strong>{money(rowTotal(a.id))}</strong>}
                      </td>
                    </tr>
                  ))}
                  <tr style={{ fontWeight: 700 }}>
                    <td>Total {s.label}</td>
                    {MONTHS.map((m, i) => <td key={m} className="text-right">{money(sectionMonth(s, i))}</td>)}
                    <td className="text-right">{money(sectionTotal(s))}</td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
