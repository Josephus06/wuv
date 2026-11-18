// An attachment moved to the office archive drive (server: db/archive-attachments.js). It still
// opens from its name -- served off the office server -- so this only says where it lives now.
export default function ArchivedTag({ at }) {
  if (!at) return null;
  const when = String(at).slice(0, 10);
  return (
    <span
      title={`Moved to the office archive storage on ${when}. It opens from the office server; if the office is offline it cannot be opened until it is back.`}
      style={{
        display: 'inline-block', marginLeft: 6, padding: '1px 6px', borderRadius: 8, fontSize: 11, fontWeight: 600,
        verticalAlign: 'middle', whiteSpace: 'nowrap', background: 'var(--archived-bg, #eef2ff)', color: 'var(--archived-fg, #4338ca)',
      }}
    >
      🗄 Office archive
    </span>
  );
}

// The server's message for a failed blob download (it arrives as a Blob, not JSON) -- "archived on
// the office server, which cannot be reached right now" is worth showing as is.
export async function blobErrorMessage(err, fallback) {
  try {
    const data = err?.response?.data;
    if (data instanceof Blob) return JSON.parse(await data.text()).error || fallback;
    return data?.error || fallback;
  } catch { return fallback; }
}
