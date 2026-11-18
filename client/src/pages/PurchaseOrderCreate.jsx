import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import { parseDiscountChain, discountLabel } from '../utils/discountChain';
import { lineDepartmentError } from '../utils/requireDepartment';

// The PO-3 Job Order picker: job orders proper, not RWIP rework orders, newest first. There are
// 124k of them, so the picker opens on the newest 100 and searches the server as you type.
const JO_PICKER_PARAMS = { limit: 100, exclude_rwip: '1' };

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

// Mirrors the real standalone "Purchase Order > Create" form (reached without going
// through a Purchase Requisition) -- the PO Category choice decides whether lines can
// carry a Job Order (PO-3) or not (PO-4).
// Rounded to the centavo at each step, exactly as the server does (routes/purchaseOrders.js cents).
const cents = (n) => Math.round(Number((Number(n) * 100).toFixed(6))) / 100;

export default function PurchaseOrderCreate() {
  const navigate = useNavigate();
  const [suppliers, setSuppliers] = useState([]);
  const [terms, setTerms] = useState([]);
  const [taxes, setTaxes] = useState([]);
  const [locations, setLocations] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [jobOrders, setJobOrders] = useState([]);
  // Job orders already chosen on a line, kept so each line still shows its JO # after a search
  // has replaced the picker's list.
  const [pickedJobOrders, setPickedJobOrders] = useState([]);
  function rememberJobOrder(jo) {
    setPickedJobOrders((prev) => (prev.some((x) => x.id === jo.id) ? prev : [...prev, jo]));
  }
  async function searchJobOrders(term) {
    try {
      const { data } = await api.get('/job-orders', { params: { ...JO_PICKER_PARAMS, search: term || undefined } });
      setJobOrders(data.rows || []);
    } catch { /* keep the list already shown */ }
  }
  const jobOrderChoices = [...pickedJobOrders, ...jobOrders.filter((jo) => !pickedJobOrders.some((x) => x.id === jo.id))];
  const [serviceItems, setServiceItems] = useState([]);
  const [nonInventoryItems, setNonInventoryItems] = useState([]);

  const [poCategory, setPoCategory] = useState('');
  const [dateCreated, setDateCreated] = useState(new Date().toISOString().slice(0, 10));
  const [needByDate, setNeedByDate] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [termId, setTermId] = useState('');
  const [refNo, setRefNo] = useState('');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState([]);

  // Each lookup is loaded on its own instead of through Promise.all, which rejects as a whole the
  // moment any one of its promises does. These seven calls sit behind SEVEN DIFFERENT permissions,
  // so a user without Job Orders access got a 403 on that one request and lost every dropdown on
  // the form -- supplier, term, tax, location, department, service items -- with nothing on screen
  // to say why. The form looked broken rather than restricted.
  //
  // Now one unreadable lookup only empties its own control, and whatever failed is named in a
  // banner, so the next person sees "you cannot read Job Orders" instead of an empty Supplier list.
  useEffect(() => {
    const load = (label, req, apply) => req
      .then(({ data }) => apply(data))
      .catch(() => setUnavailable((u) => (u.includes(label) ? u : [...u, label])));

    load('Suppliers', api.get('/suppliers'), setSuppliers);
    load('Terms', api.get('/lookups/payment-terms'), setTerms);
    load('Tax codes', api.get('/lookups/taxes'), setTaxes);
    load('Locations', api.get('/lookups/locations'), setLocations);
    load('Departments', api.get('/lookups/departments'), setDepartments);
    load('Job Orders', api.get('/job-orders', { params: JO_PICKER_PARAMS }), (d) => setJobOrders(d.rows || []));
    load('Service items', api.get('/inventory', { params: { item_type: 'Service' } }), setServiceItems);
    load('Non-inventory items', api.get('/inventory', { params: { item_type: 'Non-Inventory' } }), setNonInventoryItems);
  }, []);

  // PO-3 lines are picked from the Service items master, PO-4 lines from Non-Inventory -- and
  // only PO-3 lines carry a Job Order. So lines added under one category are the wrong shape under
  // the other: the item would not be in the list the form now offers, and a JO would ride along
  // invisibly on a PO-4. Cleared rather than silently carried over, and confirmed first because it
  // is the user's own typing being thrown away.
  function changeCategory(next) {
    if (next === poCategory) return;
    if (lines.length && !confirm(
      'Changing the PO Category clears the lines already added -- the two categories are filled from different item lists. Continue?'
    )) return;
    setPoCategory(next);
    setLines([]);
  }

  function addLine(item) {
    setLines((prev) => [...prev, {
      _key: `new-${Date.now()}`,
      item_id: item.id, item_code: item.item_code, item_name: item.display_name,
      purchase_description: item.display_name, location_id: '', department_id: '', job_order_id: '',
      qty: 1,
      // The unit PO Qty is entered in, which is the item's PURCHASE unit -- receiving multiplies
      // this quantity by conversion_factor, so labelling it with the base unit described the
      // wrong number. Base unit stays as Unit Title, what it converts into.
      purchase_unit: item.purchase_unit_title || item.base_unit_title || '',
      unit_title: item.base_unit_title || '',
      rate: 0, disc_percent: 0, tax_code_id: '', memo: '',
    }]);
  }

  function updateLine(key, patch) {
    setLines((prev) => prev.map((l) => (l._key === key ? { ...l, ...patch } : l)));
  }

  function removeLine(key) {
    setLines((prev) => prev.filter((l) => l._key !== key));
  }

  function lineCalc(l) {
    const qty = Number(l.qty || 0);
    const rate = Number(l.rate || 0);
    const subtotal = cents(qty * rate);
    // Discount % may be a chain ("10;5": 10% off, then 5% off the rest) -- utils/discountChain.js.
    const discAmount = cents(subtotal * ((parseDiscountChain(l.disc_percent).pct || 0) / 100));
    const netOfTax = cents(subtotal - discAmount);
    const tax = taxes.find((t) => t.id === l.tax_code_id);
    const taxRate = Number(tax?.rate || 0);
    // As the server: Ext. Price is the gross from the unrounded figures, Tax the rest over Net of Tax.
    const pct = parseDiscountChain(l.disc_percent).pct || 0;
    const extPrice = taxRate ? cents(qty * rate * (1 - pct / 100) * (1 + taxRate / 100)) : netOfTax;
    return { extPrice };
  }

  const grandTotal = lines.reduce((s, l) => s + lineCalc(l).extPrice, 0);

  // Which item master the Materials picker draws from. PO-3 ("Services with JO") buys work against
  // a job order, so it lists Service items. PO-4 ("Services/Non-Inventory without JO") lists
  // Service AND Non-Inventory -- its name says both, and repairs and labor (REPAIRS LABOR &
  // MATERIALS, SERVICE LABOR, Repairs & Maintenance ...) are Service items bought without a JO.
  // Both live in the one `inventories` table and are told apart by item_type, which is why this
  // is a choice of list rather than a different endpoint.
  const isNonInventoryCategory = poCategory === 'PO4';
  const pickerItems = isNonInventoryCategory ? [...serviceItems, ...nonInventoryItems] : serviceItems;
  const itemKindLabel = isNonInventoryCategory ? 'Service / Non-Inventory Item' : 'Service Item';

  async function handleSave() {
    setError('');
    if (!poCategory) { setError('Select a PO Category.'); return; }
    if (!supplierId) { setError('Select a Supplier.'); return; }
    if (!lines.length) { setError('Add at least one Material.'); return; }
    const badDisc = lines.map((l) => parseDiscountChain(l.disc_percent)).find((d) => d.error);
    if (badDisc) { setError(badDisc.error); return; }
    const deptError = lineDepartmentError(lines);
    if (deptError) { setError(deptError); return; }
    setSaving(true);
    try {
      const { data } = await api.post('/purchase-orders/direct', {
        po_category: poCategory,
        date_created: dateCreated,
        need_by_date: needByDate || null,
        supplier_id: supplierId,
        term_id: termId || null,
        ref_no: refNo || null,
        memo,
        lines: lines.map((l) => ({
          item_id: l.item_id, purchase_description: l.purchase_description,
          location_id: l.location_id || null, department_id: l.department_id || null,
          job_order_id: poCategory === 'PO3' ? (l.job_order_id || null) : null,
          memo: l.memo || null, qty: l.qty, purchase_unit: l.purchase_unit, unit_title: l.unit_title,
          rate: l.rate, disc_percent: parseDiscountChain(l.disc_percent).pct || 0, disc_formula: String(l.disc_percent ?? ""), tax_code_id: l.tax_code_id || null,
        })),
      });
      navigate(`/purchase-orders/${data.id}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Purchase Order — Create</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn" to={'/purchase-orders'}>Back to Lists</Link>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {/* Named rather than silent: an empty Supplier picker with no explanation is what sent people
          looking for a bug in the supplier list. */}
      {unavailable.length > 0 && (
        <div className="warning-banner">
          Could not load: {unavailable.join(', ')}. You may not have permission to view
          {unavailable.length === 1 ? ' it' : ' them'}, so the matching fields are empty — ask an
          administrator to grant access.
        </div>
      )}

      <div className="card">
        <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <div className="field">
            <label>Date Created</label>
            <input type="date" value={dateCreated} onChange={(e) => setDateCreated(e.target.value)} />
          </div>
          <div className="field">
            <label>Need by Date</label>
            <input type="date" value={needByDate} onChange={(e) => setNeedByDate(e.target.value)} />
          </div>
          <div className="field">
            <label>Supplier</label>
            <EntityPicker
              label="Supplier" items={suppliers} value={supplierId} getLabel={(s) => s?.name}
              columns={[{ key: 'name', label: 'Name' }, { key: 'address', label: 'Address', render: (s) => s.address || '—' }]} searchKeys={['name', 'address']}
              onSelect={(s) => setSupplierId(s.id)}
            />
          </div>
          <div className="field">
            <label>Reference #</label>
            <input value={refNo} onChange={(e) => setRefNo(e.target.value)} />
          </div>
          <div className="field">
            <label>Memo</label>
            <input value={memo} onChange={(e) => setMemo(e.target.value)} />
          </div>
          <div className="field">
            <label>Term</label>
            <EntityPicker
              label="Term" items={terms} value={termId} getLabel={(t) => t?.term_name}
              columns={[{ key: 'term_name', label: 'Term' }]} searchKeys={['term_name']}
              onSelect={(t) => setTermId(t.id)}
            />
          </div>
          <div className="field">
            <label>PO Category</label>
            <select value={poCategory} onChange={(e) => changeCategory(e.target.value)}>
              <option value="">--Select--</option>
              <option value="PO3">Services with JO</option>
              <option value="PO4">Services/Non-Inventory without JO</option>
            </select>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h3 className="subsection" style={{ marginTop: 0 }}>Materials</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item Code</th><th>Purchase Desc.</th><th>Location</th>
                {poCategory === 'PO3' && <th>JO #</th>}
                <th>PO Qty</th><th>Purchase Unit</th><th>Rate</th><th>Discount %</th>
                <th>Tax Code</th><th>Department *</th><th>Memo</th><th>Ext. Price</th><th></th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr><td colSpan={poCategory === 'PO3' ? 13 : 12} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                  {poCategory ? 'No materials yet.' : 'Select a PO Category first.'}
                </td></tr>
              )}
              {lines.map((l) => {
                const calc = lineCalc(l);
                return (
                  <tr key={l._key}>
                    <td>{l.item_code} — {l.item_name}</td>
                    <td><input style={{ width: 150 }} value={l.purchase_description} onChange={(e) => updateLine(l._key, { purchase_description: e.target.value })} /></td>
                    <td>
                      <EntityPicker
                        label="Location" items={locations} value={l.location_id} getLabel={(loc) => loc?.location_name}
                        columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']}
                        onSelect={(loc) => updateLine(l._key, { location_id: loc.id })}
                      />
                    </td>
                    {poCategory === 'PO3' && (
                      <td>
                        <EntityPicker
                          label="Job Order" items={jobOrderChoices} value={l.job_order_id} getLabel={(jo) => jo?.job_order_no}
                          columns={[
                            { key: 'job_order_no', label: 'JO #' },
                            { key: 'customer_name', label: 'Customer' },
                            { key: 'description', label: 'Description' },
                          ]}
                          searchKeys={['job_order_no', 'customer_name', 'description']}
                          onSearch={searchJobOrders}
                          onSelect={(jo) => { rememberJobOrder(jo); updateLine(l._key, { job_order_id: jo.id }); }}
                        />
                      </td>
                    )}
                    <td><input type="number" step="0.0001" style={{ width: 80 }} value={l.qty} onChange={(e) => updateLine(l._key, { qty: e.target.value })} /></td>
                    <td><input style={{ width: 90 }} value={l.purchase_unit} onChange={(e) => updateLine(l._key, { purchase_unit: e.target.value })} /></td>
                    <td><input type="number" step="0.000001" style={{ width: 90 }} value={l.rate} onChange={(e) => updateLine(l._key, { rate: e.target.value })} /></td>
                    <td><input type="text" inputMode="decimal" style={{ width: 80 }} value={l.disc_percent} placeholder="10;5" title="One discount (10) or a discount after discount (10;5 = 10% off, then 5% off the rest)" onChange={(e) => updateLine(l._key, { disc_percent: e.target.value })} /></td>
                    <td>
                      <EntityPicker
                        label="Tax Code" items={taxes} value={l.tax_code_id} getLabel={(t) => t?.code}
                        columns={[{ key: 'code', label: 'Code' }, { key: 'rate', label: 'Rate' }]} searchKeys={['code']}
                        onSelect={(t) => updateLine(l._key, { tax_code_id: t.id })}
                      />
                    </td>
                    <td>
                      <EntityPicker
                        label="Department" items={departments} value={l.department_id} getLabel={(d) => d?.name}
                        columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']}
                        onSelect={(d) => updateLine(l._key, { department_id: d.id })}
                      />
                    </td>
                    <td><input style={{ width: 120 }} value={l.memo} onChange={(e) => updateLine(l._key, { memo: e.target.value })} /></td>
                    <td>{money(calc.extPrice)}</td>
                    <td><button className="btn btn-sm btn-danger" onClick={() => removeLine(l._key)}>Remove</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 10 }}>
          <EntityPicker
            label={itemKindLabel} items={pickerItems} value="" getLabel={(i) => i.display_name}
            columns={[{ key: 'item_code', label: 'Code' }, { key: 'display_name', label: 'Name' }]}
            searchKeys={['item_code', 'display_name']}
            onSelect={addLine}
            triggerLabel={`Add ${itemKindLabel}`}
            triggerClassName="btn btn-primary"
            disabled={!poCategory}
          />
        </div>

        {lines.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
            <div className="hi-lg">Total: {money(grandTotal)}</div>
          </div>
        )}
      </div>
    </div>
  );
}
