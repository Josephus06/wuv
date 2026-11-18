import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';
import PermissionTemplateModal from '../components/PermissionTemplateModal';

import { displayDateTime } from '../utils/dates';
import { ACCOUNT_TYPE_OPTIONS } from '../utils/accountTypes';

export default function Users() {
  const { can, user, impersonate } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showTemplates, setShowTemplates] = useState(false);
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState(null);
  const isAdmin = user?.account_type === 'System Admin';

  // Lands on the dashboard rather than staying here: this page needs can_view on /users,
  // which the target user probably does not have, so remaining would just 403.
  async function loginAs(row) {
    if (!confirm(`Sign in as "${row.display_name || row.username}"?\n\nYou will see the system exactly as they do. This is recorded against their account, and you can return at any time from the banner.`)) return;
    setBusyId(row.id);
    try {
      await impersonate(row.id);
      navigate('/dashboard');
    } catch (err) {
      alert(err.response?.data?.error || 'Could not sign in as that user.');
    } finally {
      setBusyId(null);
    }
  }

  async function load() {
    setLoading(true);
    const { data } = await api.get('/users');
    setRows(data);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleDelete(row) {
    if (!confirm(`Delete user "${row.username}"?`)) return;
    try {
      await api.delete(`/users/${row.id}`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Delete failed');
    }
  }

  // Filtered in the browser rather than round-tripping: /users returns the whole list already,
  // and it is small enough that typing should filter as you type.
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => [
      r.username, r.account_type, r.display_name, r.email, r.default_branch_name,
    ].filter(Boolean).join(' ').toLowerCase().includes(q));
  }, [rows, search]);

  const columns = [
    { key: 'username', label: 'Username' },
    { key: 'account_type', label: 'Account Type' },
    { key: 'display_name', label: 'Name' },
    { key: 'email', label: 'Email' },
    { key: 'default_branch_name', label: 'Default Branch' },
    { key: 'last_login_at', label: 'Last Login', render: (r) => (r.last_login_at ? displayDateTime(r.last_login_at) : '—') },
    { key: 'is_active', label: 'Status', render: (r) => (r.is_active ? <span className="badge badge-success">Active</span> : <span className="badge badge-muted">Inactive</span>) },
  ];

  return (
    <div>
      <div className="page-header">
        <h1>Users</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {can('/users', 'can_view') && (
            <button className="btn" onClick={() => setShowTemplates(true)}>Permission Templates</button>
          )}
          {can('/users', 'can_add') && <Link className="btn btn-primary" to={'/users/new'}>Add User</Link>}
        </div>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Search</label>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Username, account type, name, email, branch..."
            />
          </div>
        </div>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <DataTable
            paginate
            columns={columns}
            rows={filteredRows}
            emptyLabel={search ? 'No users match this search.' : 'No users yet.'}
            actions={(row) => (
              <>
                {can('/users', 'can_edit') && <Link className="btn btn-sm btn-primary" to={`/users/${row.id}/edit`}>Edit</Link>}
                {/* System Admin only, and never on your own row or a switched-off account --
                    the server refuses both regardless. */}
                {isAdmin && row.is_active && row.id !== user?.id && (
                  <button className="btn btn-sm" disabled={busyId === row.id} onClick={() => loginAs(row)}>
                    {busyId === row.id ? 'Switching…' : 'Log in as'}
                  </button>
                )}
                {can('/users', 'can_delete') && <button className="btn btn-sm btn-danger" onClick={() => handleDelete(row)}>Delete</button>}
              </>
            )}
          />
        )}
      </div>

      {showTemplates && (
        <PermissionTemplateModal
          accountTypes={ACCOUNT_TYPE_OPTIONS}
          canEdit={can('/users', 'can_edit')}
          onClose={() => setShowTemplates(false)}
        />
      )}
    </div>
  );
}
