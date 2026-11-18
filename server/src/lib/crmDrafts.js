// CRM > Email Drafts: check-in and birthday emails written for a rep to review and send.
//
// NOTHING IS SENT WITHOUT A PERSON. The AI (or, with no OPENAI_API_KEY, a plain template) only
// produces a crm_email_drafts row; a rep reads it, edits it if they like, and presses Send. That
// was the user's explicit choice -- keep it that way.
//
// What the model is told, and what it is not:
//   - it gets the contact's name/title/personal notes, what the customer usually buys, the last
//     visit, and WHY the customer is on the Needs Attention list;
//   - it is told never to mention money owed, falling sales, scores, or that it is automated.
//     "Your orders dropped 80%" and "you owe us ₱45,000" are for the rep to know, not to write.
//     A check-in that reads like a dunning letter does more harm than no email.
//
// Every sent email carries an unsubscribe link (routes/crmPublic.js). Opted-out addresses are
// skipped when drafting and refused when sending, and a contact is not emailed twice inside
// MIN_DAYS_BETWEEN_EMAILS.
const crypto = require('crypto');
const pool = require('../db');
const mailer = require('./mailer');
const { getSalesRepEmployeeScope } = require('./salesVisibility');
const { daysToBirthday } = require('./crmAttention');
const { businessToday } = require('./crmCadence');

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const COMPANY = process.env.CRM_COMPANY_NAME || require('../config/company').COMPANY.name;
// The address customers' unsubscribe links point at. It must be the PUBLIC https name, not
// whatever the rep happens to be browsing on -- office staff use the LAN address, which no
// customer can reach. No fallback to localhost: with neither set, sending is refused (sendDraft).
const PUBLIC_URL = (process.env.CRM_PUBLIC_URL || process.env.CLIENT_URL || '').replace(/\/+$/, '') || null;
const MIN_DAYS_BETWEEN_EMAILS = 7;
const BIRTHDAY_LOOKAHEAD_DAYS = 3;
const CHECKIN_COOLDOWN_DAYS = 30; // nightly job: no new check-in draft for a customer inside this
const AUTO_PER_OWNER = Number(process.env.CRM_AUTO_DRAFTS_PER_REP || 3);
const AUTO_MAX = Number(process.env.CRM_AUTO_DRAFTS_MAX || 60);
const EMAIL_RE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
// Our own staff addresses turn up on customer contacts (13 of them on the office data); a
// check-in from us to us is noise.
const INTERNAL_DOMAINS = process.env.CRM_INTERNAL_EMAIL_DOMAINS
  ? process.env.CRM_INTERNAL_EMAIL_DOMAINS.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)
  : require('../config/company').COMPANY.emailDomains;

// customer_contacts.email is free text from the old system: "a@x.com>", "Name <a@x.com>",
// "a@x.com / b@y.com". Take the first real address in it, or null.
function normalizeEmail(raw) {
  const m = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/.exec(String(raw || ''));
  return m ? m[0].toLowerCase() : null;
}
function isInternal(email) {
  const domain = String(email).split('@')[1] || '';
  return INTERNAL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

// --- unsubscribe links ---------------------------------------------------------------------------
// Stateless: the link names the address and carries an HMAC of it, so it cannot be forged to
// unsubscribe somebody else and needs no token table.
function unsubscribeSig(email) {
  return crypto.createHmac('sha256', `${process.env.JWT_SECRET}:crm-unsubscribe`)
    .update(String(email).trim().toLowerCase()).digest('hex').slice(0, 32);
}
function unsubscribeUrl(email) {
  const e = String(email).trim().toLowerCase();
  return `${PUBLIC_URL}/api/crm-public/unsubscribe?e=${encodeURIComponent(e)}&s=${unsubscribeSig(e)}`;
}
function verifyUnsubscribe(email, sig) {
  const expected = unsubscribeSig(email);
  return typeof sig === 'string' && sig.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

async function isOptedOut(email) {
  const [[row]] = await pool.query('SELECT 1 AS x FROM crm_email_optouts WHERE email = ?', [String(email).trim().toLowerCase()]);
  return !!row;
}

// --- context -------------------------------------------------------------------------------------
// Days until the contact's next birthday on the business clock (0 = today), or null.
function daysUntilBirthday(birthday) {
  if (!birthday) return null;
  const next = daysToBirthday(birthday, businessToday());
  return next ? next.days : null;
}

// The contact to write to: the one asked for, else the primary, else anyone with an address --
// skipping unusable, internal and unsubscribed addresses. The returned contact's `email` is the
// cleaned address.
async function pickContact(customerId, contactId) {
  const [contacts] = await pool.query(
    `SELECT cc.* FROM customer_contacts cc
      WHERE cc.customer_id = ? AND cc.email LIKE '%@%'
      ORDER BY cc.is_primary DESC, cc.id`, [customerId],
  );
  const [optedOut] = await pool.query('SELECT email FROM crm_email_optouts');
  const blocked = new Set(optedOut.map((o) => o.email.toLowerCase()));
  const usable = contacts
    .map((c) => ({ ...c, email: normalizeEmail(c.email) }))
    .filter((c) => c.email && !isInternal(c.email) && !blocked.has(c.email));
  if (contactId) return usable.find((c) => String(c.id) === String(contactId)) || null;
  return usable[0] || null;
}

async function gatherContext(customerId, contact) {
  const [[customer]] = await pool.query('SELECT id, name, company_name FROM customers WHERE id = ?', [customerId]);
  const [[attention]] = await pool.query('SELECT reasons, owner_employee_id FROM crm_attention WHERE customer_id = ?', [customerId]);
  const [products] = await pool.query(
    `SELECT jt.display_name, COUNT(*) AS n
       FROM sales_orders so
       JOIN sales_order_lines l ON l.sales_order_id = so.id
       JOIN job_types jt ON jt.id = l.job_type_id
      WHERE so.customer_id = ? AND so.status <> 'cancelled' AND so.date_created >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
      GROUP BY jt.display_name ORDER BY n DESC LIMIT 3`, [customerId],
  );
  const [[lastVisit]] = await pool.query(
    `SELECT subject, outcome, COALESCE(starts_at, completed_at, created_at) AS at FROM crm_activities
      WHERE related_type = 'Customer' AND related_id = ? AND activity_type = 'visit' AND is_done = TRUE
      ORDER BY at DESC LIMIT 1`, [customerId],
  );
  // Owner falls back to the rep on the latest order when the customer is not on the list.
  let ownerEmployeeId = attention?.owner_employee_id || null;
  if (!ownerEmployeeId) {
    const [[so]] = await pool.query('SELECT sales_rep_id FROM sales_orders WHERE customer_id = ? ORDER BY date_created DESC, id DESC LIMIT 1', [customerId]);
    ownerEmployeeId = so?.sales_rep_id || null;
  }
  const reasons = attention ? (typeof attention.reasons === 'string' ? JSON.parse(attention.reasons) : attention.reasons) : [];
  return {
    customer,
    contact,
    reasons,
    products: products.map((p) => p.display_name),
    lastVisit: lastVisit || null,
    ownerEmployeeId,
    birthdayInDays: daysUntilBirthday(contact.birthday),
  };
}

// --- writing -------------------------------------------------------------------------------------
function firstName(name) { return String(name || '').trim().split(/\s+/)[0] || 'there'; }

function templateDraft(kind, ctx, senderName) {
  const hi = `Hi ${firstName(ctx.contact.contact_name)},`;
  if (kind === 'birthday') {
    return {
      subject: `Happy birthday, ${firstName(ctx.contact.contact_name)}!`,
      body: `${hi}\n\nWishing you a very happy birthday from all of us at ${COMPANY}! We hope you have a wonderful day and a great year ahead.\n\nThank you for working with us.\n\nBest regards,\n${senderName}`,
    };
  }
  const product = ctx.products[0] ? ` and see how the recent ${ctx.products[0].toLowerCase()} work turned out` : '';
  return {
    subject: `Checking in from ${COMPANY}`,
    body: `${hi}\n\nIt's been a little while, so I wanted to check in${product}. Is there anything coming up that we can help you with?\n\nI'd be happy to drop by or set up a quick call whenever it suits you.\n\nBest regards,\n${senderName}`,
  };
}

async function aiDraft(kind, ctx, senderName) {
  const facts = {
    kind,
    company: COMPANY,
    sender_name: senderName,
    customer: ctx.customer.company_name || ctx.customer.name,
    contact_name: ctx.contact.contact_name,
    contact_title: ctx.contact.title || null,
    personal_notes: ctx.contact.personal_notes || null,
    usually_buys: ctx.products,
    last_visit: ctx.lastVisit ? { about: ctx.lastVisit.subject, outcome: ctx.lastVisit.outcome, date: String(ctx.lastVisit.at).slice(0, 10) } : null,
    why_reaching_out: ctx.reasons.filter((r) => r.code !== 'scheduled').map((r) => r.code),
  };
  const system = [
    `You write short, warm emails from a sales representative at ${COMPANY}, a printing and signage company in the Philippines, to a customer contact.`,
    'Write in plain, friendly, professional English. 60 to 120 words in the body. No emojis, no markdown, no placeholders like [Name].',
    'Sign off with the sender_name only (no title, no company line, no phone number).',
    kind === 'birthday'
      ? 'This is a birthday greeting. Keep it personal and do not try to sell anything.'
      : 'This is a check-in to keep in touch and offer help. Offer to visit or call. You may mention what they usually buy.',
    'NEVER mention: money owed, unpaid invoices, payment, discounts or prices, that their orders or sales have dropped, scores, lists, or that this email was automated or AI-written.',
    'why_reaching_out is internal context only (e.g. "reorder" means they have not ordered in a while) -- let it shape the tone, never state it.',
    'Use personal_notes only if they are clearly friendly to bring up; never reveal that notes are kept.',
    'Reply with JSON only: {"subject": "...", "body": "..."} where body uses \\n for line breaks.',
  ].join('\n');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.7,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(facts) }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`OpenAI request failed: ${res.status}`);
  const data = await res.json();
  const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
  const subject = String(parsed.subject || '').trim().slice(0, 200);
  const body = String(parsed.body || '').trim();
  if (!subject || !body) throw new Error('OpenAI returned an empty draft');
  return { subject, body };
}

async function write(kind, ctx, senderName) {
  if (process.env.OPENAI_API_KEY) {
    try {
      return { ...(await aiDraft(kind, ctx, senderName)), generated_by: 'ai' };
    } catch (err) {
      console.error('CRM draft: AI failed, using the template instead:', err.message);
    }
  }
  return { ...templateDraft(kind, ctx, senderName), generated_by: 'template' };
}

// The name an email is signed with: the account owner when there is one, else whoever asked.
async function senderNameFor(ownerEmployeeId, userId) {
  if (ownerEmployeeId) {
    const [[e]] = await pool.query('SELECT first_name, last_name FROM employees WHERE id = ?', [ownerEmployeeId]);
    const n = e ? `${e.first_name || ''} ${e.last_name || ''}`.trim() : '';
    if (n) return n;
  }
  if (userId) {
    const [[u]] = await pool.query('SELECT display_name FROM users WHERE id = ?', [userId]);
    if (u?.display_name) return u.display_name;
  }
  return `The ${COMPANY} team`;
}

function reasonSummary(kind, ctx) {
  if (kind === 'birthday') {
    return ctx.birthdayInDays === 0 ? `${ctx.contact.contact_name}'s birthday is today` : `${ctx.contact.contact_name}'s birthday is in ${ctx.birthdayInDays} day(s)`;
  }
  return ctx.reasons.map((r) => r.text).join(' · ').slice(0, 500) || 'Keeping in touch';
}

// Create one draft. kind: 'checkin' | 'birthday' | undefined (birthday if one is within a week).
// Returns { draft } or { error, status }.
async function createDraft({ customerId, contactId, kind, userId }) {
  const contact = await pickContact(customerId, contactId);
  if (!contact) return { error: 'This customer has no contact with an email address we can write to.', status: 400 };
  const ctx = await gatherContext(customerId, contact);
  if (!ctx.customer) return { error: 'Not found', status: 404 };
  const chosen = kind || (ctx.birthdayInDays !== null && ctx.birthdayInDays <= 7 ? 'birthday' : 'checkin');
  const sender = await senderNameFor(ctx.ownerEmployeeId, userId);
  const text = await write(chosen, ctx, sender);

  const [result] = await pool.query(
    `INSERT INTO crm_email_drafts
       (customer_id, contact_id, owner_employee_id, to_email, kind, reason, subject, body, generated_by, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [customerId, contact.id, ctx.ownerEmployeeId, String(contact.email).trim(), chosen, reasonSummary(chosen, ctx),
      text.subject, text.body, text.generated_by, userId || null],
  );
  const [[draft]] = await pool.query('SELECT * FROM crm_email_drafts WHERE id = ?', [result.insertId]);
  return { draft };
}

async function regenerateDraft(draft, userId) {
  const contact = await pickContact(draft.customer_id, draft.contact_id);
  if (!contact) return { error: 'The contact has no usable email address any more (or unsubscribed).', status: 400 };
  const ctx = await gatherContext(draft.customer_id, contact);
  const text = await write(draft.kind, ctx, await senderNameFor(draft.owner_employee_id, userId));
  await pool.query(
    'UPDATE crm_email_drafts SET subject = ?, body = ?, generated_by = ?, updated_at = NOW() WHERE id = ? AND status = \'draft\'',
    [text.subject, text.body, text.generated_by, draft.id],
  );
  const [[row]] = await pool.query('SELECT * FROM crm_email_drafts WHERE id = ?', [draft.id]);
  return { draft: row };
}

// --- sending -------------------------------------------------------------------------------------
function esc(v) {
  return String(v || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function renderEmail(body, toEmail) {
  const link = unsubscribeUrl(toEmail);
  const paragraphs = String(body).trim().split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">${paragraphs}
    <p style="margin:24px 0 0;font-size:11px;color:#888">You received this because you are a customer contact of ${esc(COMPANY)}.
    <a href="${esc(link)}" style="color:#888">Unsubscribe</a> if you would rather not hear from us this way.</p></div>`;
  const text = `${String(body).trim()}\n\n--\nTo stop these emails: ${link}`;
  return { html, text };
}

// Send a draft. Returns { draft } or { error, status }. The draft row is claimed first
// (draft -> sending) so two clicks cannot send it twice.
async function sendDraft(draftId, user) {
  const [claim] = await pool.query(
    "UPDATE crm_email_drafts SET status = 'sending', updated_at = NOW() WHERE id = ? AND status = 'draft'", [draftId],
  );
  if (!claim.affectedRows) return { error: 'This draft was already sent or discarded.', status: 409 };
  const [[draft]] = await pool.query('SELECT * FROM crm_email_drafts WHERE id = ?', [draftId]);
  const fail = async (error, status, keepDraft = true) => {
    await pool.query('UPDATE crm_email_drafts SET status = ?, error = ?, updated_at = NOW() WHERE id = ?',
      [keepDraft ? 'draft' : 'failed', error, draftId]);
    return { error, status };
  };

  const to = String(draft.to_email || '').trim();
  if (!EMAIL_RE.test(to)) return fail('The address is not a valid email.', 400);
  if (isInternal(to)) return fail('That is one of our own addresses, not the customer\'s.', 400);
  if (await isOptedOut(to)) return fail('This address has unsubscribed from our emails.', 400);
  const [[recent]] = await pool.query(
    `SELECT sent_at FROM crm_email_drafts WHERE status = 'sent' AND to_email = ? AND sent_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      ORDER BY sent_at DESC LIMIT 1`, [to, MIN_DAYS_BETWEEN_EMAILS],
  );
  if (recent) return fail(`We already emailed this address on ${String(recent.sent_at).slice(0, 10)}; wait a week between emails.`, 409);
  if (!mailer.isConfigured()) return fail(`Email is not set up on this server -- ${mailer.missingReason()}.`, 503);
  if (!PUBLIC_URL) return fail('CRM_PUBLIC_URL is not set on this server, so the email would carry a broken unsubscribe link.', 503);

  const [[me]] = await pool.query('SELECT display_name, email FROM users WHERE id = ?', [user.id]);
  const { html, text } = renderEmail(draft.body, to);
  const result = await mailer.send({ to, subject: draft.subject, html, text, replyTo: me?.email || undefined, fromName: me?.display_name });
  if (!result.ok) return fail(result.error || 'The email could not be sent.', 502);

  // Into the customer's activity log, so the timeline shows what was said and "last contact" counts it.
  const [act] = await pool.query(
    `INSERT INTO crm_activities
       (related_type, related_id, activity_type, subject, description, contact_id, assigned_to_user_id, created_by_user_id)
     VALUES ('Customer', ?, 'email', ?, ?, ?, ?, ?)`,
    [draft.customer_id, `Emailed: ${draft.subject}`.slice(0, 255), `To ${to}\n\n${draft.body}`.slice(0, 2000),
      draft.contact_id, user.id, user.id],
  );
  await pool.query(
    `UPDATE crm_email_drafts SET status = 'sent', sent_at = NOW(), sent_by_user_id = ?, activity_id = ?, error = NULL, updated_at = NOW()
      WHERE id = ?`, [user.id, act.insertId, draftId],
  );
  const [[row]] = await pool.query('SELECT * FROM crm_email_drafts WHERE id = ?', [draftId]);
  return { draft: row };
}

// --- nightly -------------------------------------------------------------------------------------
// Runs after the Needs Attention rebuild on the job-owning server. Birthdays first (they are
// date-bound), then the top check-ins per account owner. Bounded by AUTO_MAX so a first run on a
// big list cannot spend an afternoon of API calls.
async function autoDraft() {
  let created = 0;
  const [bdays] = await pool.query(
    `SELECT cc.id AS contact_id, cc.customer_id, cc.birthday FROM customer_contacts cc
      JOIN customers c ON c.id = cc.customer_id AND c.is_active = TRUE
     WHERE cc.birthday IS NOT NULL AND cc.email IS NOT NULL AND cc.email <> ''
       AND NOT EXISTS (SELECT 1 FROM crm_email_optouts o WHERE o.email = LOWER(TRIM(cc.email)))
       AND NOT EXISTS (SELECT 1 FROM crm_email_drafts d WHERE d.contact_id = cc.id AND d.kind = 'birthday'
                        AND d.created_at >= DATE_SUB(NOW(), INTERVAL 300 DAY))`,
  );
  for (const b of bdays) {
    if (created >= AUTO_MAX) break;
    const days = daysUntilBirthday(b.birthday);
    if (days === null || days > BIRTHDAY_LOOKAHEAD_DAYS) continue;
    const r = await createDraft({ customerId: b.customer_id, contactId: b.contact_id, kind: 'birthday' });
    if (r.draft) created += 1;
  }

  // Check-ins: customers on the list for relationship reasons (overdue-only is a collections
  // matter, not a friendly note), not snoozed, with no draft or email in the cooldown.
  const [candidates] = await pool.query(
    `SELECT a.customer_id, a.owner_employee_id FROM crm_attention a
      LEFT JOIN crm_attention_snoozes s ON s.customer_id = a.customer_id AND s.snoozed_until >= CURDATE()
     WHERE s.customer_id IS NULL
       AND (JSON_SEARCH(a.reasons, 'one', 'reorder', NULL, '$[*].code') IS NOT NULL
         OR JSON_SEARCH(a.reasons, 'one', 'trend', NULL, '$[*].code') IS NOT NULL
         OR JSON_SEARCH(a.reasons, 'one', 'visit', NULL, '$[*].code') IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM crm_email_drafts d WHERE d.customer_id = a.customer_id
                        AND d.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY))
       AND EXISTS (SELECT 1 FROM customer_contacts cc WHERE cc.customer_id = a.customer_id
                    AND cc.email IS NOT NULL AND cc.email <> ''
                    AND NOT EXISTS (SELECT 1 FROM crm_email_optouts o WHERE o.email = LOWER(TRIM(cc.email))))
     ORDER BY a.score DESC`, [CHECKIN_COOLDOWN_DAYS],
  );
  const perOwner = new Map();
  for (const c of candidates) {
    if (created >= AUTO_MAX) break;
    const k = c.owner_employee_id || 0;
    if ((perOwner.get(k) || 0) >= AUTO_PER_OWNER) continue;
    const r = await createDraft({ customerId: c.customer_id, kind: 'checkin' });
    if (r.draft) {
      created += 1;
      perOwner.set(k, (perOwner.get(k) || 0) + 1);
    }
  }
  return { created };
}

// Which drafts a user may see/act on: the same owner scope as the Needs Attention list.
async function draftVisible(userId, draft) {
  const scope = await getSalesRepEmployeeScope(userId);
  return !scope || scope.includes(draft.owner_employee_id);
}

module.exports = {
  createDraft, regenerateDraft, sendDraft, autoDraft, draftVisible,
  verifyUnsubscribe, unsubscribeUrl, renderEmail, templateDraft,
};
