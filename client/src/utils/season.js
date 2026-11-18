import { useEffect, useState } from 'react';
import { applyTheme, resolveTheme } from './theme';

// Seasonal themes (2026-11-14). Two full dark redesigns, each scoped to a class on <html>:
//   spooky     -- Halloween, "Night of the Ledger"   (styles/spooky.css, SpookyDecor) -> html.spooky
//   christmas  -- Christmas, "Season's Greetings"    (styles/xmas.css, XmasDecor)     -> html.xmas
// While one is on, the page runs on the dark palette whatever Day / Night / Glass is stored; the
// stored theme comes back the moment the season is switched off.
//
// WHO DECIDES (asked 2026-11-14: "admin can only change the season theme, but a user can change the
// theme from original to the theme set by admin"):
//   - the season is a company-wide setting a System Admin picks (server: routes/seasonTheme.js,
//     app_settings 'season_theme'): 'auto' (Oct-Nov Halloween, Dec Christmas), 'halloween',
//     'christmas' or 'off'. Cached here in localStorage 'season-admin' so the first paint has it;
//   - each user only switches it off / on for themselves: localStorage 'season-user' = 'off' | 'on'.
// index.html applies it before first paint (mirrors resolveSeason / applySeason).
const ADMIN_KEY = 'season-admin';
const USER_KEY = 'season-user';
const CHOICES = ['auto', 'halloween', 'christmas', 'off'];

export const SEASONS = {
  spooky: { label: 'Night of the Ledger', name: 'Halloween', cls: 'spooky' },
  christmas: { label: "Season's Greetings", name: 'Christmas', cls: 'xmas' },
};
export const SEASON_CHOICES = [
  { value: 'auto', label: 'Auto (by date)' },
  { value: 'halloween', label: 'Halloween' },
  { value: 'christmas', label: 'Christmas' },
  { value: 'off', label: 'Off (original look)' },
];

// The season for a date: Oct-Nov Halloween, Dec Christmas, otherwise none.
export function seasonFor(date = new Date()) {
  const m = date.getMonth(); // 0 = Jan
  if (m === 9 || m === 10) return 'spooky';
  if (m === 11) return 'christmas';
  return null;
}

function read(key) { try { return localStorage.getItem(key); } catch { return null; } }
function write(key, v) { try { localStorage.setItem(key, v); } catch { /* applies for this session */ } }

// The admin's choice, as last heard from the server.
export function adminSeasonChoice() {
  const v = read(ADMIN_KEY);
  return CHOICES.includes(v) ? v : 'auto';
}
export function rememberAdminChoice(v) { if (CHOICES.includes(v)) write(ADMIN_KEY, v); }

// This user's own switch. Older keys ('season' / 'season-theme' = 'off') still count as off.
export function userSeasonOn() {
  const v = read(USER_KEY);
  if (v === 'on' || v === 'off') return v === 'on';
  return read('season') !== 'off' && read('season-theme') !== 'off';
}

// The season the admin's choice puts on screen now (before the user's own switch).
export function companySeason(choice = adminSeasonChoice()) {
  if (choice === 'off') return null;
  if (choice === 'halloween') return 'spooky';
  if (choice === 'christmas') return 'christmas';
  return seasonFor();
}

// What this user sees now.
export function activeSeason() { return userSeasonOn() ? companySeason() : null; }

const listeners = new Set();

export function applySeason(season) {
  const root = document.documentElement;
  if (season) root.dataset.season = season;
  else delete root.dataset.season;
  root.classList.toggle('spooky', season === 'spooky');
  root.classList.toggle('xmas', season === 'christmas');
  // Both seasons are built on the dark palette; off gets the stored Day / Night / Glass back.
  applyTheme(season ? 'dark' : resolveTheme());
  listeners.forEach((fn) => fn(season));
}

// The user's pill: their own off / on. Returns the season now showing.
export function setUserSeasonOn(on) {
  write(USER_KEY, on ? 'on' : 'off');
  const s = on ? companySeason() : null;
  applySeason(s);
  return s;
}

// The season currently on screen, for components that show something different during it
// (Lookups' "Search the crypt..." / "Check it twice..."). Follows the toggle without a reload.
export function useSeason() {
  const [season, setSeason] = useState(() => document.documentElement.dataset.season || null);
  useEffect(() => {
    listeners.add(setSeason);
    return () => { listeners.delete(setSeason); };
  }, []);
  return season;
}
