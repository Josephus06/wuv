// The time clock talks to the same API as the ERP (server/src/routes/attendance.js). It is
// always an absolute URL: the packaged app is served from the phone's own local scheme, so
// there is no same-origin server for a relative '/api' to reach.
export const API_BASE = (import.meta.env.VITE_API_BASE || 'https://wuventure.graphicstar.ph').replace(/\/$/, '');

const TOKEN_KEY = 'timeclock.token';
const USERNAME_KEY = 'timeclock.username';

function storage(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

export const getToken = () => storage(() => localStorage.getItem(TOKEN_KEY));
export const getRememberedUsername = () => storage(() => localStorage.getItem(USERNAME_KEY), '') || '';
export function clearSession() { storage(() => localStorage.removeItem(TOKEN_KEY)); }

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, body) {
  const token = getToken();
  let res;
  try {
    res = await fetch(`${API_BASE}/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your internet connection and try again.');
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && path !== '/auth/login') clearSession();
  if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status})`);
  return data;
}

export async function login(username, password) {
  const data = await request('POST', '/auth/login', { username, password });
  storage(() => {
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USERNAME_KEY, username);
  });
  return data.user;
}

export const getStatus = () => request('GET', '/attendance/me');
export const timeIn = () => request('POST', '/attendance/me/time-in');
export const timeOut = () => request('POST', '/attendance/me/time-out');
