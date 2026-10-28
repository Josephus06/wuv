import { useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import LoadingSpinner from '../components/LoadingSpinner';
import { formatDate, peso } from '../utils/payroll';

const ROUTE = '/payroll-settings';

const DAY_LABELS = {
  ordinary: 'Ordinary day',
  rest_day: 'Rest day',
  special_holiday: 'Special holiday',
  special_holiday_rest_day: 'Special holiday on rest day',
  regular_holiday: 'Regular holiday',
  regular_holiday_rest_day: 'Regular holiday on rest day',
};

// Same construction as the server's periodBrackets (lib/payrollRules.js), so the preview shows
// exactly the table a payroll will use.
function periodBrackets(brackets, periods) {
  const sorted = [...brackets].map((b) => ({ over: Number(b.over), base: Number(b.base), rate: Number(b.rate) })).sort((a, b) => a.over - b.over);
  const out = [];
  sorted.forEach((b, i) => {
    const over = Math.round(b.over / periods);
    const base = i === 0 ? b.base / periods : out[i - 1].base + (over - out[i - 1].over) * out[i - 1].rate;
    out.push({ over, base: Math.round(base * 100) / 100, rate: b.rate });
  });
  return out;
}

const toPct = (v) => (v === '' || v === null || v === undefined ? '' : String(Math.round(Number(v) * 10000) / 100));
const fromPct = (v) => (v === '' ? '' : Number(v) / 100);

export default function PayrollSettings() {
  const { can } = useAuth();
  const [sets, setSets] = useState(null);
  const [selected, setSelected] = useState(null);
  const [rules, setRules] = useState(null);
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const editable = can(ROUTE, 'can_edit');

  async function load(selectDate) {
    const { data } = await api.get('/payroll-setup/rule-sets');
    setSets(data.rule_sets);
    const pick = data.rule_sets.find((s) => s.effective_from === selectDate) || data.rule_sets[0];
    if (pick) choose(pick);
    else { setRules(data.defaults); setEffectiveFrom(''); setSelected(null); }
  }

  function choose(set) {
    setSelected(set);
    setRules(JSON.parse(JSON.stringify(set.rules)));
    setEffectiveFrom(set.effective_from);
    setNotes(set.notes || '');
    setError('');
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (path, value) => setRules((r) => {
    const next = JSON.parse(JSON.stringify(r));
    const [a, b] = path.split('.');
    if (b) next[a][b] = value; else next[a] = value;
    return next;
  });
  const get = (path) => {
    const [a, b] = path.split('.');
    return b ? rules[a][b] : rules[a];
  };

  async function save(e) {
    e.preventDefault();
    setError('');
    setNotice('');
    setSaving(true);
    try {
      await api.post('/payroll-setup/rule-sets', { effective_from: effectiveFrom, rules, notes });
      setNotice(selected && selected.effective_from === effectiveFrom
        ? `Rates effective ${formatDate(effectiveFrom)} updated. Draft payrolls pick them up when recomputed; approved ones keep the rates they used.`
        : `New rates saved, effective ${formatDate(effectiveFrom)}. Cutoffs ending before that date keep the earlier rates.`);
      await load(effectiveFrom);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function removeSet() {
    if (!confirm(`Delete the rates effective ${formatDate(selected.effective_from)}?`)) return;
    try {
      await api.delete(`/payroll-setup/rule-sets/${selected.id}`);
      setNotice('');
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Delete failed');
    }
  }

  if (!rules) return <LoadingSpinner />;

  // Which cutoff of the month the agency's contribution is deducted in.
  const deductIn = (agency) => (
    <div className="field">
      <label>Deducted in</label>
      <select disabled={!editable} value={rules.contribution_cutoffs[agency]} onChange={(e) => set(`contribution_cutoffs.${agency}`, e.target.value)}>
        <option value="split">Half in each cutoff</option>
        <option value="first">All in the 1st cutoff</option>
        <option value="second">All in the 2nd cutoff</option>
      </select>
    </div>
  );

  const num = (path, label, opts = {}) => (
    <div className="field">
      <label>{label}</label>
      <input type="number" step={opts.step || 'any'} min="0" disabled={!editable} value={get(path)}
        onChange={(e) => set(path, e.target.value === '' ? '' : Number(e.target.value))} />
      {opts.hint && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{opts.hint}</div>}
    </div>
  );
  const pct = (path, label, hint) => (
    <div className="field">
      <label>{label} (%)</label>
      <input type="number" step="any" min="0" disabled={!editable} value={toPct(get(path))}
        onChange={(e) => set(path, fromPct(e.target.value))} />
      {hint && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{hint}</div>}
    </div>
  );

  const semi = periodBrackets(rules.tax_brackets, 24);
  const isNewDate = selected && effectiveFrom !== selected.effective_from;

  return (
    <form onSubmit={save}>
      <div className="page-header">
        <h1>Payroll Settings</h1>
        {editable && (
          <button type="submit" className="btn btn-primary" disabled={saving || !effectiveFrom}>
            {saving ? 'Saving…' : isNewDate ? 'Save as New Rates' : 'Save'}
          </button>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="success-banner">{notice}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Rate set</label>
            <select value={selected?.id || ''} onChange={(e) => choose(sets.find((s) => String(s.id) === e.target.value))}>
              {sets.map((s) => <option key={s.id} value={s.id}>Effective {formatDate(s.effective_from)}{s === sets[0] ? ' (latest)' : ''}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Effective from</label>
            <input type="date" required disabled={!editable} value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
          </div>
          <div className="field">
            <label>Notes</label>
            <input disabled={!editable} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. SSS Circular 2026-xxx" />
          </div>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          A payroll uses the latest rates effective on its cutoff&apos;s last day. When an agency changes a rate, change the
          effective date to when it starts and save. That adds a new set and keeps the old one for earlier cutoffs.
          {isNewDate && <strong> Saving will add a new rate set effective {formatDate(effectiveFrom)}.</strong>}
          {selected && editable && sets.length > 1 && !isNewDate && (
            <> <button type="button" className="link-button" onClick={removeSet}>Delete this rate set</button></>
          )}
        </p>
      </div>

      <div className="settings-grid">
        <section className="card">
          <h3>Pay basis</h3>
          {num('hours_per_day', 'Hours per working day')}
          {num('working_days_per_year', 'Working days per year', { hint: 'Monthly rate × 12 ÷ this = daily rate. 313 for a 6-day week, 261 for 5 days.' })}
          {num('overtime_block_minutes', 'Overtime counted in blocks of (minutes)', { hint: 'Overtime shorter than one block is not paid.' })}
        </section>

        <section className="card">
          <h3>Holiday, rest day &amp; overtime pay</h3>
          <p className="muted" style={{ fontSize: 12 }}>Pay for the first 8 hours, as a % of the hourly rate.</p>
          <div className="settings-pairs">
            {Object.keys(DAY_LABELS).map((k) => <div key={k}>{pct(`day_multipliers.${k}`, DAY_LABELS[k])}</div>)}
          </div>
          <div className="settings-pairs">
            {pct('overtime_multiplier_ordinary', 'Overtime, ordinary day', 'Of the day\'s hourly rate (125% = +25%)')}
            {pct('overtime_multiplier_other', 'Overtime, other days', '130% = +30%')}
            {pct('night_differential_rate', 'Night differential', 'Added per night hour')}
            <div className="field">
              <label>Night hours</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input type="time" disabled={!editable} value={rules.night_start} onChange={(e) => set('night_start', e.target.value)} />
                <input type="time" disabled={!editable} value={rules.night_end} onChange={(e) => set('night_end', e.target.value)} />
              </div>
            </div>
          </div>
        </section>

        <section className="card">
          <h3>SSS</h3>
          <div className="settings-pairs">
            {num('sss.msc_min', 'Lowest salary credit (MSC)')}
            {num('sss.msc_max', 'Highest salary credit (MSC)')}
            {num('sss.msc_step', 'MSC step')}
            {pct('sss.employee_rate', 'Employee share')}
            {pct('sss.employer_rate', 'Employer share')}
            {num('sss.ec_threshold', 'EC: higher amount from MSC')}
            {num('sss.ec_low', 'EC below that')}
            {num('sss.ec_high', 'EC from that')}
          </div>
          {deductIn('sss')}
        </section>

        <section className="card">
          <h3>PhilHealth</h3>
          <div className="settings-pairs">
            {pct('philhealth.rate', 'Premium rate')}
            {pct('philhealth.employee_share', 'Employee pays', 'Of the premium')}
            {num('philhealth.floor', 'Income floor')}
            {num('philhealth.ceiling', 'Income ceiling')}
          </div>
          {deductIn('philhealth')}
        </section>

        <section className="card">
          <h3>Pag-IBIG</h3>
          <div className="settings-pairs">
            {pct('pagibig.employee_rate', 'Employee share')}
            {pct('pagibig.employer_rate', 'Employer share')}
            {num('pagibig.max_fund_salary', 'Maximum fund salary')}
            {num('pagibig.low_threshold', 'Low-salary threshold')}
            {pct('pagibig.employee_rate_low', 'Employee share at or below it')}
          </div>
          {deductIn('pagibig')}
        </section>

        <section className="card settings-wide">
          <h3>Withholding tax (annual table)</h3>
          <table className="payslip-table">
            <thead><tr><th>Annual income over</th><th>Fixed tax</th><th>Plus % of excess</th>{editable && <th />}</tr></thead>
            <tbody>
              {rules.tax_brackets.map((b, i) => (
                <tr key={i}>
                  {['over', 'base'].map((k) => (
                    <td key={k}>
                      <input type="number" step="any" min="0" disabled={!editable || (k === 'over' && i === 0)} value={b[k]}
                        onChange={(e) => set('tax_brackets', rules.tax_brackets.map((x, j) => (j === i ? { ...x, [k]: e.target.value === '' ? '' : Number(e.target.value) } : x)))} />
                    </td>
                  ))}
                  <td>
                    <input type="number" step="any" min="0" max="99" disabled={!editable} value={toPct(b.rate)}
                      onChange={(e) => set('tax_brackets', rules.tax_brackets.map((x, j) => (j === i ? { ...x, rate: fromPct(e.target.value) } : x)))} />
                  </td>
                  {editable && (
                    <td>{i > 0 && <button type="button" className="btn btn-sm" onClick={() => set('tax_brackets', rules.tax_brackets.filter((_, j) => j !== i))}>Remove</button>}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {editable && (
            <button type="button" className="btn btn-sm" style={{ marginTop: 8 }}
              onClick={() => set('tax_brackets', [...rules.tax_brackets, { over: '', base: '', rate: '' }])}>
              Add Bracket
            </button>
          )}
          <h4 style={{ marginTop: 18 }}>What each semi-monthly cutoff uses</h4>
          <p className="muted" style={{ fontSize: 12 }}>Built the way BIR builds its semi-monthly table. Check it against the published table after any change.</p>
          <table className="payslip-table">
            <thead><tr><th>Taxable pay over</th><th>Tax</th></tr></thead>
            <tbody>
              {semi.map((b, i) => (
                <tr key={i}>
                  <td>{peso(b.over)}</td>
                  <td>{b.rate ? `${peso(b.base)} + ${toPct(b.rate)}% of the excess over ${peso(b.over)}` : 'Tax-exempt'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </form>
  );
}
