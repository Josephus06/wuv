import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import ArchivedTag, { blobErrorMessage } from './ArchivedTag';

// Images and PDFs attached to a ticket -- the screenshot of the error, the scan of the form.
// A ticket is usually raised about something the person can see, and describing a screen in
// prose is slow to write and ambiguous to read.
//
// Images are shown as thumbnails rather than as a list of file names. A row reading
// "Screenshot 2026-08-18 at 14.22.31.png" tells whoever picks the ticket up nothing at all;
// the picture tells them immediately whether they are the right person for it.
//
// Uploads go up as base64 in a JSON body (there is no multipart handler on the server); the
// API mounts a larger body parser on this one endpoint to fit them.
const MAX_BYTES = 10 * 1024 * 1024;
// Mirrors what the server accepts. This only filters the file picker and gives an early,
// clearer refusal -- the server decides for real, from the file's own bytes.
const ACCEPT = 'image/png,image/jpeg,image/gif,image/bmp,image/webp,image/heic,application/pdf';

function fileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const isImage = (mime) => String(mime || '').startsWith('image/');

export default function TicketAttachments({ ticketId, currentUserId, isAdmin }) {
  const [rows, setRows] = useState([]);
  const [previews, setPreviews] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);
  // Object URLs are revoked on unmount. Without this every thumbnail leaks its blob for the
  // lifetime of the tab, which on a busy ticket queue adds up.
  const urls = useRef([]);

  function load() {
    return api.get(`/tickets/${ticketId}/attachments`)
      .then(({ data }) => setRows(data))
      .catch(() => setRows([]));
  }

  useEffect(() => { load(); }, [ticketId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    urls.current.forEach((u) => URL.revokeObjectURL(u));
    urls.current = [];
  }, []);

  // Thumbnails are fetched through the API so the request carries the auth header -- a bare
  // <img src> would be an unauthenticated GET and would simply fail.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const r of rows) {
        if (!isImage(r.mime_type) || previews[r.id] || r.archived_at) continue; // archived: opened on click, not previewed
        try {
          const { data } = await api.get(`/tickets/${ticketId}/attachments/${r.id}/file`, { responseType: 'blob' });
          if (cancelled) return;
          const url = URL.createObjectURL(data);
          urls.current.push(url);
          setPreviews((p) => ({ ...p, [r.id]: url }));
        } catch {
          // A thumbnail that will not load is not worth an error banner -- the row still
          // opens on click, which is the part that matters.
        }
      }
    })();
    return () => { cancelled = true; };
  }, [rows, ticketId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function upload(file) {
    if (!file) return;
    setError('');

    // Checked here as well as on the server so the user finds out before spending a minute
    // uploading something that will be refused.
    if (file.size > MAX_BYTES) {
      setError(`"${file.name}" is ${fileSize(file.size)}. Files must be 10MB or smaller.`);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    if (file.type && !isImage(file.type) && file.type !== 'application/pdf') {
      setError(`"${file.name}" is not an image or a PDF.`);
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
      await api.post(`/tickets/${ticketId}/attachments`, { file_name: file.name, data });
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Upload failed.');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function handleDelete(attachmentId, name) {
    if (!confirm(`Remove "${name}"?`)) return;
    setBusy(true);
    setError('');
    try {
      await api.delete(`/tickets/${ticketId}/attachments/${attachmentId}`);
      setPreviews((p) => { const next = { ...p }; delete next[attachmentId]; return next; });
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not remove that file.');
    } finally {
      setBusy(false);
    }
  }

  async function handleOpen(attachmentId) {
    setError('');
    try {
      const { data } = await api.get(`/tickets/${ticketId}/attachments/${attachmentId}/file`, { responseType: 'blob' });
      const url = URL.createObjectURL(data);
      window.open(url, '_blank');
      // Revoked on a delay: revoking immediately can beat the new tab to the object.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setError(await blobErrorMessage(err, 'Could not open that file.'));
    }
  }

  // Only the uploader and a System Admin, matching what the server enforces. Showing a
  // delete button that always comes back 403 is worse than not showing one.
  const canDelete = (row) => isAdmin || String(row.uploaded_by_user_id) === String(currentUserId);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <div>
          <h3 style={{ marginTop: 0, marginBottom: 2 }}>Attachments</h3>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Screenshots or scanned documents. Images and PDFs, up to 10MB each.
          </p>
        </div>
        {rows.length > 0 && (
          <span className="muted" style={{ fontSize: 13 }}>{rows.length} file{rows.length === 1 ? '' : 's'}</span>
        )}
      </div>

      {error && <div className="error-banner" style={{ marginTop: 10 }}>{error}</div>}

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); upload(e.dataTransfer.files?.[0]); }}
        style={{
          marginTop: 12, padding: 14, borderRadius: 10, textAlign: 'center',
          border: `2px dashed ${dragOver ? 'var(--accent)' : 'var(--border, #d1d5db)'}`,
          background: dragOver ? 'rgba(99,102,241,0.06)' : 'transparent',
        }}
      >
        <input
          ref={fileRef} type="file" accept={ACCEPT} disabled={busy}
          style={{ display: 'none' }}
          onChange={(e) => upload(e.target.files?.[0])}
        />
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? 'Uploading…' : 'Choose a file'}
        </button>
        <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>or drop one here</div>
      </div>

      {rows.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 14 }}>
          {rows.map((r) => (
            <div
              key={r.id}
              style={{
                width: 168, border: '1px solid var(--border, #e5e7eb)', borderRadius: 10,
                overflow: 'hidden', display: 'flex', flexDirection: 'column',
              }}
            >
              <button
                type="button"
                onClick={() => handleOpen(r.id)}
                title={`Open ${r.file_name}`}
                style={{
                  height: 110, border: 0, padding: 0, cursor: 'pointer', display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                  background: 'var(--panel-2, #f3f4f6)',
                }}
              >
                {isImage(r.mime_type) && previews[r.id] ? (
                  <img
                    src={previews[r.id]} alt={r.file_name}
                    style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', opacity: 0.65 }}>
                    {isImage(r.mime_type) ? 'IMAGE' : 'PDF'}
                  </span>
                )}
              </button>
              <div style={{ padding: '7px 9px', fontSize: 12 }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.file_name}>
                  {r.file_name}
                </div>
                <ArchivedTag at={r.archived_at} />
                <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                  {fileSize(r.size_bytes)} · {r.uploaded_by_name || 'Unknown'}
                </div>
                {canDelete(r) && (
                  <button
                    type="button" className="link-btn" disabled={busy}
                    style={{ fontSize: 11, marginTop: 4 }}
                    onClick={() => handleDelete(r.id, r.file_name)}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
