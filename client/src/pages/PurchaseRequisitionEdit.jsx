import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import DataTable from '../components/DataTable';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import { useAuth } from '../context/useAuth';
import { useItemBalances, balanceColumns } from '../utils/itemBalances';
import { headerDepartmentError } from '../utils/requireDepartment';

function departmentLabel(d) { return d ? d.name : ''; }
function employeeLabel(e) { return e ? `${e.first_name} ${e.last_name}` : ''; }

// Mirrors the real "Purchase Requisition" create/edit form -- a single form + one Save,
// unlike Transfer Order's inline-persist-per-line pattern. "Add Material" just adds a
// row to local state; nothing hits the server until Save.
export default function PurchaseRequisitionEdit() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id;
  const { user } = useAuth();

  const [form, setForm] = useState({
    date_created: new Date().toISOString().slice(0, 10), date_needed: '',
    department_id: '', requestor_id: '', memo: '',
  });
  const [lines, setLines] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [locations, setLocations] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [inventoryItems, setInventoryItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Warehouse - Central, the warehouse nearly everything moves through and the one a buyer is
  // asking about when they check whether something needs ordering. Named in the column headers so
  // the figure is never unattributed, and resolved by name because the installs number their
  // locations differently.
  const balanceLocation = locations.find(
    (l) => String(l.location_name || '').trim().toLowerCase() === 'warehouse - central',
  ) || null;
  const { balances: pickerBalances, load: loadPickerBalances } = useItemBalances(balanceLocation?.id ?? null);

  useEffect(() => {
    Promise.all([
      api.get('/lookups/locations'),
      api.get('/lookups/departments'),
      api.get('/purchase-requisitions/requestors'),
      api.get('/inventory'),
      isNew ? Promise.resolve(null) : api.get(`/purchase-requisitions/${id}`),
    ]).then(([locRes, deptRes, empRes, invRes, prRes]) => {
      setLocations(locRes.data);
      setDepartments(deptRes.data);
      setEmployees(empRes.data);
      setInventoryItems(invRes.data);

      if (prRes) {
        const pr = prRes.data;
        setForm({
          date_created: pr.date_created ? String(pr.date_created).slice(0, 10) : '',
          date_needed: pr.date_needed ? String(pr.date_needed).slice(0, 10) : '',
          department_id: pr.department_id || '',
          requestor_id: pr.requestor_id || '',
          memo: pr.memo || '',
        });
        setLines((pr.lines || []).map((l) => ({ ...l, _key: l.id })));
      } else {
        // Defaults for a NEW requisition only -- an existing one keeps whatever it was saved
        // with, including a deliberately empty field.
        //
        // Requested From is matched by NAME rather than a hardcoded id, because the installs
        // number their departments differently; if it is ever renamed the field simply starts
        // empty, which is what it did before.
        //
        // Requestor is whoever is filling the form in. users.employee_id is the link -- the
        // picker lists employees, and the session carries that id from /auth/me -- so a user
        // with no employee record behind them falls back to an empty field rather than a guess.
        const supplyChain = (deptRes.data || []).find(
          (d) => String(d.name || '').trim().toLowerCase() === 'supply chain',
        );
        const me = (empRes.data || []).find((e) => String(e.id) === String(user?.employee_id));
        setForm((f) => ({
          ...f,
          department_id: supplyChain?.id || '',
          requestor_id: me?.id || '',
        }));
      }
      setLoading(false);
    });
  }, [id, isNew, user?.employee_id]);

  function addLine(item) {
    setLines((prev) => [...prev, {
      _key: `new-${Date.now()}`,
      item_id: item.id, item_code: item.item_code, item_name: item.display_name,
      purchase_description: item.display_name, job_order_id: null, job_order_no: '',
      // Was hardcoded to 0, so the Qty on Hand column read 0.00 for every material however much
      // was on the shelf. Taken from the balance the picker has just shown, in STOCK units so it
      // matches the Qty beside it -- a buyer comparing "have 3, need 2" should not be reading one
      // in rolls and the other in square feet. Falls back to 0 only if the balance never loaded.
      qty_on_hand: Number(pickerBalances[item.id]?.balance_stock ?? 0),
      qty: 1,
      // Purchase Unit is the unit the Qty is ORDERED in, so it comes from the item's Purchase
      // Unit -- ROLL for a tarpaulin held in square feet. It used to copy the base unit title,
      // which read "Square Foot" against an item bought by the roll and only looked right on the
      // items whose purchase and base units happen to be the same thing. Purchase Order receiving
      // scales this quantity by conversion_factor precisely because it is in purchase units.
      purchase_unit: item.purchase_unit_title || item.base_unit_title || '',
      // Unit Title stays the BASE unit: what the order converts into once received.
      unit_title: item.base_unit_title || '',
    }]);
  }

  // JO # picker (2026-10-14): Job Orders searched on the server as the user types (lib: routes/purchaseRequisitions.js).
  const [jobOptions, setJobOptions] = useState([]);
  function searchJobs(text) {
    api.get('/purchase-requisitions/job-orders', { params: { q: (text || '').trim() } })
      .then(({ data }) => setJobOptions(Array.isArray(data) ? data : []))
      .catch(() => {});
  }

  function updateLine(key, patch) {
    setLines((prev) => prev.map((l) => (l._key === key ? { ...l, ...patch } : l)));
  }

  function removeLine(key) {
    setLines((prev) => prev.filter((l) => l._key !== key));
  }

  async function handleSave() {
    setError('');
    const deptError = headerDepartmentError(form.department_id);
    if (deptError) { setError(deptError); return; }
    if (!lines.length) { setError('Add at least one material.'); return; }
    setSaving(true);
    try {
      const payload = {
        ...form,
        lines: lines.map((l) => ({
          id: l.id || undefined, item_id: l.item_id, purchase_description: l.purchase_description, job_order_id: l.job_order_id || null,
          qty: l.qty, purchase_unit: l.purchase_unit, unit_title: l.unit_title,
        })),
      };
      if (isNew) {
        const { data } = await api.post('/purchase-requisitions', payload);
        navigate(`/purchase-requisitions/${data.id}`);
      } else {
        await api.put(`/purchase-requisitions/${id}`, payload);
        navigate(`/purchase-requisitions/${id}`);
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
        <h1>Purchase Requisition</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn" to={isNew ? '/purchase-requisitions' : `/purchase-requisitions/${id}`}>Back to Lists</Link>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <div className="field">
            <label>Date Created</label>
            <input type="date" value={form.date_created} onChange={(e) => setForm({ ...form, date_created: e.target.value })} />
          </div>
          <div className="field">
            <label>Date Needed</label>
            <input type="date" value={form.date_needed} onChange={(e) => setForm({ ...form, date_needed: e.target.value })} />
          </div>
          <div className="field">
            <label>Requested From *</label>
            <EntityPicker
              label="Department" items={departments} value={form.department_id} getLabel={departmentLabel}
              columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']}
              onSelect={(d) => setForm({ ...form, department_id: d.id })}
            />
          </div>
          <div className="field">
            <label>Memo</label>
            <textarea rows={2} value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} />
          </div>
          <div className="field">
            <label>Requestor</label>
            <EntityPicker
              label="Requestor" items={employees} value={form.requestor_id} getLabel={employeeLabel}
              columns={[{ key: 'name', label: 'Name', render: employeeLabel }, { key: 'position_title', label: 'Position' }]}
              searchKeys={['first_name', 'last_name']}
              onSelect={(e) => setForm({ ...form, requestor_id: e.id })}
            />
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h3 className="subsection" style={{ marginTop: 0 }}>Materials</h3>
        <DataTable
          columns={[
            { key: 'item', label: 'Item', render: (l) => `${l.item_code || ''} — ${l.item_name || ''}` },
            {
              key: 'purchase_description', label: 'Purchase Description',
              render: (l) => <input style={{ width: 180 }} defaultValue={l.purchase_description} onBlur={(e) => updateLine(l._key, { purchase_description: e.target.value })} />,
            },
            {
              key: 'job_order_no', label: 'JO #',
              render: (l) => (
                <EntityPicker
                  label="Job Order"
                  items={l.job_order_id && !jobOptions.some((j) => j.id === l.job_order_id)
                    ? [{ id: l.job_order_id, job_order_no: l.job_order_no }, ...jobOptions] : jobOptions}
                  value={l.job_order_id || ''}
                  getLabel={(j) => j.job_order_no}
                  columns={[
                    { key: 'job_order_no', label: 'JO #' },
                    { key: 'customer_name', label: 'Customer' },
                    { key: 'description', label: 'Description' },
                    { key: 'status', label: 'Status' },
                  ]}
                  searchKeys={['job_order_no', 'customer_name', 'description']}
                  placeholder="Select JO"
                  onSearch={searchJobs}
                  onSelect={(j) => updateLine(l._key, { job_order_id: j.id, job_order_no: j.job_order_no })}
                  onClear={() => updateLine(l._key, { job_order_id: null, job_order_no: '' })}
                />
              ),
            },
            { key: 'qty_on_hand', label: 'Qty on Hand', render: (l) => Number(l.qty_on_hand || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
            {
              key: 'qty', label: 'Qty',
              // A line already on a Purchase Order cannot go below what is ordered (the server enforces it too).
              render: (l) => <input type="number" step="0.0001" min={Number(l.po_qty || 0) || undefined} style={{ width: 90 }} defaultValue={l.qty} onBlur={(e) => updateLine(l._key, { qty: e.target.value })} />,
            },
            {
              key: 'purchase_unit', label: 'Purchase Unit',
              render: (l) => <input style={{ width: 90 }} defaultValue={l.purchase_unit} onBlur={(e) => updateLine(l._key, { purchase_unit: e.target.value })} />,
            },
            { key: 'unit_title', label: 'Unit Title' },
            ...(isNew ? [] : [{ key: 'po_qty', label: 'PO Qty', render: (l) => Number(l.po_qty || 0) }]),
          ]}
          rows={lines}
          actions={(l) => (Number(l.po_qty || 0) > 0
            ? <span className="muted" title="Already on a Purchase Order">On PO</span>
            : <button className="btn btn-sm btn-danger" onClick={() => removeLine(l._key)}>Delete</button>)}
          emptyLabel="No materials yet."
        />

        <div style={{ marginTop: 10 }}>
          <EntityPicker
            label="Item" items={inventoryItems} value="" getLabel={(i) => i.display_name}
            columns={[
              { key: 'item_code', label: 'Code' },
              { key: 'display_name', label: 'Name' },
              ...balanceColumns(pickerBalances, balanceLocation?.location_name),
            ]}
            searchKeys={['item_code', 'display_name']}
            onSelect={addLine}
            onVisibleItems={loadPickerBalances}
            triggerLabel="Add Material"
            triggerClassName="btn btn-primary"
          />
        </div>
      </div>
    </div>
  );
}
