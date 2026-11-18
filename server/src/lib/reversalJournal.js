// The journal that reverses a voided document.
//
// WHY THIS EXISTS. This build derives the general ledger rather than posting it: lib/glImpact.js
// walks the documents and computes each one's entry on the fly. Voiding used to be modelled by
// dropping the document out of that walk -- a cancelled invoice, a void ticket, a void cheque
// simply stopped being visited -- which reverses the ledger by ERASING the original entry from
// the month it was in. A closed period quietly changed its mind about what happened in it, and
// there was nothing on the ledger to say a document had ever been written or withdrawn.
//
// A general ledger does not work that way, and neither did the system this one replaces: there,
// the original entry stands and a REVERSAL journal in the period of the void cancels it out. The
// 728 imported cheque journals are exactly that, and this reproduces them -- same status, same
// source_type/source_id link, the same "Voided from CHK-13640" line memo.
//
// So voiding now posts a mirror image of whatever the document's own GL Impact was, and
// lib/glImpact.js keeps visiting the voided document. The two net to zero across all time, the
// audit trail survives, and no past period is rewritten.
//
// READ WITH lib/glImpact.js. The two are one mechanism: if a document type is made to post a
// reversal here it MUST stop being excluded there, and the other way round. Doing one without the
// other is the double count that this feature was built to fix -- 676 cheque reversals were
// posting against cheques already excluded, 52.5M of ledger that reversed nothing.
const { nextDocNo } = require('./docNumber');

const REVERSAL_STATUS = 'REVERSAL';

// Imported documents carry no void date at all -- every one of the 690 void cheques, 81 cancelled
// invoices and 19 void tickets has a NULL in its voided_at/cancelled_at. A reversal has to be
// dated somewhere, and for those the document's own date is the only honest answer: it puts the
// reversal in the same period as the entry it cancels, so a historical void nets to zero inside
// its own month exactly as it does today. A void happening NOW passes the real date and lands in
// the current period, which is the point of the exercise.
//
// A Date (the void routes pass `new Date()`) is formatted as the Manila business day: String() on a
// Date is "Wed Sep 30 2026 ...", whose first ten characters are not a date, and a void sent without
// a picked reversal date failed on exactly that.
function reversalDate({ voidedAt, documentDate }) {
  const v = voidedAt || documentDate;
  if (v instanceof Date) return v.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  return String(v).slice(0, 10);
}

// Mirror image: what the document debited, the reversal credits.
function mirror(glRows) {
  return glRows
    .map((r) => ({
      account_code: r.account_code,
      account_name: r.account_name || null,
      debit: Number(r.credit) || 0,
      credit: Number(r.debit) || 0,
      department_id: r.department_id || null,
    }))
    .filter((r) => r.debit || r.credit);
}

async function accountIdsByCode(conn, codes) {
  if (!codes.length) return new Map();
  const [rows] = await conn.query(
    'SELECT id, account_code FROM chart_of_accounts WHERE account_code IN (?)', [codes],
  );
  return new Map(rows.map((r) => [String(r.account_code), r.id]));
}

async function existingReversalId(conn, sourceType, sourceId) {
  const [[row]] = await conn.query(
    `SELECT id FROM journals WHERE source_type = ? AND source_id = ? AND status <> 'void' LIMIT 1`,
    [sourceType, sourceId],
  );
  return row?.id || null;
}

// Returns { journalId, journalNo } for the journal written, or null when there was nothing to
// reverse or one already exists.
//
// SILENT ON AN EMPTY ENTRY, deliberately. A document whose GL Impact computes to no rows -- a
// zero-value ticket, or one whose accounts are missing from the chart -- has nothing to cancel,
// and refusing the void over it would block the user from withdrawing a document for a reason
// they cannot see or fix from that screen.
//
// `date` is the reversal date the user picked in the Reversal Journal popup (as live's does). Left
// out, it falls back to reversalDate(). Each line keeps the department its GL row carries.
async function postReversalJournal(conn, {
  sourceType, sourceId, sourceNo, glRows, documentDate, voidedAt = null,
  reason = null, userId = null, locationId = null, date = null,
}) {
  if (await existingReversalId(conn, sourceType, sourceId)) return null;

  const rows = mirror(glRows || []);
  if (!rows.length) return null;

  const byCode = await accountIdsByCode(conn, [...new Set(rows.map((r) => String(r.account_code)))]);
  const resolved = rows.map((r) => ({ ...r, account_id: byCode.get(String(r.account_code)) || null }));

  const totalDebit = Number(resolved.reduce((s, r) => s + r.debit, 0).toFixed(2));
  const totalCredit = Number(resolved.reduce((s, r) => s + r.credit, 0).toFixed(2));

  const lineMemo = `Voided from ${sourceNo}`;
  const memo = [lineMemo, reason].filter(Boolean).join(' - ').slice(0, 1000);

  const journalNo = await nextDocNo('journals', 'journal_no', 'JRNL-', conn);
  const [res] = await conn.query(
    `INSERT INTO journals (journal_no, date_created, location_id, memo, status,
       total_debit, total_credit, source_type, source_id, created_by_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [journalNo, date ? String(date).slice(0, 10) : reversalDate({ voidedAt, documentDate }), locationId, memo, REVERSAL_STATUS,
      totalDebit, totalCredit, sourceType, sourceId, userId],
  );

  let lineNo = 1;
  for (const r of resolved) {
    await conn.query(
      `INSERT INTO journal_lines (journal_id, line_no, account_id, department_id, debit, credit, memo)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [res.insertId, lineNo, r.account_id, r.department_id, r.debit, r.credit, lineMemo.slice(0, 255)],
    );
    lineNo += 1;
  }

  return { journalId: res.insertId, journalNo };
}

// The reversal journal(s) a voided document wrote, for its Related Records tab -- found by the same
// source_type/source_id link postReversalJournal sets. Takes any connection or the pool.
async function listReversalJournals(db, sourceType, sourceId) {
  const [rows] = await db.query(
    `SELECT id, journal_no, date_created, total_debit, status FROM journals
      WHERE source_type = ? AND source_id = ? ORDER BY id`,
    [sourceType, sourceId],
  );
  return rows;
}

module.exports = { postReversalJournal, mirror, reversalDate, REVERSAL_STATUS, listReversalJournals };
