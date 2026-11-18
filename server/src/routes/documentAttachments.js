// Attachments on a Customer Payment or a Sales Invoice -- the customer's BIR 2307 copies above all
// (asked 2026-10-24). Mounted at /api/document-attachments/:docType/:docId. Who may see a document's
// files is who may see the document (its page's can_view); attaching takes can_add or can_edit there;
// a file is removed by whoever attached it, or by someone with can_edit.
const express = require('express');
const pool = require('../db');
const { requireAuth, userCan } = require('../middleware/auth');
const { sendArchived } = require('../lib/localArchive');

const router = express.Router();

const DOCS = {
  customer_payment: { route: '/customer-payments', table: 'customer_payments' },
  sales_invoice: { route: '/sales-invoices', table: 'sales_invoices' },
};
const KINDS = ['BIR 2307', 'Other'];
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = /^(application\/pdf|image\/(png|jpe?g|gif|webp|bmp|tiff))$/i;

// The document, and what this user may do with its files; null when it does not exist or is not theirs to see.
async function docFor(req) {
  const doc = DOCS[req.params.docType];
  if (!doc) return null;
  const me = req.user.id;
  if (!(await userCan(me, doc.route, 'can_view'))) return null;
  const [[row]] = await pool.query(`SELECT id FROM ${doc.table} WHERE id = ?`, [req.params.docId]);
  if (!row) return null;
  const canEdit = await userCan(me, doc.route, 'can_edit');
  const canAdd = canEdit || (await userCan(me, doc.route, 'can_add'));
  return { ...doc, canEdit, canAdd };
}

const LIST_SQL = `SELECT a.id, a.kind, a.file_name, a.mime_type, a.size_bytes, a.created_at, a.archived_at, a.uploaded_by_user_id,
                         u.display_name AS uploaded_by_name
                    FROM document_attachments a LEFT JOIN users u ON u.id = a.uploaded_by_user_id`;

router.get('/:docType/:docId', requireAuth, async (req, res, next) => {
  try {
    const doc = await docFor(req);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    const [rows] = await pool.query(`${LIST_SQL} WHERE a.doc_type = ? AND a.doc_id = ? ORDER BY a.id`, [req.params.docType, req.params.docId]);
    res.json({ attachments: rows, kinds: KINDS, canAdd: doc.canAdd, canEdit: doc.canEdit, me: req.user.id });
  } catch (err) { next(err); }
});

router.post('/:docType/:docId', requireAuth, async (req, res, next) => {
  try {
    const doc = await docFor(req);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!doc.canAdd) return res.status(403).json({ error: 'You cannot attach files here.' });
    const { file_name: fileName, data, mime_type: mimeType, kind } = req.body || {};
    if (!fileName || !data) return res.status(400).json({ error: 'file_name and data are required.' });
    if (!TYPES.test(String(mimeType || ''))) return res.status(400).json({ error: 'Only a PDF or an image can be attached.' });
    // A bare base64 string or a full data: URL (what the browser's FileReader hands back).
    const buf = Buffer.from(String(data).includes(',') ? String(data).split(',').pop() : String(data), 'base64');
    if (!buf.length) return res.status(400).json({ error: 'That file is empty.' });
    if (buf.length > MAX_BYTES) return res.status(413).json({ error: 'Attachments must be 10MB or smaller.' });
    const [r] = await pool.query(
      `INSERT INTO document_attachments (doc_type, doc_id, kind, file_name, mime_type, size_bytes, file_data, uploaded_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.params.docType, req.params.docId, KINDS.includes(kind) ? kind : KINDS[0], String(fileName).slice(0, 255),
        String(mimeType).slice(0, 100), buf.length, buf, req.user.id]);
    const [[row]] = await pool.query(`${LIST_SQL} WHERE a.id = ?`, [r.insertId]);
    res.status(201).json(row);
  } catch (err) { next(err); }
});

router.get('/:docType/:docId/:attachmentId/file', requireAuth, async (req, res, next) => {
  try {
    const doc = await docFor(req);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    const [[row]] = await pool.query(
      'SELECT file_name, mime_type, archive_path, file_data FROM document_attachments WHERE id = ? AND doc_type = ? AND doc_id = ?',
      [req.params.attachmentId, req.params.docType, req.params.docId]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    // Moved to the office archive drive (db/archive-attachments.js): served from there.
    if (row.archive_path) return sendArchived(req, res, row);
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${row.file_name.replace(/"/g, '')}"`);
    res.send(row.file_data);
  } catch (err) { next(err); }
});

router.delete('/:docType/:docId/:attachmentId', requireAuth, async (req, res, next) => {
  try {
    const doc = await docFor(req);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    const [[row]] = await pool.query(
      'SELECT uploaded_by_user_id FROM document_attachments WHERE id = ? AND doc_type = ? AND doc_id = ?',
      [req.params.attachmentId, req.params.docType, req.params.docId]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!doc.canEdit && Number(row.uploaded_by_user_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'Only whoever attached it, or someone who can edit, can remove this file.' });
    }
    await pool.query('DELETE FROM document_attachments WHERE id = ?', [req.params.attachmentId]);
    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
