import { useEffect, useState, useCallback } from 'react';
import api from '../api/client';
import AuthContext from './auth-context';
import { clearBackground, setBackground } from '../utils/background';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const raw = localStorage.getItem('user');
    return raw ? JSON.parse(raw) : null;
  });
  const [permissions, setPermissions] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) {
      setLoading(false);
      return;
    }
    try {
      const { data } = await api.get('/auth/me');
      setUser(data.user);
      setPermissions(data.permissions);
      localStorage.setItem('user', JSON.stringify(data.user));

      // The user's site background, deliberately a second request and deliberately not
      // awaited: it is a wallpaper-sized payload that must not sit between sign-in and
      // the first render, and index.html has already painted the cached copy. This is
      // what corrects that copy -- on a machine the user has never signed in on there is
      // nothing cached, and after a change made elsewhere the cache is a version behind.
      // A failure here leaves the cached background alone, which is the right outcome.
      api.get('/profiles/me/background')
        .then(({ data: bg }) => setBackground(bg.bg_data || null))
        .catch(() => {});
    } catch {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  async function login(username, password) {
    const { data } = await api.post('/auth/login', { username, password });
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    setUser(data.user);
    await loadMe();
  }

  function logout() {
    // Tell the server first (the token is still in localStorage for the interceptor to
    // attach) so the presence heartbeat is cleared and the user drops off the feed's
    // Contacts rail right away. Best-effort: a failed call must never block signing out.
    api.post('/auth/logout').catch(() => {});
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    // The background belongs to the account, not the browser: without this the next
    // person to sign in on a shared machine gets the last one's wallpaper.
    clearBackground();
    setUser(null);
    setPermissions([]);
  }

  function can(route, action = 'can_view') {
    const perm = permissions.find((p) => p.route === route);
    return !!perm?.[action];
  }

  // Admin "Log in as". Swapping the token and reloading /auth/me is enough -- every page
  // reads its data through the same client, so the whole app re-renders as the target user
  // with their permissions, not the admin's.
  async function impersonate(userId) {
    const { data } = await api.post(`/auth/impersonate/${userId}`);
    localStorage.setItem('token', data.token);
    await loadMe();
  }

  async function stopImpersonating() {
    const { data } = await api.post('/auth/stop-impersonating');
    localStorage.setItem('token', data.token);
    await loadMe();
  }

  return (
    <AuthContext.Provider value={{
      user, permissions, loading, login, logout, can, refresh: loadMe,
      impersonating: user?.impersonated_by || null,
      impersonate, stopImpersonating,
    }}>
      {children}
    </AuthContext.Provider>
  );
}
