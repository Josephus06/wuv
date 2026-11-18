const PDFDocument = require('pdfkit');

// A workflow from the Manual, as a PDF: the chart, then the step-by-step for every box on it.
//
// THE CHART IS DRAWN AS VECTORS, NOT A SCREENSHOT. Rasterising the page would mean a headless
// browser on the API host, which the cloud container does not have -- the same wall estimatePdf.js
// hit. Drawing it directly also means the boxes stay crisp at any zoom and the text in them is
// selectable and searchable, which a PNG of a diagram never is.
//
// THE LAYOUT IS COMPUTED BY THE CLIENT AND SENT HERE. The elbow routing that draws those
// connectors lives in ProcessFlow.jsx, and it is fiddly -- stub lengths, corner radii, the channels
// the loop-backs run in. A second implementation here would drift from the one on screen, and the
// PDF is supposed to BE the screen. So the client sends each edge's finished SVG path and this
// draws it: pdfkit takes an SVG path string directly. One layout, two renderers.
//
// The chart is scaled to the page width and sliced down the page when it is taller than one --
// squeezing the order-to-cash flow (2070px tall) onto a single A4 would put its labels at about
// three points, which is not a manual anybody can read.

const MARGIN = 40;
const INK = '#333333';
const MUTED = '#666666';
const RULE = '#dddddd';
const HEADING = '#22406f';

// The same palette the chart uses on screen (index.css, .pf-sales and friends), so a printed
// manual and the page it came from are recognisably the same document.
const KINDS = {
  sales: { fill: '#fdf0d5', border: '#d9a441', text: '#6b4a10' },
  design: { fill: '#fbe0e6', border: '#d9748f', text: '#7a2740' },
  production: { fill: '#fdf0d5', border: '#d9a441', text: '#6b4a10' },
  procurement: { fill: '#e2f0e6', border: '#66a67e', text: '#1f5133' },
  accounting: { fill: '#e4ecfa', border: '#6d8fd0', text: '#22406f' },
  decision: { fill: '#f6f2fb', border: '#9d7cc9', text: '#4a2f70' },
};
const kindOf = (k) => KINDS[k] || KINDS.accounting;

const TONE = { yes: '#2f7d4f', no: '#b4462f' };

const A4 = { w: 595.28, h: 841.89 };
const CONTENT_W = A4.w - MARGIN * 2;

function header(doc, title, subtitle) {
  doc.fillColor(HEADING).font('Helvetica-Bold').fontSize(17).text(title, MARGIN, MARGIN);
  if (subtitle) {
    doc.moveDown(0.3);
    doc.fillColor(MUTED).font('Helvetica').fontSize(9.5).text(subtitle, { width: CONTENT_W });
  }
  doc.moveDown(0.6);
  const y = doc.y;
  doc.moveTo(MARGIN, y).lineTo(A4.w - MARGIN, y).lineWidth(0.7).strokeColor(RULE).stroke();
  doc.moveDown(0.8);
}

// One node, drawn in REAL PAGE COORDINATES -- the caller has already converted.
//
// Not inside a translate/scale, and that is the whole trick. pdfkit decides whether to start a new
// page from doc.y, and doc.y is in page units whatever transform is in force. Drawing a label at
// chart y=1950 under a 0.5 scale therefore looked like text 1950pt down an 841pt page, so pdfkit
// helpfully added pages until it got there -- 43 of them for one chart. Shapes and text go down in
// page space; only the edge paths, which never move doc.y, are drawn under the transform.
function drawNode(doc, n) {
  const c = kindOf(n.kind);
  const isDecision = n.kind === 'decision';

  if (isDecision) {
    const cx = n.x + n.w / 2;
    const cy = n.y + n.h / 2;
    doc.moveTo(cx, n.y).lineTo(n.x + n.w, cy).lineTo(cx, n.y + n.h).lineTo(n.x, cy).closePath();
  } else {
    doc.roundedRect(n.x, n.y, n.w, n.h, Math.min(8, n.h / 4));
  }
  doc.fillColor(c.fill).fillAndStroke(c.fill, c.border);

  // A fixed readable size rather than one scaled with the box, so a chart reduced to fit the page
  // still has labels somebody can read instead of 4pt ones.
  const size = 6.5;
  doc.fillColor(c.text).font('Helvetica-Bold').fontSize(size);
  const pad = isDecision ? n.w * 0.2 : 4;
  const textW = Math.max(12, n.w - pad * 2);
  const h = doc.heightOfString(n.label, { width: textW, align: 'center' });
  doc.text(n.label, n.x + pad, n.y + Math.max(1, (n.h - h) / 2), {
    width: textW, align: 'center', height: n.h, ellipsis: true,
  });
}

// The chart, scaled to the page width and continued across pages when it is too tall for one.
function drawChart(doc, chart) {
  const { canvas, nodes, edges } = chart;
  if (!canvas?.w || !canvas?.h || !nodes?.length) return;

  const scale = CONTENT_W / canvas.w;
  const fullSliceH = (A4.h - MARGIN * 2) / scale;

  // If the chart will not fit in what is left of this page, start it on a fresh one.
  //
  // Without this the bank reconciliation chart -- 1400px against the ~1355px left under the
  // heading -- spilled its last 4px onto a second page, which prints as a 2pt sliver of nothing.
  // A chart that needs two pages anyway is better off starting at the top of one, too.
  if (canvas.h > (A4.h - MARGIN - doc.y) / scale) doc.addPage();

  const startY = doc.y;
  const firstSliceH = Math.max(120, (A4.h - MARGIN - startY) / scale);

  let drawn = 0;
  let top = startY;
  let sliceH = firstSliceH;

  while (drawn < canvas.h) {
    const take = Math.min(sliceH, canvas.h - drawn);

    // The connectors, under the transform. A path never moves doc.y, so pdfkit cannot decide to
    // paginate in the middle of one.
    doc.save();
    doc.rect(MARGIN, top, CONTENT_W, take * scale).clip();
    doc.translate(MARGIN, top - drawn * scale).scale(scale);
    doc.lineWidth(1.1 / scale);
    for (const e of edges || []) {
      if (!e.d) continue;
      doc.strokeColor(e.tone === 'yes' ? TONE.yes : e.tone === 'no' ? TONE.no : '#9aa3b2');
      doc.path(e.d).stroke();
    }
    doc.restore();

    // Everything with text, in page coordinates and clipped to this slice. Only what falls inside
    // the slice is drawn, so a node is not re-inked on every page.
    const toPage = (cx, cy) => ({ x: MARGIN + cx * scale, y: top + (cy - drawn) * scale });
    const within = (cy, ch) => cy + ch > drawn && cy < drawn + take;

    doc.save();
    doc.rect(MARGIN, top, CONTENT_W, take * scale).clip();
    doc.lineWidth(0.9);
    for (const n of nodes) {
      if (!within(n.y, n.h)) continue;
      const p = toPage(n.x, n.y);
      drawNode(doc, { ...n, x: p.x, y: p.y, w: n.w * scale, h: n.h * scale });
    }
    for (const e of edges || []) {
      if (!e.label || !within(e.labelY, 0)) continue;
      const p = toPage(e.labelX, e.labelY);
      doc.font('Helvetica-Bold').fontSize(6)
        .fillColor(e.tone === 'yes' ? TONE.yes : e.tone === 'no' ? TONE.no : MUTED)
        .text(e.label, p.x + 2, p.y - 7, { lineBreak: false });
    }
    doc.restore();

    drawn += take;
    if (drawn < canvas.h) {
      doc.addPage();
      top = MARGIN;
      sliceH = fullSliceH;
    } else {
      doc.y = top + take * scale;
    }
  }
  doc.moveDown(1);
}

function legendRow(doc, legend) {
  if (!legend?.length) return;
  let x = MARGIN;
  const y = doc.y;
  doc.fontSize(8).font('Helvetica');
  for (const l of legend) {
    const c = kindOf(l.kind);
    doc.roundedRect(x, y + 1, 9, 9, 2).fillAndStroke(c.fill, c.border);
    doc.fillColor(MUTED).text(l.label, x + 13, y + 1.5, { lineBreak: false });
    x += 13 + doc.widthOfString(l.label) + 14;
  }
  doc.y = y + 16;
}

// Keeps a heading and the first lines under it together: a step list that starts at the foot of a
// page with its title stranded on the previous one is exactly what makes a printed manual annoying.
function ensureRoom(doc, needed) {
  if (doc.y + needed > A4.h - MARGIN) doc.addPage();
}

function drawGuide(doc, index, node, guide) {
  ensureRoom(doc, 110);

  doc.fillColor(HEADING).font('Helvetica-Bold').fontSize(12)
    .text(`${index}. ${node.label}`, MARGIN, doc.y, { width: CONTENT_W });
  doc.moveDown(0.25);

  const meta = [];
  if (guide.where) meta.push(`Where: ${guide.where}`);
  if (guide.who) meta.push(`Who: ${guide.who}`);
  if (meta.length) {
    doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(8.5);
    for (const m of meta) doc.text(m, { width: CONTENT_W });
    doc.moveDown(0.25);
  }

  if (guide.summary) {
    doc.fillColor(INK).font('Helvetica').fontSize(9.5).text(guide.summary, { width: CONTENT_W });
    doc.moveDown(0.35);
  }

  if (guide.steps?.length) {
    doc.fillColor(INK).font('Helvetica').fontSize(9.5);
    guide.steps.forEach((s, i) => {
      ensureRoom(doc, 24);
      const label = `${i + 1}.`;
      const y = doc.y;
      doc.font('Helvetica-Bold').text(label, MARGIN + 6, y, { width: 16, lineBreak: false });
      doc.font('Helvetica').text(s, MARGIN + 24, y, { width: CONTENT_W - 24 });
      doc.moveDown(0.15);
    });
    doc.moveDown(0.2);
  }

  if (guide.notes?.length) {
    ensureRoom(doc, 30);
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8.5).text('Worth knowing', MARGIN + 6, doc.y);
    doc.font('Helvetica').fontSize(8.5);
    for (const n of guide.notes) {
      ensureRoom(doc, 20);
      const y = doc.y;
      doc.text('•', MARGIN + 6, y, { width: 10, lineBreak: false });
      doc.text(n, MARGIN + 18, y, { width: CONTENT_W - 18 });
      doc.moveDown(0.1);
    }
  }

  doc.moveDown(0.5);
  const y = doc.y;
  doc.moveTo(MARGIN, y).lineTo(A4.w - MARGIN, y).lineWidth(0.5).strokeColor(RULE).stroke();
  doc.moveDown(0.6);
}

// flow: { title, blurb, canvas, nodes, edges, legend, guides, order }
function buildManualPdf(flow) {
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));

  header(doc, flow.title || 'Workflow', flow.blurb);
  legendRow(doc, flow.legend);
  doc.moveDown(0.2);

  drawChart(doc, flow);

  doc.addPage();
  doc.fillColor(HEADING).font('Helvetica-Bold').fontSize(14).text('Step by step', MARGIN, MARGIN);
  doc.moveDown(0.2);
  doc.fillColor(MUTED).font('Helvetica').fontSize(9)
    .text('Every box on the chart, in the order it happens.', { width: CONTENT_W });
  doc.moveDown(0.8);

  // Chart order is reading order -- the nodes are laid out top to bottom down the page.
  const nodes = flow.nodes || [];
  let n = 0;
  for (const node of nodes) {
    const guide = (flow.guides || {})[node.id];
    if (!guide) continue;
    n += 1;
    drawGuide(doc, n, node, guide);
  }
  if (!n) {
    doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(10)
      .text('No step-by-step guides are recorded for this workflow.', { width: CONTENT_W });
  }

  // Footer on every page, added at the end so the total is known.
  //
  // THE BOTTOM MARGIN IS DROPPED FIRST, and that is not a nicety. pdfkit starts a new page the
  // moment text is written below the bottom margin -- so writing a footer into the margin band
  // added a page, which then needed a footer, which added a page. The first build of this came out
  // at 98 pages for a 28-step manual.
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);
    const keep = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text(
      `${flow.title || 'Workflow'}  ·  page ${i + 1} of ${range.count}`,
      MARGIN, A4.h - MARGIN + 12, { width: CONTENT_W, align: 'center', lineBreak: false },
    );
    doc.page.margins.bottom = keep;
  }

  doc.end();
  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

module.exports = { buildManualPdf };
