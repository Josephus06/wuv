// Background tabs poll slowly (asked 2026-10-27: T1S lagged with many tabs open). Every tab ran its
// own notification / messenger timers -- the bell every 5 s -- whether anyone was looking at it, so
// ten tabs meant ~150 requests a minute from one browser. A tab that is hidden now polls at most
// once a minute, and catches up the moment it is shown again.
//
//   const gate = hiddenPollGate();
//   setInterval(() => { if (gate()) load(); }, REFRESH_MS);
//   onTabVisible(load);   // refresh on coming back
export const HIDDEN_POLL_MS = 60000;

// Returns a check for each tick: always true while the tab is visible; while hidden, true once per
// `ms`. Hidden tabs still poll (slowly) so a desktop notification can arrive when T1S is in the
// background.
export function hiddenPollGate(ms = HIDDEN_POLL_MS) {
  let last = Date.now();
  return () => {
    const now = Date.now();
    if (document.visibilityState !== 'hidden' || now - last >= ms) { last = now; return true; }
    return false;
  };
}

// Calls fn when the tab becomes visible again. Returns the unsubscribe for an effect's cleanup.
export function onTabVisible(fn) {
  const handler = () => { if (document.visibilityState === 'visible') fn(); };
  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
}
