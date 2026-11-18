const pool = require('../db');
const { userCan } = require('../middleware/auth');
const { getSalesRepEmployeeScope } = require('./salesVisibility');
const { replicateNonStandardJobOrder } = require('../routes/nonStandardJobOrders');
const { replicateEstimate } = require('../routes/estimates');

// Things the chatbot can DO, as opposed to everything else it does, which is read-only.
//
// Three rules hold this together, and they are the reason a language model having write access
// to an ERP is not the alarming idea it sounds like:
//
// 1. The intent is matched deterministically, by the regex below -- never by the model. The
//    model is not asked whether the user wanted to create something, and it cannot decide to.
//    Same reasoning as isTicketTrigger in chatbotIntents.js.
// 2. Nothing happens without a yes. Every action states exactly what it will do and waits.
//    A wrongly matched message costs one question, not a stray job order.
// 3. Permission is checked against the same page right the button obeys, at the moment of
//    execution -- not when the confirmation was offered. Someone whose access is withdrawn
//    mid-conversation cannot spend a yes they were already holding.
//
// The pending action travels to the browser and back between the two turns. That is safe
// because it is re-validated on the way in: it names what to copy, it does not authorise
// copying it, so a tampered one can only ask for something the user could already do through
// the API directly.
const NSTDJO_ROUTE = '/non-standard-job-orders';
const ESTIMATE_ROUTE = '/estimates';

// "replicate NSTDJO-851", "please copy nstdjo 851", "duplicate EST-100237 for me". Not
// anchored to the start because people put please, hi, and their whole day in front of it.
// A leading "how" is excluded -- "how do I replicate NSTDJO-851" is asking to be taught, not
// asking for a copy.
//
// The two document kinds are matched in one pass rather than one regex each, so a message
// naming both cannot quietly match whichever pattern happens to be tried first.
const VERB = '(?:replicate|duplicate|copy|kopyaha|balika)';
const REPLICATE_RE = new RegExp(`\\b${VERB}\\b[^\\n]{0,40}?\\b(NSTDJO|EST)[-\\s]?(\\d+)\\b`, 'i');
const ASKING_HOW_RE = /^\s*(?:how|unsaon|pa?unsa)\b/i;

// Cebuano alongside English: sige and oo are how half the office says yes.
// A short courtesy tail is allowed -- "yes please", "sige lang" -- but nothing longer, so
// "no problem, now tell me about..." reads as a change of subject rather than an answer.
const TAIL = '(?:\\s+(?:please|pls|po|lang|na|sir|maam|thanks|thank you))*';
const YES_RE = new RegExp(`^\\s*(?:y|yes|yeah|yep|yup|ok|okay|sure|proceed|confirm|confirmed|go ahead|do it|sige|oo|padayon)${TAIL}[\\s.!]*$`, 'i');
const NO_RE = new RegExp(`^\\s*(?:n|no|nope|cancel|stop|nevermind|never mind|ayaw|dili|wala)${TAIL}[\\s.!]*$`, 'i');

function parseAction(message) {
  const text = String(message || '');
  if (ASKING_HOW_RE.test(text)) return null;
  const m = text.match(REPLICATE_RE);
  if (!m) return null;
  return {
    kind: m[1].toUpperCase() === 'EST' ? 'replicate_estimate' : 'replicate_nstdjo',
    number: Number(m[2]),
  };
}

function isConfirmation(message) {
  if (YES_RE.test(String(message || ''))) return 'yes';
  if (NO_RE.test(String(message || ''))) return 'no';
  return null;
}

async function findNstdjo(number) {
  // Matched on the printed number rather than the row id: NSTDJO-851 is what people read off
  // the screen, and on the office server the ids run on a different auto_increment offset, so
  // treating the two as interchangeable would copy a different order there.
  const [[order]] = await pool.query(
    `SELECT n.id, n.nstdjo_no, n.description, n.status, n.sub_status, c.name AS customer_name,
            (SELECT COUNT(*) FROM non_standard_job_order_materials m
              WHERE m.non_standard_job_order_id = n.id) AS line_count
       FROM non_standard_job_orders n
       LEFT JOIN customers c ON c.id = n.customer_id
      WHERE n.nstdjo_no = ?`,
    [`NSTDJO-${number}`],
  );
  return order || null;
}

// Estimates are scoped per sales rep -- a rep cannot open someone else's, and the Replicate
// button only exists on a page they could open. So the same scope is applied here, or the
// chatbot would become a way to copy, and thereby read, an estimate belonging to someone else.
// Non-standard job orders carry no such per-record filter, so their lookup has none either.
async function findEstimate(userId, number) {
  const [[estimate]] = await pool.query(
    `SELECT e.id, e.estimate_no, e.status, e.sales_rep_id, e.total_amount, c.name AS customer_name,
            (SELECT COUNT(*) FROM estimate_job_orders j WHERE j.estimate_id = e.id) AS line_count
       FROM estimates e
       LEFT JOIN customers c ON c.id = e.customer_id
      WHERE e.estimate_no = ?`,
    [`EST-${number}`],
  );
  if (!estimate) return null;
  const scope = await getSalesRepEmployeeScope(userId);
  if (scope && !scope.includes(estimate.sales_rep_id)) return null;
  return estimate;
}

// Turns a matched command into a question, or into the reason it cannot be done. Returns
// { reply, pendingAction } -- pendingAction only when there is genuinely something to confirm.
async function offerAction(user, action) {
  if (action.kind === 'replicate_estimate') {
    if (!await userCan(user.id, ESTIMATE_ROUTE, 'can_add')) {
      return { reply: 'You do not have permission to add estimates, so I cannot replicate one for you. Ask an administrator for "add" rights on Estimates.' };
    }
    const estimate = await findEstimate(user.id, action.number);
    // Out of scope and not existing give the same answer on purpose: telling someone an
    // estimate exists but belongs to another rep is itself a disclosure.
    if (!estimate) return { reply: `I could not find EST-${action.number}.` };

    const lines = Number(estimate.line_count) || 0;
    return {
      reply: [
        `Replicating ${estimate.estimate_no}${estimate.customer_name ? ` for ${estimate.customer_name}` : ''} will create a NEW draft estimate copying its header, ${lines} job line${lines === 1 ? '' : 's'} and every process line under them.`,
        `The copy is dated today and starts back at Pending Supervisor Approval. ${estimate.estimate_no} itself is left untouched.`,
        'Reply "yes" to go ahead, or "no" to leave it.',
      ].join('\n\n'),
      pendingAction: { kind: action.kind, id: estimate.id, estimate_no: estimate.estimate_no },
    };
  }

  if (action.kind !== 'replicate_nstdjo') return null;

  if (!await userCan(user.id, NSTDJO_ROUTE, 'can_add')) {
    return { reply: 'You do not have permission to add non-standard job orders, so I cannot replicate one for you. Ask an administrator for "add" rights on Non-Standard Job Orders.' };
  }

  const order = await findNstdjo(action.number);
  if (!order) return { reply: `I could not find NSTDJO-${action.number}.` };

  const lines = Number(order.line_count) || 0;
  return {
    reply: [
      `Replicating ${order.nstdjo_no}${order.customer_name ? ` for ${order.customer_name}` : ''} will create a NEW job order copying its customer, job details and ${lines} material line${lines === 1 ? '' : 's'}.`,
      'The copy starts at the beginning of the workflow under your name and goes to your own department approvers. The artist assignment, timers and approvals are not carried over, and '
        + `${order.nstdjo_no} itself is left untouched.`,
      'Reply "yes" to go ahead, or "no" to leave it.',
    ].join('\n\n'),
    pendingAction: { kind: action.kind, id: order.id, nstdjo_no: order.nstdjo_no },
  };
}

// The second turn. Everything is checked again here rather than trusted from the offer.
async function runAction(user, pendingAction) {
  if (pendingAction?.kind === 'replicate_estimate') {
    if (!await userCan(user.id, ESTIMATE_ROUTE, 'can_add')) {
      return 'You do not have permission to add estimates.';
    }
    // Re-resolved through the scoped lookup, not taken from the offer: the id arrived from
    // the browser, and this is the check that stops it naming somebody else's estimate.
    const number = Number(String(pendingAction.estimate_no || '').replace(/^EST-/i, ''));
    const estimate = await findEstimate(user.id, number);
    if (!estimate || estimate.id !== Number(pendingAction.id)) {
      return `I could not find ${pendingAction.estimate_no || 'that estimate'}.`;
    }
    try {
      const created = await replicateEstimate(user.id, estimate.id);
      return `Done — ${created.estimate_no} is a copy of ${created.replicated_from}, with ${created.job_orders} job line${created.job_orders === 1 ? '' : 's'}. It is a draft at Pending Supervisor Approval.`;
    } catch (err) {
      if (err.status) return err.message;
      console.error('[chatbot] replicate estimate failed:', err.message);
      return 'Sorry, I could not raise that copy. Nothing was created.';
    }
  }

  if (!pendingAction || pendingAction.kind !== 'replicate_nstdjo') {
    return 'I am not sure what you are confirming — say what you would like me to do.';
  }
  if (!await userCan(user.id, NSTDJO_ROUTE, 'can_add')) {
    return 'You do not have permission to add non-standard job orders.';
  }
  try {
    const created = await replicateNonStandardJobOrder(user.id, Number(pendingAction.id));
    // Where it landed depends on whether the raiser has approvers at all, so it is read off
    // the result rather than asserted -- telling someone it is with their approvers when it
    // went straight to Pending sends them looking for an approval that is never coming.
    const waiting = created.sub_status === 'SBU Approval'
      ? ' and is waiting on your department approvers'
      : '';
    return `Done — ${created.nstdjo_no} is a copy of ${created.replicated_from}, with ${created.lines} material line${created.lines === 1 ? '' : 's'}. It is at ${created.sub_status}${waiting}.`;
  } catch (err) {
    if (err.status) return err.message;
    console.error('[chatbot] replicate failed:', err.message);
    return 'Sorry, I could not raise that copy. Nothing was created.';
  }
}

module.exports = { parseAction, isConfirmation, offerAction, runAction };
