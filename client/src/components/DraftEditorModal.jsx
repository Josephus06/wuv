import { useState } from 'react';
import api from '../api/client';
import Modal from './Modal';

const KIND_LABEL = { checkin: 'Check-in', birthday: 'Birthday' };

// Review, edit and send one CRM email draft (server/src/routes/crmDrafts.js). The rep is the
// last step before a customer's inbox: nothing here sends on its own.
export default function DraftEditorModal({ draft: initial, customerName, onClose, onChanged }) {
  const [draft, setDraft] = useState(initial);
  const [form, setForm] = useState({ subject: initial.subject, body: initial.body, to_email: initial.to_email });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(initial.error || '');

  const dirty = form.subject !== draft.subject || form.body !== draft.body || form.to_email !== draft.to_email;

  async function run(label, fn) {
    setBusy(label);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err.response?.data?.error || `${label} failed`);
    } finally {
      setBusy('');
    }
  }

  const save = () => run('Save', async () => {
    const { data } = await api.put(`/crm/drafts/${draft.id}`, form);
    setDraft(data);
    onChanged?.();
  });

  const regenerate = () => run('Rewrite', async () => {
    const { data } = await api.post(`/crm/drafts/${draft.id}/regenerate`);
    setDraft(data);
    setForm({ subject: data.subject, body: data.body, to_email: data.to_email });
    onChanged?.();
  });

  const send = () => {
    if (!confirm(`Send this email to ${form.to_email}?`)) return;
    run('Send', async () => {
      if (dirty) await api.put(`/crm/drafts/${draft.id}`, form);
      await api.post(`/crm/drafts/${draft.id}/send`);
      onChanged?.();
      onClose();
    });
  };

  const discard = () => {
    if (!confirm('Discard this draft?')) return;
    run('Discard', async () => {
      await api.post(`/crm/drafts/${draft.id}/discard`);
      onChanged?.();
      onClose();
    });
  };

  return (
    <Modal title={`${KIND_LABEL[draft.kind] || 'Email'} — ${draft.customer_name || customerName || 'Draft'}`} onClose={onClose} large>
      {error && <div className="error-banner">{error}</div>}
      {draft.reason && (
        <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          <strong>Why:</strong> {draft.reason}
          <span style={{ marginLeft: 8 }}>· written by {draft.generated_by === 'ai' ? 'AI' : 'template'} — for your eyes, not in the email</span>
        </div>
      )}
      <div className="field">
        <label>To</label>
        <input type="email" value={form.to_email} onChange={(e) => setForm({ ...form, to_email: e.target.value })} />
      </div>
      <div className="field">
        <label>Subject</label>
        <input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
      </div>
      <div className="field">
        <label>Message</label>
        <textarea rows={12} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
      </div>
      <div className="muted" style={{ fontSize: 12 }}>An unsubscribe link is added at the bottom when it is sent. Replies come to your email.</div>
      <div className="modal-actions">
        <button type="button" className="btn btn-danger" onClick={discard} disabled={!!busy}>Discard</button>
        <button type="button" className="btn" onClick={regenerate} disabled={!!busy}>{busy === 'Rewrite' ? 'Rewriting...' : 'Rewrite'}</button>
        <button type="button" className="btn" onClick={save} disabled={!!busy || !dirty}>{busy === 'Save' ? 'Saving...' : 'Save Draft'}</button>
        <button type="button" className="btn btn-primary" onClick={send} disabled={!!busy}>{busy === 'Send' ? 'Sending...' : 'Send'}</button>
      </div>
    </Modal>
  );
}
