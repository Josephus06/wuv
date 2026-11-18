// One-off: reconstructs a Customer Payment for each imported invoice that has been (part-)
// paid, so paid invoices show their payment in Related Records and the Customer Payments
// module has data.
//
// WHY reconstructed rather than pulled from live: the live API exposes get_customer_payments
// (a list of payment headers) but NO payment->invoice detail endpoint, so which invoices a
// live PAY-#### settled isn't retrievable. Each imported invoice already carries its paid
// amount (gross_amount - amount_due), so this creates one payment per paid invoice for that
// exact amount. Amounts are accurate; the grouping (one payment per invoice) and the
// payment numbers (CPAY-<invoice_no>) are synthetic, not the live PAY-#### records.
//
// Scoped to the 4 migrated reps' 2026 invoices. The invoice's amount_due is left untouched
// (already correct) -- this only records the settlement. Idempotent: re-running replaces
// the payment matched by its synthetic number.
//
// --missing-only ADDED 2026-09-22, and it is the flag to use on a database that has already
// been through this script once. Without it, a whole-company run DELETES and re-creates the
// CPAY payment for all 71,786 paid invoices to fill the ~1,100 that have none -- 70,000-odd
// pointless writes, and on the droplet/office replication pair every one of them crosses the
// link. With it, the run is restricted to invoices that no customer payment line settles at
// all, which is the gap and nothing else.
//
// IT ALSO NETS OFF CREDIT MEMOS, which the unfiltered run never had to think about: 200 of the
// 1,193 invoices in that gap carry a credit memo application. Those amounts were settled by
// CREDIT, not by cash, and recording a cash receipt for them books money the company never
// received. So the amount written is (gross - amount due) - credits already applied; an invoice
// whose credits cover it is skipped outright (9 locally), and one they cover part of gets the
// remainder (191 locally, PHP 577,546.05 of credit netted out).
//
// The netting applies in every mode, not just this one -- it is simply the right amount. It
// changes nothing about the 70,666 payments an earlier full run already wrote unless someone
// re-runs that path, in which case they are rewritten a little smaller and more correctly.
//
//   node src/db/generate-invoice-payments.js --dry-run
//   node src/db/generate-invoice-payments.js
//   node src/db/generate-invoice-payments.js --all-reps --from=2021-01-01 --to=2021-12-31
//   node src/db/generate-invoice-payments.js --all-reps --missing-only --dry-run
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const argVal = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
// The REP_IDS list below only covers the divisions migrated one at a time. A whole-year,
// whole-company migration has no such list -- use --all-reps so no invoice is silently skipped.
const ALL_REPS = process.argv.includes('--all-reps');
const MISSING_ONLY = process.argv.includes('--missing-only');
const FROM = argVal('from', null);
const TO = argVal('to', null);
// Sales-1: Catherine(5), Arjie(7), Jocel(8), Michelle(9).
// Sales-3: Vanessa(69), Jerome(132), Paul(240), Margie(256), Nicole(269).
// Sales-2: Nina(106), Arlene(251), Glenn(266), Jessa(188), Katherine(243).
// Sales-4: Amelyn(39), Lindy(82), Claire(110), Jerusha(169).
// Marketing: Jocelyn(67), Ronel(10).
// Branches (Ayala + SM): Roselyn(244), Eunice(189), Cindy_AYALA(80), Cindy_SM(119), Dexter(33), Alessa(73), Precious(87).
const REP_IDS = [5, 7, 8, 9, 69, 132, 240, 256, 269, 106, 251, 266, 188, 243, 39, 82, 110, 169, 67, 10, 244, 189, 80, 119, 33, 73, 87];
const DEPOSIT_ACCOUNT_CODE = '11000'; // Cash in Bank

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only, nothing written.\n' : 'APPLYING to local.\n');

  const [[deposit]] = await pool.query('SELECT id FROM chart_of_accounts WHERE account_code = ? LIMIT 1', [DEPOSIT_ACCOUNT_CODE]);
  const [[cashMethod]] = await pool.query("SELECT id FROM payment_methods WHERE name = 'CASH' LIMIT 1");

  const where = ["si.status <> 'cancelled'", '(si.gross_amount - si.amount_due) > 0.005'];
  const params = [];
  if (!ALL_REPS) { where.push('so.sales_rep_id IN (?)'); params.push(REP_IDS); }
  // Scope by the SALES ORDER's date, not the invoice's: an order from late in the window is
  // routinely billed after it closes, and filtering on the invoice date would leave those
  // orders' settlements ungenerated.
  if (FROM && TO) { where.push('so.date_created BETWEEN ? AND ?'); params.push(FROM, TO); }
  // The gap, and only the gap: an invoice no payment line settles at all. Deliberately NOT
  // "has no CPAY-<invoice_no>" -- an invoice settled by a payment raised in the app, under its
  // own number, is settled, and re-recording it would double the cash.
  if (MISSING_ONLY) {
    where.push('NOT EXISTS (SELECT 1 FROM customer_payment_lines l WHERE l.sales_invoice_id = si.id)');
  }
  const [invoices] = await pool.query(
    `SELECT si.id, si.invoice_no, si.date_created, si.gross_amount, si.amount_due, COALESCE(si.ewt_amount, 0) AS ewt_amount,
            COALESCE(so.customer_id, ns.customer_id, si.customer_id) AS customer_id, si.office_location_id,
            COALESCE((SELECT SUM(ca.applied_amount) FROM credit_memo_applications ca
                       WHERE ca.sales_invoice_id = si.id), 0) AS credited
     FROM sales_invoices si
     LEFT JOIN sales_orders so ON so.id = si.sales_order_id
     LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id
     WHERE ${where.join(' AND ')}
       AND COALESCE(so.customer_id, ns.customer_id, si.customer_id) IS NOT NULL`,
    params
  );
  console.log(`${invoices.length} paid invoice(s) to record a payment for` +
    `${ALL_REPS ? ' (all reps)' : ` (${REP_IDS.length} preset reps)`}` +
    `${MISSING_ONLY ? ', none of them settled by any payment yet' : ''}${FROM && TO ? ` in ${FROM}..${TO}` : ''}.`);

  // Counted and named, not silently dropped. The customer is the sales order's, else the NSSO's,
  // else the invoice's own (2026-10-09: a standalone invoice -- rent, INV-83455 -- has no order but
  // does name its customer; 599 paid ones had no settlement and read open on AR Aging). Only one
  // with no customer anywhere cannot be given a payment.
  if (MISSING_ONLY) {
    const [orphans] = await pool.query(
      `SELECT si.invoice_no, ROUND(si.gross_amount - si.amount_due, 2) AS paid
         FROM sales_invoices si
         LEFT JOIN sales_orders so ON so.id = si.sales_order_id
         LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id
        WHERE si.status <> 'cancelled' AND (si.gross_amount - si.amount_due) > 0.005
          AND NOT EXISTS (SELECT 1 FROM customer_payment_lines l WHERE l.sales_invoice_id = si.id)
          AND COALESCE(so.customer_id, ns.customer_id, si.customer_id) IS NULL`
    );
    if (orphans.length) {
      console.log(`  ${orphans.length} NOT fixable here -- no customer on the invoice or its order: ` +
        orphans.slice(0, 5).map((o) => `${o.invoice_no} (${o.paid})`).join(', ') +
        (orphans.length > 5 ? ', ...' : ''));
    }
  }

  // What was settled in CASH: the amount drawn off the invoice, less whatever a credit memo
  // already covered. A credit is not a receipt -- see the note at the top of this file.
  //
  // Nor is withheld EWT (2026-10-19): the source counts it as paid, but on GROSS it stays due until
  // the EWT credit memo (BIR 2307) clears it (lib/invoiceDue.js). Settling it here hid it -- CPAY-INV-
  // 81555 for exactly INV-81555's 34.36 EWT, so CM-5695 had nothing to apply to (fixed for the existing
  // ones by reopen-ewt-settled-by-migration.js). So the larger of the EWT and the credit already
  // applied comes off: a credit memo applied is taken to be clearing that EWT first.
  const cashOf = (inv) => Number((
    Number(inv.gross_amount) - Number(inv.amount_due) - Math.max(Number(inv.ewt_amount || 0), Number(inv.credited || 0))
  ).toFixed(2));

  const fullyCredited = invoices.filter((i) => cashOf(i) <= 0.005);
  const payable = invoices.filter((i) => cashOf(i) > 0.005);
  const creditedPartly = payable.filter((i) => Number(i.credited || 0) > 0.005);
  if (fullyCredited.length) {
    const amt = fullyCredited.reduce((s, i) => s + Number(i.gross_amount) - Number(i.amount_due), 0);
    console.log(`  ${fullyCredited.length} skipped -- settled by credit memo, not cash (${amt.toFixed(2)}).`);
  }
  if (creditedPartly.length) {
    const credit = creditedPartly.reduce((s, i) => s + Number(i.credited || 0), 0);
    console.log(`  ${creditedPartly.length} part-credited -- ${credit.toFixed(2)} of credit netted out of the amounts below.`);
  }

  if (DRY_RUN) {
    const total = payable.reduce((s, i) => s + cashOf(i), 0);
    console.log(`Would create ${payable.length} customer payment(s) totalling ${total.toFixed(2)}.`);
    console.log('\nDRY RUN -- nothing written.');
    await pool.end();
    return;
  }

  let created = 0;
  for (const inv of payable) {
    const paid = cashOf(inv);
    const paymentNo = `CPAY-${inv.invoice_no}`;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // Replace any prior synthetic payment for this invoice.
      const [[existing]] = await conn.query('SELECT id FROM customer_payments WHERE customer_payment_no = ?', [paymentNo]);
      if (existing) {
        await conn.query('DELETE FROM customer_payment_lines WHERE customer_payment_id = ?', [existing.id]);
        await conn.query('DELETE FROM customer_payments WHERE id = ?', [existing.id]);
      }
      const [pRes] = await conn.query(
        `INSERT INTO customer_payments
           (customer_payment_no, date_created, customer_id, office_location_id, deposit_account_id,
            payment_method_id, payment_amount, applied_amount, unapplied_amount, receipt_type, memo, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'Official Receipt', ?, 'not_deposited')`,
        [paymentNo, inv.date_created, inv.customer_id, inv.office_location_id, deposit ? deposit.id : null,
          cashMethod ? cashMethod.id : null, paid, paid, `Settlement for ${inv.invoice_no}`]
      );
      await conn.query(
        'INSERT INTO customer_payment_lines (customer_payment_id, sales_invoice_id, applied_amount) VALUES (?, ?, ?)',
        [pRes.insertId, inv.id, paid]
      );
      await conn.commit();
      created += 1;
    } catch (err) {
      await conn.rollback();
      console.warn(`!! ${paymentNo} failed: ${err.message}`);
    } finally {
      conn.release();
    }
  }

  console.log(`\nCreated ${created} customer payment(s).`);
  await pool.end();
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
