import { useEffect, useRef, useState } from 'react';
import brandMark from '../assets/brand-mark.svg';

const SIZES = { sm: 20, md: 40, lg: 72 };

// How far the estimate is allowed to run before the data actually arrives.
//
// It stops at 95, never 100: the only thing that knows the work is finished is the response
// landing, and a bar that sits at 100% while the page is still blank is the exact failure this is
// meant to avoid. The last five percent are the caller unmounting this component.
const CEILING = 95;
const TICK_MS = 100;

// Progress as an honest estimate.
//
// The reports this sits in front of are ONE blocking request -- the browser knows the request was
// sent and that a response arrived, and nothing whatsoever in between. So a percentage here is a
// prediction against how long this report usually takes, not a measurement, and it is built to
// behave like a prediction:
//
//   * it eases off as it approaches the estimate rather than marching linearly into a wall, so a
//     slightly-slow run still looks like it is moving;
//   * it stops dead at 95% and shows only elapsed seconds once it overruns, because a number that
//     keeps climbing past what it knows is a lie, and "87%" frozen for twenty seconds reads as
//     broken far more than a plain timer does;
//   * elapsed time is always shown alongside, and THAT figure is real.
//
// `expectedMs` is the calibration. Pass the measured typical duration; the default suits a
// several-second report.
function useEstimatedProgress(enabled, expectedMs) {
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAt = useRef(null);

  useEffect(() => {
    if (!enabled) { startedAt.current = null; setElapsedMs(0); return undefined; }
    startedAt.current = Date.now();
    setElapsedMs(0);
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt.current), TICK_MS);
    return () => clearInterval(timer);
  }, [enabled, expectedMs]);

  if (!enabled) return null;

  // 1 - e^(-3t) reaches ~95% of the way at t = expectedMs and never exceeds it, which gives the
  // easing for free: fast early, slower as it nears the estimate, asymptotic past it.
  const ratio = expectedMs > 0 ? elapsedMs / expectedMs : 0;
  const eased = 1 - Math.exp(-3 * ratio);
  const percent = Math.min(CEILING, Math.floor(eased * 100));
  return { percent, elapsedMs, overrun: ratio > 1 };
}

// Used for every page-level and in-flight loading state (initial fetch, saving a
// transaction, navigating between records) -- one shared visual so "the app is working"
// always looks and feels the same. `inline` renders it next to its label (for use inside
// buttons); otherwise it centers itself with the label stacked underneath.
//
// Pass `expectedMs` to add the progress estimate; without it the spinner is exactly what it has
// always been, so no existing caller changes behaviour.
export default function LoadingSpinner({ label = 'Loading...', size = 'md', inline = false, expectedMs = 0 }) {
  // The mark is drawn larger whenever a percentage is shown. At the default 40px the digits land
  // across the coloured ring and are genuinely hard to read; the 72px mark has a hole big enough
  // to hold them, which is the difference between a number and a smudge.
  const showProgress = expectedMs > 0 && !inline;
  const px = showProgress ? SIZES.lg : (SIZES[size] || SIZES.md);
  const progress = useEstimatedProgress(showProgress, expectedMs);
  const mark = <img src={brandMark} alt="" className="loading-spinner-mark" style={{ width: px, height: px }} />;

  if (inline) {
    return (
      <span className="loading-spinner loading-spinner-inline">
        {mark}
        {label && <span>{label}</span>}
      </span>
    );
  }

  const seconds = progress ? Math.floor(progress.elapsedMs / 1000) : 0;

  return (
    <div className="loading-spinner loading-spinner-block">
      <div className="loading-spinner-dial" style={{ width: px, height: px }}>
        {mark}
        {/* Once it has overrun the estimate the percentage is withdrawn rather than frozen on
            screen -- at that point elapsed seconds is the only figure still telling the truth. */}
        {progress && !progress.overrun && (
          <span className="loading-spinner-percent" aria-hidden="true">
            {/* Inner span carries an opaque chip: the mark rotates AND scales under the text, so
                without it the digits sit on a moving two-tone background. */}
            <span>{progress.percent}%</span>
          </span>
        )}
      </div>
      {label && (
        <p className="muted">
          {label}
          {progress && (
            <span className="loading-spinner-elapsed">
              {progress.overrun ? ` ${seconds}s — taking longer than usual` : ` · ${seconds}s`}
            </span>
          )}
        </p>
      )}
      {progress && (
        <div
          className="loading-spinner-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          // Announced as indeterminate once it overruns, which is what it has become.
          aria-valuenow={progress.overrun ? undefined : progress.percent}
          aria-valuetext={progress.overrun ? `Still working, ${seconds} seconds elapsed` : `About ${progress.percent} percent`}
        >
          <span style={{ width: `${progress.percent}%` }} />
        </div>
      )}
    </div>
  );
}
