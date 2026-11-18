// Shared by both invoice print formats (Type 1 pre-printed overlay, Type 2 full form).

export const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
};

// Quantities print as whole numbers when they are whole -- the forms' qty blanks are narrow,
// and "12" is what the live statement shows, not "12.0000".
export const qtyText = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return Number.isInteger(n) ? String(n) : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
};

// yyyy-mm-dd on a printed invoice -- deliberately NOT the app's "18 Sept 2026".
//
// A documented exception to utils/dates.js, alongside the cheque dates: the screen format is for
// reading, and this one goes on a document that is filed, keyed into a customer's own system and
// sorted. An unambiguous numeric date is what that needs, and it is the same on both print
// formats so an invoice does not date itself two ways.
//
// DATE columns reach the client as 'YYYY-MM-DD' strings already (server/src/db.js sets
// dateStrings for exactly this reason), so the plain slice is both exact and timezone-proof.
// Anything else is read as a local date and rebuilt from its local parts -- never through
// toISOString(), which turns a local midnight into the previous day anywhere east of UTC, which
// is where this runs.
export const formatDate = (v) => {
  if (!v) return '';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// Tax codes in this data are 'VAT_PH:VATIN-12' | 'VAT_PH:ZRATE' | 'VAT_PH:0-VAT' |
// 'VAT_PH:EXEMPT' (and a few unprefixed variants), which map onto the BIR sales buckets
// the pre-printed form prints labels for.
export function taxBucket(line) {
  const code = (line.tax_code || '').toUpperCase();
  if (code.includes('EXEMPT')) return 'exempt';
  if (code.includes('ZRATE') || code.includes('0-VAT')) return 'zeroRated';
  if (Number(line.tax_amount) > 0 || code.includes('VATIN') || code.includes('VAT12')) return 'vatable';
  return 'exempt'; // no tax code and no tax charged -- not VATable, so it cannot sit in that box
}

export function invoiceTotals(si) {
  if (!si) return null;
  const buckets = { vatable: 0, exempt: 0, zeroRated: 0 };
  for (const l of si.lines || []) buckets[taxBucket(l)] += Number(l.net_of_tax || 0);
  // The boxes must add up to the invoice's own Net of Tax -- the figure its view, its GL and its
  // Amount Due all use. 6,062 migrated invoices carry lines that do not sum to their header
  // (INV-82382: one line of 80 x 10.98 = 878.40 on an invoice of 640.00), and the box printed the
  // line figure. So the header amount is shared out in the lines' proportions: which box the money
  // goes in still comes from the lines' tax codes, how much comes from the header.
  const lineNet = buckets.vatable + buckets.exempt + buckets.zeroRated;
  const headerNet = Number(si.net_of_tax);
  if (lineNet > 0 && Number.isFinite(headerNet) && Math.abs(lineNet - headerNet) > 0.005) {
    const keys = Object.keys(buckets);
    for (const k of keys) buckets[k] = Math.round((buckets[k] / lineNet) * headerNet * 100) / 100;
    // Rounding residue onto the largest box, so the three still sum to the header exactly.
    const residue = Math.round((headerNet - keys.reduce((sum, k) => sum + buckets[k], 0)) * 100) / 100;
    if (residue) { const big = keys.reduce((m, k) => (buckets[k] > buckets[m] ? k : m), keys[0]); buckets[big] += residue; }
  }
  return {
    ...buckets,
    vat: Number(si.tax_amount || 0),
    totalSales: Number(si.gross_amount || 0),
    withholding: Number(si.ewt_amount || 0),
    quantity: (si.lines || []).reduce((s, l) => s + Number(l.quantity || 0), 0),
    // amount_due is drawn down by payments and credit memos, so a settled invoice would
    // print 0.00. What the form asks for is what this document billed, so derive it.
    // TOTAL AMOUNT DUE is Total Sales less Withholding Tax -- the two figures printed above it --
    // on every invoice, so the form always adds up on its face (INV-82382: 640.00 - 12.80 = 627.20).
    amountDue: Number(si.gross_amount || 0) - Number(si.ewt_amount || 0),
  };
}

// The billing address an invoice shows and prints: the one typed on the invoice, else the
// customer's own Bill To Address, else any address on file for them. Migrated invoices carry
// none of their own, so without the fallbacks every one of them came up blank.
export const billingAddress = (si) =>
  si?.bill_to_address || si?.customer_bill_to_address || si?.customer_address || '';

// All figures in this database are Philippine peso. The sample Type 2 template was an export
// invoice denominated in US$ -- change this if that format is used for dollar billing.
export const CURRENCY = { code: 'PHP', symbol: '₱' };

export const paginate = (lines, perPage) => {
  const pages = [];
  for (let i = 0; i < Math.max(lines.length, 1); i += perPage) pages.push(lines.slice(i, i + perPage));
  return pages;
};

// DESCRIPTIONS THAT DO NOT FIT ON ONE LINE.
//
// The description blank is 95mm wide and every field here was nowrap + overflow:hidden, so
// anything past about 56 characters at 8pt was cut off with nothing on the paper to show it --
// 25,926 of the 121,012 invoice lines in this database, a fifth of them, and the longest runs to
// 347 characters. A printed invoice that silently drops what was sold is the worst kind of wrong.
//
// It wraps instead, and a long description uses the empty rows beneath it. That space is nearly
// always there: 56,883 of the invoices carry a SINGLE line item against six row slots, and 7,911
// carry two. An item consumes as many whole 5mm rows as its wrapped text needs, and the next item
// starts on the next ruled line after it, so every item's Qty/Unit Price/Amount still land on a
// rule of the pre-printed form.
//
// Courier advances every glyph by exactly 0.6em, so the character capacity of a millimetre width
// is arithmetic rather than measurement -- the break points are identical on screen and on paper,
// which is what a pre-printed overlay needs. Wrapping is done here rather than left to CSS for
// the same reason: the browser's line breaking is not something a calibration can be measured
// against.
const PT_TO_MM = 25.4 / 72;
const charWidthMm = (pt) => 0.6 * pt * PT_TO_MM;
const lineHeightMm = (pt) => pt * PT_TO_MM * 1.15; // 1.15 = .si-form's line-height

export function wrapMono(text, widthMm, pt) {
  const s = String(text ?? '').trim();
  if (!s) return [];
  const perLine = Math.max(1, Math.floor(widthMm / charWidthMm(pt)));
  const out = [];
  let line = '';
  for (const word of s.split(/\s+/)) {
    // A single word longer than the blank -- a part code, a URL -- is broken hard rather than
    // allowed to overrun the column into Unit Price.
    if (word.length > perLine) {
      if (line) { out.push(line); line = ''; }
      for (let i = 0; i < word.length; i += perLine) out.push(word.slice(i, i + perLine));
      line = out.pop() ?? '';
      continue;
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= perLine) line += ` ${word}`;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out;
}

// How the items are packed into the band, and where each one sits.
//
// THE BAND IS A FIXED HEIGHT AND THE SPACING INSIDE IT ADJUSTS. The pre-printed form gives the
// items a fixed area -- rowsPerPage rules, rowHeight apart, so 6 x 5mm = 30mm below items.top.
// Packing one item per rule capped a sheet at six items and sent a seventh onto a second
// pre-printed form, which costs a BIR serial for what is really a spacing decision.
//
// So the unit of packing is the TEXT LINE, not the rule, and the vertical pitch between lines is
// whatever divides the band evenly for the content on it -- never tighter than the text itself
// (line height at the base font) and never looser than the form's own rule spacing:
//
//   pitch = clamp(bandHeight / linesOnThisPage, lineHeight, rowHeight)
//
// A sparse sheet therefore looks exactly as it did -- one or two items land on the printed rules,
// because the clamp holds pitch at rowHeight. A full one closes up until the band is used. At 6pt
// the text line is 2.44mm, so a 30mm band holds 12 lines: ten single-line items sit at a 3mm
// pitch with room to spare, and only a genuinely longer invoice starts a second form.
//
// A description that wraps still draws its own lines at the text's natural line height; it is the
// gap between ITEMS that stretches, so a compressed sheet never overlaps and a sparse one never
// looks squashed.
export function layoutPages(lines, form) {
  const { top, rowHeight, rowsPerPage, columns } = form.items;
  const lh = lineHeightMm(form.baseFontPt);
  const bandHeight = rowsPerPage * rowHeight;
  // What the band can hold once the pitch is squeezed to the text itself.
  const maxLines = Math.max(1, Math.floor(bandHeight / lh));

  const items = (lines || []).map((l) => {
    let wrapped = wrapMono(l.description, columns.description.w, form.baseFontPt);
    if (wrapped.length > maxLines) {
      // Visibly cut, never silently: the ellipsis is the whole point, so whoever reads the
      // invoice knows to look at the system for the rest.
      wrapped = wrapped.slice(0, maxLines);
      wrapped[maxLines - 1] = `${wrapped[maxLines - 1].slice(0, Math.max(0, wrapped[maxLines - 1].length - 1))}…`;
    }
    return { line: l, wrapped, lines: Math.max(1, wrapped.length) };
  });

  // Pack by text line, keeping an item's own lines together.
  const pages = [];
  let page = [];
  let used = 0;
  for (const item of items) {
    if (used + item.lines > maxLines && page.length) {
      pages.push({ items: page, usedLines: used });
      page = [];
      used = 0;
    }
    page.push({ ...item, lineOffset: used });
    used += item.lines;
  }
  pages.push({ items: page, usedLines: used });

  return pages.map((pg) => {
    const pitch = pg.usedLines
      ? Math.min(rowHeight, Math.max(lh, bandHeight / pg.usedLines))
      : rowHeight;
    return {
      ...pg,
      pitch,
      // Where the Order ID line goes: under the last item, not under a count of rules.
      itemsBottom: top + pg.usedLines * pitch,
      items: pg.items.map((it) => ({ ...it, y: top + it.lineOffset * pitch })),
    };
  });
}
