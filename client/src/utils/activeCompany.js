// The company the whole app is looking at, picked in the topbar's company switcher.
//
//   Wu Venture (none chosen) -> every transaction of every company, the consolidated view
//   Fresh and Tidy           -> only Fresh and Tidy's branches
//   Cuts for Tots            -> only Cuts for Tots' branches
//
// It rides on every API call as an X-Company-Id header (api/client.js); the server scopes every
// list, report and dashboard figure to that company's branches (server/src/lib/requestScope.js).
// It also picks the theme: <html data-company="wu|fnt|c4t"> swaps the primary colour to the
// company's logo colour (styles/companyThemes.css).
const KEY = 'company.active';

export function getActiveCompany() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    return v && Number(v.id) > 0 ? v : null;
  } catch { return null; }
}

export function setActiveCompany(company) {
  try {
    if (company) localStorage.setItem(KEY, JSON.stringify({ id: company.id, name: company.name, code: company.code || '' }));
    else localStorage.removeItem(KEY);
  } catch { /* storage unavailable: the choice lasts only until reload */ }
}

// wu / fnt / c4t -- the logo and colour set of a company (null = Wu Venture, the group).
export function brandKey(company) {
  if (!company) return 'wu';
  const s = `${company.code || ''} ${company.name || ''}`.toLowerCase();
  if (/fresh|tidy|\bfat\b|\bfnt\b/.test(s)) return 'fnt';
  if (/cuts|tots|\bcft\b|\bc4t\b/.test(s)) return 'c4t';
  return 'wu';
}

export function applyCompanyTheme(company = getActiveCompany()) {
  document.documentElement.dataset.company = brandKey(company);
}
