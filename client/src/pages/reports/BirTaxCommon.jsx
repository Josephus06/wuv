import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api/client';

// Shared by the three BIR tax reports (asked 2026-10-21): Expanded Withholding Tax, 2307 from
// customers, VAT Computation -- the month picker (kept in ?month= so a reminder can link to it), the
// filing deadline banner and the CSV download.

export function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
export const day = (v) => (v ? String(v).slice(0, 10) : '');

const manilaMonth = (offset = 0) => {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + offset, 1));
  return d.toISOString().slice(0, 7);
};

// ?month=YYYY-MM, else the default (offset months from this one: -1 = last month).
export function useMonth(defaultOffset) {
  const [params, setParams] = useSearchParams();
  const month = /^\d{4}-\d{2}$/.test(params.get('month') || '') ? params.get('month') : manilaMonth(defaultOffset);
  const setMonth = (m) => { const p = new URLSearchParams(params); p.set('month', m); setParams(p, { replace: true }); };
  return [month, setMonth];
}

export function MonthPicker({ month, onChange }) {
  const step = (n) => {
    const [y, m] = month.split('-').map(Number);
    onChange(new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7));
  };
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
      <button type="button" className="btn btn-secondary" onClick={() => step(-1)} aria-label="Previous month">‹</button>
      <div className="field" style={{ margin: 0 }}>
        <label>Month</label>
        <input type="month" value={month} onChange={(e) => e.target.value && onChange(e.target.value)} />
      </div>
      <button type="button" className="btn btn-secondary" onClick={() => step(1)} aria-label="Next month">›</button>
    </div>
  );
}

const fmtDue = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' });

// "Due Wed, November 5, 2026 -- in 15 days", coloured by how close it is.
export function DeadlineBanner({ deadline, what, done }) {
  if (!deadline) return null;
  const d = deadline.days_left;
  const tone = done ? 'success' : deadline.state === 'overdue' ? 'danger' : deadline.state === 'upcoming' ? 'info' : 'warning';
  const when = d < 0 ? `${-d} day${d === -1 ? '' : 's'} ago` : d === 0 ? 'today' : `in ${d} day${d === 1 ? '' : 's'}`;
  return (
    <div className={`card bir-deadline bir-deadline-${tone}`} style={{ marginBottom: 16, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <span className={`badge badge-${tone}`}>{done ? 'Complete' : d < 0 ? 'Past due' : d === 0 ? 'Due today' : d <= 3 ? 'Due soon' : 'Upcoming'}</span>
      <div>
        <strong>{what}</strong> — due {fmtDue(deadline.due_date)} ({when})
      </div>
    </div>
  );
}

export function useCsvDownload(path, params, filename) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function download() {
    setBusy(true); setError('');
    try {
      const res = await api.get(path, { params: { ...params, format: 'csv' }, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not download the report.');
    }
    setBusy(false);
  }
  return { download, busy, error };
}

export function Stat({ label, value, tone }) {
  return (
    <div className="stat-card">
      <div className="value" style={{ fontSize: 22, color: tone ? `var(--color-${tone}-text)` : undefined }}>{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}
