import { useEffect, useState } from 'react';
import Pagination from '../components/Pagination';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import { lineDepartmentError } from '../utils/requireDepartment';

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

// A line's Supplier picker (2026-10-15): it opens on the suppliers this ITEM has been bought from
// (or quoted by, on the Inventory's price list), newest first with their last price; "Show all
// suppliers" widens it to every supplier. An item never bought before has no list of its own, so it
// opens on all of them.
function SupplierCell({ row, suppliers, itemSuppliers, onSelect }) {
  const [showAll, setShowAll] = useState(false);
  const known = itemSuppliers || [];
  const byId = new Map(suppliers.map((s) => [s.id, s]));
  const own = known.map((k) => ({ ...(byId.get(k.supplier_id) || { name: k.supplier_name }), ...k, id: k.supplier_id }));
  const all = showAll || !own.length;
  // A supplier picked from the full list stays named after the box is unticked again.
  if (row.supplier_id && !own.some((s) => s.id === row.supplier_id) && byId.has(row.supplier_id)) own.push(byId.get(row.supplier_id));
  return (
    <EntityPicker
      label={all ? 'Supplier' : `Suppliers of ${row.item_code || 'this item'}`}
      items={all ? suppliers : own} value={row.supplier_id} getLabel={(s) => s.name || s.supplier_name}
      columns={[
        { key: 'name', label: 'Name', render: (s) => s.name || s.supplier_name },
        { key: 'address', label: 'Address', render: (s) => s.address || '—' },
        ...(all ? [] : [
          { key: 'rate', label: 'Last Price', render: (s) => money(s.rate) },
          { key: 'last_purchase_date', label: 'Last Bought', render: (s) => (s.last_purchase_date ? String(s.last_purchase_date).slice(0, 10) : '—') },
        ]),
      ]}
      searchKeys={['name', 'supplier_name', 'address']}
      headerExtra={(
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 400 }}>
          <input type="checkbox" checked={all} disabled={!own.length} onChange={(e) => setShowAll(e.target.checked)} />
          Show all suppliers{!own.length && itemSuppliers ? ' (none on record for this item)' : ''}
        </label>
      )}
      onSelect={(s) => onSelect(s, known.find((k) => k.supplier_id === s.id))}
    />
  );
}

// Mirrors the real "Placing Order Form" -- reached from Purchasing > Place Order Form.
// Simplified version of the real Canvass step: no Supplier Price history comparison or
// "not the lowest price, pick a reason" justification yet (see schema.sql note on
// purchase_orders for why), just a straightforward per-line Supplier/Rate/Discount/Tax
// entry. Saving splits the grid into one PO per distinct Supplier, same as the real form.
export default function PlaceOrderForm() {
  const navigate = useNavigate();
  const [showPicker, setShowPicker] = useState(false);
  const [openPRs, setOpenPRs] = useState([]);
  const [pickerSearch, setPickerSearch] = useState('');
  // The PR picker shows five at a time (asked 2026-10-03).
  const [pickerPage, setPickerPage] = useState(1);
  const PICKER_PAGE_SIZE = 5;
  const [selectedPrIds, setSelectedPrIds] = useState(new Set());
  const [rows, setRows] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  // item_id -> the suppliers it has been bought from (see SupplierCell); loaded as lines arrive.
  const [itemSuppliers, setItemSuppliers] = useState({});
  const [taxes, setTaxes] = useState([]);
  const [locations, setLocations] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [dateCreated, setDateCreated] = useState(new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/suppliers').then(({ data }) => setSuppliers(data)).catch(() => {});
    api.get('/lookups/taxes').then(({ data }) => setTaxes(data)).catch(() => {});
    api.get('/lookups/locations').then(({ data }) => setLocations(data)).catch(() => {});
    api.get('/lookups/departments').then(({ data }) => setDepartments(data)).catch(() => {});
  }, []);

  // Resolved by NAME, not by a hardcoded id: the two installs number their rows differently, so an
  // id baked in here would point at the right row on one and at something else on the other. If
  // either name is ever changed the lookup simply finds nothing and the field starts blank, which
  // is the behaviour these fields had before -- a missing default, never a wrong one.
  const idByName = (list, key, name) => (
    list.find((x) => String(x[key] || '').trim().toLowerCase() === name.toLowerCase())?.id || ''
  );
  const defaultLocationId = idByName(locations, 'location_name', 'Warehouse - Central');
  const defaultDepartmentId = idByName(departments, 'name', 'Supply Chain');

  async function openPicker() {
    setPickerPage(1);
    setShowPicker(true);
    const { data } = await api.get('/purchase-requisitions', { params: { open_only: 1 } });
    setOpenPRs(data.filter((pr) => pr.item_status !== 'FULLY ORDERED' && pr.status !== 'cancelled'));
  }

  function togglePr(id) {
    setSelectedPrIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleDone() {
    setShowPicker(false);
    if (!selectedPrIds.size) return;
    const { data } = await api.get('/purchase-orders/canvass-lines', { params: { pr_ids: [...selectedPrIds].join(',') } });
    // The PRs' own memos carry into the Purchase Order's Memo (asked 2026-11-10), each once, after
    // whatever is typed there already; still editable before creating.
    const prMemos = openPRs.filter((pr) => selectedPrIds.has(pr.id) && String(pr.memo || '').trim())
      .map((pr) => String(pr.memo).trim());
    if (prMemos.length) {
      setMemo((cur) => {
        const parts = cur.trim() ? [cur.trim()] : [];
        for (const m of prMemos) if (!parts.some((p) => p.includes(m))) parts.push(m);
        return parts.join(' / ');
      });
    }
    setRows((prev) => [
      ...prev,
      ...data
        .filter((l) => !prev.some((p) => p.purchase_requisition_line_id === l.purchase_requisition_line_id))
        .map((l) => ({
          ...l,
          po_qty_input: l.remaining,
          supplier_id: '', supplier_name: '', rate: 0, disc_percent: 0, tax_code_id: '', tax_code: '',
          // Both started blank and had to be picked on every line, which on a long canvass is the
          // same two choices over and over. Warehouse - Central and Supply Chain are what they are
          // in practice: 16,637 of the existing purchase order lines are Central and 16,723 are
          // Supply Chain, each the largest group by a wide margin.
          location_id: defaultLocationId,
          // The requisition's OWN department wins where it has one -- a PR raised by Production
          // should not arrive charged to Supply Chain -- and Supply Chain is only the fallback.
          department_id: l.department_id || defaultDepartmentId,
        })),
    ]);
  }

  useEffect(() => {
    const missing = [...new Set(rows.map((r) => r.item_id).filter((id) => id && !(id in itemSuppliers)))];
    if (!missing.length) return;
    setItemSuppliers((prev) => ({ ...prev, ...Object.fromEntries(missing.map((id) => [id, null])) }));
    for (const id of missing) {
      api.get(`/purchase-orders/item-price-history/${id}`)
        .then(({ data }) => setItemSuppliers((prev) => ({ ...prev, [id]: data.suppliers || [] })))
        .catch(() => setItemSuppliers((prev) => ({ ...prev, [id]: [] })));
    }
  }, [rows, itemSuppliers]);

  function updateRow(key, patch) {
    setRows((prev) => prev.map((r) => (r.purchase_requisition_line_id === key ? { ...r, ...patch } : r)));
  }

  function removeRow(key) {
    setRows((prev) => prev.filter((r) => r.purchase_requisition_line_id !== key));
  }

  function lineCalc(r) {
    const q = Number(r.po_qty_input || 0);
    const rate = Number(r.rate || 0);
    const subtotal = q * rate;
    const discAmount = subtotal * (Number(r.disc_percent || 0) / 100);
    const netOfTax = subtotal - discAmount;
    const tax = taxes.find((t) => t.id === r.tax_code_id);
    const taxAmount = netOfTax * (Number(tax?.rate || 0) / 100);
    return { subtotal, discAmount, netOfTax, taxAmount, extPrice: netOfTax + taxAmount };
  }

  const grandTotal = rows.reduce((s, r) => s + lineCalc(r).extPrice, 0);

  async function handleCreate() {
    setError('');
    const submitRows = rows.filter((r) => Number(r.po_qty_input) > 0 && r.supplier_id);
    if (!submitRows.length) { setError('Enter a Qty and pick a Supplier for at least one line.'); return; }
    const deptError = lineDepartmentError(submitRows);
    if (deptError) { setError(deptError); return; }
    setSaving(true);
    try {
      const { data } = await api.post('/purchase-orders', {
        date_created: dateCreated,
        memo,
        lines: submitRows.map((r) => ({
          purchase_requisition_line_id: r.purchase_requisition_line_id,
          item_id: r.item_id,
          purchase_description: r.purchase_description,
          location_id: r.location_id || null,
          department_id: r.department_id || null,
          qty: r.po_qty_input,
          purchase_unit: r.purchase_unit,
          unit_title: r.unit_title,
          supplier_id: r.supplier_id,
          rate: r.rate,
          disc_percent: r.disc_percent,
          tax_code_id: r.tax_code_id || null,
        })),
      });
      if (data.length === 1) navigate(`/purchase-orders/${data[0].id}`);
      else navigate('/purchase-orders');
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  // The picker's list after the search; paged five at a time below.
  const q = pickerSearch.trim().toLowerCase();
  const pickerRows = openPRs.filter((pr) => !q || [pr.pr_no, pr.requestor_name, pr.department_name, pr.memo]
    .some((v) => String(v || '').toLowerCase().includes(q)));

  return (
    <div>
      <div className="page-header">
        <h1>Placing Order Form</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn" to={'/purchase-orders'}>Purchase Orders</Link>
          <button className="btn btn-primary" onClick={openPicker}>Select Purchase Requisitions</button>
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
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h3 className="subsection" style={{ marginTop: 0 }}>Canvass</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>PR #</th><th>Item</th><th>Purchase Desc.</th><th>Location</th><th>Department *</th><th>On Hand</th><th>PR Qty</th><th>POed Qty</th><th>PO Qty</th>
                <th>Unit</th><th>Supplier</th><th>Rate</th><th>Disc %</th><th>Tax Code</th><th>Ext. Price</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={16} className="muted" style={{ textAlign: 'center', padding: 20 }}>Select Purchase Requisitions to start canvassing.</td></tr>
              )}
              {rows.map((r) => {
                const calc = lineCalc(r);
                return (
                  <tr key={r.purchase_requisition_line_id}>
                    <td>{r.pr_no}</td>
                    <td>{r.item_code} — {r.item_name}</td>
                    {/* Starts as the PR line's description; editable here as on Create / Edit PO. */}
                    <td><input style={{ width: 150 }} value={r.purchase_description || ''} onChange={(e) => updateRow(r.purchase_requisition_line_id, { purchase_description: e.target.value })} /></td>
                    <td>
                      <EntityPicker
                        label="Location" items={locations} value={r.location_id} getLabel={(loc) => loc?.location_name}
                        columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']}
                        onSelect={(loc) => updateRow(r.purchase_requisition_line_id, { location_id: loc.id })}
                      />
                    </td>
                    <td>
                      <EntityPicker
                        label="Department" items={departments} value={r.department_id} getLabel={(d) => d?.name}
                        columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']}
                        onSelect={(d) => updateRow(r.purchase_requisition_line_id, { department_id: d.id })}
                      />
                    </td>
                    <td>{qty(r.qty_on_hand)}</td>
                    <td>{qty(r.qty)}</td>
                    <td>{qty(r.po_qty)}</td>
                    <td>
                      <input
                        type="number" step="0.0001" max={r.remaining} style={{ width: 90 }}
                        value={r.po_qty_input} onChange={(e) => updateRow(r.purchase_requisition_line_id, { po_qty_input: e.target.value })}
                      />
                    </td>
                    <td>{r.purchase_unit}</td>
                    <td>
                      <SupplierCell
                        row={r} suppliers={suppliers} itemSuppliers={itemSuppliers[r.item_id]}
                        // Picking one of the item's own suppliers brings its last price in, when no rate is typed yet.
                        onSelect={(s, last) => updateRow(r.purchase_requisition_line_id, {
                          supplier_id: s.id, supplier_name: s.name || s.supplier_name,
                          // Only in the same unit: a price per box is not a price per piece.
                          ...(last && !Number(r.rate) && (!last.unit || last.unit === r.purchase_unit) ? { rate: Number(last.rate) || 0 } : {}),
                        })}
                      />
                    </td>
                    <td>
                      <input type="number" step="0.000001" style={{ width: 90 }} value={r.rate} onChange={(e) => updateRow(r.purchase_requisition_line_id, { rate: e.target.value })} />
                    </td>
                    <td>
                      <input type="number" step="0.01" style={{ width: 70 }} value={r.disc_percent} onChange={(e) => updateRow(r.purchase_requisition_line_id, { disc_percent: e.target.value })} />
                    </td>
                    <td>
                      <EntityPicker
                        label="Tax Code" items={taxes} value={r.tax_code_id} getLabel={(t) => t.code}
                        columns={[{ key: 'code', label: 'Code' }, { key: 'rate', label: 'Rate' }]} searchKeys={['code']}
                        onSelect={(t) => updateRow(r.purchase_requisition_line_id, { tax_code_id: t.id, tax_code: t.code })}
                      />
                    </td>
                    <td>{money(calc.extPrice)}</td>
                    <td><button className="btn btn-sm btn-danger" onClick={() => removeRow(r.purchase_requisition_line_id)}>Remove</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {rows.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
            <div className="hi-lg">Total: {money(grandTotal)}</div>
            <button className="btn btn-primary" disabled={saving} onClick={handleCreate}>Create Purchase Order(s)</button>
          </div>
        )}
      </div>

      {showPicker && (
        <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && setShowPicker(false)}>
          <div className="modal modal-lg" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="estimate-banner" style={{ borderRadius: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ margin: 0, color: '#fff' }}>Purchase Requisitions</h2>
              <button type="button" onClick={() => setShowPicker(false)} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 24, lineHeight: 1, cursor: 'pointer' }}>×</button>
            </div>
            <div style={{ padding: 24 }}>
              <input placeholder="Search PR #, requestor, department or memo" value={pickerSearch} onChange={(e) => { setPickerSearch(e.target.value); setPickerPage(1); }} style={{ marginBottom: 16, maxWidth: 320 }} />
              <div className="table-wrap">
                <table>
                  <thead><tr><th></th><th>PR #</th><th>Date Created</th><th>Requested From</th><th>Requestor</th><th>Memo</th><th>Status</th><th>Item Status</th></tr></thead>
                  <tbody>
                    {pickerRows.slice((pickerPage - 1) * PICKER_PAGE_SIZE, pickerPage * PICKER_PAGE_SIZE)
                      .map((pr) => (
                        <tr key={pr.id} className="picker-row" style={{ cursor: 'pointer' }} onClick={() => togglePr(pr.id)}>
                          <td><input type="checkbox" checked={selectedPrIds.has(pr.id)} readOnly /></td>
                          <td>{pr.pr_no}</td>
                          <td>{String(pr.date_created).slice(0, 10)}</td>
                          <td>{pr.department_name}</td>
                          <td>{pr.requestor_name}</td>
                          <td style={{ maxWidth: 260, whiteSpace: 'pre-wrap' }}>{pr.memo || <span className="muted">—</span>}</td>
                          <td>{pr.status}</td>
                          <td>{pr.item_status}</td>
                        </tr>
                      ))}
                    {pickerRows.length === 0 && (
                      <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>{openPRs.length ? 'No Purchase Requisition matches the search.' : 'No open Purchase Requisitions.'}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, flexWrap: 'wrap', gap: 8 }}>
                <span className="muted">{pickerRows.length} PR(s){selectedPrIds.size ? ` · ${selectedPrIds.size} selected` : ''}</span>
                <Pagination page={pickerPage} totalPages={Math.max(1, Math.ceil(pickerRows.length / PICKER_PAGE_SIZE))} onChange={setPickerPage} />
              </div>
              <div className="modal-actions">
                <button className="btn btn-primary" onClick={handleDone}>Done</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
