import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';
import { COMPANY } from '../config/company';
import { formatClock, formatLocalTime, formatMinutes } from '../utils/attendance';

// The branch time clock: no login. Opened once on a branch tablet from the secret link HR
// made under Time Clock Devices; employees type their private PIN, see their name, and press
// the one button that applies (Time In or Time Out). The server takes the time.
//
// Screens: pin -> confirm -> done -> back to pin. A confirm or done screen left alone goes
// back to the PIN pad by itself, so the next person never sees someone else's name.

const PIN_LENGTH = 6;
const CONFIRM_TIMEOUT_MS = 20000;
const DONE_TIMEOUT_MS = 6000;

export default function Kiosk() {
  const { token } = useParams();
  const [device, setDevice] = useState(null);
  const [deviceError, setDeviceError] = useState('');
  const [now, setNow] = useState(() => new Date());
  const [pin, setPin] = useState('');
  const [screen, setScreen] = useState('pin');
  const [who, setWho] = useState(null); // lookup result
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    api.get(`/kiosk/${token}`)
      .then(({ data }) => { setDevice(data); document.title = `Time Clock · ${data.branch_name || data.name}`; })
      .catch((err) => setDeviceError(err.response?.data?.error || 'This time clock cannot reach the server.'));
  }, [token]);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const reset = useCallback(() => {
    clearTimeout(timer.current);
    setPin('');
    setWho(null);
    setResult(null);
    setScreen('pin');
    setBusy(false);
  }, []);

  const after = useCallback((ms) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(reset, ms);
  }, [reset]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const lookup = useCallback(async (fullPin) => {
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post(`/kiosk/${token}/lookup`, { pin: fullPin });
      setWho(data);
      setScreen('confirm');
      after(CONFIRM_TIMEOUT_MS);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not check the PIN. Try again.');
      setPin('');
    } finally {
      setBusy(false);
    }
  }, [token, after]);

  const press = useCallback((key) => {
    if (screen !== 'pin' || busy) return;
    setError('');
    if (key === 'clear') { setPin(''); return; }
    if (key === 'back') { setPin(pin.slice(0, -1)); return; }
    if (pin.length >= PIN_LENGTH) return;
    const next = pin + key;
    setPin(next);
    if (next.length === PIN_LENGTH) lookup(next);
  }, [screen, busy, pin, lookup]);

  // A hardware keyboard works too (a PC at the front desk).
  useEffect(() => {
    const onKey = (e) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('back');
      else if (e.key === 'Escape') { if (screen === 'pin') press('clear'); else reset(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press, reset, screen]);

  async function stamp() {
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post(`/kiosk/${token}/punch`, { pin, action: who.action });
      setResult(data);
      setScreen('done');
      after(DONE_TIMEOUT_MS);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not record the time. Try again.');
      setScreen('pin');
      setPin('');
      setWho(null);
    } finally {
      setBusy(false);
    }
  }

  const tz = device?.timezone || 'Asia/Manila';
  const clock = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(now);
  const dateLine = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(now);

  if (deviceError) {
    return (
      <div className="kiosk kiosk-center">
        <div className="kiosk-card">
          <h1>Time clock unavailable</h1>
          <p>{deviceError}</p>
        </div>
      </div>
    );
  }
  if (!device) return <div className="kiosk kiosk-center"><div className="kiosk-spinner" /></div>;

  return (
    <div className="kiosk">
      <header className="kiosk-head">
        <div>
          <div className="kiosk-brand">{COMPANY.name}</div>
          <div className="kiosk-place">{device.branch_name || device.name}</div>
        </div>
        <button type="button" className="kiosk-fullscreen" onClick={() => document.documentElement.requestFullscreen?.().catch(() => {})}>
          Full screen
        </button>
      </header>

      <div className="kiosk-clock">
        <div className="kiosk-time">{clock}</div>
        <div className="kiosk-date">{dateLine}</div>
      </div>

      {screen === 'pin' && (
        <div className="kiosk-panel">
          <div className="kiosk-prompt">{busy ? 'Checking…' : 'Enter your PIN'}</div>
          <div className="kiosk-dots" aria-label={`${pin.length} of ${PIN_LENGTH} digits entered`}>
            {Array.from({ length: PIN_LENGTH }, (_, i) => <span key={i} className={i < pin.length ? 'is-on' : ''} />)}
          </div>
          {error && <div className="kiosk-error">{error}</div>}
          <div className="kiosk-pad">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <button type="button" key={d} disabled={busy} onClick={() => press(d)}>{d}</button>
            ))}
            <button type="button" className="kiosk-pad-alt" disabled={busy} onClick={() => press('clear')}>Clear</button>
            <button type="button" disabled={busy} onClick={() => press('0')}>0</button>
            <button type="button" className="kiosk-pad-alt" disabled={busy} onClick={() => press('back')} aria-label="Delete last digit">⌫</button>
          </div>
        </div>
      )}

      {screen === 'confirm' && who && (
        <div className="kiosk-panel">
          <div className="kiosk-hello">Hi, {who.employee.first_name}!</div>
          <div className="kiosk-sub">
            {who.employee.name}{who.employee.employee_code ? ` · ${who.employee.employee_code}` : ''}
          </div>
          <div className="kiosk-shift">
            {who.today.shift
              ? <>{who.today.shift.name} · {formatClock(who.today.shift.start_time)} – {formatClock(who.today.shift.end_time)}</>
              : 'No shift scheduled today'}
          </div>
          {who.action === 'done' ? (
            <div className="kiosk-done-note">
              Already done for today: {formatLocalTime(who.today.log.time_in_local)} – {formatLocalTime(who.today.log.time_out_local, who.today.work_date)}
            </div>
          ) : (
            <>
              {who.action === 'out' && <div className="kiosk-sub">On duty since {formatLocalTime(who.open_log.time_in_local)}</div>}
              <button type="button" className={`kiosk-punch ${who.action === 'in' ? 'is-in' : 'is-out'}`} disabled={busy} onClick={stamp}>
                {busy ? 'Saving…' : who.action === 'in' ? 'TIME IN' : 'TIME OUT'}
              </button>
            </>
          )}
          <button type="button" className="kiosk-cancel" disabled={busy} onClick={reset}>{who.action === 'done' ? 'OK' : 'Not me — cancel'}</button>
        </div>
      )}

      {screen === 'done' && result && (
        <div className="kiosk-panel kiosk-success">
          <div className="kiosk-check">✓</div>
          <div className="kiosk-hello">
            {result.action === 'in' ? 'Timed in' : 'Timed out'} at {formatLocalTime(result.action === 'in' ? result.log.time_in_local : result.log.time_out_local)}
          </div>
          <div className="kiosk-sub">
            {result.employee.name}
            {result.action === 'in' && result.log.late_minutes > 0 && ` · ${formatMinutes(result.log.late_minutes)} late`}
            {result.action === 'out' && ` · worked ${formatMinutes(result.log.worked_minutes) || '0m'}`}
          </div>
          <button type="button" className="kiosk-cancel" onClick={reset}>Done</button>
        </div>
      )}
    </div>
  );
}
