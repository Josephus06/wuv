import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';
import QrScanner from '../components/QrScanner';
import FaceEnroll from '../components/FaceEnroll';
import { COMPANY } from '../config/company';
import { formatClock, formatLocalTime, formatMinutes } from '../utils/attendance';
import { loadFaceModels, readFace } from '../utils/face';

// The branch time clock: no login. Opened once on a branch tablet from the secret link HR
// made under Time Clock Devices. Two ways to stamp, chosen on the device (and remembered):
//   Enter PIN  the employee types their private PIN, sees their name, and presses the one
//              button that applies (Time In or Time Out).
//   Scan QR    the employee holds their QR badge up to the camera; the scan IS the stamp
//              (Time In, or Time Out if they are timed in). A handheld USB scanner works too.
// Either way the camera then reads the employee's face, and the server checks it against the
// face HR registered (lib/kioskFace.js): a mismatch is refused twice, then let through and
// flagged for HR. The server takes the time.
//
// Screens: pin (the PIN pad or the camera) -> confirm (PIN only) / face (QR only) -> done /
// info -> back to pin; register (a face, with HR's code). A screen left alone goes back by
// itself, so the next person never sees someone else's name.
//
// There is ONE camera, kept mounted across the screens (it is slow to start): big for the QR
// scan and the face check, small beside the PIN pad.

const PIN_LENGTH = 6;
const CONFIRM_TIMEOUT_MS = 20000;
const DONE_TIMEOUT_MS = 6000;
const SCAN_DONE_MS = 4000;
const FACE_TIMEOUT_MS = 5000;
const SAME_BADGE_IGNORE_MS = 8000; // the same badge still in front of the camera after its stamp

// The four stamps (a shift with a stamped lunch uses all four; others only In and Out).
const STAMPS = {
  in: { button: 'TIME IN', done: 'Timed in', cls: 'is-in', at: (l) => l.time_in_local },
  lunch_out: { button: 'LUNCH OUT', done: 'Out to lunch', cls: 'is-out', at: (l) => l.lunch_out_local },
  lunch_in: { button: 'BACK FROM LUNCH', done: 'Back from lunch', cls: 'is-in', at: (l) => l.lunch_in_local },
  out: { button: 'TIME OUT', done: 'Timed out', cls: 'is-out', at: (l) => l.time_out_local },
};

function stored(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode: just not remembered */ }
}

// "Face does not match… (1 try left)"
function faceMessage(data) {
  const left = data.attempts_left;
  return `${data.error}${left ? ` (${left} ${left === 1 ? 'try' : 'tries'} left)` : ''}`;
}

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
  const [faceBusy, setFaceBusy] = useState(false); // reading the face right now
  const [mode, setMode] = useState(() => stored('kiosk-mode', 'pin'));
  const [facing, setFacing] = useState(() => stored('kiosk-camera', 'user'));
  const [cameraError, setCameraError] = useState('');
  const [faceReady, setFaceReady] = useState(false);
  const [badge, setBadge] = useState(''); // the QR code waiting for its face check
  const [enroll, setEnroll] = useState(null); // { code, employee } while registering a face
  const [enrollCode, setEnrollCode] = useState('');
  const timer = useRef(null);
  const lastScan = useRef({ code: '', at: 0 });
  const wedge = useRef(''); // characters typed by a USB QR scanner
  const video = useRef(null);

  useEffect(() => {
    api.get(`/kiosk/${token}`)
      .then(({ data }) => { setDevice(data); document.title = `Time Clock · ${data.branch_name || data.name}`; })
      .catch((err) => setDeviceError(err.response?.data?.error || 'This time clock cannot reach the server.'));
  }, [token]);

  // Loaded up front: the first face check should not wait for the models.
  useEffect(() => {
    loadFaceModels().then(() => setFaceReady(true)).catch(() => setFaceReady(false));
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const reset = useCallback(() => {
    clearTimeout(timer.current);
    setPin('');
    setWho(null);
    setResult(null);
    setBadge('');
    setEnroll(null);
    setEnrollCode('');
    setScreen('pin');
    setBusy(false);
    setFaceBusy(false);
    setError('');
  }, []);

  const after = useCallback((ms) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(reset, ms);
  }, [reset]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const onVideo = useCallback((v) => { video.current = v; }, []);

  function chooseMode(m) { setMode(m); store('kiosk-mode', m); setError(''); }
  function flipCamera() { const f = facing === 'user' ? 'environment' : 'user'; setFacing(f); store('kiosk-camera', f); }

  async function face() {
    setFaceBusy(true);
    try { return await readFace(video.current, { timeoutMs: FACE_TIMEOUT_MS }); } finally { setFaceBusy(false); }
  }

  // A QR badge: after the face is read, one request identifies, checks the face and stamps.
  const checkBadge = useCallback(async (code) => {
    setBusy(true);
    setError('');
    clearTimeout(timer.current);
    try {
      const { data } = await api.post(`/kiosk/${token}/scan`, { qr: code, face: await face() });
      setResult(data);
      setScreen(STAMPS[data.action] ? 'done' : 'info');
      after(SCAN_DONE_MS);
    } catch (err) {
      const data = err.response?.data;
      if (data?.face_retry) {
        setError(faceMessage(data));
        after(CONFIRM_TIMEOUT_MS);
      } else {
        setError(data?.error || 'Could not record the time. Try again.');
        setScreen('pin');
        setBadge('');
        after(DONE_TIMEOUT_MS); // clears the message for the next person
      }
    } finally {
      lastScan.current = { code, at: Date.now() };
      setBusy(false);
    }
  }, [token, after]); // eslint-disable-line react-hooks/exhaustive-deps

  const scan = useCallback((text) => {
    const code = String(text).trim();
    const t = Date.now();
    if (busy || screen !== 'pin' || (code === lastScan.current.code && t - lastScan.current.at < SAME_BADGE_IGNORE_MS)) return;
    lastScan.current = { code, at: t };
    setBadge(code);
    setScreen('face');
    checkBadge(code);
  }, [busy, screen, checkBadge]);

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
      if (screen === 'register') return; // the code box takes the keys
      if (mode === 'qr') {
        // A USB scanner types the badge's code and presses Enter.
        if (e.key === 'Enter') { if (wedge.current) scan(wedge.current); wedge.current = ''; } else if (e.key.length === 1) wedge.current = (wedge.current + e.key).slice(-80);
        else if (e.key === 'Escape') reset();
        return;
      }
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('back');
      else if (e.key === 'Escape') { if (screen === 'pin') press('clear'); else reset(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press, reset, screen, mode, scan]);

  async function stamp(action = who.action) {
    setBusy(true);
    setError('');
    clearTimeout(timer.current);
    try {
      const { data } = await api.post(`/kiosk/${token}/punch`, { pin, action, face: await face() });
      setResult(data);
      setScreen('done');
      after(DONE_TIMEOUT_MS);
    } catch (err) {
      const data = err.response?.data;
      if (data?.face_retry) {
        setError(faceMessage(data)); // stay on the confirm screen to try again
        after(CONFIRM_TIMEOUT_MS);
      } else {
        setError(data?.error || 'Could not record the time. Try again.');
        setScreen('pin');
        setPin('');
        setWho(null);
      }
    } finally {
      setBusy(false);
    }
  }

  // Face registration with HR's code: the code first (shows whose face it is), then the photos.
  async function startEnroll(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post(`/kiosk/${token}/face-code`, { code: enrollCode });
      setEnroll({ code: enrollCode, employee: data.employee });
    } catch (err) {
      setError(err.response?.data?.error || 'Could not check the code.');
    } finally {
      setBusy(false);
    }
  }

  async function saveEnroll(samples) {
    const { data } = await api.post(`/kiosk/${token}/face-register`, { code: enroll.code, samples, consent: true });
    setEnroll(null);
    setResult({ registered: data.employee });
    setScreen('info');
    after(DONE_TIMEOUT_MS);
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

  const cameraShown = screen === 'pin' || screen === 'confirm' || screen === 'face';
  const cameraSmall = screen === 'confirm' || (screen === 'pin' && mode === 'pin');

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
        <div className="kiosk-modes" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'qr'} className={mode === 'qr' ? 'is-on' : ''} onClick={() => chooseMode('qr')}>Scan QR</button>
          <button type="button" role="tab" aria-selected={mode === 'pin'} className={mode === 'pin' ? 'is-on' : ''} onClick={() => chooseMode('pin')}>Enter PIN</button>
        </div>
      )}

      {/* The one camera: kept mounted (hidden) behind the result screens so it does not
          restart for every person; let go while a face is being registered. */}
      {screen !== 'register' && (
        <div className="kiosk-panel" style={cameraShown ? undefined : { display: 'none' }}>
          {screen === 'pin' && mode === 'qr' && <div className="kiosk-prompt">{busy ? 'Saving…' : 'Hold your QR badge up to the camera'}</div>}
          {screen === 'face' && <div className="kiosk-prompt">{faceBusy ? 'Look at the camera…' : busy ? 'Saving…' : 'Look straight at the camera'}</div>}
          {cameraError ? <div className="kiosk-error">{cameraError}</div> : (
            <QrScanner
              onScan={scan}
              onVideo={onVideo}
              onError={setCameraError}
              paused={busy || screen !== 'pin'}
              scanQr={mode === 'qr' && screen === 'pin'}
              compact={cameraSmall}
              facing={facing}
            />
          )}
          {(screen === 'face' || (screen === 'pin' && mode === 'qr')) && error && <div className="kiosk-error">{error}</div>}
          {screen === 'face' && !busy && (
            <>
              <button type="button" className="kiosk-punch is-in kiosk-punch-sm" onClick={() => checkBadge(badge)}>TRY AGAIN</button>
              <button type="button" className="kiosk-cancel" onClick={reset}>Cancel</button>
            </>
          )}
          {screen === 'pin' && mode === 'qr' && <button type="button" className="kiosk-fullscreen" onClick={flipCamera}>Switch camera</button>}
        </div>
      )}

      {screen === 'pin' && mode !== 'qr' && (
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

      {screen === 'pin' && (
        <button type="button" className="kiosk-link" onClick={() => { setScreen('register'); setError(''); clearTimeout(timer.current); }}>
          Register face{!faceReady && ' · face check loading…'}
        </button>
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
              {who.action !== 'in' && who.open_log && <div className="kiosk-sub">On duty since {formatLocalTime(who.open_log.time_in_local)}</div>}
              {who.action === 'lunch_in' && <div className="kiosk-sub">Out to lunch since {formatLocalTime(who.open_log.lunch_out_local)}</div>}
              {error && <div className="kiosk-error">{error}</div>}
              <button type="button" className={`kiosk-punch ${STAMPS[who.action].cls}`} disabled={busy} onClick={() => stamp()}>
                {faceBusy ? 'Look at the camera…' : busy ? 'Saving…' : STAMPS[who.action].button}
              </button>
              {who.action === 'lunch_out' && (
                <button type="button" className="kiosk-cancel" disabled={busy} onClick={() => stamp('out')}>Time out instead (going home)</button>
              )}
            </>
          )}
          <button type="button" className="kiosk-cancel" disabled={busy} onClick={reset}>{who.action === 'done' ? 'OK' : 'Not me — cancel'}</button>
        </div>
      )}

      {screen === 'register' && (
        <div className="kiosk-panel">
          {!enroll ? (
            <form onSubmit={startEnroll} className="kiosk-panel" style={{ width: '100%' }}>
              <div className="kiosk-prompt">Register a face</div>
              <div className="kiosk-sub">Enter the 6-digit code from the employee&apos;s profile (HR → Employees → Edit → Time Clock Face).</div>
              <input
                className="kiosk-code"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={enrollCode}
                onChange={(e) => setEnrollCode(e.target.value.replace(/\D/g, ''))}
                autoFocus
              />
              {error && <div className="kiosk-error">{error}</div>}
              <button type="submit" className="kiosk-punch is-in kiosk-punch-sm" disabled={busy || enrollCode.length !== 6}>{busy ? 'Checking…' : 'NEXT'}</button>
              <button type="button" className="kiosk-cancel" onClick={reset}>Cancel</button>
            </form>
          ) : (
            <FaceEnroll dark name={`${enroll.employee.name}${enroll.employee.employee_code ? ` · ${enroll.employee.employee_code}` : ''}`} onSave={saveEnroll} onCancel={reset} />
          )}
        </div>
      )}

      {screen === 'info' && result?.registered && (
        <div className="kiosk-panel kiosk-success">
          <div className="kiosk-check">✓</div>
          <div className="kiosk-hello">Face registered</div>
          <div className="kiosk-sub">{result.registered.name} can now time in and out here.</div>
          <button type="button" className="kiosk-cancel" onClick={reset}>Done</button>
        </div>
      )}

      {screen === 'info' && result?.employee && (
        <div className="kiosk-panel">
          <div className="kiosk-hello">Hi, {result.employee.first_name}!</div>
          <div className="kiosk-sub">{result.employee.name}{result.employee.employee_code ? ` · ${result.employee.employee_code}` : ''}</div>
          <div className="kiosk-done-note">
            {result.action === 'recent'
              ? <>Already stamped at {formatLocalTime(result.log.lunch_in_local || result.log.lunch_out_local || result.log.time_in_local)}. No need to scan again.</>
              : <>Already done for today: {formatLocalTime(result.log.time_in_local)} – {formatLocalTime(result.log.time_out_local, result.today.work_date)}</>}
          </div>
          <button type="button" className="kiosk-cancel" onClick={reset}>OK</button>
        </div>
      )}

      {screen === 'done' && result && (
        <div className="kiosk-panel kiosk-success">
          <div className="kiosk-check">✓</div>
          <div className="kiosk-hello">
            {STAMPS[result.action].done} at {formatLocalTime(STAMPS[result.action].at(result.log))}
          </div>
          <div className="kiosk-sub">
            {result.employee.name}
            {(result.action === 'in' || result.action === 'lunch_in') && result.log.late_minutes > 0 && ` · ${formatMinutes(result.log.late_minutes)} late`}
            {(result.action === 'in' || result.action === 'lunch_in') && result.log.halfday_absent && ' · counted as half day absent'}
            {result.action === 'lunch_out' && result.log.scheduled_lunch_end_local && ` · back by ${formatLocalTime(result.log.scheduled_lunch_end_local)}`}
            {result.action === 'out' && ` · worked ${formatMinutes(result.log.worked_minutes) || '0m'}`}
          </div>
          {result.face_verified === false && <div className="kiosk-error">Face not verified — HR will review this stamp.</div>}
          <button type="button" className="kiosk-cancel" onClick={reset}>Done</button>
        </div>
      )}
    </div>
  );
}
