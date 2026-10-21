// PINs, device links and brute-force protection for the branch time clock.
const crypto = require('crypto');

// PINs are stored as an HMAC rather than a plain hash: a 6-digit PIN has only a million
// possibilities, so an unkeyed hash could be reversed by trying them all. Without the server
// secret, a copy of the employees table reveals nothing. Changing the secret invalidates
// every PIN (HR regenerates them).
function pinSecret() {
  const secret = process.env.KIOSK_PIN_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error('KIOSK_PIN_SECRET or JWT_SECRET must be set');
  return secret;
}

const PIN_RE = /^\d{6}$/;

function pinHash(pin) {
  return crypto.createHmac('sha256', pinSecret()).update(`kiosk-pin:${pin}`).digest('hex');
}

// PINs a person might type by accident or guess first.
function isWeakPin(pin) {
  if (/^(\d)\1{5}$/.test(pin)) return true; // 000000, 111111 ...
  const digits = pin.split('').map(Number);
  const up = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
  const down = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
  return up || down; // 123456, 654321 ...
}

// A random 6-digit PIN no other employee holds. `taken(hash)` checks the database.
async function newPin(taken) {
  for (let i = 0; i < 50; i += 1) {
    const pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    if (isWeakPin(pin)) continue;
    if (!(await taken(pinHash(pin)))) return pin;
  }
  throw new Error('Could not find a free PIN -- try again');
}

// Device links: a long random token in the URL; only its SHA-256 is stored.
function newDeviceToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Wrong-PIN throttle, per device. Five wrong PINs within ten minutes lock that device for
// two minutes: plenty for a fat-fingered employee, far too slow to walk through a million
// PINs. In memory -- the API runs as one process, and a restart forgiving a lockout is
// harmless.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCK_MS = 2 * 60 * 1000;
const failures = new Map(); // key -> { count, first, lockedUntil }

function lockedFor(key, now = Date.now()) {
  const f = failures.get(key);
  if (!f) return 0;
  if (f.lockedUntil && f.lockedUntil > now) return f.lockedUntil - now;
  if (now - f.first > WINDOW_MS) failures.delete(key);
  return 0;
}

function recordFailure(key, now = Date.now()) {
  let f = failures.get(key);
  if (!f || now - f.first > WINDOW_MS) f = { count: 0, first: now, lockedUntil: 0 };
  f.count += 1;
  if (f.count >= MAX_FAILURES) { f.lockedUntil = now + LOCK_MS; f.count = 0; f.first = now; }
  failures.set(key, f);
}

function clearFailures(key) {
  failures.delete(key);
}

module.exports = { PIN_RE, pinHash, isWeakPin, newPin, newDeviceToken, tokenHash, lockedFor, recordFailure, clearFailures, MAX_FAILURES };
