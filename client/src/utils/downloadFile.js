import api from '../api/client';

// Fetches a file from the API (with the user's token, which a plain link would not carry) and
// hands it to the browser as a download.
export async function downloadFile(path, params, filename) {
  const res = await api.get(path, { params, responseType: 'blob' });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
