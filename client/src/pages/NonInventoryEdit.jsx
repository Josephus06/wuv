import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

// Create/Edit for Master Lists > Non-Inventories, laid out like the source's NONINVTY screen
// rather than the Inventory one: identity, units and flags on the left, the three descriptions on
// the right, then the tab strip. Same `inventories` row as an Inventory item (see NonInventories.jsx),
// so it saves through /inventory, always as item_type 'Non-Inventory' -- which is what keeps it out
// of the Costing / Accounting approval queues (routes/inventories.js NON_STOCK_SQL): on the source a
// Non-Inventory item is simply Approved the moment it is saved.
//
// Item Description is display_name. Unit Title picks the item's unit and fills the Base / Purchase
// / Stock / Sales units from it; each can still be changed where they differ.
const CONVERSION_TYPES = ['LINEAR', 'AREA'];

const EMPTY = {
  item_code: '', display_name: '', purchase_description: '', sales_description: '',
  category_id: '', base_unit_id: '', purchase_unit_id: '', stock_unit_id: '', sales_unit_id: '',
  length: '', width: '', conversion_type: '', conversion_factor: 1,
  is_office_supply: false, is_to_item: false, is_with_jo: false, is_po: false, is_jo: false,
  can_be_received: false,
  is_length_based: false, is_width_based: false, price_indicator: 0, tolerance_pct: 0, reorder_point: 0,
  selling_price: '', beg_selling_price: '',
  expense_account_id: '', asset_account_id: '', income_account_id: '', cogs_account_id: '',
  // Carried through untouched so a PUT doesn't blank what the record already holds.
  is_active: true, to_type: '', last_purchase_price: '', last_purchase_date: '', average_cost: '',
  material_cost: '', wastage_allowance_pct: 0, markup_pct: 0,
  disc_ceiling_pct: 0, disc_supervisor_pct: 0, disc_manager_pct: 0, disc_gm_pct: 0,
};

const TABS = [
  ['purchasing', 'Purchasing / Inventory'], ['detail', 'Inventory Detail'], ['pricing', 'Sales / Pricing'],
  ['accounting', 'Accounting'], ['related', 'Related Records'], ['system', 'System Information'],
  ['uom', 'Unit of Measures'], ['stocks', 'Warehouse Stocks'], ['suppliers', 'Supplier Prices'],
];
// Tabs that list what other documents and screens attach to the item, not fields of it.
const VIEW_ONLY_TABS = ['related', 'system', 'uom', 'stocks', 'suppliers'];

function accountLabel(a) { return a ? `${a.account_code} — ${a.account_name}` : ''; }
function unitLabel(u) { return u ? `${u.title} (${u.code})` : ''; }
function money(v) {
  if (v === null || v === undefined || v === '') return '';
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const UNIT_COLUMNS = [{ key: 'title', label: 'Title' }, { key: 'code', label: 'Code' }];
const ACCOUNT_COLUMNS = [{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }, { key: 'account_type', label: 'Type' }];

export default function NonInventoryEdit() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();

  const [form, setForm] = useState(EMPTY);
  const [item, setItem] = useState(null);
  const [tab, setTab] = useState('purchasing');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [categories, setCategories] = useState([]);
  const [units, setUnits] = useState([]);
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
        const d = itemRes.data;
        setItem(d);
        const next = { ...EMPTY };
        Object.keys(EMPTY).forEach((k) => {
          if (d[k] === null || d[k] === undefined) return;
          next[k] = typeof EMPTY[k] === 'boolean' ? !!d[k] : d[k];
        });
        next.last_purchase_date = d.last_purchase_date ? String(d.last_purchase_date).slice(0, 10) : '';
        setForm(next);
      }
      setLoading(false);
    });
  }, [id, isNew]);

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  function pickUnitTitle(u) {
    // Fill the other three from the unit title only where they are empty or were tracking the old
    // base unit -- a deliberately different purchase unit (Box vs Piece) is left alone.
    const follow = (k) => (!form[k] || String(form[k]) === String(form.base_unit_id) ? u.id : form[k]);
    setForm({
      ...form, base_unit_id: u.id,
      purchase_unit_id: follow('purchase_unit_id'), stock_unit_id: follow('stock_unit_id'), sales_unit_id: follow('sales_unit_id'),
    });
  }

  async function handleSave() {
    if (!form.item_code.trim()) { setError('Item Code is required.'); return; }
    if (!form.display_name.trim()) { setError('Item Description is required.'); return; }
    if (!form.base_unit_id) { setError('Unit Title is required.'); return; }
    if (form.conversion_type && !(Number(form.length) > 0)) { setError(`Length is required for a ${form.conversion_type} conversion.`); return; }
    if (form.conversion_type === 'AREA' && !(Number(form.width) > 0)) { setError('Width is required for an AREA conversion.'); return; }
    setSaving(true);
    setError('');
    const payload = { ...form, item_type: 'Non-Inventory' };
    ['category_id', 'base_unit_id', 'purchase_unit_id', 'stock_unit_id', 'sales_unit_id', 'expense_account_id', 'asset_account_id', 'income_account_id', 'cogs_account_id', 'conversion_type']
      .forEach((k) => { payload[k] = payload[k] || null; });
    ['length', 'width', 'last_purchase_price', 'last_purchase_date', 'average_cost', 'material_cost', 'selling_price', 'beg_selling_price']
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

  const totalQty = (item?.stock_by_location || []).reduce((s, r) => s + Number(r.qty_on_hand || 0), 0);
  const totalValue = item && item.average_cost !== null ? totalQty * Number(item.average_cost) : null;

  function unitPicker(key, label) {
    return (
      <div className="field">
        <label>{label}</label>
        <EntityPicker
          label={label} items={units} value={form[key]} getLabel={unitLabel}
          columns={UNIT_COLUMNS} searchKeys={['title', 'code']}
          onSelect={(u) => setForm({ ...form, [key]: u.id })}
        />
      </div>
    );
  }
  function accountPicker(key, label) {
    return (
      <div className="field">
        <label>{label}</label>
        <EntityPicker
          label={label} items={accounts} value={form[key]} getLabel={accountLabel}
          columns={ACCOUNT_COLUMNS} searchKeys={['account_code', 'account_name']}
          onSelect={(a) => setForm({ ...form, [key]: a.id })}
          onClear={() => setForm({ ...form, [key]: '' })}
        />
      </div>
    );
  }
  function checkbox(key, label) {
    return (
      <div className="field field-checkbox">
        <input type="checkbox" id={`ni-${key}`} checked={form[key]} onChange={set(key)} />
        <label htmlFor={`ni-${key}`}>{label}</label>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1>Non-Inventory <span className="muted" style={{ fontSize: '0.6em', fontWeight: 400 }}>{isNew ? 'Create' : form.item_code}</span></h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn" to={isNew ? '/non-inventories' : `/inventory/${id}`}>Cancel</Link>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20 }}>
          <div>
            <div className="field"><label>Item Code</label><input required value={form.item_code} onChange={set('item_code')} /></div>
            <div className="field">
              <label>Category</label>
              <EntityPicker
                label="Category" items={categories} value={form.category_id} getLabel={(c) => c.name}
                columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']}
                onSelect={(c) => setForm({ ...form, category_id: c.id })}
              />
            </div>
            <div className="field">
              <label>Unit Title</label>
              <EntityPicker
                label="Unit Title" items={units} value={form.base_unit_id} getLabel={unitLabel}
                columns={UNIT_COLUMNS} searchKeys={['title', 'code']} onSelect={pickUnitTitle}
              />
            </div>
            <div className="review-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
              {unitPicker('base_unit_id', 'Base Unit')}
              {unitPicker('purchase_unit_id', 'Purchase Unit')}
              {unitPicker('stock_unit_id', 'Stock Unit')}
              {unitPicker('sales_unit_id', 'Sales Unit')}
            </div>
            <div className="review-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', alignItems: 'end' }}>
              <div className="field"><label>Length{form.conversion_type ? ' *' : ''}</label><input type="number" step="0.0001" value={form.length} onChange={set('length')} /></div>
              <div className="field">
                <label>Width{form.conversion_type === 'AREA' ? ' *' : ''}</label>
                <input type="number" step="0.0001" value={form.width} onChange={set('width')} disabled={form.conversion_type === 'LINEAR'} />
              </div>
              <div className="field">
                <label>Conversion Type</label>
                {/* LINEAR converts by Length alone, so Width is cleared and locked; AREA needs both
                    (Length x Width). Left unselected, neither is required. */}
                <select
                  value={form.conversion_type || ''}
                  onChange={(e) => setForm({ ...form, conversion_type: e.target.value, width: e.target.value === 'LINEAR' ? '' : form.width })}
                >
                  <option value="">--Select--</option>
                  {CONVERSION_TYPES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </div>
              {checkbox('is_office_supply', 'Office Supply Requisition')}
              {checkbox('is_to_item', 'TO')}
            </div>
            {form.conversion_type === 'AREA' && (
              <div className="muted" style={{ marginTop: 6 }}>
                Area (L x W) : <span className="hi">{(Number(form.length) || 0) * (Number(form.width) || 0)}</span>
              </div>
            )}
            <div className="field-row" style={{ marginTop: 12 }}>
              {checkbox('is_with_jo', 'With JO')}
              {checkbox('is_po', 'PO')}
            </div>
          </div>

          <div>
            <div className="field"><label>Item Description</label><textarea rows={4} value={form.display_name} onChange={set('display_name')} /></div>
            <div className="field"><label>Purchase Description</label><textarea rows={4} value={form.purchase_description} onChange={set('purchase_description')} /></div>
            <div className="field"><label>Sales Description</label><textarea rows={4} value={form.sales_description} onChange={set('sales_description')} /></div>
          </div>
        </div>

        <div className="status-tabs" style={{ marginTop: 20 }}>
          {TABS.map(([key, label]) => (
            <button key={key} type="button" className={`status-tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>{label}</button>
          ))}
        </div>

        <div style={{ paddingTop: 16 }}>
          {tab === 'purchasing' && (
            <div className="review-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
              <div>
                <div>Last Purchase Price : <span className="hi">{money(form.last_purchase_price)}</span></div>
                <div>Total Value : <span className="hi">{money(totalValue)}</span></div>
                <div>Average Cost : <span className="hi">{money(form.average_cost)}</span></div>
              </div>
              {checkbox('can_be_received', 'Can be Received')}
            </div>
          )}

          {tab === 'detail' && (
            <div className="field-row">
              {checkbox('is_length_based', 'Priced by Length')}
              {checkbox('is_width_based', 'Priced by Width')}
              <div className="field"><label>Conversion Factor</label><input type="number" step="0.000001" value={form.conversion_factor} onChange={set('conversion_factor')} /></div>
              <div className="field"><label>Reorder Point</label><input type="number" step="0.0001" value={form.reorder_point} onChange={set('reorder_point')} /></div>
            </div>
          )}

          {tab === 'pricing' && (
            <div className="field-row">
              <div className="field"><label>Selling Price</label><input type="number" step="0.0001" value={form.selling_price} onChange={set('selling_price')} /></div>
              <div className="field"><label>Beg. Selling Price</label><input type="number" step="0.0001" value={form.beg_selling_price} onChange={set('beg_selling_price')} /></div>
              <div className="field" />
            </div>
          )}

          {tab === 'accounting' && (
            <div className="review-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              {accountPicker('expense_account_id', 'Expense Account')}
              {accountPicker('cogs_account_id', 'COGS Account')}
              {accountPicker('asset_account_id', 'Asset Account')}
              {accountPicker('income_account_id', 'Income Account')}
            </div>
          )}

          {VIEW_ONLY_TABS.includes(tab) && (
            <p className="muted" style={{ margin: 0 }}>
              {isNew
                ? 'Available once the item is saved.'
                : <>Shown on the <Link to={`/inventory/${id}`}>item&apos;s page</Link>.</>}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
