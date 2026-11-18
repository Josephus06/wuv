// T1S continues the source system's books (src/db/create-opening-balances.js, loaded by
// src/db/load-opening-balances.js). This is the one place reports ask about it.
//
// opening_gl_balances holds the SOURCE's figures as GL lines, one set per date:
//   2025-12-31            every account's closing balance (2025 income/expense closed into RE)
//   each 2026 month-end   that month's ACTIVITY per account, from the source's own trial balances
// up to the cut-over. Summing the rows up to a date gives the source's position at that date.
// T1S computes its own ledger from documents only AFTER the last of them -- its posting rules for
// production, inventory and purchasing did not reproduce the source's (2026 Jan-Sep: T1S showed
// PHP 217.7M profit against the source's 22.1M), while the documents themselves are all migrated.
//
// booksStart() -> null when nothing is loaded (every report then behaves exactly as before),
// otherwise { first: '2025-12-31', asOf: <last source date>, start: <day after it> }. Read per call
// rather than cached so a load takes effect on the next report without a restart.
const pool = require('../db');

const nextDay = (ymd) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

async function booksStart() {
  try {
    const [[r]] = await pool.query(
      "SELECT DATE_FORMAT(MIN(as_of), '%Y-%m-%d') AS first, DATE_FORMAT(MAX(as_of), '%Y-%m-%d') AS last FROM opening_gl_balances",
    );
    if (!r || !r.last) return null;
    return { first: r.first, asOf: r.last, start: nextDay(r.last) };
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return null; // deployed ahead of its schema script
    throw e;
  }
}

// The source's rows dated within [fromDate, toDate] (fromDate optional) as GL lines, shaped like
// the rows lib/glImpact.js getPostedGlLines returns.
async function openingGlLines(toDate, fromDate = null) {
  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(ob.as_of, '%Y-%m-%d') AS as_of, ob.account_code, coa.account_name, ob.debit, ob.credit, ob.note
       FROM opening_gl_balances ob JOIN chart_of_accounts coa ON coa.id = ob.account_id
      WHERE ob.as_of <= ?${fromDate ? ' AND ob.as_of >= ?' : ''}`,
    fromDate ? [String(toDate).slice(0, 10), String(fromDate).slice(0, 10)] : [String(toDate).slice(0, 10)],
  );
  return rows.map((r) => ({
    account_code: r.account_code,
    account_name: r.account_name,
    debit: Number(r.debit) || 0,
    credit: Number(r.credit) || 0,
    entry_date: r.as_of,
    source_type: 'opening_balance',
    source_no: r.as_of.endsWith('-12-31') ? `OPENING-${r.as_of}` : `SOURCE-${r.as_of.slice(0, 7)}`,
    source_id: null,
    memo: r.note || (r.as_of.endsWith('-12-31') ? 'Opening balance carried from the source system' : `Source system activity for ${r.as_of.slice(0, 7)}`),
    location_id: null,
    department_id: null,
  }));
}

// The source's month lines carry no department -- they are its trial balance. For a report broken
// down by department, each one is split by the source's own DEPARTMENT income statement for that
// month (source_dept_account_actuals, db/load-source-dept-actuals.js): one line per department,
// matched to the T1S department of the same name, or keyed `src:<name>` where T1S has none (e.g.
// Quality Assurance). Whatever the split does not cover -- the source's "No Department", a month
// not loaded, a balance-sheet account -- stays on the original line, unassigned, so every account's
// total is exactly what it was.
//
// By LOCATION it is the same, from the source's location income statement (source_loc_account_
// actuals, load-source-dept-actuals.js --by=location): "No Location" stays unassigned, and a source
// location T1S has none of (e.g. Damaged) is keyed `src:<name>`.
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const SPLITS = {
  department: { table: 'source_dept_account_actuals', col: 'source_department', none: 'No Department', t1s: 'SELECT id, name FROM departments', field: 'department_id' },
  location: { table: 'source_loc_account_actuals', col: 'source_location', none: 'No Location', t1s: 'SELECT id, location_name AS name FROM locations', field: 'location_id' },
};
const splitSourceLinesByDepartment = (lines) => splitSourceLines(lines, 'department');
const splitSourceLinesByLocation = (lines) => splitSourceLines(lines, 'location');
async function splitSourceLines(lines, by) {
  const cfg = SPLITS[by];
  const months = new Set();
  for (const l of lines) if (l.source_type === 'opening_balance') months.add(String(l.entry_date).slice(0, 7));
  if (!months.size) return lines;
  let parts = []; let sides = []; let deps = [];
  try {
    [parts] = await pool.query(
      `SELECT year, month, ${cfg.col} AS name, account_code, SUM(amount) AS amount FROM ${cfg.table}
        WHERE CONCAT(year, '-', LPAD(month, 2, '0')) IN (?) GROUP BY year, month, ${cfg.col}, account_code`,
      [[...months]],
    );
    [sides] = await pool.query('SELECT account_code, side FROM source_coa_keys');
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return lines;
    throw e;
  }
  if (!parts.length) return lines;
  [deps] = await pool.query(cfg.t1s);
  const deptId = new Map(deps.map((d) => [normName(d.name), Number(d.id)]));
  const credit = new Set(sides.filter((s) => String(s.side).toUpperCase() === 'CREDIT').map((s) => s.account_code));
  const byKey = new Map(); // "YYYY-MM|code" -> [{ dept, net }]
  for (const p of parts) {
    if (p.name === 'Total' || p.name === cfg.none) continue;
    const k = `${p.year}-${String(p.month).padStart(2, '0')}|${p.account_code}`;
    // The source states each amount on the account's normal side; as debit - credit:
    const net = credit.has(p.account_code) ? -Number(p.amount) : Number(p.amount);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push({ dept: p.name, net });
  }
  // A department reclass inside one month (e.g. 30802: Human Resource +18,909.50, Production-SIGNAGE
  // -18,909.50) nets the account's month to zero, so the loader writes no line for it and there is
  // nothing to split. Give each such month/account a zero line here so its departments still show;
  // the remainder line below keeps the account total unchanged.
  const lineKeys = new Set(lines.filter((l) => l.source_type === 'opening_balance').map((l) => `${String(l.entry_date).slice(0, 7)}|${l.account_code}`));
  const missing = [...byKey.keys()].filter((k) => months.has(k.slice(0, 7)) && !lineKeys.has(k));
  if (missing.length) {
    const [coa] = await pool.query('SELECT account_code, account_name FROM chart_of_accounts WHERE account_code IN (?)', [[...new Set(missing.map((k) => k.slice(8)))]]);
    const nameOf = new Map(coa.map((c) => [String(c.account_code), c.account_name]));
    const monthLine = new Map();
    for (const l of lines) if (l.source_type === 'opening_balance') monthLine.set(String(l.entry_date).slice(0, 7), l);
    for (const k of missing) {
      const code = k.slice(8);
      if (!nameOf.has(code)) continue; // not in the T1S chart: nothing to report it under
      const m = monthLine.get(k.slice(0, 7));
      lines = [...lines, { ...m, account_code: code, account_name: nameOf.get(code), debit: 0, credit: 0, memo: `Source system activity for ${k.slice(0, 7)}` }];
    }
  }
  const out = [];
  for (const l of lines) {
    const split = l.source_type === 'opening_balance' && byKey.get(`${String(l.entry_date).slice(0, 7)}|${l.account_code}`);
    if (!split) { out.push(l); continue; }
    let rest = (Number(l.debit) || 0) - (Number(l.credit) || 0);
    for (const s of split) {
      rest -= s.net;
      out.push({
        ...l, debit: s.net > 0 ? round2(s.net) : 0, credit: s.net < 0 ? round2(-s.net) : 0,
        [cfg.field]: deptId.get(normName(s.dept)) || `src:${s.dept}`,
        // what lib/sourceLedger is asked by, to list the documents (by department only)
        ...(by === 'department' ? { source_department: s.dept } : { source_location: s.dept }),
        memo: `${l.memo} -- ${s.dept}`,
      });
    }
    if (Math.abs(rest) >= 0.005) out.push({ ...l, debit: rest > 0 ? round2(rest) : 0, credit: rest < 0 ? round2(-rest) : 0 });
  }
  return out;
}

// Net balance (debit - credit) of one account from the source's rows up to a date.
async function sourceBalance(accountId, toDate) {
  const [[r]] = await pool.query(
    'SELECT COALESCE(SUM(debit - credit), 0) AS amt FROM opening_gl_balances WHERE account_id = ? AND as_of <= ?',
    [accountId, String(toDate).slice(0, 10)],
  );
  return Number(r.amt) || 0;
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// The customer (AR) or supplier (AP) documents that were open at the books start, each reduced by
// whatever T1S has settled against it SINCE then -- a 2026 payment or credit memo applied to the
// invoice / bill it links to. An opening item with no T1S document to link to (a journal, a bill
// that was never migrated) keeps its opening balance until it is dealt with.
//
// Returned in the same shape lib/arAging.js / lib/apAging.js build their open items, so the
// agings just append them after dropping their own pre-start documents.
const SIDES = {
  ar: {
    table: 'opening_ar_items', party: 'customer_id', partyTable: 'customers', link: 'sales_invoice_id', linkType: 'Invoice',
    settled: `SELECT x.id, SUM(x.amt) AS amt FROM (
                SELECT cpl.sales_invoice_id AS id, cpl.applied_amount AS amt
                  FROM customer_payment_lines cpl JOIN customer_payments cp ON cp.id = cpl.customer_payment_id
                 WHERE cpl.sales_invoice_id IN (?) AND cp.status != 'voided' AND cp.date_created >= ? AND cp.date_created <= ?
                UNION ALL
                SELECT cma.sales_invoice_id, cma.applied_amount
                  FROM credit_memo_applications cma JOIN credit_memos cm ON cm.id = cma.credit_memo_id
                 WHERE cma.sales_invoice_id IN (?) AND cm.status != 'voided' AND cm.date_created >= ? AND cm.date_created <= ?
              ) x GROUP BY x.id`,
  },
  ap: {
    table: 'opening_ap_items', party: 'supplier_id', partyTable: 'suppliers', link: 'vendor_bill_id', linkType: 'Bill',
    settled: `SELECT x.id, SUM(x.amt) AS amt FROM (
                SELECT bpl.vendor_bill_id AS id, bpl.applied_amount AS amt
                  FROM bill_payment_lines bpl JOIN bill_payments bp ON bp.id = bpl.bill_payment_id
                 WHERE bpl.vendor_bill_id IN (?) AND bp.status != 'voided' AND bp.date_created >= ? AND bp.date_created <= ?
                UNION ALL
                SELECT bca.vendor_bill_id, bca.applied_amount
                  FROM bill_credit_applications bca JOIN bill_credits bc ON bc.id = bca.bill_credit_id
                 WHERE bca.vendor_bill_id IN (?) AND bc.status != 'voided' AND bc.date_created >= ? AND bc.date_created <= ?
              ) x GROUP BY x.id`,
  },
};

// Which snapshot of open items a given aging date starts from: the latest one ON OR BEFORE it.
// Two are loaded for the cut-over -- the source's aging at 2025-12-31 (the books opening) and at
// 2026-09-30 (the day before staff moved to T1S). Bill payments migrated from the source mostly do
// not say which bills they paid, so a 2025-12-31 bill can never be settled by 2026 source data; the
// 2026-09-30 snapshot is the source's own answer to "what is still open", and from then on every
// payment is entered in T1S against the document it pays. Returns null when there is no snapshot
// at or before the date (history is then read exactly as before).
async function agingAnchor(side, asOf) {
  const table = SIDES[side].table;
  try {
    const [[r]] = await pool.query(`SELECT DATE_FORMAT(MAX(as_of), '%Y-%m-%d') AS as_of FROM ${table} WHERE as_of <= ?`, [String(asOf).slice(0, 10)]);
    if (!r || !r.as_of) return null;
    const d = new Date(`${r.as_of}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return { asOf: r.as_of, start: d.toISOString().slice(0, 10) };
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return null;
    throw e;
  }
}

// Whether the opening item tables carry location_id yet (db/add-opening-item-location.js). Read
// once per table: an install deployed ahead of the migration keeps the old behaviour.
const hasLocation = new Map();
async function openingHasLocation(table) {
  if (!hasLocation.has(table)) {
    const [c] = await pool.query(`SHOW COLUMNS FROM ${table} LIKE 'location_id'`);
    if (c.length) hasLocation.set(table, true); else return false; // re-checked until the migration lands
  }
  return true;
}

async function openingItems(side, asOf, books, { partyId, nameStarts, locationId, noLocation } = {}) {
  const s = SIDES[side];
  const withLoc = await openingHasLocation(s.table);
  // Each opening item carries the office location the source gave its document (AR from the
  // source's aging, AP from the linked bill), so a report narrowed to a location keeps its own.
  // Before that column exists every item is location-less: a location filter has none of them,
  // "No Location" has all of them.
  if (locationId && !withLoc) return [];
  const where = ['o.as_of = ?'];
  const params = [books.asOf];
  if (withLoc && locationId) { where.push('o.location_id = ?'); params.push(locationId); }
  if (withLoc && noLocation) where.push('o.location_id IS NULL');
  if (partyId) { where.push(`o.${s.party} = ?`); params.push(partyId); }
  if (nameStarts) { where.push('COALESCE(p.name, o.' + (side === 'ar' ? 'customer_name' : 'supplier_name') + ') LIKE ?'); params.push(`${nameStarts}%`); }
  const nameCol = side === 'ar' ? 'customer_name' : 'supplier_name';
  const [rows] = await pool.query(
    `SELECT o.*, COALESCE(p.name, o.${nameCol}) AS party_name${withLoc ? ', loc.location_name' : ''}
       FROM ${s.table} o LEFT JOIN ${s.partyTable} p ON p.id = o.${s.party}
       ${withLoc ? 'LEFT JOIN locations loc ON loc.id = o.location_id' : ''}
      WHERE ${where.join(' AND ')}`, params,
  );
  const linked = rows.map((r) => r[s.link]).filter(Boolean);
  const settledBy = new Map();
  if (linked.length) {
    try {
      const [st] = await pool.query(s.settled, [linked, books.start, asOf, linked, books.start, asOf]);
      for (const r of st) settledBy.set(r.id, Number(r.amt) || 0);
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e; // e.g. an install without bill credit applications
    }
  }
  // OPENING PAYMENTS APPLIED AFTER THE SNAPSHOT. A payment the snapshot lists as Unapplied Payment
  // was unapplied when it was taken, so any application of it was made afterwards -- whatever the
  // payment's own date. Those dates are before the books start, so the settlement query above never
  // sees them, and both sides stayed open: INV-83203 (204.10) beside PAY-60698 (-204.10), dated
  // 2026-09-29 and applied to it after the 2026-09-30 snapshot -- 515 invoices, 5.3M, as of
  // 2026-10-05. The customer's total was right; its open items were not.
  //   - an opening invoice is reduced by what an opening payment applied to it;
  //   - an opening payment is reduced by what it applied to an opening invoice or to one raised
  //     since the books start (whose own side lib/arAging.js already settles from the line).
  // Applications to other pre-start invoices are left out: those were made before the snapshot,
  // which already nets them.
  const fromOpeningPayment = new Map(); // invoice id -> amount
  const openingPaymentUsed = new Map(); // payment no -> amount
  if (side === 'ar') {
    const payNos = rows.filter((r) => r.doc_type === 'Unapplied Payment' && r.doc_no).map((r) => r.doc_no);
    if (payNos.length) {
      const [apps] = await pool.query(
        `SELECT cp.customer_payment_no AS pay_no, cpl.sales_invoice_id AS invoice_id, SUM(cpl.applied_amount) AS amt,
                MAX(oi.id IS NOT NULL) AS opening_invoice
           FROM customer_payment_lines cpl
           JOIN customer_payments cp ON cp.id = cpl.customer_payment_id
           JOIN sales_invoices si ON si.id = cpl.sales_invoice_id
           LEFT JOIN opening_ar_items oi ON oi.as_of = ? AND oi.sales_invoice_id = cpl.sales_invoice_id
          WHERE cp.customer_payment_no IN (?) AND cp.status != 'voided' AND si.status != 'cancelled'
            AND (oi.id IS NOT NULL OR si.date_created >= ?)
          GROUP BY cp.customer_payment_no, cpl.sales_invoice_id`,
        [books.asOf, payNos, books.start],
      );
      for (const a of apps) {
        const amt = Number(a.amt) || 0;
        if (Number(a.opening_invoice)) fromOpeningPayment.set(a.invoice_id, (fromOpeningPayment.get(a.invoice_id) || 0) + amt);
        openingPaymentUsed.set(a.pay_no, (openingPaymentUsed.get(a.pay_no) || 0) + amt);
      }
    }
    // OPENING CREDIT MEMOS, the same way (2026-10-20): a memo the snapshot lists as still open was
    // unapplied when it was taken, so its application came afterwards, whatever the memo's own date.
    // INV-83461 (17,920.00) kept 320.00 open beside CM-5467 (-320.00), dated 2026-09-29 and applied to
    // it after the 2026-09-30 snapshot, though PAY-60689 and CM-5467 had settled it in full.
    const memoNos = rows.filter((r) => r.doc_type === 'Credit Memo' && r.doc_no).map((r) => r.doc_no);
    if (memoNos.length) {
      try {
        const [apps] = await pool.query(
          `SELECT cm.credit_memo_no AS memo_no, cma.sales_invoice_id AS invoice_id, SUM(cma.applied_amount) AS amt,
                  MAX(oi.id IS NOT NULL) AS opening_invoice
             FROM credit_memo_applications cma
             JOIN credit_memos cm ON cm.id = cma.credit_memo_id
             JOIN sales_invoices si ON si.id = cma.sales_invoice_id
             LEFT JOIN opening_ar_items oi ON oi.as_of = ? AND oi.sales_invoice_id = cma.sales_invoice_id
            WHERE cm.credit_memo_no IN (?) AND cm.status != 'voided' AND si.status != 'cancelled'
              AND (oi.id IS NOT NULL OR si.date_created >= ?)
            GROUP BY cm.credit_memo_no, cma.sales_invoice_id`,
          [books.asOf, memoNos, books.start],
        );
        for (const a of apps) {
          const amt = Number(a.amt) || 0;
          if (Number(a.opening_invoice)) fromOpeningPayment.set(a.invoice_id, (fromOpeningPayment.get(a.invoice_id) || 0) + amt);
          openingPaymentUsed.set(a.memo_no, (openingPaymentUsed.get(a.memo_no) || 0) + amt);
        }
      } catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; }
    }
  }

  const out = [];
  for (const r of rows) {
    let settled = r[s.link] ? (settledBy.get(r[s.link]) || 0) + (fromOpeningPayment.get(r[s.link]) || 0) : 0;
    // A payment's credit is negative; what it has since applied brings it back toward zero, never past.
    if (['Unapplied Payment', 'Credit Memo'].includes(r.doc_type) && openingPaymentUsed.has(r.doc_no)) {
      settled = -Math.min(openingPaymentUsed.get(r.doc_no), Math.abs(Number(r.balance)));
    }
    const balance = round2(Number(r.balance) - settled);
    if (Math.abs(balance) < 0.005) continue;
    out.push({
      party_id: r[s.party], party_name: r.party_name,
      type: r.doc_type, reference: r.doc_no, id: r[s.link] || null,
      date: r.doc_date ? String(r.doc_date).slice(0, 10) : books.asOf,
      due_date: r.due_date ? String(r.due_date).slice(0, 10) : null,
      original_amount: round2(r.original_amount), balance,
      location_name: r.location_name || null,
      // The source document's own details, where add-opening-ar-item-details.js has loaded them
      // (undefined before that column exists, which the AR report reads as "not loaded").
      memo: r.memo ?? null, po_no: r.po_no ?? null, bs_no: r.bs_no ?? null,
      src_location: r.src_location, sales_rep: r.sales_rep ?? null,
      opening: true,
    });
  }
  return out;
}

module.exports = { booksStart, openingGlLines, splitSourceLinesByDepartment, splitSourceLinesByLocation, sourceBalance, openingItems, agingAnchor };
