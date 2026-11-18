import { useState } from 'react';
import api from '../api/client';
import Modal from './Modal';

// Edit one customer contact, including the personal details the CRM uses (birthday, notes).
// PUT replaces the whole contact, so the form carries every field.
export default function ContactEditModal({ customerId, contact, onClose, onSaved }) {
  const [form, setForm] = useState({
    contact_name: contact.contact_name || '',
    title: contact.title || '',
    email: contact.email || '',
    phone: contact.phone || '',
    description: contact.description || '',
    is_primary: !!contact.is_primary,
    birthday: contact.birthday ? String(contact.birthday).slice(0, 10) : '',
    personal_notes: contact.personal_notes || '',
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.put(`/customers/${customerId}/contacts/${contact.id}`, form);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save contact');
      setSaving(false);
    }
  }

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <Modal title={`Contact — ${contact.contact_name}`} onClose={onClose}>
      <form onSubmit={handleSave}>
        {error && <div className="error-banner">{error}</div>}
        <div className="field-row">
          <div className="field"><label>Name</label><input required value={form.contact_name} onChange={set('contact_name')} /></div>
          <div className="field"><label>Title</label><input value={form.title} onChange={set('title')} /></div>
        </div>
        <div className="field-row">
          <div className="field"><label>Email</label><input type="email" value={form.email} onChange={set('email')} /></div>
          <div className="field"><label>Phone</label><input value={form.phone} onChange={set('phone')} /></div>
        </div>
        <div className="field-row">
          <div className="field"><label>Birthday</label><input type="date" value={form.birthday} onChange={set('birthday')} /></div>
          <div className="field">
            <label>Primary Contact</label>
            <select value={form.is_primary ? '1' : ''} onChange={(e) => setForm({ ...form, is_primary: !!e.target.value })}>
              <option value="">No</option>
              <option value="1">Yes</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label>Personal Notes</label>
          <textarea rows={3} value={form.personal_notes} onChange={set('personal_notes')} placeholder="Family, interests, preferences — things worth remembering before a visit" />
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Close</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}
