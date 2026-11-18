import { Fragment, useEffect, useState } from 'react';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import Modal from '../../components/Modal';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
// Variance is signed so positive is always GOOD: income above budget, costs below it.
const variance = (income, budget, actual) => (income ? actual - budget : budget - actual);
const pct = (v, budget) => (budget ? `${((v / budget) * 100).toFixed(1)}%` : '—');
const tone = (v) => (v < -0.005 ? { color: 'var(--danger, #b91c1c)' } : v > 0.005 ? { color: 'var(--success, #15803d)' } : undefined);

// Reports > Budget vs Actual: one budget against the GL for a month, a quarter or year-to-date.
// Actuals come from the same derived GL as the Income Statement.
export default function BudgetVsActual() {
  const [view, setView] = useState('sheets');
  return (
    <div>
      <div className="page-header">
        <h1>Budget vs Actual</h1>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className={`btn btn-sm ${view === 'sheets' ? 'btn-primary' : ''}`} onClick={() => setView('sheets')}>Expenses vs Budget</button>
          <button className={`btn btn-sm ${view === 'single' ? 'btn-primary' : ''}`} onClick={() => setView('single')}>By Account</button>
          <button className={`btn btn-sm ${view === 'departments' ? 'btn-primary' : ''}`} onClick={() => setView('departments')}>By Department</button>
        </div>
      </div>
      {view === 'sheets' ? <DeptSheets /> : view === 'single' ? <SingleBudget /> : <ByDepartment />}
    </div>
  );
}

// The accounting workbook's report: Admin Expenses, Selling Expenses and COGS vs Budget, each month
// Actual then Variance (Budget - Actual, so negative = over budget, in red), then the year.
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function DeptSheets() {
  const [options, setOptions] = useState([]);
  const [budgetId, setBudgetId] = useState('');
  const [tab, setTab] = useState('admin');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // AI, mirroring the account report's panel. Everything it says comes from the report the user
  // is looking at, so it is cleared whenever a different budget is generated.
  const [aiBusy, setAiBusy] = useState('');
  const [aiError, setAiError] = useState('');
  const [briefing, setBriefing] = useState('');
  const [question, setQuestion] = useState('');
  const [qa, setQa] = useState([]);
  useEffect(() => {
    api.get('/budgets/report/options').then(({ data: o }) => {
      const dept = o.filter((x) => x.kind === 'department');
      setOptions(dept); if (dept.length) setBudgetId(String(dept[0].id));
    }).catch((e) => setError(e.response?.data?.error || 'Could not load budgets.'));
  }, []);
  async function explain() {
    setAiBusy('explain'); setAiError(''); setBriefing('');
    try { const { data: d } = await api.post('/budgets/report/ai/dept-explain', { budget_id: budgetId }); setBriefing(d.text); }
    catch (e) { setAiError(e.response?.data?.error || 'The AI could not answer.'); }
    setAiBusy('');
  }
  async function ask() {
    const q = question.trim();
    if (!q) return;
    setAiBusy('ask'); setAiError('');
    try {
      const { data: d } = await api.post('/budgets/report/ai/dept-ask', { budget_id: budgetId, question: q, history: qa });
      setQa((prev) => [...prev, { q, a: d.answer }]);
      setQuestion('');
    } catch (e) { setAiError(e.response?.data?.error || 'The AI could not answer.'); }
    setAiBusy('');
  }
  async function generate() {
    if (!budgetId) { setError('Choose a budget.'); return; }
    setLoading(true); setError('');
    setBriefing(''); setQa([]); setAiError('');
    try { const { data: d } = await api.get('/budgets/report/department-sheets', { params: { budget_id: budgetId } }); setData(d); }
    catch (e) { setError(e.response?.data?.error || 'Could not build the report.'); }
    setLoading(false);
  }
  async function extract() {
    try {
      const { data: blob } = await api.get('/budgets/report/department-sheets/export', { params: { budget_id: budgetId }, responseType: 'blob' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = `${data?.budget.fiscal_year || ''}-expenses-vs-budget.xlsx`; a.click(); URL.revokeObjectURL(url);
    } catch { setError('Could not extract the report.'); }
  }
  const red = (v) => (v != null && v < -0.005 ? { color: 'var(--danger, #b91c1c)' } : undefined);
  const cell = (v) => (v == null ? '' : money(v));
  const Y = data ? String(data.budget.fiscal_year).slice(2) : '';
  const band = (i) => (i % 2 ? { background: 'var(--surface-2, #f3f4f6)' } : undefined);
  const src = (i) => (data?.month_source[i] === 't1s' ? 'this system' : data?.month_source[i] === 'missing' ? 'not loaded' : '');
  // Click an actual to see the transactions behind it.
  const [drill, setDrill] = useState(null); // { title, loading, error, data }
  async function openDrill(params, title) {
    setDrill({ title, loading: true });
    try {
      const { data: d } = await api.get('/budgets/report/department-sheets/drill', { params: { budget_id: budgetId, ...params } });
      setDrill({ title, data: d });
    } catch (e) { setDrill({ title, error: e.response?.data?.error || 'Could not load the transactions.' }); }
  }
  const link = (value, params, title) => (value == null ? '' : (
    <button type="button" className="link-btn" style={{ font: 'inherit', padding: 0 }} title="Show the transactions" onClick={() => openDrill(params, title)}>{money(value)}</button>
  ));
  const g = data?.groups.find((x) => x.grp === tab);
  const note = data?.budget.sales_target ? `Note: Budget @ ${(data.budget.sales_target / 1000000).toLocaleString('en-US', { maximumFractionDigits: 2 })}M Sales` : '';
  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field" style={{ gridColumn: 'span 2' }}><label>Department Budget</label>
            <select value={budgetId} onChange={(e) => setBudgetId(e.target.value)}>
              {options.length === 0 && <option value="">No department budgets yet</option>}
              {options.map((o) => <option key={o.id} value={o.id}>{`${o.fiscal_year} · ${o.name} · v${o.version}${o.status === 'draft' ? ' (DRAFT)' : ''}`}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn-primary" disabled={loading} onClick={generate}>{loading ? 'Generating...' : 'Generate'}</button>
          <button className="btn" disabled={!data} onClick={extract}>Extract</button>
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {loading && <LoadingSpinner />}
      {data && !loading && (
        <div className="card">
          {/* Rule-based, so these appear whether or not the AI is reachable -- and the months with
              no actuals are said out loud, because a blank month reads as an underspend otherwise. */}
          {(data.flags?.report || []).map((f, i) => (
            <div key={i} className="warning-banner" style={{ marginBottom: 10 }}>{f.text}</div>
          ))}
          {Object.keys(data.flags?.rows || {}).length > 0 && (
            <div className="error-banner" style={{ marginBottom: 10 }}>
              ⚠ {Object.keys(data.flags.rows).length} department row{Object.keys(data.flags.rows).length === 1 ? '' : 's'} flagged:
              over budget, a one-month spike, spending with no budget, a negative cost, or no department mapped.
              Hover the ⚠ beside a row to see why.
            </div>
          )}

          <div className="card" style={{ marginBottom: 12, background: 'var(--surface-2, #f8fafc)' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <strong>AI</strong>
              {!data.ai_available && <span className="muted">AI is not set up on this server.</span>}
              {data.ai_available && (
                <>
                  <button className="btn btn-sm btn-primary" disabled={!!aiBusy} onClick={explain}>{aiBusy === 'explain' ? 'Thinking...' : 'Explain this report'}</button>
                  <input style={{ flex: 1, minWidth: 240 }} value={question} onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && ask()} placeholder="Ask about these sheets, e.g. which department is furthest over budget?" />
                  <button className="btn btn-sm" disabled={!!aiBusy || !question.trim()} onClick={ask}>{aiBusy === 'ask' ? 'Thinking...' : 'Ask'}</button>
                </>
              )}
            </div>
            {aiError && <div className="error-banner" style={{ marginTop: 8 }}>{aiError}</div>}
            {briefing && <div style={{ whiteSpace: 'pre-wrap', marginTop: 10, lineHeight: 1.5 }}>{briefing}</div>}
            {qa.map((x, i) => (
              <div key={i} style={{ marginTop: 10 }}>
                <div><strong>Q:</strong> {x.q}</div>
                <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}><strong>A:</strong> {x.a}</div>
              </div>
            ))}
            {data.ai_available && (briefing || qa.length > 0) && (
              <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                AI-written from this report's own figures. It is told which months have no actuals yet. Check anything important against the ledger.
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            {data.groups.map((x) => (
              <button key={x.grp} className={`btn btn-sm ${tab === x.grp ? 'btn-primary' : ''}`} onClick={() => setTab(x.grp)}>{data.budget.fiscal_year} {x.label}</button>
            ))}
            <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
              Actuals: the old system up to {data.books_as_of || 'the cut-over'}, this system after.
            </span>
          </div>
          {tab !== 'cogs' && (
            <div className="table-wrap">
              <table style={{ fontFamily: 'Courier New, monospace', fontSize: 12 }}>
                <thead>
                  <tr>
                    <th rowSpan={2}>Department</th><th rowSpan={2} className="text-right" style={{ color: '#0070c0' }}>Monthly Budget</th>
                    {SHORT.map((m, i) => (
                      <th key={m} colSpan={2} style={{ ...band(i), textAlign: 'center' }}>
                        {m}-{Y}{src(i) ? <span className="muted" style={{ fontSize: 10 }}> ({src(i)})</span> : null}
                      </th>
                    ))}
                    <th rowSpan={2} className="text-right">Annual Budget</th><th rowSpan={2} className="text-right">Annual Expenses</th>
                    <th rowSpan={2} className="text-right">Variance</th><th rowSpan={2}>Remarks</th>
                  </tr>
                  <tr>
                    {SHORT.map((m, i) => [
                      <th key={m + 'a'} className="text-right" style={{ ...band(i), fontWeight: 800 }}>ACTUAL</th>,
                      <th key={m + 'v'} className="text-right" style={{ ...band(i), fontWeight: 800 }}>Variance</th>,
                    ])}
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {r.label}
                        {/* The reasons in the title, so a flag can be understood without leaving
                            the row it is on. */}
                        {(data.flags?.rows?.[r.id] || []).length > 0 && (
                          <span
                            style={{ marginLeft: 6, cursor: 'help' }}
                            title={data.flags.rows[r.id].map((f) => `• ${f.text}`).join('\n')}
                          >
                            ⚠
                          </span>
                        )}
                        {r.includes && <div className="muted" style={{ fontSize: 10 }}>{r.includes}</div>}
                      </td>
                      <td className="text-right" style={{ color: '#0070c0', fontWeight: 700 }}>{money(r.budget[0])}</td>
                      {SHORT.map((m, i) => [
                        <td key={m + 'a'} className="text-right" style={band(i)}>{link(r.actual[i], { row_id: r.id, month: i + 1 }, `${r.label} · ${m}-${Y}`)}</td>,
                        <td key={m + 'v'} className="text-right" style={{ ...band(i), ...red(r.variance[i]) }}>{cell(r.variance[i])}</td>,
                      ])}
                      <td className="text-right">{money(r.annual_budget)}</td><td className="text-right">{money(r.annual_actual)}</td>
                      <td className="text-right" style={red(r.annual_variance)}>{money(r.annual_variance)}</td><td>{r.remarks || ''}</td>
                    </tr>
                  ))}
                  <tr style={{ fontWeight: 700, borderTop: '1px solid #000', borderBottom: '3px double #000' }}>
                    <td>Total</td><td className="text-right" style={{ color: '#0070c0' }}>{money(g.totals.budget[0])}</td>
                    {SHORT.map((m, i) => [
                      <td key={m + 'a'} className="text-right" style={band(i)}>{cell(g.totals.actual[i])}</td>,
                      <td key={m + 'v'} className="text-right" style={{ ...band(i), ...red(g.totals.variance[i]) }}>{cell(g.totals.variance[i])}</td>,
                    ])}
                    <td className="text-right">{money(g.totals.annual_budget)}</td><td className="text-right">{money(g.totals.annual_actual)}</td>
                    <td className="text-right" style={red(g.totals.annual_variance)}>{money(g.totals.annual_variance)}</td><td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          {tab === 'cogs' && g.rows[0] && (
            <div className="table-wrap">
              <table style={{ fontFamily: 'Courier New, monospace', fontSize: 12, maxWidth: 760 }}>
                <thead><tr><th>Month</th><th className="text-right">Budget</th><th className="text-right">Actual Expenses</th><th className="text-right">Variance</th></tr></thead>
                <tbody>
                  {SHORT.map((m, i) => (
                    <Fragment key={m}>
                      <tr style={{ borderTop: '1px solid var(--border, #e5e7eb)' }}>
                        <td style={{ fontWeight: 700 }}>{m}-{Y}{src(i) ? <span className="muted" style={{ fontSize: 10 }}> {src(i)}</span> : null}</td>
                        <td className="text-right" style={{ fontWeight: 700 }}>{money(g.rows[0].budget[i])}</td>
                        <td className="text-right" style={{ fontWeight: 700 }}>{link(g.rows[0].actual[i], { row_id: g.rows[0].id, month: i + 1 }, `COGS · ${m}-${Y}`)}</td>
                        <td className="text-right" style={{ fontWeight: 700, ...red(g.rows[0].variance[i]) }}>{cell(g.rows[0].variance[i])}</td>
                      </tr>
                      {(data.cogs_breakdown || []).map((b) => (
                        <tr key={b.line} className="muted" style={b.parent ? { fontSize: 11 } : undefined}>
                          <td></td><td style={{ paddingLeft: b.parent ? 48 : 24 }}>{b.label}</td>
                          <td className="text-right">{link(b.actual[i], { line: b.line, month: i + 1 }, `COGS · ${b.parent ? `${b.parent} · ` : ''}${b.label} · ${m}-${Y}`)}</td><td></td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                  <tr style={{ fontWeight: 700, borderTop: '1px solid #000', borderBottom: '3px double #000' }}>
                    <td>Total</td><td className="text-right">{money(g.rows[0].annual_budget)}</td><td className="text-right">{money(g.rows[0].annual_actual)}</td>
                    <td className="text-right" style={red(g.rows[0].annual_variance)}>{money(g.rows[0].annual_variance)}</td>
                  </tr>
                </tbody>
              </table>
              <p className="muted" style={{ fontSize: 12 }}>Actual = Cost of Goods Sold + the Production departments&apos; operating expenses. Others = COGS booked to the sales teams and branches.</p>
            </div>
          )}

          {note && <div style={{ color: 'var(--danger, #b91c1c)', fontWeight: 700, fontSize: 12, marginTop: 6 }}>{note}</div>}
        </div>
      )}
      {drill && (
        <Modal title={`Transactions: ${drill.title}`} onClose={() => setDrill(null)} xl>
          {drill.loading && <LoadingSpinner />}
          {drill.error && <div className="error-banner">{drill.error}</div>}
          {drill.data && (
            <>
              <div className="muted" style={{ marginBottom: 8 }}>
                {drill.data.transactions.length} transaction{drill.data.transactions.length === 1 ? '' : 's'} ·
                {drill.data.from === 'source' ? ' from the old system (before the cut-over)' : ' from this system'} ·
                total <strong>{money(drill.data.total)}</strong>
              </div>
              <div className="table-wrap" style={{ maxHeight: '65vh', overflow: 'auto' }}>
                <table style={{ fontSize: 12 }}>
                  <thead><tr><th>Date</th><th>Document</th><th>Memo</th><th>Name</th><th>Account</th><th>Department</th><th className="text-right">Debit</th><th className="text-right">Credit</th><th className="text-right">Amount</th></tr></thead>
                  <tbody>
                    {drill.data.transactions.length === 0 && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 16 }}>No transactions.</td></tr>}
                    {drill.data.transactions.map((t, k) => (
                      <tr key={k}>
                        <td style={{ whiteSpace: 'nowrap' }}>{t.date || ''}</td><td style={{ whiteSpace: 'nowrap' }}>{t.document}</td>
                        <td>{t.memo || ''}</td><td>{t.name || ''}</td>
                        <td>{t.account_code} {t.account_name || ''}</td><td>{t.department || ''}</td>
                        <td className="text-right">{t.debit ? money(t.debit) : ''}</td><td className="text-right">{t.credit ? money(t.credit) : ''}</td>
                        <td className="text-right" style={t.amount < 0 ? { color: 'var(--danger, #b91c1c)' } : undefined}>{money(t.amount)}</td>
                      </tr>
                    ))}
                    <tr style={{ fontWeight: 700, borderTop: '2px solid #000' }}><td colSpan={8}>Total</td><td className="text-right">{money(drill.data.total)}</td></tr>
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  );
}

// Every department's approved budget side by side, plus Unassigned: actuals with no department.
function ByDepartment() {
  const now = new Date();
  const [form, setForm] = useState({ year: String(now.getFullYear()), period: 'ytd', month: String(now.getMonth() + 1) });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  async function generate() {
    setLoading(true); setError('');
    try { const { data: d } = await api.get('/budgets/report/departments', { params: form }); setData(d); }
    catch (e) { setError(e.response?.data?.error || 'Could not build the report.'); }
    setLoading(false);
  }
  const rows = data ? [...data.sections.map((sec) => ({ ...sec })), { key: 'net_income', label: 'Net Income', income: true, strong: true }] : [];
  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field"><label>Fiscal Year</label>
            <select value={form.year} onChange={(e) => set({ year: e.target.value })}>
              {[now.getFullYear() + 1, now.getFullYear(), now.getFullYear() - 1].map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div className="field"><label>Period</label>
            <select value={form.period} onChange={(e) => set({ period: e.target.value })}>
              <option value="month">Month</option><option value="quarter">Quarter to date</option><option value="ytd">Year to date</option>
            </select>
          </div>
          <div className="field"><label>{form.period === 'month' ? 'Month' : 'Up to'}</label>
            <select value={form.month} onChange={(e) => set({ month: e.target.value })}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} disabled={loading} onClick={generate}>{loading ? 'Generating...' : 'Generate'}</button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {loading && <LoadingSpinner />}
      {data && !loading && (
        <div className="card">
          <div style={{ marginBottom: 10 }}><strong>All departments</strong> · {data.period_label} · {data.approved_department_budgets} approved department budget{data.approved_department_budgets === 1 ? '' : 's'}</div>
          {data.unassigned_cost_share > 0 && (
            <div className="error-banner" style={{ marginBottom: 10 }}>
              {data.unassigned_cost_share}% of this period's costs carry no department (the Unassigned column), so department figures understate
              spending. Department is now required on new Cheques, Journals and Vendor Bills.
            </div>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th rowSpan={2}>Section</th>
                  {data.columns.map((c) => <th key={c.key} colSpan={3} style={{ textAlign: 'center' }}>{c.label}{!c.has_budget && c.key !== 'unassigned' ? ' (no budget)' : ''}</th>)}
                </tr>
                <tr>{data.columns.map((c) => ['Budget', 'Actual', 'Var.'].map((h) => <th key={c.key + h} className="text-right">{h}</th>))}</tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} style={r.strong ? { fontWeight: 800, borderTop: '2px solid var(--border, #d1d5db)' } : undefined}>
                    <td>{r.label}</td>
                    {data.columns.map((c) => {
                      const bgt = c.budget[r.key] || 0; const act = c.actual[r.key] || 0;
                      const v = variance(r.income, bgt, act);
                      return [
                        <td key={c.key + 'b'} className="text-right">{c.has_budget ? money(bgt) : '—'}</td>,
                        <td key={c.key + 'a'} className="text-right">{money(act)}</td>,
                        <td key={c.key + 'v'} className="text-right" style={c.has_budget ? tone(v) : undefined}>{c.has_budget ? money(v) : '—'}</td>,
                      ];
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function SingleBudget() {
  const [options, setOptions] = useState([]);
  const [form, setForm] = useState({ budget_id: '', period: 'ytd', month: String(new Date().getMonth() + 1) });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  // AI: a briefing, and questions about what is on screen. Both are asked of the report exactly as
  // generated (budget / period / month), never of a half-changed filter.
  const [generated, setGenerated] = useState(null);
  const [briefing, setBriefing] = useState('');
  const [question, setQuestion] = useState('');
  const [qa, setQa] = useState([]);
  const [aiBusy, setAiBusy] = useState('');
  const [aiError, setAiError] = useState('');

  useEffect(() => {
    api.get('/budgets/report/options').then(({ data: o }) => {
      setOptions(o);
      if (o.length) set({ budget_id: String(o[0].id) });
    }).catch((e) => setError(e.response?.data?.error || 'Could not load budgets.'));
  }, []);

  async function generate() {
    if (!form.budget_id) { setError('Choose a budget.'); return; }
    setLoading(true); setError('');
    try {
      const { data: d } = await api.get('/budgets/report/vs-actual', { params: form });
      setData(d); setGenerated({ ...form }); setBriefing(''); setQa([]); setAiError('');
    }
    catch (e) { setError(e.response?.data?.error || 'Could not build the report.'); }
    setLoading(false);
  }
  async function extract() {
    try {
      const { data: blob } = await api.get('/budgets/report/vs-actual/export', { params: form, responseType: 'blob' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = `budget-vs-actual-${form.month}.xlsx`; a.click(); URL.revokeObjectURL(url);
    } catch { setError('Could not extract the report.'); }
  }

  async function explain() {
    setAiBusy('explain'); setAiError('');
    try { const { data: d } = await api.post('/budgets/report/ai/explain', generated); setBriefing(d.text); }
    catch (e) { setAiError(e.response?.data?.error || 'The AI could not explain this report.'); }
    setAiBusy('');
  }
  async function ask() {
    const q = question.trim(); if (!q) return;
    setAiBusy('ask'); setAiError('');
    try {
      const { data: d } = await api.post('/budgets/report/ai/ask', { ...generated, question: q, history: qa });
      setQa((prev) => [...prev, { q, a: d.answer }]); setQuestion('');
    } catch (e) { setAiError(e.response?.data?.error || 'The AI could not answer.'); }
    setAiBusy('');
  }

  const label = (o) => `${o.fiscal_year} · ${o.name} · ${o.dimension_label} · v${o.version}${o.status === 'draft' ? ' (DRAFT)' : ''}`;

  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field" style={{ gridColumn: 'span 2' }}>
            <label>Budget</label>
            <select value={form.budget_id} onChange={(e) => set({ budget_id: e.target.value })}>
              {options.length === 0 && <option value="">No budgets yet</option>}
              {options.map((o) => <option key={o.id} value={o.id}>{label(o)}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Period</label>
            <select value={form.period} onChange={(e) => set({ period: e.target.value })}>
              <option value="month">Month</option>
              <option value="quarter">Quarter to date</option>
              <option value="ytd">Year to date</option>
            </select>
          </div>
          <div className="field">
            <label>{form.period === 'month' ? 'Month' : 'Up to'}</label>
            <select value={form.month} onChange={(e) => set({ month: e.target.value })}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn-primary" disabled={loading} onClick={generate}>{loading ? 'Generating...' : 'Generate'}</button>
          <button className="btn" disabled={!data} onClick={extract}>Extract</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading && <LoadingSpinner />}
      {data && !loading && (
        <div className="card">
          {data.flag_count > 0 && (
            <div className="error-banner" style={{ marginBottom: 10 }}>
              ⚠ {data.flag_count} account{data.flag_count === 1 ? '' : 's'} flagged: the actual may be wrong (a spike, mostly manual
              adjustments, a negative cost, or spending with no budget). Hover the ⚠ beside an account to see why.
            </div>
          )}
          <div className="card" style={{ marginBottom: 12, background: 'var(--surface-2, #f8fafc)' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <strong>AI</strong>
              {!data.ai_available && <span className="muted">AI is not set up on this server.</span>}
              {data.ai_available && (
                <>
                  <button className="btn btn-sm btn-primary" disabled={!!aiBusy} onClick={explain}>{aiBusy === 'explain' ? 'Thinking...' : 'Explain this report'}</button>
                  <input style={{ flex: 1, minWidth: 240 }} value={question} onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && ask()} placeholder="Ask about these numbers, e.g. why are operating expenses over budget?" />
                  <button className="btn btn-sm" disabled={!!aiBusy || !question.trim()} onClick={ask}>{aiBusy === 'ask' ? 'Thinking...' : 'Ask'}</button>
                </>
              )}
            </div>
            {aiError && <div className="error-banner" style={{ marginTop: 8 }}>{aiError}</div>}
            {briefing && <div style={{ whiteSpace: 'pre-wrap', marginTop: 10, lineHeight: 1.5 }}>{briefing}</div>}
            {qa.map((x, i) => (
              <div key={i} style={{ marginTop: 10 }}>
                <div><strong>Q:</strong> {x.q}</div>
                <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}><strong>A:</strong> {x.a}</div>
              </div>
            ))}
            {data.ai_available && (briefing || qa.length > 0) && (
              <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>AI-written from this report's figures and the transactions behind them. Check anything important against the ledger.</div>
            )}
          </div>
          <div style={{ marginBottom: 10 }}>
            <strong>{data.budget.name}</strong> · {data.budget.dimension_label} · {data.period_label}
            {data.budget.status === 'draft' && <span className="badge badge-warning" style={{ marginLeft: 8 }}>Draft budget</span>}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th><th className="text-right">Budget</th><th className="text-right">Actual</th>
                  <th className="text-right">Variance</th><th className="text-right">%</th>
                  <th className="text-right">YTD Budget</th><th className="text-right">YTD Actual</th><th className="text-right">YTD Variance</th>
                  <th className="text-right">Annual Budget</th>
                </tr>
              </thead>
              <tbody>
                {data.sections.map((s) => (
                  <Fragment key={s.key}>
                    <tr><td colSpan={9} style={{ fontWeight: 700, background: 'var(--surface-2, #f3f4f6)' }}>{s.label}</td></tr>
                    {s.rows.length === 0 && <tr><td colSpan={9} className="muted">Nothing budgeted or booked.</td></tr>}
                    {s.rows.map((r) => {
                      const v = variance(s.income, r.budget, r.actual); const yv = variance(s.income, r.ytd_budget, r.ytd_actual);
                      return (
                        <tr key={r.account_id}>
                          <td>
                            {r.account_code} — {r.account_name}
                            {r.flags?.length > 0 && (
                              <span title={r.flags.map((f) => f.text).join('\n')} style={{ marginLeft: 6, cursor: 'help', color: 'var(--danger, #b91c1c)' }}>⚠</span>
                            )}
                          </td>
                          <td className="text-right">{money(r.budget)}</td>
                          <td className="text-right">{money(r.actual)}</td>
                          <td className="text-right" style={tone(v)}>{money(v)}</td>
                          <td className="text-right" style={tone(v)}>{pct(v, r.budget)}</td>
                          <td className="text-right">{money(r.ytd_budget)}</td>
                          <td className="text-right">{money(r.ytd_actual)}</td>
                          <td className="text-right" style={tone(yv)}>{money(yv)}</td>
                          <td className="text-right muted">{money(r.annual_budget)}</td>
                        </tr>
                      );
                    })}
                    {(() => {
                      const T = s.totals; const v = variance(s.income, T.budget, T.actual); const yv = variance(s.income, T.ytd_budget, T.ytd_actual);
                      return (
                        <tr style={{ fontWeight: 700 }}>
                          <td>Total {s.label}</td>
                          <td className="text-right">{money(T.budget)}</td><td className="text-right">{money(T.actual)}</td>
                          <td className="text-right" style={tone(v)}>{money(v)}</td><td className="text-right" style={tone(v)}>{pct(v, T.budget)}</td>
                          <td className="text-right">{money(T.ytd_budget)}</td><td className="text-right">{money(T.ytd_actual)}</td>
                          <td className="text-right" style={tone(yv)}>{money(yv)}</td><td></td>
                        </tr>
                      );
                    })()}
                  </Fragment>
                ))}
                {[['Gross Profit', 'gross_profit'], ['Net Income', 'net_income']].map(([lbl, k]) => {
                  const S = data.summary; const v = S.actual[k] - S.budget[k]; const yv = S.ytd_actual[k] - S.ytd_budget[k];
                  return (
                    <tr key={k} style={{ fontWeight: 800, borderTop: '2px solid var(--border, #d1d5db)' }}>
                      <td>{lbl}</td>
                      <td className="text-right">{money(S.budget[k])}</td><td className="text-right">{money(S.actual[k])}</td>
                      <td className="text-right" style={tone(v)}>{money(v)}</td><td className="text-right" style={tone(v)}>{pct(v, S.budget[k])}</td>
                      <td className="text-right">{money(S.ytd_budget[k])}</td><td className="text-right">{money(S.ytd_actual[k])}</td>
                      <td className="text-right" style={tone(yv)}>{money(yv)}</td><td></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ marginTop: 10, fontSize: 12 }}>
            Variance is positive when it is good for the business: income above budget, costs below it. Actuals are the same
            GL figures as the Income Statement{data.budget.dimension !== 'company' ? ', counting only transactions carrying this budget\'s department/location' : ''}.
          </p>
        </div>
      )}
    </div>
  );
}
