// A discount typed as a chain -- "10;5" -- is applied one after the other: 10% off, then 5% off
// what is left. 100 -> 90 -> 85.50, so the chain comes to one effective 14.5%. Mirrored in
// client/src/utils/discountChain.js; keep the two in step.
//
// Accepts a plain number (10), a single percent as text ("10"), or a chain separated by ";"
// (commas and "+" are taken too, since people type them). Each step must be 0-100.
function parseDiscountChain(input) {
  if (input === null || input === undefined || input === '') return { pct: 0, formula: null };
  const text = String(input).trim();
  if (!text) return { pct: 0, formula: null };
  const parts = text.split(/[;,+]/).map((s) => s.trim()).filter((s) => s !== '');
  if (!parts.length) return { pct: 0, formula: null };
  let remaining = 1;
  for (const p of parts) {
    const n = Number(p.replace(/%$/, ''));
    if (!Number.isFinite(n) || n < 0 || n > 100) return { error: `Discount "${text}" is not valid -- use percentages like 10 or 10;5.` };
    remaining *= 1 - n / 100;
  }
  const pct = Number(((1 - remaining) * 100).toFixed(6));
  // A single step needs no formula; the percent says it all.
  return { pct, formula: parts.length > 1 ? parts.join(';') : null };
}

module.exports = { parseDiscountChain };
