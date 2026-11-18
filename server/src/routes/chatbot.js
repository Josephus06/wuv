const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { answerQuestion, isTicketTrigger } = require('../lib/chatbotIntents');
const { parseAction, isConfirmation, offerAction, runAction } = require('../lib/chatbotActions');

const router = express.Router();

router.post('/ask', requireAuth, async (req, res, next) => {
  try {
    const message = String(req.body.message || '').trim();
    if (!message) return res.status(400).json({ error: 'Message is required.' });
    const history = Array.isArray(req.body.history) ? req.body.history : [];
    const pendingAction = req.body.pendingAction || null;

    if (isTicketTrigger(message)) {
      return res.json({ reply: 'Sure — which department is this for?', isTicketTrigger: true });
    }

    // An offer is on the table from the previous turn. A yes runs it, a no drops it, and
    // anything else is treated as a change of subject -- the offer is discarded rather than
    // left hanging, so a later stray "ok" cannot go back and trigger it.
    if (pendingAction) {
      const answer = isConfirmation(message);
      if (answer === 'yes') {
        return res.json({ reply: await runAction(req.user, pendingAction), isTicketTrigger: false });
      }
      if (answer === 'no') {
        return res.json({ reply: 'Left it alone. Nothing was created.', isTicketTrigger: false });
      }
    }

    // Deterministic, never the model's decision: see lib/chatbotActions.js.
    const action = parseAction(message);
    if (action) {
      const offer = await offerAction(req.user, action);
      if (offer) {
        return res.json({
          reply: offer.reply,
          pendingAction: offer.pendingAction || null,
          isTicketTrigger: false,
        });
      }
    }

    const reply = await answerQuestion(req.user, message, history);
    res.json({ reply, isTicketTrigger: false });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
