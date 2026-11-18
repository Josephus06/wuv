const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { getSalesRepEmployeeScope } = require('../lib/salesVisibility');
const { createDraft, regenerateDraft, sendDraft, draftVisible } = require('../lib/crmDrafts');

// CRM > Email Drafts. Seeing the list takes the CRM Dashboard's view right; writing, sending or
// discarding one takes its edit right -- sending mail to a customer is an action, not a read.
// Rows are narrowed to the customers the caller can see, exactly as Needs Attention is.
const router = express.Router();
const ROUTE = '/crm-dashboard';

async function loadVisible(req, res) {
  const [[draft]] = await pool.query('SELECT * FROM crm_email_drafts WHERE id = ?', [req.params.id]);
  if (!draft || !(await draftVisible(req.user.id, draft))) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  return draft;
}

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const status = ['draft', 'sent', 'discarded'].includes(req.query.status) ? req.query.status : 'draft';
    const scope = await getSalesRepEmployeeScope(req.user.id, ROUTE);
    const where = ['d.status = ?'];
    const params = [status];
    if (scope) {
      where.push('d.owner_employee_id IN (?)');
      params.push(scope.length ? scope : [0]);
    }
    if (req.query.customer_id) {
      where.push('d.customer_id = ?');
      params.push(Number(req.query.customer_id));
    }
    const [rows] = await pool.query(
      `SELECT d.*, c.name AS customer_name, cc.contact_name,
              TRIM(CONCAT(COALESCE(e.first_name, ''), ' ', COALESCE(e.last_name, ''))) AS owner_name,
              u.display_name AS sent_by_name
         FROM crm_email_drafts d
         JOIN customers c ON c.id = d.customer_id
         LEFT JOIN customer_contacts cc ON cc.id = d.contact_id
         LEFT JOIN employees e ON e.id = d.owner_employee_id
         LEFT JOIN users u ON u.id = d.sent_by_user_id
        WHERE ${where.join(' AND ')}
        ORDER BY ${status === 'draft' ? "(d.kind = 'birthday') DESC, d.created_at DESC" : 'COALESCE(d.sent_at, d.updated_at) DESC'}
        LIMIT 200`, params,
    );
    res.json({ ai: !!process.env.OPENAI_API_KEY, rows });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const { customer_id: customerId, contact_id: contactId, kind } = req.body;
    if (!customerId) return res.status(400).json({ error: 'customer_id is required.' });
    if (kind && !['checkin', 'birthday'].includes(kind)) return res.status(400).json({ error: 'Unknown email kind.' });
    const result = await createDraft({ customerId, contactId, kind, userId: req.user.id });
    if (result.error) return res.status(result.status).json({ error: result.error });
    if (!(await draftVisible(req.user.id, result.draft))) {
      // Written for a customer outside the caller's scope -- do not leave it lying in someone's inbox.
      await pool.query('DELETE FROM crm_email_drafts WHERE id = ?', [result.draft.id]);
      return res.status(404).json({ error: 'Not found' });
    }
    res.status(201).json(result.draft);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const draft = await loadVisible(req, res);
    if (!draft) return;
    const subject = String(req.body.subject || '').trim();
    const body = String(req.body.body || '').trim();
    const to = String(req.body.to_email || '').trim();
    if (!subject || !body || !to) return res.status(400).json({ error: 'Subject, body and address are all required.' });
    const [r] = await pool.query(
      "UPDATE crm_email_drafts SET subject = ?, body = ?, to_email = ?, updated_at = NOW() WHERE id = ? AND status = 'draft'",
      [subject.slice(0, 255), body, to.slice(0, 150), draft.id],
    );
    if (!r.affectedRows) return res.status(409).json({ error: 'This draft was already sent or discarded.' });
    const [[row]] = await pool.query('SELECT * FROM crm_email_drafts WHERE id = ?', [draft.id]);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/regenerate', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const draft = await loadVisible(req, res);
    if (!draft) return;
    if (draft.status !== 'draft') return res.status(409).json({ error: 'This draft was already sent or discarded.' });
    const result = await regenerateDraft(draft, req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.draft);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/send', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const draft = await loadVisible(req, res);
    if (!draft) return;
    const result = await sendDraft(draft.id, req.user);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.draft);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/discard', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const draft = await loadVisible(req, res);
    if (!draft) return;
    await pool.query("UPDATE crm_email_drafts SET status = 'discarded', updated_at = NOW() WHERE id = ? AND status = 'draft'", [draft.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
