import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import Modal from './Modal';
import LoadingSpinner from './LoadingSpinner';

// Editor for the per-account-type default permission matrix that the Add/Update User wizard
// offers as "Apply template". Editing a template only changes what future users start from --
// it never touches the permissions of users who already exist.
// The same columns, in the same order, as a user's Permissions tab (UserWizard), so a template can
// grant everything a user can be granted. can_edit used to be labelled 'Can Update' here, and the
// real can_update, can_view_all and can_print were missing -- the server saved them all along.
const PERMISSION_ACTIONS = [
  { key: 'can_view', label: 'Can View' },
  { key: 'can_add', label: 'Can Add' },
  { key: 'can_edit', label: 'Can Edit' },
  { key: 'can_update', label: 'Can Update' },
  { key: 'can_view_all', label: 'Can View All' },
  { key: 'can_delete', label: 'Can Delete' },
  { key: 'can_approve', label: 'Can Approve' },
  { key: 'can_print', label: 'Can Print' },
  { key: 'can_void', label: 'Can Void' },
];

export default function PermissionTemplateModal({ accountTypes, canEdit, onClose }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [pages, setPages] = useState([]);
  const [templates, setTemplates] = useState({});
  const [type, setType] = useState(accountTypes[0] || '');
  const [permMap, setPermMap] = useState({});
  const [search, setSearch] = useState('');

  useEffect(() => {
    (async () => {
      const [pgs, tpl] = await Promise.all([
        api.get('/users/meta/pages'),
        api.get('/account-type-permissions'),
      ]);
      setPages(pgs.data);
      setTemplates(tpl.data || {});
      setLoading(false);
    })().catch((err) => {
      setError(err.response?.data?.error || 'Could not load permission templates.');
      setLoading(false);
    });
  }, []);

  // Reload the grid whenever the selected type changes, discarding unsaved edits to the
  // previous one -- switching types is an explicit "show me that template instead".
  useEffect(() => {
    const map = {};
    (templates[type] || []).forEach((r) => { map[r.page_id] = { ...r, page_id: r.page_id }; });
    setPermMap(map);
    setSaved('');
  }, [type, templates]);

  const filtered = useMemo(
    () => pages.filter((p) => p.name.toLowerCase().includes(search.toLowerCase())),
    [pages, search]
  );

  const grantCount = useMemo(
    () => Object.values(permMap).reduce((n, p) => n + PERMISSION_ACTIONS.filter((a) => p[a.key]).length, 0),
    [permMap]
  );

  function toggle(pageId, key) {
    setPermMap((prev) => {
      const cur = prev[pageId] || { page_id: pageId };
      return { ...prev, [pageId]: { ...cur, [key]: !cur[key] } };
    });
  }

  // Whole-column toggle: ticking "Can View" for 60-odd pages one box at a time is the main
  // reason setting a template up by hand is painful.
  function toggleColumn(key) {
    const allOn = filtered.every((p) => permMap[p.id]?.[key]);
    setPermMap((prev) => {
      const next = { ...prev };
      filtered.forEach((p) => {
        next[p.id] = { ...(next[p.id] || { page_id: p.id }), [key]: !allOn };
      });
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    setSaved('');
    try {
      const { data } = await api.put(`/account-type-permissions/${encodeURIComponent(type)}`, {
        permissions: Object.values(permMap),
      });
      setTemplates((prev) => ({ ...prev, [type]: data }));
      setSaved(`Saved the ${type} template. Existing users were not changed.`);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Permission Templates" onClose={onClose} xl>
      {loading ? <LoadingSpinner /> : (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            The defaults a new user starts from when you click <strong>Apply template</strong> on the
            permissions step of the user wizard. Editing a template here does not change any existing user.
          </p>

          {error && <div className="error-banner">{error}</div>}
          {saved && <div className="success-banner">{saved}</div>}

          <div className="perm-template-bar">
            <label htmlFor="tpl-type">Account Type</label>
            <select id="tpl-type" value={type} onChange={(e) => setType(e.target.value)}>
              {accountTypes.map((t) => (
                <option key={t} value={t}>
                  {t}{(templates[t]?.length || 0) === 0 ? ' (empty)' : ''}
                </option>
              ))}
            </select>
            <input placeholder="Search pages..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 220 }} />
            <span className="muted">{grantCount} permission(s) ticked</span>
          </div>

          <div className="table-wrap" style={{ maxHeight: '52vh', overflowY: 'auto' }}>
            <table className="perm-table">
              <thead>
                <tr>
                  <th>Page</th>
                  {PERMISSION_ACTIONS.map((a) => (
                    <th key={a.key}>
                      <button type="button" className="link-btn" disabled={!canEdit}
                        title={`Toggle ${a.label} for every page shown`} onClick={() => toggleColumn(a.key)}>
                        {a.label}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((page) => {
                  const perm = permMap[page.id] || {};
                  return (
                    <tr key={page.id}>
                      <td>{page.name}</td>
                      {PERMISSION_ACTIONS.map((a) => (
                        <td key={a.key} style={{ textAlign: 'center' }}>
                          <input type="checkbox" disabled={!canEdit} checked={!!perm[a.key]} onChange={() => toggle(page.id, a.key)} />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="modal-actions">
            {canEdit && <button className="btn btn-primary" disabled={saving} onClick={handleSave}>Save Template</button>}
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </>
      )}
    </Modal>
  );
}
