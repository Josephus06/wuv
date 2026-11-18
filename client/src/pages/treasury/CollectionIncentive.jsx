import { useCallback, useEffect, useState } from 'react';
import api from '../../api/client';
import { useAuth } from '../../context/useAuth';
import LoadingSpinner from '../../components/LoadingSpinner';
import FilterPicker from '../../components/FilterPicker';

// Treasury > Collection Incentive (routes/collectionIncentive.js): the collector's incentive from
// what was collected and how late, by Treasury's workbook formula. Monthly or annual.

const ROUTE = '/treasury/collection-incentive';
const BUCKET_FIELDS = [
  { col: 'target_current', label: 'Current' },
  { col: 'target_1_30', label: '1-30' },
  { col: 'target_31_60', label: '31-60' },
  { col: 'target_61_90', label: '61-90' },
  { col: 'target_over_90', label: 'Over 90' },
];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
};
const pct = (v, d = 1) => `${(Number(v || 0) * 100).toFixed(d)}%`;
const displayDay = (v) => (v ? new Date(`${v}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const R = { textAlign: 'right' };

function defaults() {
  const now = new Date();
  const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return {
    mode: 'monthly',
    month: `${lm.getFullYear()}-${String(lm.getMonth() + 1).padStart(2, '0')}`,
    year: now.getFullYear(),
    through: Math.max(1, now.getMonth()), // last full month
    locationId: null, // set to Head Office once the locations load
  };
}

const params = (f) => ({
  mode: f.mode,
  ...(f.mode === 'annual' ? { year: f.year, through: f.through } : { month: f.month }),
  ...(f.locationId ? { location_id: f.locationId } : {}),
});

// Percentages are edited as whole-number percents (29.5) and stored as fractions (0.295).
const toForm = (s) => ({
  ...Object.fromEntries(BUCKET_FIELDS.map((b) => [b.col, +(s[b.col] * 100).toFixed(4)])),
  incentive_rate: +(s.incentive_rate * 100).toFixed(4),
  qualifier_pct: +(s.qualifier_pct * 100).toFixed(4),
});
const fromForm = (f) => ({
  ...Object.fromEntries(BUCKET_FIELDS.map((b) => [b.col, Number(f[b.col]) / 100])),
  incentive_rate: Number(f.incentive_rate) / 100,
  qualifier_pct: Number(f.qualifier_pct) / 100,
});

function SetupCard({ year, canEdit, onSaved }) {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setEditing(false); setError('');
    api.get(`${ROUTE}/settings`, { params: { year } })
      .then(({ data }) => { if (live) { setSettings(data); setForm(toForm(data)); } })
      .catch(() => { if (live) setError('Could not load the set-up.'); });
    return () => { live = false; };
  }, [year]);

  if (!settings || !form) return error ? <div className="error-banner">{error}</div> : null;
  const targetSum = BUCKET_FIELDS.reduce((s, b) => s + Number(form[b.col] || 0), 0);

  async function save() {
    setSaving(true); setError('');
    try {
      const { data } = await api.put(`${ROUTE}/settings/${year}`, fromForm(form));
      setSettings(data); setForm(toForm(data)); setEditing(false); onSaved();
    } catch (e) {
      setError(e.response?.data?.error || 'Could not save the set-up.');
    }
    setSaving(false);
  }

  const field = (col, label, suffix) => (
    <div className="field" key={col}>
      <label>{label}</label>
      {editing ? (
        <input type="number" step="any" min="0" value={form[col]} onChange={(e) => setForm({ ...form, [col]: e.target.value })} />
      ) : (
        <div style={{ padding: '8px 0', fontWeight: 600 }}>
          {`${form[col]}${suffix || ''}`}
        </div>
      )}
    </div>
  );

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Set-up for {year}</h3>
        {canEdit && !editing && <button className="btn btn-sm" onClick={() => setEditing(true)}>Edit set-up</button>}
        {editing && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-sm" disabled={saving} onClick={() => { setForm(toForm(settings)); setEditing(false); setError(''); }}>Cancel</button>
            <button className="btn btn-sm btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
          </div>
        )}
      </div>
      <div className="muted" style={{ margin: '6px 0 12px' }}>
        {settings.saved
          ? <>Saved{settings.updated_by ? ` by ${settings.updated_by}` : ''}{settings.updated_at ? `, ${String(settings.updated_at).slice(0, 10)}` : ''}.</>
          : settings.inherited_from
            ? <>Not set up for {year} yet — using {settings.inherited_from}&apos;s. Saving makes {year}&apos;s own.</>
            : <>Not set up yet — using the workbook&apos;s figures. Saving makes {year}&apos;s own.</>}
      </div>
      {error && <div className="error-banner">{error}</div>}
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Target % per aging bucket</div>
      <div className="filter-grid">
        {BUCKET_FIELDS.map((b) => field(b.col, b.label, '%'))}
      </div>
      {editing && (
        <div className="muted" style={{ marginBottom: 10, color: Math.abs(targetSum - 100) > 0.05 ? 'var(--danger, #b91c1c)' : undefined }}>
          Adds up to {targetSum.toFixed(2)}% — must be 100%.
        </div>
      )}
      <div className="filter-grid">
        {/* Monthly target is no longer set up (2026-11-12): it is the AR Aging at the end of the month before. */}
        <div className="field"><label>Monthly target</label><div className="muted" style={{ padding: '8px 0' }}>AR Aging total as of the end of the previous month</div></div>
        {field('qualifier_pct', 'Qualifies at (% of monthly target)', '%')}
        {field('incentive_rate', 'Incentive rate (% of avg monthly collection)', '%')}
      </div>
    </div>
  );
}

export default function CollectionIncentive() {
  const { can } = useAuth();
  const canEdit = can(ROUTE, 'can_edit');
  const [form, setForm] = useState(defaults);
  const [applied, setApplied] = useState(defaults);
  const [locations, setLocations] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Head Office by default, as Collection Report with Aging.
  useEffect(() => {
    const pick = (id) => {
      setForm((f) => (f.locationId === null ? { ...f, locationId: id } : f));
      setApplied((f) => (f.locationId === null ? { ...f, locationId: id } : f));
    };
    api.get('/lookups/locations')
      .then(({ data: d }) => {
        const locs = Array.isArray(d) ? d : (d?.rows || []);
        setLocations(locs);
        const ho = locs.find((l) => String(l.location_name || '').trim().toLowerCase() === 'head office');
        pick(ho ? String(ho.id) : '');
      })
      .catch(() => pick(''));
  }, []);

  const load = useCallback(async (f) => {
    setLoading(true); setError('');
    try {
      const { data: d } = await api.get(ROUTE, { params: params(f) });
      setData(d);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not load the report.');
    }
    setLoading(false);
  }, []);

  useEffect(() => { if (applied.locationId !== null) load(applied); }, [load, applied]);

  async function download() {
    const res = await api.get(`${ROUTE}/export`, { params: params(applied), responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = applied.mode === 'annual'
      ? `collection-incentive-${applied.year}-thru-${String(applied.through).padStart(2, '0')}.xlsx`
      : `collection-incentive-${applied.month}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const r = data?.result;
  const s = data?.settings;
  const setupYear = applied.mode === 'annual' ? applied.year : Number(applied.month.slice(0, 4));
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 6 }, (_, i) => thisYear - i);

  return (
    <div>
      <div className="page-header">
        <h1>Collection Incentive</h1>
        <button className="btn btn-primary" disabled={loading || !r} onClick={download}>Export to Excel</button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Report</label>
            <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
              <option value="monthly">Monthly</option>
              <option value="annual">Annual</option>
            </select>
          </div>
          {form.mode === 'monthly' ? (
            <div className="field">
              <label>Month</label>
              <input type="month" value={form.month} onChange={(e) => e.target.value && setForm({ ...form, month: e.target.value })} />
            </div>
          ) : (
            <>
              <div className="field">
                <label>Year</label>
                <select value={form.year} onChange={(e) => setForm({ ...form, year: Number(e.target.value) })}>
                  {years.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
              <div className="field">
                <label>January through</label>
                <select value={form.through} onChange={(e) => setForm({ ...form, through: Number(e.target.value) })}>
                  {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
              </div>
            </>
          )}
          <div className="field">
            <label>Location</label>
            <FilterPicker label="Location" items={locations} value={form.locationId ?? ''} onChange={(v) => setForm({ ...form, locationId: v })}
              getLabel={(l) => l.location_name} allLabel="All locations" />
          </div>
          <div className="field" style={{ alignSelf: 'end' }}>
            <button className="btn btn-primary" onClick={() => setApplied({ ...form })}>Generate</button>
          </div>
        </div>
      </div>

      {loading || !r ? (loading ? <LoadingSpinner /> : null) : (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <h3 style={{ margin: 0 }}>{data.mode === 'annual' ? 'Annual' : 'Monthly'} incentive — {data.label}</h3>
              <span className={`badge ${r.qualified ? 'badge-success' : 'badge-muted'}`} style={{ fontSize: 13 }}>
                {r.qualified ? 'Qualified' : 'Not qualified'}
              </span>
            </div>
            <div className="muted" style={{ margin: '6px 0 12px' }}>
              Payments {data.from} to {data.to}, aged on days past the invoice&apos;s due date (as Collection Report with Aging).
              {' '}Advances from Customers are counted as Current.
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Aging</th><th style={R}>Target %</th><th style={R}>Target Amount</th><th style={R}>Actual Amount Collected</th>
                    <th style={R}>Actual % of Total</th><th style={R}>Expected Incentive</th>
                    <th style={R} title="Actual % ÷ Target % when under target; 1 when the target is met">Multiplier</th>
                    <th style={R}>Actual Incentive</th>
                  </tr>
                </thead>
                <tbody>
                  {r.lines.map((l) => (
                    <tr key={l.key}>
                      <td>{l.label}{l.key === 'current' && <span className="muted"> (incl. advances)</span>}</td>
                      <td style={R}>{pct(l.target_pct)}</td>
                      <td style={R}>{money(l.target_amount)}</td>
                      <td style={R}>{money(l.collected)}</td>
                      <td style={{ ...R, color: l.actual_pct < l.target_pct ? 'var(--danger, #b91c1c)' : undefined }}>{pct(l.actual_pct)}</td>
                      <td style={R}>{money(l.expected)}</td>
                      <td style={R}>{l.multiplier === 1 ? '100%' : pct(l.multiplier, 2)}</td>
                      <td style={R}>{money(l.incentive)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700 }}>
                    <td>Total</td><td />
                    <td style={R}>{money(r.target_total)}</td>
                    <td style={R}>{money(r.total_collected)}</td>
                    <td />
                    <td style={R}>{money(r.expected_total)}</td>
                    <td />
                    <td style={R}>{money(r.incentive_total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="review-grid" style={{ marginTop: 16 }}>
              <div className="item"><div className="label">Actual collection ({r.months} month{r.months === 1 ? '' : 's'})</div><div className="value">{money(r.total_collected)}</div></div>
              {data.mode === 'annual' && <div className="item"><div className="label">Average monthly collection</div><div className="value">{money(r.avg_monthly_collection)}</div></div>}
              <div className="item"><div className="label">Base incentive ({pct(s.incentive_rate, 2)} of {data.mode === 'annual' ? 'avg monthly' : 'the month'})</div><div className="value">{money(r.base_incentive)}</div></div>
              <div className="item"><div className="label">{data.mode === 'annual' ? 'Monthly target (average of each month’s prior AR Aging)' : `Monthly target (AR Aging as of ${displayDay(data.target_as_of)}, negative balances excluded)`}</div><div className="value">{money(r.monthly_target)}</div></div>
              <div className="item">
                <div className="label">{pct(r.pct_of_target)} of target — qualifies at {pct(s.qualifier_pct, 0)}</div>
                <div className="value">{money(r.qualify_at)}</div>
              </div>
              <div className="item">
                <div className="label">{data.mode === 'annual' ? 'Average monthly incentive payable' : 'Incentive payable'}</div>
                <div className="value" style={{ fontSize: 18, fontWeight: 700, color: r.qualified ? 'var(--success, #15803d)' : undefined }}>{money(r.incentive_payable)}</div>
              </div>
            </div>
            {!r.qualified && (
              <div className="warning-banner" style={{ marginTop: 8 }}>
                Not qualified: {data.mode === 'annual' ? 'the average month' : 'the month'} collected {money(r.avg_monthly_collection)}, below {pct(s.qualifier_pct, 0)} of the {money(r.monthly_target)} monthly target ({money(r.qualify_at)}). No incentive is due.
              </div>
            )}
          </div>

          {data.mode === 'annual' && (
            <div className="card" style={{ marginBottom: 16 }}>
              <h3 style={{ marginTop: 0 }}>Month by month</h3>
              <div className="muted" style={{ marginBottom: 8 }}>
                Each month on its own, as the monthly report computes it. Only a month that reaches {pct(s.qualifier_pct, 0)} of the monthly target earns its incentive.
              </div>
              <div className="table-wrap">
                <table className="responsive-cards">
                  <thead>
                    <tr><th>Month</th><th style={R}>Collected</th><th style={R}>Target (prior AR Aging)</th><th style={R}>% of Target</th><th>Qualified</th><th style={R}>Incentive</th></tr>
                  </thead>
                  <tbody>
                    {data.months.map((m) => (
                      <tr key={m.month}>
                        <td data-label="Month">{m.label}</td>
                        <td data-label="Collected" style={R}>{money(m.collected)}</td>
                        <td data-label="Target" style={R}>{money(m.monthly_target)}</td>
                        <td data-label="% of Target" style={R}>{pct(m.pct_of_target)}</td>
                        <td data-label="Qualified">
                          <span className={`badge ${m.qualified ? 'badge-success' : 'badge-muted'}`}>{m.qualified ? 'Yes' : 'No'}</span>
                        </td>
                        <td data-label="Incentive" style={{ ...R, fontWeight: 600 }}>{money(m.payable)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ fontWeight: 700 }}>
                      <td>Earned ({data.qualified_months} of {data.months.length} months qualified)</td>
                      <td style={R}>{money(r.total_collected)}</td><td /><td /><td />
                      <td style={R}>{money(data.earned_total)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      <SetupCard year={setupYear} canEdit={canEdit} onSaved={() => load(applied)} />
    </div>
  );
}
