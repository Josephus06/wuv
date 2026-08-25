import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

// How a shift is labelled on screen. The consolidated Z-Reading prints no branch code -- it
// identifies itself by trading name and Z counter range -- so joining on '/' unconditionally
// left a leading slash on every one of its rows.
function shiftLabel(s) {
  return [s.branch_code, s.shift].filter(Boolean).join('/') || '—';
}

// Imports POS Z-Reading shift reports as a Sales Order's daily cash & collections grid --
// one PDF per shift, one row per shift, several at once because a day runs more than one
// shift and a sheet covers a period.
//
// Deliberately two steps: the upload only READS the documents and shows what they say, and
// nothing is written until the operator has seen every row and pressed Create. These are
// records of money already taken, so an import that quietly got a figure wrong would be far
// worse than one that asked for a look first.
export default function SalesOrderImport() {
  const navigate = useNavigate();

  const [customers, setCustomers] = useState([]);
  const [locations, setLocations] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [customer, setCustomer] = useState(null);
  const [location, setLocation] = useState(null);
  const [department, setDepartment] = useState(null);
  const [memo, setMemo] = useState('');

  const [shifts, setShifts] = useState([]);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get('/customers', { params: { limit: 1000 } }),
      api.get('/lookups/locations'),
      api.get('/lookups/departments'),
    ]).then(([custRes, locRes, deptRes]) => {
      setCustomers(custRes.data.rows || custRes.data);
      setLocations(locRes.data);
      // Retired departments are excluded rather than shown and refused: the server rejects
      // an inactive one, and nothing here should be assignable to a department that is gone.
      setDepartments((deptRes.data || []).filter((d) => d.is_active));
    }).catch(() => {});
  }, []);

  async function handleFiles(e) {
    const files = [...(e.target.files || [])];
    if (!files.length) return;
    setError('');
    setShifts([]);
    setReading(true);
    try {
      const body = new FormData();
      files.forEach((f) => body.append('files', f));
      const { data } = await api.post('/sales-orders/import/preview', body);
      // The parser hands back the grid row pre-filled; it is held flat on the shift here so
      // the two collected columns the report cannot supply stay editable.
      setShifts(data.shifts.map((s) => ({ ...s, ...(s.row || {}) })));
      const dates = data.shifts.map((s) => s.closed_date).filter(Boolean).sort();
      if (!memo && dates.length) {
        const period = dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} to ${dates[dates.length - 1]}`;
        setMemo(`Z-Reading import — ${period}`);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Could not read those PDFs.');
    } finally {
      setReading(false);
    }
  }

  function updateShift(key, patch) {
    setShifts((prev) => prev.map((s) => (s.import_key === key ? { ...s, ...patch } : s)));
  }

  const usable = shifts.filter((s) => s.ok && !s.duplicate);
  const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
  const sum = (key) => usable.reduce((s, r) => s + num(r[key]), 0);

  // Mirrors the server's own refusal conditions, so the operator sees the problem in the row
  // rather than in a failed save.
  function rowProblem(s) {
    if (!near(num(s.cash) + num(s.gcash), num(s.total_daily_sales))) return 'Cash + E-wallet does not equal Total Daily Sales';
    if (!near(num(s.vat_ex) + num(s.vat_12), num(s.vat_inc))) return 'VAT EX + VAT 12% does not equal VAT (Inc.)';
    if (!near(num(s.collected_cash) + num(s.collected_gcash), num(s.collected_bank_deposit))) {
      return `Collected Cash + Collected E-wallet must add up to ${money(s.collected_bank_deposit)}`;
    }
    return null;
  }
  function near(a, b) { return Math.abs(Number(a.toFixed(2)) - Number(b.toFixed(2))) <= 0.01; }

  const problems = usable.map(rowProblem).filter(Boolean);
  const canCreate = usable.length > 0 && problems.length === 0 && !!customer && !!department;

  async function handleCreate() {
    setError('');
    if (!customer) { setError('Select the customer to record these sales against.'); return; }
    if (!department) { setError('Select the department these sales belong to.'); return; }
    setSaving(true);
    try {
      const { data } = await api.post('/sales-orders/import', {
        customer_id: customer.id,
        office_location_id: location?.id || null,
        department_id: department.id,
        memo,
        shifts: usable.map((s) => ({
          import_key: s.import_key, source_file: s.source_file, store_name: s.store_name,
          branch_code: s.branch_code, shift: s.shift, closed_by: s.closed_by,
          // Both attendants and both times, so the order records who had the till and when --
          // the closing cashier is also what the server resolves the Sales Rep from.
          opened_by: s.opened_by, opened_date: s.opened_date, opened_time: s.opened_time,
          closed_date: s.closed_date, closed_time: s.closed_time,
          beginning_or: s.beginning_or, ending_or: s.ending_or,
          // The Z-Reading's category breakdown has to travel with the row: it is what the
          // GL entry splits revenue by (laundry vs water refilling). Without it the order
          // saves fine but has no GL impact at all.
          categories: s.categories,
          sale_date: s.sale_date, cash: s.cash, collected_cash: s.collected_cash,
          gcash: s.gcash, collected_gcash: s.collected_gcash,
          collected_bank_deposit: s.collected_bank_deposit, total_daily_sales: s.total_daily_sales,
          total_cash_to_deposit: s.total_cash_to_deposit, total_gcash: s.total_gcash,
          uncollected_sales: s.uncollected_sales, vat_ex: s.vat_ex, vat_12: s.vat_12, vat_inc: s.vat_inc,
        })),
      });
      navigate(`/sales-orders/${data.id}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Import failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Sales Order — Import Z-Reading</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => navigate('/sales-orders')}>Back to Lists</button>
          <button className="btn btn-primary" disabled={!canCreate || saving} onClick={handleCreate}>
            {saving ? <LoadingSpinner inline size="sm" label="Creating..." /> : 'Create Sales Order'}
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="field">
          <label>Z-Reading PDFs — pick one per shift, several at a time</label>
          <input type="file" multiple accept="application/pdf,.pdf" onChange={handleFiles} />
        </div>
        {reading && <LoadingSpinner inline size="sm" label="Reading the PDFs..." />}
      </div>

      {shifts.length > 0 && (
        <>
          <div className="card" style={{ marginTop: 16 }}>
            <div className="review-grid" style={{ gridTemplateColumns: '1fr 1fr 260px' }}>
              <div>
                <div className="field">
                  <label>Customer *</label>
                  <EntityPicker
                    label="Customer" items={customers} value={customer?.id || ''} getLabel={(c) => c?.name}
                    columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']}
                    onSelect={setCustomer}
                  />
                </div>
                <div className="field">
                  <label>Office Location</label>
                  <EntityPicker
                    label="Office Location" items={locations} value={location?.id || ''} getLabel={(l) => l.location_name}
                    columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']}
                    onSelect={setLocation}
                  />
                </div>
              </div>
              <div>
                {/* Required, unlike Office Location: this order posts straight to the ledger,
                    and its revenue has to land in a department the way every other posting
                    document's does. */}
                <div className="field">
                  <label>Department *</label>
                  <EntityPicker
                    label="Department" items={departments} value={department?.id || ''} getLabel={(d) => d?.name}
                    columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']}
                    onSelect={setDepartment}
                  />
                  {!department && <div className="muted" style={{ marginTop: 4 }}>Assign the department these takings belong to.</div>}
                </div>
                <div className="field"><label>Memo</label><textarea rows={3} value={memo} onChange={(e) => setMemo(e.target.value)} /></div>
              </div>
              <div className="card" style={{ background: 'var(--surface-2, #f3f4f6)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Shifts</span><span className="hi">{usable.length} of {shifts.length}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">VAT EX</span><span className="hi">{money(sum('vat_ex'))}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">VAT 12%</span><span className="hi">{money(sum('vat_12'))}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}><span>Total Daily Sales</span><span>{money(sum('total_daily_sales'))}</span></div>
              </div>
            </div>
          </div>

          {/* The report was read fine but its own figures disagree. Shown in the milder tone
              and separately from the refusals above: the row is still importable once the
              operator settles the difference in the grid. */}
          {usable.filter((s) => (s.warnings || []).length).map((s) => (
            <div className="warning-banner" style={{ marginTop: 16 }} key={`warn-${s.import_key}`}>
              <strong>{s.source_file}</strong> — this report does not agree with itself:
              <ul style={{ margin: '8px 0 0 18px' }}>
                {(s.warnings || []).map((w, j) => <li key={j}>{w}</li>)}
              </ul>
              <div style={{ marginTop: 6 }}>
                Check the figures against the till and correct Cash / E-wallet below before creating the order.
              </div>
            </div>
          ))}

          {shifts.filter((s) => !s.ok || s.duplicate).map((s, i) => (
            <div className="error-banner" style={{ marginTop: 16 }} key={`bad-${i}`}>
              <strong>{s.source_file}</strong>
              {s.duplicate
                ? <> — this shift is already imported as <strong>{s.duplicate.sales_order_no}</strong>, so it is excluded.</>
                : (
                  <ul style={{ margin: '8px 0 0 18px' }}>
                    {(s.errors || []).map((e, j) => <li key={j}>{e}</li>)}
                  </ul>
                )}
            </div>
          ))}

          <div className="card" style={{ marginTop: 16 }}>
            <h3 className="subsection" style={{ marginTop: 0 }}>Daily Sales &amp; Collections</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th><th>Branch / Shift</th><th>Cash</th><th>Collected Cash</th><th>E-wallet</th>
                    <th>Collected E-wallet</th><th>Collected Bank Deposit / Collected Sales</th>
                    <th>Total Daily Sales</th><th>Total Cash to be Deposited</th><th>Total E-wallet</th>
                    <th>Uncollected Sales</th><th>VAT EX</th><th>VAT 12%</th><th>VAT (Inc.)</th>
                  </tr>
                </thead>
                <tbody>
                  {usable.map((s) => {
                    const problem = rowProblem(s);
                    return (
                      <tr key={s.import_key} title={problem || ''}>
                        <td>{s.sale_date}</td>
                        <td>{shiftLabel(s)}</td>
                        {/* Editable, unlike the rest of the printed figures. A POS that prints
                            a tender split not adding to its own net sales (branch 786 is six
                            pesos out) would otherwise be unimportable forever -- the operator
                            settles it against the till, and the totals still have to tie
                            before Create will save anything. */}
                        <td>
                          <input
                            type="number" step="0.01" style={{ width: 110 }}
                            value={s.cash}
                            onChange={(e) => updateShift(s.import_key, { cash: e.target.value })}
                          />
                        </td>
                        {/* The Z-Reading prints only a single COLLECTED total, never the split
                            by tender -- so these two are the operator's to fill in. */}
                        <td>
                          <input
                            type="number" step="0.01" style={{ width: 110 }}
                            value={s.collected_cash}
                            onChange={(e) => updateShift(s.import_key, { collected_cash: e.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            type="number" step="0.01" style={{ width: 110 }}
                            value={s.gcash}
                            onChange={(e) => updateShift(s.import_key, { gcash: e.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            type="number" step="0.01" style={{ width: 110 }}
                            value={s.collected_gcash}
                            onChange={(e) => updateShift(s.import_key, { collected_gcash: e.target.value })}
                          />
                        </td>
                        <td>{money(s.collected_bank_deposit)}</td>
                        <td>{money(s.total_daily_sales)}</td>
                        <td>{money(s.total_cash_to_deposit)}</td>
                        <td>{money(s.total_gcash)}</td>
                        <td>{money(s.uncollected_sales)}</td>
                        <td>{money(s.vat_ex)}</td>
                        <td>{money(s.vat_12)}</td>
                        <td>{money(s.vat_inc)}</td>
                      </tr>
                    );
                  })}
                  {usable.length > 0 && (
                    <tr>
                      <td colSpan={2}><strong>Total</strong></td>
                      {['cash', 'collected_cash', 'gcash', 'collected_gcash', 'collected_bank_deposit',
                        'total_daily_sales', 'total_cash_to_deposit', 'total_gcash', 'uncollected_sales',
                        'vat_ex', 'vat_12', 'vat_inc'].map((k) => (
                          <td key={k}><strong>{money(sum(k))}</strong></td>
                        ))}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {problems.length > 0 && (
              <div className="error-banner" style={{ marginTop: 12 }}>
                <ul style={{ margin: '0 0 0 18px' }}>
                  {problems.map((p, i) => <li key={i}>{p}</li>)}
                </ul>
              </div>
            )}
          </div>

          {usable.map((s) => (
            <div className="card" style={{ marginTop: 16 }} key={`detail-${s.import_key}`}>
              <h3 className="subsection" style={{ marginTop: 0 }}>
                {shiftLabel(s)} — {s.sale_date} · OR {s.beginning_or} → {s.ending_or}
              </h3>
              {/* Who had the till and when. The closing cashier becomes the order's Sales Rep
                  where that name matches an employee record. */}
              <div className="muted" style={{ marginBottom: 10 }}>
                Opened <strong>{s.opened_time || '—'}</strong> by <strong>{s.opened_by || '—'}</strong>
                {' · '}
                Closed <strong>{s.closed_time || '—'}</strong> by <strong>{s.closed_by || '—'}</strong>
              </div>
              <div className="review-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <div>
                  <div className="muted" style={{ marginBottom: 6 }}>Category breakdown</div>
                  <table>
                    <tbody>
                      {(s.categories || []).map((c) => (
                        <tr key={c.name}><td>{c.name}</td><td style={{ textAlign: 'right' }}>{money(c.amount)}</td></tr>
                      ))}
                      <tr><td><strong>Gross</strong></td><td style={{ textAlign: 'right' }}><strong>{money(s.figures?.gross)}</strong></td></tr>
                    </tbody>
                  </table>
                </div>
                <div>
                  <div className="muted" style={{ marginBottom: 6 }}>Uncollected ({(s.uncollected_items || []).length} accounts)</div>
                  <table>
                    <tbody>
                      {(s.uncollected_items || []).map((u, i) => (
                        <tr key={i}><td>{u.customer}</td><td>{u.reference_date}</td><td style={{ textAlign: 'right' }}>{money(u.amount)}</td></tr>
                      ))}
                      <tr><td colSpan={2}><strong>Total</strong></td><td style={{ textAlign: 'right' }}><strong>{money(s.uncollected_sales)}</strong></td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="muted" style={{ marginTop: 10 }}>
                {(s.checks || []).filter((c) => c.ok).length} of {(s.checks || []).length} internal totals reconciled.

              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
