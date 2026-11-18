import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import Modal from '../components/Modal';

// The coverages a line can carry, as the source's Coverages picker lists them (2026-10-28). A line
// may carry several; they are saved as one comma-separated text.
const COVERAGES = [
  'Structural',
  'Electrical',
  'Sticker Printing Without Laminate (Non 3M)',
  'Sticker Printing With Cold UV Laminate (Non 3M)',
  'Sticker Printing Without Laminate (3M)',
  'Sticker Printing With Cold UV Laminate (3M)',
  'Flex Printing (Non 3M)',
  'Flex Printing (3M)',
];
const splitCoverage = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

function CoverageModal({ value, onDone, onClose }) {
  const [picked, setPicked] = useState(() => splitCoverage(value));
  const toggle = (c) => setPicked((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]));
  // Kept in the list's order, whatever order they were ticked in; an older free-text coverage stays.
  const done = () => onDone([...COVERAGES.filter((c) => picked.includes(c)), ...picked.filter((c) => !COVERAGES.includes(c))].join(', '));
  return (
    <Modal title="Coverages" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {[...COVERAGES, ...picked.filter((c) => !COVERAGES.includes(c))].map((c) => (
          <label key={c} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px', borderBottom: '1px solid var(--border, #e2e8f0)', cursor: 'pointer', fontWeight: 400 }}>
            <input type="checkbox" checked={picked.includes(c)} onChange={() => toggle(c)} style={{ width: 'auto' }} />
            {c}
          </label>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
        <button className="btn btn-primary" onClick={done}>Done</button>
      </div>
    </Modal>
  );
}

function today() { return new Date().toISOString().slice(0, 10); }
function plusYear(d) {
  if (!d) return '';
  const dt = new Date(`${String(d).slice(0, 10)}T00:00:00`);
  dt.setFullYear(dt.getFullYear() + 1);
  return dt.toISOString().slice(0, 10);
}

// Create / edit a Warranty Certificate. Pick a BILLED Sales Order -> autofill customer/contact/
// address/project and pull its job orders in as warranty lines (coverage = job type; warranty
// defaults to one year from the SO date, editable). Extended warranty dates are optional per line.
export default function WarrantyCertificateForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [billedSos, setBilledSos] = useState([]);
  const [header, setHeader] = useState({
    date_created: today(), sales_order_id: '', sales_order_no: '', customer_id: '', contact_person_id: '',
    contact_name: '', contact_number: '', address: '', contract_description: '',
  });
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [coverageFor, setCoverageFor] = useState(null);

  useEffect(() => {
    (async () => {
      const { data: sos } = await api.get('/warranty-certificates/billable-sales-orders');
      setBilledSos(sos);
      if (id) {
        const { data: wc } = await api.get(`/warranty-certificates/${id}`);
        setHeader({
          date_created: String(wc.date_created).slice(0, 10), sales_order_id: wc.sales_order_id || '', sales_order_no: wc.sales_order_no || '',
          customer_id: wc.customer_id || '', contact_person_id: wc.contact_person_id || '', contact_name: wc.contact_name || '',
          contact_number: wc.contact_number || '', address: wc.address || '', contract_description: wc.contract_description || '',
        });
        setLines((wc.lines || []).map((l) => ({
          job_order_id: l.job_order_id, job_order_no: l.job_order_no, job_description: l.job_description, coverage: l.coverage,
          warranty_date_from: l.warranty_date_from ? String(l.warranty_date_from).slice(0, 10) : '',
          warranty_date_to: l.warranty_date_to ? String(l.warranty_date_to).slice(0, 10) : '',
          remarks: l.remarks || '', ext_warranty_date_from: l.ext_warranty_date_from ? String(l.ext_warranty_date_from).slice(0, 10) : '',
          ext_warranty_date_to: l.ext_warranty_date_to ? String(l.ext_warranty_date_to).slice(0, 10) : '', ext_remarks: l.ext_remarks || '',
        })));
      }
      setLoading(false);
    })().catch((e) => { setError(e.response?.data?.error || 'Failed to load.'); setLoading(false); });
  }, [id]);

  const setH = (patch) => setHeader((h) => ({ ...h, ...patch }));
  // Searched on the server (2026-11-11): the first load is only the newest 500 billed orders, so an
  // older one (SO-67488) never showed when filtered in the browser.
  const searchSos = (q) => api.get('/warranty-certificates/billable-sales-orders', { params: { search: q } }).then(({ data }) => setBilledSos(data));
  const setLine = (i, patch) => setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const delLine = (i) => setLines((ls) => ls.filter((_, idx) => idx !== i));

  async function onSelectSo(so) {
    if (!so) return;
    const { data } = await api.get(`/warranty-certificates/source-sales-order/${so.id}`);
    const s = data.sales_order;
    setH({
      sales_order_id: s.id, sales_order_no: s.sales_order_no, customer_id: s.customer_id || '', contact_person_id: s.contact_person_id || '',
      contact_name: s.contact_name || '', contact_number: s.contact_number || s.contact_phone || '',
      address: s.address || s.shipping_address || '', contract_description: s.contract_description || '',
    });
    const from = String(s.date_created).slice(0, 10);
    setLines((data.job_orders || []).map((j) => ({
      // Coverage starts empty, picked per line from the Coverages list (as the source does).
      job_order_id: j.job_order_id, job_order_no: j.job_order_no, job_description: j.job_description, coverage: '',
      warranty_date_from: from, warranty_date_to: plusYear(from), remarks: '', ext_warranty_date_from: '', ext_warranty_date_to: '', ext_remarks: '',
    })));
  }

  async function save() {
    setError('');
    if (!header.sales_order_id) { setError('Select a billed Sales Order.'); return; }
    setSaving(true);
    try {
      const body = { ...header, lines };
      if (id) { await api.put(`/warranty-certificates/${id}`, body); navigate(`/warranty-certificates/${id}`); }
      else { const { data } = await api.post('/warranty-certificates', body); navigate(`/warranty-certificates/${data.id}`); }
    } catch (e) { setError(e.response?.data?.error || 'Save failed.'); setSaving(false); }
  }

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="page-header">
        <div style={{ fontWeight: 600 }}>Warranty Certificate <span className="muted">/ {id ? 'Edit' : 'Create'}</span></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={'/warranty-certificates'}>Back to Lists</Link>
          <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="field"><label>Date Created</label><input type="date" value={header.date_created} onChange={(e) => setH({ date_created: e.target.value })} /></div>
            <div className="field">
              <label>SO # <span className="muted">(billed only)</span></label>
              <EntityPicker label="Sales Order" items={billedSos} value={header.sales_order_id} getLabel={(s) => s.sales_order_no}
                columns={[{ key: 'sales_order_no', label: 'SO #' }, { key: 'customer_name', label: 'Customer' }, { key: 'contract_description', label: 'Project' }]}
                searchKeys={['sales_order_no', 'customer_name']} placeholder={header.sales_order_no || '--Select--'} onSelect={onSelectSo} onSearch={searchSos} disabled={!!id} />
            </div>
            <div className="field"><label>Customer</label><input value={billedSos.find((s) => String(s.id) === String(header.sales_order_id))?.customer_name || header.customer_name || ''} readOnly disabled /></div>
            <div className="field"><label>Contact Name</label><input value={header.contact_name} onChange={(e) => setH({ contact_name: e.target.value })} /></div>
            <div className="field"><label>Contact Number</label><input value={header.contact_number} onChange={(e) => setH({ contact_number: e.target.value })} /></div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="field"><label>Contract Description</label><textarea rows={4} value={header.contract_description} onChange={(e) => setH({ contract_description: e.target.value })} /></div>
            <div className="field"><label>Address</label><textarea rows={4} value={header.address} onChange={(e) => setH({ address: e.target.value })} /></div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="status-tabs" style={{ marginBottom: 8 }}><button className="status-tab active">Job Orders</button></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th></th><th>Job Order #</th><th>Job Description</th><th>Coverage</th>
                <th>Warranty From</th><th>Warranty To</th><th>Remarks</th>
                <th>Ext. From</th><th>Ext. To</th><th>Ext. Remarks</th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 16 }}>Pick a Sales Order to load its job orders.</td></tr>}
              {lines.map((l, i) => (
                <tr key={i}>
                  <td><button type="button" className="btn btn-sm btn-warning" onClick={() => delLine(i)}>✕</button></td>
                  <td>{l.job_order_no}</td>
                  <td style={{ minWidth: 220 }}><input value={l.job_description || ''} onChange={(e) => setLine(i, { job_description: e.target.value })} style={{ width: '100%' }} /></td>
                  <td style={{ minWidth: 200 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <button type="button" className="btn btn-sm btn-primary" onClick={() => setCoverageFor(i)}>Coverage</button>
                      <span style={{ fontSize: 12 }}>{l.coverage}</span>
                    </div>
                  </td>
                  <td><input type="date" value={l.warranty_date_from || ''} onChange={(e) => setLine(i, { warranty_date_from: e.target.value })} /></td>
                  <td><input type="date" value={l.warranty_date_to || ''} onChange={(e) => setLine(i, { warranty_date_to: e.target.value })} /></td>
                  <td><input value={l.remarks || ''} onChange={(e) => setLine(i, { remarks: e.target.value })} style={{ width: 120 }} /></td>
                  <td><input type="date" value={l.ext_warranty_date_from || ''} onChange={(e) => setLine(i, { ext_warranty_date_from: e.target.value })} /></td>
                  <td><input type="date" value={l.ext_warranty_date_to || ''} onChange={(e) => setLine(i, { ext_warranty_date_to: e.target.value })} /></td>
                  <td><input value={l.ext_remarks || ''} onChange={(e) => setLine(i, { ext_remarks: e.target.value })} style={{ width: 120 }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {coverageFor !== null && (
        <CoverageModal
          value={lines[coverageFor]?.coverage}
          onClose={() => setCoverageFor(null)}
          onDone={(v) => { setLine(coverageFor, { coverage: v }); setCoverageFor(null); }}
        />
      )}
    </div>
  );
}
