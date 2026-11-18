// Mirrors server/src/lib/discountChain.js -- keep the two in step. "10;5" is 10% off, then 5% off
// what is left: 100 -> 90 -> 85.50, one effective 14.5%.
export function parseDiscountChain(input) {
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
  return { pct, formula: parts.length > 1 ? parts.join(';') : null };
}

// What a line's Discount % cell shows: the chain as typed where there is one, else the percent.
export function discountLabel(line) {
  if (line?.disc_formula) return line.disc_formula;
  const n = Number(line?.disc_percent);
  return Number.isFinite(n) && n ? String(Number(n.toFixed(6))) : '';
}
