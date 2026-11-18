import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import { parseDiscountChain, discountLabel } from '../utils/discountChain';
import { lineDepartmentError } from '../utils/requireDepartment';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

// Mirrors the real system's PO "Edit" screen (confirmed against the sandbox: reuses
// the same header/line fields as Create, reached from the detail view's Edit button --
// only shown there while the PO is still Pending Approval, matching the backend's own
// PUT /:id guard). Existing lines that
// already have Received/Billed activity can't be removed, and their Qty can't go below what was
// Received/Billed (it was locked outright until 2026-10-31) --
// everything else (rate, discount, tax, description, location, department) stays
// editable, and brand-new lines can be added/removed freely, same restrictions the
// backend enforces server-side regardless of what this form allows client-side.
// Rounded to the centavo at each step, exactly as the server does (routes/purchaseOrders.js cents).
const cents = (n) => Math.round(Number((Number(n) * 100).toFixed(6))) / 100;

export default function PurchaseOrderEdit() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [po, setPo] = useState(null);
  const [suppliers, setSuppliers] = useState([]);
  const [terms, setTerms] = useState([]);
  const [taxes, setTaxes] = useState([]);
  const [locations, setLocations] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [items, setItems] = useState([]);
  const [serviceItems, setServiceItems] = useState([]);
  const [nonInventoryItems, setNonInventoryItems] = useState([]);

  const [dateCreated, setDateCreated] = useState('');
  const [needByDate, setNeedByDate] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [termId, setTermId] = useState('');
  const [refNo, setRefNo] = useState('');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState([]);

  // The Purchase Order itself is fatal if it will not load -- there is nothing to edit without it.
  // The six lookups beside it are NOT: they sit behind six different permissions, and rolling them
  // into one Promise.all meant a single 403 on any of them made the whole PO uneditable, reported
  // as "Failed to load Purchase Order" when the order had loaded perfectly well. Each now fills in
  // on its own, and anything unreadable is named in a banner instead of blocking the screen.
  useEffect(() => {
    const load = (label, req, apply) => req
      .then(({ data }) => apply(data))
      .catch(() => setUnavailable((u) => (u.includes(label) ? u : [...u, label])));

    load('Suppliers', api.get('/suppliers'), setSuppliers);
    load('Terms', api.get('/lookups/payment-terms'), setTerms);
    load('Tax codes', api.get('/lookups/taxes'), setTaxes);
    load('Locations', api.get('/lookups/locations'), setLocations);
    load('Departments', api.get('/lookups/departments'), setDepartments);
    load('Items', api.get('/inventory'), setItems);
    load('Service items', api.get('/inventory', { params: { item_type: 'Service' } }), setServiceItems);
    load('Non-inventory items', api.get('/inventory', { params: { item_type: 'Non-Inventory' } }), setNonInventoryItems);

    api.get(`/purchase-orders/${id}`).then((poRes) => {
      const p = poRes.data;
      setPo(p);
      setDateCreated(p.date_created ? String(p.date_created).slice(0, 10) : '');
      setNeedByDate(p.need_by_date ? String(p.need_by_date).slice(0, 10) : '');
      setSupplierId(p.supplier_id);
      setTermId(p.term_id || '');
      setRefNo(p.ref_no || '');
      setMemo(p.memo || '');
      setLines(p.lines.map((l) => ({
        _key: `existing-${l.id}`,
        id: l.id,
        item_id: l.item_id, item_code: l.item_code, item_name: l.item_name,
        purchase_description: l.purchase_description, location_id: l.location_id || '', department_id: l.department_id || '',
        job_order_id: l.job_order_id || '', pr_no: l.pr_no,
        qty: l.qty, purchase_unit: l.purchase_unit, unit_title: l.unit_title,
        rate: l.rate, disc_percent: discountLabel(l), tax_code_id: l.tax_code_id || '',
        locked: Number(l.received_qty || 0) > 0 || Number(l.billed_qty || 0) > 0,
        // A received / billed line's qty can still change, down to what it has received / billed.
        min_qty: Math.max(Number(l.received_qty || 0), Number(l.billed_qty || 0)),
        purchase_requisition_line_id: l.purchase_requisition_line_id || null,
      })));
      setLoading(false);
    }).catch((err) => {
      setError(err.response?.data?.error || 'Failed to load Purchase Order');
      setLoading(false);
    });
  }, [id]);

  function addLine(item) {
    setLines((prev) => [...prev, {
      _key: `new-${Date.now()}`,
      id: null,
      item_id: item.id, item_code: item.item_code, item_name: item.display_name,
      purchase_description: item.display_name, location_id: '', department_id: '', job_order_id: '',
      qty: 1,
      // As in PurchaseOrderCreate: PO Qty is in the item's PURCHASE unit, and receiving scales it
      // by conversion_factor. Unit Title keeps the base unit.
      purchase_unit: item.purchase_unit_title || item.base_unit_title || '',
      unit_title: item.base_unit_title || '',
      rate: 0, disc_percent: 0, tax_code_id: '',
      locked: false, purchase_requisition_line_id: null,
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

  async function handleSave() {
    setError('');
    if (!supplierId) { setError('Select a Supplier.'); return; }
    if (!lines.length) { setError('Add at least one Material.'); return; }
    const badDisc = lines.map((l) => parseDiscountChain(l.disc_percent)).find((d) => d.error);
    if (badDisc) { setError(badDisc.error); return; }
    const deptError = lineDepartmentError(lines);
    if (deptError) { setError(deptError); return; }
    setSaving(true);
    try {
      await api.put(`/purchase-orders/${id}`, {
        date_created: dateCreated,
        need_by_date: needByDate || null,
        supplier_id: supplierId,
        term_id: termId || null,
        ref_no: refNo || null,
        memo,
        lines: lines.map((l) => ({
          id: l.id, item_id: l.item_id, purchase_requisition_line_id: l.purchase_requisition_line_id,
          purchase_description: l.purchase_description,
          location_id: l.location_id || null, department_id: l.department_id || null,
          job_order_id: l.job_order_id || null,
          qty: l.qty, purchase_unit: l.purchase_unit, unit_title: l.unit_title,
          rate: l.rate, disc_percent: parseDiscountChain(l.disc_percent).pct || 0, disc_formula: String(l.disc_percent ?? ""), tax_code_id: l.tax_code_id || null,
        })),
      });
      navigate(`/purchase-orders/${id}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingSpinner />;
  if (!po) return <div className="error-banner">{error || 'Not found'}</div>;

  return (
    <div>
      <div className="page-header">
        <h1>Purchase Order — {po.po_no}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn" to={`/purchase-orders/${id}`}>Back</Link>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
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
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h3 className="subsection" style={{ marginTop: 0 }}>Materials</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item Code</th><th>Purchase Desc.</th><th>Location</th><th>Department *</th>
                <th>PO Qty</th><th>Purchase Unit</th><th>Rate</th><th>Discount %</th>
                <th>Tax Code</th><th>Ext. Price</th><th></th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 20 }}>No materials yet.</td></tr>
              )}
              {lines.map((l) => {
                const calc = lineCalc(l);
                return (
                  <tr key={l._key}>
                    <td>{l.item_code} — {l.item_name}{l.pr_no ? <div className="muted" style={{ fontSize: 12 }}>PR {l.pr_no}</div> : null}</td>
                    <td><input style={{ width: 150 }} value={l.purchase_description || ''} onChange={(e) => updateLine(l._key, { purchase_description: e.target.value })} /></td>
                    <td>
                      <EntityPicker
                        label="Location" items={locations} value={l.location_id} getLabel={(loc) => loc?.location_name}
                        columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']}
                        onSelect={(loc) => updateLine(l._key, { location_id: loc.id })}
                      />
                    </td>
                    <td>
                      <EntityPicker
                        label="Department" items={departments} value={l.department_id} getLabel={(d) => d?.name}
                        columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']}
                        onSelect={(d) => updateLine(l._key, { department_id: d.id })}
                      />
                    </td>
                    <td>
                      <input
                        type="number" step="0.0001" style={{ width: 80 }} value={l.qty}
                        min={l.locked ? l.min_qty : undefined}
                        title={l.locked ? `Already Received/Billed: ${l.min_qty} -- Qty cannot go below it` : undefined}
                        onChange={(e) => updateLine(l._key, { qty: e.target.value })}
                      />
                      {l.locked && <div className="muted" style={{ fontSize: 11 }}>min {l.min_qty}</div>}
                    </td>
                    <td>{l.purchase_unit}</td>
                    <td><input type="number" step="0.000001" style={{ width: 90 }} value={l.rate} onChange={(e) => updateLine(l._key, { rate: e.target.value })} /></td>
                    <td><input type="text" inputMode="decimal" style={{ width: 80 }} value={l.disc_percent} placeholder="10;5" title="One discount (10) or a discount after discount (10;5 = 10% off, then 5% off the rest)" onChange={(e) => updateLine(l._key, { disc_percent: e.target.value })} /></td>
                    <td>
                      <EntityPicker
                        label="Tax Code" items={taxes} value={l.tax_code_id} getLabel={(t) => t?.code}
                        columns={[{ key: 'code', label: 'Code' }, { key: 'rate', label: 'Rate' }]} searchKeys={['code']}
                        onSelect={(t) => updateLine(l._key, { tax_code_id: t.id })}
                      />
                    </td>
                    <td>{money(calc.extPrice)}</td>
                    <td>{!l.locked && <button className="btn btn-sm btn-danger" onClick={() => removeLine(l._key)}>Remove</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 10 }}>
          <EntityPicker
            // The same lists as the create form: PO-3 buys Service items, PO-4 Service and
            // Non-Inventory, the rest stock items.
            label="Item" items={po?.type === 'PO3' ? serviceItems : po?.type === 'PO4' ? [...serviceItems, ...nonInventoryItems] : items}
            value="" getLabel={(i) => i.display_name}
            columns={[{ key: 'item_code', label: 'Code' }, { key: 'display_name', label: 'Name' }]}
            searchKeys={['item_code', 'display_name']}
            onSelect={addLine}
            triggerLabel="Add Material"
            triggerClassName="btn btn-primary"
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
