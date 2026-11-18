import { useEffect, useState } from 'react';
import api from '../api/client';
import Modal from './Modal';

// Edit a customer's CRM profile: priority, how often they should be visited, and tags.
// Saved through PUT /crm/customers/:id/profile, never through PUT /customers/:id -- that one
// rewrites every column it knows about, so it must not learn about these.
export default function CrmProfileModal({ customer, profile, onClose, onSaved }) {
  const [meta, setMeta] = useState({ priorities: ['high', 'normal', 'low'], defaultVisitEveryDays: {} });
  const [tags, setTags] = useState([]);
  const [form, setForm] = useState({
    crm_priority: profile.crm_priority,
    visit_every_days: profile.visit_every_days ?? '',
    tag_ids: profile.tags.map((t) => t.id),
  });
  const [newTag, setNewTag] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([api.get('/crm/meta'), api.get('/crm/tags')]).then(([m, t]) => {
      setMeta(m.data);
      setTags(t.data);
    });
  }, []);

  function toggleTag(id) {
    setForm((f) => ({ ...f, tag_ids: f.tag_ids.includes(id) ? f.tag_ids.filter((x) => x !== id) : [...f.tag_ids, id] }));
  }

  async function addTag() {
    const name = newTag.trim();
    if (!name) return;
    setError('');
    try {
      const { data } = await api.post('/crm/tags', { name });
      setTags((t) => [...t, data].sort((a, b) => a.name.localeCompare(b.name)));
      setForm((f) => ({ ...f, tag_ids: [...f.tag_ids, data.id] }));
      setNewTag('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add tag');
    }
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.put(`/crm/customers/${customer.id}/profile`, form);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save');
      setSaving(false);
    }
  }

  const defaultDays = meta.defaultVisitEveryDays[form.crm_priority];

  return (
    <Modal title={`CRM Profile — ${customer.name}`} onClose={onClose}>
      <form onSubmit={handleSave}>
        {error && <div className="error-banner">{error}</div>}
        <div className="field-row">
          <div className="field">
            <label>Priority</label>
            <select value={form.crm_priority} onChange={(e) => setForm({ ...form, crm_priority: e.target.value })}>
              {meta.priorities.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Visit Every (days)</label>
            <input
              type="number" min="1" value={form.visit_every_days}
              onChange={(e) => setForm({ ...form, visit_every_days: e.target.value })}
              placeholder={defaultDays ? `${defaultDays} (priority default)` : ''}
            />
          </div>
        </div>
        <div className="field">
          <label>Tags</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {tags.length === 0 && <span className="muted">No tags yet.</span>}
            {tags.map((t) => (
              <button
                key={t.id} type="button"
                className={`badge ${form.tag_ids.includes(t.id) ? 'badge-info' : 'badge-muted'}`}
                style={{ border: 'none', cursor: 'pointer' }}
                onClick={() => toggleTag(t.id)}
              >
                {form.tag_ids.includes(t.id) ? '✓ ' : ''}{t.name}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder="New tag"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
            />
            <button type="button" className="btn btn-sm" onClick={addTag}>Add Tag</button>
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Close</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}
