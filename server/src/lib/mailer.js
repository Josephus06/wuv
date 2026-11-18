// The one place this system sends mail, by whichever route the install actually has.
//
// Until now the only thing that sent mail was the nightly ticket reminder, which built its own
// transport inline. A second sender (estimates going to customers) made that a fork in the road:
// either two copies of the same configuration drift apart, or there is one place to change when
// the mail host does. This is that place.
//
// NOT CONFIGURED IS A NORMAL STATE, NOT AN ERROR. The office install has SMTP settings; the cloud
// server currently does not, and says so at boot ("Ticket reminder email job disabled because SMTP
// configuration is missing"). Callers need to distinguish "we could not send" from "this
// installation does not send mail at all", because only one of those is worth telling a user to
// go and fix. So `isConfigured()` is separate from `send()` rather than being discovered by
// catching an exception.
//
// TWO TRANSPORTS, BECAUSE ONE OF THEM DOES NOT WORK EVERYWHERE. The office and cloud installs
// reach an SMTP server perfectly well. Railway does not: outbound SMTP is blocked there on every
// port and to every provider -- smtp.gmail.com:587 and secure262.inmotionhosting.com:465 both
// time out -- which is a deliberate anti-spam measure on the platform, not a misconfiguration.
// Nothing you can put in SMTP_HOST fixes it.
//
// So when an email API key is present, mail goes out over HTTPS on port 443 instead, which is
// never blocked. The choice is made by which variables exist rather than by a mode switch: an
// install with an API key uses it, an install with SMTP settings uses those, and the caller
// cannot tell the difference.
const nodemailer = require('nodemailer');
require('dotenv').config();

const {
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, FROM_EMAIL,
  BREVO_API_KEY, RESEND_API_KEY,
} = process.env;

// HTTPS is preferred when available: it works on every host, SMTP does not.
function httpProvider() {
  if (BREVO_API_KEY) return 'brevo';
  if (RESEND_API_KEY) return 'resend';
  return null;
}

// Built once and reused. Nodemailer pools connections behind this, so creating a transport per
// message would open a new TLS session for every send.
let transport = null;

function isConfigured() {
  if (httpProvider()) return !!FROM_EMAIL;
  return !!(SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS);
}

// What to tell a user when it is not set up, naming the specific thing that is missing rather
// than "email is not configured" -- which sends them looking through everything.
function missingReason() {
  // An install part-way through moving to an API key gets told about the API key, not sent back
  // to fill in SMTP settings it no longer needs.
  if (httpProvider()) {
    return FROM_EMAIL ? '' : 'FROM_EMAIL is not set, and the email API needs a verified sender address';
  }
  const gaps = [];
  if (!SMTP_HOST) gaps.push('SMTP_HOST');
  if (!SMTP_PORT) gaps.push('SMTP_PORT');
  if (!SMTP_USER) gaps.push('SMTP_USER');
  if (!SMTP_PASS) gaps.push('SMTP_PASS');
  return gaps.length ? `${gaps.join(', ')} ${gaps.length === 1 ? 'is' : 'are'} not set on this server` : '';
}

function getTransport() {
  if (!isConfigured()) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: SMTP_HOST,
      // 465 is implicit TLS; 587 and 25 start plain and upgrade. Getting this wrong produces a
      // hang rather than an error, which is a miserable thing to debug.
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      // WITHOUT THESE, A BLOCKED PORT LOOKS LIKE A SLOW ONE. Nodemailer waits two minutes to
      // connect by default, so a host that silently drops outbound SMTP -- which many platforms
      // do, to stop their address ranges being used for spam -- leaves the user watching a
      // "Sending..." button for two minutes before anything is reported. Ten seconds is far more
      // than a reachable mail server needs, and failing fast lets us say what is actually wrong.
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
  }
  return transport;
}

// The address mail appears to come from. Falls back to the authenticating account, because most
// providers reject a From that the account is not allowed to send as.
function fromAddress() {
  return FROM_EMAIL || SMTP_USER || '';
}

// A display name for the From header. The ADDRESS cannot be the sales rep's own: SPF and DMARC
// exist to stop a server sending as a domain it is not authorised for, and providers drop or
// spam-folder mail that tries. What we can honestly do is put the rep's NAME on an address we are
// allowed to send from, so the customer sees who it is from in their inbox, and point Reply-To at
// the rep so an answer reaches a person rather than a shared mailbox.
//
// Quotes and line breaks are stripped before the name goes into the header. A newline in a header
// value ends that header and begins another -- that is how extra recipients get injected into a
// message -- and a display name is user-supplied data like any other.
function fromHeader(name) {
  const addr = fromAddress();
  const clean = String(name || '').replace(/[\r\n"<>]/g, '').trim().slice(0, 78);
  return clean ? `"${clean}" <${addr}>` : addr;
}

// Attachments reach the two APIs base64-encoded in the JSON body rather than as a MIME part.
// Both take the same two things under different names, so the caller keeps writing nodemailer's
// shape ({ filename, content }) and the difference is absorbed here.
//
// Base64 costs a third in size on the wire. Brevo caps a message at 10MB and Resend at 40MB, and
// what we send today is a quotation PDF measured in tens of kilobytes -- nowhere near either, but
// worth knowing before something larger is ever attached.
function encodeAttachments(provider, attachments) {
  if (!attachments?.length) return undefined;
  return attachments.map((a) => {
    const content = Buffer.isBuffer(a.content) ? a.content.toString('base64')
      : Buffer.from(String(a.content || ''), a.encoding || 'utf8').toString('base64');
    return provider === 'brevo'
      ? { content, name: a.filename }
      : { content, filename: a.filename, content_type: a.contentType || undefined };
  });
}

// The same message, over HTTPS. Both providers take one POST and answer immediately, so there is
// no transport to pool and nothing to keep open between sends.
//
// A ten-second budget, matching the SMTP path. An email API that has not answered in ten seconds
// is not going to, and the person is watching a button.
async function sendOverHttp(provider, { to, subject, html, text, replyTo, attachments, fromName }) {
  const files = encodeAttachments(provider, attachments);
  const from = fromAddress();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  const req = provider === 'brevo'
    ? {
      url: 'https://api.brevo.com/v3/smtp/email',
      headers: { 'api-key': BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: {
        sender: { email: from, name: fromName || undefined },
        to: [{ email: to }],
        subject,
        htmlContent: html,
        textContent: text,
        replyTo: replyTo ? { email: replyTo } : undefined,
        attachment: files,
      },
    }
    : {
      url: 'https://api.resend.com/emails',
      headers: { authorization: `Bearer ${RESEND_API_KEY}`, 'content-type': 'application/json' },
      // Resend takes the whole From as one string, so the display name is quoted here the same
      // way the SMTP path does it -- and sanitised by the same function, for the same reason.
      body: {
        from: fromHeader(fromName),
        to: [to],
        subject,
        html,
        text,
        reply_to: replyTo || undefined,
        attachments: files,
      },
    };

  try {
    const res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      // The provider's own words. "400 Bad Request" tells nobody that the sender address has not
      // been verified yet, which is the commonest first-run failure with both of these.
      const detail = payload?.message || payload?.error?.message || payload?.error || JSON.stringify(payload).slice(0, 200);
      return { ok: false, error: `${provider} refused it (${res.status}): ${detail}` };
    }
    return { ok: true, messageId: payload?.messageId || payload?.id || null };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, blocked: true, error: `${provider} did not respond within 10 seconds.` };
    }
    return { ok: false, error: err.message || `Could not reach ${provider}.` };
  } finally {
    clearTimeout(timer);
  }
}

// Resolves to { ok: true, messageId } or { ok: false, error }. It does not throw: every caller so
// far wants to report the failure to a person rather than turn it into a 500, and a send that
// fails is a normal outcome (a wrong address, a provider refusing) rather than a bug.
async function send({ to, subject, html, text, replyTo, attachments, fromName }) {
  if (!isConfigured()) return { ok: false, error: `Email is not set up on this server -- ${missingReason()}.` };

  // Attachments travel by either route. They used to be refused here on the API path, back when
  // nothing attached anything and dropping a file silently would have been worse than saying so.
  // Estimates now go out with the quotation PDF on them, and Railway -- the one install that
  // cannot use SMTP at all -- is exactly where that has to keep working.
  const provider = httpProvider();
  if (provider) return sendOverHttp(provider, { to, subject, html, text, replyTo, attachments, fromName });

  try {
    const info = await getTransport().sendMail({
      from: fromHeader(fromName),
      to,
      subject,
      html,
      // Some clients, and most spam filters, want a plain-text alternative. Sending HTML alone
      // measurably increases the chance of landing in a junk folder.
      text,
      replyTo: replyTo || undefined,
      attachments: attachments || undefined,
    });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    // A timeout or a refused connection almost never means the settings are wrong -- it means
    // nothing could get out of this machine to the mail server. Saying so points at the hosting
    // platform rather than sending someone to re-check a password that was correct all along.
    const blocked = /ETIMEDOUT|ECONNREFUSED|ESOCKET|Greeting never received|timeout/i.test(
      `${err.code || ''} ${err.message || ''}`,
    );
    if (blocked) {
      return {
        ok: false,
        blocked: true,
        error: `Could not reach ${SMTP_HOST}:${SMTP_PORT} from this server (${err.code || 'timed out'}). `
          + 'The settings look right -- this is the host blocking outbound mail. '
          + (String(SMTP_PORT) === '465'
            ? 'Try port 587, or set BREVO_API_KEY to send over HTTPS instead.'
            : 'This host blocks SMTP on every port -- set BREVO_API_KEY to send over HTTPS instead.'),
      };
    }
    return { ok: false, error: err.message || 'The mail server refused the message.' };
  }
}

module.exports = { send, isConfigured, missingReason, fromAddress, fromHeader };
