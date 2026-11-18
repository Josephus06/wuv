import { useEffect, useState } from 'react';
import api from '../api/client';

// The picture under one step of a Manual guide (2026-10-14; server routes/manual.js /images).
// Everyone sees it; Edit on the Manual adds, replaces (upload, paste or drop a screenshot) and
// removes it. A screenshot is shrunk to 1600 px wide before upload.
const MAX_W = 1600;
const cache = new Map(); // image id + updated_at -> object URL

function shrink(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const src = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, MAX_W / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); // a transparent PNG stays readable as JPEG
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(src);
      resolve(c.toDataURL('image/jpeg', 0.88));
    };
    img.onerror = () => { URL.revokeObjectURL(src); reject(new Error('That file is not a picture.')); };
    img.src = src;
  });
}

export default function ManualStepImage({ flowKey, nodeId, stepIndex, image, canEdit, onChanged }) {
  const [url, setUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(false);
  const cacheKey = image ? `${image.id}-${image.updated_at}` : null;

  useEffect(() => {
    if (!cacheKey) { setUrl(null); return undefined; }
    if (cache.has(cacheKey)) { setUrl(cache.get(cacheKey)); return undefined; }
    let alive = true;
    api.get(`/manual/images/${image.id}`, { responseType: 'blob', params: { v: image.updated_at } })
      .then(({ data }) => { const u = URL.createObjectURL(data); cache.set(cacheKey, u); if (alive) setUrl(u); })
      .catch(() => {});
    return () => { alive = false; };
  }, [cacheKey, image]);

  async function upload(file) {
    if (!file) return;
    setBusy(true); setError('');
    try {
      const data = await shrink(file);
      const { data: row } = await api.put('/manual/images', { flow: flowKey, node: nodeId, step: stepIndex, data });
      onChanged(row);
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Could not save the picture.');
    }
    setBusy(false);
  }

  async function remove() {
    if (!window.confirm('Remove this picture?')) return;
    setBusy(true); setError('');
    try {
      await api.delete(`/manual/images/${image.id}`);
      onChanged(null);
    } catch (e) { setError(e.response?.data?.error || 'Could not remove the picture.'); }
    setBusy(false);
  }

  if (!image && !canEdit) return null;
  return (
    <div className="pf-step-image"
      onDragOver={canEdit ? (e) => e.preventDefault() : undefined}
      onDrop={canEdit ? (e) => { e.preventDefault(); upload(e.dataTransfer.files?.[0]); } : undefined}>
      {image && (url
        ? <img src={url} alt={`Step ${stepIndex + 1}`} onClick={() => setZoom(true)} />
        : <div className="pf-step-image-loading" />)}
      {canEdit && (
        <div className="pf-step-image-tools">
          <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
            {busy ? 'Saving…' : image ? 'Replace picture' : 'Add picture'}
            <input type="file" accept="image/*" hidden disabled={busy} onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          {/* A screenshot straight from the clipboard (Win+Shift+S, then click here and Ctrl+V). */}
          <input className="pf-step-image-paste" placeholder="or paste a screenshot here" readOnly disabled={busy}
            onPaste={(e) => { const f = [...(e.clipboardData?.files || [])][0]; if (f) { e.preventDefault(); upload(f); } }} />
          {image && <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={remove}>Remove</button>}
        </div>
      )}
      {error && <div className="error-banner" style={{ marginTop: 6 }}>{error}</div>}
      {zoom && url && (
        <div className="pf-step-image-zoom" onClick={() => setZoom(false)}>
          <img src={url} alt={`Step ${stepIndex + 1}`} />
        </div>
      )}
    </div>
  );
}
