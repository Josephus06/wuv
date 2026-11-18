import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import DataTable from '../components/DataTable';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import { isBaseUnit } from '../utils/unitUsed';
import { displayMonth } from '../utils/dates';
import { lineDepartmentError } from '../utils/requireDepartment';

// Mirrors the real system's "Inventory Adjustments" Add/Edit form: the Adjustments
// section (Add Material / Upload Material) appears as soon as an Adjustment Account is
// picked, not after an explicit Save. Line items still need a parent adjustment id to
// snapshot Qty on Hand against, so selecting the account on a brand-new adjustment
// silently creates the draft header in the background (see handleSelectAccount).
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function accountLabel(a) { return a ? `${a.account_code} — ${a.account_name}` : ''; }

const STATUS_LABELS = {
  pending_approval: 'Pending Approval',
  approved: 'Approved',
  cancelled: 'Cancelled',
};

export default function InventoryAdjustmentEdit() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();

  const [form, setForm] = useState({ date_created: new Date().toISOString().slice(0, 10), adjustment_account_id: '', memo: '' });
  const [adjustment, setAdjustment] = useState(null);
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [accounts, setAccounts] = useState([]);
  const [inventoryItems, setInventoryItems] = useState([]);
  const [locations, setLocations] = useState([]);
  const [departments, setDepartments] = useState([]);

  useEffect(() => {
    Promise.all([
      api.get('/lookups/chart-of-accounts'),
      api.get('/inventory'),
      api.get('/lookups/locations'),
      api.get('/lookups/departments'),
      isNew ? Promise.resolve(null) : api.get(`/inventory-adjustments/${id}`),
    ]).then(([acctRes, invRes, locRes, deptRes, adjRes]) => {
      setAccounts(acctRes.data);
      setInventoryItems(invRes.data);
      setLocations(locRes.data);
      setDepartments(deptRes.data);
      if (adjRes) {
        setAdjustment(adjRes.data);
        setLines(adjRes.data.lines || []);
        setForm({
          date_created: adjRes.data.date_created ? String(adjRes.data.date_created).slice(0, 10) : '',
          adjustment_account_id: adjRes.data.adjustment_account_id || '',
          memo: adjRes.data.memo || '',
        });
      }
      setLoading(false);
    });
  }, [id, isNew]);

  const postingPeriod = form.date_created
    ? displayMonth(form.date_created)
    : '';

  async function handleSave() {
    setError('');
    // Every line needs a Department; the server refuses the Save (and Approve) otherwise.
    const deptError = lineDepartmentError(lines);
    if (deptError) { setError(deptError); return; }
    setSaving(true);
    try {
      // Save lands on the adjustment's own view, the way Transfer Order, Journal, Deposit and
      // Purchase Requisition all do. This form used to stay in the editor -- a new adjustment
      // went to its own /edit and an existing one just reloaded in place -- so the only sign a
      // save had worked was the spinner stopping, and approving it meant navigating there by
      // hand. Lines are posted as they are added, so there is nothing unsaved to lose.
      if (isNew) {
        const { data } = await api.post('/inventory-adjustments', form);
        navigate(`/inventory-adjustments/${data.id}`);
      } else {
        await api.put(`/inventory-adjustments/${id}`, form);
        navigate(`/inventory-adjustments/${id}`);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  // Mirrors the real form: picking an Adjustment Account on a brand-new adjustment
  // silently creates the draft header right away (no explicit Save needed first), so
  // the Add Material button can appear immediately -- matching the real system where
  // Add Material shows up as soon as the account is set.
  async function handleSelectAccount(account) {
    setForm((f) => ({ ...f, adjustment_account_id: account.id }));
    if (isNew && !adjustment) {
      setSaving(true);
      setError('');
      try {
        const { data } = await api.post('/inventory-adjustments', { ...form, adjustment_account_id: account.id });
        setAdjustment(data);
        navigate(`/inventory-adjustments/${data.id}/edit`, { replace: true });
      } catch (err) {
        setError(err.response?.data?.error || 'Save failed');
      } finally {
        setSaving(false);
      }
    }
  }

  async function addLine(itemId) {
    const targetId = adjustment?.id;
    if (!targetId) return;
    const { data } = await api.post(`/inventory-adjustments/${targetId}/lines`, { item_id: itemId });
    setLines((prev) => [...prev, data]);
    const { data: adj } = await api.get(`/inventory-adjustments/${targetId}`);
    setAdjustment(adj);
  }

  // Sends only the changed field(s), not a full merged snapshot of the row -- so two
  // edits to the same line fired close together (e.g. toggling Unit Used right before
  // blurring Adjust Qty By) can never clobber each other with stale values for fields
  // neither request meant to touch. The backend fills in anything not present in the
  // request from what's already saved.
  async function commitLine(lineId, overrides = {}) {
    const { data } = await api.put(`/inventory-adjustments/${id}/lines/${lineId}`, overrides);
    setLines((prev) => prev.map((l) => (l.id === lineId ? { ...l, ...data } : l)));
    const { data: adj } = await api.get(`/inventory-adjustments/${id}`);
    setAdjustment(adj);
  }

  async function removeLine(lineId) {
    if (!confirm('Remove this line?')) return;
    await api.delete(`/inventory-adjustments/${id}/lines/${lineId}`);
    setLines((prev) => prev.filter((l) => l.id !== lineId));
    const { data: adj } = await api.get(`/inventory-adjustments/${id}`);
    setAdjustment(adj);
  }

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="page-header">
        <h1>{isNew ? 'Add Inventory Adjustment' : `Inventory Adjustment — ${adjustment?.adjustment_no}`}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn" to={isNew ? '/inventory-adjustments' : `/inventory-adjustments/${id}`}>Back to Lists</Link>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>
        </div>
      </div>

      {!isNew && adjustment && <p className="muted" style={{ marginTop: -8 }}>{STATUS_LABELS[adjustment.status] || adjustment.status}</p>}

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="field">
            <label>Date Created</label>
            <input type="date" value={form.date_created} onChange={(e) => setForm({ ...form, date_created: e.target.value })} />
          </div>
          <div className="field">
            <label>Posting Period</label>
            <input readOnly tabIndex={-1} value={postingPeriod} />
          </div>
          <div className="field">
            <label>Adjustment Account</label>
            <EntityPicker
              label="Adjustment Account" items={accounts} value={form.adjustment_account_id} getLabel={accountLabel}
              columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }, { key: 'account_type', label: 'Type' }]}
              searchKeys={['account_code', 'account_name']}
              onSelect={handleSelectAccount}
            />
          </div>
          <div className="field" style={{ gridColumn: 'span 2' }}>
            <label>Memo</label>
            <input value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} />
          </div>
          <div className="field">
            <label>Estimated Total Value</label>
            <input readOnly tabIndex={-1} value={money(adjustment?.estimated_total_value ?? 0)} />
          </div>
        </div>
      </div>

      {form.adjustment_account_id && (
        <div className="card" style={{ marginTop: 20 }}>
          <h3 className="subsection" style={{ marginTop: 0 }}>Adjustments</h3>
          <DataTable
            columns={[
              { key: 'item_code', label: 'Item Code', render: (l) => `${l.item_code || ''} ${l.item_name ? `— ${l.item_name}` : ''}` },
              {
                key: 'location_name', label: 'Location',
                render: (l) => (
                  <EntityPicker
                    label="Location" items={locations} value={l.location_id} getLabel={(loc) => loc.location_name}
                    columns={[{ key: 'location_name', label: 'Name' }, { key: 'location_code', label: 'Code' }]}
                    searchKeys={['location_name', 'location_code']}
                    placeholder="Select Location"
                    // An approved line's stock has already landed there: to move it, delete the line
                    // and add it again (the server refuses the change too).
                    disabled={adjustment?.status === 'approved' && !!l.location_id}
                    onSelect={(loc) => commitLine(l.id, { location_id: loc.id })}
                  />
                ),
              },
              {
                key: 'department_name', label: 'Department *',
                render: (l) => (
                  <EntityPicker
                    label="Department" items={departments} value={l.department_id} getLabel={(d) => d.name}
                    columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']}
                    placeholder="Select Department"
                    onSelect={(d) => commitLine(l.id, { department_id: d.id })}
                  />
                ),
              },
              { key: 'qty_on_hand', label: 'Qty on Hand' },
              {
                key: 'unit_used', label: 'Unit Used',
                render: (l) => (
                  // Normalised, because a migrated line stores 'StockUnit'/'BaseUnit' and neither
                  // matches an option value -- so a base-unit adjustment opened here showed
                  // "Stock Unit", and saving any other field would have committed that back.
                  <select defaultValue={isBaseUnit(l.unit_used) ? 'base' : 'stock'} onChange={(e) => commitLine(l.id, { unit_used: e.target.value })}>
                    <option value="stock">Stock Unit</option>
                    <option value="base">Base Unit</option>
                  </select>
                ),
              },
              { key: 'uom_title', label: 'UOM' },
              { key: 'unit', label: 'Unit' },
              { key: 'current_value', label: 'Current Value', render: (l) => money(l.current_value) },
              {
                key: 'adjust_qty_by', label: 'Adjust Qty. By',
                render: (l) => (
                  <input
                    type="number" step="0.0001" style={{ width: 90 }}
                    defaultValue={l.adjust_qty_by}
                    onBlur={(e) => commitLine(l.id, { adjust_qty_by: e.target.value })}
                  />
                ),
              },
              { key: 'new_qty', label: 'New Qty' },
              { key: 'est_unit_cost', label: 'Est. Unit Cost', render: (l) => money(l.est_unit_cost) },
              { key: 'est_unit_cost_base', label: 'Est. Unit Cost (Base)', render: (l) => money(l.est_unit_cost_base) },
              {
                key: 'memo', label: 'Memo',
                render: (l) => (
                  <input
                    style={{ width: 120 }}
                    defaultValue={l.memo || ''}
                    onBlur={(e) => commitLine(l.id, { memo: e.target.value })}
                  />
                ),
              },
            ]}
            rows={lines}
            actions={(l) => <button className="btn btn-sm btn-danger" onClick={() => removeLine(l.id)}>Remove</button>}
            emptyLabel="No adjustment lines yet."
          />

          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            <EntityPicker
              label="Item" items={inventoryItems} value="" getLabel={(i) => i.display_name}
              columns={[{ key: 'item_code', label: 'Code' }, { key: 'display_name', label: 'Name' }]}
              searchKeys={['item_code', 'display_name']}
              onSelect={(i) => addLine(i.id)}
              triggerLabel="Add Material"
              triggerClassName="btn btn-primary"
              disabled={!adjustment}
            />
            <button type="button" className="btn btn-primary" disabled title="Bulk material upload isn't available in this build yet.">
              Upload Material
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
