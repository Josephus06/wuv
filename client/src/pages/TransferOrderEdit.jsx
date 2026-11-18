import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import { useItemBalances } from '../utils/itemBalances';

const STATUS_LABELS = {
  pending_fulfillment: 'Pending Fulfillment',
  partially_fulfilled: 'Partially Fulfilled',
  pending_receipt: 'Pending Receipt',
  pending_receipt_partially_fulfilled: 'Pending Receipt / Partially Fulfilled',
  received: 'Received',
  cancelled: 'Cancelled',
};

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function locationLabel(l) { return l ? l.location_name : ''; }
function employeeLabel(e) { return e ? `${e.first_name} ${e.last_name}` : ''; }

// Mirrors the real "Transfer Order" Add/Update form. Reached two ways: "Add New" from
// the Transfer Orders list (blank), or the "Create TO" button on a Job Order's
// Production view -- which arrives here with router state (`prefill`) already carrying
// the header defaults (Withdraw From = Warehouse - Central, Transfer To = the JO's own
// material location, Requestor = the current user) and one line per material that's
// actually short, so this whole record gets created in a single request on mount
// instead of the user re-entering what the Production screen already knew.
export default function TransferOrderEdit() {
  const { id } = useParams();
  const location = useLocation();
  const isNew = !id;
  const navigate = useNavigate();
  const { can, user } = useAuth();
  // Materials picked on a brand-new TO, before it has an id to post lines against. They go up
  // with the header in the one create request, so the TO and its materials land together.
  const [draftLines, setDraftLines] = useState([]);

  const [form, setForm] = useState({
    date_created: new Date().toISOString().slice(0, 10), date_needed: '',
    withdraw_from_location_id: '', transfer_to_location_id: '', requestor_id: '', memo: '',
  });
  const [to, setTo] = useState(null);
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [locations, setLocations] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [inventoryItems, setInventoryItems] = useState([]);
  const autoCreated = useRef(false);

  // Qty on Hand for materials picked before the first save: the Bin Card balance at the chosen
  // Withdraw From location, the same figure a saved line shows. Nothing until a location is
  // chosen -- a company-wide total would read as stock this warehouse may not have.
  const { balances: draftBalances, load: loadDraftBalances } = useItemBalances(form.withdraw_from_location_id || null);
  const draftItemKey = draftLines.map((l) => l.item_id).join(',');
  useEffect(() => {
    if (isNew && form.withdraw_from_location_id && draftItemKey) {
      loadDraftBalances(draftItemKey.split(',').map((itemId) => ({ id: Number(itemId) })));
    }
  }, [isNew, form.withdraw_from_location_id, draftItemKey]); // eslint-disable-line react-hooks/exhaustive-deps
  function draftOnHand(l) {
    const b = form.withdraw_from_location_id ? draftBalances[l.item_id] : null;
    if (!b) return <span className="muted">—</span>;
    return qty(l.unit_used === 'stock' && b.stock_unit_title ? b.balance_stock : b.balance_base);
  }

  useEffect(() => {
    Promise.all([
      api.get('/lookups/locations'),
      // Requestors and items from the TO's own endpoint: /employees and /inventory answer only to
      // those pages' permissions, and a refusal there stopped the whole form from loading.
      api.get('/transfer-orders/form-meta'),
      isNew ? Promise.resolve(null) : api.get(`/transfer-orders/${id}`),
    ]).then(async ([locRes, metaRes, toRes]) => {
      setLocations(locRes.data);
      setEmployees(metaRes.data.employees);
      setInventoryItems(metaRes.data.items);

      const prefill = location.state?.prefill;
      if (isNew && prefill && !autoCreated.current) {
        autoCreated.current = true;
        setSaving(true);
        try {
          const { data } = await api.post('/transfer-orders', {
            date_created: new Date().toISOString().slice(0, 10),
            withdraw_from_location_id: prefill.withdraw_from_location_id,
            transfer_to_location_id: prefill.transfer_to_location_id,
            requestor_id: prefill.requestor_id || null,
            job_order_id: prefill.job_order_id || null,
            lines: prefill.lines || [],
          });
          navigate(`/transfer-orders/${data.id}`, { replace: true });
        } catch (err) {
          setError(err.response?.data?.error || 'Could not create the transfer order.');
          setLoading(false);
        } finally {
          setSaving(false);
        }
        return;
      }

      // The Requestor is whoever is raising it until they pick someone else.
      if (isNew && user?.employee_id) setForm((f) => (f.requestor_id ? f : { ...f, requestor_id: user.employee_id }));

      if (toRes) {
        setTo(toRes.data);
        setLines(toRes.data.lines || []);
        setForm({
          date_created: toRes.data.date_created ? String(toRes.data.date_created).slice(0, 10) : '',
          date_needed: toRes.data.date_needed ? String(toRes.data.date_needed).slice(0, 10) : '',
          withdraw_from_location_id: toRes.data.withdraw_from_location_id || '',
          transfer_to_location_id: toRes.data.transfer_to_location_id || '',
          requestor_id: toRes.data.requestor_id || '',
          memo: toRes.data.memo || '',
        });
      }
      setLoading(false);
    }).catch((err) => {
      // Without this a refused lookup left the form on its spinner with nothing said.
      setError(err.response?.data?.error || 'Could not load the Transfer Order form.');
      setLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isNew]);

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      if (isNew) {
        if (!form.withdraw_from_location_id || !form.transfer_to_location_id) {
          setError('Withdraw From and Transfer To are required.');
          return;
        }
        const bad = draftLines.find((l) => !(Number(l.qty) > 0));
        if (bad) { setError(`Enter a Qty above zero for ${bad.item_name}.`); return; }
        // Only a System Admin edits a saved TO (2026-10-19), so anyone else adds its items now.
        if (!draftLines.length && user?.account_type !== 'System Admin') { setError('Add at least one item before saving.'); return; }
        const { data } = await api.post('/transfer-orders', {
          ...form,
          lines: draftLines.map((l) => ({ item_id: l.item_id, qty: Number(l.qty), uom: l.uom, unit_used: l.unit_used, memo: l.memo || null })),
        });
        // With materials it is complete, so show it; without, open it for editing to add them.
        navigate(draftLines.length ? `/transfer-orders/${data.id}` : `/transfer-orders/${data.id}/edit`);
      } else {
        await api.put(`/transfer-orders/${id}`, form);
        navigate(`/transfer-orders/${id}`);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function addLine(item) {
    const { data } = await api.post(`/transfer-orders/${id}/lines`, {
      item_id: item.id, qty: 1, uom: item.base_unit_title, unit: item.base_unit_title,
    });
    setLines((prev) => [...prev, data]);
  }

  // Only the field that changed is sent. This used to post the whole row back, which meant the
  // Unit Used dropdown -- committed on change -- was undone by whatever input the user blurred
  // next, since that request still carried the row as it had been read.
  async function commitLine(lineId, patch) {
    const { data } = await api.put(`/transfer-orders/${id}/lines/${lineId}`, patch);
    setLines((prev) => prev.map((l) => (l.id === lineId ? { ...l, ...data } : l)));
  }

  async function removeLine(lineId) {
    if (!confirm('Remove this material?')) return;
    await api.delete(`/transfer-orders/${id}/lines/${lineId}`);
    setLines((prev) => prev.filter((l) => l.id !== lineId));
  }

  if (loading) return <LoadingSpinner />;

  const isPending = !to || to.status === 'pending_fulfillment';
  const isAdmin = user?.account_type === 'System Admin';
  // A saved TO is edited by a System Admin only, at any status (2026-10-19) -- except Withdraw From /
  // Transfer To, which stay as they are once stock has moved. A NEW one, by anyone with Can Add.
  const adminPastPending = !isPending && isAdmin;
  // ...and its requestor (who raised it, or the employee named Requestor) while Pending Fulfillment.
  const ownPending = isPending && (Number(to?.created_by_user_id) === Number(user?.id)
    || (!!user?.employee_id && Number(to?.requestor_id) === Number(user?.employee_id)));
  const canEdit = isNew ? can('/transfer-orders', 'can_add') : (isAdmin || ownPending);

  return (
    <div>
      <div className="page-header">
        <h1>{isNew ? 'Add Transfer Order' : `Transfer Order — ${to?.to_no}`}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn" to={isNew ? '/transfer-orders' : `/transfer-orders/${id}`}>Back</Link>
          {canEdit && <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>}
        </div>
      </div>

      {!isNew && to && <p className="muted" style={{ marginTop: -8 }}>{STATUS_LABELS[to.status] || to.status}{to.job_order_no ? ` · ${to.job_order_no}` : ''}</p>}
      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="review-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <div className="field">
            <label>Date Created</label>
            <input type="date" disabled={!canEdit && !isNew} value={form.date_created} onChange={(e) => setForm({ ...form, date_created: e.target.value })} />
          </div>
          <div className="field">
            <label>Date Needed</label>
            <input type="date" disabled={!canEdit && !isNew} value={form.date_needed} onChange={(e) => setForm({ ...form, date_needed: e.target.value })} />
          </div>
          <div className="field">
            <label>Withdraw From</label>
            <EntityPicker
              label="Withdraw From" items={locations} value={form.withdraw_from_location_id} getLabel={locationLabel}
              columns={[{ key: 'location_name', label: 'Name' }, { key: 'location_code', label: 'Code' }]}
              searchKeys={['location_name', 'location_code']}
              disabled={(!canEdit && !isNew) || adminPastPending}
              onSelect={(l) => setForm({ ...form, withdraw_from_location_id: l.id })}
            />
          </div>
          <div className="field">
            <label>Requestor</label>
            <EntityPicker
              label="Requestor" items={employees} value={form.requestor_id} getLabel={employeeLabel}
              columns={[{ key: 'name', label: 'Name', render: employeeLabel }, { key: 'position_title', label: 'Position' }]}
              searchKeys={['first_name', 'last_name']}
              disabled={!canEdit && !isNew}
              onSelect={(e) => setForm({ ...form, requestor_id: e.id })}
            />
          </div>
          <div className="field">
            <label>Transfer To</label>
            <EntityPicker
              label="Transfer To" items={locations} value={form.transfer_to_location_id} getLabel={locationLabel}
              columns={[{ key: 'location_name', label: 'Name' }, { key: 'location_code', label: 'Code' }]}
              searchKeys={['location_name', 'location_code']}
              disabled={(!canEdit && !isNew) || adminPastPending}
              onSelect={(l) => setForm({ ...form, transfer_to_location_id: l.id })}
            />
          </div>
          <div className="field">
            <label>Memo</label>
            <input disabled={!canEdit && !isNew} value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} />
          </div>
        </div>
      </div>

      {isNew && (
        <div className="card" style={{ marginTop: 20 }}>
          <h3 className="subsection" style={{ marginTop: 0 }}>Materials</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Item</th><th>Qty</th><th>Unit Used</th><th>Unit</th><th>Qty on Hand</th><th>Memo</th><th></th></tr></thead>
              <tbody>
                {draftLines.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No materials yet.</td></tr>}
                {draftLines.map((l, i) => {
                  const set = (patch) => setDraftLines((ls) => ls.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
                  return (
                    <tr key={i}>
                      <td>{`${l.item_code || ''} — ${l.item_name || ''}`}</td>
                      <td><input type="number" step="0.0001" min="0" style={{ width: 90 }} value={l.qty} onChange={(e) => set({ qty: e.target.value })} /></td>
                      <td>
                        <select value={l.unit_used} onChange={(e) => set({ unit_used: e.target.value })}>
                          <option value="stock">Stock Unit{l.stock_unit_title ? ` — ${l.stock_unit_title}` : ''}</option>
                          <option value="base">Base Unit{l.base_unit_title ? ` — ${l.base_unit_title}` : ''}</option>
                        </select>
                      </td>
                      <td>{l.unit_used === 'base' ? l.base_unit_title : l.stock_unit_title}</td>
                      <td>{draftOnHand(l)}</td>
                      <td><input style={{ width: 160 }} value={l.memo} onChange={(e) => set({ memo: e.target.value })} /></td>
                      <td><button type="button" className="btn btn-sm btn-danger" onClick={() => setDraftLines((ls) => ls.filter((_, idx) => idx !== i))}>Delete</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 10 }}>
            <EntityPicker
              label="Item" items={inventoryItems} value="" getLabel={(i) => i.display_name}
              columns={[{ key: 'item_code', label: 'Code' }, { key: 'display_name', label: 'Name' }]}
              searchKeys={['item_code', 'display_name']}
              // Base unit to start with, the same as Add Material on a saved TO sends.
              onSelect={(item) => setDraftLines((ls) => [...ls, {
                item_id: item.id, item_code: item.item_code, item_name: item.display_name, qty: 1,
                uom: item.base_unit_title, unit_used: 'base', memo: '',
                base_unit_title: item.base_unit_title, stock_unit_title: item.stock_unit_title,
              }])}
              triggerLabel="Add Material"
              triggerClassName="btn btn-primary"
            />
          </div>
        </div>
      )}

      {!isNew && (
        <div className="card" style={{ marginTop: 20 }}>
          <h3 className="subsection" style={{ marginTop: 0 }}>Materials</h3>
          <DataTable
            columns={[
              { key: 'item_code', label: 'Item', render: (l) => `${l.item_code || ''} — ${l.item_name || ''}` },
              { key: 'job_order_no', label: 'JO #' },
              { key: 'to_count', label: 'TO Count' },
              {
                key: 'qty', label: 'Qty',
                render: (l) => canEdit ? (
                  <input type="number" step="0.0001" style={{ width: 80 }} defaultValue={l.qty} onBlur={(e) => commitLine(l.id, { qty: e.target.value })} />
                ) : qty(l.qty),
              },
              { key: 'uom', label: 'UOM' },
              {
                // Choosing here rewrites Unit to that item's own Stock Unit or Base Unit. Qty is
                // left alone on purpose: switching to rolls is how a requestor says "send a whole
                // roll", and they re-key the 24 SQFT as 1 themselves.
                key: 'unit_used', label: 'Unit Used',
                render: (l) => canEdit ? (
                  <select
                    value={l.unit_used_resolved || 'stock'}
                    onChange={(e) => commitLine(l.id, { unit_used: e.target.value })}
                  >
                    <option value="stock">Stock Unit{l.stock_unit_title ? ` — ${l.stock_unit_title}` : ''}</option>
                    <option value="base">Base Unit{l.base_unit_title ? ` — ${l.base_unit_title}` : ''}</option>
                  </select>
                ) : (l.unit_used_resolved === 'base' ? 'Base Unit' : 'Stock Unit'),
              },
              { key: 'unit', label: 'Unit' },
              {
                key: 'adjusted_qty', label: 'Adjusted Qty',
                render: (l) => canEdit ? (
                  <input type="number" step="0.0001" style={{ width: 90 }} defaultValue={l.adjusted_qty ?? ''} onBlur={(e) => commitLine(l.id, { adjusted_qty: e.target.value })} />
                ) : (l.adjusted_qty != null ? qty(l.adjusted_qty) : ''),
              },
              { key: 'new_qty', label: 'New Qty', render: (l) => qty(l.new_qty) },
              { key: 'committed', label: 'Committed', render: (l) => qty(l.committed) },
              { key: 'fulfilled', label: 'Fulfilled', render: (l) => qty(l.fulfilled) },
              { key: 'received', label: 'Received', render: (l) => qty(l.received) },
              { key: 'back_ordered', label: 'Back Ordered', render: (l) => qty(l.back_ordered) },
              { key: 'qty_on_hand', label: 'Qty on Hand', render: (l) => qty(l.qty_on_hand) },
              {
                key: 'memo', label: 'Memo',
                render: (l) => canEdit ? (
                  <input style={{ width: 120 }} defaultValue={l.memo || ''} onBlur={(e) => commitLine(l.id, { memo: e.target.value })} />
                ) : l.memo,
              },
            ]}
            rows={lines}
            actions={canEdit ? (l) => <button className="btn btn-sm btn-danger" onClick={() => removeLine(l.id)}>Delete</button> : undefined}
            emptyLabel="No materials yet."
          />

          {canEdit && (
            <div style={{ marginTop: 10 }}>
              <EntityPicker
                label="Item" items={inventoryItems} value="" getLabel={(i) => i.display_name}
                columns={[{ key: 'item_code', label: 'Code' }, { key: 'display_name', label: 'Name' }]}
                searchKeys={['item_code', 'display_name']}
                onSelect={addLine}
                triggerLabel="Add Material"
                triggerClassName="btn btn-primary"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
