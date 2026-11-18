// Attachments moved off the cloud to the office server's archive drive (asked 2026-11-04).
//
// HOW A FILE GETS THERE. db/archive-attachments.js runs on the office server on the 1st of every
// month. For every attachment uploaded before that month it writes the bytes to ARCHIVE_DIR
// (the office's /backup drive), checks the copy, then empties the row's file_data -- or deletes
// the Spaces object, for a large Archiver file -- and records archive_path on the row. The row
// replicates, so every server knows the file is archived and where.
//
// HOW IT IS SERVED. The same code runs on the cloud, the office and SM:
//   * the office has ARCHIVE_DIR set and the file on disk, so it streams it straight off the drive;
//   * the cloud and SM have ARCHIVE_REMOTE_URL (the office over Tailscale) and pass the request on,
//     with the user's own token -- the servers share JWT_SECRET, so the office checks the same
//     permissions the cloud would have. One hop only: a forwarded request is never forwarded again;
//   * neither (or the office unreachable): a clear "archived, office offline" error.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const HOP_HEADER = 'x-archive-hop';
const LINK_TTL_SECONDS = 10 * 60;

const archiveDir = () => process.env.ARCHIVE_DIR || '';
const remoteUrl = () => String(process.env.ARCHIVE_REMOTE_URL || '').replace(/\/+$/, '');

// The absolute path of an archived file on this server, or null when it is not on this server.
// archive_path is relative to ARCHIVE_DIR; anything that resolves outside it is refused.
function localPath(archivePath) {
  const root = archiveDir();
  if (!root || !archivePath) return null;
  const full = path.resolve(root, archivePath);
  if (!full.startsWith(path.resolve(root) + path.sep)) return null;
  return fs.existsSync(full) ? full : null;
}

const safeName = (n) => String(n || 'file').replace(/["\\\r\n]/g, '_');
const isInline = (mime) => /^(application\/pdf|image\/)/.test(mime || '');

function streamLocal(res, full, { fileName, mimeType, inline }) {
  const size = fs.statSync(full).size;
  res.setHeader('Content-Type', mimeType || 'application/octet-stream');
  res.setHeader('Content-Length', size);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName(fileName)}"`);
  fs.createReadStream(full).on('error', (e) => res.destroy(e)).pipe(res);
}

// Pass the request to the office and stream its answer back, status and headers included.
async function proxy(req, res, urlPath, headers = {}) {
  let upstream;
  try {
    upstream = await fetch(`${remoteUrl()}${urlPath}`, {
      headers: { ...headers, [HOP_HEADER]: '1' },
      signal: AbortSignal.timeout(30_000), // to the first byte; the body then streams as long as it takes
    });
  } catch {
    return res.status(503).json({ error: 'This file is archived on the office server, which cannot be reached right now. Try again later or from the office.' });
  }
  res.status(upstream.status);
  for (const h of ['content-type', 'content-length', 'content-disposition']) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (!upstream.body) return res.end();
  return Readable.fromWeb(upstream.body).on('error', (e) => res.destroy(e)).pipe(res);
}

// Serve an archived attachment from inside its own (already permission-checked) download route.
// row: { archive_path, file_name, mime_type }.
async function sendArchived(req, res, row, { inline } = {}) {
  const opts = { fileName: row.file_name, mimeType: row.mime_type, inline: inline ?? isInline(row.mime_type) };
  const full = localPath(row.archive_path);
  if (full) return streamLocal(res, full, opts);
  if (remoteUrl() && !req.headers[HOP_HEADER]) {
    return proxy(req, res, req.originalUrl, { authorization: req.headers.authorization || '' });
  }
  return res.status(503).json({ error: 'This file is archived on the office server and is not available from here.' });
}

// A short-lived link for a large archived file, so the browser downloads it itself (with its own
// progress bar) instead of holding hundreds of MB in memory. Signed with JWT_SECRET, which every
// server shares, so the link works whichever server the browser reaches.
function sign(body) {
  return crypto.createHmac('sha256', String(process.env.JWT_SECRET || '')).update(body).digest('base64url');
}
function signLink(row) {
  const body = Buffer.from(JSON.stringify({
    p: row.archive_path, n: row.file_name, m: row.mime_type, e: Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS,
  })).toString('base64url');
  return `${body}.${sign(body)}`;
}
function readLink(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = sign(body);
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  try {
    const d = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return d.e >= Math.floor(Date.now() / 1000) ? d : null;
  } catch { return null; }
}

// GET /api/archive-link/:token -- no login header (a plain browser download carries none); the
// signature and expiry are the permission, issued by a route that checked the user's.
async function serveLink(req, res) {
  const d = readLink(req.params.token);
  if (!d) return res.status(410).json({ error: 'This download link has expired. Open the file again.' });
  const full = localPath(d.p);
  if (full) return streamLocal(res, full, { fileName: d.n, mimeType: d.m, inline: false });
  if (remoteUrl() && !req.headers[HOP_HEADER]) return proxy(req, res, `/api/archive-link/${req.params.token}`);
  return res.status(503).json({ error: 'This file is archived on the office server, which cannot be reached right now.' });
}

module.exports = { sendArchived, signLink, serveLink, localPath, LINK_TTL_SECONDS };
