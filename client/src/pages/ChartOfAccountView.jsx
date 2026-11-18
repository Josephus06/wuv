import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayAuditTime } from '../utils/dates';

const YES_NO = (v) => (v ? 'Yes' : 'No');

export default function ChartOfAccountView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('details');
  const [auditLogs, setAuditLogs] = useState([]);

  useEffect(() => {
    api.get(`/chart-of-accounts/${id}`).then(({ data }) => { setAccount(data); setLoading(false); });
  }, [id]);

  useEffect(() => {
    if (tab === 'system') api.get(`/chart-of-accounts/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
  }, [tab, id]);

  if (loading || !account) return <LoadingSpinner />;

  const canEdit = can('/chart-of-accounts', 'can_edit');

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={'/chart-of-accounts'}>Back to Lists</Link>
          {canEdit && <Link className="btn btn-sm btn-primary" to={`/chart-of-accounts/${id}/edit`}>Edit</Link>}
        </div>
      </div>

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Chart of Account</h1>
          <span className="estimate-no">{account.account_code}</span>
        </div>
        <div className="estimate-status">{account.is_active ? 'Active' : 'Inactive'}</div>

        <div className="estimate-detail-grid">
          <div>
            <h4>Details</h4>
            <div>Account Title : <span className="hi">{account.account_name}</span></div>
            <div>Description : <span className="hi">{account.description}</span></div>
            <div>Detail Type : <span className="hi">{account.detail_type}</span></div>
          </div>
          <div>
            <h4>Classification</h4>
            <div>Account Type : <span className="hi">{account.coa_account_type}</span></div>
            <div>Account Sub-Type : <span className="hi">{account.account_sub_type}</span></div>
            <div>Normal Balance : <span className="hi">{account.normal_balance}</span></div>
            <div>Is Summary : <span className="hi">{YES_NO(account.is_summary)}</span></div>
          </div>
          <div>
            <h4>Hierarchy</h4>
            <div>Parent Account : {account.parent_account_code ? (
              <Link className="link-btn" to={`/chart-of-accounts/${account.parent_account_id}`}>
                {account.parent_account_code} — {account.parent_account_name}
              </Link>
            ) : <span className="hi">—</span>}</div>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'details' ? 'active' : ''}`} onClick={() => setTab('details')}>Sub-Accounts</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'details' && (
        <div className="card">
          <DataTable
            columns={[
              { key: 'account_code', label: 'Account Code' },
              { key: 'account_name', label: 'Account Title' },
            ]}
            rows={account.children || []}
            actions={(c) => <Link className="btn btn-sm btn-primary" to={`/chart-of-accounts/${c.id}`}>View</Link>}
            emptyLabel="No sub-accounts."
          />
        </div>
      )}

      {tab === 'system' && (
        <div className="card">
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
