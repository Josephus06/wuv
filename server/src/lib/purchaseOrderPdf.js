// The Purchase Order, as a PDF built server-side, for emailing to the supplier.
//
// A SECOND RENDERING OF THE PRINTED PO (client/src/pages/PurchaseOrderPrint.jsx): same sections,
// same order, same figures -- supplier block and order details, the materials table, the totals
// straight off the PO header, and the Prepared by / Approved by / Received by (Supplier) sign-off
// with the signatures on file. Drawn with pdfkit for the same reason the quotation is
// (lib/estimatePdf.js): no browser on the API hosts, and it has to run identically on the office
// server, the cloud box and Railway. The letterhead matches the quotation's.
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { displayDate } = require('./dates');
const { COMPANY: CONFIG } = require('../config/company');

const MARGIN = 40;
const INK = '#1f2937';
const MUTED = '#64748b';
const RULE = '#e2e8f0';
// The company's primary / accent colours (moss green, gold) -- names kept from the source.
const BRAND_BLUE = '#2E3F1C';
const BRAND_ORANGE = '#C9A227';
// Optional logo mark; printed only when the file is there (same file as lib/estimatePdf.js).
const MARK_FILE = path.join(__dirname, '..', 'assets', 'brand', 'mark.png');

// From config/company.js (server environment).
const COMPANY = {
  wordmark: [CONFIG.short, ''],
  tagline: CONFIG.tagline,
  name: CONFIG.name,
  legal: CONFIG.name,
  address: CONFIG.addressLines,
};
const TYPE_LABELS = {
  PO1: 'Inventory with JO', PO2: 'Inventory without JO',
  PO3: 'Services with JO', PO4: 'Services/Non-Inventory without JO',
};

// Addresses imported from the source carry CR/LF pairs; pdfkit draws a lone CR as a glyph.
const str = (v) => (v == null ? '' : String(v).replace(/\r\n?/g, '\n').replace(/\n+$/, ''));
const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
};
const date = (v) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : displayDate(d);
};

// Columns in points; widths add up to the A4 text width (595.28 - 80).
const COLS = [
  { key: 'idx', label: '#', w: 20 },
  { key: 'code', label: 'Item Code', w: 92 },
  { key: 'desc', label: 'Description', w: 144 },
  { key: 'jo', label: 'Job Order', w: 58 },
  { key: 'qty', label: 'Qty', w: 38, align: 'right' },
  { key: 'unit', label: 'Unit', w: 34 },
  { key: 'rate', label: 'Rate', w: 48, align: 'right' },
  { key: 'disc', label: 'Disc%', w: 32, align: 'right' },
  { key: 'amount', label: 'Amount', w: 49.28, align: 'right' },
];
const PAD = 3;
const limit = (doc) => doc.page.height - doc.page.margins.bottom;
const rule = (doc, y, color = RULE, width = 0.5) => doc.save().lineWidth(width).strokeColor(color)
  .moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).stroke().restore();

function letterhead(doc) {
  const left = doc.page.margins.left; const right = doc.page.width - doc.page.margins.right;
  const top = doc.y; const mark = 38;
  if (fs.existsSync(MARK_FILE)) doc.image(MARK_FILE, left, top, { width: mark, height: mark });
  const textX = left + mark + 8;
  doc.font('Helvetica-Bold').fontSize(19).fillColor(BRAND_BLUE)
    .text(COMPANY.wordmark[0], textX, top + 5, { continued: true, lineBreak: false, characterSpacing: -0.2 });
  doc.fillColor(BRAND_ORANGE).text(COMPANY.wordmark[1], { lineBreak: false, characterSpacing: -0.2 });
  const wordW = doc.widthOfString(COMPANY.wordmark.join(''), { characterSpacing: -0.2 });
  const tagY = top + 27;
  doc.save().lineWidth(0.6).strokeColor('#9aa3bd').moveTo(textX, tagY).lineTo(textX + wordW - 12, tagY).stroke()
    .strokeColor(BRAND_ORANGE).moveTo(textX + wordW - 12, tagY).lineTo(textX + wordW, tagY).stroke().restore();
  doc.font('Helvetica').fontSize(7).fillColor('#7a7a7a').text(COMPANY.tagline, textX, tagY + 3, { width: wordW, align: 'right', lineBreak: false });

  doc.font('Helvetica-Bold').fontSize(9).fillColor(BRAND_BLUE).text(COMPANY.name, left, top, { width: right - left, align: 'right' });
  doc.font('Helvetica').fontSize(8.5).fillColor('#555555');
  for (const line of COMPANY.address) doc.text(line, left, doc.y, { width: right - left, align: 'right' });

  doc.y = Math.max(doc.y, top + mark + 4) + 8;
  const bandY = doc.y; const bandW = right - left;
  doc.save().lineWidth(2).strokeColor(BRAND_BLUE).moveTo(left, bandY).lineTo(left + bandW * 0.78, bandY).stroke()
    .strokeColor(BRAND_ORANGE).moveTo(left + bandW * 0.78, bandY).lineTo(right, bandY).stroke().restore();
  doc.y = bandY + 12;
}

function labelled(doc, label, value, x, width) {
  const y = doc.y;
  doc.font('Helvetica').fontSize(9).fillColor('#334155').text(`${label} :`, x, y, { width: 72, lineBreak: false });
  doc.font('Helvetica-Bold').fillColor(INK).text(value || ' ', x + 74, y, { width: width - 74 });
  doc.y = Math.max(doc.y, y + 12);
}

function tableHeader(doc) {
  const top = doc.y; let x = doc.page.margins.left;
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#334155');
  for (const c of COLS) { doc.text(c.label, x + PAD, top + PAD, { width: c.w - PAD * 2, align: c.align || 'left', lineBreak: false }); x += c.w; }
  doc.y = top + 16; rule(doc, doc.y, '#cbd5e1', 0.8); doc.y += 2;
}

function drawRow(doc, v) {
  doc.font('Helvetica').fontSize(8.5).fillColor(INK);
  const h = Math.max(...COLS.map((c) => doc.heightOfString(str(v[c.key]), { width: c.w - PAD * 2 }))) + PAD * 2;
  if (doc.y + h > limit(doc)) { doc.addPage(); tableHeader(doc); doc.font('Helvetica').fontSize(8.5).fillColor(INK); }
  const top = doc.y; let x = doc.page.margins.left;
  for (const c of COLS) {
    doc.fillColor(c.key === 'idx' ? BRAND_ORANGE : INK)
      .text(str(v[c.key]), x + PAD, top + PAD, { width: c.w - PAD * 2, align: c.align || 'left' });
    x += c.w;
  }
  doc.y = top + h; rule(doc, doc.y); doc.y += 1;
}

// A drawn signature from users.signature_data ("data:image/png;base64,...") -> a Buffer pdfkit
// can place; anything else leaves the space to be signed by hand.
function sigBuffer(dataUrl) {
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(str(dataUrl));
  return m ? Buffer.from(m[2], 'base64') : null;
}

function signatures(doc, po) {
  const left = doc.page.margins.left; const width = doc.page.width - left - doc.page.margins.right;
  const gap = 14; const colW = (width - gap * 3) / 4; const inkH = 45;
  if (doc.y + inkH + 50 > limit(doc)) doc.addPage();
  doc.y += 30;
  const top = doc.y;
  const approver = po.approved_by_gm_name || po.approved_by_supervisor_name || '';
  const approvedAt = po.approved_by_gm_at || po.approved_by_supervisor_at;
  const cols = [
    { img: sigBuffer(po.prepared_signature), name: po.created_by_name, role: 'Prepared by' },
    { img: sigBuffer(po.approved_signature), name: approver, role: `Pre-Approved by${approvedAt ? ` - ${date(approvedAt)}` : ''}` },
    { img: sigBuffer(po.final_approver_signature), name: po.final_approver_name, role: 'Approved by' },
    { img: null, name: '', role: 'Received by (Supplier)' },
  ];
  cols.forEach((c, i) => {
    const x = left + i * (colW + gap);
    if (c.img) { try { doc.image(c.img, x, top, { fit: [colW, inkH], align: 'center', valign: 'bottom' }); } catch { /* unreadable image: leave it to be signed */ } }
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(str(c.name), x, top + inkH + 2, { width: colW, align: 'center' });
    const lineY = top + inkH + 16;
    doc.save().lineWidth(0.6).strokeColor('#94a3b8').moveTo(x, lineY).lineTo(x + colW, lineY).stroke().restore();
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(c.role, x, lineY + 4, { width: colW, align: 'center' });
  });
  doc.y = top + inkH + 40;
}

// po: the same object GET /purchase-orders/:id/print returns (header + lines + signatures).
function buildPurchaseOrderPdf(po) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4', margin: MARGIN, bufferPages: true,
        info: { Title: `Purchase Order ${str(po.po_no)}`, Author: COMPANY.legal, Subject: str(po.supplier_name) },
      });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      letterhead(doc);
      const left = doc.page.margins.left; const width = doc.page.width - left - doc.page.margins.right;
      doc.font('Helvetica-Bold').fontSize(15).fillColor('#1e3a8a').text('Purchase Order', left, doc.y, { width, align: 'center' });
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#1e3a8a').text(str(po.po_no), left, doc.y + 2, { width, align: 'center' });
      doc.y += 14;

      // Two columns, as the print: supplier on the left, the order's own details on the right.
      const colW = (width - 20) / 2; const top = doc.y;
      labelled(doc, 'Supplier', str(po.supplier_name), left, colW);
      labelled(doc, 'Address', str(po.supplier_address), left, colW);
      labelled(doc, 'TIN', str(po.supplier_tin), left, colW);
      labelled(doc, 'Contact No', str(po.supplier_contact_no), left, colW);
      const leftEnd = doc.y;
      doc.y = top; const rx = left + colW + 20;
      labelled(doc, 'Date Created', date(po.date_created), rx, colW);
      labelled(doc, 'Need by Date', date(po.need_by_date), rx, colW);
      labelled(doc, 'Term', str(po.term_name || po.supplier_credit_term), rx, colW);
      labelled(doc, 'Reference #', str(po.ref_no), rx, colW);
      labelled(doc, 'PO Category', str(TYPE_LABELS[po.type] || po.type), rx, colW);
      if (po.parent_po_no) labelled(doc, 'Landed Cost of', str(po.parent_po_no), rx, colW);
      doc.y = Math.max(doc.y, leftEnd);
      if (po.memo) { doc.y += 6; labelled(doc, 'Memo', str(po.memo), left, width); }

      doc.y += 14;
      doc.font('Helvetica').fontSize(9).fillColor('#1e3a8a').text('M A T E R I A L S', left, doc.y, { width, align: 'center' });
      doc.y += 6;
      tableHeader(doc);
      const lines = po.lines || [];
      if (!lines.length) {
        doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED).text('No materials on this order.', left, doc.y + 6, { width, align: 'center' });
        doc.y += 20;
      }
      lines.forEach((l, i) => drawRow(doc, {
        idx: i + 1, code: l.item_code, desc: l.purchase_description || l.item_name, jo: l.job_order_no || '',
        qty: money(l.qty), unit: l.purchase_unit || l.unit_title || '', rate: money(l.rate),
        disc: l.disc_formula || (Number(l.disc_percent) ? money(l.disc_percent) : ''), amount: money(l.ext_price),
      }));

      // Totals, off the PO header exactly as the print shows them.
      if (doc.y + 90 > limit(doc)) doc.addPage();
      doc.y += 10;
      const tw = 200; const tx = left + width - tw;
      for (const [label, value, bold] of [
        ['Subtotal', po.subtotal], ['Discount', po.discount_amount], ['Net of Tax', po.net_of_tax],
        ['Tax', po.tax_amount], ['Total Amount', po.total_amount, true],
      ]) {
        const y = doc.y;
        if (bold) { doc.save().lineWidth(0.6).strokeColor('#cbd5e1').moveTo(tx, y).lineTo(tx + tw, y).stroke().restore(); doc.y += 4; }
        const yy = doc.y;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(INK).text(label, tx, yy, { width: tw / 2, lineBreak: false });
        doc.text(money(value), tx + tw / 2, yy, { width: tw / 2, align: 'right', lineBreak: false });
        doc.y = yy + 13;
      }

      signatures(doc, po);

      const range = doc.bufferedPageRange();
      if (range.count > 1) {
        for (let i = range.start; i < range.start + range.count; i += 1) {
          doc.switchToPage(i);
          const bottom = doc.page.margins.bottom; doc.page.margins.bottom = 0;
          doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(`${str(po.po_no)} - Page ${i - range.start + 1} of ${range.count}`,
            left, doc.page.height - bottom + 12, { width, align: 'center', lineBreak: false });
          doc.page.margins.bottom = bottom;
        }
      }
      doc.end();
    } catch (err) { reject(err); }
  });
}

const purchaseOrderPdfFilename = (po) => `Purchase-Order-${str(po.po_no).replace(/[^A-Za-z0-9._-]/g, '') || `PO-${po.id}`}.pdf`;

module.exports = { buildPurchaseOrderPdf, purchaseOrderPdfFilename };
