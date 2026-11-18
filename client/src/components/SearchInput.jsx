import { useRef } from 'react';

// The "General Searching" box on the list pages, with an × that clears it (asked 2026-10-19).
// A drop-in for <input>: every prop goes to the input, and the × sends the page's own onChange an
// empty value -- the pages read e.target.value -- then puts the cursor back in the box.
export default function SearchInput({ value, onChange, className, ...rest }) {
  const ref = useRef(null);
  const clear = () => {
    onChange?.({ target: { value: '' }, currentTarget: { value: '' } });
    ref.current?.focus();
  };
  return (
    <div className={`search-input${className ? ` ${className}` : ''}`}>
      <input ref={ref} {...rest} value={value ?? ''} onChange={onChange} />
      {value ? (
        <button type="button" className="search-input-clear" aria-label="Clear search" title="Clear" onClick={clear}>×</button>
      ) : null}
    </div>
  );
}
