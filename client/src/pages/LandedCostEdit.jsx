import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

// Mirrors the real Purchase Order's "Landed Cost" tab > Create PO -- a sub-PO for
// freight/customs/etc. tied back to an already-Approved parent PO. Not sourced from any
// Purchase Requisition line, so items are picked straight from Inventory.
// Rounded to the centavo at each step, exactly as the server does (routes/purchaseOrders.js cents).
const cents = (n) => Math.round(Number((Number(n) * 100).toFixed(6))) / 100;

export default function LandedCostEdit() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [parent, setParent] = useState(null);
  const [suppliers, setSuppliers] = useState([]);
  const [terms, setTerms] = useState([]);
  const [taxes, setTaxes] = useState([]);
  const [landedCosts, setLandedCosts] = useState([]);
  const [locations, setLocations] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [dateCreated, setDateCreated] = useState(new Date().toISOString().slice(0, 10));
  const [supplierId, setSupplierId] = useState('');
  const [termId, setTermId] = useState('');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get(`/purchase-orders/${id}`),
      api.get('/suppliers'),
      api.get('/lookups/payment-terms'),
      api.get('/lookups/taxes'),
      // The charges from Master Lists > Landed Costs, not the whole inventory. A landed cost PO is
      // for freight, customs and cutting; offering thousands of stock items here was an invitation
      // to put one of them on a freight charge.
      api.get('/purchase-orders/meta/landed-cost-items'),
      api.get('/lookups/locations'),
      api.get('/lookups/departments'),
    ]).then(([poRes, supRes, termRes, taxRes, lcRes, locRes, deptRes]) => {
      setParent(poRes.data);
      setSuppliers(supRes.data);
      setTerms(termRes.data);
      setTaxes(taxRes.data);
      setLandedCosts(lcRes.data);
      setLocations(locRes.data);
      setDepartments(deptRes.data);
      setLoading(false);
    });
  }, [id]);

  function addLine(item) {
    // A landed cost with no inventory item behind it cannot go on a PO line, which needs one.
    // Refused here with the reason rather than silently adding a line that will not save.
    if (!item.id) {
      setError(`"${item.name}" has no item linked to it. Set one on Master Lists > Landed Costs before using it here.`);
      return;
    }
    setError('');
    setLines((prev) => [...prev, {
      _key: `new-${Date.now()}`,
      // The line still records the INVENTORY ITEM, exactly as it always has -- all 907 existing
      // landed cost lines point at one, and everything downstream joins on it. Only what can be
      // chosen has narrowed.
      item_id: item.id, item_code: item.item_code, item_name: item.display_name,
      purchase_description: item.name, qty: 1,
      // Landed cost is apportioned over a purchased quantity, so the same rule applies: the qty
      // is in the item's purchase unit, with the base unit as Unit Title.
      purchase_unit: item.purchase_unit_title || item.base_unit_title || '',
      unit_title: item.base_unit_title || '',
      rate: 0, disc_percent: 0, tax_code_id: '', tax_code: '',
      location_id: '', department_id: '',
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
    const discAmount = cents(subtotal * (Number(l.disc_percent || 0) / 100));
    const netOfTax = cents(subtotal - discAmount);
    const tax = taxes.find((t) => t.id === l.tax_code_id);
    const taxRate = Number(tax?.rate || 0);
    // As the server: Ext. Price is the gross from the unrounded figures, Tax the rest over Net of Tax.
    const pct = Number(l.disc_percent || 0);
    const extPrice = taxRate ? cents(qty * rate * (1 - pct / 100) * (1 + taxRate / 100)) : netOfTax;
    return { extPrice };
  }

  const grandTotal = lines.reduce((s, l) => s + lineCalc(l).extPrice, 0);

  async function handleSave() {
    setError('');
    if (!supplierId) { setError('Select a Supplier.'); return; }
    if (!lines.length) { setError('Add at least one line.'); return; }
    setSaving(true);
    try {
      const { data } = await api.post(`/purchase-orders/${id}/landed-costs`, {
        date_created: dateCreated,
        supplier_id: supplierId,
        term_id: termId || null,
        memo,
        lines: lines.map((l) => ({
          item_id: l.item_id, purchase_description: l.purchase_description, qty: l.qty,
          location_id: l.location_id || null, department_id: l.department_id || null,
          purchase_unit: l.purchase_unit, unit_title: l.unit_title, rate: l.rate,
          disc_percent: l.disc_percent, tax_code_id: l.tax_code_id || null,
        })),
      });
      navigate(`/purchase-orders/${data.id}`);
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
        <h1>Landed Cost — {parent?.po_no}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn" to={`/purchase-orders/${id}`}>Back to Lists</Link>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <div className="field">
            <label>Date Created</label>
            <input type="date" value={dateCreated} onChange={(e) => setDateCreated(e.target.value)} />
          </div>
          <div className="field">
            <label>Memo</label>
            <input value={memo} onChange={(e) => setMemo(e.target.value)} />
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
        <h3 className="subsection" style={{ marginTop: 0 }}>Items</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item Code</th><th>Purchase Desc.</th><th>Location</th><th>Department</th>
                <th>Qty</th><th>Rate</th>
                <th>Discount %</th><th>Tax Code</th><th>Ext. Price</th><th></th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 20 }}>No items yet.</td></tr>
              )}
              {lines.map((l) => {
                const calc = lineCalc(l);
                return (
                  <tr key={l._key}>
                    <td>{l.item_code} — {l.item_name}</td>
                    <td><input style={{ width: 160 }} value={l.purchase_description} onChange={(e) => updateLine(l._key, { purchase_description: e.target.value })} /></td>
                    {/* Same two pickers, from the same lookups, as a PO1 line -- a freight or
                        customs charge belongs to a warehouse and a cost centre like anything else. */}
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
                    <td><input type="number" step="0.0001" style={{ width: 80 }} value={l.qty} onChange={(e) => updateLine(l._key, { qty: e.target.value })} /></td>
                    <td><input type="number" step="0.000001" style={{ width: 90 }} value={l.rate} onChange={(e) => updateLine(l._key, { rate: e.target.value })} /></td>
                    <td><input type="number" step="0.01" style={{ width: 70 }} value={l.disc_percent} onChange={(e) => updateLine(l._key, { disc_percent: e.target.value })} /></td>
                    <td>
                      <EntityPicker
                        label="Tax Code" items={taxes} value={l.tax_code_id} getLabel={(t) => t?.code}
                        columns={[{ key: 'code', label: 'Code' }, { key: 'rate', label: 'Rate' }]} searchKeys={['code']}
                        onSelect={(t) => updateLine(l._key, { tax_code_id: t.id, tax_code: t.code })}
                      />
                    </td>
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
            label="Landed Cost" items={landedCosts} value=""
            getLabel={(i) => i.name}
            columns={[
              { key: 'name', label: 'Landed Cost' },
              { key: 'item_code', label: 'Item', render: (i) => i.item_code || '—' },
              // Says outright which entries cannot be used and why, instead of leaving somebody to
              // wonder why picking one does nothing.
              {
                key: 'usable',
                label: '',
                render: (i) => (i.usable ? '' : <span className="badge badge-warning">no item linked</span>),
              },
            ]}
            searchKeys={['name', 'item_code']}
            onSelect={addLine}
            triggerLabel="Add Item"
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
