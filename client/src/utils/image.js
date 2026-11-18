// Resizes a user-picked image down to a JPEG data URL while KEEPING its aspect ratio -- the
// newsfeed's photos, where a centre-crop to a square would cut the top off a group shot.
// Returns the dimensions alongside the data URL so the feed can reserve the right space before
// the photo has loaded (no layout jump as you scroll).
//
// Same reasoning as fileToSquareDataUrl below for doing it in the browser: the server takes
// plain JSON and never has to handle a multipart upload. 1600px at q0.8 lands around 400KB,
// which is what the API's per-image cap and the 12mb JSON body limit are sized for.
export function fileToDataUrl(file, maxDim = 1600, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const width = Math.max(1, Math.round(img.width * scale));
      const height = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      // A transparent PNG flattened onto nothing turns black once it is JPEG; white matches
      // the card it will sit on.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      resolve({ data_url: canvas.toDataURL('image/jpeg', quality), width, height });
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not read that image file.'));
    };
    img.src = objectUrl;
  });
}

// Resizes/center-crops a user-picked image file down to a small square JPEG data URL
// entirely in the browser (canvas), so the server never has to handle multipart uploads
// or file storage -- the resulting data URL is small enough to send as plain JSON and
// store inline in the DB (see server/src/routes/auth.js's PUT /me/avatar).
// Same idea as fileToSquareDataUrl, but keeps the original aspect ratio and only bounds the
// longest edge -- newsfeed photos are landscape/portrait, not avatars, so center-cropping to a
// square would throw away most of the picture. Result still goes over as a JSON data URL and
// lands in feed_posts.image_data.
export function fileToScaledDataUrl(file, maxEdge = 1280, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not read that image file.'));
    };
    img.src = objectUrl;
  });
}

export function fileToSquareDataUrl(file, size = 240, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2;
      const sy = (img.height - side) / 2;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not read that image file.'));
    };
    img.src = objectUrl;
  });
}
