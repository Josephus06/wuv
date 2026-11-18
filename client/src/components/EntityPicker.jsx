import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import Pagination from './Pagination';

const PAGE_SIZE = 10;

// onClear is optional and opt-in per caller: a picker offers "Clear selection" only where the
// field is genuinely allowed to be empty. Wiring it into every picker would invite someone to
// blank a required reference and only find out at save time.
//
// onSearch is optional: for a list too big to load whole, the caller is told what was typed
// (debounced) and replaces `items` with the server's matches. The local filter still runs over them.
//
// tabs is optional too: [{ key, label, items, columns, searchKeys }] for a picker choosing across
// several kinds of record at once (Employees / Vendor / Customer). Each tab brings its own list and
// columns; the top-level items/columns/searchKeys are then unused. Ids must be unique across the
// tabs, since `value` has to find the selection whichever tab it came from.
export default function EntityPicker({
  label, items: plainItems, value, getLabel, columns: plainColumns, searchKeys: plainSearchKeys, onSelect,
  placeholder, required, disabled, triggerLabel, triggerClassName, isSelectable, headerExtra, onClear,
  onVisibleItems, tabs, onSearch,
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [tabKey, setTabKey] = useState(tabs?.[0]?.key);
  const tab = tabs ? (tabs.find((t) => t.key === tabKey) || tabs[0]) : null;
  const items = tab ? tab.items : plainItems;
  const columns = tab ? tab.columns : plainColumns;
  const searchKeys = tab ? tab.searchKeys : plainSearchKeys;
  const allItems = useMemo(() => (tabs ? tabs.flatMap((t) => t.items) : plainItems), [tabs, plainItems]);

  // Deliberately searches the FULL list, not the selectable one. A record that points at
  // something since retired must still show what it points at.
  const selected = allItems.find((i) => String(i.id) === String(value));

  // What may be chosen from here on. Callers pass isSelectable to keep retired master data --
  // an inactive process, a disabled location -- out of new work without hiding it on the
  // documents that already reference it. The currently-selected row is kept regardless, so
  // reopening the picker on an existing line does not silently drop what it is set to.
  const selectableItems = useMemo(() => {
    if (!isSelectable) return items;
    return items.filter((item) => isSelectable(item) || String(item.id) === String(value));
  }, [items, isSelectable, value]);

  const filtered = useMemo(() => {
    if (!search) return selectableItems;
    const q = search.toLowerCase();
    return selectableItems.filter((item) => searchKeys.some((k) => String(item[k] ?? '').toLowerCase().includes(q)));
  }, [selectableItems, search, searchKeys]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Optional hook for a caller that wants to show something per row it cannot afford to compute
  // for the whole list -- a stock balance, say, which costs a query over every movement ever
  // recorded. Only the ten rows actually on screen are announced, so the cost follows what the
  // user is looking at rather than the size of the catalogue.
  //
  // Keyed on the ids rather than the array: pageItems is rebuilt every render, so depending on it
  // directly would call the caller forever.
  const visibleKey = pageItems.map((i) => i.id).join(',');
  useEffect(() => {
    if (open && onVisibleItems) onVisibleItems(pageItems);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey, open]);

  useEffect(() => {
    if (!open || !onSearch) return undefined;
    const t = setTimeout(() => onSearch(search.trim()), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, open]);

  function openPicker() {
    if (disabled) return;
    setSearch('');
    setPage(1);
    // Reopen on the tab the current selection lives in, so it is in view.
    if (tabs) setTabKey((tabs.find((t) => t.items.some((i) => String(i.id) === String(value))) || tabs[0]).key);
    setOpen(true);
  }

  function choose(item) {
    onSelect(item);
    setOpen(false);
  }

  // Clears the FIELD, not the record behind it -- hence "Clear selection" rather than "Delete",
  // which in a picker listing master data reads like it removes the material itself.
  function clearSelection() {
    onClear();
    setOpen(false);
  }

  return (
    <>
      {triggerLabel ? (
        <button type="button" className={triggerClassName || 'btn'} onClick={openPicker} disabled={disabled}>
          {triggerLabel}
        </button>
      ) : (
        <div className="picker-input">
          <input
            readOnly
            required={required}
            value={selected ? getLabel(selected) : ''}
            placeholder={placeholder || `Select ${label}...`}
            onClick={openPicker}
            disabled={disabled}
          />
          {/* Clear straight from the field (2026-10-26), not only from inside the picker -- where the
              caller allows it to be empty and there is something to clear. */}
          {onClear && selected && !disabled && (
            <button type="button" className="btn" onClick={() => onClear()} aria-label={`Clear ${label}`} title={`Clear ${label}`}>
              ×
            </button>
          )}
          <button type="button" className="btn" onClick={openPicker} disabled={disabled} aria-label={`Search ${label}`}>
            🔍
          </button>
        </div>
      )}

      {open && (
        <Modal
          title={headerExtra ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>{label}{headerExtra}</span> : label}
          onClose={() => setOpen(false)}
          large
        >
          <div className="picker-search" style={{ margin: '0 -24px 16px', display: 'flex', gap: 12, alignItems: 'center' }}>
            <input
              autoFocus
              placeholder="Search..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              style={{ flex: 1, minWidth: 0 }}
            />
            {/* Only with something to clear: on an empty field the button would do nothing and
                just raise the question of what it does. */}
            {onClear && selected && (
              <button type="button" className="btn" style={{ whiteSpace: 'nowrap' }} onClick={clearSelection}>
                Clear selection
              </button>
            )}
          </div>
          {tabs && (
            <div className="status-tabs" style={{ marginBottom: 12 }}>
              {tabs.map((t) => (
                <button key={t.key} type="button" className={`status-tab ${t.key === tab.key ? 'active' : ''}`}
                  onClick={() => { setTabKey(t.key); setPage(1); }}>{t.label}</button>
              ))}
            </div>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>{columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {pageItems.length === 0 && (
                  <tr><td colSpan={columns.length} className="muted" style={{ textAlign: 'center', padding: 20 }}>No results.</td></tr>
                )}
                {pageItems.map((item) => (
                  <tr key={item.id} className="picker-row" onClick={() => choose(item)}>
                    {columns.map((c) => <td key={c.key}>{c.render ? c.render(item) : item[c.key]}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} totalPages={totalPages} onChange={setPage} />
        </Modal>
      )}
    </>
  );
}
