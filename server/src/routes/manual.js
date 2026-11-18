const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { buildManualPdf } = require('../lib/manualPdf');
const pool = require('../db');

const router = express.Router();
const ROUTE = '/process-flow';

// The Manual, as a PDF.
//
// GATED ON can_view, NOT can_print. The convention here is that printed output needs can_print,
// and for a Job Order that is right -- the printed sheet goes to the production floor. A manual is
// reference material somebody is already reading on screen, and saving it as a PDF reveals nothing
// new. On the droplet 47 people can open this page and 2 hold can_print, so the stricter gate would
// lock 45 of them out of a copy of something already in front of them.
//
// THE CLIENT SENDS THE LAYOUT. The elbow routing that draws the connectors lives in ProcessFlow.jsx
// and is genuinely fiddly; a second implementation here would drift from the chart on screen, and
// this PDF is meant to BE that chart. So the browser sends each edge's finished SVG path and the
// node boxes it already computed, and this renders them. See lib/manualPdf.js.
//
// That makes the body the only input, so it is bounded: a manual is tens of kilobytes, and nothing
// here is stored or echoed back to anybody else.
const MAX_NODES = 400;
const MAX_EDGES = 800;

/* -------------------------------------------------------------------------- */
/* Step pictures (2026-10-14; db/add-manual-step-images.js)                    */
/* -------------------------------------------------------------------------- */
// Everyone who can read the Manual sees them; Edit on the Manual adds, replaces and removes them.
const MAX_IMAGE_BYTES = 1.4 * 1024 * 1024; // inside the 2 MB request limit once base64; the browser shrinks screenshots well below it
const KEY_RE = /^[\w.-]{1,60}$/;
const noTable = (e) => e && e.code === 'ER_NO_SUCH_TABLE';

// Which steps of a workflow have a picture: [{ id, node_id, step_index, updated_at }]
router.get('/images', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const flow = String(req.query.flow || '');
    if (!KEY_RE.test(flow)) return res.json([]);
    const [rows] = await pool.query(
      'SELECT id, node_id, step_index, updated_at FROM manual_step_images WHERE flow_key = ?', [flow]);
    res.json(rows);
  } catch (err) {
    if (noTable(err)) return res.json([]);
    next(err);
  }
});

router.get('/images/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[row]] = await pool.query('SELECT mime_type, image_data, updated_at FROM manual_step_images WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', row.mime_type);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(row.image_data);
  } catch (err) { next(err); }
});

// { flow, node, step, data: data URL } -- adds the step's picture, or replaces it.
router.put('/images', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { flow, node } = req.body || {};
    const step = Number(req.body?.step);
    if (!KEY_RE.test(String(flow || '')) || !KEY_RE.test(String(node || '')) || !Number.isInteger(step) || step < 0 || step > 200) {
      return res.status(400).json({ error: 'Which step is this picture for?' });
    }
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(String(req.body?.data || ''));
    if (!m) return res.status(400).json({ error: 'That is not a picture.' });
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length) return res.status(400).json({ error: 'That picture is empty.' });
    if (buf.length > MAX_IMAGE_BYTES) return res.status(413).json({ error: 'That picture is too large.' });
    await pool.query(
      `INSERT INTO manual_step_images (flow_key, node_id, step_index, mime_type, image_data, uploaded_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE mime_type = VALUES(mime_type), image_data = VALUES(image_data),
                               uploaded_by_user_id = VALUES(uploaded_by_user_id)`,
      [flow, node, step, m[1], buf, req.user.id]);
    const [[row]] = await pool.query(
      'SELECT id, node_id, step_index, updated_at FROM manual_step_images WHERE flow_key = ? AND node_id = ? AND step_index = ?',
      [flow, node, step]);
    res.json(row);
  } catch (err) {
    if (noTable(err)) return res.status(503).json({ error: 'Step pictures are not set up yet (db/add-manual-step-images.js).' });
    next(err);
  }
});

router.delete('/images/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM manual_step_images WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/pdf', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const flow = req.body || {};
    const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
    const edges = Array.isArray(flow.edges) ? flow.edges : [];

    if (!nodes.length) return res.status(400).json({ error: 'There is nothing to put in the PDF.' });
    if (nodes.length > MAX_NODES || edges.length > MAX_EDGES) {
      return res.status(413).json({ error: 'That workflow is too large to render.' });
    }
    if (!flow.canvas?.w || !flow.canvas?.h) {
      return res.status(400).json({ error: 'The chart has no size.' });
    }

    const pdf = await buildManualPdf(flow);

    const name = String(flow.title || 'workflow').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name || 'workflow'}-manual.pdf"`);
    res.setHeader('Content-Length', pdf.length);
    return res.end(pdf);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
