import { useEffect, useRef } from 'react';
import jsQR from 'jsqr';

// The device camera, reading QR codes: calls onScan(text) for each code it sees. The browser's
// own BarcodeDetector is used where it exists (Android Chrome), jsQR everywhere else (Windows
// Chrome has none). The camera needs HTTPS, which the live site has.
//
// `paused` stops reading (not the camera) while the kiosk shows a result, so the camera does
// not have to start again for the next person.

const SCAN_EVERY_MS = 180;
const MAX_WIDTH = 640; // frames are scaled down before jsQR reads them: faster, and enough

function cameraMessage(err) {
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser cannot use the camera here. Open the time clock link in Chrome (on https).';
  if (err?.name === 'NotAllowedError') return 'Camera access was blocked. Allow the camera for this site in the browser settings, then reload.';
  if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') return 'No camera found on this device.';
  if (err?.name === 'NotReadableError') return 'The camera is being used by another app. Close it and reload.';
  return 'Could not start the camera.';
}

export default function QrScanner({ onScan, onError, paused = false, facing = 'user' }) {
  const video = useRef(null);
  const onScanRef = useRef(onScan);
  const pausedRef = useRef(paused);
  onScanRef.current = onScan;
  pausedRef.current = paused;

  useEffect(() => {
    let stream = null;
    let timer = null;
    let stopped = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let detector = null;
    try {
      if ('BarcodeDetector' in window) detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    } catch { detector = null; }

    async function read(v) {
      if (detector) {
        try {
          const codes = await detector.detect(v);
          return codes[0]?.rawValue || null;
        } catch { detector = null; } // fall through to jsQR from now on
      }
      const scale = Math.min(1, MAX_WIDTH / v.videoWidth);
      canvas.width = Math.round(v.videoWidth * scale);
      canvas.height = Math.round(v.videoHeight * scale);
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data || null;
    }

    async function tick() {
      if (stopped) return;
      const v = video.current;
      if (v && !pausedRef.current && v.readyState >= 2 && v.videoWidth) {
        try {
          const text = await read(v);
          if (text && !stopped && !pausedRef.current) onScanRef.current(text);
        } catch { /* a bad frame; try the next one */ }
      }
      timer = setTimeout(tick, SCAN_EVERY_MS);
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      onError?.(cameraMessage(null));
      return undefined;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then((s) => {
        if (stopped) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        video.current.srcObject = s;
        video.current.play().catch(() => {});
        onError?.('');
        tick();
      })
      .catch((err) => onError?.(cameraMessage(err)));

    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [facing, onError]);

  return (
    <div className="qr-scanner">
      {/* The front camera is mirrored, like a mirror: moving the badge left moves it left. */}
      <video ref={video} className={facing === 'user' ? 'is-mirrored' : ''} playsInline muted />
      <div className="qr-scanner-frame" />
    </div>
  );
}
