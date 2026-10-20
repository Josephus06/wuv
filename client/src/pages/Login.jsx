import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/useAuth';
import { Capacitor } from '@capacitor/core';
import { COMPANY } from '../config/company';

const TIMECLOCK_APK = '/downloads/wvi-timeclock.apk';

// The company's own product-showcase graphics (Room Nameplates, Yearbooks, Booth
// Fabrication, Acrylic Medals) -- faded into a 2x2 collage behind the sign-in card
// rather than shown at full strength, since each one individually is a busy ad graphic
// with its own logo/CTA baked in.
const COLLAGE_IMAGES = [
  '/login-collage/1-room-nameplates.jpg',
  '/login-collage/2-yearbooks.jpg',
  '/login-collage/3-booth-fabrication.jpg',
  '/login-collage/4-acrylic-medals.jpg',
];

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(username, password);
      navigate('/dashboard');
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page-v2">
      <form className="login-card-v2" onSubmit={handleSubmit}>
        <div className="login-card-v2-inner">
          <h1>Sign In</h1>
          {error && <div className="error-banner">{error}</div>}

          <div className="login-field-v2">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 4-6 8-6s8 2 8 6" /></svg>
            <input
              placeholder="Username or e-mail"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              required
            />
          </div>
          <div className="login-field-v2">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          <button className="login-submit-v2" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>

          {/* The employee Time Clock app (timeclock/), served from client/public/downloads.
              Not offered inside the ERP's own Android build -- that is already an app, and
              an APK download from inside a WebView goes nowhere useful. */}
          {!Capacitor.isNativePlatform() && (
            <a className="login-app-link" href={TIMECLOCK_APK} download="WVI-TimeClock.apk">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="6" y="2" width="12" height="20" rx="2.5" />
                <path d="M12 7v7M9 11l3 3 3-3M10 18h4" />
              </svg>
              <span>
                <strong>Time Clock app for employees</strong>
                <small>Download for Android · 4.9 MB</small>
              </span>
            </a>
          )}
        </div>
      </form>

      <div className="login-photo-panel">
        <div className="login-collage">
          {COLLAGE_IMAGES.map((src) => (
            <div key={src} className="login-collage-cell" style={{ backgroundImage: `url('${src}')` }} />
          ))}
        </div>
        <div className="login-photo-caption">
          <div className="login-photo-caption-main">{COMPANY.name}</div>
          <div className="login-photo-caption-sub">{COMPANY.tagline}</div>
        </div>
      </div>

    </div>
  );
}
