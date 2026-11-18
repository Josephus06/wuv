import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import EntityPicker from '../components/EntityPicker';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDate } from '../utils/dates';

const EMPTY = { company_name: '', contact_name: '', email: '', phone: '', source: '', sales_rep_id: '', memo: '' };
const SOURCES = ['Referral', 'Website', 'Cold Call', 'Walk-in', 'Social Media', 'Trade Show', 'Other'];
const STATUS_LABELS = { new: 'New', contacted: 'Contacted', qualified: 'Qualified', unqualified: 'Unqualified', converted: 'Converted' };
const STATUS_BADGE = { new: 'badge-muted', contacted: 'badge-info', qualified: 'badge-success', unqualified: 'badge-danger', converted: 'badge-success' };

function formatDate(v) { return v ? displayDate(v) : '—'; }

// A Lead is a prospect that isn't a real Customer yet -- no real ERP transaction
// (Estimate, Sales Order, etc.) can reference it, only crm_activities. Converting
// spawns a real `customers` row (server/src/routes/leads.js's POST /:id/convert), at
// which point the Lead becomes read-only history and the customer can start getting
// real Estimates -- which is what actually drives the CRM Pipeline now (see
// server/src/routes/crmPipeline.js), not a manually-tracked Opportunity stage.
export default function Leads() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({});
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [employees, setEmployees] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    const params = {};
    if (status) params.status = status;
    if (search) params.search = search;
    const [l, emp] = await Promise.all([
      api.get('/leads', { params }),
      api.get('/employees'),
    ]);
    setRows(l.data.rows);
    setCounts(l.data.counts);
    setEmployees(emp.data);
    setLoading(false);
  }

  useEffect(() => { load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  function openCreate() {
    setForm(EMPTY);
    setEditing('new');
    setError('');
  }

  function openEdit(row) {
    setForm({
      company_name: row.company_name, contact_name: row.contact_name || '', email: row.email || '',
      phone: row.phone || '', source: row.source || '', sales_rep_id: row.sales_rep_id || '', memo: row.memo || '',
    });
    setEditing(row);
    setError('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const payload = { ...form, sales_rep_id: form.sales_rep_id || null };
    try {
      if (editing === 'new') {
        await api.post('/leads', payload);
      } else {
        await api.put(`/leads/${editing.id}`, { ...payload, status: editing.status });
      }
      setEditing(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleConvert(row) {
    if (!confirm(`Convert "${row.company_name}" to a Customer? This creates a real Customer record from this lead's info.`)) return;
    try {
      const { data } = await api.post(`/leads/${row.id}/convert`);
      await load();
      navigate(`/customers/${data.id}`);
    } catch (err) {
      alert(err.response?.data?.error || 'Convert failed');
    }
  }

  const columns = [
    { key: 'lead_no', label: 'Lead #' },
    { key: 'company_name', label: 'Company' },
    { key: 'contact_name', label: 'Contact' },
    { key: 'phone', label: 'Phone' },
    { key: 'sales_rep_name', label: 'Sales Rep', render: (r) => r.sales_rep_name || '—' },
    { key: 'status', label: 'Status', render: (r) => <span className={`badge ${STATUS_BADGE[r.status] || 'badge-muted'}`}>{STATUS_LABELS[r.status] || r.status}</span> },
    { key: 'created_at', label: 'Created', render: (r) => formatDate(r.created_at) },
  ];

  return (
    <div>
      <div className="page-header">
        <h1>Leads</h1>
        {can('/leads', 'can_add') && <button className="btn btn-primary" onClick={openCreate}>Add Lead</button>}
      </div>

      <div className="status-tabs">
        <button className={`status-tab ${status === '' ? 'active' : ''}`} onClick={() => setStatus('')}>All</button>
        {Object.entries(STATUS_LABELS).map(([key, label]) => (
          <button key={key} className={`status-tab ${status === key ? 'active' : ''}`} onClick={() => setStatus(key)}>
            {label} {counts[key] ? `(${counts[key]})` : ''}
          </button>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 16, marginTop: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Search</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} placeholder="Lead #, company, contact..." />
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={load}>Search</button>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <DataTable
            paginate
            columns={columns}
            rows={rows}
            actions={(row) => (
              <>
                {can('/leads', 'can_edit') && row.status !== 'converted' && <button className="btn btn-sm" onClick={() => openEdit(row)}>Edit</button>}
                {can('/leads', 'can_edit') && row.status !== 'converted' && <button className="btn btn-sm btn-primary" onClick={() => handleConvert(row)}>Convert</button>}
                {row.status === 'converted' && row.converted_customer_id && (
                  <Link className="btn btn-sm" to={`/customers/${row.converted_customer_id}`}>View Customer</Link>
                )}
              </>
            )}
          />
        )}
      </div>

      {editing && (
        <Modal title={editing === 'new' ? 'Add Lead' : `Edit Lead — ${editing.lead_no}`} onClose={() => setEditing(null)}>
          <form onSubmit={handleSubmit}>
            {error && <div className="error-banner">{error}</div>}
            <div className="field-row">
              <div className="field">
                <label>Company Name</label>
                <input required value={form.company_name} onChange={(e) => setForm({ ...form, company_name: e.target.value })} />
              </div>
              <div className="field">
                <label>Contact Name</label>
                <input value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Email</label>
                <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="field">
                <label>Phone</label>
                <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Source</label>
                <select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
                  <option value="">—</option>
                  {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Sales Rep</label>
                <EntityPicker
                  label="Sales Rep" items={employees} value={form.sales_rep_id}
                  getLabel={(e) => e && `${e.first_name} ${e.last_name}`}
                  columns={[{ key: 'first_name', label: 'First Name' }, { key: 'last_name', label: 'Last Name' }]}
                  searchKeys={['first_name', 'last_name']}
                  onSelect={(e) => setForm({ ...form, sales_rep_id: e.id })}
                />
              </div>
            </div>
            <div className="field">
              <label>Memo</label>
              <textarea rows={3} value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setEditing(null)}>Close</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>Save</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
