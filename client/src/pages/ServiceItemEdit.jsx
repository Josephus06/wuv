import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

// Create/Edit for Master Lists > Service Items, laid out like the source's SERVICE screen (asked
// 2026-10-19: Add New opened the Inventory Item form). Left: Item Code, Item Description, Purchase /
// Sales Unit and the With JO / PO / JO flags; right: Purchase and Sales Description; then the tabs.
// A service has no stock, so there is no category, unit title, conversion or reorder point.
//
// Same `inventories` row as any item, saved through /inventory always as item_type 'Service' (see
// NonInventoryEdit.jsx). base_unit_id is required on that table, so it follows the Sales Unit (else
// the Purchase Unit) -- the service's own unit.
const EMPTY = {
  item_code: '', display_name: '', purchase_description: '', sales_description: '',
  base_unit_id: '', purchase_unit_id: '', stock_unit_id: '', sales_unit_id: '',
  is_with_jo: false, is_po: false, is_jo: false,
  selling_price: '', beg_selling_price: '',
  expense_account_id: '', asset_account_id: '', income_account_id: '', cogs_account_id: '',
  // Carried through untouched so a PUT doesn't blank what the record already holds.
  is_active: true, category_id: '', conversion_factor: 1, reorder_point: 0,
  last_purchase_price: '', last_purchase_date: '', average_cost: '', material_cost: '',
};

const TABS = [
  ['purchasing', 'Purchasing / Inventory'], ['pricing', 'Sales / Pricing'], ['accounting', 'Accounting'],
  ['related', 'Related Records'], ['system', 'System Information'], ['uom', 'Unit of Measures'], ['suppliers', 'Supplier Prices'],
];
const VIEW_ONLY_TABS = ['related', 'system', 'uom', 'suppliers'];

function accountLabel(a) { return a ? `${a.account_code} — ${a.account_name}` : ''; }
function unitLabel(u) { return u ? `${u.title} (${u.code})` : ''; }
function money(v) {
  if (v === null || v === undefined || v === '') return '';
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const UNIT_COLUMNS = [{ key: 'title', label: 'Title' }, { key: 'code', label: 'Code' }];
const ACCOUNT_COLUMNS = [{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }, { key: 'account_type', label: 'Type' }];

export default function ServiceItemEdit() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();

  const [form, setForm] = useState(EMPTY);
  const [tab, setTab] = useState('purchasing');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [units, setUnits] = useState([]);
  const [accounts, setAccounts] = useState([]);

  useEffect(() => {
    Promise.all([
      api.get('/lookups/units-of-measure'),
      api.get('/lookups/chart-of-accounts'),
      isNew ? Promise.resolve(null) : api.get(`/inventory/${id}`),
    ]).then(([unitRes, acctRes, itemRes]) => {
      setUnits(unitRes.data);
      setAccounts(acctRes.data);
      if (itemRes) {
        const d = itemRes.data;
        const next = { ...EMPTY };
        Object.keys(EMPTY).forEach((k) => {
          if (d[k] === null || d[k] === undefined) return;
          next[k] = typeof EMPTY[k] === 'boolean' ? !!d[k] : d[k];
        });
        next.last_purchase_date = d.last_purchase_date ? String(d.last_purchase_date).slice(0, 10) : '';
        setForm(next);
      }
      setLoading(false);
    }).catch((e) => { setError(e.response?.data?.error || 'Failed to load.'); setLoading(false); });
  }, [id, isNew]);

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  async function handleSave() {
    if (!form.item_code.trim()) { setError('Item Code is required.'); return; }
    if (!form.display_name.trim()) { setError('Item Description is required.'); return; }
    if (!form.purchase_unit_id && !form.sales_unit_id) { setError('Choose a Purchase Unit or a Sales Unit.'); return; }
    setSaving(true);
    setError('');
    const unit = form.sales_unit_id || form.purchase_unit_id;
    const payload = {
      ...form, item_type: 'Service',
      base_unit_id: unit, stock_unit_id: form.stock_unit_id || unit,
      purchase_unit_id: form.purchase_unit_id || unit, sales_unit_id: form.sales_unit_id || unit,
    };
    ['category_id', 'expense_account_id', 'asset_account_id', 'income_account_id', 'cogs_account_id']
      .forEach((k) => { payload[k] = payload[k] || null; });
    ['last_purchase_price', 'last_purchase_date', 'average_cost', 'material_cost', 'selling_price', 'beg_selling_price']
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

  function unitPicker(key, label) {
    return (
      <div className="field">
        <label>{label}</label>
        <EntityPicker
          label={label} items={units} value={form[key]} getLabel={unitLabel}
          columns={UNIT_COLUMNS} searchKeys={['title', 'code']}
          onSelect={(u) => setForm({ ...form, [key]: u.id })}
          onClear={() => setForm({ ...form, [key]: '' })}
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
        <input type="checkbox" id={`svc-${key}`} checked={form[key]} onChange={set(key)} />
        <label htmlFor={`svc-${key}`}>{label}</label>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1>Service Items <span className="muted" style={{ fontSize: '0.6em', fontWeight: 400 }}>{isNew ? 'Create' : form.item_code}</span></h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn" to={isNew ? '/service-items' : `/inventory/${id}`}>Cancel</Link>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20 }}>
          <div>
            <div className="field"><label>Item Code</label><input required value={form.item_code} onChange={set('item_code')} /></div>
            <div className="field"><label>Item Description</label><textarea rows={4} value={form.display_name} onChange={set('display_name')} /></div>
            <div className="review-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
              {unitPicker('purchase_unit_id', 'Purchase Unit')}
              {unitPicker('sales_unit_id', 'Sales Unit')}
            </div>
            <div className="field-row" style={{ marginTop: 12 }}>
              {checkbox('is_with_jo', 'With JO')}
              {checkbox('is_po', 'PO')}
              {checkbox('is_jo', 'JO')}
            </div>
          </div>

          <div>
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
            <div>
              <div>Last Purchase Price : <span className="hi">{money(form.last_purchase_price)}</span></div>
              <div>Total Value : <span className="hi" /></div>
              <div>Average Cost : <span className="hi">{money(form.average_cost)}</span></div>
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
