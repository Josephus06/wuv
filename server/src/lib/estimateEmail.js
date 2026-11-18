// Renders an estimate as an email a customer can actually read.
//
// THE BODY IS THE SUMMARY; THE ATTACHMENT IS THE DOCUMENT. The full Price Quotation goes out as a
// PDF alongside this (see estimatePdf.js) -- that is the thing a customer prints, signs and sends
// back. This body still carries the lines and the total in HTML because an attachment is a click
// away and often unopened on a phone, and because a message that is nothing but "see attached"
// reads as spam to both the recipient and the filters.
//
// STYLES ARE INLINE ON PURPOSE. Gmail and Outlook strip <style> blocks; a stylesheet would render
// as an unstyled wall of text for most recipients. The same goes for the table layout, which is
// the only thing that lays out reliably across mail clients.
const { COMPANY } = require('../config/company');

// The company's colours, off the logo, so the email and the PDF it carries look like one piece of
// paper from one company. Same two values as estimatePdf.js and the brand mark itself.
const BRAND_BLUE = '#0b109f';
const BRAND_ORANGE = '#ec7601';

const peso = (n) => `PHP ${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d) => (d ? String(d).slice(0, 10) : '');

// Every value a customer sees goes through this. The figures are ours, but the names, memos and
// descriptions came from a form somebody typed into -- an unescaped apostrophe or angle bracket
// would break the layout at best, and inject markup into the mail at worst.
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const TD = 'padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;';
const TH = 'padding:8px 10px;border-bottom:2px solid #d1d5db;font-size:12px;text-align:left;'
  + 'text-transform:uppercase;letter-spacing:0.04em;color:#4b5563;';

// The customer is being asked to approve a price for work described in their own terms. They are
// shown the job lines and what each costs -- deliberately NOT the process and material breakdown
// underneath, which is our costing, carries our margin, and is nobody else's business.
function jobRows(jobOrders) {
  if (!jobOrders?.length) return `<tr><td style="${TD}" colspan="5">No job lines on this estimate.</td></tr>`;
  return jobOrders.map((jo, i) => `
    <tr>
      <td style="${TD}">${i + 1}</td>
      <td style="${TD}">${esc(jo.description || jo.job_type || '')}</td>
      <td style="${TD};text-align:right">${esc(jo.quantity ?? '')}</td>
      <td style="${TD}">${esc(jo.units || '')}</td>
      <td style="${TD};text-align:right">${peso(jo.gross_amount ?? jo.subtotal)}</td>
    </tr>`).join('');
}

function row(label, value) {
  if (value === null || value === undefined || value === '') return '';
  return `<tr><td style="padding:2px 0;color:#6b7280;font-size:13px;">${esc(label)}</td>
    <td style="padding:2px 0 2px 14px;font-size:13px;"><strong>${esc(value)}</strong></td></tr>`;
}

// THE FIGURES COME FROM THE LINES, NOT FROM THE ESTIMATE HEADER.
//
// estimates.subtotal / total_amount are only populated when somebody opens the Billing step and
// presses "Recalculate from Job Orders". Plenty of estimates never have that done, so the header
// sits at zero while the job lines carry real money -- and reading the header sent a customer a
// quotation totalling 0.00 while the screen the sender was looking at showed 162.58.
//
// So this totals the lines, exactly as EstimateView's own footer does, and the email therefore
// always agrees with what the person pressing Send can see.
//
// The header is kept as a fallback for the opposite case: older migrated estimates whose header
// totals were imported but whose line detail was not. Used only when the lines come to nothing,
// so it can never contradict a real line total.
function computeTotals(est, jobOrders) {
  const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
  const subtotal = (jobOrders || []).reduce((s, jo) => s + num(jo.subtotal), 0);
  const discount = (jobOrders || []).reduce((s, jo) => s + num(jo.disc_amount), 0);
  const tax = (jobOrders || []).reduce((s, jo) => s + num(jo.tax_amount), 0);
  const netOfTax = subtotal - discount;
  const total = netOfTax + tax;

  if (total === 0 && num(est.total_amount) !== 0) {
    return {
      subtotal: num(est.subtotal),
      discount: num(est.discount_total),
      netOfTax: num(est.net_of_tax),
      tax: num(est.tax_total),
      total: num(est.total_amount),
    };
  }
  return { subtotal, discount, netOfTax, tax, total };
}

function buildHtml(est, jobOrders, { companyName, senderName, senderEmail, note }) {
  const t = computeTotals(est, jobOrders);
  const totals = [
    ['Subtotal', t.subtotal],
    ['Discount', t.discount],
    ['Net of Tax', t.netOfTax],
    ['Tax', t.tax],
  ].filter(([, v]) => v !== null && v !== undefined && Number(v) !== 0);

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;max-width:720px;margin:0 auto;padding:8px;">
  <div style="background:${BRAND_BLUE};color:#fff;padding:18px 20px;border-radius:8px 8px 0 0;border-bottom:3px solid ${BRAND_ORANGE};">
    <div style="font-size:19px;font-weight:700;letter-spacing:0.02em;">
      GRAPHIC<span style="color:${BRAND_ORANGE};">STAR</span>
    </div>
    <div style="font-size:11px;opacity:0.75;margin-top:1px;">Creations Made Easy</div>
    <div style="font-size:22px;font-weight:700;margin-top:12px;">Estimate ${esc(est.estimate_no || '')}</div>
    <div style="opacity:0.85;font-size:13px;margin-top:2px;">Dated ${esc(day(est.date_created))}</div>
  </div>

  <div style="border:1px solid #e5e7eb;border-top:0;border-radius:0 0 8px 8px;padding:20px;">
    <p style="font-size:14px;margin:0 0 14px;">
      Good day${est.contact_person_name ? ` ${esc(est.contact_person_name)}` : ''},
    </p>
    <p style="font-size:14px;margin:0 0 16px;">
      Please find below our estimate for your requirement, with the full price quotation attached
      as a PDF. Kindly review it and let us know if you would like to proceed, or if anything needs
      adjusting.
    </p>

    ${note ? `<div style="background:#f3f4f6;border-left:3px solid ${BRAND_BLUE};padding:10px 14px;margin:0 0 18px;font-size:13px;white-space:pre-wrap;">${esc(note)}</div>` : ''}

    <table style="width:100%;border-collapse:collapse;margin:0 0 18px;">
      <tbody>
        ${row('Customer', est.customer_name)}
        ${row('Contact', est.contact_person_name)}
        ${row('Sales Rep.', est.sales_rep_name)}
        ${row('Credit Term', est.credit_term)}
        ${row('Production Lead Time', est.production_lead_time)}
        ${row('Price Validity', est.price_validity)}
      </tbody>
    </table>

    <table style="width:100%;border-collapse:collapse;margin:0 0 6px;">
      <thead><tr>
        <th style="${TH}">#</th><th style="${TH}">Description</th>
        <th style="${TH};text-align:right">Qty</th><th style="${TH}">Unit</th>
        <th style="${TH};text-align:right">Amount</th>
      </tr></thead>
      <tbody>${jobRows(jobOrders)}</tbody>
    </table>

    <table style="width:100%;border-collapse:collapse;margin:10px 0 0;">
      <tbody>
        ${totals.map(([l, v]) => `<tr>
          <td style="padding:3px 10px;text-align:right;font-size:13px;color:#6b7280;">${esc(l)}</td>
          <td style="padding:3px 10px;text-align:right;font-size:13px;width:150px;">${peso(v)}</td></tr>`).join('')}
        <tr>
          <td style="padding:9px 10px;text-align:right;font-weight:700;font-size:15px;border-top:2px solid ${BRAND_BLUE};color:${BRAND_BLUE};">Total</td>
          <td style="padding:9px 10px;text-align:right;font-weight:700;font-size:15px;border-top:2px solid ${BRAND_BLUE};color:${BRAND_BLUE};">${peso(t.total)}</td>
        </tr>
      </tbody>
    </table>

    <p style="font-size:13px;color:#4b5563;margin:22px 0 0;">
      To accept this estimate, simply reply to this email${senderName ? ` and ${esc(senderName)} will pick it up` : ''}.
    </p>
    <p style="font-size:13px;margin:14px 0 0;">
      ${senderName ? `<strong>${esc(senderName)}</strong><br>` : ''}
      ${senderEmail ? `<a href="mailto:${esc(senderEmail)}" style="color:${BRAND_BLUE};">${esc(senderEmail)}</a><br>` : ''}
      ${esc(companyName)}
    </p>
  </div>
</div>`;
}

// The plain-text alternative. Not decoration: a message sent as HTML alone is markedly more
// likely to be filed as junk, and some clients still show this instead.
function buildText(est, jobOrders, { companyName, senderName, note }) {
  const t = computeTotals(est, jobOrders);
  const lines = [
    `${companyName}`,
    `Estimate ${est.estimate_no || ''} -- ${day(est.date_created)}`,
    '',
    `Good day${est.contact_person_name ? ` ${est.contact_person_name}` : ''},`,
    '',
    'Please find our estimate below, with the full price quotation attached as a PDF.',
    'Kindly review it and let us know if you would like to proceed.',
    '',
  ];
  if (note) lines.push(note, '');
  for (const [i, jo] of (jobOrders || []).entries()) {
    lines.push(`${i + 1}. ${jo.description || jo.job_type || ''} -- ${jo.quantity ?? ''} ${jo.units || ''} -- ${peso(jo.gross_amount ?? jo.subtotal)}`);
  }
  lines.push('', `TOTAL: ${peso(t.total)}`, '');
  lines.push('To accept this estimate, simply reply to this email.');
  if (senderName) lines.push('', senderName);
  lines.push(companyName);
  return lines.join('\n');
}

function buildEstimateEmail(est, jobOrders, opts) {
  const o = { companyName: COMPANY.name, ...opts };
  return {
    subject: `Estimate ${est.estimate_no || ''} from ${o.companyName}`.trim(),
    html: buildHtml(est, jobOrders, o),
    text: buildText(est, jobOrders, o),
  };
}

module.exports = { buildEstimateEmail };
