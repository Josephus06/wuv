import { useCallback, useEffect, useRef, useState } from 'react';
import QrScanner from './QrScanner';
import { loadFaceModels, readFace } from '../utils/face';

// Registering an employee's face: the camera, the consent confirmation, three photos taken a
// moment apart, then onSave(samples) -- samples are [{ descriptor, photo }]. Used in the
// employee profile (a PC webcam) and at the branch time clock.

const SAMPLES = 3;

export default function FaceEnroll({ name, onSave, onCancel, dark = false }) {
  const video = useRef(null);
  const [cameraError, setCameraError] = useState('');
  const [ready, setReady] = useState(false);
  const [consent, setConsent] = useState(false);
  const [samples, setSamples] = useState([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    loadFaceModels().then(() => setReady(true)).catch(() => setError('Could not load the face check. Check the internet connection and reload.'));
  }, []);

  const onVideo = useCallback((v) => { video.current = v; }, []);

  async function capture() {
    setBusy(true);
    setError('');
    setSamples([]);
    const taken = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      setStatus(`Photo ${i + 1} of ${SAMPLES}: look at the camera${i ? ', turn your head a little' : ''}…`);
      await new Promise((r) => setTimeout(r, i ? 900 : 300));
      const face = await readFace(video.current, { timeoutMs: 6000 });
      if (!face.descriptor) {
        setError('No clear face seen. Face the camera in good light, close enough to fill the circle, and try again.');
        setStatus('');
        setBusy(false);
        return;
      }
      taken.push(face);
      setSamples([...taken]);
    }
    setStatus('');
    setBusy(false);
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      await onSave(samples);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save the face.');
      setBusy(false);
    }
  }

  return (
    <div className={`face-enroll${dark ? ' is-dark' : ''}`}>
      {name && <div className="face-enroll-name">{name}</div>}
      {cameraError ? <div className="error-banner">{cameraError}</div> : (
        <QrScanner scanQr={false} onVideo={onVideo} onError={setCameraError} facing="user" />
      )}
      {status && <div className="face-enroll-status">{status}</div>}
      {samples.length > 0 && (
        <div className="face-enroll-shots">
          {samples.map((s, i) => <img key={i} src={s.photo} alt={`Photo ${i + 1}`} />)}
        </div>
      )}
      <label className="face-enroll-consent">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        The employee signed the consent form for using their face at the time clock.
      </label>
      {error && <div className="error-banner">{error}</div>}
      <div className="face-enroll-actions">
        {onCancel && <button type="button" className="btn" disabled={busy} onClick={onCancel}>Cancel</button>}
        <button type="button" className="btn" disabled={busy || !ready || !consent || !!cameraError} onClick={capture}>
          {!ready ? 'Loading face check…' : samples.length ? 'Retake Photos' : 'Take Photos'}
        </button>
        <button type="button" className="btn btn-primary" disabled={busy || !consent || samples.length < SAMPLES} onClick={save}>
          Save Face
        </button>
      </div>
    </div>
  );
}
