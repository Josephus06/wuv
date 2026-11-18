import { useEffect, useMemo, useRef, useState } from 'react';
import BirCompanyPicker from '../../components/BirCompanyPicker';
import { useSearchParams } from 'react-router-dom';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import { useAuth } from '../../context/useAuth';

// BIR Reports > Tax Return (asked 2026-11-07, after Odoo's Tax Return page): a period, a Report switcher
// (2550Q, SAWT & QAP, by Tax > Account, by Account > Tax, Generic), Comparison, PDF (print) and XLSX.
// The server builds every report as groups of columns + rows (routes/birTaxReturn.js); this page draws
// them, folds rows under their parent, and on the 2550Q takes the lines T1S cannot know -- typed figures
// recompute the return on the server, and are not saved.

const REPORTS = [
  ['2550q', '2550Q (PH)'],
  ['sawt_qap', 'SAWT & QAP (PH)'],
  ['tax_account', 'Group by: Tax > Account'],
  ['account_tax', 'Group by: Account > Tax'],
  ['generic', 'Generic Tax report'],
];
const COMPARE = [['', 'No Comparison'], ['previous', 'Previous Period'], ['last_year', 'Same Period Last Year'], ['custom', 'Custom Dates']];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
function defaultPeriod() {
  const t = manilaToday(); let y = Number(t.slice(0, 4)); let q = Math.floor((Number(t.slice(5, 7)) - 1) / 3);
  if (q === 0) { q = 4; y -= 1; }
  return { from: `${y}-${pad(q * 3 - 2)}-01`, to: `${y}-${pad(q * 3)}-${lastDay(y, q * 3)}` };
}
const money = (v) => (v == null || v === '' ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
function fmtCell(v, col) {
  if (v == null || v === '') return '';
  if (col?.pct) return `${Number(v).toFixed(1)}%`;
  if (col?.num) return money(v);
  return v;
}

function Dropdown({ label, children, open, setOpen }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open, setOpen]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className={`btn btn-sm${open ? ' btn-primary' : ''}`} onClick={() => setOpen(!open)}>{label}</button>
      {open && (
        <div className="card trp-menu" style={{ position: 'absolute', top: '110%', left: 0, zIndex: 30, minWidth: 260, padding: 10, boxShadow: '0 6px 20px rgba(0,0,0,.15)' }}>
          {children}
        </div>
      )}
    </div>
  );
}
const MenuItem = ({ on, children, onClick }) => (
  <button type="button" className="link-btn" style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 4px', fontWeight: on ? 700 : 400 }} onClick={onClick}>
    <span style={{ display: 'inline-block', width: 16 }}>{on ? '✓' : ''}</span>{children}
  </button>
);

export default function BirTaxReturn() {
  const { can } = useAuth();
  const mayPrint = can('/reports/bir-tax-return', 'can_print');
  const [params, setParams] = useSearchParams();
  const def = defaultPeriod();
  const q = {
    report: params.get('report') || '2550q',
    from: params.get('from') || def.from,
    to: params.get('to') || def.to,
    compare: params.get('compare') || '',
    compare_count: params.get('compare_count') || '1',
    compare_from: params.get('compare_from') || '',
    compare_to: params.get('compare_to') || '',
    order: params.get('order') || 'descending',
    tab: params.get('tab') || 'sawt',
  };
  const setQ = (patch) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v === '' || v == null) p.delete(k); else p.set(k, v); }
    setParams(p, { replace: true });
  };
  const [manual, setManual] = useState({}); // 2550Q typed lines
  const [manualSent, setManualSent] = useState({});
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(''); // which dropdown is open
  const [open, setOpen] = useState({}); // row id -> expanded (overrides the row's default)

  // Typed 2550Q figures go to the server after a pause, so a figure being typed is not sent per key.
  useEffect(() => { const t = setTimeout(() => setManualSent(manual), 600); return () => clearTimeout(t); }, [manual]);
  useEffect(() => { setManual({}); setManualSent({}); }, [q.from, q.to]);

  const query = useMemo(() => ({ ...q, manual: q.report === '2550q' && Object.keys(manualSent).length ? JSON.stringify(manualSent) : undefined }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params.toString(), manualSent]);

  useEffect(() => {
    let live = true;
    setLoading((d) => d || !data); setError('');
    api.get('/reports/bir-tax-return', { params: query })
      .then(({ data: d }) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e.response?.data?.error || 'Could not build the report.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  async function xlsx() {
    setBusy(true);
    try {
      const res = await api.get('/reports/bir-tax-return/xlsx', { params: query, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url; a.download = `tax-return-${q.report}${q.report === 'sawt_qap' ? `-${q.tab}` : ''}-${q.from}_${q.to}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e.response?.data?.error || 'Could not download the XLSX.'); }
    setBusy(false);
  }

  // Period presets, as Odoo's date filter.
  const [py, pm] = q.from.split('-').map(Number);
  const setMonth = (y, m) => setQ({ from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${lastDay(y, m)}` });
  const setQuarter = (y, n) => setQ({ from: `${y}-${pad(n * 3 - 2)}-01`, to: `${y}-${pad(n * 3)}-${lastDay(y, n * 3)}` });
  const setYear = (y) => setQ({ from: `${y}-01-01`, to: `${y}-12-31` });

  const rows = useMemo(() => data?.rows || [], [data]);
  const hasChildren = useMemo(() => new Set(rows.map((r) => r.parent).filter(Boolean)), [rows]);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const isOpen = (r) => (open[r.id] != null ? open[r.id] : !r.collapsed);
  const visible = (r) => { let p = r.parent; while (p) { const pr = byId.get(p); if (!pr || !isOpen(pr)) return false; p = pr.parent; } return true; };
  const cols = data ? data.groups.flatMap((g, gi) => g.cols.map((c) => ({ ...c, gi }))) : [];

  const compareLabel = COMPARE.find(([k]) => k === q.compare)?.[1] || 'No Comparison';
  const reportLabel = REPORTS.find(([k]) => k === q.report)?.[1];

  return (
    <div className="trp">
      <style>{`
        .trp-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
        .trp-sheet { max-width: 1180px; margin: 0 auto; }
        .trp-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .trp-table th, .trp-table td { padding: 6px 8px; border-bottom: 1px solid var(--color-border, #e5e7eb); }
        .trp-table thead th { font-weight: 600; text-align: right; }
        .trp-table td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
        .trp-table td.neg { color: var(--color-danger-text, #b91c1c); }
        .trp-table tr.section td { background: var(--color-surface-2, #dde1e6); font-weight: 700; }
        .trp-table tr.subhead td, .trp-table tr.total td { font-weight: 700; }
        .trp-table tr.click td:first-child { cursor: pointer; }
        .trp-table input { width: 130px; height: 24px; text-align: right; padding: 0 6px; margin: -3px 0; font-size: 13px; }
        .trp-caret { display: inline-block; width: 14px; color: #64748b; }
        @media print {
          .trp-no-print, header, nav, .navbar, .app-header, .topbar { display: none !important; }
          .trp-sheet { max-width: none; box-shadow: none; }
          .trp-table input { border: 0; }
        }
      `}</style>

      <div className="trp-bar trp-no-print">
        {mayPrint && <button type="button" className="btn btn-sm btn-primary" disabled={!data} onClick={() => window.print()}>PDF</button>}
        {mayPrint && <button type="button" className="btn btn-sm" disabled={busy || !data} onClick={xlsx}>{busy ? 'Preparing…' : 'XLSX'}</button>}
        <h1 style={{ margin: '0 12px 0 4px', fontSize: 20 }}>Tax Return</h1>
        <BirCompanyPicker />

        <Dropdown label={`📅 ${data?.label || `${q.from} – ${q.to}`}`} open={menu === 'date'} setOpen={(v) => setMenu(v ? 'date' : '')}>
          <div style={{ display: 'grid', gap: 8 }}>
            <div className="field" style={{ margin: 0 }}>
              <label>Month</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <select value={pm} onChange={(e) => setMonth(py, Number(e.target.value))}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select>
                <input type="number" style={{ width: 80 }} value={py} onChange={(e) => /^\d{4}$/.test(e.target.value) && setMonth(Number(e.target.value), pm)} />
              </div>
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Quarter</label>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {[1, 2, 3, 4].map((n) => <button key={n} type="button" className="btn btn-sm" onClick={() => setQuarter(py, n)}>Q{n} {py}</button>)}
              </div>
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Year</label>
              <div style={{ display: 'flex', gap: 4 }}>
                {[py - 1, py].map((y) => <button key={y} type="button" className="btn btn-sm" onClick={() => setYear(y)}>{y}</button>)}
              </div>
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Custom</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input type="date" value={q.from} onChange={(e) => e.target.value && setQ({ from: e.target.value })} />
                <input type="date" value={q.to} onChange={(e) => e.target.value && setQ({ to: e.target.value })} />
              </div>
            </div>
          </div>
        </Dropdown>

        {q.report !== 'sawt_qap' && (
          <Dropdown label={`% ${q.compare ? compareLabel : 'Comparison'}`} open={menu === 'cmp'} setOpen={(v) => setMenu(v ? 'cmp' : '')}>
            {COMPARE.map(([k, label]) => <MenuItem key={k} on={q.compare === k} onClick={() => setQ({ compare: k })}>{label}</MenuItem>)}
            {(q.compare === 'previous' || q.compare === 'last_year') && (
              <div className="field" style={{ margin: '6px 0 0' }}>
                <label>Number of periods</label>
                <input type="number" min="1" max="12" value={q.compare_count} onChange={(e) => setQ({ compare_count: e.target.value })} />
              </div>
            )}
            {q.compare === 'custom' && (
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <input type="date" value={q.compare_from} onChange={(e) => setQ({ compare_from: e.target.value })} />
                <input type="date" value={q.compare_to} onChange={(e) => setQ({ compare_to: e.target.value })} />
              </div>
            )}
            <hr style={{ margin: '8px 0' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <span>Period order</span>
              <select value={q.order} onChange={(e) => setQ({ order: e.target.value })}>
                <option value="descending">Descending</option>
                <option value="ascending">Ascending</option>
              </select>
            </div>
          </Dropdown>
        )}

        <Dropdown label={`📘 Report: ${reportLabel}`} open={menu === 'rep'} setOpen={(v) => setMenu(v ? 'rep' : '')}>
          {REPORTS.map(([k, label]) => <MenuItem key={k} on={q.report === k} onClick={() => { setQ({ report: k }); setMenu(''); setOpen({}); }}>{label}</MenuItem>)}
        </Dropdown>
        <span className="muted" style={{ fontSize: 12 }}>In ₱</span>
      </div>

      {q.report === 'sawt_qap' && (
        <div className="trp-no-print" style={{ display: 'flex', justifyContent: 'center', gap: 4, marginBottom: 12 }}>
          {[['sawt', 'SAWT'], ['qap', 'QAP']].map(([k, label]) => (
            <button key={k} type="button" className={`btn btn-sm${q.tab === k ? ' btn-primary' : ''}`} onClick={() => { setQ({ tab: k }); setOpen({}); }}>{label}</button>
          ))}
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      {loading ? <LoadingSpinner /> : data && (
        <div className="card trp-sheet">
          <div style={{ display: 'none' }} className="trp-print-title" />
          <h3 style={{ marginTop: 0 }}>
            {data.title.replace(/^Report: /, '')}{data.report === 'sawt_qap' ? ` — ${data.tab === 'sawt' ? 'SAWT (tax withheld from us by customers)' : 'QAP (tax we withheld from suppliers)'}` : ''}
          </h3>
          <div className="table-wrap">
            <table className="trp-table">
              <thead>
                <tr>
                  <th />
                  {data.groups.map((g) => <th key={g.label} colSpan={g.cols.length} style={{ textAlign: 'center', border: '1px solid var(--color-border, #e5e7eb)' }}>{g.label}</th>)}
                </tr>
                <tr>
                  <th />
                  {cols.map((c, i) => <th key={i} style={c.num || c.pct ? undefined : { textAlign: 'left' }}>{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.filter(visible).map((r) => {
                  const kids = hasChildren.has(r.id);
                  return (
                    <tr key={r.id} className={`${r.style}${kids ? ' click' : ''}`}>
                      <td style={{ paddingLeft: 8 + (r.level || 0) * 16 }}
                        onClick={kids ? () => setOpen((o) => ({ ...o, [r.id]: !isOpen(r) })) : undefined}>
                        {kids && <span className="trp-caret">{isOpen(r) ? '▾' : '▸'}</span>}
                        {r.label}
                      </td>
                      {r.cells.map((v, i) => {
                        const c = cols[i];
                        // 2550Q: a line typed on the page, in the period asked for.
                        const inputKey = r.input && c.gi === data.current_group ? r.input[i % 2] : null;
                        if (inputKey) {
                          return (
                            <td key={i} className="num">
                              <input type="number" step="0.01" value={manual[inputKey] ?? (v ? String(v) : '')} placeholder="0.00"
                                onChange={(e) => setManual((m) => ({ ...m, [inputKey]: e.target.value }))} />
                            </td>
                          );
                        }
                        return <td key={i} className={`${c.num || c.pct ? 'num' : ''}${c.num && Number(v) < 0 ? ' neg' : ''}`}>{fmtCell(v, c)}</td>;
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {data.report === '2550q' && (
            <div className="muted trp-no-print" style={{ fontSize: 12, marginTop: 8 }}>
              Sales, output tax and purchases are the period&rsquo;s documents, as on VAT Computation. The boxed lines (carry-overs,
              importations, credits, penalties) are typed here and recompute the return; they are not saved. VATable sales to
              Government are customers whose type is set to Government.
            </div>
          )}
          {data.report === 'sawt_qap' && (
            <div className="muted trp-no-print" style={{ fontSize: 12, marginTop: 8 }}>
              {data.tab === 'qap'
                ? 'The documents of the Expanded Withholding Tax report. Click a document to see its ATC lines.'
                : 'The creditable withholding on customers’ invoices (Creditable Withholding Tax page); ATC suggested from the rate.'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
