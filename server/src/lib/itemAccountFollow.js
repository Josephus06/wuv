// When an item's Expense Account changes, its Vendor Bills in periods still open for A/P follow it
// (asked 2026-10-24: APACER SSD moved from 17800 Tools and Accessories to 17400 Office Equipments,
// and VB-24367 -- September, still open -- kept debiting 17800). A bill in a closed period keeps
// what it posted.
//
//   A bill T1S posts itself (no imported entry): its line's account_id is the item's account, and
//     computeVendorBillGl debits it -- the line simply takes the new account.
//   A bill carrying the source's own entry (live_gl_entries): the debit of that line's amount to the
//     old account is moved to the new one, so GL Impact shows it. For a bill dated before the books
//     start (lib/openingBalances.js booksStart) the ledger is the source's figures, which that entry
//     is not part of, so a reclass journal on the bill's date (Dr new / Cr old) is what moves the
//     balance -- journals keyed in T1S for that period count (glImpact.js preStartT1sJournalLines).
const pool = require('../db');
const { periodLock } = require('./accountingPeriod');
const { booksStart } = require('./openingBalances');
const { assignDocNo } = require('./docNumber');

const r2 = (n) => Number(Number(n || 0).toFixed(2));
const day = (v) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);

async function followItemExpenseAccount({ itemId, oldAccountId, newAccountId, userId }) {
  const out = { bills: 0, journals: [], skippedClosed: [] };
  if (!oldAccountId || !newAccountId || Number(oldAccountId) === Number(newAccountId)) return out;
  const [accts] = await pool.query('SELECT id, account_code, account_name FROM chart_of_accounts WHERE id IN (?)', [[oldAccountId, newAccountId]]);
  const oldAcct = accts.find((a) => Number(a.id) === Number(oldAccountId));
  const newAcct = accts.find((a) => Number(a.id) === Number(newAccountId));
  if (!oldAcct || !newAcct) return out;
  const [[item]] = await pool.query('SELECT item_code, item_type FROM inventories WHERE id = ?', [itemId]);
  const books = await booksStart();

  const [lines] = await pool.query(
    `SELECT vbl.id, vbl.vendor_bill_id, vbl.account_id, vbl.net_of_tax, vbl.department_id,
            vb.bill_no, vb.date_created, vb.office_location_id, vb.purchase_order_id
       FROM vendor_bill_lines vbl JOIN vendor_bills vb ON vb.id = vbl.vendor_bill_id
      WHERE vbl.item_id = ? AND vb.status <> 'cancelled'`, [itemId]);
  const byBill = new Map();
  for (const l of lines) byBill.set(l.vendor_bill_id, [...(byBill.get(l.vendor_bill_id) || []), l]);

  for (const [billId, billLines] of byBill) {
    const b = billLines[0];
    const date = day(b.date_created);
    const preStart = books && date < books.start;
    if (await periodLock(date, 'ap') || (preStart && await periodLock(date, 'other_gl'))) {
      out.skippedClosed.push(b.bill_no);
      continue;
    }
    const [live] = await pool.query(
      "SELECT id, account_code, debit FROM live_gl_entries WHERE source_type = 'vendor_bill' AND source_id = ? ORDER BY id", [billId]);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      let moved = 0;
      const depts = new Map();
      if (live.length) {
        // One entry per line: the old account's debit of the line's own amount.
        const used = new Set();
        for (const l of billLines) {
          const hit = live.find((e) => !used.has(e.id) && String(e.account_code) === String(oldAcct.account_code)
            && Math.abs(Number(e.debit) - Number(l.net_of_tax)) < 0.01);
          if (!hit) continue;
          used.add(hit.id);
          await conn.query('UPDATE live_gl_entries SET account_id = ?, account_code = ?, account_name = ? WHERE id = ?',
            [newAcct.id, newAcct.account_code, newAcct.account_name, hit.id]);
          moved += Number(hit.debit);
          depts.set(l.department_id || null, (depts.get(l.department_id || null) || 0) + Number(hit.debit));
        }
      } else {
        // T1S's own entry: the line carries the account (a Non-Inventory line with none debited 20300).
        const ids = billLines.filter((l) => Number(l.account_id) === Number(oldAccountId)
          || (!l.account_id && b.purchase_order_id && item?.item_type === 'Non-Inventory')).map((l) => l.id);
        if (ids.length) {
          await conn.query('UPDATE vendor_bill_lines SET account_id = ? WHERE id IN (?)', [newAcct.id, ids]);
          moved = billLines.filter((l) => ids.includes(l.id)).reduce((s, l) => s + Number(l.net_of_tax), 0);
        }
      }
      moved = r2(moved);
      if (moved && live.length && preStart) {
        const memo = `Reclass ${b.bill_no}: item ${item?.item_code || itemId} account changed from ${oldAcct.account_code} ${oldAcct.account_name} to ${newAcct.account_code} ${newAcct.account_name}`;
        const [jr] = await conn.query(
          `INSERT INTO journals (journal_no, date_created, location_id, memo, status, total_debit, total_credit, created_by_user_id)
           VALUES ('', ?, ?, ?, 'SAVED', ?, ?, ?)`, [date, b.office_location_id || null, memo.slice(0, 1000), moved, moved, userId]);
        const journalNo = await assignDocNo(conn, { table: 'journals', column: 'journal_no', prefix: 'JRNL-', id: jr.insertId });
        let n = 0;
        for (const [deptId, amt] of depts) {
          await conn.query('INSERT INTO journal_lines (journal_id, line_no, account_id, department_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?, 0, ?)',
            [jr.insertId, ++n, newAcct.id, deptId, r2(amt), b.bill_no]);
          await conn.query('INSERT INTO journal_lines (journal_id, line_no, account_id, department_id, debit, credit, memo) VALUES (?, ?, ?, ?, 0, ?, ?)',
            [jr.insertId, ++n, oldAcct.id, deptId, r2(amt), b.bill_no]);
        }
        await conn.query(
          `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
           VALUES ('Journal', ?, 'Created', 'journal_no', NULL, ?, ?)`, [jr.insertId, journalNo, userId]);
        out.journals.push({ journal_no: journalNo, bill_no: b.bill_no, amount: moved });
      }
      await conn.commit();
      if (moved) out.bills += 1;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }
  return out;
}

module.exports = { followItemExpenseAccount };
