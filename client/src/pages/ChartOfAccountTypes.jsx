import { useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayAuditTime } from '../utils/dates';

// Mirrors the real system's "Accounting > Chart of Account Types" screen: the real
// (Account Type, Account Sub-Type) pairing with its Normal Balance -- fully migrated
// from the live site (23 rows across ASSET/LIABILITY/EQUITY/INCOME/EXPENSE).
const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];
const EMPTY = { account_type: '', account_sub_type: '', normal_balance: '' };

export default function ChartOfAccountTypes() {
  const { can } = useAuth();
  const [rows, setRows] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [auditLogs, setAuditLogs] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  async function load(searchValue = search) {
    setLoading(true);
    const { data } = await api.get('/chart-of-account-types', { params: searchValue ? { search: searchValue } : {} });
    setRows(data);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function openCreate() {
    setForm(EMPTY);
    setEditing('new');
    setAuditLogs([]);
    setError('');
  }

  async function openEdit(row) {
    setForm({ account_type: row.account_type, account_sub_type: row.account_sub_type, normal_balance: row.normal_balance });
    setEditing(row);
    setError('');
    const { data } = await api.get(`/chart-of-account-types/${row.id}/audit-logs`);
    setAuditLogs(data);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    try {
      if (editing === 'new') {
        await api.post('/chart-of-account-types', form);
        setEditing(null);
      } else {
        await api.put(`/chart-of-account-types/${editing.id}`, form);
      }
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    }
  }

  async function handleDelete(row) {
    if (!confirm(`Delete "${row.account_type} — ${row.account_sub_type}"?`)) return;
    try {
      await api.delete(`/chart-of-account-types/${row.id}`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Delete failed');
    }
  }

  const columns = [
    { key: 'account_type', label: 'Account Type' },
    { key: 'account_sub_type', label: 'Account Sub-Type' },
    { key: 'normal_balance', label: 'Normal Balance' },
  ];

  return (
    <div>
      <div className="page-header">
        <h1>Chart of Account Types</h1>
        {can('/chart-of-account-types', 'can_add') && <button className="btn btn-primary" onClick={openCreate}>Add New</button>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Search</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load(search)} placeholder="Account Type or Sub-Type..." />
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => load(search)}>Search</button>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <DataTable
            paginate
            columns={columns}
            rows={rows}
            actions={(row) => (
              <>
                {can('/chart-of-account-types', 'can_edit') && <button className="btn btn-sm" onClick={() => openEdit(row)}>Update</button>}
                {can('/chart-of-account-types', 'can_delete') && <button className="btn btn-sm btn-danger" onClick={() => handleDelete(row)}>Delete</button>}
              </>
            )}
          />
        )}
      </div>

      {editing && (
        <Modal title={editing === 'new' ? 'Add / Update Chart of Account Type' : `Edit — ${editing.account_type} / ${editing.account_sub_type}`} onClose={() => setEditing(null)}>
          <form onSubmit={handleSubmit}>
            {error && <div className="error-banner">{error}</div>}
            <div className="field">
              <label>Account Type</label>
              <select required value={form.account_type} onChange={(e) => setForm({ ...form, account_type: e.target.value })}>
                <option value="">--Select--</option>
                {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Account Sub-Type</label>
              <input required value={form.account_sub_type} onChange={(e) => setForm({ ...form, account_sub_type: e.target.value })} />
            </div>
            <div className="field">
              <label>Normal Balance</label>
              <select required value={form.normal_balance} onChange={(e) => setForm({ ...form, normal_balance: e.target.value })}>
                <option value="">--Select--</option>
                <option value="DEBIT">DEBIT</option>
                <option value="CREDIT">CREDIT</option>
              </select>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setEditing(null)}>Close</button>
              <button type="submit" className="btn btn-primary">Save</button>
            </div>
          </form>

          {editing !== 'new' && (
            <div className="subsection">
              <h3>System Information</h3>
              <DataTable
                columns={[
                  { key: 'set_at', label: 'Date Time', render: (r) => displayAuditTime(r.set_at) },
                  { key: 'set_by_name', label: 'Set By' },
                  { key: 'event_type', label: 'Type' },
                  { key: 'field_name', label: 'Field' },
                  { key: 'old_value', label: 'Old Value' },
                  { key: 'new_value', label: 'New Value' },
                ]}
                rows={auditLogs}
                emptyLabel="No audit history yet."
              />
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
