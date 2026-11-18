// Speech INPUT -- the listening half. The speaking half is in notificationSound.js.
//
// Web Speech API, the same one behind Chrome's own dictation. Nothing is bundled and no audio
// service is paid for, but unlike speech synthesis this is NOT local: Chrome streams the audio to
// Google to transcribe it. That is worth knowing before turning the wake word on in a room where
// confidential things are said out loud, and it is why the wake word is off until somebody asks
// for it rather than on by default.
//
// TWO LIMITS THAT DECIDE WHERE THIS WORKS AT ALL:
//   - Chrome and Edge only. Firefox has no SpeechRecognition and Safari's is unreliable.
//   - A secure context. https://gsuite.graphicstar.ph is fine; http://192.168.0.175:4000 is not,
//     and the browser refuses silently there unless something explains why.
//
// ONE RECOGNISER AT A TIME. Chrome allows a single live recognition per page: starting a second
// kills the first, and the dead one still fires its own onend, which is how a naive wake-word loop
// ends up fighting the push-to-talk button. Everything here goes through `active` for that reason.

const Recognition = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null;

export function voiceSupported() {
  return Boolean(Recognition) && typeof window !== 'undefined' && window.isSecureContext;
}

// Said in the UI instead of a mic button that does nothing when pressed.
export function voiceUnavailableReason() {
  if (!Recognition) return 'This browser cannot listen. Voice needs Chrome or Edge.';
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return 'Voice needs a secure (https) address. Open the site by its https name rather than its IP.';
  }
  return null;
}

// The error codes worth turning into something a person can act on. The rest are transient.
const FATAL = {
  'not-allowed': 'The microphone is blocked. Allow it in the browser address bar, then try again.',
  'service-not-allowed': 'The microphone is blocked by this device\'s settings.',
  'audio-capture': 'No microphone was found.',
};

let active = null;

// `deliberate` is the difference between "Chrome stopped listening" and "we stopped it". Both fire
// onend, and only the first is a reason to start again -- without the flag, shutting one recogniser
// down to start another schedules a restart of the one being replaced, which schedules another,
// and the microphone ends up cycling every few hundred milliseconds for the rest of the session.
function retire(rec) {
  if (!rec) return;
  rec.deliberate = true;
  try { rec.abort(); } catch { /* already gone */ }
}

function stopActive() {
  if (!active) return;
  const r = active;
  active = null;
  retire(r);
}

// A single question. Starts listening, reports what it hears as it hears it, and finishes on the
// first final result or when the speaker stops.
//
// Returns a cancel function -- the caller needs it because the mic button doubles as a stop
// button, and because navigating away while the mic is live leaves the browser's recording
// indicator on.
export function listenOnce({ onPartial, onResult, onError, onEnd, lang = 'en-US' } = {}) {
  if (!voiceSupported()) {
    onError?.(voiceUnavailableReason());
    onEnd?.();
    return () => {};
  }
  stopActive();

  const rec = new Recognition();
  rec.lang = lang;
  rec.continuous = false;
  // Interim results are what make the button feel alive; without them the box stays empty for
  // several seconds and everyone says the word again, louder.
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  let settled = false;
  rec.onresult = (event) => {
    let finalText = '';
    let partial = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const r = event.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else partial += r[0].transcript;
    }
    if (partial) onPartial?.(partial.trim());
    if (finalText.trim()) {
      settled = true;
      onResult?.(finalText.trim());
      // Stop rather than abort: abort discards the result we have just accepted.
      try { rec.stop(); } catch { /* it is ending anyway */ }
    }
  };
  rec.onerror = (e) => {
    // `aborted` is what a deliberate cancel raises -- not something to report as a failure.
    if (e.error === 'aborted' || e.error === 'no-speech') return;
    onError?.(FATAL[e.error] || `The microphone stopped (${e.error}).`);
  };
  rec.onend = () => {
    if (active === rec) active = null;
    if (!settled) onPartial?.('');
    // A deliberate cancel counts as settled: pressing stop is not the same as being misheard, and
    // reporting "I did not catch that" to someone who just changed their mind is nonsense.
    onEnd?.(settled || Boolean(rec.deliberate));
  };

  active = rec;
  try {
    rec.start();
  } catch (err) {
    active = null;
    onError?.(`The microphone would not start (${err.message}).`);
    onEnd?.(false);
    return () => {};
  }
  return () => { if (active === rec) active = null; retire(rec); };
}

// The wake word is "Tetel", said on its own -- no "hey" needed, though one is allowed.
//
// NEAR-MISSES ARE DELIBERATE. "Tetel" is not an English word, so the transcriber reaches for the
// nearest one it knows and hands back "tattle", "petal", "tetta". Demanding the exact spelling
// makes the feature look broken rather than making it precise.
//
// WHAT IS DELIBERATELY *NOT* HERE: "total", "title" and "detail". All three are close enough to be
// tempting, and all three are said constantly in an accounting office -- "what's the total",
// "the detail is wrong". Accepting them would have the assistant barging into conversations all
// day, which is the fastest way for everyone to switch the microphone off for good.
const WAKE = /\b(?:(?:hey|hi|ok|okay)[,]?\s+)?(tetel|tetell|tetl|tetle|tettel|tatel|tattel|tattle|tetal|tetta|teta|petal|pedal|tito|titol)\b/i;

export function isWakePhrase(text) {
  return WAKE.test(String(text || ''));
}

// Anything said after the wake phrase in the same breath -- "hey Jot, how many estimates today".
// Sending that straight through saves a second round of listening, which is the difference
// between the assistant feeling quick and feeling like a phone menu.
export function afterWakePhrase(text) {
  const m = String(text || '').match(WAKE);
  if (!m) return '';
  return String(text).slice(m.index + m[0].length).replace(/^[\s,.!?]+/, '').trim();
}

// Listens in the background for the wake phrase and nothing else.
//
// Chrome ends a continuous recognition on its own -- after a stretch of silence, when the tab is
// hidden, when the network hiccups -- so staying on means restarting on every end. The restart is
// delayed and backs off, because a recogniser that fails instantly (no microphone, permission
// withdrawn) would otherwise be restarted thousands of times a minute.
export function wakeWordListener({ onWake, onError, lang = 'en-US' } = {}) {
  if (!voiceSupported()) {
    onError?.(voiceUnavailableReason());
    return { stop() {}, pause() {}, resume() {} };
  }

  let stopped = false;
  let paused = false;
  let rec = null;
  let timer = null;
  let failures = 0;

  const schedule = (ms) => {
    clearTimeout(timer);
    if (stopped || paused) return;
    timer = setTimeout(start, ms);
  };

  function start() {
    if (stopped || paused) return;
    retire(rec);
    stopActive();
    rec = new Recognition();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const said = event.results[i][0].transcript;
        if (!isWakePhrase(said)) continue;
        failures = 0;
        // Hand over the whole utterance: the caller decides whether the question came with it.
        onWake?.(said.trim(), event.results[i].isFinal);
        return;
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (FATAL[e.error]) {
        stopped = true;
        onError?.(FATAL[e.error]);
        return;
      }
      failures += 1;
    };
    const self = rec;
    self.onend = () => {
      if (active === self) active = null;
      // Retired on purpose -- replaced, paused or stopped. Restarting it here is what turns one
      // handover into an endless cycle of the microphone stopping and starting.
      if (self.deliberate) return;
      // Backs off to 8s after a run of failures, so a broken microphone costs one restart every
      // few seconds rather than a tight loop that pins a core.
      schedule(failures > 3 ? 8000 : 400);
    };

    active = rec;
    try {
      rec.start();
    } catch {
      failures += 1;
      schedule(1000);
    }
  }

  start();

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      retire(rec);
      if (active === rec) active = null;
    },
    // Held while the assistant is speaking or while a question is being captured. Without this
    // the wake listener transcribes the assistant's own answer and wakes itself up.
    pause() {
      paused = true;
      clearTimeout(timer);
      retire(rec);
      if (active === rec) active = null;
    },
    resume() {
      if (stopped || !paused) return;
      paused = false;
      failures = 0;
      schedule(300);
    },
  };
}
