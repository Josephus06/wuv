// Reader for the salons' POS "BIR Sales Summary" (Dizlog, Cuts 4 Tots): one row per day with the
// day's receipt range, gross sales, VATable sales, VAT, VAT-exempt sales and the deductions (senior /
// PWD / other discounts, returns, voids), ending in the day's Net Sales.
//
// It is the BIR's record of the day, so it is what an invoice's VAT is taken from. Uploaded with the
// salons' daily sales sheet (lib/posDailySummary.js) -- which carries the day's split into services /
// products / certificates and how it was paid -- each day is paired by date, and the two must agree on
// the day's net sales to the centavo (lib/posSalesImport.js).
//
// The PDF's text breaks a row wherever a cell wraps ("2026-09-" / "01", "1914490." / "2") and one row
// can be split by the page break, so a row is found by its fixed tail instead: the 18 numbers from
// "Sales Issued w/ Manual SI/OR" to "VAT on Returns", the "-" of the empty Others column, Total VAT
// Adjustment, VAT Payable, Net Sales, Transaction Gross Sales, Sales Overrun, "-", and the three
// counters. Each row is checked: VATable + VAT + VAT-exempt + zero-rated less the senior / PWD /
// NAAC / solo-parent discounts must come to Net Sales.
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const NUM = /^-?\d+(\.\d+)?$/;
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

function isBirSalesSummary(text) {
  return /BIR\s+Sales\s+Summary/i.test(text) && /VATable/i.test(text);
}

// -> { ok, errors, store_name, address, tin, period_from, period_to, days: [{ date, si_from, si_to, gross, vatable, vat,
//      exempt, zero_rated, sc, pwd, naac, solo, other_discount, returns, voids, vat_adjustment, vat_payable, net_sales }] }
function parseBirSalesSummary(text) {
  const head = text.split(/\n/).map((s) => s.trim()).filter(Boolean);
  const store = head[1] || '';
  const address = head[2] || '';
  const tin = (text.match(/TIN:\s*([\d-]+)/i) || [])[1] || null;
  const period = text.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s*-\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  const iso = (m, d, y) => `${y}-${String(MONTHS[String(m).toLowerCase()] || 0).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const periodFrom = period ? iso(period[1], period[2], period[3]) : null;
  const periodTo = period ? iso(period[4], period[5], period[6]) : null;

  const body = text.split(/\bSolo\s+Parent\b/i).slice(1).join(' ') || text;
  const tokens = body.split(/\s+/).filter(Boolean);
  const days = [];
  const errors = [];
  let lastDate = null;
  for (let i = 18; i + 8 < tokens.length; i += 1) {
    // The "-" of the empty Others column, preceded by 18 numbers and followed by 5 numbers, "-" and 3 more.
    if (tokens[i] !== '-') continue;
    const before = tokens.slice(i - 18, i);
    const after = tokens.slice(i + 1, i + 6);
    if (!before.every((t) => NUM.test(t)) || !after.every((t) => NUM.test(t)) || tokens[i + 6] !== '-') continue;
    const n = before.map(Number);
    const a = after.map(Number);
    // Back from the block: the receipt range (two 6-digit numbers) and the date ("2026-09-" + "01").
    let date = null; let siFrom = null; let siTo = null;
    for (let j = i - 19; j >= Math.max(0, i - 40); j -= 1) {
      const t = tokens[j];
      const m = t.match(/^(\d{4}-\d{2}-)(\d{2})?$/);
      if (m) {
        const dayTok = m[2] || (/^\d{2}$/.test(tokens[j + 1] || '') ? tokens[j + 1] : null);
        if (dayTok) date = `${m[1]}${dayTok}`;
        else if (lastDate && lastDate.startsWith(m[1])) date = `${m[1]}${String(Number(lastDate.slice(8)) + 1).padStart(2, '0')}`; // day split off by the page break
        // The receipt range: the first two receipt numbers after the date.
        const receipts = tokens.slice(j + 1, i - 18).filter((x) => /^\d{5,}$/.test(x));
        [siFrom, siTo] = [receipts[0] || null, receipts[1] || null];
        break;
      }
      if (/^Total$/i.test(t)) break;
    }
    if (!date) continue; // the Total row, or a row too broken to place
    lastDate = date;
    const day = {
      date, si_from: siFrom, si_to: siTo,
      manual: n[0], gross: n[1], vatable: n[2], vat: n[3], exempt: n[4], zero_rated: n[5],
      sc: n[6], pwd: n[7], naac: n[8], solo: n[9], other_discount: n[10], returns: n[11], voids: n[12], total_deductions: n[13],
      vat_adjustment: a[0], vat_payable: a[1], net_sales: a[2], transaction_gross: a[3],
    };
    const expect = round2(day.vatable + day.vat_payable + day.exempt + day.zero_rated - day.sc - day.pwd - day.naac - day.solo);
    if (Math.abs(expect - day.net_sales) > 0.05) {
      errors.push(`${date}: VATable ${day.vatable} + VAT ${day.vat_payable} + exempt ${day.exempt} less discounts is ${expect}, but Net Sales says ${day.net_sales} -- the row was misread.`);
    }
    days.push(day);
  }
  if (!days.length) errors.push('No daily rows could be read from this BIR Sales Summary.');
  const dupes = days.map((d) => d.date).filter((d, i, all) => all.indexOf(d) !== i);
  if (dupes.length) errors.push(`Days read twice: ${[...new Set(dupes)].join(', ')}.`);
  return { ok: !errors.length, errors, store_name: store, address, tin, period_from: periodFrom, period_to: periodTo, days };
}

module.exports = { isBirSalesSummary, parseBirSalesSummary };
