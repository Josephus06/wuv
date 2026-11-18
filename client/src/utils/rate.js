// A per-unit rate as Purchasing shows it (2026-10-08): stored to 6 decimal places, shown with at
// least 2 and up to 6, so a whole-peso rate still reads 527.00 while one that carries its fraction
// shows it -- 4,696.428571 rather than 4,696.43. Totals keep the 2-decimal money format.
export function rate6(v) {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return '';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}
