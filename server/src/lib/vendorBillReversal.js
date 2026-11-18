// A Vendor Bill's reversal (2026-10-14): what the bill posts, and whether it is in the ledger at all.
// Shared by routes/vendorBills.js (Cancel) and db/backfill-vendor-bill-reversals.js.
const { computeVendorBillGl, vendorBillDebitLines } = require('./glImpact');
const { booksStart } = require('./openingBalances');

// The entry a bill posts, exactly as the GL has it (lib/glImpact.js getPostedGlLines): the old
// system's own imported entries where there are any, else the computed one -- a PO bill's from its
// header, a standalone bill's from its lines. The reversal journal mirrors these (2026-10-14).
async function postedBillGlRows(db, billId) {
  const [[vb]] = await db.query(
    `SELECT vb.*, coa.account_code, coa.account_name, loc.location_name AS office_location_name
       FROM vendor_bills vb
       LEFT JOIN chart_of_accounts coa ON coa.id = vb.account_id
       LEFT JOIN locations loc ON loc.id = vb.office_location_id
      WHERE vb.id = ?`, [billId]);
  if (!vb) return null;
  const [imported] = await db.query(
    `SELECT g.account_code, g.account_name, g.debit, g.credit
       FROM live_gl_entries g WHERE g.source_type = 'vendor_bill' AND g.source_id = ?`, [billId])
    .catch((e) => { if (e.code === 'ER_NO_SUCH_TABLE') return [[]]; throw e; });
  let glRows;
  if (imported.length) {
    glRows = imported.map((r) => ({ account_code: r.account_code, account_name: r.account_name, debit: Number(r.debit) || 0, credit: Number(r.credit) || 0 }));
  } else {
    // The lines that debit their own account, exactly as the ledger takes them (a PO bill's
    // Non-Inventory / Service lines included -- lib/glImpact.js vendorBillDebitLines).
    const lines = (await vendorBillDebitLines([billId], db)).get(Number(billId)) || [];
    glRows = await computeVendorBillGl(vb, lines);
  }
  return { vb, glRows: glRows.filter((r) => Number(r.debit) || Number(r.credit)) };
}

// Is this bill in the ledger at all? Up to the books start the GL is the old system's own figures
// (lib/openingBalances.js), so a bill dated before it is there only if the old system had it when
// those figures were loaded, or if it was keyed in T1S after the source closed -- those are added
// on top of its figures (lib/glImpact.js preStartVendorBillLines, 2026-10-26). Any other, reversing
// it would take out what was never put in. From the books start, every bill posts.
async function billInLedger(db, vb) {
  const books = await booksStart();
  const dated = String(vb.date_created instanceof Date ? vb.date_created.toISOString() : vb.date_created).slice(0, 10);
  if (!books || dated >= books.start) return true;
  const [[keyed]] = await db.query(
    "SELECT 1 AS y FROM audit_logs WHERE auditable_type = 'VendorBill' AND auditable_id = ? AND event_type = 'Created' AND set_at >= ? LIMIT 1",
    [vb.id, books.start]);
  if (keyed) return true;
  const [[snap]] = await db.query('SELECT MIN(created_at) AS loaded FROM opening_gl_balances WHERE as_of = ?', [books.asOf]);
  if (!snap?.loaded) return true;
  return !vb.created_at || new Date(vb.created_at) <= new Date(snap.loaded);
}

module.exports = { postedBillGlRows, billInLedger };
