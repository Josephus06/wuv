import { useEffect, useState } from 'react';
import api from '../api/client';

// The UOM of a process line, limited to the units assigned to its item (Inventory Item > Unit of
// Measures) -- asked 2026-10-19: a line could carry SQFT or PC on a sheet item whose units are
// MM / CM / MTR / IN / FT, and then could not be costed (fix-nsjo-size-units.js). Used by the
// Estimate, Job Order edit, and the NSJO / RWIP / Non-Standard JO forms.
//
// A line already holding a unit outside the item's list does NOT get that unit offered back: it
// reads "— choose —" with a red outline until a valid one is picked.
const cache = new Map(); // item id -> Promise<[{ id, code }]>

export function loadItemUoms(itemId) {
  if (!itemId) return Promise.resolve([]);
  if (!cache.has(itemId)) {
    cache.set(itemId, api.get(`/inventory/${itemId}/unit-of-measures`).then(({ data }) => (Array.isArray(data) ? data : []))
      .catch(() => { cache.delete(itemId); return []; }));
  }
  return cache.get(itemId);
}

// The unit a line starts on when its item is picked: the item's base unit if it is one of its
// assigned units, else the first assigned unit, else nothing.
export async function defaultItemUom(itemId, baseUnitCode) {
  const list = await loadItemUoms(itemId);
  const base = String(baseUnitCode || '').toUpperCase();
  const hit = list.find((u) => String(u.code).toUpperCase() === base);
  return hit ? hit.code : (list[0]?.code || '');
}

export default function ItemUomSelect({ itemId, value, onChange, disabled, style, options: given }) {
  const [list, setList] = useState(given || []);
  useEffect(() => {
    if (given) { setList(given); return undefined; }
    let alive = true;
    loadItemUoms(itemId).then((l) => { if (alive) setList(l); });
    return () => { alive = false; };
  }, [itemId, given]);
  const valid = !value || list.some((u) => String(u.code) === String(value));
  return (
    <select
      value={valid ? (value || '') : ''}
      disabled={disabled || !itemId}
      onChange={(e) => onChange(e.target.value)}
      title={valid ? undefined : `"${value}" is not one of this item's units -- choose one`}
      style={{ ...(style || {}), ...(valid ? {} : { outline: '2px solid var(--danger, #b91c1c)' }) }}
    >
      <option value="">{valid ? '—' : '— choose —'}</option>
      {list.map((u) => <option key={u.id || u.code} value={u.code}>{u.code}</option>)}
    </select>
  );
}
