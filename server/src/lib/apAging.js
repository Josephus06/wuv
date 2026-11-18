const pool = require('../db');
const { agingAnchor, openingItems } = require('./openingBalances');

// AP Aging (Accounting > Reports > AP Aging). The payables mirror of lib/arAging.js: every
// vendor's outstanding balance as of a date, split into the same five age buckets. Built the
// same way and deliberately in the same shape, so the two reports can be read side by side.
//
// What makes up a vendor's balance, all signed so positive = we owe them:
//   + each non-cancelled Vendor Bill's payable, less the bill payments and bill-credit
//     applications that had settled it by the as-of date -> its remaining, aged by DUE date
//   - each open Bill Credit's still-unused remaining (a credit the vendor owes us back), aged
//     by the credit's own date
//   - each Bill Payment's unapplied cash (we paid more than we applied), aged by its own date
//
// THE PAYABLE IS gross_amount - wtax_amount, NOT gross. Withholding tax is money withheld from
// the vendor and remitted to the BIR, so it was never owed to them; routes/vendorBills.js opens
// every bill at exactly `grossAmount - wtaxAmount` and that is the figure this report ages.
// Using gross would overstate payables by the whole withheld amount -- PHP 2.2M across the
// 19,164 bills in this database.
//
// MARKED PAID, NOT EVIDENCED -- AND WHY THIS REPORT DEFAULTS THE OPPOSITE WAY TO AR AGING.
// AR Aging counts an invoice that claims to be settled with nothing recording the settlement,
// and flags it: there, such invoices were 1.9% of the file, so including them kept the report
// honest at a cost of a footnote.
//
// On the payables side the same question has a different answer, because the data is different
// in kind: 12,221 of the 18,873 bills marked paid -- 65% of them, PHP 149.4M -- carry no bill
// payment at all, because the bill payment migration is unfinished (868 of the payments landed
// with their applications, the rest as headers or not at all). Deriving those into the balance
// would report about PHP 162M outstanding where the business is carrying PHP 13M, and a
// payables report that is twelve times the real number is not one anyone can use.
//
// So they are EXCLUDED by default and counted in the open, never silently dropped: the response
// always carries `unevidenced` (count and amount), the page states it above the numbers, and
// `includeUnevidenced` puts them back in for anyone who wants the derived-from-documents view
// the AR report gives. The default is a judgement about which number is less wrong, not a claim
// that those bills are settled.
const UNEVIDENCED_DEFAULT = false;

// A bill whose header says it is settled. 'paid' is what the migration wrote; 'paid_in_full' is
// what routes/billPayments.js writes when a payment closes one. Either, or a zero amount due, is
// enough to make silence about a payment worth flagging.
function isMarkedPaid(bill) {
  const status = String(bill.status || '').toLowerCase();
  return status === 'paid' || status === 'paid_in_full'
    || Math.abs(Number(bill.amount_due || 0)) < 0.005;
}

function daysBetween(fromStr, toStr) {
  const a = new Date(`${String(fromStr).slice(0, 10)}T00:00:00Z`);
  const b = new Date(`${String(toStr).slice(0, 10)}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

function emptyBuckets() {
  return { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, over_90: 0 };
}

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

// Location scopes the primary document, never its settlements -- a payable belongs to wherever
// it was raised, and paying it from elsewhere does not move where it is owed. Same rule, same
// words, as the AR side.
function locationClause(alias, { locationId, noLocation, companyId }) {
  if (noLocation) return { sql: ` AND ${alias}.office_location_id IS NULL`, params: [] };
  if (locationId) return { sql: ` AND ${alias}.office_location_id = ?`, params: [locationId] };
  // Every branch of one company (locations.company_id).
  if (companyId) return { sql: ` AND ${alias}.office_location_id IN (SELECT id FROM locations WHERE company_id = ?)`, params: [companyId] };
  return { sql: '', params: [] };
}

// Every open payables item as of a date. One function feeding both the buckets and the
// drill-down, for the same reason the AR side has one: a detail that does not add up to its
// summary is worse than no detail.
async function collectOpenApItemsFromDocs(asOf, filters = {}) {
  const { nameStarts, supplierId } = filters;
  const includeUnevidenced = filters.includeUnevidenced === undefined
    ? UNEVIDENCED_DEFAULT : !!filters.includeUnevidenced;
  const nameClause = nameStarts ? ' AND s.name LIKE ?' : '';
  const nameParam = nameStarts ? [`${nameStarts}%`] : [];
  const supClause = supplierId ? ' AND s.id = ?' : '';
  const supParam = supplierId ? [supplierId] : [];

  // A bill reaches its vendor through its purchase order; vendor_bills carries no supplier of
  // its own. Every bill in this database has one (checked: zero orphans), but the join stays
  // inner deliberately -- a bill with no vendor has no line to appear on in a vendor report.
  const billLoc = locationClause('vb', filters);
  const [bills] = await pool.query(
    `SELECT vb.id, s.id AS supplier_id, s.name AS supplier_name, vb.bill_no, vb.date_created, vb.date_due,
            vb.gross_amount, vb.wtax_amount, vb.amount_due, vb.status, vb.reference_no, vb.memo,
            po.po_no, loc.location_name
       FROM vendor_bills vb
       LEFT JOIN purchase_orders po ON po.id = vb.purchase_order_id
       JOIN suppliers s ON s.id = COALESCE(po.supplier_id, vb.supplier_id)
       LEFT JOIN locations loc ON loc.id = vb.office_location_id
      WHERE vb.cancelled_at IS NULL AND vb.status <> 'cancelled' AND vb.date_created <= ?
            ${billLoc.sql}${nameClause}${supClause}`,
    [asOf, ...billLoc.params, ...nameParam, ...supParam],
  );

  // Settlements that had landed by the as-of date, summed per bill.
  const [payToBill] = await pool.query(
    `SELECT bpl.vendor_bill_id AS bill_id, SUM(bpl.applied_amount) AS amt
       FROM bill_payment_lines bpl
       JOIN bill_payments bp ON bp.id = bpl.bill_payment_id
      WHERE bpl.vendor_bill_id IS NOT NULL AND bp.status <> 'voided' AND bp.voided_at IS NULL
        AND bp.date_created <= ?
      GROUP BY bpl.vendor_bill_id`,
    [asOf],
  );
  const [creditToBill] = await pool.query(
    `SELECT bca.vendor_bill_id AS bill_id, SUM(bca.applied_amount) AS amt
       FROM bill_credit_applications bca
       JOIN bill_credits bc ON bc.id = bca.bill_credit_id
      WHERE bc.status <> 'voided' AND bc.voided_at IS NULL AND bc.date_created <= ?
      GROUP BY bca.vendor_bill_id`,
    [asOf],
  );
  const paidByBill = new Map(payToBill.map((r) => [r.bill_id, Number(r.amt)]));
  const creditedByBill = new Map(creditToBill.map((r) => [r.bill_id, Number(r.amt)]));

  // PAID AFTER THE AS-OF DATE (2026-11-13). A bill marked paid by a payment or credit dated LATER --
  // a post-dated cheque (CHK-16100, 8 Dec) or bill payment (BPAY-13858, 10 Dec) -- was still owed on
  // the as-of date. It was being counted as "marked paid, no payment" and left out of the balance by
  // default: 161 bills, PHP 3.59M as of 13 Nov 2026. It is owed, and is shown with the payment that
  // will settle it. The earliest such document per bill.
  const [laterPay] = await pool.query(
    `SELECT bpl.vendor_bill_id AS bill_id, bp.bill_payment_no AS ref, DATE_FORMAT(bp.date_created, '%Y-%m-%d') AS d
       FROM bill_payment_lines bpl JOIN bill_payments bp ON bp.id = bpl.bill_payment_id
      WHERE bpl.vendor_bill_id IS NOT NULL AND bp.status <> 'voided' AND bp.voided_at IS NULL AND bp.date_created > ?`,
    [asOf],
  );
  const [laterCredit] = await pool.query(
    `SELECT bca.vendor_bill_id AS bill_id, bc.bill_credit_no AS ref, DATE_FORMAT(bc.date_created, '%Y-%m-%d') AS d
       FROM bill_credit_applications bca JOIN bill_credits bc ON bc.id = bca.bill_credit_id
      WHERE bc.status <> 'voided' AND bc.voided_at IS NULL AND bc.date_created > ?`,
    [asOf],
  );
  const paidLater = new Map();
  for (const r of [...laterPay, ...laterCredit]) {
    const cur = paidLater.get(r.bill_id);
    if (!cur || r.d < cur.date) paidLater.set(r.bill_id, { ref: r.ref, date: r.d });
  }

  const creditLoc = locationClause('bc', filters);
  const [credits] = await pool.query(
    `SELECT bc.id, s.id AS supplier_id, s.name AS supplier_name, bc.bill_credit_no, bc.date_created,
            bc.total_amount, bc.memo, loc.location_name
       FROM bill_credits bc
       LEFT JOIN vendor_bills vb ON vb.id = bc.vendor_bill_id
       LEFT JOIN purchase_orders po ON po.id = vb.purchase_order_id
       JOIN suppliers s ON s.id = COALESCE(po.supplier_id, vb.supplier_id, bc.supplier_id)
       LEFT JOIN locations loc ON loc.id = bc.office_location_id
      WHERE bc.status <> 'voided' AND bc.voided_at IS NULL AND bc.date_created <= ?
            ${creditLoc.sql}${nameClause}${supClause}`,
    [asOf, ...creditLoc.params, ...nameParam, ...supParam],
  );
  // A credit's remaining = its total, less what it has been applied to bills and less any bill
  // payment that has drawn on it (the Debits tab of the payment modal).
  const [creditApplied] = await pool.query(
    `SELECT bc.id, COALESCE(SUM(bca.applied_amount), 0) AS amt
       FROM bill_credits bc
       LEFT JOIN bill_credit_applications bca ON bca.bill_credit_id = bc.id
      WHERE bc.status <> 'voided' AND bc.date_created <= ?
      GROUP BY bc.id`,
    [asOf],
  );
  const [creditDrawn] = await pool.query(
    `SELECT bpl.bill_credit_id AS credit_id, SUM(bpl.applied_amount) AS amt
       FROM bill_payment_lines bpl
       JOIN bill_payments bp ON bp.id = bpl.bill_payment_id
      WHERE bpl.bill_credit_id IS NOT NULL AND bp.status <> 'voided' AND bp.date_created <= ?
      GROUP BY bpl.bill_credit_id`,
    [asOf],
  );
  // ...and any standing Cheque that has used it (cheque_bill_credits; absent on an older schema).
  const [chequeDrawn] = await pool.query(
    `SELECT cbc.bill_credit_id AS credit_id, SUM(cbc.applied_amount) AS amt
       FROM cheque_bill_credits cbc JOIN cheques c ON c.id = cbc.cheque_id
      WHERE c.status <> 'void' AND c.date_created <= ?
      GROUP BY cbc.bill_credit_id`,
    [asOf],
  ).catch((e) => { if (e.code === 'ER_NO_SUCH_TABLE') return [[]]; throw e; });
  const appliedByCredit = new Map(creditApplied.map((r) => [r.id, Number(r.amt)]));
  const drawnByCredit = new Map(creditDrawn.map((r) => [r.credit_id, Number(r.amt)]));
  for (const r of chequeDrawn) drawnByCredit.set(r.credit_id, (drawnByCredit.get(r.credit_id) || 0) + Number(r.amt));

  const payLoc = locationClause('bp', filters);
  const [payments] = await pool.query(
    `SELECT bp.id, s.id AS supplier_id, s.name AS supplier_name, bp.bill_payment_no, bp.date_created,
            bp.total_amount, bp.memo, bp.reference_no, bp.check_no, loc.location_name
       FROM bill_payments bp
       JOIN suppliers s ON s.id = bp.supplier_id
       LEFT JOIN locations loc ON loc.id = bp.office_location_id
      WHERE bp.status <> 'voided' AND bp.voided_at IS NULL AND bp.date_created <= ?
            ${payLoc.sql}${nameClause}${supClause}`,
    [asOf, ...payLoc.params, ...nameParam, ...supParam],
  );
  // Only cash applied to BILLS consumes a payment; a line drawing a bill credit moves no cash.
  const [payApplied] = await pool.query(
    `SELECT bpl.bill_payment_id AS payment_id, SUM(bpl.applied_amount) AS amt
       FROM bill_payment_lines bpl
       JOIN bill_payments bp ON bp.id = bpl.bill_payment_id
      WHERE bpl.vendor_bill_id IS NOT NULL AND bp.status <> 'voided' AND bp.date_created <= ?
      GROUP BY bpl.bill_payment_id`,
    [asOf],
  );
  const appliedByPayment = new Map(payApplied.map((r) => [r.payment_id, Number(r.amt)]));

  // Which payments have ANY line, which the SUM above cannot tell us: it is absent both for a
  // payment that applied nothing and for one whose lines were never imported, and those need
  // opposite treatment. The AR side draws the same distinction for the same reason.
  const [payLineCounts] = await pool.query(
    `SELECT bill_payment_id AS payment_id, COUNT(*) AS n FROM bill_payment_lines GROUP BY bill_payment_id`,
  );
  const hasLines = new Set(payLineCounts.map((r) => r.payment_id));

  const items = [];
  const unevidenced = { count: 0, amount: 0 };
  const unlinkedPayments = { count: 0, amount: 0 };
  const headerDisagreement = { count: 0, amount: 0 };

  for (const bill of bills) {
    // What was ever owed to the vendor on this bill: gross less the tax withheld from them.
    const payable = Number(bill.gross_amount) - Number(bill.wtax_amount || 0);
    const settled = (paidByBill.get(bill.id) || 0) + (creditedByBill.get(bill.id) || 0);
    const remaining = payable - settled;
    if (Math.abs(remaining) < 0.005) continue;

    // Settled by a document dated after the as-of date: owed on the as-of date, so counted, not flagged.
    const later = paidLater.get(bill.id) || null;
    const claimsPaid = isMarkedPaid(bill) && settled < 0.005 && !later;
    if (claimsPaid) {
      unevidenced.count += 1;
      unevidenced.amount += remaining;
      if (!includeUnevidenced) continue;
    }

    // A THIRD FACE OF THE SAME UNFINISHED MIGRATION, and the one that does not announce itself.
    // 1,231 of the 1,460 bills carrying a balance on production are still 'open' but hold a
    // header Amount Due LOWER than their own documents support -- PHP 4.0M in total. Something
    // drew those headers down without leaving a payment behind, so the migration's own partial
    // settlements are invisible to a report built from documents.
    //
    // Not excluded: unlike a bill claiming to be fully paid, there is no clean line here between
    // "already settled" and "still owed", and dropping the difference would mean silently
    // trusting a header this report exists not to trust. Counted and reported instead, so the
    // reader knows how much of the total rests on that disagreement.
    const headerDue = Number(bill.amount_due || 0);
    if (Math.abs(remaining - headerDue) >= 0.005) {
      headerDisagreement.count += 1;
      headerDisagreement.amount += remaining - headerDue;
    }

    items.push({
      supplier_id: bill.supplier_id, supplier_name: bill.supplier_name,
      type: 'Vendor Bill', reference: bill.bill_no, id: bill.id,
      date: bill.date_created, due_date: bill.date_due, aging_date: bill.date_due || bill.date_created,
      original_amount: round2(payable), balance: round2(remaining),
      po_no: bill.po_no || null, ref_no: bill.reference_no || null, memo: bill.memo || null,
      location_name: bill.location_name || null,
      marked_paid_unevidenced: claimsPaid,
      paid_later: later,
    });
  }

  for (const bc of credits) {
    const remaining = Number(bc.total_amount) - (appliedByCredit.get(bc.id) || 0) - (drawnByCredit.get(bc.id) || 0);
    if (remaining < 0.005) continue;
    items.push({
      supplier_id: bc.supplier_id, supplier_name: bc.supplier_name,
      type: 'Bill Credit', reference: bc.bill_credit_no, id: bc.id,
      date: bc.date_created, due_date: null, aging_date: bc.date_created,
      original_amount: round2(bc.total_amount), balance: round2(-remaining),
      po_no: null, ref_no: null, memo: bc.memo || null, location_name: bc.location_name || null,
      marked_paid_unevidenced: false,
    });
  }

  for (const bp of payments) {
    // A PAYMENT WITH NO LINES AT ALL HAS LOST ITS LINKS, IT IS NOT MONEY SITTING UNAPPLIED.
    // 3,564 of the 10,655 live bill payments on production -- PHP 69.6M -- arrived as headers
    // with no applications, the same unfinished migration that leaves 65% of bills claiming to
    // be paid with nothing recording it. Reading them as unapplied cash put PHP 66M of negative
    // balance into this report and turned the company's payables into MINUS 52.6M.
    //
    // They are excluded on the same terms as those bills, and counted in the open the same way:
    // both halves of one missing link, so the report cannot net a phantom credit against a
    // phantom debt and call the result a balance. Every payment that DOES carry lines is fully
    // applied by them (PHP 64,051,202.16 against PHP 64,051,202.16), so genuine unapplied cash
    // in this database is currently zero -- this is not hiding a real overpayment.
    if (!hasLines.has(bp.id)) {
      unlinkedPayments.count += 1;
      unlinkedPayments.amount += Number(bp.total_amount);
      if (!includeUnevidenced) continue;
    }
    const unapplied = Number(bp.total_amount) - (appliedByPayment.get(bp.id) || 0);
    if (unapplied < 0.005) continue;
    items.push({
      supplier_id: bp.supplier_id, supplier_name: bp.supplier_name,
      type: 'Unapplied Payment', reference: bp.bill_payment_no, id: bp.id,
      date: bp.date_created, due_date: null, aging_date: bp.date_created,
      original_amount: round2(bp.total_amount), balance: round2(-unapplied),
      po_no: null, ref_no: bp.reference_no || bp.check_no || null, memo: bp.memo || null,
      location_name: bp.location_name || null,
      marked_paid_unevidenced: false,
    });
  }

  return {
    items,
    unevidenced: { count: unevidenced.count, amount: round2(unevidenced.amount), included: includeUnevidenced },
    unlinked_payments: { count: unlinkedPayments.count, amount: round2(unlinkedPayments.amount), included: includeUnevidenced },
    header_disagreement: { count: headerDisagreement.count, amount: round2(headerDisagreement.amount) },
  };
}

// With an opening balance loaded (lib/openingBalances.js) the aging is the supplier documents open
// at the books start -- each less what 2026 has paid or credited against it -- plus everything
// dated from the start. Pre-start documents are history; the source system's own 2025-12-31 AP
// aging is what they amounted to. An as-of date before the start reads history as before.
async function collectOpenApItems(asOf, filters = {}) {
  const res = await collectOpenApItemsFromDocs(asOf, filters);
  const books = await agingAnchor('ap', asOf);
  if (!books) return res;
  const opening = await openingItems('ap', asOf, books, {
    partyId: filters.supplierId, nameStarts: filters.nameStarts, locationId: filters.locationId, noLocation: filters.noLocation,
  });
  const items = [
    ...opening.map((o) => ({
      supplier_id: o.party_id, supplier_name: o.party_name,
      type: o.type === 'Bill' ? 'Vendor Bill' : o.type, reference: o.reference, id: o.id,
      date: o.date, due_date: o.due_date, aging_date: o.due_date || o.date,
      original_amount: o.original_amount, balance: o.balance,
      po_no: null, ref_no: null, memo: 'Opening balance from the source system', location_name: o.location_name || null,
      marked_paid_unevidenced: false, opening: true,
    })),
    ...res.items.filter((i) => String(i.date).slice(0, 10) >= books.start),
  ];
  return { ...res, items };
}

// Which summary row an item belongs to. A supplier when it has one; otherwise its own name. Opening
// items whose source name matched no T1S supplier carry no supplier_id, and keying on the id alone
// put every one of them in ONE row under whichever name came first -- the 2026-09-30 AP aging showed
// Mandaue Foam at 9,235.31 because six unmatched vendors (Cebu Air, Tianjin, MR DIY, ...) and two
// unnamed lines were folded into it. The total was right; the rows were not.
function rowKey(item) {
  return item.supplier_id != null ? `id:${item.supplier_id}` : `name:${String(item.supplier_name || '').trim().toUpperCase()}`;
}

async function buildApAging(asOf, filters = {}) {
  const {
    items, unevidenced, unlinked_payments: unlinkedPayments, header_disagreement: headerDisagreement,
  } = await collectOpenApItems(asOf, filters);

  const bySupplier = new Map();
  function supplierRow(item) {
    const key = rowKey(item);
    if (!bySupplier.has(key)) {
      bySupplier.set(key, {
        row_key: key, supplier_id: item.supplier_id ?? null, supplier_name: item.supplier_name || '',
        ...emptyBuckets(), unevidenced_count: 0, unevidenced_amount: 0,
      });
    }
    return bySupplier.get(key);
  }

  for (const item of items) {
    const row = supplierRow(item);
    addToBucket(row, item.balance, item.aging_date, asOf);
    if (item.marked_paid_unevidenced) {
      row.unevidenced_count += 1;
      row.unevidenced_amount += item.balance;
    }
  }

  const rows = [...bySupplier.values()]
    .map((r) => {
      const buckets = {
        current: round2(r.current), d1_30: round2(r.d1_30), d31_60: round2(r.d31_60),
        d61_90: round2(r.d61_90), over_90: round2(r.over_90),
      };
      const total = round2(buckets.current + buckets.d1_30 + buckets.d31_60 + buckets.d61_90 + buckets.over_90);
      return {
        row_key: r.row_key, supplier_id: r.supplier_id, supplier_name: r.supplier_name, ...buckets, total_balance: total,
        unevidenced_count: r.unevidenced_count, unevidenced_amount: round2(r.unevidenced_amount),
      };
    })
    .filter((r) => Math.abs(r.total_balance) >= 0.005
      || [r.current, r.d1_30, r.d31_60, r.d61_90, r.over_90].some((v) => Math.abs(v) >= 0.005))
    // Exclude credit balance (2026-11-13, as on AR Aging): a vendor whose balance nets below zero --
    // it owes us (bill credits, advances) -- is left out, and the totals with it.
    .filter((r) => !filters.excludeCredit || r.total_balance >= 0.005)
    .sort((a, b) => String(a.supplier_name).localeCompare(String(b.supplier_name)));

  const totals = rows.reduce((t, r) => ({
    current: t.current + r.current, d1_30: t.d1_30 + r.d1_30, d31_60: t.d31_60 + r.d31_60,
    d61_90: t.d61_90 + r.d61_90, over_90: t.over_90 + r.over_90, total_balance: t.total_balance + r.total_balance,
    unevidenced_count: t.unevidenced_count + r.unevidenced_count,
    unevidenced_amount: t.unevidenced_amount + r.unevidenced_amount,
  }), { ...emptyBuckets(), total_balance: 0, unevidenced_count: 0, unevidenced_amount: 0 });
  Object.keys(totals).forEach((k) => { totals[k] = round2(totals[k]); });

  // Reported whether or not they are in the numbers, so the page can say what is being left out
  // as readily as what is being counted.
  return {
    as_of: asOf, rows, totals,
    excluded_unevidenced: unevidenced,
    excluded_unlinked_payments: unlinkedPayments,
    header_disagreement: headerDisagreement,
  };
}

// The DETAILS drill-down: the individual open items behind one vendor's balance. Same open-item
// function as the summary, so it cannot disagree with the row it was opened from.
async function buildApAgingSupplierDetails(supplierId, asOf, filters = {}) {
  const [[supplier]] = await pool.query('SELECT id, name FROM suppliers WHERE id = ?', [supplierId]);
  if (!supplier) return null;
  const { items } = await collectOpenApItems(asOf, { ...filters, supplierId });
  return detailsOf(items, asOf, supplier.id, supplier.name);
}

// The Details of a row with no T1S supplier -- an opening item whose source vendor matched none --
// found the way the summary grouped it: by name, among the items with no supplier_id.
async function buildApAgingUnmatchedDetails(name, asOf, filters = {}) {
  const key = rowKey({ supplier_id: null, supplier_name: name });
  const { items } = await collectOpenApItems(asOf, filters);
  return detailsOf(items.filter((i) => i.supplier_id == null && rowKey(i) === key), asOf, null, name);
}

function detailsOf(items, asOf, supplierId, supplierName) {
  const sorted = items
    .map((i) => ({
      type: i.type, reference: i.reference, id: i.id, date: i.date, due_date: i.due_date,
      original_amount: i.original_amount, balance: i.balance,
      days_overdue: Math.max(daysBetween(i.aging_date, asOf), 0),
      po_no: i.po_no, ref_no: i.ref_no, memo: i.memo, location_name: i.location_name,
      marked_paid_unevidenced: i.marked_paid_unevidenced, paid_later: i.paid_later || null,
    }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.reference).localeCompare(String(b.reference)));

  return {
    supplier_id: supplierId,
    supplier_name: supplierName,
    as_of: asOf,
    items: sorted,
    total_balance: round2(sorted.reduce((s, i) => s + i.balance, 0)),
  };
}

// ---- AP Aging Details (Accounting > Reports, 2026-10-09) -- AR Aging Details' twin ----
//
// Every vendor's open documents, grouped by vendor the way AP Aging groups them (rowKey), so a
// vendor's rows always add up to its Total Balance there. Paged by vendor; totals are over the whole
// filtered set, never just the page.
const DETAILS_DEFAULT_PAGE_SIZE = 25;
const DETAILS_MAX_PAGE_SIZE = 200;

function groupApItems(items, asOf) {
  const byVendor = new Map();
  for (const item of items) {
    const key = rowKey(item);
    if (!byVendor.has(key)) {
      byVendor.set(key, { row_key: key, supplier_id: item.supplier_id ?? null, supplier_name: item.supplier_name || '', items: [], total_balance: 0 });
    }
    const g = byVendor.get(key);
    g.items.push({
      type: item.type, trans_date: item.date, trans_no: item.reference, id: item.id ?? null,
      ref_no: item.ref_no || null, memo: item.memo || null, po_no: item.po_no || null,
      date_due: item.due_date || null, age: daysBetween(item.aging_date, asOf),
      original_amount: round2(item.original_amount || 0), open_balance: round2(item.balance),
      location_name: item.location_name || null, marked_paid_unevidenced: !!item.marked_paid_unevidenced,
      paid_later: item.paid_later || null,
    });
    g.total_balance += Number(item.balance || 0);
  }
  return [...byVendor.values()]
    .map((g) => ({
      ...g,
      total_balance: round2(g.total_balance),
      items: g.items.sort((x, y) => String(x.trans_date).localeCompare(String(y.trans_date)) || String(x.trans_no).localeCompare(String(y.trans_no))),
    }))
    .filter((g) => g.items.length > 0)
    .sort((x, y) => String(x.supplier_name).localeCompare(String(y.supplier_name)));
}

async function buildApAgingDetails(asOf, filters = {}) {
  const { items } = await collectOpenApItems(asOf, filters);
  const groups = groupApItems(items, asOf);
  const limit = Math.min(DETAILS_MAX_PAGE_SIZE, Math.max(1, Number(filters.limit) || DETAILS_DEFAULT_PAGE_SIZE));
  const page = Math.max(1, Number(filters.page) || 1);
  const pageGroups = groups.slice((page - 1) * limit, page * limit);
  return {
    as_of: asOf,
    rows: pageGroups,
    page,
    limit,
    total_pages: Math.max(1, Math.ceil(groups.length / limit)),
    page_total: round2(pageGroups.reduce((sum, g) => sum + g.total_balance, 0)),
    totals: {
      open_balance: round2(groups.reduce((sum, g) => sum + g.total_balance, 0)),
      vendor_count: groups.length,
      item_count: groups.reduce((sum, g) => sum + g.items.length, 0),
      unevidenced_count: items.filter((i) => i.marked_paid_unevidenced).length,
      // A vendor whose open documents cancel out exactly has no AP Aging row; it keeps its rows here.
      zero_net_vendor_count: groups.filter((g) => Math.abs(g.total_balance) < 0.005).length,
    },
  };
}

// The whole filtered set, flat -- one row per document with its vendor repeated, for a spreadsheet.
async function buildApAgingDetailsCsv(asOf, filters = {}) {
  const { items } = await collectOpenApItems(asOf, filters);
  const groups = groupApItems(items, asOf);
  const esc = (v) => {
    const t = v == null ? '' : String(v);
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const lines = [['Vendor', 'Type', 'Trans Date', 'Trans #', 'Ref #', 'Memo', 'PO #', 'Date Due', 'Age', 'Original', 'Open Balance', 'Location'].join(',')];
  for (const g of groups) {
    for (const it of g.items) {
      lines.push([g.supplier_name, it.type, String(it.trans_date || '').slice(0, 10), it.trans_no, it.ref_no, it.memo, it.po_no,
        String(it.date_due || '').slice(0, 10), it.age, it.original_amount.toFixed(2), it.open_balance.toFixed(2), it.location_name].map(esc).join(','));
    }
  }
  return { csv: lines.join('\r\n') };
}

// The Vendor picker: suppliers whose name matches, a page at a time.
async function searchApSuppliers(term) {
  const q = `%${String(term || '').trim()}%`;
  const [rows] = await pool.query('SELECT id, name FROM suppliers WHERE name LIKE ? ORDER BY name LIMIT 50', [q]);
  return rows;
}

// The open items of the vendors whose balance is not a credit -- what AP Aging lists with Exclude
// credit balance on -- so its Details extract holds the same vendors as the summary.
function withoutCreditVendors(items) {
  const net = new Map();
  for (const i of items) net.set(rowKey(i), (net.get(rowKey(i)) || 0) + Number(i.balance || 0));
  return items.filter((i) => round2(net.get(rowKey(i))) >= 0.005);
}

module.exports = {
  buildApAging, buildApAgingSupplierDetails, buildApAgingUnmatchedDetails, collectOpenApItems,
  buildApAgingDetails, buildApAgingDetailsCsv, searchApSuppliers, withoutCreditVendors,
};
