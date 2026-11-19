import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import api from '../../api/client';
import { getActiveCompany } from '../../utils/activeCompany';
import '../../styles/financialReports.css';

// The Accounting reports, in Odoo's flow (server: lib/financialReports.js). One page draws all of
// them: the filter bar (date, comparison, journals, branch, options, search), the report itself
// with lines that unfold in place, a drill from any amount to the General Ledger and from any
// ledger line to its document, and PDF (print) / XLSX export. Filters live in the URL, so Back
// returns to the report as it was and a drill-down is a link that can be shared.

export const REPORTS = {
  'balance-sheet': { key: 'balance_sheet', title: 'Balance Sheet' },
  'profit-and-loss': { key: 'profit_loss', title: 'Profit and Loss' },
  'cash-flow': { key: 'cash_flow', title: 'Cash Flow Statement' },
  'executive-summary': { key: 'executive_summary', title: 'Executive Summary' },
  'general-ledger': { key: 'general_ledger', title: 'General Ledger' },
  'trial-balance': { key: 'trial_balance', title: 'Trial Balance' },
  'journal-audit': { key: 'journal_audit', title: 'Journal Audit' },
  'check-register': { key: 'check_register', title: 'Check Register' },
  'partner-ledger': { key: 'partner_ledger', title: 'Partner Ledger' },
  'aged-receivable': { key: 'aged_receivable', title: 'Aged Receivable' },
  'aged-payable': { key: 'aged_payable', title: 'Aged Payable' },
  'invoice-analysis': { key: 'invoice_analysis', title: 'Invoice Analysis' },
  'audit-trail': { key: 'audit_trail', title: 'Audit Trail' },
};
const SLUG_OF = Object.fromEntries(Object.entries(REPORTS).map(([slug, r]) => [r.key, slug]));

/* ---------------------------------------------------------------- dates */
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const endOfMonth = (y, m) => new Date(y, m + 1, 0);
function presets(single) {
  const t = new Date(); const y = t.getFullYear(); const m = t.getMonth(); const q = Math.floor(m / 3);
  if (single) {
    return [
      ['today', 'Today', null, iso(t)],
      ['end_last_month', 'End of Last Month', null, iso(endOfMonth(y, m - 1))],
      ['end_last_quarter', 'End of Last Quarter', null, iso(endOfMonth(y, q * 3 - 1))],
      ['end_last_year', 'End of Last Year', null, `${y - 1}-12-31`],
    ];
  }
  return [
    ['this_month', 'This Month', iso(new Date(y, m, 1)), iso(endOfMonth(y, m))],
    ['this_quarter', 'This Quarter', iso(new Date(y, q * 3, 1)), iso(endOfMonth(y, q * 3 + 2))],
    ['this_year', 'This Financial Year', `${y}-01-01`, `${y}-12-31`],
    ['last_month', 'Last Month', iso(new Date(y, m - 1, 1)), iso(endOfMonth(y, m - 1))],
    ['last_quarter', 'Last Quarter', iso(new Date(y, q * 3 - 3, 1)), iso(endOfMonth(y, q * 3 - 1))],
    ['last_year', 'Last Financial Year', `${y - 1}-01-01`, `${y - 1}-12-31`],
  ];
}
// Each report opens on the period Odoo's does.
const DEFAULT_PRESET = {
  balance_sheet: 'today', aged_receivable: 'today', aged_payable: 'today', profit_loss: 'this_year', executive_summary: 'this_year',
  partner_ledger: 'this_year', journal_audit: 'this_year', cash_flow: 'last_month', check_register: 'last_month',
  general_ledger: 'this_month', trial_balance: 'this_month', invoice_analysis: 'this_year', audit_trail: 'this_month',
};
const SINGLE = new Set(['balance_sheet', 'aged_receivable', 'aged_payable']);

/* ---------------------------------------------------------------- formatting */
const money = (v) => (v === null || v === undefined || v === '' ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
function cell(v, type, fmt) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v !== 'number') return v;
  const t = fmt || type;
  if (t === 'percent') return `${v.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
  if (t === 'number') return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (t === 'ratio') return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return money(v);
}

/* ---------------------------------------------------------------- dropdown */
function Drop({ label, icon, children, active }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className={`fr-drop ${open ? 'open' : ''}`} ref={ref}>
      <button type="button" className={`fr-chip ${active ? 'is-active' : ''}`} onClick={() => setOpen((o) => !o)}>
        {icon && <span className="fr-chip-icon" aria-hidden="true">{icon}</span>}{label} <span className="caret">▾</span>
      </button>
      {open && <div className="fr-drop-menu" onClick={(e) => { if (e.target.closest('[data-close]')) setOpen(false); }}>{children}</div>}
    </div>
  );
}
const Item = ({ on, onClick, children, close = true }) => (
  <button type="button" className={`fr-item ${on ? 'on' : ''}`} onClick={onClick} {...(close ? { 'data-close': '' } : {})}>
    <span className="fr-check">{on ? '✓' : ''}</span>{children}
  </button>
);

export default function FinancialReport() {
  const { slug } = useParams();
  const def = REPORTS[slug];
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const key = def?.key;
  const single = SINGLE.has(key);

  // The filters, all in the URL; a missing date takes the report's default period.
  const params = useMemo(() => {
    const p = Object.fromEntries(sp.entries());
    if (!p.date_to) {
      const pr = presets(single).find((x) => x[0] === DEFAULT_PRESET[key]) || presets(single)[0];
      if (!single) p.date_from = pr[2];
      p.date_to = pr[3];
      p.preset = pr[0];
    }
    return p;
  }, [sp, key, single]);
  const setParams = useCallback((patch) => {
    const next = { ...params, ...patch };
    Object.keys(next).forEach((k) => { if (next[k] === '' || next[k] === null || next[k] === undefined || next[k] === false) delete next[k]; });
    setSp(next, { replace: false });
  }, [params, setSp]);

  const [report, setReport] = useState(null);
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [branches, setBranches] = useState([]);
  const [searchText, setSearchText] = useState(params.search || '');

  useEffect(() => {
    api.get('/lookups/company-branches').then(({ data }) => {
      const active = getActiveCompany();
      setBranches((data.branches || []).filter((b) => !active || String(b.company_id) === String(active.id)));
    }).catch(() => {});
  }, []);
  useEffect(() => { setSearchText(params.search || ''); }, [params.search]);

  const query = useMemo(() => {
    const q = { ...params };
    delete q.preset;
    return q;
  }, [params]);

  useEffect(() => {
    if (!key) return;
    let gone = false;
    setLoading(true); setError('');
    api.get(`/reports/fr/${key}`, { params: query })
      .then(({ data }) => { if (!gone) { setReport(data); setLines(data.lines); } })
      .catch((e) => { if (!gone) setError(e.response?.data?.error || 'Could not load the report'); })
      .finally(() => { if (!gone) setLoading(false); });
    return () => { gone = true; };
  }, [key, query]);

  // Unfold / fold a line; a line folded on the server ("lazy") fetches its children the first time.
  const toggle = async (line) => {
    if (line.lazy && !lines.some((l) => l.parent === line.id)) {
      try {
        const { data } = await api.get(`/reports/fr/${key}`, { params: { ...query, expand: line.id } });
        setLines((ls) => {
          const i = ls.findIndex((l) => l.id === line.id);
          const copy = ls.slice();
          copy.splice(i + 1, 0, ...data.lines);
          copy[i] = { ...copy[i], folded: false };
          return copy;
        });
      } catch (e) { setError(e.response?.data?.error || 'Could not unfold the line'); }
      return;
    }
    setLines((ls) => ls.map((l) => (l.id === line.id ? { ...l, folded: !l.folded } : l)));
  };

  // A line shows when no ancestor is folded.
  const visible = useMemo(() => {
    const byId = new Map(lines.map((l) => [l.id, l]));
    const shown = (l) => { let p = l.parent && byId.get(l.parent); while (p) { if (p.folded) return false; p = p.parent && byId.get(p.parent); } return true; };
    return lines.filter(shown);
  }, [lines]);

  const drill = (action) => {
    if (!action) return;
    const slugTo = SLUG_OF[action.report];
    if (!slugTo) return;
    const p = new URLSearchParams();
    Object.entries(action.params || {}).forEach(([k, v]) => { if (v) p.set(k, v); });
    if (query.location_id) p.set('location_id', query.location_id);
    navigate(`/accounting-reports/${slugTo}?${p.toString()}`);
  };

  const exportXlsx = async () => {
    try {
      const res = await api.get(`/reports/fr/${key}/xlsx`, { params: query, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url; a.download = `${def.title.replace(/\s+/g, '_')}_${params.date_to}.xlsx`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch { setError('Could not export the report'); }
  };

  if (!def) return <div className="card">Unknown report.</div>;
  const f = report?.features || {};
  const pr = presets(single);
  const presetLabel = params.preset ? pr.find((x) => x[0] === params.preset)?.[1] : null;
  const dateLabel = presetLabel || (single ? `As of ${params.date_to}` : `${params.date_from} – ${params.date_to}`);
  const journalsOn = (params.journals || '').split(',').filter(Boolean);
  const branchName = branches.find((b) => String(b.id) === String(params.location_id))?.location_name;
  const cols = report?.columns || [];
  const company = getActiveCompany();

  return (
    <div className="fr-page">
      <div className="page-header fr-header">
        <div>
          <h1>{def.title}</h1>
          <div className="fr-sub">
            {company ? company.name : 'Wu Venture (all companies)'}{branchName ? ` · ${branchName}` : ''} · {dateLabel}
          </div>
        </div>
        <div className="fr-actions">
          <button type="button" className="btn" onClick={() => window.print()}>PDF</button>
          <button type="button" className="btn" onClick={exportXlsx}>XLSX</button>
        </div>
      </div>

      <div className="fr-filters">
        <Drop label={dateLabel} icon="📅" active>
          {pr.map(([k, label, from, to]) => (
            <Item key={k} on={params.preset === k} onClick={() => setParams({ preset: k, date_from: single ? '' : from, date_to: to })}>{label}</Item>
          ))}
          <div className="fr-custom">
            {!single && <label>From <input type="date" value={params.date_from || ''} onChange={(e) => setParams({ preset: '', date_from: e.target.value })} /></label>}
            <label>{single ? 'Date' : 'To'} <input type="date" value={params.date_to || ''} onChange={(e) => setParams({ preset: '', date_to: e.target.value })} /></label>
          </div>
        </Drop>

        {f.comparison && (
          <Drop label={params.comparison ? (params.comparison === 'same_last_year' ? 'Comparison: Same Period Last Year' : `Comparison: ${params.comparison_count || 1} Previous Period${Number(params.comparison_count) > 1 ? 's' : ''}`) : 'Comparison'} icon="⇄" active={!!params.comparison}>
            <Item on={!params.comparison} onClick={() => setParams({ comparison: '', comparison_count: '' })}>No Comparison</Item>
            <Item on={params.comparison === 'previous_period'} onClick={() => setParams({ comparison: 'previous_period', comparison_count: params.comparison_count || 1 })}>Previous Period</Item>
            <Item on={params.comparison === 'same_last_year'} onClick={() => setParams({ comparison: 'same_last_year', comparison_count: params.comparison_count || 1 })}>Same Period Last Year</Item>
            {params.comparison && (
              <div className="fr-custom">
                <label>Number of periods <input type="number" min="1" max="12" value={params.comparison_count || 1} onChange={(e) => setParams({ comparison_count: e.target.value })} /></label>
              </div>
            )}
          </Drop>
        )}

        {f.journals && report?.journals && (
          <Drop label={journalsOn.length ? `Journals: ${journalsOn.length}` : 'All Journals'} icon="📒" active={journalsOn.length > 0}>
            <Item on={!journalsOn.length} onClick={() => setParams({ journals: '' })}>All Journals</Item>
            {report.journals.map((j) => {
              const on = journalsOn.includes(j.key);
              return (
                <Item key={j.key} on={on} close={false}
                  onClick={() => setParams({ journals: (on ? journalsOn.filter((x) => x !== j.key) : [...journalsOn, j.key]).join(',') })}>{j.label}</Item>
              );
            })}
          </Drop>
        )}

        {f.branch && branches.length > 0 && (
          <Drop label={branchName || 'All Branches'} icon="🏬" active={!!params.location_id}>
            <Item on={!params.location_id} onClick={() => setParams({ location_id: '' })}>All Branches{company ? ` of ${company.name}` : ''}</Item>
            {branches.map((b) => <Item key={b.id} on={String(b.id) === String(params.location_id)} onClick={() => setParams({ location_id: b.id })}>{b.location_name}</Item>)}
          </Drop>
        )}

        {f.partnerType && (
          <Drop label={params.partner_type === 'receivable' ? 'Receivable' : params.partner_type === 'payable' ? 'Payable' : 'Receivable & Payable'} icon="👥" active>
            <Item on={!params.partner_type} onClick={() => setParams({ partner_type: '' })}>Receivable & Payable</Item>
            <Item on={params.partner_type === 'receivable'} onClick={() => setParams({ partner_type: 'receivable' })}>Receivable</Item>
            <Item on={params.partner_type === 'payable'} onClick={() => setParams({ partner_type: 'payable' })}>Payable</Item>
          </Drop>
        )}

        {f.groupBy && report?.groupOptions && (
          <>
            <Drop label={params.move_type === 'vendor' ? 'Vendor Bills' : 'Customer Invoices'} icon="🧾" active>
              <Item on={params.move_type !== 'vendor'} onClick={() => setParams({ move_type: '', group_by: '', group_by2: '' })}>Customer Invoices</Item>
              <Item on={params.move_type === 'vendor'} onClick={() => setParams({ move_type: 'vendor', group_by: '', group_by2: '' })}>Vendor Bills</Item>
            </Drop>
            <Drop label={`Group by: ${report.groupOptions.find((g) => g.key === report.group_by)?.label || ''}${report.group_by2 ? ` > ${report.groupOptions.find((g) => g.key === report.group_by2)?.label}` : ''}`} icon="▤" active>
              <div className="fr-menu-title">Group by</div>
              {report.groupOptions.map((g) => <Item key={g.key} on={report.group_by === g.key} onClick={() => setParams({ group_by: g.key, group_by2: report.group_by2 === g.key ? '' : report.group_by2 })}>{g.label}</Item>)}
              <div className="fr-menu-title">Then by</div>
              <Item on={!report.group_by2} onClick={() => setParams({ group_by2: '' })}>Nothing</Item>
              {report.groupOptions.filter((g) => g.key !== report.group_by).map((g) => <Item key={g.key} on={report.group_by2 === g.key} onClick={() => setParams({ group_by2: g.key })}>{g.label}</Item>)}
            </Drop>
          </>
        )}

        <Drop label="Options" icon="⚙" active={!!(params.unfold_all || params.hide_zero || params.hierarchy)}>
          <Item on={!!params.unfold_all} close={false} onClick={() => setParams({ unfold_all: params.unfold_all ? '' : '1' })}>Unfold All</Item>
          <Item on={!!params.hide_zero} close={false} onClick={() => setParams({ hide_zero: params.hide_zero ? '' : '1' })}>Hide lines at 0</Item>
          {f.hierarchy && <Item on={!!params.hierarchy} close={false} onClick={() => setParams({ hierarchy: params.hierarchy ? '' : '1' })}>Hierarchy and Subtotals</Item>}
        </Drop>

        {params.account && (
          <button type="button" className="fr-chip is-active" onClick={() => setParams({ account: '' })} title="Show every account">
            Account {params.account} ✕
          </button>
        )}

        {f.search && (
          <form className="fr-search" onSubmit={(e) => { e.preventDefault(); setParams({ search: searchText.trim() }); }}>
            <input type="search" placeholder="Search…" value={searchText} onChange={(e) => setSearchText(e.target.value)}
              onBlur={() => { if ((params.search || '') !== searchText.trim()) setParams({ search: searchText.trim() }); }} />
          </form>
        )}
      </div>

      {error && <div className="card fr-error">{error}</div>}
      {report?.warning && <div className="card fr-warning">{report.warning}</div>}

      <div className={`card fr-card ${loading ? 'is-loading' : ''}`}>
        <div className="fr-print-head">
          <h2>{def.title}</h2>
          <div>{company ? company.name : 'Wu Venture (all companies)'}{branchName ? ` · ${branchName}` : ''} · {dateLabel}</div>
        </div>
        {!report && loading && <div className="fr-empty">Loading…</div>}
        {report && (
          <div className="table-wrap">
            <table className="fr-table">
              <thead>
                {report.grouped && (
                  <tr>
                    <th />
                    {cols.reduce((acc, c, i) => {
                      if (i > 0 && cols[i - 1].label === c.label) acc[acc.length - 1].span += 1;
                      else acc.push({ label: c.label, span: 1 });
                      return acc;
                    }, []).map((g, i) => <th key={i} colSpan={g.span} className="num fr-group-head">{g.label}</th>)}
                  </tr>
                )}
                <tr>
                  <th />
                  {cols.map((c, i) => <th key={i} className={c.type === 'text' || c.type === 'date' ? '' : 'num'}>{report.grouped ? c.group : c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {visible.length <= 1 && !loading && (
                  <tr><td colSpan={cols.length + 1} className="fr-empty">Nothing to show for these filters.</td></tr>
                )}
                {visible.map((l) => (
                  <tr key={l.id} className={`fr-row s-${l.style || 'plain'} lv-${Math.min(l.level, 4)}`}>
                    <td className="fr-name" style={{ paddingLeft: 10 + l.level * 18 }}>
                      {l.unfoldable ? (
                        <button type="button" className="fr-fold" onClick={() => toggle(l)} aria-label={l.folded ? 'Unfold' : 'Fold'}>
                          {l.folded ? '▸' : '▾'}
                        </button>
                      ) : <span className="fr-fold-space" />}
                      {l.link ? (
                        <a href={l.link} onClick={(e) => { e.preventDefault(); navigate(l.link); }}>{l.name}</a>
                      ) : l.action ? (
                        <button type="button" className="fr-link" onClick={() => drill(l.action)} title="Open in the General Ledger">{l.name}</button>
                      ) : (
                        <span onClick={l.unfoldable ? () => toggle(l) : undefined} className={l.unfoldable ? 'fr-clickable' : ''}>{l.name}</span>
                      )}
                    </td>
                    {l.values.map((v, i) => {
                      const c = cols[i] || {};
                      const isNum = typeof v === 'number';
                      const growth = c.type === 'percent' && !l.fmt && isNum;
                      return (
                        <td key={i} className={`${isNum ? 'num' : ''} ${isNum && v < 0 ? 'neg' : ''} ${growth ? (v >= 0 ? 'up' : 'down') : ''}`}>
                          {l.action && isNum && i === 0 ? (
                            <button type="button" className="fr-link num" onClick={() => drill(l.action)}>{cell(v, c.type, l.fmt)}</button>
                          ) : cell(v, c.type, l.fmt)}
                        </td>
                      );
                    })}
                    {l.values.length < cols.length && Array.from({ length: cols.length - l.values.length }).map((_, i) => <td key={`x${i}`} />)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// The Accounting > Reporting menu, Odoo's four groups (used by Layout's nav).
export const REPORT_MENU = [
  { title: 'Statement Reports', items: ['balance-sheet', 'profit-and-loss', 'cash-flow', 'executive-summary'] },
  { title: 'Audit Reports', items: ['general-ledger', 'trial-balance', 'journal-audit', 'check-register'] },
  { title: 'Partner Reports', items: ['partner-ledger', 'aged-receivable', 'aged-payable'] },
  { title: 'Management', items: ['invoice-analysis', 'audit-trail'] },
];
