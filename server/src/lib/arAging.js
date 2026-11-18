const pool = require('../db');
const { agingAnchor, openingItems } = require('./openingBalances');
const { getSbuGroups } = require('./sbuGroups');

// AR Aging (Accounting > Reports > AR Aging). Every customer's outstanding receivable as
// of a date, split into age buckets. Reconstructed point-in-time -- like the four GL
// reports, it never trusts a stored running balance (sales_invoices.amount_due is a live
// figure that can't answer "what was owed last month"); it rebuilds each open item from
// documents dated on or before the as-of date.
//
// What makes up a customer's balance, all signed so positive = the customer owes us:
//   + each non-cancelled Invoice's gross, less the payments and credit-memo applications
//     that had settled it by the as-of date -> its remaining balance, aged by DUE date
//   - each open Credit Memo's still-unapplied remaining (a credit we owe back), aged by
//     the memo's own date
//   - each Customer Payment's unapplied cash (an overpayment sitting on account), aged by
//     the payment's own date
// A credit memo applied to an invoice is a wash on the total -- it lowers the invoice and
// lowers the credit we owe by the same amount -- which is exactly right.
//
// Aging basis: an invoice ages by how far past its DUE date the as-of date is; credits and
// overpayments have no due date, so they age by their document date. Current = not yet due.
//
// MARKED PAID, NOT EVIDENCED. 1,363 invoices (about 1.9% of the 72,314 marked paid_in_full,
// 46.4M gross) carry status = 'paid_in_full' and amount_due = 0 while nothing in this database
// records a payment or credit memo settling them. Because this report derives from documents
// rather than trusting the header -- for the good reasons above -- it counts every one of them
// as outstanding, and the invoice screen says "Paid In Full" on the same document. Two screens,
// two answers, and no way for the reader to tell which is wrong.
//
// So the report now SAYS SO rather than silently picking a side. Such an item still counts in
// the balance -- hiding 46.4M of receivable on the strength of a flag with nothing behind it is
// the one thing that would be worse -- but it is flagged, counted separately, and the customer
// row carries the total, so Accounting gets a worklist instead of a mystery.
//
// It is not one bad migration batch: the affected invoices run 108 in 2021, 134 in 2022, 588 in
// 2023, 133 in 2024, 85 in 2025 and 315 in 2026. The mirror image is 2,143 payments holding
// 10.4M of unapplied cash -- some of these invoices are settled by that money, with the link
// between them never imported.

// How much of a payment is still sitting on account as unapplied cash.
//
// Two sources, because the migration left customer payments in two different states:
//
//   with application lines -> measured from them, as this report always did. This covers the
//     reconstructed CPAY-INV-#### payments generate-invoice-payments.js created, which do
//     carry lines.
//
//   without any lines -> taken from the unapplied_amount the LIVE system itself reported at
//     import time (stored by import-customer-payments.js). The live API exposes no endpoint
//     returning WHICH invoices a payment settled -- see that importer's header -- so ~58,700
//     real PAY-#### payments arrived as headers only. Deriving their unapplied figure from
//     lines that were never imported reported every one of them as 100% unapplied cash: about
//     460M of settled receivable resurfacing as credit, which is what drove customers to large
//     negative balances (23 APPLES INC. showed -901,898.17, exactly the sum of its real
//     payments).
//
// Trusting the header here does not leave an invoice looking unpaid: the invoices those real
// payments settled are already discharged locally by the reconstructed CPAY-INV-#### payments,
// which is precisely why those were generated. It does mean this report cannot say WHICH
// invoice a real payment settled -- that needs the lines themselves, and they do not exist yet.
// An invoice whose header says it is settled. Both signals are checked rather than status
// alone: the migration set them together, and an invoice can be discharged to zero without the
// status keeping up. Either one claiming 'settled' is enough to make silence about a payment
// worth flagging.
function isMarkedPaid(inv) {
  return String(inv.status || '').toLowerCase() === 'paid_in_full'
    || Math.abs(Number(inv.amount_due || 0)) < 0.005;
}

function unappliedCash(payment, cashAppliedFromLines) {
  if (cashAppliedFromLines !== null && cashAppliedFromLines !== undefined) {
    return Number(payment.payment_amount) - Number(cashAppliedFromLines);
  }
  // A header-only payment whose live unapplied figure never came across is treated as fully
  // unapplied, the old behaviour -- better to over-report a credit than to silently drop one.
  if (payment.unapplied_amount === null || payment.unapplied_amount === undefined) {
    return Number(payment.payment_amount);
  }
  return Number(payment.unapplied_amount);
}

function daysBetween(fromStr, toStr) {
  const a = new Date(`${String(fromStr).slice(0, 10)}T00:00:00Z`);
  const b = new Date(`${String(toStr).slice(0, 10)}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

function emptyBuckets() {
  return { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, over_90: 0 };
}

// Drop a signed amount into the bucket for how overdue it is as of the report date.
function addToBucket(buckets, amount, agingDate, asOf) {
  const overdue = daysBetween(agingDate, asOf);
  if (overdue <= 0) buckets.current += amount;
  else if (overdue <= 30) buckets.d1_30 += amount;
  else if (overdue <= 60) buckets.d31_60 += amount;
  else if (overdue <= 90) buckets.d61_90 += amount;
  else buckets.over_90 += amount;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Location scopes the *primary* document (invoice/memo/payment), never its settlements --
// a receivable belongs to wherever it was raised, and paying it from elsewhere doesn't
// move where it's owed. `noLocation` selects documents with no office location at all.
// companyId (Fresh n Tidy, Cuts For Tots ...) takes every branch of that company (locations.company_id).
function locationClause(alias, { locationId, noLocation, companyId }) {
  if (noLocation) return { sql: ` AND ${alias}.office_location_id IS NULL`, params: [] };
  if (locationId) return { sql: ` AND ${alias}.office_location_id = ?`, params: [locationId] };
  if (companyId) return { sql: ` AND ${alias}.office_location_id IN (SELECT id FROM locations WHERE company_id = ?)`, params: [companyId] };
  return { sql: '', params: [] };
}

// EVERY OPEN ITEM AS OF A DATE, in one place.
//
// Both reports built on this file are the same set of facts shown at two grains: AR Aging sums
// these items into buckets per customer, AR Aging Details lists them. They used to be separate
// query sets, which is a standing invitation for a detail report that does not add up to the
// summary it details -- the one thing that makes both useless. So the items are computed once
// here and each report presents them.
//
// The signed convention is the same throughout: positive = the customer owes us.
//
// The display fields (BS #, memo, PO #, location) are along for the ride. They cost nothing on
// queries that were already reading these rows, and the Details report needs them.
async function collectOpenItemsFromDocs(asOf, filters = {}) {
  const { nameStarts, customerId } = filters;
  const nameClause = nameStarts ? ' AND c.name LIKE ?' : '';
  const nameParam = nameStarts ? [`${nameStarts}%`] : [];
  const custClause = customerId ? ' AND c.id = ?' : '';
  const custParam = customerId ? [customerId] : [];

  const invLoc = locationClause('si', filters);
  const [invoices] = await pool.query(
    `SELECT si.id, c.id AS customer_id, c.name AS customer_name, si.date_created, si.date_due, si.gross_amount,
            si.status, si.amount_due, si.invoice_no, si.bs_si_no, si.po_no, si.memo, si.term, si.sales_rep_id,
            si.department_id, loc.location_name, CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep
     FROM sales_invoices si
     LEFT JOIN sales_orders so ON so.id = si.sales_order_id
     LEFT JOIN estimates e ON e.id = si.estimate_id
     LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id
     JOIN customers c ON c.id = COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id)
     LEFT JOIN locations loc ON loc.id = si.office_location_id
     LEFT JOIN employees sr ON sr.id = si.sales_rep_id
     WHERE si.status != 'cancelled' AND si.date_created <= ?${invLoc.sql}${nameClause}${custClause}`,
    [asOf, ...invLoc.params, ...nameParam, ...custParam]
  );

  // Settlements that had landed by the as-of date, summed per invoice. Payments and memos
  // are atomic, so their whole effect counts once the parent document's date has passed.
  const [payToInv] = await pool.query(
    `SELECT cpl.sales_invoice_id AS invoice_id, SUM(cpl.applied_amount) AS amt
     FROM customer_payment_lines cpl
     JOIN customer_payments cp ON cp.id = cpl.customer_payment_id
     WHERE cpl.sales_invoice_id IS NOT NULL AND cp.status != 'voided' AND cp.date_created <= ?
     GROUP BY cpl.sales_invoice_id`,
    [asOf]
  );
  const [memoToInv] = await pool.query(
    `SELECT cma.sales_invoice_id AS invoice_id, SUM(cma.applied_amount) AS amt
     FROM credit_memo_applications cma
     JOIN credit_memos cm ON cm.id = cma.credit_memo_id
     WHERE cm.status != 'voided' AND cm.date_created <= ?
     GROUP BY cma.sales_invoice_id`,
    [asOf]
  );
  const paidByInvoice = new Map(payToInv.map((r) => [r.invoice_id, Number(r.amt)]));
  const creditedByInvoice = new Map(memoToInv.map((r) => [r.invoice_id, Number(r.amt)]));

  const memoLoc = locationClause('cm', filters);
  const [memos] = await pool.query(
    `SELECT cm.id, cm.customer_id, c.name AS customer_name, cm.date_created, cm.gross_amount,
            cm.credit_memo_no, cm.memo, cm.sales_rep_id, loc.location_name,
            -- A memo keeps its sales group on its lines, not its header.
            (SELECT MIN(cml.department_id) FROM credit_memo_lines cml WHERE cml.credit_memo_id = cm.id) AS department_id
     FROM credit_memos cm
     JOIN customers c ON c.id = cm.customer_id
     LEFT JOIN locations loc ON loc.id = cm.office_location_id
     WHERE cm.status != 'voided' AND cm.date_created <= ?${memoLoc.sql}${nameClause}${custClause}`,
    [asOf, ...memoLoc.params, ...nameParam, ...custParam]
  );
  // A memo's remaining credit = its gross, less what it has been applied to invoices and
  // less any payment that has drawn on it.
  const [memoApplied] = await pool.query(
    `SELECT cm.id, COALESCE(SUM(cma.applied_amount), 0) AS amt
     FROM credit_memos cm
     LEFT JOIN credit_memo_applications cma ON cma.credit_memo_id = cm.id
     WHERE cm.status != 'voided' AND cm.date_created <= ?
     GROUP BY cm.id`,
    [asOf]
  );
  const [memoDrawn] = await pool.query(
    `SELECT cpl.credit_memo_id AS memo_id, SUM(cpl.applied_amount) AS amt
     FROM customer_payment_lines cpl
     JOIN customer_payments cp ON cp.id = cpl.customer_payment_id
     WHERE cpl.credit_memo_id IS NOT NULL AND cp.status != 'voided' AND cp.date_created <= ?
     GROUP BY cpl.credit_memo_id`,
    [asOf]
  );
  const appliedByMemo = new Map(memoApplied.map((r) => [r.id, Number(r.amt)]));
  const drawnByMemo = new Map(memoDrawn.map((r) => [r.memo_id, Number(r.amt)]));

  const payLoc = locationClause('cp', filters);
  const [payments] = await pool.query(
    `SELECT cp.id, cp.customer_id, c.name AS customer_name, cp.date_created, cp.payment_amount,
            cp.unapplied_amount, cp.customer_payment_no, cp.memo, cp.or_no, loc.location_name
     FROM customer_payments cp
     JOIN customers c ON c.id = cp.customer_id
     LEFT JOIN locations loc ON loc.id = cp.office_location_id
     WHERE cp.status != 'voided' AND cp.date_created <= ?${payLoc.sql}${nameClause}${custClause}`,
    [asOf, ...payLoc.params, ...nameParam, ...custParam]
  );
  // Only cash applied to invoices consumes a payment; a line drawing a credit moves no
  // cash. What's left over is an overpayment held on account.
  const [payCashApplied] = await pool.query(
    `SELECT cpl.customer_payment_id AS payment_id, SUM(cpl.applied_amount) AS amt
     FROM customer_payment_lines cpl
     JOIN customer_payments cp ON cp.id = cpl.customer_payment_id
     WHERE cpl.sales_invoice_id IS NOT NULL AND cp.status != 'voided' AND cp.date_created <= ?
     GROUP BY cpl.customer_payment_id`,
    [asOf]
  );
  const cashAppliedByPayment = new Map(payCashApplied.map((r) => [r.payment_id, Number(r.amt)]));

  // One row per still-open document. `aging_date` is what the age is measured from and the
  // bucket chosen by: an invoice ages from its DUE date, a credit or an overpayment has no due
  // date and ages from its own.
  const items = [];

  for (const inv of invoices) {
    const settled = (paidByInvoice.get(inv.id) || 0) + (creditedByInvoice.get(inv.id) || 0);
    const remaining = Number(inv.gross_amount) - settled;
    if (Math.abs(remaining) < 0.005) continue;
    items.push({
      customer_id: inv.customer_id, customer_name: inv.customer_name,
      type: 'Invoice', reference: inv.invoice_no, id: inv.id,
      date: inv.date_created, due_date: inv.date_due, aging_date: inv.date_due || inv.date_created,
      original_amount: round2(inv.gross_amount), balance: round2(remaining),
      bs_no: inv.bs_si_no || null, po_no: inv.po_no || null, memo: inv.memo || null,
      location_name: inv.location_name || null, sales_rep: inv.sales_rep || null,
      term: inv.term || null, sales_rep_id: inv.sales_rep_id || null, department_id: inv.department_id || null,
      // The invoice header insists it is settled and nothing in the data agrees. Carried on the
      // item so the customer row can show how much of its balance rests on that disagreement.
      marked_paid_unevidenced: isMarkedPaid(inv) && settled < 0.005,
    });
  }
  for (const cm of memos) {
    const remaining = Number(cm.gross_amount) - (appliedByMemo.get(cm.id) || 0) - (drawnByMemo.get(cm.id) || 0);
    if (remaining < 0.005) continue;
    items.push({
      customer_id: cm.customer_id, customer_name: cm.customer_name,
      type: 'Credit Memo', reference: cm.credit_memo_no, id: cm.id,
      date: cm.date_created, due_date: null, aging_date: cm.date_created,
      original_amount: round2(cm.gross_amount), balance: round2(-remaining),
      bs_no: null, po_no: null, memo: cm.memo || null, location_name: cm.location_name || null,
      sales_rep_id: cm.sales_rep_id || null, department_id: cm.department_id || null,
      marked_paid_unevidenced: false,
    });
  }
  for (const cp of payments) {
    // .has(), not `|| 0` -- only payments that actually have lines appear in this map, so this
    // is what separates "applied nothing" from "its lines were never imported".
    const unapplied = unappliedCash(cp, cashAppliedByPayment.has(cp.id) ? cashAppliedByPayment.get(cp.id) : null);
    if (unapplied < 0.005) continue;
    items.push({
      customer_id: cp.customer_id, customer_name: cp.customer_name,
      type: 'Unapplied Payment', reference: cp.customer_payment_no, id: cp.id,
      date: cp.date_created, due_date: null, aging_date: cp.date_created,
      original_amount: round2(cp.payment_amount), balance: round2(-unapplied),
      // The OR number is the reference a collector actually quotes on the phone, and the memo
      // column is where the real report shows it when the payment carries no memo of its own.
      bs_no: null, po_no: null, memo: cp.memo || (cp.or_no ? `OR# ${cp.or_no}` : null),
      location_name: cp.location_name || null,
      marked_paid_unevidenced: false,
    });
  }

  return items;
}

// Which row an item belongs to: its customer, or -- for an opening item whose source customer
// matched no T1S customer, so carries no customer_id -- its own name. Keyed on the id alone, every
// such item fell into ONE row under whichever name came first (lib/apAging.js has the same rule
// and the case that found it: six unmatched vendors folded into Mandaue Foam on 2026-09-30).
function rowKey(item) {
  return item.customer_id != null ? `id:${item.customer_id}` : `name:${String(item.customer_name || '').trim().toUpperCase()}`;
}

// Per Term and per Account Officer (asked 2026-10-13) go by each INVOICE's own term and sales rep
// -- the customer record's are almost all blank (no customer has an Account Officer; 442 of 35,261
// have a term), while every invoice carries both. A credit memo has a sales rep but no term; an
// unapplied payment has neither, so it drops out while either filter is on. An opening item answers
// for the T1S invoice it is linked to, or else by the source's sales rep name.
const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim().toUpperCase();
// The open items narrowed by Term / Account Officer (Sales Rep). Shared by AR Aging and AR Aging
// Details (2026-10-14: "add filter per sales rep") so both answer the same way.
//
// Per Sales Group / SBU (2026-10-14) goes by each document's sales group: an invoice's department
// (e.g. "Sales - 3"), a credit memo's from its lines. An SBU is its groups (lib/sbuGroups.js -- SBU 1
// is Sales 1 + 3, SBU 2 is Sales 2 + 4). A document with no group, an unapplied payment, or an
// opening balance not linked to a T1S invoice drops out while either is on.
async function salesGroupIds(filters) {
  if (filters.salesGroupId) return new Set([Number(filters.salesGroupId)]);
  if (!filters.sbu) return null;
  const sbu = (await getSbuGroups()).find((g) => String(g.index) === String(filters.sbu));
  return new Set(sbu ? sbu.departmentIds.map(Number) : []);
}
async function narrowItems(items, filters = {}) {
  const term = filters.term ? norm(filters.term) : null;
  const officerId = filters.officerId ? Number(filters.officerId) : null;
  const groups = await salesGroupIds(filters);
  if (!term && !officerId && !groups) return items;
  let officerName = null;
  if (officerId) {
    const [[e]] = await pool.query("SELECT CONCAT(first_name, ' ', last_name) AS name FROM employees WHERE id = ?", [officerId]);
    officerName = norm(e?.name);
  }
  return items.filter((i) => {
    if (groups && !groups.has(Number(i.department_id))) return false;
    if (term && norm(i.term) !== term) return false;
    if (officerId) {
      if (i.sales_rep_id) return Number(i.sales_rep_id) === officerId;
      return !!officerName && norm(i.sales_rep) === officerName;
    }
    return true;
  });
}

async function buildArAging(asOf, filters = {}) {
  const items = await narrowItems(await collectOpenItems(asOf, filters), filters);
  const opts = { excludeCredit: !!filters.excludeCredit };
  const result = { as_of: asOf, ...summarizeItems(items, asOf, opts) };
  if (filters.sbu && !filters.salesGroupId) result.sbu_layout = await buildSbuLayout(items, asOf, filters.sbu, opts);
  return result;
}

// One row per customer, and the totals, for a set of open items.
//
// excludeCredit (asked 2026-11-13: "Include credit / Exclude credit balance"): leaves out every
// customer whose balance, netted across all its documents, is a credit -- below zero, so we owe
// them -- and the totals with them. A customer who owes on balance stays whole, its unapplied
// payments and credit memos included, so its row still nets to what it actually owes.
function summarizeItems(items, asOf, { excludeCredit = false } = {}) {
  // Accumulate every contribution into per-customer buckets.
  const byCustomer = new Map();
  function customerRow(item) {
    const key = rowKey(item);
    if (!byCustomer.has(key)) {
      byCustomer.set(key, {
        row_key: key, customer_id: item.customer_id ?? null, customer_name: item.customer_name || '',
        ...emptyBuckets(), unevidenced_count: 0, unevidenced_amount: 0, terms: new Set(), officers: new Set(),
      });
    }
    return byCustomer.get(key);
  }

  for (const item of items) {
    const row = customerRow(item);
    addToBucket(row, item.balance, item.aging_date, asOf);
    if (item.term) row.terms.add(String(item.term).trim());
    if (item.sales_rep && String(item.sales_rep).trim()) row.officers.add(String(item.sales_rep).trim());
    if (item.marked_paid_unevidenced) {
      row.unevidenced_count += 1;
      row.unevidenced_amount += item.balance;
    }
  }

  const rows = [...byCustomer.values()]
    .map((r) => {
      const buckets = {
        current: round2(r.current), d1_30: round2(r.d1_30), d31_60: round2(r.d31_60),
        d61_90: round2(r.d61_90), over_90: round2(r.over_90),
      };
      const total = round2(buckets.current + buckets.d1_30 + buckets.d31_60 + buckets.d61_90 + buckets.over_90);
      return {
        row_key: r.row_key, customer_id: r.customer_id, customer_name: r.customer_name,
        term_name: [...r.terms].join(', ') || null, officer_name: [...r.officers].join(', ') || null,
        ...buckets, total_balance: total,
        unevidenced_count: r.unevidenced_count,
        unevidenced_amount: round2(r.unevidenced_amount),
      };
    })
    // A customer with everything netted to zero isn't outstanding -- drop it, same as the
    // real report only listing customers with a balance.
    .filter((r) => Math.abs(r.total_balance) >= 0.005
      || [r.current, r.d1_30, r.d31_60, r.d61_90, r.over_90].some((v) => Math.abs(v) >= 0.005))
    .filter((r) => !excludeCredit || r.total_balance >= 0.005)
    .sort((a, b) => String(a.customer_name).localeCompare(String(b.customer_name)));

  const totals = rows.reduce((t, r) => ({
    current: t.current + r.current, d1_30: t.d1_30 + r.d1_30, d31_60: t.d31_60 + r.d31_60,
    d61_90: t.d61_90 + r.d61_90, over_90: t.over_90 + r.over_90, total_balance: t.total_balance + r.total_balance,
    unevidenced_count: t.unevidenced_count + r.unevidenced_count,
    unevidenced_amount: t.unevidenced_amount + r.unevidenced_amount,
  }), { ...emptyBuckets(), total_balance: 0, unevidenced_count: 0, unevidenced_amount: 0 });
  Object.keys(totals).forEach((k) => { totals[k] = round2(totals[k]); });

  return { rows, totals };
}

// AR Aging filtered by SBU, laid out the way the SBU heads read it (asked 2026-10-14):
//
//   Sales-1 supervisor | Arjie Bayagna        <- the supervisor's own customers
//   AC-1               | Catherine            <- each account officer under them
//   AC-1               | Jocel
//   Sales-3 supervisor | Nicole Joji Ann Fuentes
//   AC-3               | ...
//   SBU 1              | Michelle Riveral     <- the SBU head's own customers
//
// Groups are the SBU's sales groups by name; who supervises whom is user_supervisors, the same as
// the dashboard's sales breakdown (lib/salesBreakdown.js). A document belongs to its own sales rep
// (by id, or by name for an opening balance), so a customer appears under each officer it owes on.
// Every item lands in exactly one section, so the sections add up to the report total.
async function buildSbuLayout(items, asOf, sbuIndex, summaryOpts = {}) {
  const sbu = (await getSbuGroups()).find((g) => String(g.index) === String(sbuIndex));
  if (!sbu) return null;
  const [users] = await pool.query(
    `SELECT u.id, u.employee_id, u.is_supervisor, u.is_sales_business_unit,
            COALESCE(CONCAT(e.first_name, ' ', e.last_name), u.display_name) AS name
       FROM users u LEFT JOIN employees e ON e.id = u.employee_id WHERE u.is_active = TRUE`);
  const [links] = await pool.query('SELECT user_id, supervisor_id FROM user_supervisors');
  const userById = new Map(users.map((u) => [u.id, u]));
  const userByEmp = new Map(users.filter((u) => u.employee_id).map((u) => [Number(u.employee_id), u]));
  const empByName = new Map(users.filter((u) => u.employee_id).map((u) => [norm(u.name), Number(u.employee_id)]));
  const supsOf = new Map();
  for (const l of links) {
    if (l.supervisor_id === l.user_id || !userById.get(l.supervisor_id)?.is_supervisor) continue;
    if (!supsOf.has(l.user_id)) supsOf.set(l.user_id, []);
    supsOf.get(l.user_id).push(l.supervisor_id);
  }
  const empOf = (i) => (i.sales_rep_id ? Number(i.sales_rep_id) : empByName.get(norm(i.sales_rep)) || null);
  const nameOf = (empId, i) => userByEmp.get(empId)?.name || i?.sales_rep || '(no account officer)';
  const section = (kind, label, name, list) => ({ kind, label, name, ...summarizeItems(list, asOf, summaryOpts) });

  const headUser = userById.get(sbu.userId);
  const isHead = (empId) => empId != null && headUser && Number(headUser.employee_id) === empId;
  const groups = sbu.departmentIds.map((id, k) => ({ id: Number(id), name: sbu.departmentNames[k] }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const sections = [];
  for (const g of groups) {
    const short = g.name.replace(/s*-s*/g, '-');
    const num = (g.name.match(/d+/) || [''])[0];
    const mine = items.filter((i) => Number(i.department_id) === g.id && !isHead(empOf(i)));
    // supervisor user id -> { own: [], members: Map(empId -> items) }; reps nobody supervises apart.
    const bySup = new Map();
    const loose = new Map();
    const supEntry = (id) => { if (!bySup.has(id)) bySup.set(id, { own: [], members: new Map() }); return bySup.get(id); };
    for (const i of mine) {
      const emp = empOf(i);
      const u = emp != null ? userByEmp.get(emp) : null;
      const key = emp ?? `name:${norm(i.sales_rep)}`;
      if (u && u.is_supervisor) { supEntry(u.id).own.push(i); continue; }
      const sup = u ? (supsOf.get(u.id) || []).find((sid) => !userById.get(sid)?.is_sales_business_unit) : null;
      const bucket = sup ? supEntry(sup).members : loose;
      if (!bucket.has(key)) bucket.set(key, { emp, items: [] });
      bucket.get(key).items.push(i);
    }
    const byName = (a, b) => String(a.name).localeCompare(String(b.name));
    for (const [supId, e] of [...bySup.entries()].sort((a, b) => String(userById.get(a[0])?.name).localeCompare(String(userById.get(b[0])?.name)))) {
      sections.push(section('supervisor', `${short} supervisor`, userById.get(supId)?.name || 'Supervisor', e.own));
      [...e.members.values()].map((m) => ({ name: nameOf(m.emp, m.items[0]), items: m.items })).sort(byName)
        .forEach((m) => sections.push(section('officer', `AC-${num}`, m.name, m.items)));
    }
    [...loose.values()].map((m) => ({ name: nameOf(m.emp, m.items[0]), items: m.items })).sort(byName)
      .forEach((m) => sections.push(section('officer', `AC-${num}`, m.name, m.items)));
  }
  const headItems = items.filter((i) => isHead(empOf(i)));
  sections.push(section('sbu', sbu.label, headUser?.name || sbu.displayName, headItems));
  // Anything outside the SBU's groups (should be none -- the filter keeps only those) is not lost.
  const inGroups = new Set(groups.map((g) => g.id));
  const rest = items.filter((i) => !isHead(empOf(i)) && !inGroups.has(Number(i.department_id)));
  if (rest.length) sections.push(section('officer', 'Other', '', rest));
  return { label: sbu.label, owner: headUser?.name || sbu.displayName, sections };
}

// AR Aging Details (Accounting > Reports > AR Aging Details). The same open items AR Aging
// buckets, listed instead of summed: one group per customer, one row per document, with the
// age and the open balance it contributes. Because both reports read collectOpenItems, a
// customer's rows here always add up to that customer's Total Balance on the summary -- the
// two cannot drift apart.
//
// AGE is measured from the aging date, which is the DUE date for an invoice and the document
// date for a credit memo or an unapplied payment. Not clamped at zero: an invoice not yet due
// ages negative, and "-12" says something a floor of 0 would hide.
//
// PAGED BY CUSTOMER, not by row. A page that cut a customer in half would show a group whose
// rows do not add up to its own heading, which is the one thing this report exists to avoid.
const DETAILS_DEFAULT_PAGE_SIZE = 25;
const DETAILS_MAX_PAGE_SIZE = 200;

function groupItemsByCustomer(items, asOf) {
  const byCustomer = new Map();
  for (const item of items) {
    const key = rowKey(item);
    if (!byCustomer.has(key)) {
      byCustomer.set(key, {
        row_key: key, customer_id: item.customer_id ?? null, customer_name: item.customer_name || '', items: [], total_balance: 0,
      });
    }
    const group = byCustomer.get(key);
    group.items.push({
      type: item.type,
      trans_date: item.date,
      trans_no: item.reference,
      id: item.id,
      bs_no: item.bs_no,
      memo: item.memo,
      po_no: item.po_no,
      date_due: item.due_date,
      age: daysBetween(item.aging_date, asOf),
      open_balance: item.balance,
      location_name: item.location_name,
      sales_rep: item.sales_rep || null,
      marked_paid_unevidenced: item.marked_paid_unevidenced,
    });
    group.total_balance += item.balance;
  }

  return [...byCustomer.values()]
    .map((g) => ({
      ...g,
      total_balance: round2(g.total_balance),
      items: g.items.sort((a, b) => String(a.trans_date).localeCompare(String(b.trans_date))
        || String(a.trans_no).localeCompare(String(b.trans_no))),
    }))
    // Same rule as the summary: a customer whose items net to nothing is not outstanding. Kept
    // when the items themselves are non-zero, so a customer holding an invoice and an equal
    // credit still shows both rows rather than vanishing.
    .filter((g) => Math.abs(g.total_balance) >= 0.005 || g.items.length > 0)
    .sort((a, b) => String(a.customer_name).localeCompare(String(b.customer_name)));
}

async function buildArAgingDetails(asOf, filters = {}) {
  const items = await narrowItems(await collectOpenItems(asOf, filters), filters);
  const groups = groupItemsByCustomer(items, asOf);

  const limit = Math.min(DETAILS_MAX_PAGE_SIZE, Math.max(1, Number(filters.limit) || DETAILS_DEFAULT_PAGE_SIZE));
  const page = Math.max(1, Number(filters.page) || 1);
  const pageGroups = groups.slice((page - 1) * limit, page * limit);

  // Totals are over the WHOLE filtered set, not the page: the items were all computed anyway,
  // and a receivable report whose total moves when you turn the page is not a total.
  const totals = {
    open_balance: round2(groups.reduce((s, g) => s + g.total_balance, 0)),
    customer_count: groups.length,
    item_count: groups.reduce((s, g) => s + g.items.length, 0),
    unevidenced_count: items.filter((i) => i.marked_paid_unevidenced).length,
    // The one place this report's customer count can differ from AR Aging's, counted so the page
    // can say why rather than leaving a silent difference for someone to find by subtraction.
    // A customer whose open documents cancel out exactly -- an invoice and a credit of the same
    // size -- has no AR Aging row, because every bucket is zero. It keeps its rows here: a
    // balance of zero reached by holding two live documents is precisely what someone chasing
    // receivables needs to see, and there were 6 such customers on production at 2026-09-22.
    zero_net_customer_count: groups.filter((g) => Math.abs(g.total_balance) < 0.005).length,
  };
  const pageTotal = round2(pageGroups.reduce((s, g) => s + g.total_balance, 0));

  return {
    as_of: asOf,
    rows: pageGroups,
    page,
    limit,
    total_pages: Math.max(1, Math.ceil(groups.length / limit)),
    page_total: pageTotal,
    totals,
  };
}

// The whole filtered set, flat, one row per document with its customer repeated -- the shape a
// spreadsheet can sort and pivot. No page limit: this report's cost is the scan that already
// happened, so paging the export would only make someone run it five times.
async function buildArAgingDetailsCsv(asOf, filters = {}) {
  const items = await narrowItems(await collectOpenItems(asOf, filters), filters);
  const groups = groupItemsByCustomer(items, asOf);

  // The source's own extract layout (asked 2026-10-02), as the Excel one (lib/agingWorkbook.js): the
  // customer on a row of its own, its documents with the Customer column blank, "Total - <name>",
  // a final "Total"; Sales Rep before Location; dates as the source writes them (10/4/2022).
  const header = ['Customer', 'Trans. Date', 'Trans. #', 'BS #', 'Memo', 'PO #', 'Date Due', 'Age', 'Open Balance', 'Sales Rep', 'Location'];
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    // Excel reads a leading = + - @ as a formula. Note this deliberately does NOT touch the
    // money column, which is written by `money` below and may legitimately start with a minus.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const money = (v) => Number(v).toFixed(2);
  const day = (v) => { const d = v ? String(v).slice(0, 10) : ''; return d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}/${d.slice(0, 4)}` : ''; };

  const out = [header.join(',')];
  let grand = 0;
  for (const g of groups) {
    out.push([cell(g.customer_name), '', '', '', '', '', '', '', '', '', ''].join(','));
    for (const it of g.items) {
      out.push([
        '', day(it.trans_date), cell(it.trans_no), cell(it.bs_no), cell(it.memo),
        cell(it.po_no), day(it.date_due), it.age, money(it.open_balance), cell(it.sales_rep), cell(it.location_name),
      ].join(','));
    }
    out.push([cell(`Total - ${g.customer_name}`), '', '', '', '', '', '', '', money(g.total_balance), '', ''].join(','));
    grand += Number(g.total_balance) || 0;
  }
  out.push(['Total', '', '', '', '', '', '', '', money(grand), '', ''].join(','));
  return { csv: out.join('\n'), customers: groups.length, items: items.length };
}

// The Details report's customer groups, whole (no paging) -- for its Excel extract.
async function buildArAgingDetailsGroups(asOf, filters = {}) {
  return groupItemsByCustomer(await narrowItems(await collectOpenItems(asOf, filters), filters), asOf);
}

// Typeahead for the Details report's Customer filter. Capped, and limited to customers that
// have AR history at all -- /customers returns all 21,562 rows and a receivables filter has no
// use for a customer who has never been billed.
async function searchArCustomers(term) {
  const q = `%${String(term || '').trim()}%`;
  const [rows] = await pool.query(
    `SELECT c.id, c.name
       FROM customers c
      WHERE c.name LIKE ?
        AND (EXISTS (SELECT 1 FROM sales_orders so JOIN sales_invoices si ON si.sales_order_id = so.id
                      WHERE so.customer_id = c.id)
          -- An invoice raised against the customer directly, with no order behind it. Every one of
          -- the 187 open 2017-2020 invoices is of that shape, and without this their customers
          -- could not be picked at all -- the report would list them and the filter could not
          -- find them.
          OR EXISTS (SELECT 1 FROM sales_invoices si WHERE si.customer_id = c.id)
          -- And the customer whose whole balance is an opening item: real in this report, and
          -- previously invisible to its own filter unless they also had a payment or a credit.
          OR EXISTS (SELECT 1 FROM opening_ar_items o WHERE o.customer_id = c.id)
          OR EXISTS (SELECT 1 FROM customer_payments cp WHERE cp.customer_id = c.id)
          OR EXISTS (SELECT 1 FROM credit_memos cm WHERE cm.customer_id = c.id))
      ORDER BY c.name
      -- The picker paginates ten at a time, so 25 was a page and a half. 50 fills it without
      -- turning a keystroke into a scan of 35,000 customers.
      LIMIT 50`,
    [q],
  );
  return rows;
}

// The DETAILS drill-down: the individual open items making up one customer's balance, each
// with its own remaining and bucket -- what the aging row is the sum of.
async function buildArAgingCustomerDetailsFromDocs(customerId, asOf) {
  const [[customer]] = await pool.query('SELECT id, name FROM customers WHERE id = ?', [customerId]);
  if (!customer) return null;

  const [invoices] = await pool.query(
    `SELECT si.id, si.invoice_no, si.date_created, si.date_due, si.gross_amount,
            si.status, si.amount_due,
            COALESCE((SELECT SUM(cpl.applied_amount) FROM customer_payment_lines cpl
                      JOIN customer_payments cp ON cp.id = cpl.customer_payment_id
                      WHERE cpl.sales_invoice_id = si.id AND cp.status != 'voided' AND cp.date_created <= ?), 0)
            + COALESCE((SELECT SUM(cma.applied_amount) FROM credit_memo_applications cma
                        JOIN credit_memos cm ON cm.id = cma.credit_memo_id
                        WHERE cma.sales_invoice_id = si.id AND cm.status != 'voided' AND cm.date_created <= ?), 0) AS settled
     FROM sales_invoices si
     LEFT JOIN sales_orders so ON so.id = si.sales_order_id
     LEFT JOIN estimates e ON e.id = si.estimate_id
     LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id
     WHERE COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id) = ? AND si.status != 'cancelled' AND si.date_created <= ?`,
    [asOf, asOf, customerId, asOf]
  );

  const items = [];
  for (const inv of invoices) {
    const remaining = Number(inv.gross_amount) - Number(inv.settled);
    if (Math.abs(remaining) < 0.005) continue;
    const agingDate = inv.date_due || inv.date_created;
    items.push({
      type: 'Invoice', reference: inv.invoice_no, id: inv.id, date: inv.date_created,
      due_date: inv.date_due, original_amount: round2(inv.gross_amount), balance: round2(remaining),
      days_overdue: Math.max(daysBetween(agingDate, asOf), 0),
      // Why this line and the invoice screen disagree, said on the line itself.
      marked_paid_unevidenced: isMarkedPaid(inv) && Number(inv.settled) < 0.005,
    });
  }

  const [memos] = await pool.query(
    `SELECT cm.id, cm.credit_memo_no, cm.date_created, cm.gross_amount,
            COALESCE((SELECT SUM(cma.applied_amount) FROM credit_memo_applications cma WHERE cma.credit_memo_id = cm.id), 0)
            + COALESCE((SELECT SUM(cpl.applied_amount) FROM customer_payment_lines cpl
                        JOIN customer_payments cp ON cp.id = cpl.customer_payment_id
                        WHERE cpl.credit_memo_id = cm.id AND cp.status != 'voided' AND cp.date_created <= ?), 0) AS used
     FROM credit_memos cm
     WHERE cm.customer_id = ? AND cm.status != 'voided' AND cm.date_created <= ?`,
    [asOf, customerId, asOf]
  );
  for (const cm of memos) {
    const remaining = Number(cm.gross_amount) - Number(cm.used);
    if (remaining < 0.005) continue;
    items.push({
      type: 'Credit Memo', reference: cm.credit_memo_no, id: cm.id, date: cm.date_created,
      due_date: null, original_amount: round2(cm.gross_amount), balance: round2(-remaining),
      days_overdue: Math.max(daysBetween(cm.date_created, asOf), 0),
    });
  }

  const [payments] = await pool.query(
    `SELECT cp.id, cp.customer_payment_no, cp.date_created, cp.payment_amount, cp.unapplied_amount,
            COALESCE((SELECT SUM(cpl.applied_amount) FROM customer_payment_lines cpl
                      WHERE cpl.customer_payment_id = cp.id AND cpl.sales_invoice_id IS NOT NULL), 0) AS cash_applied,
            (SELECT COUNT(*) FROM customer_payment_lines cpl WHERE cpl.customer_payment_id = cp.id) AS line_count
     FROM customer_payments cp
     WHERE cp.customer_id = ? AND cp.status != 'voided' AND cp.date_created <= ?`,
    [customerId, asOf]
  );
  for (const cp of payments) {
    // The COUNT is what the SUM cannot tell us: it returns 0 both for a payment that applied
    // nothing and for one whose lines were never imported, and those need opposite treatment.
    const unapplied = unappliedCash(cp, Number(cp.line_count) > 0 ? cp.cash_applied : null);
    if (unapplied < 0.005) continue;
    items.push({
      type: 'Unapplied Payment', reference: cp.customer_payment_no, id: cp.id, date: cp.date_created,
      due_date: null, original_amount: round2(cp.payment_amount), balance: round2(-unapplied),
      days_overdue: Math.max(daysBetween(cp.date_created, asOf), 0),
    });
  }

  items.sort((a, b) => new Date(a.date) - new Date(b.date));
  const total = round2(items.reduce((s, i) => s + i.balance, 0));
  return { customer_id: customer.id, customer_name: customer.name, as_of: asOf, items, total_balance: total };
}

// The LEDGER drill-down: every AR document for the customer in date order, with a running
// balance of what they owe. Invoices raise the balance; payments (cash) and credit memos
// lower it. This is the transaction history behind the number, not a point-in-time recut,
// so it lists everything up to the as-of date.
async function buildArAgingCustomerLedger(customerId, asOf) {
  const [[customer]] = await pool.query('SELECT id, name FROM customers WHERE id = ?', [customerId]);
  if (!customer) return null;

  const entries = [];

  const [invoices] = await pool.query(
    `SELECT si.id, si.invoice_no, si.date_created, si.gross_amount
     FROM sales_invoices si
     LEFT JOIN sales_orders so ON so.id = si.sales_order_id
     LEFT JOIN estimates e ON e.id = si.estimate_id
     LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id
     WHERE COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id) = ? AND si.status != 'cancelled' AND si.date_created <= ?`,
    [customerId, asOf]
  );
  for (const si of invoices) {
    entries.push({ date: si.date_created, type: 'Invoice', reference: si.invoice_no, id: si.id, amount: round2(si.gross_amount) });
  }

  const [memos] = await pool.query(
    `SELECT id, credit_memo_no, date_created, gross_amount FROM credit_memos
     WHERE customer_id = ? AND status != 'voided' AND date_created <= ?`,
    [customerId, asOf]
  );
  for (const cm of memos) {
    entries.push({ date: cm.date_created, type: 'Credit Memo', reference: cm.credit_memo_no, id: cm.id, amount: round2(-cm.gross_amount) });
  }

  const [payments] = await pool.query(
    `SELECT id, customer_payment_no, date_created, payment_amount FROM customer_payments
     WHERE customer_id = ? AND status != 'voided' AND date_created <= ?`,
    [customerId, asOf]
  );
  for (const cp of payments) {
    entries.push({ date: cp.date_created, type: 'Payment', reference: cp.customer_payment_no, id: cp.id, amount: round2(-cp.payment_amount) });
  }

  entries.sort((a, b) => new Date(a.date) - new Date(b.date) || String(a.reference).localeCompare(String(b.reference)));
  let running = 0;
  const ledger = entries.map((e) => {
    running = round2(running + e.amount);
    return { ...e, balance: running };
  });

  return { customer_id: customer.id, customer_name: customer.name, as_of: asOf, ledger, total_balance: running };
}

// When T1S's books start from an opening balance (lib/openingBalances.js), the aging is the
// customer documents open at the books start -- each less what 2026 has settled against it -- plus
// every document dated from the start. Pre-start documents are history: the source system's own
// 2025-12-31 aging is what they amounted to. An as-of date before the start reads history as before.
// The T1S record behind each opening item, so the reports can open it (asked 2026-10-05: every
// transaction on AR Aging / AR Aging Details clickable). An opening row's own link column is the
// INVOICE it was tied to, whatever its type -- so an opening Credit Memo or Unapplied Payment pointed
// at an invoice id, or nowhere. Each is found by its document number in its own table instead; one
// that T1S never imported keeps a null id and shows as plain text.
async function resolveOpeningIds(opening) {
  const lookups = [
    ['Invoice', 'sales_invoices', 'invoice_no'],
    ['Credit Memo', 'credit_memos', 'credit_memo_no'],
    ['Unapplied Payment', 'customer_payments', 'customer_payment_no'],
  ];
  const resolved = new Map(); // `${type}|${reference}` -> id
  for (const [type, table, col] of lookups) {
    const nos = [...new Set(opening.filter((o) => o.type === type && o.reference && !(type === 'Invoice' && o.id)).map((o) => o.reference))];
    if (!nos.length) continue;
    const [rows] = await pool.query(`SELECT id, ${col} AS no FROM ${table} WHERE ${col} IN (?)`, [nos]);
    rows.forEach((r) => resolved.set(`${type}|${r.no}`, r.id));
  }
  return opening.map((o) => ({
    ...o,
    id: o.type === 'Invoice' && o.id ? o.id : (resolved.get(`${o.type}|${o.reference}`) || null),
  }));
}

// A document dated BEFORE the books start but entered in T1S after the opening snapshot was loaded
// -- so the source's snapshot cannot contain it (INV-83549: dated 2026-09-30, keyed 2026-10-03, the
// 2026-09-30 snapshot loaded that evening). Dropping every pre-start document as "history" lost it
// from the aging entirely, leaving only the customer's unapplied advance (asked 2026-10-08). These
// are kept: dated pre-start, keyed in T1S after the snapshot was loaded, and not among its items.
const LATE_TABLES = {
  Invoice: ['sales_invoices', 'invoice_no'],
  'Credit Memo': ['credit_memos', 'credit_memo_no'],
  'Unapplied Payment': ['customer_payments', 'customer_payment_no'],
};
async function lateEnteredKeys(books) {
  const keys = new Set();
  const [[snap]] = await pool.query('SELECT MIN(created_at) AS loaded FROM opening_ar_items WHERE as_of = ?', [books.asOf]);
  if (!snap || !snap.loaded) return keys;
  for (const [type, [table, col]] of Object.entries(LATE_TABLES)) {
    const [rows] = await pool.query(
      `SELECT d.id FROM ${table} d
        WHERE d.date_created < ? AND d.created_at > ?
          -- Keyed by a person in T1S. Imported documents have no creator, and the ones imported after the
          -- snapshot (backfills) are closed in the source -- that is why the snapshot does not list them.
          AND d.created_by_user_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM opening_ar_items o
                           WHERE o.as_of = ? AND o.doc_no = d.${col} COLLATE utf8mb4_unicode_ci)`,
      [books.start, snap.loaded, books.asOf]);
    rows.forEach((r) => keys.add(`${type}|${r.id}`));
  }
  return keys;
}
const keepAfterStart = (books, late) => (i) => String(i.date).slice(0, 10) >= books.start || late.has(`${i.type}|${i.id}`);

async function collectOpenItems(asOf, filters = {}) {
  const items = await collectOpenItemsFromDocs(asOf, filters);
  const books = await agingAnchor('ar', asOf);
  if (!books) return items;
  const opening = await resolveOpeningIds(await openingItems('ar', asOf, books, {
    partyId: filters.customerId, nameStarts: filters.nameStarts, locationId: filters.locationId, noLocation: filters.noLocation,
  }));
  // An opening item that links to a T1S invoice shows that invoice's BS/SI #, PO # and memo, the
  // way an invoice dated after the start does -- the opening balance itself carries none of them.
  const invIds = opening.filter((o) => o.type === 'Invoice' && o.id).map((o) => o.id);
  const invById = new Map();
  if (invIds.length) {
    const [inv] = await pool.query(
      `SELECT si.id, si.bs_si_no, si.po_no, si.memo, si.term, si.sales_rep_id, si.department_id, CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep
         FROM sales_invoices si LEFT JOIN employees sr ON sr.id = si.sales_rep_id WHERE si.id IN (?)`, [invIds]);
    inv.forEach((r) => invById.set(r.id, r));
  }
  return [
    ...opening.map((o) => ({
      customer_id: o.party_id, customer_name: o.party_name, type: o.type, reference: o.reference, id: o.id,
      date: o.date, due_date: o.due_date, aging_date: o.due_date || o.date,
      original_amount: o.original_amount, balance: o.balance,
      // The source's own details for the document (as its AR Aging Details shows them), else the
      // linked T1S invoice's. The placeholder only where neither has ever been loaded.
      bs_no: o.bs_no || (o.type === 'Invoice' ? invById.get(o.id) : null)?.bs_si_no || null, po_no: o.po_no || (o.type === 'Invoice' ? invById.get(o.id) : null)?.po_no || null,
      memo: o.memo || (o.type === 'Invoice' ? invById.get(o.id) : null)?.memo || (o.src_location === undefined ? 'Opening balance from the source system' : null),
      location_name: o.location_name || o.src_location || null,
      sales_rep: o.sales_rep || (o.type === 'Invoice' ? invById.get(o.id) : null)?.sales_rep || null,
      term: (o.type === 'Invoice' ? invById.get(o.id) : null)?.term || null,
      sales_rep_id: (o.type === 'Invoice' ? invById.get(o.id) : null)?.sales_rep_id || null,
      department_id: (o.type === 'Invoice' ? invById.get(o.id) : null)?.department_id || null,
      marked_paid_unevidenced: false, opening: true,
    })),
    ...items.filter(keepAfterStart(books, await lateEnteredKeys(books))),
  ];
}

async function buildArAgingCustomerDetails(customerId, asOf) {
  const result = await buildArAgingCustomerDetailsFromDocs(customerId, asOf);
  if (!result) return result;
  const books = await agingAnchor('ar', asOf);
  if (!books) return result;
  const opening = await resolveOpeningIds(await openingItems('ar', asOf, books, { partyId: customerId }));
  const items = [
    ...opening.map((o) => ({
      type: o.type, reference: o.reference, id: o.id, date: o.date, due_date: o.due_date,
      original_amount: o.original_amount, balance: o.balance,
      days_overdue: Math.max(daysBetween(o.due_date || o.date, asOf), 0), opening: true,
    })),
    ...result.items.filter(keepAfterStart(books, await lateEnteredKeys(books))),
  ].sort((a, b) => new Date(a.date) - new Date(b.date));
  return { ...result, items, total_balance: round2(items.reduce((sum, i) => sum + i.balance, 0)) };
}

// The Details popup lists INVOICES only (asked 2026-10-13); the Ledger keeps everything. What the
// credits come to is still returned, so the popup can say how its total meets the report's row.
async function buildArAgingCustomerInvoiceDetails(customerId, asOf) {
  const all = await buildArAgingCustomerDetails(customerId, asOf);
  if (!all) return all;
  const items = all.items.filter((i) => i.type === 'Invoice');
  const credits = all.items.filter((i) => i.type !== 'Invoice');
  return {
    ...all,
    items,
    total_balance: round2(items.reduce((s, i) => s + i.balance, 0)),
    credits_balance: round2(credits.reduce((s, i) => s + i.balance, 0)),
    credits_count: credits.length,
    customer_balance: all.total_balance,
  };
}

module.exports = {
  buildArAging, buildArAgingCustomerDetails, buildArAgingCustomerInvoiceDetails, buildArAgingCustomerLedger, collectOpenItems,
  buildArAgingDetails, buildArAgingDetailsCsv, buildArAgingDetailsGroups, searchArCustomers,
};
