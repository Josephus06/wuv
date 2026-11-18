// Transaction detail for months up to the cut-over, read live from the source system: T1S holds
// those months only as the source's per-account figures (lib/openingBalances.js), so the documents
// behind an amount are asked of the source itself -- get_transaction_ledgers, per account and
// department, exactly as its own department income statement drills down. Read-only on the source.
// Needs LIVE_SITE_USERNAME / LIVE_SITE_PASSWORD in the server's .env.
// The old system's address (LIVE_SITE_URL). Only consulted when opening balances are loaded and
// LIVE_SITE_USERNAME / LIVE_SITE_PASSWORD are set; neither is the case on a fresh install.
const SITE = (process.env.LIVE_SITE_URL || '').replace(/\/+$/, '');
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

let sourceToken = null; let sourceTokenAt = 0;
async function sourceLogin() {
  if (sourceToken && Date.now() - sourceTokenAt < 20 * 60 * 1000) return sourceToken;
  if (!process.env.LIVE_SITE_USERNAME || !process.env.LIVE_SITE_PASSWORD) {
    throw Object.assign(new Error('Transactions for months before the cut-over come from the old system, and this server has no login for it (LIVE_SITE_USERNAME / LIVE_SITE_PASSWORD).'), { status: 503 });
  }
  const r = await fetch(`${SITE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.LIVE_SITE_USERNAME, password: process.env.LIVE_SITE_PASSWORD }),
  });
  sourceToken = (await r.json())?.data?.token; sourceTokenAt = Date.now();
  if (!sourceToken) throw Object.assign(new Error('Could not log in to the old system.'), { status: 502 });
  return sourceToken;
}

// One account's ledger lines in one source department over [from, to]. coa: a source_coa_keys row;
// deptPk: source_dept_keys.dept_pk (may be null). -> [{ date, document, memo, name, debit, credit, amount }]
async function departmentLedger({ coa, department, deptPk, from, to }) {
  const token = await sourceLogin();
  const body = {
    coa_pk: coa.coa_pk, coa_code: coa.account_code, coa_title: coa.title, side: coa.side,
    locdept: { type: 'Department', name: department, pk: deptPk || null }, dateFilter: [from, to],
  };
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 60000);
  try {
    const r = await fetch(`${SITE}/api/get_transaction_ledgers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body), signal: ctl.signal,
    });
    const j = await r.json();
    if (!j?.success) throw new Error(j?.message || 'the old system returned no ledger');
    const out = [];
    for (const t of (j.data?.[0] || [])) {
      const dr = Number(t.DRAmount_LdgrEntries) || 0; const cr = Number(t.CRAmount_LdgrEntries) || 0;
      if (!dr && !cr) continue;
      out.push({
        date: t.DateCreated_TransH, document: t.UserPK_TransH, memo: t.Memo_TransH,
        name: t.Name_Cust || t.Name_Accnt || t.Name_Empl || t.name || null,
        debit: round2(dr), credit: round2(cr), amount: round2(dr - cr),
      });
    }
    return out;
  } finally { clearTimeout(timer); }
}

// The source's chart of accounts and locations, read once and kept for an hour: the Balance Sheet
// drill-down needs any account's source key (source_coa_keys holds only the income-statement ones)
// and the list of locations to ask about.
let coaCache = null; let locCache = null; let cacheAt = 0;
async function sourceLookups() {
  if (coaCache && Date.now() - cacheAt < 60 * 60 * 1000) return { coa: coaCache, locations: locCache };
  const token = await sourceLogin();
  const post = async (ep, body) => {
    const r = await fetch(`${SITE}/api/${ep}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(300000) });
    const j = await r.json();
    return Array.isArray(j?.data?.[0]) ? j.data[0] : (Array.isArray(j?.data) ? j.data : []);
  };
  const coa = new Map();
  for (let off = 0; off < 5000; off += 200) {
    const rows = await post('get_chart_of_accounts', { searchKey: '', limit: 200, offset: off });
    for (const c of rows) if (c.UserPK_COA) coa.set(String(c.UserPK_COA), { coa_pk: c.SysPK_COA, title: c.Title_COA });
    if (rows.length < 200) break;
  }
  const locations = (await post('get_locations', { searchKey: '', limit: 500, offset: 0 }))
    .map((l) => ({ pk: l.SysPK_Loc, name: l.Name_Loc }));
  coaCache = coa; locCache = locations; cacheAt = Date.now();
  return { coa, locations };
}

// One account's WHOLE ledger over [from, to], every location. Asked location by location, plus
// lines carrying none: the source will not scan an account unfiltered (it times out after five
// minutes), but one location at a time answers in about a second. side: 'DEBIT' | 'CREDIT'.
// -> [{ date, document, memo, name, debit, credit, amount, location }]
async function accountLedger({ accountCode, side, from, to }) {
  const { coa, locations } = await sourceLookups();
  const key = coa.get(String(accountCode));
  if (!key) return [];
  const out = [];
  await pool4([...locations, { pk: null, name: null }], async (loc) => {
    const token = await sourceLogin();
    const body = {
      coa_pk: key.coa_pk, coa_code: String(accountCode), coa_title: key.title, side,
      locdept: { type: 'Location', name: loc.name, pk: loc.pk }, dateFilter: [from, to],
    };
    const r = await fetch(`${SITE}/api/get_transaction_ledgers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(120000),
    });
    const j = await r.json();
    if (!j?.success) throw new Error(j?.message || 'the old system returned no ledger');
    for (const t of (j.data?.[0] || [])) {
      const dr = Number(t.DRAmount_LdgrEntries) || 0; const cr = Number(t.CRAmount_LdgrEntries) || 0;
      if (!dr && !cr) continue;
      out.push({
        date: t.DateCreated_TransH, document: t.UserPK_TransH, memo: t.Memo_TransH,
        name: t.Name_Cust || t.Name_Accnt || t.Name_Empl || t.name || null,
        debit: round2(dr), credit: round2(cr), amount: round2(dr - cr), location: loc.name,
      });
    }
  });
  return out;
}

// Runs fn over items, `width` at a time.
async function pool4(items, fn, width = 4) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(width, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

module.exports = { SITE, sourceLogin, departmentLedger, accountLedger, pool4 };
