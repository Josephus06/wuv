// Audible notifications: a short chime, then the headline read aloud in a female voice.
//
// Both are generated in the browser -- a WebAudio tone rather than a bundled mp3, and the
// platform's own speech synthesiser rather than a TTS service. Nothing to ship, nothing to
// pay for, and no request leaves the machine to announce a ticket.

const PREF_KEY = 'notifications.sound';

export function soundEnabled() {
  // Defaults ON: someone who has not chosen wants to be told. The toggle in the bell menu
  // writes 'off' the moment they decide otherwise.
  return localStorage.getItem(PREF_KEY) !== 'off';
}

export function setSoundEnabled(on) {
  localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
}

// ---------------------------------------------------------------------------- chime

// Browsers refuse to start audio until the user has interacted with the page, so the context
// is created lazily and resumed on the first interaction.
let ctx = null;
function audioContext() {
  if (ctx) return ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

// Two quick notes, a fifth apart -- recognisable as "something arrived" without being the
// kind of alarm that makes an office look up.
export function chime() {
  const audio = audioContext();
  if (!audio) return;
  if (audio.state === 'suspended') audio.resume();
  const now = audio.currentTime;
  [880, 1320].forEach((freq, i) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    // Shaped rather than switched: an abrupt start and stop on a sine wave clicks.
    gain.gain.setValueAtTime(0, now + i * 0.16);
    gain.gain.linearRampToValueAtTime(0.16, now + i * 0.16 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.16 + 0.28);
    osc.connect(gain).connect(audio.destination);
    osc.start(now + i * 0.16);
    osc.stop(now + i * 0.16 + 0.3);
  });
}

// ---------------------------------------------------------------------------- voice

// Known female voices across Windows, macOS, Android and Chrome's own set. Matched by name
// because the API exposes no gender field at all -- there is nothing else to go on.
const FEMALE_HINTS = /(female|zira|hazel|susan|linda|heera|catherine|samantha|victoria|karen|moira|tessa|fiona|serena|allison|ava|nicky|joanna|salli|kimberly|amy|emma|aria|jenny|michelle|natasha|clara|libby|sonia)/i;

let voices = [];
function refreshVoices() {
  if (!('speechSynthesis' in window)) return;
  voices = window.speechSynthesis.getVoices() || [];
}
if ('speechSynthesis' in window) {
  refreshVoices();
  // Chrome returns an empty list on the first call and fills it asynchronously.
  window.speechSynthesis.addEventListener('voiceschanged', refreshVoices);
}

// Preference order: a female English voice, then any English voice, then whatever exists.
// Never awaited -- see speak() for why picking a voice must not be asynchronous.
function pickVoice() {
  const english = voices.filter((v) => /^en(-|_|$)/i.test(v.lang));
  return english.find((v) => FEMALE_HINTS.test(v.name))
    || voices.find((v) => FEMALE_HINTS.test(v.name))
    || english[0]
    || voices[0]
    || null;
}

export function availableVoice() {
  const v = pickVoice();
  return v ? `${v.name} (${v.lang})` : null;
}

// Chrome will not speak unless the page has been interacted with, and -- the part that is
// easy to miss -- an `await` before speak() breaks the chain from that interaction, so the
// utterance is accepted and silently dropped. Speaking a silent utterance during the first
// real click unlocks the synthesiser for everything afterwards, including speech triggered
// later by a background poll.
let primed = false;
export function primeSpeech() {
  if (primed || !('speechSynthesis' in window)) return;
  primed = true;
  refreshVoices();
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  try { window.speechSynthesis.speak(u); } catch { /* nothing to recover from */ }
  if (ctx?.state === 'suspended') ctx.resume();
}
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', primeSpeech, { once: true });
  window.addEventListener('keydown', primeSpeech, { once: true });
}

// "TICKET-141" is read as "ticket dash one four one" or worse; splitting the hyphen and
// spacing the digits gets "ticket one forty one", which is how someone would say it.
function speakable(text) {
  return String(text || '')
    .replace(/--/g, ',')
    .replace(/([A-Za-z]+)-(\d+)/g, '$1 $2')
    // A job order number is JO-63697-1-1; left alone the tail is read as "dash one dash
    // one", so the separators between digits become spaces too.
    .replace(/(\d)-(?=\d)/g, '$1 ')
    .replace(/\bNSTDJO\b/gi, 'N S T D J O')
    .replace(/\bJO\b/g, 'J O')
    .trim();
}

// Deliberately synchronous. Every await between a user gesture and speak() is a chance for
// the browser to decide this is not user-initiated, which is exactly how the first version
// ended up chiming and then saying nothing.
export function speak(text, onFailure) {
  if (!('speechSynthesis' in window)) { onFailure?.('This browser has no speech synthesiser.'); return; }
  const synth = window.speechSynthesis;
  const say = speakable(text);
  if (!say) return;

  // Only cancel when something is actually queued: cancelling an idle synthesiser leaves
  // Chrome accepting the next utterance and never speaking it.
  if (synth.speaking || synth.pending) synth.cancel();

  const utterance = new SpeechSynthesisUtterance(say);
  utterance.rate = 1;
  utterance.pitch = 1.05; // a touch brighter, which reads as a lighter voice on flatter engines
  utterance.volume = 1;
  utterance.lang = 'en-US';
  const voice = pickVoice();
  if (voice) utterance.voice = voice;
  utterance.onerror = (e) => onFailure?.(`The voice failed to start (${e.error || 'unknown'}).`);
  synth.speak(utterance);
  if (synth.paused) synth.resume();

  // Nothing started and nothing errored is the silent failure this whole file exists to
  // avoid -- say so rather than leaving someone wondering.
  if (onFailure) {
    setTimeout(() => {
      if (!synth.speaking && !synth.pending) {
        onFailure('The browser accepted the voice but did not speak. Click anywhere on the page once, then press Test again.');
      }
    }, 700);
  }
}

// ------------------------------------------------------------------- desktop popup

// The OS-level popup that shows even when this tab is in the background or the window is
// minimised. It cannot fire when the browser itself is closed: that needs a service worker
// and Web Push, which is a different mechanism.
export function desktopNotify({ title, body, onClick }) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  // Only when the page is not being looked at. Duplicating an on-screen toast into an OS
  // popup while the user is staring at the page is just noise.
  if (document.visibilityState === 'visible') return;
  try {
    const n = new Notification(title, { body: body || '', tag: `erp-${title}`, icon: '/favicon.ico' });
    n.onclick = () => { window.focus(); n.close(); onClick?.(); };
  } catch {
    // Some browsers throw when constructing one outside a service worker; the in-page toast
    // and the voice have already done the job.
  }
}

// Asked for once, and only from a real click -- browsers ignore (or permanently block) a
// permission request that is not tied to a user gesture.
export function requestDesktopPermission() {
  if (!('Notification' in window)) return Promise.resolve('unsupported');
  if (Notification.permission !== 'default') return Promise.resolve(Notification.permission);
  return Notification.requestPermission();
}

// The pair, for a batch of new notifications. Only the newest is read: reading five in a row
// takes half a minute, during which nobody can hear the next one.
export function announce(titles, onFailure) {
  if (!soundEnabled() || !titles.length) return;
  chime();
  const [first] = titles;
  const rest = titles.length - 1;
  setTimeout(
    () => speak(rest > 0 ? `${first}. And ${rest} more notification${rest === 1 ? '' : 's'}.` : first, onFailure),
    450,
  );
}
