import { useCallback, useEffect, useState } from 'react';
import {
  ApiError, clearSession, getRememberedUsername, getStatus, getToken, login, timeIn, timeOut,
} from './api';
import { formatClock, formatDate, formatLocalTime, formatMinutes, parseUtc } from './format';

export default function App() {
  const [signedIn, setSignedIn] = useState(() => !!getToken());
  const [notice, setNotice] = useState('');

  const signOut = useCallback((message = '') => {
    clearSession();
    setNotice(message);
    setSignedIn(false);
  }, []);

  return signedIn
    ? <TimeClock onSignOut={signOut} />
    : <SignIn notice={notice} onSignedIn={() => { setNotice(''); setSignedIn(true); }} />;
}

function SignIn({ notice, onSignedIn }) {
  const [username, setUsername] = useState(getRememberedUsername);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(username.trim(), password);
      onSignedIn();
    } catch (err) {
      setError(err.status === 401 ? 'Wrong username or password.' : err.message);
      setBusy(false);
    }
  }

  return (
    <main className="screen signin">
      <div className="brand">
        <div className="brand-mark">WU</div>
        <h1>Time Clock</h1>
        <p className="muted">Sign in with your WVI account</p>
      </div>
      <form className="card" onSubmit={submit}>
        {notice && <div className="banner info">{notice}</div>}
        {error && <div className="banner error">{error}</div>}
        <label htmlFor="username">Username or email</label>
        <input
          id="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" required
          value={username} onChange={(e) => setUsername(e.target.value)}
        />
        <label htmlFor="password">Password</label>
        <div className="password-row">
          <input
            id="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required
            value={password} onChange={(e) => setPassword(e.target.value)}
          />
          <button type="button" className="link" onClick={() => setShowPassword((s) => !s)}>
            {showPassword ? 'Hide' : 'Show'}
          </button>
        </div>
        <button type="submit" className="btn primary block" disabled={busy}>{busy ? 'Signing in…' : 'Sign In'}</button>
      </form>
    </main>
  );
}

function TimeClock({ onSignOut }) {
  const [data, setData] = useState(null);
  const [now, setNow] = useState(() => new Date());
  const [confirming, setConfirming] = useState(null); // 'in' | 'out'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleError = useCallback((err) => {
    if (err instanceof ApiError && err.status === 401) {
      onSignOut('Your session ended. Please sign in again.');
      return;
    }
    setError(err.message);
  }, [onSignOut]);

  const load = useCallback(async () => {
    try {
      setData(await getStatus());
      setError('');
    } catch (err) {
      handleError(err);
    }
  }, [handleError]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    // Coming back to the app (unlocking the phone) re-reads the status, so a stamp made from
    // the website in the meantime is reflected before anyone taps.
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);

  async function stamp() {
    const kind = confirming;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const log = kind === 'in' ? await timeIn() : await timeOut();
      setSuccess(kind === 'in'
        ? `Timed in at ${formatLocalTime(log.time_in_local)}${log.late_minutes ? ` · ${formatMinutes(log.late_minutes)} late` : ''}`
        : `Timed out at ${formatLocalTime(log.time_out_local)} · worked ${formatMinutes(log.worked_minutes)}`);
      await load();
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  if (!data) {
    return (
      <main className="screen center">
        {error ? (
          <div className="card">
            <div className="banner error">{error}</div>
            <button type="button" className="btn primary block" onClick={load}>Try Again</button>
            <button type="button" className="btn block" onClick={() => onSignOut()}>Sign Out</button>
          </div>
        ) : <div className="spinner" aria-label="Loading" />}
      </main>
    );
  }

  const tz = data.timezone;
  const clock = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(now);
  const dateLine = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).format(now);
  const nowHm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);

  if (!data.employee) {
    return (
      <main className="screen center">
        <div className="card">
          <h2>Not set up yet</h2>
          <p>Your account is not linked to an employee record, so there is nothing to time in to.</p>
          <p className="muted">Ask HR to set the Employee on your user account, then open the app again.</p>
          <button type="button" className="btn block" onClick={() => onSignOut()}>Sign Out</button>
        </div>
      </main>
    );
  }

  const open = data.open_log;
  const today = data.today;
  const doneToday = !open && today.log?.time_out_local;
  const elapsed = open ? Math.max(0, Math.floor((now - parseUtc(open.time_in)) / 60000)) : 0;

  return (
    <main className="screen">
      <header className="topbar">
        <div>
          <div className="who">{data.employee.first_name} {data.employee.last_name}</div>
          <div className="muted small">{[data.employee.employee_code, data.employee.department_name].filter(Boolean).join(' · ')}</div>
        </div>
        <button type="button" className="link" onClick={() => onSignOut()}>Sign out</button>
      </header>

      <section className="clock">
        <div className="clock-time">{clock}</div>
        <div className="muted">{dateLine}</div>
        <div className="shift">
          {today.shift
            ? <>{today.shift.name} · {formatClock(today.shift.start_time)} – {formatClock(today.shift.end_time)}</>
            : <span className="muted">No shift scheduled today</span>}
        </div>
      </section>

      {error && <div className="banner error">{error}</div>}
      {success && <div className="banner success">{success}</div>}

      <section className="action">
        {open ? (
          <>
            <button type="button" className="punch out" disabled={busy} onClick={() => setConfirming('out')}>
              <span className="punch-label">TIME OUT</span>
            </button>
            <div className="status on">
              <span className="dot" /> On duty since {formatLocalTime(open.time_in_local)} · {formatMinutes(elapsed)}
            </div>
          </>
        ) : doneToday ? (
          <div className="status done">
            Done for today · {formatLocalTime(today.log.time_in_local)} – {formatLocalTime(today.log.time_out_local, today.work_date)}
          </div>
        ) : (
          <>
            <button type="button" className="punch in" disabled={busy} onClick={() => setConfirming('in')}>
              <span className="punch-label">TIME IN</span>
            </button>
            <div className="status"><span className="dot" /> Not timed in</div>
          </>
        )}
      </section>

      <section className="history">
        <h3>Recent</h3>
        {data.recent.length === 0 ? <p className="muted">No time records yet.</p> : (
          <ul>
            {data.recent.slice(0, 7).map((r) => (
              <li key={r.id}>
                <span className="day">{formatDate(r.work_date)}</span>
                <span className="times">
                  {formatLocalTime(r.time_in_local, r.work_date)} – {formatLocalTime(r.time_out_local, r.work_date) || '—'}
                </span>
                <span className="tags">
                  {r.late_minutes > 0 && <span className="tag late">{formatMinutes(r.late_minutes)} late</span>}
                  {r.time_out_local && <span className="tag">{formatMinutes(r.worked_minutes)}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {confirming && (
        <div className="sheet-backdrop" onClick={() => !busy && setConfirming(null)}>
          <div className="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h2>{confirming === 'in' ? 'Time in now?' : 'Time out now?'}</h2>
            <p className="sheet-time">{formatClock(nowHm)}</p>
            <p className="muted">The time is taken from the company server when you confirm.</p>
            <button type="button" className={`btn block ${confirming === 'in' ? 'primary' : 'danger'}`} disabled={busy} onClick={stamp}>
              {busy ? 'Saving…' : confirming === 'in' ? 'Confirm Time In' : 'Confirm Time Out'}
            </button>
            <button type="button" className="btn block" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
          </div>
        </div>
      )}
    </main>
  );
}
