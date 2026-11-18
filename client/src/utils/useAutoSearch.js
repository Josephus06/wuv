import { useEffect, useRef } from 'react';

// Runs a list page's search a moment after the user stops typing in General Searching, so
// results filter as they type instead of waiting for the Search button or Enter. The pause
// keeps a fast typist from firing one server request per letter.
//
// `run` is the page's own search function, called as-is, so each page keeps whatever it
// already does on Search (reset to page 1, apply the other filters too, and so on).
export default function useAutoSearch(value, run, delay = 400) {
  const runRef = useRef(run);
  runRef.current = run;
  // The value last searched for. Starts at the mount value, so opening a page does not
  // search twice, and StrictMode's re-run of the effect finds nothing changed.
  const last = useRef(value);

  useEffect(() => {
    if (value === last.current) return undefined;
    const timer = setTimeout(() => {
      last.current = value;
      runRef.current();
    }, delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
}
