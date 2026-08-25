// Parser for the BIR-style "CONSOLIDATED Z-READING REPORT", the second Z-Reading format the
// Sales Order import accepts. Where posZReading.js reads one shift from one till, this one
// reads a whole trading period already consolidated by the POS -- the Z counter range and the
// shifts summary say how many shifts went into it.
//
// The document is a flat list of "Label <value>" lines under section headings (BREAKDOWN OF
// SALES, DISCOUNT SUMMARY, SALES ADJUSTMENT, VAT ADJUSTMENT, TRANSACTION SUMMARY, SHIFTS
// SUMMARY). Labels are separated from their values by dotted leaders, which are drawn rather
// than typed, so what survives text extraction is a label, some whitespace, and a value --
// sometimes wrapped onto the next line. Everything here is anchored at a line start and
// tolerant of that wrap.
//
// Mapping onto the daily cash & collections grid:
//
//   DATE                       <- End Date & Time (the trading day, not the Report Date,
//                                 which is whenever the report was printed -- the sample was
//                                 run 08/25 for the 08/23 trading day)
//   CASH                       <- CASH
//   E-WALLET                   <- GCASH + every other non-cash tender
//   TOTAL DAILY SALES          <- Net Amount
//   TOTAL CASH TO BE DEPOSITED <- CASH (Cash in Drawer less the Opening Fund is the same
//                                 figure; the drawer total includes float that is not takings)
//   TOTAL E-WALLET             <- same non-cash bucket
//   UNCOLLECTED SALES          <- PAY LATER + INVOICE
//   VAT EX                     <- Net Amount less VAT Amount (see below)
//   VAT 12%                    <- VAT Amount
//   VAT (INC.)                 <- Net Amount
//
// Two mappings deserve their reasoning stated.
//
// The grid has one non-cash tender column, so CREDIT_CARD / PAY LATER / ONLINE / INVOICE are
// added to GCASH rather than dropped -- dropping them would break the report's own identity
// that the tenders add to Payment Received, and would understate the day. When any of them is
// non-zero the parser says so in a warning, because the column is labelled E-wallet and a card
// sale sitting in it should be visible rather than silent.
//
// VAT EX is taken as Net Amount less VAT Amount rather than as the printed Vatable Sales. The
// three VAT columns are what the ledger is built from and they have to tie to the centavo,
// but a BIR report derives Vatable and VAT from the same Net Amount by division and rounds
// both -- the sample prints 16,530.35 + 1,983.64 = 18,513.99 against a Net Amount of
// 18,514.00, a centavo out before anyone has touched it. Net and VAT are kept exactly as
// printed and the vatable column absorbs that rounding, so a report can never be rejected for
// the POS's own division. The printed figure is preserved in `figures.vatable_sales`, and a
// difference of more than a centavo is reported as a warning rather than quietly absorbed.

const VAT_RATE = 12;
const TOLERANCE = 0.01;

function num(v) {
  if (v === null || v === undefined) return null;
  const negative = /^\(.*\)$/.test(String(v).trim());
  const n = Number(String(v).replace(/[(),]/g, ''));
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}
function round2(n) { return Number(Number(n).toFixed(2)); }
function collapse(s) { return String(s).replace(/\s+/g, ' ').trim(); }
function n0(v) { return v === null || v === undefined ? 0 : Number(v); }

// A label as it is printed, turned into a pattern: regex characters escaped, runs of spaces
// allowed to be any whitespace, and a trailing "." optional -- extraction is not reliable
// about "Beg. SI" versus "Beg SI".
function labelPattern(label) {
  return String(label)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\.\s/g, '\\.?\\s')
    .replace(/\s+/g, '\\s+');
}

const AMOUNT = String.raw`\(?-?[\d,]+\.\d{2}\)?`;
const DATE = String.raw`\d{1,2}/\d{1,2}/\d{2,4}`;

// Label at the start of a line, then the dotted-leader gap (which extracts as whitespace),
// then the value -- possibly on the following line. The negative lookahead stops "CASH" from
// matching the "Cash in Drawer" line, and "Void" from matching "Less Void".
function fieldFor(text, label, valueRe) {
  const re = new RegExp(
    `(?:^|\\n)[ \\t]*${labelPattern(label)}(?![A-Za-z0-9])[ \\t.:]*\\s*(${valueRe})`,
    'i'
  );
  const m = re.exec(text);
  return m ? m[1] : null;
}
function amountFor(text, label) {
  const raw = fieldFor(text, label, AMOUNT);
  return raw === null ? null : num(raw);
}
function intFor(text, label) {
  const raw = fieldFor(text, label, String.raw`\d+`);
  return raw === null ? null : Number(raw);
}

function toIsoDate(mdY) {
  const [m, d, y] = String(mdY).split('/').map((p) => p.trim());
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  return `${year}-${String(Number(m)).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`;
}
// The header stamps are 12-hour ("09:59 PM"); the shifts summary is already 24-hour ("21:59").
function to24h(time) {
  const t = String(time).trim();
  const ampm = /(\d{1,2}):(\d{2})\s*([AP])\.?M\.?/i.exec(t);
  if (ampm) {
    let hour = Number(ampm[1]) % 12;
    if (ampm[3].toUpperCase() === 'P') hour += 12;
    return `${String(hour).padStart(2, '0')}:${ampm[2]}`;
  }
  const plain = /(\d{1,2}):(\d{2})/.exec(t);
  return plain ? `${String(Number(plain[1])).padStart(2, '0')}:${plain[2]}` : null;
}
function stampFor(text, label) {
  const raw = fieldFor(text, label, `${DATE}\\s+\\d{1,2}:\\d{2}(?:\\s*[AP]\\.?M\\.?)?`);
  if (!raw) return { date: null, time: null };
  const d = new RegExp(DATE).exec(raw);
  return { date: d ? toIsoDate(d[0]) : null, time: to24h(raw.slice(d ? d[0].length : 0)) };
}

function isConsolidatedZReading(rawText) {
  return /CONSOLIDATED\s+Z\s*-?\s*READING/i.test(String(rawText || ''));
}

function parseConsolidatedZReading(rawText) {
  const text = String(rawText || '').replace(/\r/g, '');
  const errors = [];
  const warnings = [];
  const checks = [];

  if (!isConsolidatedZReading(text)) {
    return { ok: false, errors: ['This does not look like a Consolidated Z-Reading report.'] };
  }

  // The first lines are the store block: trading name, then "Operated By", then the address.
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const storeName = lines[0] || null;
  const operatedBy = /Operated\s+By\s*:?\s*([^\n]+)/i.exec(text);
  const tin = /VAT\s*REG\.?\s*TIN\s*:?\s*([\d-]+)/i.exec(text);
  const min = /(?:^|\n)\s*MIN\s*:?\s*(\S+)/i.exec(text);
  const serial = /(?:^|\n)\s*S\s*\/\s*N\s*:?\s*([^\n]+)/i.exec(text);

  const start = stampFor(text, 'Start Date & Time');
  const end = stampFor(text, 'End Date & Time');
  const reportDate = fieldFor(text, 'Report Date', DATE);

  // "Z Counter Range 375 - 376", or a single counter on a one-shift day.
  const zRange = /Z\s*Counter\s*Range[^\n\d]*(\d+)(?:\s*-\s*(\d+))?/i.exec(text);
  const zFrom = zRange ? zRange[1] : null;
  const zTo = zRange && zRange[2] ? zRange[2] : zFrom;

  const f = {
    // Header / audit trail.
    reset_counter: intFor(text, 'Reset Counter No.'),
    z_read_count: intFor(text, 'Z Read Count'),
    beginning_si: fieldFor(text, 'Beg. SI', String.raw`\S+`),
    ending_si: fieldFor(text, 'End SI', String.raw`\S+`),
    beginning_void: fieldFor(text, 'Beg. Void', String.raw`\S+`),
    ending_void: fieldFor(text, 'End Void', String.raw`\S+`),
    previous_accumulated_sales: amountFor(text, 'Previous Accumulated Sales'),
    present_accumulated_sales: amountFor(text, 'Present Accumulated Sales'),
    sales_for_the_day: amountFor(text, 'Sales for the Day'),

    // Breakdown of sales.
    vatable_sales: amountFor(text, 'Vatable Sales'),
    vat_amount: amountFor(text, 'VAT Amount'),
    vat_exempt_sales: amountFor(text, 'VAT Exempt Sales'),
    zero_rated_sales: amountFor(text, 'Zero Rated Sales'),
    gross_amount: amountFor(text, 'Gross Amount'),
    less_discount: amountFor(text, 'Less Discount'),
    less_return: amountFor(text, 'Less Return'),
    less_void: amountFor(text, 'Less Void'),
    less_vat_adjustment: amountFor(text, 'Less VAT Adjustment'),
    net_amount: amountFor(text, 'Net Amount'),

    // Discount summary.
    sc_discount: amountFor(text, 'SC Disc'),
    pwd_discount: amountFor(text, 'PWD Disc'),
    naac_discount: amountFor(text, 'NAAC Disc'),
    solo_parent_discount: amountFor(text, 'Solo Parent Disc'),
    medal_of_valor_discount: amountFor(text, 'Medal of Valor Discount'),
    other_discount: amountFor(text, 'Other Disc'),

    // Sales / VAT adjustment.
    void_adjustment: amountFor(text, 'Void'),
    vat_on_return: amountFor(text, 'VAT on Return'),
    gc_sales: amountFor(text, 'GC Sales'),

    // Transaction summary.
    cash_in_drawer: amountFor(text, 'Cash in Drawer'),
    cash: amountFor(text, 'CASH'),
    credit_card: amountFor(text, 'CREDIT_CARD'),
    pay_later: amountFor(text, 'PAY LATER'),
    online: amountFor(text, 'ONLINE'),
    invoice: amountFor(text, 'INVOICE'),
    gcash: amountFor(text, 'GCASH'),
    payin: amountFor(text, 'PAYIN'),
    opening_fund: amountFor(text, 'Opening Fund'),
    less_withdrawal: amountFor(text, 'Less Withdrawal'),
    payment_received: amountFor(text, 'Payment Received'),
    short_over: amountFor(text, 'SHORT/OVER'),
  };

  // CREDIT_CARD is sometimes printed "CREDIT CARD"; try the other spelling before giving up.
  if (f.credit_card === null) f.credit_card = amountFor(text, 'CREDIT CARD');

  for (const [key, label] of [
    ['net_amount', 'Net Amount'], ['vat_amount', 'VAT Amount'],
    ['gross_amount', 'Gross Amount'], ['cash', 'CASH'],
  ]) {
    if (f[key] === null) errors.push(`Could not read ${label} from the report.`);
  }
  if (!end.date && !start.date) {
    errors.push('Could not read the Start/End Date & Time -- the trading date comes from it.');
  }

  // Shifts summary: "Z-375  08/23/2026 10:47 - 08/23/2026 21:59", one line per shift the
  // consolidation covers.
  const shiftsSummary = [];
  const shiftRe = new RegExp(
    String.raw`(?:^|\n)[ \t]*Z\s*-?\s*(\d+)[ \t.:]*\s*(${DATE})\s+(\d{1,2}:\d{2}(?:\s*[AP]\.?M\.?)?)\s*-\s*(${DATE})\s+(\d{1,2}:\d{2}(?:\s*[AP]\.?M\.?)?)`,
    'gi'
  );
  for (const m of text.matchAll(shiftRe)) {
    shiftsSummary.push({
      z_counter: m[1],
      opened_date: toIsoDate(m[2]), opened_time: to24h(m[3]),
      closed_date: toIsoDate(m[4]), closed_time: to24h(m[5]),
    });
  }

  function check(label, stated, computed, note) {
    if (stated === null || computed === null || !Number.isFinite(computed)) return;
    // Same rounding-the-difference care as the VAT EX note below: a report whose vatable and
    // VAT add to a centavo under its own net amount is normal, and must not read as a failure.
    const ok = round2(Math.abs(round2(stated) - round2(computed))) <= TOLERANCE;
    checks.push({ label, stated: round2(stated), computed: round2(computed), ok, note });
    if (!ok) warnings.push(`${label}: report says ${round2(stated).toFixed(2)} but ${note} gives ${round2(computed).toFixed(2)}.`);
  }

  // Every figure the report states, recomputed from its own others. As in the shift parser, a
  // failed check is a warning rather than a refusal: the document was read correctly and the
  // POS printed figures that disagree, which is for the operator to settle against the till.
  check('Net Amount', f.net_amount,
    n0(f.gross_amount) - Math.abs(n0(f.less_discount)) - Math.abs(n0(f.less_return))
      - Math.abs(n0(f.less_void)) - Math.abs(n0(f.less_vat_adjustment)),
    'gross less discount, return, void and VAT adjustment');
  check('Net Amount', f.net_amount,
    n0(f.vatable_sales) + n0(f.vat_amount) + n0(f.vat_exempt_sales) + n0(f.zero_rated_sales),
    'vatable + VAT + exempt + zero-rated');
  check('VAT Amount', f.vat_amount, n0(f.vatable_sales) * (VAT_RATE / 100), `${VAT_RATE}% of vatable sales`);
  check('Less Discount', f.less_discount,
    n0(f.sc_discount) + n0(f.pwd_discount) + n0(f.naac_discount) + n0(f.solo_parent_discount)
      + n0(f.medal_of_valor_discount) + n0(f.other_discount),
    'its own discount summary');

  const nonCash = n0(f.gcash) + n0(f.credit_card) + n0(f.pay_later) + n0(f.online) + n0(f.invoice);
  check('Payment Received', f.payment_received, n0(f.cash) + nonCash, 'the tender lines added up');
  check('Payment Received', f.payment_received, n0(f.net_amount), 'net amount');
  check('Sales for the Day', f.sales_for_the_day, n0(f.net_amount), 'net amount');
  check('Cash in Drawer', f.cash_in_drawer,
    n0(f.opening_fund) + n0(f.cash) + n0(f.payin) - Math.abs(n0(f.less_withdrawal)),
    'opening fund + cash + pay-in less withdrawal');
  if (shiftsSummary.length && f.z_read_count !== null) {
    check('Z Read Count', f.z_read_count, shiftsSummary.length, 'the shifts it lists');
  }

  // The grid's non-cash column is labelled E-wallet, so anything in it that is not GCash has
  // to be called out rather than folded in silently.
  const otherTenders = [
    ['card', f.credit_card], ['pay later', f.pay_later], ['online', f.online], ['invoice', f.invoice],
  ].filter(([, v]) => Math.abs(n0(v)) > TOLERANCE);
  if (otherTenders.length) {
    warnings.push(
      `Non-GCash tenders are included in the E-wallet column: ${otherTenders.map(([k, v]) => `${k} ${round2(n0(v)).toFixed(2)}`).join(', ')}.`
    );
  }

  // VAT EX carries the report's own rounding so the three VAT columns tie exactly; see the
  // note at the top. More than a centavo apart is worth saying out loud.
  // Rounding the difference before comparing, not the operands: 16530.36 - 16530.35 comes out
  // of binary floating point as 0.010000000000218, which is over a 0.01 tolerance by a hair
  // and would put this warning on every single report of a format that is always a centavo out
  // by construction.
  const vatEx = f.net_amount === null || f.vat_amount === null ? null : round2(f.net_amount - f.vat_amount);
  if (vatEx !== null && f.vatable_sales !== null && round2(Math.abs(vatEx - f.vatable_sales)) > TOLERANCE) {
    warnings.push(
      `Vatable Sales prints as ${round2(f.vatable_sales).toFixed(2)} but net amount less VAT is ${vatEx.toFixed(2)}; the VAT EX column uses the latter so the VAT columns add to the day's total.`
    );
  }

  const saleDate = end.date || start.date;
  const shiftLabel = zFrom ? (zTo && zTo !== zFrom ? `${zFrom}-${zTo}` : zFrom) : null;
  // MIN identifies the machine and is unique per terminal, which is what makes one trading
  // day at one till distinct from the same day at another. TIN then the trading name stand in
  // when a report omits it.
  const machine = (min ? min[1] : null) || (tin ? tin[1] : null) || (storeName ? collapse(storeName) : null);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    checks,
    format: 'consolidated_z_reading',
    store_name: storeName,
    operated_by: operatedBy ? collapse(operatedBy[1]) : null,
    tin: tin ? tin[1] : null,
    min: min ? min[1] : null,
    serial_no: serial ? collapse(serial[1]) : null,
    report_date: reportDate ? toIsoDate(reportDate) : null,
    // No branch code: this format prints a trading name and an address, not the branch number
    // the per-shift report carries. Putting the trading name here instead would read back
    // doubled, because the order's contract description is built as store_name + branch_code
    // ("FRESH AND TIDY" + "613"). The terminal is still identified -- its MIN is in the import
    // key, which is what has to be unique.
    branch_code: null,
    shift: shiftLabel ? `Z-${shiftLabel}` : null,
    z_counter_from: zFrom,
    z_counter_to: zTo,
    opened_date: start.date,
    opened_time: start.time,
    // This format prints no cashier names -- it is consolidated across shifts and the tills
    // are not attributed. The grid's Opened By / Closed By stay empty rather than guessed.
    opened_by: null,
    closed_date: end.date,
    closed_time: end.time,
    closed_by: null,
    beginning_or: f.beginning_si,
    ending_or: f.ending_si,
    figures: f,
    shifts_summary: shiftsSummary,

    // No per-category breakdown exists in this format, and without one the GL entry has no
    // honest way to split revenue. One bucket named for the trading name lets the operator map
    // it once in POS Category Accounts and have every future import of that store post
    // correctly -- and keeps two stores' revenue on separate accounts.
    categories: f.net_amount === null || !storeName
      ? []
      : [{ name: collapse(storeName).slice(0, 80), amount: f.net_amount }],
    uncollected_items: [],

    import_key: machine && saleDate
      ? `ZC:${machine}/${shiftLabel || 'na'}|${saleDate}`.slice(0, 120)
      : null,

    row: {
      sale_date: saleDate,
      cash: f.cash,
      collected_cash: 0,
      gcash: round2(nonCash),
      collected_gcash: 0,
      // This format records no collections against earlier receivables, so there is nothing
      // to split. Left at zero, which is what the save-time check expects of each other.
      collected_bank_deposit: 0,
      total_daily_sales: f.net_amount,
      total_cash_to_deposit: f.cash,
      total_gcash: round2(nonCash),
      uncollected_sales: round2(n0(f.pay_later) + n0(f.invoice)),
      vat_ex: vatEx,
      vat_12: f.vat_amount,
      vat_inc: f.net_amount,
    },
  };
}

module.exports = { parseConsolidatedZReading, isConsolidatedZReading };
