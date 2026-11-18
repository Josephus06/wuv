// The Price Quotation, as a PDF, built server-side.
//
// WHY NOT THE PRINT VIEW. What the Print button produces is EstimatePrint.jsx rendered by the
// sender's own browser. Reproducing that server-side would mean a headless browser on the API
// host, and the cloud container has no browser binaries -- which is why the email started life
// as an HTML body alone. Drawing the same document directly, with a pure-JS PDF writer, needs
// nothing installed beyond a node module and runs identically on the office server, the cloud
// box and Railway.
//
// IT IS A SECOND RENDERING OF ONE DOCUMENT, SO THE FIGURES MUST NOT DRIFT. The totals here are
// computed exactly as EstimatePrint.jsx computes them -- per line, amount = subtotal - discount,
// tax = amount x tax_rate -- and NOT the way the email body does it (which totals the stored
// tax_amount and falls back to the estimate header when the lines come to nothing). A customer
// holding the attachment beside the quotation the sales rep printed has to see the same figures,
// and if the two ever have to disagree the print view is the one that is right: it is what the
// company has been sending for years.
//
// WHAT IS DELIBERATELY ABSENT: the process and material breakdown under each job line. That is
// our costing and carries our margin. The print report omits it and so does this.
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { COMPANY: CONFIG } = require('../config/company');
const { displayDate } = require('./dates');

// Everything in points, the unit PDF itself uses. A4 is 595.28 x 841.89.
const MARGIN = 40;
const INK = '#333333';
const MUTED = '#666666';
const RULE = '#dddddd';

// The company's colours (the moss green and gold of the app's own palette, client/src/index.css).
// The names are kept from the source this was ported from; they are just "primary" and "accent".
const BRAND_BLUE = '#2E3F1C';
const BRAND_ORANGE = '#C9A227';

// An optional square logo mark beside the wordmark. Drawn only when the file is there -- drop a
// PNG at this path to have it printed.
const MARK_FILE = path.join(__dirname, '..', 'assets', 'brand', 'mark.png');

// Payment QR codes printed at the foot of the quotation: [{ label, file }]. None are configured
// for this company, so the "scan the QR code" line and the codes are left off.
const PAYMENT_QR = [];

const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
};
// '24 Aug 2026', the app-wide format (lib/dates.js), matching the print view. Accepts a Date or a
// string; anything unreadable prints as its first ten characters rather than vanishing.
const formatDate = (d) => {
  if (!d) return '';
  return displayDate(d) || String(d).slice(0, 10);
};
const str = (v) => (v === null || v === undefined ? '' : String(v));

// The nine columns of the items table, in the print report's order. Widths sum to 515, which is
// A4 less both margins -- absolute rather than proportional because the numeric columns have to
// stay wide enough for a seven-figure peso amount whatever else is on the page.
const COLS = [
  { key: 'no', label: '#', w: 18, align: 'left' },
  { key: 'description', label: 'Description', w: 107, align: 'left' },
  { key: 'size', label: 'Size', w: 62, align: 'left' },
  { key: 'quantity', label: 'Quantity', w: 50, align: 'right' },
  { key: 'units', label: 'Units', w: 40, align: 'right' },
  { key: 'price', label: 'Unit Price', w: 55, align: 'right' },
  { key: 'disc', label: 'Discount %', w: 50, align: 'right' },
  { key: 'rate', label: 'Rate', w: 55, align: 'right' },
  // Wide enough for its own heading on one line -- 'Amount (Vat-' / 'Ex)' split across two rows
  // and pushed every column heading out of line with it.
  { key: 'amount', label: 'Amount (Vat-Ex)', w: 78, align: 'right' },
];
const CELL_PAD = 3;

// Same arithmetic as EstimatePrint.jsx, deliberately -- see the note at the top of this file.
function computeLines(jobOrders) {
  let subtotal = 0;
  let taxTotal = 0;
  const lines = (jobOrders || []).map((jo) => {
    const amount = num(jo.subtotal) - num(jo.disc_amount);
    // The line's own 2-decimal tax, as the estimate screen and the Sales Order total it -- summing
    // Net x rate unrounded printed 2,850.01 on an estimate that reads 2,850.00 (EST-105221).
    const tax = jo.tax_amount != null && jo.tax_amount !== ''
      ? num(jo.tax_amount)
      : Math.round(amount * (num(jo.tax_rate) / 100) * 100) / 100;
    subtotal += amount;
    taxTotal += tax;
    const size = [jo.length, jo.width, jo.height]
      .map((v) => (v === null || v === undefined || v === '' ? 0 : v)).join(' x ');
    return { ...jo, amount, size: jo.uom ? `${size} ${jo.uom}` : size };
  });
  return { lines, subtotal, taxTotal, total: subtotal + taxTotal };
}

// The bottom of the printable area. Anything that would cross it starts a new page instead.
function limit(doc) {
  return doc.page.height - doc.page.margins.bottom;
}

function ensure(doc, height) {
  if (doc.y + height > limit(doc)) {
    doc.addPage();
    return true;
  }
  return false;
}

function rule(doc, y, color = RULE, width = 0.5) {
  doc.save().lineWidth(width).strokeColor(color)
    .moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y)
    .stroke().restore();
}

function tableHeader(doc) {
  const labels = {};
  for (const c of COLS) labels[c.key] = c.label;
  drawRow(doc, labels, {
    bold: true, size: 8, color: BRAND_BLUE, keepWithHeader: false, underline: BRAND_BLUE,
  });
}

// One row of the items table. Cells wrap, so the row is as tall as its tallest cell -- a long
// description must not print over the row beneath it.
function drawRow(doc, values, {
  bold = false, size = 8.5, color = INK, keepWithHeader = true, underline = RULE,
} = {}) {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);
  const heights = COLS.map((c) => doc.heightOfString(str(values[c.key]), { width: c.w - CELL_PAD * 2 }));
  const rowH = Math.max(...heights) + CELL_PAD * 2;

  // A row that will not fit takes the column headings with it, so a continuation page is still
  // readable on its own.
  if (doc.y + rowH > limit(doc)) {
    doc.addPage();
    if (keepWithHeader) tableHeader(doc);
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);
  }

  const top = doc.y;
  let x = doc.page.margins.left;
  for (const c of COLS) {
    doc.text(str(values[c.key]), x + CELL_PAD, top + CELL_PAD, {
      width: c.w - CELL_PAD * 2, align: c.align, lineBreak: true,
    });
    x += c.w;
  }
  doc.y = top + rowH;
  rule(doc, doc.y, underline, underline === RULE ? 0.5 : 1);
  doc.y += 1;
}

// The brand mark, drawn at `size` points square with its top-left at (x, y). Width AND height
// are given because the artwork is square and must stay square -- letting pdfkit fit one axis
// would distort it.
function drawMark(doc, x, y, size) {
  if (fs.existsSync(MARK_FILE)) doc.image(MARK_FILE, x, y, { width: size, height: size });
}

// The logo, as the customer knows it: the mark, then GRAPHIC in blue and STAR in orange, with the
// tagline under them. Set in type rather than placed as an image -- the real logo is a bitmap
// with a bevel and a drop shadow on it, and a 2200px JPEG scaled into a 40pt header prints muddy.
// This is the same two-tone wordmark at print resolution.
function wordmark(doc, x, y, company) {
  const markSize = 38;
  drawMark(doc, x, y, markSize);

  const textX = x + markSize + 8;
  doc.font('Helvetica-Bold').fontSize(19).fillColor(BRAND_BLUE)
    .text(company.wordmark[0], textX, y + 5, { continued: true, lineBreak: false, characterSpacing: -0.2 });
  doc.fillColor(BRAND_ORANGE).text(company.wordmark[1], { lineBreak: false, characterSpacing: -0.2 });

  const wordWidth = doc.widthOfString(company.wordmark.join(''), { characterSpacing: -0.2 });
  const tagY = y + 27;
  // The hairline the tagline sits on in the logo: blue almost the whole way, tipped in orange.
  doc.save().lineWidth(0.6).strokeColor('#9aa3bd')
    .moveTo(textX, tagY).lineTo(textX + wordWidth - 12, tagY).stroke()
    .strokeColor(BRAND_ORANGE)
    .moveTo(textX + wordWidth - 12, tagY).lineTo(textX + wordWidth, tagY).stroke().restore();
  doc.font('Helvetica').fontSize(7).fillColor('#7a7a7a')
    .text(company.tagline, textX, tagY + 3, { width: wordWidth, align: 'right', lineBreak: false });

  return markSize;
}

function letterhead(doc, company) {
  const right = doc.page.width - doc.page.margins.right;
  const left = doc.page.margins.left;
  const top = doc.y;

  const markSize = wordmark(doc, left, top, company);

  doc.font('Helvetica-Bold').fontSize(9).fillColor(BRAND_BLUE)
    .text(company.name, left, top, { width: right - left, align: 'right' });
  doc.font('Helvetica').fontSize(8.5).fillColor('#555555');
  for (const line of company.address) {
    doc.text(line, left, doc.y, { width: right - left, align: 'right' });
  }

  // The band that separates the letterhead from the document: the logo's two colours, blue
  // running most of the width and finishing in the orange of the mark.
  doc.y = Math.max(doc.y, top + markSize + 4) + 8;
  const bandY = doc.y;
  const bandW = right - left;
  doc.save().lineWidth(2).strokeColor(BRAND_BLUE)
    .moveTo(left, bandY).lineTo(left + bandW * 0.78, bandY).stroke()
    .strokeColor(BRAND_ORANGE)
    .moveTo(left + bandW * 0.78, bandY).lineTo(right, bandY).stroke().restore();

  doc.y = bandY + 12;
  doc.font('Helvetica-Bold').fontSize(14).fillColor(BRAND_BLUE)
    .text('Price Quotation', left, doc.y, { width: bandW, align: 'center' });
  doc.y += 16;
}

// A "Label : value" line with the label in bold, both on one baseline. Written as two runs
// rather than one string so the value is not bolded along with its label.
function labelled(doc, label, value, x, width) {
  const y = doc.y;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(label, x, y, { continued: true, width });
  // A SPACE, NOT AN EMPTY STRING, when there is no value. An empty run does not close the
  // continued line, so the next label printed straight over this one -- "Contact Title :" and
  // "Contact # : 0960..." came out stacked on the same baseline.
  doc.font('Helvetica').fillColor(INK).text(value ? ` ${value}` : ' ', { width });
}

function detailsBlock(doc, est) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const leftWidth = (right - left) * 0.62;
  const top = doc.y;

  labelled(doc, 'Customer :', str(est.customer_name), left, leftWidth);
  labelled(doc, 'Attention :', str(est.contact_name || est.contact_person_name), left, leftWidth);
  labelled(doc, 'Contact Title :', str(est.contact_title), left, leftWidth);
  labelled(doc, 'Contact # :', str(est.contact_phone), left, leftWidth);
  labelled(doc, 'Contact Email :', str(est.contact_email), left, leftWidth);
  doc.moveDown(0.6);
  // Blank on the printed report too. The billing party is the customer above unless somebody
  // fills these in, and inventing a value here would make the PDF disagree with the print view.
  labelled(doc, 'Bill To :', '', left, leftWidth);
  labelled(doc, 'Bill to Address :', str(est.shipping_address), left, leftWidth);
  doc.moveDown(0.6);
  labelled(doc, 'Contract Description :', str(est.contract_description), left, leftWidth);
  labelled(doc, 'Memo :', str(est.memo), left, leftWidth);
  const leftBottom = doc.y;

  // The estimate number and date sit against the right margin, level with the top of the block.
  doc.y = top;
  const rightX = left + leftWidth + 10;
  const rightWidth = right - rightX;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK)
    .text(`Estimate # : ${str(est.estimate_no)}`, rightX, doc.y, { width: rightWidth, align: 'right' });
  doc.text(`Date : ${formatDate(est.date_created)}`, rightX, doc.y, { width: rightWidth, align: 'right' });

  doc.y = Math.max(leftBottom, doc.y) + 14;
}

function totalsBlock(doc, est, t) {
  ensure(doc, 80);
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const top = doc.y + 8;

  doc.y = top;
  labelled(doc, 'Payment Terms :', str(est.credit_term), left, 260);
  labelled(doc, 'Production Lead Time :', str(est.production_lead_time), left, 260);
  const leftBottom = doc.y;

  const boxW = 200;
  const boxX = right - boxW;
  doc.y = top;
  const amountRow = (label, value, bold) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10 : 9)
      .fillColor(bold ? BRAND_BLUE : INK);
    const y = doc.y;
    doc.text(label, boxX, y, { width: boxW * 0.5 });
    doc.text(money(value), boxX + boxW * 0.5, y, { width: boxW * 0.5, align: 'right' });
    doc.y = y + 13;
  };
  amountRow('Subtotal :', t.subtotal, false);
  amountRow('Tax :', t.taxTotal, false);
  doc.y += 2;
  doc.save().lineWidth(1).strokeColor(BRAND_BLUE)
    .moveTo(boxX, doc.y).lineTo(right, doc.y).stroke().restore();
  doc.y += 4;
  amountRow('Total :', t.total, true);

  doc.y = Math.max(leftBottom, doc.y) + 16;
}

// The standing terms, payment instructions and bank accounts: fixed text on the printed report,
// held here as data so nothing customer-facing is buried inside a layout function and a changed
// bank account is a one-line edit.
const TERMS = [
  '1. Delivery date is relative to either of the following:',
  '     - Approval of Final Proof',
  '     - Receipt of Purchase Order and/or Payment',
  '2. Cancellation of order by oral, written, electronic, or other forms of communication, shall be subject '
  + 'to 25% charge which is based on the TOTAL ORDER AMOUNT. The charges shall cover incidental expenses such '
  + 'as Layouting, Site Inspection, Bank Charges and other processing costs. This is applicable only if item/s '
  + 'is/are not produced.',
];
// The company's own bank accounts (COMPANY_BANKS in the environment), numbered as printed.
const BANKS = CONFIG.bankAccounts.map((acct, i) => `${i + 1}. ${acct}`);

function termsBlock(doc, company) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.right - left;
  ensure(doc, 110);

  doc.font('Helvetica-Bold').fontSize(9).fillColor(BRAND_BLUE).text('Terms and Conditions:', left, doc.y);
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(8).fillColor('#444444');
  for (const p of TERMS) {
    ensure(doc, 26);
    doc.font('Helvetica').fontSize(8).fillColor('#444444').text(p, left, doc.y, { width });
    doc.moveDown(0.25);
  }

  ensure(doc, 100);
  doc.moveDown(0.5);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(BRAND_BLUE).text('Payment Informations:', left, doc.y);
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(8).fillColor('#444444');
  doc.text(`A. For check payments, make all payable to ${company.legal}`, left, doc.y, { width });
  doc.moveDown(0.15);
  doc.text(`B. Money transfer payments must be made to any of ${company.legal} bank accounts only:`, left, doc.y, { width });
  doc.moveDown(0.3);

  // Two columns, the way the report lays them out: 1 and 2 on one line, 3 and 4 on the next.
  const colW = width / 2;
  for (let i = 0; i < BANKS.length; i += 2) {
    ensure(doc, 14);
    const y = doc.y;
    doc.text(BANKS[i], left, y, { width: colW - 8 });
    const rowBottom = doc.y;
    if (BANKS[i + 1]) doc.text(BANKS[i + 1], left + colW, y, { width: colW - 8 });
    doc.y = Math.max(rowBottom, doc.y);
  }
  doc.moveDown(0.4);
  if (!PAYMENT_QR.length) return;
  ensure(doc, 16);
  doc.text('C. For GCASH and PAYMAYA payments, scan the QR code of the branch you are dealing with:', left, doc.y, { width });
  paymentQrCodes(doc);
}

// The three branch QR codes, side by side under the payment terms.
//
// Kept together with ensure(): a code stranded on its own page, or a label separated from the
// code beneath it, is worse than a page break before the whole block -- someone scanning a
// payment code needs to be certain which branch they are paying.
function paymentQrCodes(doc) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.right - left;
  const colW = width / PAYMENT_QR.length;
  const QR = 92;        // points; ~32mm printed, comfortably scannable from a phone
  const LABEL_H = 11;   // room for one line of 6.5pt label under the code

  doc.moveDown(0.5);
  ensure(doc, QR + LABEL_H + 6);
  const top = doc.y;

  PAYMENT_QR.forEach(({ label, file }, i) => {
    const x = left + colW * i;
    // Drawn at a fixed width AND height: the source files are square, and letting pdfkit scale
    // one axis only would stretch a code that has to stay square to scan.
    doc.image(file, x + (colW - QR) / 2, top, { width: QR, height: QR });
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(INK)
      .text(label, x + 4, top + QR + 3, { width: colW - 8, align: 'center' });
  });

  // pdfkit does not advance doc.y for an image, and the labels were written per column, so the
  // cursor is put below the tallest of them by hand -- otherwise the signature block lands on top.
  doc.y = top + QR + LABEL_H + 4;
  doc.font('Helvetica').fontSize(8).fillColor('#444444');
}

function signatureBlock(doc, est) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.right - left;
  const colW = width / 3;
  // The three blocks are kept together: a signature line stranded alone on a final page reads as
  // a different document. The gap above them is skipped if a page break has just supplied one.
  const movedOn = ensure(doc, 90);
  if (!movedOn) doc.y += 34;

  const boxes = [
    ['Prepared By:', str(est.prepared_by_name)],
    ['Approved By:', str(est.approved_by_name)],
    ['Customer Name/Signature/Date', ''],
  ];
  const top = doc.y;
  boxes.forEach(([label, name], i) => {
    const x = left + colW * i;
    const inner = colW - 16;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
      .text(label, x + 8, top, { width: inner, align: 'center' });
    doc.font('Helvetica').fontSize(9).fillColor(INK)
      .text(name || ' ', x + 8, top + 30, { width: inner, align: 'center' });
    doc.save().lineWidth(0.5).strokeColor('#999999')
      .moveTo(x + 16, top + 44).lineTo(x + colW - 16, top + 44).stroke().restore();
  });
  doc.y = top + 50;
}

function pageNumbers(doc) {
  const range = doc.bufferedPageRange();
  if (range.count < 2) return;
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    // WRITING BELOW THE BOTTOM MARGIN ADDS A PAGE. pdfkit treats any text past the margin as
    // overflow and starts a new one -- which is how a three-page quotation came out six pages
    // long, each footer conjuring another blank sheet. Dropping the margin for the duration of
    // the write puts the footer in the margin where it belongs.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(
      `Page ${i - range.start + 1} of ${range.count}`,
      doc.page.margins.left,
      doc.page.height - bottom + 12,
      {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
        align: 'right',
        lineBreak: false,
      },
    );
    doc.page.margins.bottom = bottom;
  }
}

// From config/company.js (server environment). The wordmark is [primary, accent]: the short name
// in the primary colour, nothing in the accent.
const COMPANY = {
  wordmark: [CONFIG.short, ''],
  tagline: CONFIG.tagline,
  name: CONFIG.name,
  legal: CONFIG.name,
  address: CONFIG.addressLines,
};

// Resolves to a Buffer. Held in memory rather than written to disk: it is a few tens of KB, it
// is wanted once, and a temp file on a container that may be recycled mid-request is a leak
// waiting to happen.
function buildEstimatePdf(est, jobOrders, opts = {}) {
  const company = { ...COMPANY, ...(opts.company || {}) };
  return new Promise((resolve, reject) => {
    try {
      // bufferPages, because the page count is not known until the last line is drawn and
      // "Page 1 of 3" has to be written back onto page 1 afterwards.
      const doc = new PDFDocument({
        size: 'A4',
        margin: MARGIN,
        bufferPages: true,
        info: {
          Title: `Price Quotation ${str(est.estimate_no)}`,
          Author: company.legal,
          Subject: str(est.contract_description),
        },
      });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const t = computeLines(jobOrders);

      letterhead(doc, company);
      detailsBlock(doc, est);

      tableHeader(doc);
      if (!t.lines.length) {
        doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED)
          .text('No job lines on this estimate.', doc.page.margins.left + CELL_PAD, doc.y + CELL_PAD);
        doc.y += 4;
        rule(doc, doc.y);
        doc.y += 1;
      }
      t.lines.forEach((jo, i) => {
        drawRow(doc, {
          no: `${i + 1}.`,
          description: str(jo.description),
          size: str(jo.size),
          quantity: str(jo.quantity),
          units: str(jo.units),
          price: money(jo.price_per_unit),
          disc: money(jo.disc_percent),
          rate: money(jo.disc_price_per_unit || jo.price_per_unit),
          amount: money(jo.amount),
        });
      });

      totalsBlock(doc, est, t);
      termsBlock(doc, company);
      signatureBlock(doc, est);
      pageNumbers(doc);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// A filename the customer can find again in a downloads folder six weeks later. Anything that is
// not a letter, digit, dot, dash or underscore is dropped -- a stray quote or newline in an
// estimate number would otherwise end up inside a mail header.
function estimatePdfFilename(est) {
  const no = str(est.estimate_no).replace(/[^A-Za-z0-9._-]/g, '') || `estimate-${est.id}`;
  return `Price-Quotation-${no}.pdf`;
}

module.exports = { buildEstimatePdf, estimatePdfFilename };
