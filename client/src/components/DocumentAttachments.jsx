import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import ArchivedTag, { blobErrorMessage } from './ArchivedTag';
import { displayDateTime } from '../utils/dates';

// Files on a Customer Payment or a Sales Invoice -- the customer's BIR 2307 copies above all
// (2026-10-24; routes/documentAttachments.js). docType is 'customer_payment' or 'sales_invoice'.
// Same look as the Job Order's attachments (att-* classes).
const MAX_BYTES = 10 * 1024 * 1024;

function fileExt(name) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || ''));
  return m ? m[1].toUpperCase().slice(0, 4) : 'FILE';
}

function fileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function DocumentAttachments({ docType, docId, title = 'Attachments' }) {
  const [state, setState] = useState(null);
  const [kind, setKind] = useState('BIR 2307');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);
  const base = `/document-attachments/${docType}/${docId}`;

  const load = () => api.get(base).then(({ data }) => setState(data)).catch(() => setState({ attachments: [], kinds: [], canAdd: false }));
  useEffect(() => { load(); }, [docType, docId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function upload(file) {
    if (!file) return;
    setError('');
    if (file.size > MAX_BYTES) {
      setError(`"${file.name}" is ${fileSize(file.size)}. Files must be 10MB or smaller.`);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setBusy(true);
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read that file'));
        reader.readAsDataURL(file);
      });
      await api.post(base, { file_name: file.name, kind, data, mime_type: file.type });
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Upload failed');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function remove(row) {
    if (!confirm(`Remove "${row.file_name}"?`)) return;
    setBusy(true);
    setError('');
    try {
      await api.delete(`${base}/${row.id}`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not remove that file');
    } finally {
      setBusy(false);
    }
  }

  // Opened through the API so the request carries the auth header.
  async function open(row) {
    setError('');
    try {
      const { data } = await api.get(`${base}/${row.id}/file`, { responseType: 'blob' });
      const url = URL.createObjectURL(data);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setError(await blobErrorMessage(err, 'Could not open that file'));
    }
  }

  if (!state) return null;
  const rows = state.attachments || [];
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="att-head">
        <div>
          <h3>{title}</h3>
          <p className="att-sub">BIR 2307 copies and other supporting files.</p>
        </div>
        {rows.length > 0 && <span className="att-count">{rows.length} file{rows.length === 1 ? '' : 's'}</span>}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {rows.length === 0 ? (
        <div className="att-empty">
          <div className="att-empty-mark">📎</div>
          <strong>No files attached yet</strong>
          <span>{state.canAdd ? 'Attach the BIR 2307 copy here.' : 'Nothing has been attached yet.'}</span>
        </div>
      ) : (
        <div className="att-list">
          {rows.map((r) => (
            <div className="att-item" key={r.id}>
              <div className="att-icon">{fileExt(r.file_name)}</div>
              <div className="att-body">
                <button type="button" className="att-name" onClick={() => open(r)}>{r.file_name}</button>
                <ArchivedTag at={r.archived_at} />
                <div className="att-meta">
                  {fileSize(r.size_bytes)} · {r.uploaded_by_name || 'Unknown'}
                  {r.created_at ? ` · ${displayDateTime(r.created_at)}` : ''}
                </div>
              </div>
              <span className="att-kind">{r.kind}</span>
              {(state.canEdit || Number(r.uploaded_by_user_id) === Number(state.me)) && (
                <button type="button" className="btn btn-sm btn-warning" disabled={busy} onClick={() => remove(r)}>Remove</button>
              )}
            </div>
          ))}
        </div>
      )}

      {state.canAdd && (
        <div className="att-upload">
          <div className="att-field">
            <label htmlFor={`att-kind-${docType}-${docId}`}>Document type</label>
            <select id={`att-kind-${docType}-${docId}`} value={kind} onChange={(e) => setKind(e.target.value)} disabled={busy}>
              {(state.kinds || []).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <label
            className={`att-drop${dragOver ? ' is-over' : ''}${busy ? ' is-busy' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); upload(e.dataTransfer.files?.[0]); }}
          >
            <input ref={fileRef} type="file" accept="application/pdf,image/*" onChange={(e) => upload(e.target.files?.[0])} disabled={busy} />
            <div className="att-drop-main">{busy ? 'Uploading…' : <><em>Choose a file</em> or drag it here</>}</div>
            <div className="att-drop-hint">PDF or image · up to 10MB</div>
          </label>
        </div>
      )}
    </div>
  );
}
