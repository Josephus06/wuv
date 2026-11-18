import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';
import { computeMaterialCosting } from '../utils/costing';
import { displayDateTime, displayAuditTime } from '../utils/dates';

// Costing > Material Costing > Update -- the source's MATERIAL COST screen, not the Inventory
// item form: the item's identity and purchase costs read-only on the left, the costing chain on
// the right, and only System Information below. It edits the same `inventories` row through
// PUT /inventory/:id, so the figures are the ones the list and the item page show.
//
//   Wastage Amount = Material Cost x Wastage %       Subtotal    = Material Cost + Wastage Amount
//   Mark-Up Amount = Subtotal x Mark-Up %            Total Price = Subtotal + Mark-Up Amount
//   Selling Price  = Total Price rounded up to the whole peso (42.44 -> 43), worked out here, not typed
//   each DC Amount = Selling Price x its %           (the price actually quoted, not Total Price)
//   Price Indicator = Material Cost / Last Purchase Price (Base Cost) -- how far the costing
//   basis sits from what the item last cost; the source prints it with a % sign, e.g. "1.03%".
const EDITABLE = [
  'material_cost', 'tolerance_pct', 'wastage_allowance_pct', 'markup_pct', 'selling_price', 'beg_selling_price',
  'disc_ceiling_pct', 'disc_supervisor_pct', 'disc_manager_pct', 'disc_gm_pct',
];
const DISCOUNTS = [
  ['disc_ceiling_pct', 'DC Account Officer %'],
  ['disc_supervisor_pct', 'DC Sales Supervisor %'],
  ['disc_manager_pct', 'DC Sales Manager %'],
  ['disc_gm_pct', 'DC General Manager %'],
];

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function fmt(v, digits = 2) { return num(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }); }
function longDate(v) {
  if (!v) return '';
  const d = new Date(`${String(v).slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}

export default function MaterialCostEdit() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const canEdit = can('/inventory', 'can_edit');

  const [item, setItem] = useState(null);
  const [form, setForm] = useState({});
  const [auditLogs, setAuditLogs] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.get(`/inventory/${id}`), api.get(`/inventory/${id}/audit-logs`)]).then(([itemRes, logRes]) => {
      setItem(itemRes.data);
      setForm(Object.fromEntries(EDITABLE.map((k) => [k, itemRes.data[k] ?? ''])));
      setAuditLogs(logRes.data);
    });
  }, [id]);

  if (!item) return <LoadingSpinner />;

  const cf = num(item.conversion_factor) || 1;
  const lppBase = num(item.last_purchase_price) / cf;
  const avgBase = num(item.average_cost) / cf;
  const c = computeMaterialCosting({ ...item, ...form, selling_price: null });
  const priceIndicator = lppBase > 0 && num(form.material_cost) > 0 ? num(form.material_cost) / lppBase : 0;
  // Rounded UP to the peso, as computeMaterialCosting prices a material; toFixed first so a total
  // that is whole but for float noise (42.000000001) is not pushed to the next peso.
  const sellingPrice = Math.ceil(Number(c.priceUnrounded.toFixed(6)));
  // GP Rate = (Selling Price - cost) / Selling Price. See the GP row below for which cost.
  const gpOf = (cost) => (sellingPrice > 0 ? ((sellingPrice - cost) / sellingPrice) * 100 : null);
  const gpCost = avgBase > 0 ? avgBase : c.costPerUnit;
  const gpMain = gpOf(gpCost);
  const gpSubtotal = gpOf(c.costPerUnit);

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  function input(key) {
    return <input type="number" step="0.0001" value={form[key]} onChange={set(key)} disabled={!canEdit} />;
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    // PUT writes every item field, so send the whole record with this screen's edits on top.
    const payload = { ...item, ...form, selling_price: num(form.material_cost) > 0 ? sellingPrice : form.selling_price };
    EDITABLE.forEach((k) => { if (payload[k] === '') payload[k] = ['selling_price', 'material_cost', 'beg_selling_price'].includes(k) ? null : 0; });
    payload.last_purchase_date = item.last_purchase_date ? String(item.last_purchase_date).slice(0, 10) : null;
    try {
      await api.put(`/inventory/${id}`, payload);
      navigate('/material-costing');
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Material Cost</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn" to={'/material-costing'}>Back to Lists</Link>
          {canEdit && <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>{item.item_code}</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 24 }}>
          <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', alignContent: 'start' }}>
            <div style={{ gridColumn: '1 / -1' }}><div className="muted">Display Name</div><strong>{item.display_name}</strong></div>
            <div><div className="muted">Unit Title</div><strong>{item.stock_unit_title || item.base_unit_title}</strong></div>
            <div style={{ gridColumn: 'span 2' }}><div className="muted">Base Unit</div><strong>{item.base_unit_code || item.base_unit_title}</strong></div>
            <div><div className="muted">Last Purchase Price</div><strong>{fmt(item.last_purchase_price, 4)}</strong></div>
            <div><div className="muted">Last Purchase Price (Base Cost)</div><strong>{fmt(lppBase, 4)}</strong></div>
            <div><div className="muted">Last Purchase Date</div><strong>{longDate(item.last_purchase_date)}</strong></div>
            <div><div className="muted">Average Cost</div><strong>{fmt(item.average_cost, 4)}</strong></div>
            <div style={{ gridColumn: 'span 2' }}><div className="muted">Average Cost (Base Cost)</div><strong>{fmt(avgBase, 4)}</strong></div>
          </div>

          <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', alignContent: 'start', alignItems: 'end' }}>
            <div className="field"><label>Material Cost (Base Cost)</label>{input('material_cost')}</div>
            <div><div className="muted">Price Indicator</div><strong>{fmt(priceIndicator)}%</strong></div>
            <div className="field"><label>Tolerance %</label>{input('tolerance_pct')}</div>

            <div className="field"><label>Wastage Allowance %</label>{input('wastage_allowance_pct')}</div>
            <div><div className="muted">Amount</div><strong>{fmt(c.wastage)}</strong></div>
            <div><div className="muted">Subtotal</div><strong>{fmt(c.costPerUnit)}</strong></div>

            <div className="field"><label>Mark-Up %</label>{input('markup_pct')}</div>
            <div><div className="muted">Amount</div><strong>{fmt(c.priceUnrounded - c.costPerUnit)}</strong></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, alignItems: 'end' }}>
              <div><div className="muted">Total Price</div><strong style={{ color: 'var(--accent)', fontSize: '1.2em' }}>{fmt(c.priceUnrounded)}</strong></div>
              <div className="field"><label>Selling Price</label><input value={fmt(sellingPrice)} readOnly disabled title="Total Price rounded up to the whole peso" /></div>
            </div>

            {/* GP Rate (asked 2026-10-13), live as the figures above change. Measured against the
                Average Cost (Base Cost) -- the cost an Estimate charges this material at (shared/costing.js
                computeAutoPricing) -- so it is the margin the estimate will show for it. An item never
                purchased has no average cost; then it is measured against the Subtotal instead. */}
            <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'baseline',
              padding: '10px 12px', borderRadius: 8, background: 'var(--surface-2, rgba(0,0,0,.04))' }}>
              <div>
                <div className="muted">GP Rate</div>
                <strong style={{ fontSize: '1.4em', color: gpMain != null && gpMain < 0 ? 'var(--danger, #dc2626)' : 'var(--accent)' }}>
                  {gpMain == null ? '—' : `${fmt(gpMain)}%`}
                </strong>
                <div className="muted" style={{ fontSize: 12 }}>
                  {avgBase > 0
                    ? `vs Average Cost (Base Cost) ${fmt(avgBase, 4)} — what an Estimate shows`
                    : `vs Subtotal ${fmt(c.costPerUnit)} — no Average Cost yet (never purchased)`}
                </div>
              </div>
              {avgBase > 0 && (
                <div>
                  <div className="muted">GP vs Subtotal</div>
                  <strong>{gpSubtotal == null ? '—' : `${fmt(gpSubtotal)}%`}</strong>
                  <div className="muted" style={{ fontSize: 12 }}>Material Cost + Wastage {fmt(c.costPerUnit)}</div>
                </div>
              )}
              <div>
                <div className="muted">Gross Profit</div>
                <strong>{fmt(sellingPrice - gpCost)}</strong>
                <div className="muted" style={{ fontSize: 12 }}>per base unit</div>
              </div>
            </div>

            {DISCOUNTS.map(([key, label], i) => (
              <div key={key} style={{ display: 'contents' }}>
                <div className="field"><label>{label}</label>{input(key)}</div>
                <div className="field"><label>DC Amount</label><input value={fmt(sellingPrice * num(form[key]) / 100)} readOnly disabled /></div>
                {i === 0 ? <div className="field"><label>Beg. Selling Price</label>{input('beg_selling_price')}</div> : <div />}
              </div>
            ))}
          </div>
        </div>

        <div className="status-tabs" style={{ marginTop: 24 }}>
          <button type="button" className="status-tab active">System Information</button>
        </div>
        <div className="review-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', margin: '12px 0' }}>
          <div>Created : <span className="hi">{item.created_at ? displayDateTime(item.created_at) : '—'}</span></div>
          <div>Last Updated : <span className="hi">{item.updated_at ? displayDateTime(item.updated_at) : '—'}</span></div>
        </div>
        <DataTable
          columns={[
            { key: 'set_at', label: 'When', render: (r) => displayAuditTime(r.set_at) },
            { key: 'set_by_name', label: 'Set By' },
            { key: 'event_type', label: 'Type' },
            { key: 'field_name', label: 'Field' },
            { key: 'old_value', label: 'Old Value' },
            { key: 'new_value', label: 'New Value' },
          ]}
          rows={auditLogs}
          emptyLabel="No audit history yet."
        />
      </div>
    </div>
  );
}
