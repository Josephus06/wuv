import { useEffect, useRef, useState } from 'react';

// A page-header button that opens a small menu under itself -- the "Print ⌄" pattern, where
// one action has several formats behind it. Click-driven (not hover like the top nav), since
// these sit next to destructive buttons and a hover menu is too easy to open by accident.
export default function ButtonMenu({ label, options, className = 'btn btn-sm', disabled = false, title }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="btn-menu" ref={ref}>
      <button type="button" className={className} title={title} disabled={disabled} onClick={() => setOpen((v) => !v)}>
        {label} <span className="btn-menu-caret">▾</span>
      </button>
      {open && (
        <div className="btn-menu-list">
          {options.map((o) => (
            <button
              key={o.label}
              type="button"
              className="btn-menu-item"
              onClick={() => { setOpen(false); o.onClick(); }}
            >
              <span>{o.label}</span>
              {o.hint && <small>{o.hint}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
