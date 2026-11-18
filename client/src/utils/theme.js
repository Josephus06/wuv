// Light/dark theme handling.
//
// The palette lives in index.css as CSS custom properties: :root holds light, and
// :root[data-theme="dark"] overrides them. The data-theme attribute is ALWAYS set --
// index.html sets it inline before first paint (so a dark-mode user never sees a white
// flash), and this module keeps it in step afterwards.
//
// Three stored states, not two: an explicit choice, or no stored value at all meaning "follow
// the OS", which is the default for someone who has never touched the toggle. That's why
// resolve() consults matchMedia rather than assuming light.
//
// THREE THEMES NOW. 'glass' is the frosted theme (styles/glass.css) and is a dark theme in
// every respect that matters to the browser, which is why it maps to colorScheme 'dark'
// below -- the native scrollbars and form widgets have no idea what glass is, and telling
// them 'glass' would silently fall back to light ones on a near-black page.
const STORAGE_KEY = 'theme';
export const THEMES = ['light', 'dark', 'glass'];
// Which of the browser's own two schemes each theme belongs to.
const COLOR_SCHEME = { light: 'light', dark: 'dark', glass: 'dark' };

export function storedTheme() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return THEMES.includes(v) ? v : null;
  } catch {
    // Private mode / blocked storage -- fall back to following the OS every load.
    return null;
  }
}

export function systemTheme() {
  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// The theme actually in effect right now: the user's explicit choice if they made one.
export function resolveTheme() {
  return storedTheme() || systemTheme();
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  // Keeps native widgets (scrollbars, form controls, the browser's own UI) in step with the
  // chosen theme rather than the OS one. Glass maps to 'dark': see COLOR_SCHEME above.
  document.documentElement.style.colorScheme = COLOR_SCHEME[theme] || theme;
}

export function setTheme(theme) {
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* not fatal -- applies for this session */ }
  applyTheme(theme);
  return theme;
}

// The toggle's order: day -> night -> glass -> day. Named here rather than written into the
// component so the cycle and the theme list cannot drift apart.
export function nextTheme(theme) {
  const i = THEMES.indexOf(theme);
  return THEMES[(i + 1) % THEMES.length];
}

// Subscribes to OS theme changes, but only acts while the user is still on "follow the OS".
// Returns an unsubscribe function.
export function watchSystemTheme(onChange) {
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (!mq) return () => {};
  const handler = () => {
    if (storedTheme()) return;
    const next = systemTheme();
    applyTheme(next);
    onChange(next);
  };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
