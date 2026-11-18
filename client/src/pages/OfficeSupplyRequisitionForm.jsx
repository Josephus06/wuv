import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import { headerDepartmentError } from '../utils/requireDepartment';

const STATUS_LABELS = { open: 'Open', partially_served: 'Partially Served', served: 'Served', cancelled: 'Cancelled' };
function today() { return new Date().toISOString().slice(0, 10); }
const EMPTY_LINE = { item_id: '', item_label: '', qty: 1, uom: '', unit: '', qty_served: 0, remarks: '', on_hand: null };

// Create / edit an Office Supply Requisition -- mirrors the live OSR form: Date Created / Date Needed
// / Requestor across the top, Withdraw From (location) + Transfer To (department) down the left with
// Memo alongside, then a Materials grid. The item picker is restricted to is_office_supply items.
export default function OfficeSupplyRequisitionForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [meta, setMeta] = useState(null);
  // A new requisition is needed the day it is raised unless someone says otherwise.
  const [header, setHeader] = useState({ date_created: today(), date_needed: today(), location_id: '', transfer_to_location_id: '', requestor_id: '', department_id: '', memo: '' });
  const [osrNo, setOsrNo] = useState('New');
  const [status, setStatus] = useState('open');
  const [tab, setTab] = useState('materials');
  const [lines, setLines] = useState([{ ...EMPTY_LINE }]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const { data: m } = await api.get('/office-supply-requisitions/meta');
      setMeta(m);
      // New requisition: autofill Requestor with the logged-in user's employee (and Department with
      // that employee's), and withdraw from Warehouse - Central, where office supplies are issued from.
      if (!id) {
        setHeader((h) => ({
          ...h,
          requestor_id: h.requestor_id || m.defaults?.requestor_id || '',
          department_id: h.department_id || m.defaults?.department_id || '',
          location_id: h.location_id || m.defaults?.withdraw_from_location_id || '',
        }));
      }
      if (id) {
        const { data: o } = await api.get(`/office-supply-requisitions/${id}`);
        setOsrNo(o.osr_no); setStatus(o.status);
        setHeader({
          date_created: String(o.date_created).slice(0, 10), date_needed: o.date_needed ? String(o.date_needed).slice(0, 10) : '',
          location_id: o.location_id || '', transfer_to_location_id: o.transfer_to_location_id || '', requestor_id: o.requestor_id || '', department_id: o.department_id || '', memo: o.memo || '',
        });
        setLines((o.lines || []).map((l) => ({
          item_id: l.item_id, item_label: `${l.item_code} — ${l.item_name}`, qty: Number(l.qty), uom: l.uom || '', unit: l.unit || '',
          qty_served: Number(l.qty_served), remarks: l.remarks || '', on_hand: l.on_hand,
        })));
      }
      setLoading(false);
    })().catch((e) => { setError(e.response?.data?.error || 'Failed to load.'); setLoading(false); });
  }, [id]);

  const setH = (patch) => setHeader((h) => ({ ...h, ...patch }));
  const setLine = (i, patch) => setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, { ...EMPTY_LINE }]);
  const delLine = (i) => setLines((ls) => ls.filter((_, idx) => idx !== i));

  async function refreshOnHand(i, itemId, locationId) {
    if (!itemId || !locationId) { setLine(i, { on_hand: null }); return; }
    const { data } = await api.get('/office-supply-requisitions/on-hand', { params: { item_id: itemId, location_id: locationId } });
    setLine(i, { on_hand: data.qty_on_hand });
  }
  function onLocation(locId) {
    setH({ location_id: locId });
    lines.forEach((l, i) => { if (l.item_id) refreshOnHand(i, l.item_id, locId); });
  }
  function onItem(i, item) {
    setLine(i, { item_id: item?.id || '', item_label: item ? `${item.item_code} — ${item.display_name}` : '', uom: item?.base_unit || '' });
    if (item?.id) refreshOnHand(i, item.id, header.location_id);
  }

  async function save() {
    setError('');
    const deptError = headerDepartmentError(header.department_id);
    if (deptError) { setError(deptError); return; }
    const payload = lines.filter((l) => l.item_id && Number(l.qty) > 0).map((l) => ({
      item_id: l.item_id, location_id: header.location_id || null, qty: Number(l.qty), uom: l.uom, unit: l.unit, remarks: l.remarks,
    }));
    if (!payload.length) { setError('Add at least one item with a qty.'); return; }
    setSaving(true);
    try {
      const body = { ...header, lines: payload };
      if (id) { await api.put(`/office-supply-requisitions/${id}`, body); navigate(`/office-supply-requisitions/${id}`); }
      else { const { data } = await api.post('/office-supply-requisitions', body); navigate(`/office-supply-requisitions/${data.id}`); }
    } catch (e) { setError(e.response?.data?.error || 'Save failed.'); setSaving(false); }
  }

  if (loading || !meta) return <LoadingSpinner />;

  return (
    <div>
      <div className="page-header">
        <div style={{ fontWeight: 600 }}>Office Supply Requisitions</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={'/office-supply-requisitions'}>Back to Lists</Link>
          <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <h2 style={{ margin: '0 0 2px', color: '#334155' }}>{osrNo}</h2>
        <div className="muted" style={{ marginBottom: 16 }}>{STATUS_LABELS[status] || status}</div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, alignItems: 'start' }}>
          <div className="field"><label>Date Created</label><input type="date" value={header.date_created} onChange={(e) => {
            // Date Needed follows Date Created while it still matches it; once someone has set a
            // different Date Needed, changing Date Created leaves it alone.
            const v = e.target.value;
            setHeader((h) => ({ ...h, date_created: v, date_needed: !h.date_needed || h.date_needed === h.date_created ? v : h.date_needed }));
          }} /></div>
          <div className="field"><label>Date Needed</label><input type="date" value={header.date_needed} onChange={(e) => setH({ date_needed: e.target.value })} /></div>
          <div className="field">
            <label>Requestor</label>
            <EntityPicker label="Requestor" items={meta.employees} value={header.requestor_id} getLabel={(x) => x.name}
              columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} placeholder="--Select--"
              // A Department not yet chosen follows the Requestor's own.
              onSelect={(x) => setHeader((h) => ({ ...h, requestor_id: x?.id || '', department_id: h.department_id || x?.department_id || '' }))} />
          </div>

          <div className="field">
            <label>Withdraw From</label>
            <EntityPicker label="Withdraw From" items={meta.locations} value={header.location_id} getLabel={(l) => l.location_name}
              columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']} placeholder="--Select--" onSelect={(l) => onLocation(l?.id || '')} />
          </div>
          <div className="field" style={{ gridColumn: '2 / span 2', gridRow: '2 / span 2' }}>
            <label>Memo</label>
            <textarea rows={5} value={header.memo} onChange={(e) => setH({ memo: e.target.value })} style={{ height: '100%' }} />
          </div>

          <div className="field">
            <label>Transfer To</label>
            <EntityPicker label="Transfer To" items={meta.locations} value={header.transfer_to_location_id} getLabel={(l) => l.location_name}
              columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']} placeholder="--Select--" onSelect={(l) => setH({ transfer_to_location_id: l?.id || '' })} />
          </div>
          <div className="field">
            <label>Department *</label>
            <EntityPicker label="Department" items={meta.departments} value={header.department_id} getLabel={(d) => d.name}
              columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']} placeholder="--Select--" onSelect={(d) => setH({ department_id: d?.id || '' })} />
          </div>
        </div>

        <div className="status-tabs" style={{ marginTop: 24 }}>
          <button className={`status-tab ${tab === 'materials' ? 'active' : ''}`} onClick={() => setTab('materials')}>Materials</button>
          <button className={`status-tab ${tab === 'related' ? 'active' : ''}`} onClick={() => setTab('related')}>Related Records</button>
        </div>

        {tab === 'materials' && (
          <div style={{ marginTop: 12 }}>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th><th>Item</th><th style={{ textAlign: 'right' }}>Qty</th><th>UOM</th><th>Unit</th>
                    <th style={{ textAlign: 'right' }}>Fulfilled</th><th style={{ textAlign: 'right' }}>Qty on Hand</th><th>Memo</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      <td style={{ minWidth: 280 }}>
                        <EntityPicker label="Item" items={meta.items} value={l.item_id} getLabel={(x) => `${x.item_code} — ${x.display_name}`}
                          columns={[
                            { key: 'item_code', label: 'Code' }, { key: 'display_name', label: 'Name' }, { key: 'base_unit', label: 'UOM' },
                            // Warehouse - Central's stock, from the stock ledger (see /meta).
                            { key: 'central_on_hand', label: 'On Hand (Warehouse - Central)',
                              render: (x) => (x.central_on_hand == null ? '' : Number(x.central_on_hand).toLocaleString('en-US', { maximumFractionDigits: 4 })) },
                          ]}
                          searchKeys={['item_code', 'display_name']} placeholder={l.item_label || '--Select office-supply item--'} onSelect={(x) => onItem(i, x)} />
                      </td>
                      <td><input type="number" step="0.01" style={{ width: 90, textAlign: 'right' }} value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} /></td>
                      <td><input style={{ width: 70 }} value={l.uom} onChange={(e) => setLine(i, { uom: e.target.value })} /></td>
                      <td><input style={{ width: 110 }} value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value })} /></td>
                      <td><input style={{ width: 80, textAlign: 'right' }} value={l.qty_served ?? 0} readOnly disabled /></td>
                      <td><input style={{ width: 90, textAlign: 'right' }} value={l.on_hand == null ? '' : Number(l.on_hand)} readOnly disabled /></td>
                      <td><input style={{ width: 180 }} value={l.remarks} onChange={(e) => setLine(i, { remarks: e.target.value })} /></td>
                      <td><button type="button" className="btn btn-sm btn-warning" onClick={() => delLine(i)}>Delete</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button className="btn btn-sm btn-primary" style={{ marginTop: 10 }} onClick={addLine}>Add Material</button>
            {!header.location_id && <p className="muted" style={{ marginTop: 8 }}>Pick a Withdraw From location to see Qty on Hand.</p>}
          </div>
        )}

        {tab === 'related' && (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead><tr><th>Date</th><th>Transaction #</th><th>Qty</th><th>Status</th></tr></thead>
              <tbody><tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No related records.</td></tr></tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
