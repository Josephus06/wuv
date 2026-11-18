import { useMemo } from 'react';
import EntityPicker from './EntityPicker';

// A list filter that picks from people or places -- Sales Rep, Department, Location, Customer --
// through the searchable picker window instead of a long dropdown (asked 2026-10-12). It takes and
// gives back what a <select> did -- the chosen id as a string, '' for all -- so a filter swaps
// `<select value onChange>` for this without anything else on the page changing.
//   items     the records to choose from (each with an id)
//   getLabel  how a record reads, e.g. (e) => `${e.first_name} ${e.last_name}`
//   value / onChange   the id, '' when no filter
export default function FilterPicker({ label, items, value, onChange, getLabel, allLabel = 'All', disabled }) {
  const list = useMemo(
    () => (items || []).map((it) => ({ ...it, _label: String(getLabel(it) ?? '').trim() })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items],
  );
  return (
    <EntityPicker
      label={label}
      items={list}
      value={value ?? ''}
      getLabel={(i) => i._label}
      columns={[{ key: '_label', label }]}
      searchKeys={['_label']}
      placeholder={allLabel}
      disabled={disabled}
      onSelect={(i) => onChange(i ? String(i.id) : '')}
      onClear={() => onChange('')}
    />
  );
}
