import { useState } from 'react';
import api from '../api/client';
import Modal from './Modal';

// Create a ticket from the Tickets page (asked 2026-10-13), besides the chatbot. Same POST /tickets
// the chatbot uses, so the sender department's approvers and the receiving head are notified the
// same way; files go up afterwards to the ticket's attachments (10 MB each, checked server-side).
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_DEPARTMENT = 'Support-System'; // where almost every ticket goes

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = reject;
  r.readAsDataURL(file);
});

export default function NewTicketModal({ departments, onClose, onCreated }) {
  const fallback = departments.find((d) => d.name === DEFAULT_DEPARTMENT);
  const [departmentId, setDepartmentId] = useState(fallback ? String(fallback.id) : '');
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function addFiles(list) {
    const picked = [...list];
    const tooBig = picked.find((f) => f.size > MAX_FILE_BYTES);
    if (tooBig) setError(`${tooBig.name} is over 10 MB.`);
    setFiles((cur) => [...cur, ...picked.filter((f) => f.size <= MAX_FILE_BYTES)]);
  }

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError('');
    let ticket;
    try {
      ({ data: ticket } = await api.post('/tickets', { department_id: departmentId, description }));
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create the ticket.');
      setSaving(false);
      return;
    }
    // The ticket exists now; a file that fails is reported but does not undo it.
    const failed = [];
    for (const f of files) {
      try {
        await api.post(`/tickets/${ticket.id}/attachments`, { file_name: f.name, data: await readAsDataUrl(f) });
      } catch (err) {
        failed.push(`${f.name}: ${err.response?.data?.error || 'not uploaded'}`);
      }
    }
    if (failed.length) window.alert(`${ticket.ticket_no} was created, but some files were not attached:\n${failed.join('\n')}`);
    onCreated(ticket);
  }

  return (
    <Modal title="New Ticket" onClose={onClose}>
      <form onSubmit={submit}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files); }}>
        {error && <div className="error-banner">{error}</div>}
        <div className="field">
          <label>Send to Department *</label>
          <select required value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">— Select —</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>What do you need? *</label>
          <textarea required rows={6} value={description} onChange={(e) => setDescription(e.target.value)}
            onPaste={(e) => { const pasted = [...(e.clipboardData?.files || [])]; if (pasted.length) { e.preventDefault(); addFiles(pasted); } }}
            placeholder="e.g. Kindly change the job location of JO-72319-5-11 to WAREHOUSE" />
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Include the document numbers (SO-, JO-, EST-, PO- ...). The first 60 characters become the ticket&apos;s subject.
          </div>
        </div>
        <div className="field">
          <label>Attachments</label>
          <label className="btn btn-sm" style={{ cursor: 'pointer', width: 'fit-content' }}>
            Add screenshot / file
            <input type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          </label>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>You can also paste a screenshot into the box above, or drop files here.</div>
          {files.length > 0 && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} style={{ fontSize: 13 }}>
                  {f.name} <span className="muted">({Math.max(1, Math.round(f.size / 1024))} KB)</span>{' '}
                  <button type="button" className="btn btn-sm" style={{ padding: '0 6px' }}
                    onClick={() => setFiles((cur) => cur.filter((_, n) => n !== i))}>×</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Creating…' : 'Create Ticket'}</button>
        </div>
      </form>
    </Modal>
  );
}
