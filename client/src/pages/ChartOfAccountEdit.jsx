import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import DataTable from '../components/DataTable';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayAuditTime } from '../utils/dates';

// Mirrors the real system's "Add/Update Chart of Account" form. The real system's own
// Chart of Account Type picker doubles as both the Type and Sub-Type selection (picking
// one row sets both, plus its Normal Balance) -- same EntityPicker pattern used
// throughout this app rather than two dependent dropdowns.
function coaTypeLabel(t) { return t ? `${t.account_type} — ${t.account_sub_type}` : ''; }
function accountLabel(a) { return a ? `${a.account_code} — ${a.account_name}` : ''; }

const EMPTY = {
  account_code: '', account_name: '', description: '', coa_type_id: '', parent_account_id: '',
  detail_type: '', is_summary: false, is_active: true,
};

export default function ChartOfAccountEdit() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();

  const [form, setForm] = useState(EMPTY);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [auditLogs, setAuditLogs] = useState([]);

  const [coaTypes, setCoaTypes] = useState([]);
  const [accounts, setAccounts] = useState([]);

  useEffect(() => {
    Promise.all([
      api.get('/chart-of-account-types'),
      api.get('/chart-of-accounts', { params: { limit: 1000 } }),
      isNew ? Promise.resolve(null) : api.get(`/chart-of-accounts/${id}`),
    ]).then(([typesRes, acctRes, detailRes]) => {
      setCoaTypes(typesRes.data);
      setAccounts(acctRes.data.rows);
      if (detailRes) {
        const d = detailRes.data;
        setForm({
          account_code: d.account_code, account_name: d.account_name, description: d.description || '',
          coa_type_id: d.coa_type_id || '', parent_account_id: d.parent_account_id || '',
          detail_type: d.detail_type || '', is_summary: !!d.is_summary, is_active: !!d.is_active,
        });
      }
      setLoading(false);
    });
  }, [id, isNew]);

  useEffect(() => {
    if (!isNew) api.get(`/chart-of-accounts/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
  }, [id, isNew]);

  async function handleSave() {
    setSaving(true);
    setError('');
    const payload = { ...form, coa_type_id: form.coa_type_id || null, parent_account_id: form.parent_account_id || null };
    try {
      if (isNew) {
        const { data } = await api.post('/chart-of-accounts', payload);
        navigate(`/chart-of-accounts/${data.id}`);
      } else {
        await api.put(`/chart-of-accounts/${id}`, payload);
        navigate(`/chart-of-accounts/${id}`);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingSpinner />;

  const otherAccounts = accounts.filter((a) => a.id !== Number(id));

  return (
    <div>
      <div className="page-header">
        <h1>{isNew ? 'Add Chart of Account' : `Chart of Account — ${form.account_code}`}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn" to={isNew ? '/chart-of-accounts' : `/chart-of-accounts/${id}`}>Back</Link>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="field"><label>Account Code</label><input required value={form.account_code} onChange={(e) => setForm({ ...form, account_code: e.target.value })} /></div>
          <div className="field"><label>Account Title</label><input required value={form.account_name} onChange={(e) => setForm({ ...form, account_name: e.target.value })} /></div>
          <div className="field">
            <label>Chart of Account Type</label>
            <EntityPicker
              label="Chart of Account Type" items={coaTypes} value={form.coa_type_id} getLabel={coaTypeLabel}
              columns={[{ key: 'account_type', label: 'Account Type' }, { key: 'account_sub_type', label: 'Sub-Type' }, { key: 'normal_balance', label: 'Normal Balance' }]}
              searchKeys={['account_type', 'account_sub_type']}
              onSelect={(t) => setForm({ ...form, coa_type_id: t.id })}
            />
          </div>
          <div className="field" style={{ gridColumn: 'span 2' }}>
            <label>Description</label>
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="field">
            <label>Parent Account</label>
            <EntityPicker
              label="Parent Account" items={otherAccounts} value={form.parent_account_id} getLabel={accountLabel}
              columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Title' }]}
              searchKeys={['account_code', 'account_name']}
              onSelect={(a) => setForm({ ...form, parent_account_id: a.id })}
            />
          </div>
          <div className="field"><label>Detail Type</label><input value={form.detail_type} onChange={(e) => setForm({ ...form, detail_type: e.target.value })} /></div>
        </div>
        <div className="field-row" style={{ marginTop: 12 }}>
          <div className="field field-checkbox">
            <input type="checkbox" id="coa-summary" checked={form.is_summary} onChange={(e) => setForm({ ...form, is_summary: e.target.checked })} />
            <label htmlFor="coa-summary">Is Summary</label>
          </div>
          <div className="field field-checkbox">
            <input type="checkbox" id="coa-active" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
            <label htmlFor="coa-active">Active</label>
          </div>
        </div>
      </div>

      {!isNew && (
        <div className="card" style={{ marginTop: 20 }}>
          <h3 className="subsection" style={{ marginTop: 0 }}>System Information</h3>
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
    </div>
  );
}
