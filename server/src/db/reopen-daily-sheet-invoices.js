// Reopens the Cuts for Tots invoices made from the daily sales sheet (Import POS Sales, keys DAILY:*).
//
// Until 2026-11-20 the sheet's import also paid each invoice -- GC / GCash / Cash Customer Payments
// and a Cash Short and Over journal -- so every salon invoice read Paid In Full. Asked: "make the
// cuts for tots invoices become OPEN in status", the money to be recorded with Accept Payment. This
// removes those import-made payments and journals and sets each invoice back to Open with its full
// amount due. The import no longer makes them (lib/posSalesImport.js).
//
// Only what the import made is touched: payments whose memo says "from daily sales sheet" and that
// apply to nothing else, and journals named "Cash short/over ... (INV-n)". An invoice whose payment
// is already in a Bank Deposit is left alone and listed, as is any invoice also paid by hand.
//
//   node src/db/reopen-daily-sheet-invoices.js           (dry run: lists what it would do)
//   node src/db/reopen-daily-sheet-invoices.js --apply
require('dotenv').config();
const pool = require('../db');

const APPLY = process.argv.includes('--apply');

(async () => {
  const conn = await pool.getConnection();
  try {
    console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${APPLY ? '' : '  -- DRY RUN, nothing is written (add --apply)'}`);
    const [invoices] = await conn.query(
      `SELECT id, invoice_no, date_created, gross_amount, amount_due, status, office_location_id
         FROM sales_invoices WHERE pos_import_key LIKE 'DAILY:%' AND status <> 'cancelled' ORDER BY date_created, id`);
    const totals = { invoices: 0, payments: 0, journals: 0, amount: 0 };
    const skipped = [];
    if (APPLY) await conn.beginTransaction();
    for (const inv of invoices) {
      const [pays] = await conn.query(
        `SELECT cp.id, cp.customer_payment_no, cp.memo, cp.deposit_id, cp.status, cp.payment_amount,
                (SELECT COUNT(*) FROM customer_payment_lines x WHERE x.customer_payment_id = cp.id AND (x.sales_invoice_id IS NULL OR x.sales_invoice_id <> ?)) AS other_lines
           FROM customer_payment_lines l JOIN customer_payments cp ON cp.id = l.customer_payment_id
          WHERE l.sales_invoice_id = ?`, [inv.id, inv.id]);
      const mine = pays.filter((p) => /from daily sales sheet/i.test(p.memo || '') && !Number(p.other_lines));
      const others = pays.filter((p) => !mine.includes(p) && p.status !== 'voided');
      const banked = mine.filter((p) => p.deposit_id);
      if (others.length || banked.length) {
        skipped.push(`${inv.invoice_no}: ${others.length ? `also paid by ${others.map((p) => p.customer_payment_no).join(', ')}` : ''}${banked.length ? ` deposited (${banked.map((p) => p.customer_payment_no).join(', ')})` : ''}`);
        continue;
      }
      const [journals] = await conn.query(
        "SELECT id, journal_no, memo FROM journals WHERE memo LIKE ? AND (memo LIKE 'Cash short %' OR memo LIKE 'Cash over %')",
        [`%(${inv.invoice_no})`]);
      if (!mine.length && !journals.length && inv.status === 'saved' && Math.abs(Number(inv.amount_due) - Number(inv.gross_amount)) < 0.005) continue;
      console.log(`${inv.invoice_no} ${String(inv.date_created).slice(0, 15)} ${Number(inv.gross_amount).toFixed(2)}: ${inv.status} -> Open; remove ${mine.map((p) => `${p.customer_payment_no} ${Number(p.payment_amount).toFixed(2)}`).join(', ') || 'no payments'}${journals.length ? `; ${journals.map((j) => j.journal_no).join(', ')}` : ''}`);
      totals.invoices += 1; totals.payments += mine.length; totals.journals += journals.length;
      totals.amount += mine.reduce((s, p) => s + Number(p.payment_amount), 0);
      if (!APPLY) continue;
      if (mine.length) {
        const ids = mine.map((p) => p.id);
        await conn.query('DELETE FROM customer_payment_lines WHERE customer_payment_id IN (?)', [ids]);
        await conn.query('DELETE FROM customer_payments WHERE id IN (?)', [ids]);
      }
      if (journals.length) {
        const ids = journals.map((j) => j.id);
        await conn.query('DELETE FROM journal_lines WHERE journal_id IN (?)', [ids]);
        await conn.query('DELETE FROM journals WHERE id IN (?)', [ids]);
      }
      await conn.query("UPDATE sales_invoices SET amount_due = gross_amount, status = 'saved' WHERE id = ?", [inv.id]);
      await conn.query(
        `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
         SELECT 'SalesInvoice', ?, 'Status Change', 'status', ?, 'saved (reopened: daily sheet payments removed)', id
           FROM users WHERE account_type = 'System Admin' ORDER BY id LIMIT 1`, [inv.id, inv.status]);
    }
    if (APPLY) await conn.commit();
    console.log(`\n${totals.invoices} invoice(s) ${APPLY ? 'reopened' : 'to reopen'}; ${totals.payments} payment(s) (${totals.amount.toFixed(2)}) and ${totals.journals} short/over journal(s) ${APPLY ? 'removed' : 'to remove'}.`);
    if (skipped.length) console.log(`Left as they are (${skipped.length}):\n  ${skipped.join('\n  ')}`);
  } catch (e) {
    if (APPLY) await conn.rollback().catch(() => {});
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
})();
