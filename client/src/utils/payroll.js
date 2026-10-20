// Formatting shared by the payroll pages.

const pesoFormat = new Intl.NumberFormat('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function peso(v) {
  const n = Number(v) || 0;
  return pesoFormat.format(n);
}

// "2026-10-01", "2026-10-15" -> "Oct 1–15, 2026"
export function formatPeriod(start, end) {
  if (!start || !end) return '';
  const s = new Date(`${start}T00:00:00Z`);
  const e = new Date(`${end}T00:00:00Z`);
  const month = s.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${month} ${s.getUTCDate()}–${e.getUTCDate()}, ${s.getUTCFullYear()}`;
}

export function formatDate(iso) {
  if (!iso) return '';
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function csvDownload(filename, header, rows) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const blob = new Blob([[header, ...rows].map((r) => r.map(cell).join(',')).join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
