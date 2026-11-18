import { useEffect, useMemo, useState } from 'react';
import BirCompanyPicker from '../../components/BirCompanyPicker';
import { useSearchParams } from 'react-router-dom';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import SearchInput from '../../components/SearchInput';
import Pagination from '../../components/Pagination';
import { SupplierLink } from '../../components/PartyLink';
import { useAuth } from '../../context/useAuth';
import { Stat, money } from './BirTaxCommon';

// BIR Reports > BIR 2307 to Suppliers (asked 2026-11-05): every supplier we withheld Expanded
// Withholding Tax from in a quarter, each with its BIR Form 2307 (Certificate of Creditable Tax
// Withheld at Source) to open, check and print. View lists and opens, Print prints (each print is
// logged as issued), Edit keeps the Payor details printed in Part II.

const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
function lastQuarter() {
  const t = manilaToday(); let y = Number(t.slice(0, 4)); let q = Math.floor((Number(t.slice(5, 7)) - 1) / 3);
  if (q === 0) { q = 4; y -= 1; }
  return `${y}-Q${q}`;
}
function stepQuarter(q, n) {
  const [y, k] = q.split('-Q').map(Number);
  const i = y * 4 + (k - 1) + n;
  return `${Math.floor(i / 4)}-Q${(i % 4) + 1}`;
}

const PAYOR_FIELDS = [
  ['name', "Payor's registered name", ''],
  ['tin', 'TIN (with branch code)', '000-000-000-00000'],
  ['address', 'Registered address', ''],
  ['zip', 'ZIP code', ''],
  ['signatory', 'Authorized representative (prints on the signature line)', ''],
  ['signatory_title', 'Title / designation', ''],
  ['signatory_tin', "Representative's TIN", ''],
];

export default function BirSupplier2307() {
  const { can } = useAuth();
  const mayEdit = can('/reports/bir-2307', 'can_edit');
  const [params, setParams] = useSearchParams();
  const quarter = /^\d{4}-Q[1-4]$/.test(params.get('quarter') || '') ? params.get('quarter') : lastQuarter();
  const setQuarter = (q) => { const p = new URLSearchParams(params); p.set('quarter', q); setParams(p, { replace: true }); };
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [show, setShow] = useState('');
  const [payor, setPayor] = useState(null); // the edit form, when open
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true); setError('');
    api.get('/reports/bir/2307', { params: { quarter } })
      .then(({ data: d }) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e.response?.data?.error || 'Could not load the suppliers.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [quarter]);

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (data?.payees || []).filter((p) => (!s || `${p.name} ${p.tin || ''}`.toLowerCase().includes(s))
      && (!show || (show === 'issued' ? p.issued_count > 0 : p.issued_count === 0)));
  }, [data, search, show]);

  const PAGE_SIZE = 10;
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [quarter, search, show]);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const curPage = Math.min(page, totalPages);
  const pageRows = rows.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE);

  const payorMissing = data && (!data.payor.name || !data.payor.tin || !data.payor.address);

  async function savePayor(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const { data: saved } = await api.put('/reports/bir/2307/payor', payor);
      setData((d) => ({ ...d, payor: saved }));
      setPayor(null);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save the Payor details.');
    }
    setSaving(false);
  }

  const open = (p) => window.open(`/reports/bir-2307/form?quarter=${quarter}&payee=${encodeURIComponent(p.key)}`, '_blank');

  return (
    <div>
      <div className="page-header">
        <h1>BIR 2307 to Suppliers</h1>
        <BirCompanyPicker />
        <button type="button" className="btn btn-primary" onClick={() => window.open(`/reports/bir-2307/form?manual=1&quarter=${quarter}`, '_blank')}>
          Create 2307
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16, display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" onClick={() => setQuarter(stepQuarter(quarter, -1))} aria-label="Previous quarter">‹</button>
          <div className="field" style={{ margin: 0 }}>
            <label>Quarter</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input type="number" style={{ width: 90 }} value={quarter.slice(0, 4)}
                onChange={(e) => /^\d{4}$/.test(e.target.value) && setQuarter(`${e.target.value}-${quarter.slice(5)}`)} />
              <select value={quarter.slice(5)} onChange={(e) => setQuarter(`${quarter.slice(0, 4)}-${e.target.value}`)}>
                <option value="Q1">Q1 (Jan – Mar)</option>
                <option value="Q2">Q2 (Apr – Jun)</option>
                <option value="Q3">Q3 (Jul – Sep)</option>
                <option value="Q4">Q4 (Oct – Dec)</option>
              </select>
            </div>
          </div>
          <button type="button" className="btn btn-secondary" onClick={() => setQuarter(stepQuarter(quarter, 1))} aria-label="Next quarter">›</button>
        </div>
        <div className="field" style={{ margin: 0, minWidth: 240, flex: 1 }}>
          <label>Supplier</label>
          <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or TIN" />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Show</label>
          <select value={show} onChange={(e) => setShow(e.target.value)}>
            <option value="">All</option>
            <option value="pending">Not yet issued</option>
            <option value="issued">Issued</option>
          </select>
        </div>
      </div>

      {loading ? <LoadingSpinner /> : data && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <h3 style={{ margin: 0 }}>Payor (Part II)</h3>
              {mayEdit && !payor && <button className="btn btn-sm" onClick={() => setPayor({ ...data.payor })}>Edit</button>}
            </div>
            {payor ? (
              <form onSubmit={savePayor} style={{ marginTop: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
                  {PAYOR_FIELDS.map(([k, label, ph]) => (
                    <div className="field" key={k} style={{ margin: 0, gridColumn: k === 'address' ? '1 / -1' : undefined }}>
                      <label>{label}</label>
                      <input value={payor[k] || ''} placeholder={ph} onChange={(e) => setPayor({ ...payor, [k]: e.target.value })} />
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
                  <button type="button" className="btn btn-secondary" onClick={() => setPayor(null)}>Cancel</button>
                </div>
              </form>
            ) : payorMissing ? (
              <div className="muted" style={{ marginTop: 8 }}>
                The Payor&rsquo;s name, TIN and address are not set yet, so they print blank on every 2307.
                {mayEdit ? ' Click Edit to fill them in.' : ' Ask someone with Edit on this page to fill them in.'}
              </div>
            ) : (
              <div style={{ marginTop: 8, lineHeight: 1.6 }}>
                <strong>{data.payor.name}</strong> · TIN {data.payor.tin}<br />
                {data.payor.address}{data.payor.zip ? ` ${data.payor.zip}` : ''}
                {data.payor.signatory && <div className="muted">Signs as {data.payor.signatory}{data.payor.signatory_title ? `, ${data.payor.signatory_title}` : ''}</div>}
              </div>
            )}
          </div>

          <div className="stat-grid">
            <Stat label="Suppliers withheld from" value={data.totals.payees} />
            <Stat label="2307 issued" value={`${data.totals.issued} / ${data.totals.payees}`} tone={data.totals.issued < data.totals.payees ? 'warning' : undefined} />
            <Stat label="Income payments" value={money(data.totals.income)} />
            <Stat label="Tax withheld" value={money(data.totals.tax)} />
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>{data.label}</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Supplier</th><th>TIN</th><th style={{ textAlign: 'right' }}>Docs</th>
                    <th style={{ textAlign: 'right' }}>Income Payments</th><th style={{ textAlign: 'right' }}>Tax Withheld</th>
                    <th>Issued</th><th />
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((p) => (
                    <tr key={p.key}>
                      <td>
                        <SupplierLink id={p.supplier_id} name={p.name || '—'} />
                        {p.suggested_atc > 0 && <div className="muted" style={{ fontSize: 12 }}>ATC suggested from the rate — check it on the form</div>}
                        {p.no_atc > 0 && <div style={{ fontSize: 12, color: 'var(--color-warning-text)' }}>{p.no_atc} document{p.no_atc === 1 ? '' : 's'} with no ATC</div>}
                      </td>
                      <td>{p.tin || <span style={{ color: 'var(--color-warning-text)' }}>none</span>}</td>
                      <td style={{ textAlign: 'right' }}>{p.docs}</td>
                      <td style={{ textAlign: 'right' }}>{money(p.income)}</td>
                      <td style={{ textAlign: 'right' }}><strong>{money(p.tax)}</strong></td>
                      <td>
                        {p.issued_count ? (
                          <span title={`Printed ${p.issued_count} time${p.issued_count === 1 ? '' : 's'}`}>
                            <span className="badge badge-success">Issued</span>
                            <div className="muted" style={{ fontSize: 12 }}>{String(p.last_issued_at).slice(0, 10)}{p.last_issued_by ? ` · ${p.last_issued_by}` : ''}</div>
                          </span>
                        ) : <span className="badge badge-warning">Not yet</span>}
                      </td>
                      <td><button className="btn btn-sm" onClick={() => open(p)}>Open 2307</button></td>
                    </tr>
                  ))}
                  {!rows.length && <tr><td colSpan={7} className="muted">{data.payees.length ? 'No supplier matches.' : `Nothing was withheld from suppliers in ${data.label}.`}</td></tr>}
                </tbody>
              </table>
            </div>
            {rows.length > PAGE_SIZE && (
              <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                Showing {(curPage - 1) * PAGE_SIZE + 1}–{Math.min(curPage * PAGE_SIZE, rows.length)} of {rows.length} suppliers
              </div>
            )}
            <Pagination page={curPage} totalPages={totalPages} onChange={setPage} />
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              From the vendor bills, bill credits and cheques of the quarter with withholding tax, as on the Expanded Withholding Tax report.
              Give each supplier its 2307 within 20 days after the quarter ends, or when the supplier asks for it.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
