import { useEffect, useState } from 'react';
import api from '../../api/client';
import EntityPicker from '../../components/EntityPicker';

// Shared by Accounting > Reports > Sales Orders (Commission) and Invoices (Commission) (2026-10-22),
// copies of the source system's two commission listings.

export const money = (v) => {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
};
// "Sep 30, 2026", as the source prints dates; a DATE column is sliced, never put through a Date shift.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtDate = (v) => {
  const s = v ? String(v).slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const [y, m, d] = s.split('-').map(Number);
  return `${MONTHS[m - 1]} ${String(d).padStart(2, '0')}, ${y}`;
};
export const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
export const monthStart = () => `${today().slice(0, 7)}-01`;

// "As of" (one date) or "Period from" (two), as on the source.
export function DateFilter({ label, value, onChange }) {
  return (
    <div className="field">
      <label>{label}</label>
      {/* The choice keeps its width; the dates share the rest, and none overflows its column. */}
      <div style={{ display: 'flex', gap: 6, minWidth: 0 }}>
        <select value={value.filter} style={{ flex: '0 0 125px', minWidth: 0 }}
          onChange={(e) => onChange({ ...value, filter: e.target.value })}>
          <option value="as of">As of</option>
          <option value="period from">Period from</option>
        </select>
        <input type="date" style={{ flex: '1 1 0', minWidth: 0 }} value={value.d1} onChange={(e) => onChange({ ...value, d1: e.target.value })} />
        {value.filter === 'period from' && <input type="date" style={{ flex: '1 1 0', minWidth: 0 }} value={value.d2} onChange={(e) => onChange({ ...value, d2: e.target.value })} />}
      </div>
    </div>
  );
}

// The pickers' lists: sales reps (employees), locations, sales divisions.
export function useLookups() {
  const [lk, setLk] = useState({ reps: [], locations: [], divisions: [] });
  useEffect(() => {
    Promise.all([
      api.get('/employees').then((r) => r.data).catch(() => []),
      api.get('/lookups/locations').then((r) => r.data).catch(() => []),
      api.get('/lookups/sales-divisions').then((r) => r.data).catch(() => []),
    ]).then(([reps, locations, divisions]) => setLk({ reps, locations, divisions }));
  }, []);
  return lk;
}

export function RepPicker({ reps, value, onChange }) {
  return (
    <EntityPicker
      label="Sales Rep." items={reps} value={value}
      getLabel={(e) => `${e.first_name || ''} ${e.last_name || ''}`.trim()}
      columns={[{ key: 'first_name', label: 'First Name' }, { key: 'last_name', label: 'Last Name' }]}
      searchKeys={['first_name', 'last_name']}
      placeholder="Sales Rep"
      onSelect={(e) => onChange(e ? e.id : '')}
      onClear={() => onChange('')}
    />
  );
}
