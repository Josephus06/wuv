// Formatting shared by the payroll pages.

const pesoFormat = new Intl.NumberFormat('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function peso(v) {
  const n = Number(v) || 0;
  return pesoFormat.format(n);
}

// "2026-10-01", "2026-10-15" -> "Oct 1–15, 2026"; across months "Sep 26 – Oct 10, 2026".
export function formatPeriod(start, end) {
  if (!start || !end) return '';
  const s = new Date(`${start}T00:00:00Z`);
  const e = new Date(`${end}T00:00:00Z`);
  const mon = (d) => d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  if (s.getUTCFullYear() !== e.getUTCFullYear()) {
    return `${mon(s)} ${s.getUTCDate()}, ${s.getUTCFullYear()} – ${mon(e)} ${e.getUTCDate()}, ${e.getUTCFullYear()}`;
  }
  if (s.getUTCMonth() !== e.getUTCMonth()) return `${mon(s)} ${s.getUTCDate()} – ${mon(e)} ${e.getUTCDate()}, ${e.getUTCFullYear()}`;
  return `${mon(s)} ${s.getUTCDate()}–${e.getUTCDate()}, ${s.getUTCFullYear()}`;
}

// The standard dates of a cutoff: "2026-10", 1 -> 1st–15th; 2 -> 16th–month end.
export function standardPeriod(month, cutoff) {
  const [y, m] = month.split('-').map(Number);
  const mm = String(m).padStart(2, '0');
  if (Number(cutoff) === 1) return { period_start: `${y}-${mm}-01`, period_end: `${y}-${mm}-15` };
  return { period_start: `${y}-${mm}-16`, period_end: `${y}-${mm}-${new Date(Date.UTC(y, m, 0)).getUTCDate()}` };
}

// A payslip line's quantity: "11 days", "3.5 hr", or a loan's "balance after: 1,200.00".
export function qtyLabel(l) {
  if (l.quantity === null || l.quantity === undefined) return '';
  const q = Number(l.quantity);
  if (l.unit === 'bal') return `balance after: ${peso(q)}`;
  const unit = { day: q === 1 ? 'day' : 'days', hr: 'hr', min: 'min' }[l.unit] || '';
  return `${q % 1 ? q.toFixed(2) : q} ${unit}`.trim();
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

// A payroll run's review status: draft -> for checking (Prepared) -> for approval (Noted) -> approved.
export const RUN_STATUS = {
  draft: { label: 'Draft', badge: 'badge-info' },
  for_checking: { label: 'For Checking', badge: 'badge-warning' },
  for_approval: { label: 'For Approval', badge: 'badge-warning' },
  approved: { label: 'Approved', badge: 'badge-success' },
};

// The company's logo for a printout; Wu Ventures' for any other company.
export const WU_LOGO = '/payslip/wu-ventures.png';
const LOGOS = { CFT: '/payslip/cuts-for-tots.png', FAT: '/payslip/fresh-and-tidy.png' };
export function companyLogo(run) {
  return LOGOS[run.company_code]
    || (/cuts/i.test(run.company_name) ? LOGOS.CFT : /fresh/i.test(run.company_name) ? LOGOS.FAT : WU_LOGO);
}
export const isSquareLogo = (src) => src === LOGOS.FAT;
