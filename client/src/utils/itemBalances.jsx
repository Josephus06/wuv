import { useState } from 'react';
import api from '../api/client';

// Stock balances for an item picker, loaded for the rows on screen only.
//
// A balance is a sum over every movement ever recorded. Asking for the whole catalogue measured
// 15 SECONDS for 6,547 items against about 40ms for a page of ten, so the picker's onVisibleItems
// hook drives this and the cost follows what the user is actually looking at.
//
// Shared rather than written per page: the Bin Card and the Purchase Requisition both want it, and
// two copies of the caching would be free to disagree about which location a figure belongs to.

function qtyFmt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}

// `undefined` means not asked for yet and `null` means in flight -- both show a dash rather than a
// 0, because an unknown balance and an empty bin are not the same answer to "how much is there".
function balanceCell(entry, amountKey, unitKey) {
  if (!entry) return <span className="muted">—</span>;
  return (
    <>
      {qtyFmt(entry[amountKey])}
      {entry[unitKey] && <span className="muted" style={{ marginLeft: 4, fontSize: '0.85em' }}>{entry[unitKey]}</span>}
    </>
  );
}

export function useItemBalances(locationId) {
  const [cache, setCache] = useState({ locationId: null, byItem: {} });

  // A cached figure belongs to the location it was asked for, so the cache carries that location
  // with it and anything held for a different one is simply not used. Keying it this way rather
  // than clearing on change means no effect has to fire to keep the two in step.
  const wanted = locationId ?? null;
  const balances = cache.locationId === wanted ? cache.byItem : {};

  async function load(visible) {
    const missing = visible.map((i) => i.id).filter((id) => balances[id] === undefined);
    if (!missing.length) return;
    // Marked pending first so a second page turn does not re-request the same ids. A cache held
    // for another location is dropped here rather than merged into.
    const keep = (prev) => (prev.locationId === wanted ? prev.byItem : {});
    setCache((prev) => {
      const byItem = { ...keep(prev) };
      missing.forEach((id) => { byItem[id] = null; });
      return { locationId: wanted, byItem };
    });
    try {
      const { data } = await api.get('/inventory/balances', {
        params: { item_ids: missing.join(','), location_id: wanted || undefined },
      });
      setCache((prev) => {
        const byItem = { ...keep(prev) };
        data.forEach((b) => { byItem[b.item_id] = b; });
        return { locationId: wanted, byItem };
      });
    } catch {
      // A balance that will not load must not stop someone picking an item; the cell stays blank,
      // and the id is released so turning back to the page tries again.
      setCache((prev) => {
        const byItem = { ...keep(prev) };
        missing.forEach((id) => { if (byItem[id] === null) delete byItem[id]; });
        return { locationId: wanted, byItem };
      });
    }
  }

  return { balances, load };
}

// The two picker columns. Each figure carries its own unit, because every row is a different item
// and the unit cannot live in the header the way it does on a single-item report.
export function balanceColumns(balances, locationName) {
  const suffix = locationName ? ` — ${locationName}` : '';
  return [
    {
      key: 'balance_stock',
      label: `Balance (Stock Unit)${suffix}`,
      render: (i) => balanceCell(balances[i.id], 'balance_stock', 'stock_unit_title'),
    },
    {
      key: 'balance_base',
      label: `Balance (Base Unit)${suffix}`,
      render: (i) => balanceCell(balances[i.id], 'balance_base', 'base_unit_title'),
    },
  ];
}
