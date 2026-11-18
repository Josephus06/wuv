// Personal site background ("wallpaper").
//
// Same shape as utils/theme.js, and for the same reason: the value has to be on the
// document before React mounts or the user watches their background pop in a beat after
// the page. index.html applies the cached copy inline before first paint; this module
// keeps it in step afterwards and is the only thing that writes the cache.
//
// The image itself lives on the server (users.bg_data, via /api/profiles/me/background)
// so it follows the user between machines; localStorage only ever holds a copy of it.
// Cache and server can disagree for one request after a change made elsewhere -- the
// cached image paints immediately and AuthContext overwrites it once /me/background
// answers, which is the right trade for something purely cosmetic.
//
// CSS carries the image as a custom property and the on/off state as a data attribute,
// so the whole visual treatment (the fixed layer, its balanced opacity, which surfaces
// go transparent to let it through) stays in index.css rather than being half in JS.
const STORAGE_KEY = 'app-background';

// A data: URL is pasted straight into a CSS url() below, so it is matched against a
// positive allowlist rather than screened for bad characters: only the alphabet a base64
// image URL is actually made of gets through, which no quote, backslash, whitespace or
// parenthesis can survive. Guards against a hand-edited cache entry, and rejects a value
// that is not an image in the first place.
const DATA_URL_CHARS = /^[A-Za-z0-9+/=:;,.-]+$/;

function isSafeDataUrl(value) {
  return typeof value === 'string'
    && value.startsWith('data:image/')
    && DATA_URL_CHARS.test(value);
}

export function storedBackground() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isSafeDataUrl(v) ? v : null;
  } catch {
    // Private mode / blocked storage -- the background still works, it just has to be
    // re-fetched from the server on every load instead of painting from cache.
    return null;
  }
}

// Anything that renders "do you have a background right now" (the topbar menu decides
// whether to offer Remove) subscribes here. Without this it would read the cache once at
// mount and then be wrong for the user whose background arrives a moment later from the
// server -- the machine they just signed in on has nothing cached.
//
// Seeded from the cache because that is what index.html has already painted by the time
// this module loads; applyBackground keeps it honest from then on.
let current = storedBackground();
const listeners = new Set();

export function currentBackground() {
  return current;
}

// Subscribers are handed the current value immediately, not just future changes. The
// two are a race otherwise: on a machine with nothing cached the server copy can land
// before the topbar has mounted and subscribed, and a subscriber that only listened
// forward would sit there believing the user has no background and never offer Remove.
export function subscribeBackground(fn) {
  listeners.add(fn);
  fn(current);
  return () => listeners.delete(fn);
}

export function applyBackground(dataUrl) {
  const root = document.documentElement;
  const next = isSafeDataUrl(dataUrl) ? dataUrl : null;
  current = next;
  if (next) {
    root.style.setProperty('--app-bg-image', `url("${next}")`);
    root.dataset.bg = 'on';
  } else {
    root.style.removeProperty('--app-bg-image');
    delete root.dataset.bg;
  }
  listeners.forEach((fn) => fn(next));
}

// Persist + apply in one step. Pass null to go back to the plain theme background.
export function setBackground(dataUrl) {
  const next = isSafeDataUrl(dataUrl) ? dataUrl : null;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, next);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Over quota (or blocked): show it for this session rather than failing the upload.
    // The server copy is what matters; the next load re-fetches it.
  }
  applyBackground(next);
  return next;
}

// Used on sign-out: the background is a property of the account, not the browser, so the
// next person to sign in on this machine must not inherit the last one's wallpaper.
export function clearBackground() {
  setBackground(null);
}
