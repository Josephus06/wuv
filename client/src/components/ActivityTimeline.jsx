import { useEffect, useState } from 'react';
import api from '../api/client';
import LoadingSpinner from './LoadingSpinner';
import { displayDate, displayDateTime } from '../utils/dates';

const TYPE_LABELS = { visit: 'Visit', meeting: 'Meeting', call: 'Call', email: 'Email', note: 'Note', task: 'Task' };
const TYPE_ICONS = { visit: '🚗', meeting: '👥', call: '📞', email: '✉️', note: '📝', task: '☑️' };
// Visits and meetings have a time and a place, and are either logged after the fact or planned.
const SCHEDULED = ['visit', 'meeting'];
const EMPTY = {
  activity_type: 'note', subject: '', description: '', due_date: '',
  starts_at: '', ends_at: '', location: '', contact_id: '', outcome: '',
};

function formatDateTime(v) { return v ? displayDateTime(String(v).replace(' ', 'T')) : ''; }
function formatDate(v) { return v ? displayDate(v) : ''; }
function nowLocalInput() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

// Reusable activity/interaction log (visits/meetings/calls/emails/notes/tasks) -- attached to
// any Lead/Customer/Estimate via `relatedType`/`relatedId`, backed by
// server/src/routes/crmActivities.js's polymorphic crm_activities table. `contacts` (optional)
// lets a visit or meeting name who it was with; `onChange` tells the parent something was
// logged, so e.g. the customer's "last visit" can refresh.
export default function ActivityTimeline({ relatedType, relatedId, contacts = [], onChange }) {
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    const { data } = await api.get('/crm-activities', { params: { related_type: relatedType, related_id: relatedId } });
    setActivities(data);
    setLoading(false);
  }

  useEffect(() => { load(); }, [relatedType, relatedId]); // eslint-disable-line react-hooks/exhaustive-deps

  function setType(type) {
    setForm((f) => ({ ...f, activity_type: type, starts_at: SCHEDULED.includes(type) && !f.starts_at ? nowLocalInput() : f.starts_at }));
  }

  async function handleAdd(e) {
    e.preventDefault();
    if (!form.subject) return;
    const scheduled = SCHEDULED.includes(form.activity_type);
    setSaving(true);
    setError('');
    try {
      await api.post('/crm-activities', {
        related_type: relatedType, related_id: relatedId,
        activity_type: form.activity_type, subject: form.subject,
        description: form.description || null, due_date: form.activity_type === 'task' ? (form.due_date || null) : null,
        starts_at: scheduled ? form.starts_at : null,
        ends_at: scheduled ? (form.ends_at || null) : null,
        location: scheduled ? (form.location || null) : null,
        contact_id: form.contact_id || null,
        outcome: scheduled ? (form.outcome || null) : null,
        // A visit dated now or earlier is being logged after the fact; a later one is a plan.
        is_done: scheduled && new Date(form.starts_at) <= new Date(),
      });
      setForm(EMPTY);
      await load();
      onChange?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to log activity');
    } finally {
      setSaving(false);
    }
  }

  // PUT replaces every editable field, so send the activity back whole with only is_done flipped.
  async function toggleDone(activity) {
    await api.put(`/crm-activities/${activity.id}`, {
      subject: activity.subject, description: activity.description, due_date: activity.due_date,
      is_done: !activity.is_done, assigned_to_user_id: activity.assigned_to_user_id,
      starts_at: activity.starts_at, ends_at: activity.ends_at, location: activity.location,
      contact_id: activity.contact_id, outcome: activity.outcome,
    });
    await load();
    onChange?.();
  }

  // Email the contact a calendar invitation. Confirms the address first -- this goes to the customer.
  async function sendInvite(activity) {
    const contact = contacts.find((c) => String(c.id) === String(activity.contact_id));
    const to = prompt(
      `Send a calendar invite for "${activity.subject}" to:`,
      contact?.email || '',
    );
    if (!to) return;
    setError('');
    try {
      await api.post(`/crm-activities/${activity.id}/invite`, { to });
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send the invite');
    }
  }

  async function handleDelete(activity) {
    if (!confirm(`Delete this ${TYPE_LABELS[activity.activity_type].toLowerCase()}?`)) return;
    await api.delete(`/crm-activities/${activity.id}`);
    await load();
    onChange?.();
  }

  const scheduled = SCHEDULED.includes(form.activity_type);
  const planned = scheduled && form.starts_at && new Date(form.starts_at) > new Date();

  return (
    <div>
      <form onSubmit={handleAdd} className="card" style={{ marginBottom: 16 }}>
        {error && <div className="error-banner">{error}</div>}
        <div className="field-row">
          <div className="field" style={{ maxWidth: 160 }}>
            <label>Type</label>
            <select value={form.activity_type} onChange={(e) => setType(e.target.value)}>
              {Object.entries(TYPE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
          <div className="field" style={{ flex: 2 }}>
            <label>Subject</label>
            <input required value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder={scheduled ? 'Purpose of the visit' : 'What happened?'} />
          </div>
          {form.activity_type === 'task' && (
            <div className="field" style={{ maxWidth: 170 }}>
              <label>Due Date</label>
              <input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
            </div>
          )}
        </div>
        {scheduled && (
          <div className="field-row">
            <div className="field" style={{ maxWidth: 220 }}>
              <label>Starts</label>
              <input type="datetime-local" required value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} />
            </div>
            <div className="field" style={{ maxWidth: 220 }}>
              <label>Ends</label>
              <input type="datetime-local" value={form.ends_at} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} />
            </div>
            <div className="field">
              <label>Location</label>
              <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
            </div>
            {contacts.length > 0 && (
              <div className="field" style={{ maxWidth: 220 }}>
                <label>With</label>
                <select value={form.contact_id} onChange={(e) => setForm({ ...form, contact_id: e.target.value })}>
                  <option value="">—</option>
                  {contacts.map((c) => <option key={c.id} value={c.id}>{c.contact_name}</option>)}
                </select>
              </div>
            )}
          </div>
        )}
        <div className="field">
          <label>Notes</label>
          <textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        {scheduled && !planned && (
          <div className="field">
            <label>Outcome</label>
            <textarea rows={2} value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value })} placeholder="What was agreed, what to follow up" />
          </div>
        )}
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving...' : planned ? `Schedule ${TYPE_LABELS[form.activity_type]}` : 'Log Activity'}
        </button>
      </form>

      {loading ? <LoadingSpinner /> : (
        <div className="activity-list">
          {activities.length === 0 && <div className="empty-state">No activity logged yet.</div>}
          {activities.map((a) => {
            const isScheduled = SCHEDULED.includes(a.activity_type);
            const canTick = a.activity_type === 'task' || isScheduled;
            return (
              <div key={a.id} className="card" style={{ marginBottom: 10, opacity: a.activity_type === 'task' && a.is_done ? 0.6 : 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <span style={{ marginRight: 8 }}>{TYPE_ICONS[a.activity_type]}</span>
                    <strong>{a.subject}</strong>
                    {a.activity_type === 'task' && a.due_date && (
                      <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                        Due {formatDate(a.due_date)}{a.is_done ? ' — Done' : ''}
                      </span>
                    )}
                    {isScheduled && (
                      <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                        {formatDateTime(a.starts_at)}
                        {a.location ? ` · ${a.location}` : ''}
                        {a.contact_name ? ` · with ${a.contact_name}` : ''}
                        {a.is_done ? '' : ' — Scheduled'}
                        {!a.is_done && a.invite_sent_at ? ` · invite sent ${formatDate(a.invite_sent_at)}` : ''}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {isScheduled && !a.is_done && (
                      <button type="button" className="btn btn-sm" onClick={() => sendInvite(a)}>
                        {a.invite_sent_at ? 'Resend Invite' : 'Send Invite'}
                      </button>
                    )}
                    {canTick && (
                      <button type="button" className="btn btn-sm" onClick={() => toggleDone(a)}>
                        {a.is_done ? 'Reopen' : 'Mark Done'}
                      </button>
                    )}
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => handleDelete(a)}>Delete</button>
                  </div>
                </div>
                {a.description && <div style={{ marginTop: 6 }}>{a.description}</div>}
                {a.outcome && <div style={{ marginTop: 6 }}><span className="muted">Outcome:</span> {a.outcome}</div>}
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  {a.created_by_name || 'Someone'} · {formatDateTime(a.created_at)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
