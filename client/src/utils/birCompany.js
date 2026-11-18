// The company the BIR Reports are being prepared for. Each company of the group files under its
// own TIN, so every BIR page works on one company at a time -- or on the whole group when none is
// chosen. Kept in localStorage (not the URL) because the 2307 form opens in a new tab and must stay
// on the same company; api/client.js adds it to every /reports/bir* request.
const KEY = 'bir.companyId';

export function getBirCompanyId() {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
}

export function setBirCompanyId(id) {
  try {
    if (id) localStorage.setItem(KEY, String(id));
    else localStorage.removeItem(KEY);
  } catch { /* storage unavailable: the choice just won't be remembered */ }
}
