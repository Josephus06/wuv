import { useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import { parseUtc } from '../utils/datetime';

const ROUTE = '/kiosk-devices';
const linkFor = (token) => `${window.location.origin}/clock/${token}`;
const when = (v) => (v ? parseUtc(v).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : 'Never');

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A plain printable sheet of new PINs, in its own window -- handed out once, never shown again.
function printPins(rows) {
  const w = window.open('', '_blank');
  if (!w) { alert('Allow pop-ups to print the PIN list.'); return; }
  const body = rows.map((r) => `<tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.employee_code)}</td><td>${escapeHtml(r.company_name)}</td><td>${escapeHtml(r.branch_name)}</td><td class="pin">${escapeHtml(r.pin)}</td></tr>`).join('');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Time Clock PINs</title><style>
    body{font-family:system-ui,sans-serif;margin:24px;color:#222}h1{font-size:18px}p{font-size:12px;color:#555}
    table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:6px 8px;font-size:13px;text-align:left}
    th{background:#f0f0f0}.pin{font-family:monospace;font-size:16px;letter-spacing:2px}
  </style></head><body><h1>Time Clock PINs</h1>
  <p>Give each employee their own PIN privately. They cannot be shown again -- a lost PIN is replaced from the employee's profile.</p>
  <table><thead><tr><th>Employee</th><th>No.</th><th>Company</th><th>Branch</th><th>PIN</th></tr></thead><tbody>${body}</tbody></table>
  <script>window.print()</script></body></html>`);
  w.document.close();
}

export default function KioskDevices() {
  const { can } = useAuth();
  const [rows, setRows] = useState([]);
  const [branches, setBranches] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ name: '', branch_id: '', is_active: true });
  const [link, setLink] = useState(null); // { name, url } shown once
  const [pinRun, setPinRun] = useState(null); // { company_id } | { generated: [] }
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  async function load() {
    setLoading(true);
    const { data } = await api.get('/kiosk-admin/devices');
    setRows(data);
    setLoading(false);
  }

  useEffect(() => {
    load();
    api.get('/schedule/branches').then(({ data }) => setBranches(data)).catch(() => {});
    api.get('/payroll-setup/companies').then(({ data }) => setCompanies(data)).catch(() => {});
  }, []);

  function open(row) {
    setForm(row ? { name: row.name, branch_id: row.branch_id || '', is_active: row.is_active } : { name: '', branch_id: '', is_active: true });
    setEditing(row || 'new');
    setError('');
  }

  async function save(e) {
    e.preventDefault();
    setError('');
    try {
      if (editing === 'new') {
        const { data } = await api.post('/kiosk-admin/devices', form);
        setLink({ name: form.name, url: linkFor(data.token) });
      } else {
        await api.put(`/kiosk-admin/devices/${editing.id}`, form);
      }
      setEditing(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    }
  }

  async function newLink(row) {
    if (!confirm(`Make a new link for "${row.name}"? The current link stops working on that device straight away.`)) return;
    const { data } = await api.post(`/kiosk-admin/devices/${row.id}/new-link`);
    setLink({ name: row.name, url: linkFor(data.token) });
    load();
  }

  async function toggle(row) {
    await api.put(`/kiosk-admin/devices/${row.id}`, { name: row.name, branch_id: row.branch_id, is_active: !row.is_active });
    load();
  }

  async function remove(row) {
    if (!confirm(`Delete "${row.name}"?`)) return;
    try {
      await api.delete(`/kiosk-admin/devices/${row.id}`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Delete failed');
    }
  }

  async function copyLink() {
    try { await navigator.clipboard.writeText(link.url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* select it by hand */ }
  }

  async function generatePins(e) {
    e.preventDefault();
    if (!confirm('Give a new PIN to every active employee who does not have one yet? Employees who already have a PIN keep it.')) return;
    try {
      const { data } = await api.post('/kiosk-admin/pins', { company_id: pinRun.company_id || undefined });
      setPinRun({ generated: data.generated });
    } catch (err) {
      setError(err.response?.data?.error || 'Could not generate PINs');
    }
  }

  const columns = [
    { key: 'name', label: 'Device', render: (r) => <><strong>{r.name}</strong>{r.branch_name && <div className="muted" style={{ fontSize: 11 }}>{r.branch_name}</div>}</> },
    { key: 'is_active', label: 'Status', render: (r) => (r.is_active ? <span className="badge badge-success">On</span> : <span className="badge badge-muted">Off</span>) },
    { key: 'last_used_at', label: 'Last Used', render: (r) => when(r.last_used_at) },
    { key: 'stamp_count', label: 'Stamps' },
    { key: 'created_by', label: 'Added By', render: (r) => <>{r.created_by || '—'}<div className="muted" style={{ fontSize: 11 }}>{when(r.created_at)}</div></> },
  ];

  return (
    <div>
      <div className="page-header">
        <h1>Time Clock Devices</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {can('/employees', 'can_edit') && <button className="btn" onClick={() => { setPinRun({ company_id: '' }); setError(''); }}>Give PINs to Employees</button>}
          {can(ROUTE, 'can_add') && <button className="btn btn-primary" onClick={() => open(null)}>Add Device</button>}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <p style={{ margin: 0 }}>
          A <strong>time clock</strong> is a branch tablet or PC where employees time in and out with their own 6-digit PIN,
          without logging in. Add a device here, then open its link once on that device and leave it on the time clock screen.
          Only registered devices can record time, and each record shows which device it came from.
        </p>
        <p className="muted" style={{ margin: '8px 0 0' }}>
          Each employee&apos;s PIN is set in their profile (Employees → Edit → Employment Info), or for everyone at once with
          <em> Give PINs to Employees</em>.
        </p>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <DataTable
            columns={columns}
            rows={rows}
            emptyLabel="No time clock devices yet."
            actions={(row) => (
              <>
                {can(ROUTE, 'can_edit') && <button className="btn btn-sm" onClick={() => open(row)}>Edit</button>}
                {can(ROUTE, 'can_edit') && <button className="btn btn-sm" onClick={() => newLink(row)}>New Link</button>}
                {can(ROUTE, 'can_edit') && <button className="btn btn-sm" onClick={() => toggle(row)}>{row.is_active ? 'Turn Off' : 'Turn On'}</button>}
                {can(ROUTE, 'can_delete') && row.stamp_count === 0 && <button className="btn btn-sm btn-danger" onClick={() => remove(row)}>Delete</button>}
              </>
            )}
          />
        )}
      </div>

      {editing && (
        <Modal title={editing === 'new' ? 'Add Time Clock Device' : 'Edit Device'} onClose={() => setEditing(null)}>
          <form onSubmit={save}>
            {error && <div className="error-banner">{error}</div>}
            <div className="field">
              <label>Device Name</label>
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Seaside front-desk tablet" />
            </div>
            <div className="field">
              <label>Branch</label>
              <select value={form.branch_id} onChange={(e) => setForm({ ...form, branch_id: e.target.value })}>
                <option value="">—</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            {editing !== 'new' && (
              <div className="field field-checkbox">
                <input type="checkbox" id="kiosk-on" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
                <label htmlFor="kiosk-on">On (records time)</label>
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary">{editing === 'new' ? 'Add & Get Link' : 'Save'}</button>
            </div>
          </form>
        </Modal>
      )}

      {link && (
        <Modal title={`Time clock link · ${link.name}`} onClose={() => setLink(null)}>
          <p>Open this link <strong>on the device itself</strong>, then leave the browser on that page (bookmark it or add it to the home screen).</p>
          <div className="kiosk-link-box">
            <input readOnly value={link.url} onFocus={(e) => e.target.select()} />
            <button type="button" className="btn btn-primary" onClick={copyLink}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
          <p className="warning-banner" style={{ marginTop: 12 }}>
            This link is shown only now. Anyone who has it can use this time clock, so don&apos;t post it in a group chat.
            If it leaks or is lost, use <em>New Link</em> — the old one stops working.
          </p>
          <div className="modal-actions">
            <a className="btn" href={link.url} target="_blank" rel="noreferrer">Open on this computer</a>
            <button type="button" className="btn btn-primary" onClick={() => setLink(null)}>Done</button>
          </div>
        </Modal>
      )}

      {pinRun && (
        <Modal title="Give PINs to Employees" onClose={() => setPinRun(null)} large={!!pinRun.generated}>
          {error && <div className="error-banner">{error}</div>}
          {!pinRun.generated ? (
            <form onSubmit={generatePins}>
              <p>Every active employee <strong>without</strong> a PIN gets a new one. Employees who already have a PIN keep it.</p>
              <div className="field">
                <label>Company</label>
                <select value={pinRun.company_id} onChange={(e) => setPinRun({ company_id: e.target.value })}>
                  <option value="">All companies</option>
                  {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="modal-actions">
                <button type="button" className="btn" onClick={() => setPinRun(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary">Generate PINs</button>
              </div>
            </form>
          ) : pinRun.generated.length === 0 ? (
            <>
              <p>Everyone already has a PIN. To replace one, open the employee&apos;s profile.</p>
              <div className="modal-actions"><button type="button" className="btn btn-primary" onClick={() => setPinRun(null)}>OK</button></div>
            </>
          ) : (
            <>
              <p className="warning-banner">Print or note these now — they cannot be shown again. Hand each PIN to its employee privately.</p>
              <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
                <table>
                  <thead><tr><th>Employee</th><th>Company</th><th>Branch</th><th>PIN</th></tr></thead>
                  <tbody>
                    {pinRun.generated.map((g) => (
                      <tr key={g.id}><td>{g.name}</td><td>{g.company_name || '—'}</td><td>{g.branch_name || '—'}</td><td className="kiosk-pin">{g.pin}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="modal-actions">
                <button type="button" className="btn" onClick={() => printPins(pinRun.generated)}>Print List</button>
                <button type="button" className="btn btn-primary" onClick={() => setPinRun(null)}>Done</button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
