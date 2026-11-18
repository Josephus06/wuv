import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

// Full-page Add/Edit form for Inventory items -- mirrors JobOrderEdit.jsx's pattern:
// EntityPicker (searchable modal) for Category/Unit/Chart-of-Accounts fields instead of
// plain <select> dropdowns, since those lists are too long to scan without search.
// Type, as the source's item screen offers it (2026-10-08):
//   INVENTORY  kept on the shelf -- replenished from Purchasing > Inventory Replenishment when
//              stock will not cover the job orders in production;
//   JIT        just in time -- bought for the job that needs it, never stocked.
// Stored upper-case, as the 4,200 migrated items carry them. An item already of another type
// (Service, or the app's older 'Inventory') keeps it and shows it; Service Items > Add New opens
// this form with ?type=Service.
const ITEM_TYPES = [{ value: 'INVENTORY', label: 'Inventory' }, { value: 'JIT', label: 'JIT' }];
const normType = (t) => (String(t || '').toUpperCase() === 'INVENTORY' ? 'INVENTORY' : (t || ''));

const EMPTY = {
  item_code: '', display_name: '', sales_description: '', purchase_description: '',
  category_id: '', base_unit_id: '', purchase_unit_id: '', stock_unit_id: '', sales_unit_id: '',
  conversion_factor: 1, unit_title_id: '', length: '', width: '', item_type: '', reorder_point: 0, is_active: true,
  to_type: '', is_office_supply: false, is_to_item: true,
  is_with_jo: false, is_po: false, is_jo: false,
  is_length_based: false, is_width_based: false, last_purchase_price: '', last_purchase_date: '',
  average_cost: '', material_cost: '', price_indicator: 0, tolerance_pct: 0, wastage_allowance_pct: 0, markup_pct: 0,
  selling_price: '', beg_selling_price: '', disc_ceiling_pct: 0, disc_supervisor_pct: 0,
  disc_manager_pct: 0, disc_gm_pct: 0,
  expense_account_id: '', asset_account_id: '', income_account_id: '', cogs_account_id: '',
};

function accountLabel(a) { return a ? `${a.account_code} — ${a.account_name}` : ''; }
const fmtUnitNum = (v, d) => (v === null || v === undefined || v === '' ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
function unitLabel(u) { return u ? `${u.title} (${u.code})` : ''; }

// Sales / Pricing follows the costing sheet (matcosting.xlsx) cell for cell:
//   Wastage Amt = Material Cost x Wastage %      Subtotal = Material Cost + Wastage Amt
//   Markup Amt  = Subtotal x Markup %            Selling Price = Subtotal + Markup Amt
//   each Disc. Amt (AC / Supervisor / Manager / GM) = Selling Price x its %
function xlN(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function xlNum(v) { return xlN(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function computePricing(f) {
  const cost = xlN(f.material_cost);
  const wastageAmt = cost * xlN(f.wastage_allowance_pct) / 100;
  const subtotal = wastageAmt + cost;
  const markupAmt = subtotal * xlN(f.markup_pct) / 100;
  const sellingPrice = markupAmt + subtotal;
  return {
    wastageAmt, subtotal, markupAmt, sellingPrice,
    discAc: sellingPrice * xlN(f.disc_ceiling_pct) / 100,
    discSupervisor: sellingPrice * xlN(f.disc_supervisor_pct) / 100,
    discManager: sellingPrice * xlN(f.disc_manager_pct) / 100,
    discGm: sellingPrice * xlN(f.disc_gm_pct) / 100,
  };
}

export default function InventoryEdit() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const isNew = !id;
  const navigate = useNavigate();

  const [form, setForm] = useState(() => ({ ...EMPTY, item_type: isNew ? (searchParams.get('type') || '') : '' }));
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [categories, setCategories] = useState([]);
  const [units, setUnits] = useState([]);
  // Unit Titles (Master Lists > Unit of Measures): picking one fills the units, length, width and
  // conversion below, as the source's Inventory form does (2026-10-12).
  const [unitTitles, setUnitTitles] = useState([]);
  useEffect(() => { api.get('/unit-of-measures/titles-lookup').then(({ data }) => setUnitTitles(data || [])).catch(() => {}); }, []);
  const [accounts, setAccounts] = useState([]);

  useEffect(() => {
    Promise.all([
      api.get('/lookups/inventory-categories'),
      api.get('/lookups/units-of-measure'),
      api.get('/lookups/chart-of-accounts'),
      isNew ? Promise.resolve(null) : api.get(`/inventory/${id}`),
    ]).then(([catRes, unitRes, acctRes, itemRes]) => {
      setCategories(catRes.data);
      setUnits(unitRes.data);
      setAccounts(acctRes.data);
      if (itemRes) {
        const data = itemRes.data;
        setForm({
          item_code: data.item_code, display_name: data.display_name,
          sales_description: data.sales_description || '', purchase_description: data.purchase_description || '',
          category_id: data.category_id || '', base_unit_id: data.base_unit_id || '',
          purchase_unit_id: data.purchase_unit_id || '', stock_unit_id: data.stock_unit_id || '', sales_unit_id: data.sales_unit_id || '',
          conversion_factor: data.conversion_factor ?? 1, item_type: normType(data.item_type),
          unit_title_id: data.unit_title_id || '', length: data.length ?? '', width: data.width ?? '',
          reorder_point: data.reorder_point || 0, is_active: !!data.is_active,
          to_type: data.to_type || '', is_office_supply: !!data.is_office_supply, is_to_item: !!data.is_to_item,
          is_with_jo: !!data.is_with_jo, is_po: !!data.is_po, is_jo: !!data.is_jo,
          is_length_based: !!data.is_length_based, is_width_based: !!data.is_width_based,
          last_purchase_price: data.last_purchase_price ?? '', last_purchase_date: data.last_purchase_date ? String(data.last_purchase_date).slice(0, 10) : '',
          average_cost: data.average_cost ?? '', material_cost: data.material_cost ?? '', price_indicator: data.price_indicator ?? 0, tolerance_pct: data.tolerance_pct ?? 0,
          wastage_allowance_pct: data.wastage_allowance_pct ?? 0, markup_pct: data.markup_pct ?? 0,
          selling_price: data.selling_price ?? '', beg_selling_price: data.beg_selling_price ?? '',
          disc_ceiling_pct: data.disc_ceiling_pct ?? 0, disc_supervisor_pct: data.disc_supervisor_pct ?? 0,
          disc_manager_pct: data.disc_manager_pct ?? 0, disc_gm_pct: data.disc_gm_pct ?? 0,
          expense_account_id: data.expense_account_id || '', asset_account_id: data.asset_account_id || '',
          income_account_id: data.income_account_id || '', cogs_account_id: data.cogs_account_id || '',
        });
      }
      setLoading(false);
    });
  }, [id, isNew]);

  // A Unit Title fills Base / Purchase / Stock / Sales Unit (matched by code), Length, Width and
  // Conversion. A unit it names that is not in the units list leaves that field as it was.
  function applyUnitTitle(t) {
    if (!t) return;
    const unitId = (code) => (code ? (units.find((u) => String(u.code).trim().toLowerCase() === String(code).trim().toLowerCase()) || {}).id : undefined);
    const pick = (code, current) => unitId(code) || current;
    setForm((f) => ({
      ...f,
      unit_title_id: t.id,
      base_unit_id: pick(t.base_unit, f.base_unit_id),
      purchase_unit_id: pick(t.purchase_unit, f.purchase_unit_id),
      stock_unit_id: pick(t.stock_unit, f.stock_unit_id),
      // Most source titles name no sale unit (114 of 246); the source then sells in the base unit
      // (SHT-SQFT-30 -> SQFT), so a blank Sales Unit takes the base unit rather than staying blank.
      sales_unit_id: unitId(t.sale_unit) || f.sales_unit_id || unitId(t.base_unit) || '',
      length: t.length ?? '',
      width: t.width ?? '',
      conversion_factor: t.conversion ?? 1,
    }));
  }

  const pricing = computePricing(form);
  function cellInput(key, step = '0.01') {
    return <input type="number" step={step} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />;
  }

  async function handleSave() {
    if (!form.item_type) { setError('Select a Type -- Inventory (stocked) or JIT (bought per job).'); return; }
    setSaving(true);
    setError('');
    const payload = { ...form };
    // Selling Price is no longer typed in -- it's the sheet's Subtotal + Markup Amount.
    payload.selling_price = form.material_cost === '' ? form.selling_price : Math.round(pricing.sellingPrice * 10000) / 10000;
    ['category_id', 'base_unit_id', 'purchase_unit_id', 'stock_unit_id', 'sales_unit_id', 'expense_account_id', 'asset_account_id', 'income_account_id', 'cogs_account_id', 'unit_title_id']
      .forEach((k) => { payload[k] = payload[k] || null; });
    ['last_purchase_price', 'last_purchase_date', 'average_cost', 'material_cost', 'selling_price', 'beg_selling_price', 'length', 'width']
      .forEach((k) => { payload[k] = payload[k] === '' ? null : payload[k]; });
    try {
      if (isNew) {
        const { data } = await api.post('/inventory', payload);
        navigate(`/inventory/${data.id}`);
      } else {
        await api.put(`/inventory/${id}`, payload);
        navigate(`/inventory/${id}`);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="page-header">
        <h1>{isNew ? 'Add Inventory Item' : `Inventory Item — ${form.item_code}`}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn" to={isNew ? '/inventory' : `/inventory/${id}`}>Cancel</Link>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <h3 className="subsection" style={{ marginTop: 0 }}>Basic Info</h3>
        <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="field"><label>Item Code</label><input required value={form.item_code} onChange={(e) => setForm({ ...form, item_code: e.target.value })} /></div>
          <div className="field"><label>Display Name</label><input required value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} /></div>
          <div className="field">
            <label>Category</label>
            <EntityPicker
              label="Category" items={categories} value={form.category_id} getLabel={(c) => c.name}
              columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']}
              onSelect={(c) => setForm({ ...form, category_id: c.id })}
            />
          </div>

          <div className="field"><label>Sales Description</label><input value={form.sales_description} onChange={(e) => setForm({ ...form, sales_description: e.target.value })} /></div>
          <div className="field"><label>Purchase Description</label><input value={form.purchase_description} onChange={(e) => setForm({ ...form, purchase_description: e.target.value })} /></div>
          <div className="field">
            <label>Type</label>
            <select value={form.item_type} onChange={(e) => setForm({ ...form, item_type: e.target.value })}>
              <option value="">--Select--</option>
              {ITEM_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              {form.item_type && !ITEM_TYPES.some((t) => t.value === form.item_type) && (
                <option value={form.item_type}>{form.item_type}</option>
              )}
            </select>
          </div>

          <div className="field"><label>Reorder Point</label><input type="number" step="0.0001" value={form.reorder_point} onChange={(e) => setForm({ ...form, reorder_point: e.target.value })} /></div>
          {/* A dropdown, as the source has it (2026-10-12): as free text it took browser autofill --
              a whole description landed here and the 30-character column refused every save. */}
          <div className="field">
            <label>TO Type</label>
            <select value={form.to_type} onChange={(e) => setForm({ ...form, to_type: e.target.value })}>
              <option value="">--Select--</option>
              <option value="Count">Count</option>
              <option value="Whole">Whole</option>
              {form.to_type && !['Count', 'Whole'].includes(form.to_type) && <option value={form.to_type}>{form.to_type}</option>}
            </select>
          </div>
        </div>
        <div className="field-row" style={{ marginTop: 12 }}>
          <div className="field field-checkbox">
            <input type="checkbox" id="is-active" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
            <label htmlFor="is-active">Active</label>
          </div>
          <div className="field field-checkbox">
            <input type="checkbox" id="is-office-supply" checked={form.is_office_supply} onChange={(e) => setForm({ ...form, is_office_supply: e.target.checked })} />
            <label htmlFor="is-office-supply">Office Supply Requisition</label>
          </div>
          <div className="field field-checkbox">
            <input type="checkbox" id="is-to-item" checked={form.is_to_item} onChange={(e) => setForm({ ...form, is_to_item: e.target.checked })} />
            <label htmlFor="is-to-item">TO Item</label>
          </div>
          {form.item_type === 'Service' && (
            <>
              <div className="field field-checkbox">
                <input type="checkbox" id="is-with-jo" checked={form.is_with_jo} onChange={(e) => setForm({ ...form, is_with_jo: e.target.checked })} />
                <label htmlFor="is-with-jo">With JO</label>
              </div>
              <div className="field field-checkbox">
                <input type="checkbox" id="is-po" checked={form.is_po} onChange={(e) => setForm({ ...form, is_po: e.target.checked })} />
                <label htmlFor="is-po">PO</label>
              </div>
              <div className="field field-checkbox">
                <input type="checkbox" id="is-jo" checked={form.is_jo} onChange={(e) => setForm({ ...form, is_jo: e.target.checked })} />
                <label htmlFor="is-jo">JO</label>
              </div>
            </>
          )}
        </div>
        {isNew && (
          <p className="muted" style={{ marginTop: 12 }}>
            New items start pending both Costing and Accounting approval. Fill in Sales/Pricing and Accounting below (or after saving) to make those approvals available on the item's view page.
          </p>
        )}

        <h3 className="subsection">Units</h3>
        <div className="field">
          <label>Unit Title</label>
          <EntityPicker
            label="Unit Titles" items={unitTitles} value={form.unit_title_id} getLabel={(t) => t?.title}
            columns={[
              { key: 'title', label: 'Unit Title' }, { key: 'purchase_unit', label: 'Purchase Unit' },
              { key: 'stock_unit', label: 'Stock Unit' }, { key: 'sale_unit', label: 'Sale Unit' }, { key: 'base_unit', label: 'Base Unit' },
              { key: 'length', label: 'Length', render: (t) => fmtUnitNum(t.length, 2) },
              { key: 'width', label: 'Width', render: (t) => fmtUnitNum(t.width, 2) },
              { key: 'conversion', label: 'Conversion', render: (t) => fmtUnitNum(t.conversion, 2) },
            ]}
            searchKeys={['title', 'purchase_unit', 'stock_unit', 'sale_unit', 'base_unit']}
            placeholder="Select Unit Title..."
            onSelect={applyUnitTitle}
            onClear={() => setForm({ ...form, unit_title_id: '' })}
          />
        </div>
        <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="field">
            <label>Base Unit</label>
            <EntityPicker
              label="Base Unit" items={units} value={form.base_unit_id} getLabel={unitLabel}
              columns={[{ key: 'title', label: 'Title' }, { key: 'code', label: 'Code' }]} searchKeys={['title', 'code']}
              onSelect={(u) => setForm({ ...form, base_unit_id: u.id })}
            />
          </div>
          <div className="field">
            <label>Purchase Unit</label>
            <EntityPicker
              label="Purchase Unit" items={units} value={form.purchase_unit_id} getLabel={unitLabel}
              columns={[{ key: 'title', label: 'Title' }, { key: 'code', label: 'Code' }]} searchKeys={['title', 'code']}
              onSelect={(u) => setForm({ ...form, purchase_unit_id: u.id })}
            />
          </div>
          <div className="field">
            <label>Stock Unit</label>
            <EntityPicker
              label="Stock Unit" items={units} value={form.stock_unit_id} getLabel={unitLabel}
              columns={[{ key: 'title', label: 'Title' }, { key: 'code', label: 'Code' }]} searchKeys={['title', 'code']}
              onSelect={(u) => setForm({ ...form, stock_unit_id: u.id })}
            />
          </div>
          <div className="field">
            <label>Sales Unit</label>
            <EntityPicker
              label="Sales Unit" items={units} value={form.sales_unit_id} getLabel={unitLabel}
              columns={[{ key: 'title', label: 'Title' }, { key: 'code', label: 'Code' }]} searchKeys={['title', 'code']}
              onSelect={(u) => setForm({ ...form, sales_unit_id: u.id })}
            />
          </div>
          <div className="field"><label>Length</label><input type="number" step="any" value={form.length} onChange={(e) => setForm({ ...form, length: e.target.value })} /></div>
          <div className="field"><label>Width</label><input type="number" step="any" value={form.width} onChange={(e) => setForm({ ...form, width: e.target.value })} /></div>
          <div className="field"><label>Conversion Factor</label><input type="number" step="0.000001" value={form.conversion_factor} onChange={(e) => setForm({ ...form, conversion_factor: e.target.value })} /></div>
        </div>

        <h3 className="subsection">Inventory Detail</h3>
        <div className="field-row">
          <div className="field field-checkbox">
            <input type="checkbox" id="is-length" checked={form.is_length_based} onChange={(e) => setForm({ ...form, is_length_based: e.target.checked })} />
            <label htmlFor="is-length">Priced by Length</label>
          </div>
          <div className="field field-checkbox">
            <input type="checkbox" id="is-width" checked={form.is_width_based} onChange={(e) => setForm({ ...form, is_width_based: e.target.checked })} />
            <label htmlFor="is-width">Priced by Width</label>
          </div>
          <div className="field"><label>Price Indicator</label><input type="number" step="0.01" value={form.price_indicator} onChange={(e) => setForm({ ...form, price_indicator: e.target.value })} /></div>
          <div className="field"><label>Tolerance %</label><input type="number" step="0.01" value={form.tolerance_pct} onChange={(e) => setForm({ ...form, tolerance_pct: e.target.value })} /></div>
        </div>

        <h3 className="subsection">Purchasing / Costing</h3>
        <div className="field-row">
          <div className="field"><label>Average Cost</label><input type="number" step="0.0001" value={form.average_cost} onChange={(e) => setForm({ ...form, average_cost: e.target.value })} /></div>
          <div className="field"><label>Last Purchase Price</label><input type="number" step="0.0001" value={form.last_purchase_price} onChange={(e) => setForm({ ...form, last_purchase_price: e.target.value })} /></div>
          <div className="field"><label>Last Purchase Date</label><input type="date" value={form.last_purchase_date} onChange={(e) => setForm({ ...form, last_purchase_date: e.target.value })} /></div>
        </div>

        <h3 className="subsection">Sales / Pricing</h3>
        <div className="xl-pricing-wrap">
          <table className="xl-pricing">
            <thead>
              <tr>
                <th colSpan={7} className="xl-blank" />
                <th colSpan={2} className="xl-blue">Disc. AC</th>
                <th colSpan={2} className="xl-blue">Disc. Supervisor</th>
                <th colSpan={2} className="xl-blue">Disc. Manager</th>
                <th colSpan={2} className="xl-blue">Disc. GM</th>
              </tr>
              <tr className="xl-orange">
                <th>Material Cost</th><th>Wastage Allowance %</th><th>Amount</th><th>Subtotal</th>
                <th>Markup %</th><th>Amount</th><th>Selling Price</th>
                <th>%</th><th>Amount</th><th>%</th><th>Amount</th><th>%</th><th>Amount</th><th>%</th><th>Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr className="xl-orange">
                <td>{cellInput('material_cost', '0.0001')}</td>
                <td>{cellInput('wastage_allowance_pct')}</td>
                <td>{xlNum(pricing.wastageAmt)}</td>
                <td>{xlNum(pricing.subtotal)}</td>
                <td>{cellInput('markup_pct')}</td>
                <td>{xlNum(pricing.markupAmt)}</td>
                <td className="xl-strong">{xlNum(pricing.sellingPrice)}</td>
                <td>{cellInput('disc_ceiling_pct')}</td><td>{xlNum(pricing.discAc)}</td>
                <td>{cellInput('disc_supervisor_pct')}</td><td>{xlNum(pricing.discSupervisor)}</td>
                <td>{cellInput('disc_manager_pct')}</td><td>{xlNum(pricing.discManager)}</td>
                <td>{cellInput('disc_gm_pct')}</td><td>{xlNum(pricing.discGm)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="field-row" style={{ marginTop: 12 }}>
          <div className="field"><label>Beg. Selling Price</label><input type="number" step="0.0001" value={form.beg_selling_price} onChange={(e) => setForm({ ...form, beg_selling_price: e.target.value })} /></div>
          <div className="field" />
          <div className="field" />
        </div>

        <h3 className="subsection">Accounting</h3>
        <div className="review-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <div className="field">
            <label>Expense Account</label>
            <EntityPicker
              label="Expense Account" items={accounts} value={form.expense_account_id} getLabel={accountLabel}
              columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }, { key: 'account_type', label: 'Type' }]}
              searchKeys={['account_code', 'account_name']}
              onSelect={(a) => setForm({ ...form, expense_account_id: a.id })}
              onClear={() => setForm({ ...form, expense_account_id: '' })}
            />
          </div>
          <div className="field">
            <label>COGS Account</label>
            <EntityPicker
              label="COGS Account" items={accounts} value={form.cogs_account_id} getLabel={accountLabel}
              columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }, { key: 'account_type', label: 'Type' }]}
              searchKeys={['account_code', 'account_name']}
              onSelect={(a) => setForm({ ...form, cogs_account_id: a.id })}
              onClear={() => setForm({ ...form, cogs_account_id: '' })}
            />
          </div>
          <div className="field">
            <label>Asset Account</label>
            <EntityPicker
              label="Asset Account" items={accounts} value={form.asset_account_id} getLabel={accountLabel}
              columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }, { key: 'account_type', label: 'Type' }]}
              searchKeys={['account_code', 'account_name']}
              onSelect={(a) => setForm({ ...form, asset_account_id: a.id })}
              onClear={() => setForm({ ...form, asset_account_id: '' })}
            />
          </div>
          <div className="field">
            <label>Income Account</label>
            <EntityPicker
              label="Income Account" items={accounts} value={form.income_account_id} getLabel={accountLabel}
              columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }, { key: 'account_type', label: 'Type' }]}
              searchKeys={['account_code', 'account_name']}
              onSelect={(a) => setForm({ ...form, income_account_id: a.id })}
              onClear={() => setForm({ ...form, income_account_id: '' })}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
