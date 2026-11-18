import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';

// Office Location filters start on the SIGNED-IN USER'S Default Login Location (Users > User
// Branches, the row ticked "Default Login Location") -- asked 2026-10-19: a Head Office user's
// screens open on Head Office, a branch user's on their branch. Before that every screen opened on
// Head Office for everyone (2026-10-14). A user with no default branch still falls back to Head Office.
//
// Looked up once per signed-in account and shared by every screen; signing in as someone else (a new
// token) looks it up again.
//   undefined -- still looking; ''  -- none found (or no access to the list): no default
let pending = null;
let pendingToken = null;

function headOffice() {
  return api.get('/lookups/locations')
    .then(({ data }) => {
      const locs = Array.isArray(data) ? data : (data?.rows || []);
      const ho = locs.find((l) => String(l.location_name || '').trim().toLowerCase() === 'head office');
      return ho ? String(ho.id) : '';
    })
    .catch(() => '');
}

export function defaultOfficeLocationId() {
  let token = null;
  try { token = localStorage.getItem('token'); } catch { /* storage blocked: treat as one session */ }
  if (!pending || token !== pendingToken) {
    pendingToken = token;
    pending = api.get('/auth/me')
      .then(({ data }) => {
        // /auth/me answers { user, permissions } -- the branch is on the user. Reading it off the
        // top level found nothing, so every account fell back to Head Office (2026-10-19).
        const id = (data?.user || data)?.default_branch?.location_id;
        return id ? String(id) : headOffice();
      })
      .catch(() => headOffice())
      .catch(() => { pending = null; return ''; });
  }
  return pending;
}
// The name the screens already call it by.
export const headOfficeLocationId = defaultOfficeLocationId;

// A location filter's state, starting at null (= not decided yet) and set to the user's default
// office once known. A screen waits for it to stop being null before its first load, so the first
// list it shows is already that office's. Choosing "All" afterwards sets '' and stays.
//
// Follows the signed-in account: when it changes on an open screen (an admin's "Log in as", or
// "Return to my account"), the filter moves to the new account's default -- it used to keep the
// first account's, so a screen opened as an admin stayed on Head Office after logging in as a
// branch user (2026-10-19, ROSELYN P. TUNDAG / Branch - Ayala).
export function useHeadOfficeFilter() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [value, setValue] = useState(null);
  const shownFor = useRef(undefined);
  useEffect(() => {
    let alive = true;
    defaultOfficeLocationId().then((id) => {
      if (!alive) return;
      const switched = shownFor.current !== undefined && shownFor.current !== userId;
      shownFor.current = userId;
      setValue((v) => (v === null || switched ? id : v));
    });
    return () => { alive = false; };
  }, [userId]);
  return [value, setValue];
}
