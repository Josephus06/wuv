// Face reading for the time clock's face check and face registration. face-api (with its
// TensorFlow) is loaded only on the pages that use it, and its models come from
// /face-models (client/public). What leaves the browser is a 128-number descriptor and a
// small JPEG of the face; the server does the matching (server/src/lib/kioskFace.js).

const MODELS = '/face-models';
const MIN_FACE_PX = 70; // a face smaller than this in the frame is too far to trust
const PHOTO_PX = 240;

let loading = null;

export function loadFaceModels() {
  if (!loading) {
    loading = (async () => {
      const faceapi = await import('@vladmandic/face-api');
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODELS),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODELS),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODELS),
      ]);
      return faceapi;
    })().catch((err) => { loading = null; throw err; });
  }
  return loading;
}

// The face, cropped with some margin around it, as a small JPEG data URL.
function snapshot(video, box) {
  const margin = box.width * 0.4;
  const x = Math.max(0, box.x - margin);
  const y = Math.max(0, box.y - margin);
  const w = Math.min(video.videoWidth - x, box.width + margin * 2);
  const h = Math.min(video.videoHeight - y, box.height + margin * 2);
  const scale = Math.min(1, PHOTO_PX / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(video, x, y, w, h, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.75);
}

// A whole-frame JPEG, for when no face was found (HR still sees who stood there).
function frame(video) {
  if (!video?.videoWidth) return null;
  const scale = Math.min(1, 320 / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.7);
}

// Looks for one clear face in the camera for up to `timeoutMs`.
// Returns { descriptor, photo }, or { descriptor: null, photo } when none was found in time.
export async function readFace(video, { timeoutMs = 5000 } = {}) {
  let faceapi;
  try { faceapi = await loadFaceModels(); } catch { return { descriptor: null, photo: frame(video) }; }
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (video?.readyState >= 2 && video.videoWidth) {
      try {
        const found = await faceapi.detectSingleFace(video, options).withFaceLandmarks().withFaceDescriptor();
        if (found && found.detection.box.width >= MIN_FACE_PX) {
          return { descriptor: Array.from(found.descriptor), photo: snapshot(video, found.detection.box) };
        }
      } catch { /* a bad frame; try the next one */ }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { descriptor: null, photo: frame(video) };
}
