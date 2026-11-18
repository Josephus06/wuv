const { nextDocNo } = require('./docNumber');

// The journal behind a bank-only statement line: a charge, interest credited, an inward credit
// with no advice yet -- anything the bank did that the book has no document for.
//
// WHY POST AT ALL. Reconciling proves `statement + deposits in transit - unpresented cheques =
// book`. A bank record with nothing on the book side breaks that identity by its own amount, and
// only an entry on the book side can close it. Tagging the line without posting cleared the
// needs-review gate and then failed at the balance check, so the reconciliation could never be
// finished. Folding the amount into the summary instead would have been worse: the screen would
// balance while the general ledger still did not know about the charge, which is a false negative
// on the one thing the exercise exists to catch.
//
// SIGN. Statement amounts are signed the same way the book side is -- positive is money INTO the
// account. So a positive line DEBITS the bank (asset up) and credits the named account; a negative
// line CREDITS the bank and debits it. The named account is whatever the person chose: Bank
// Charges for a fee, Interest Income for a credit, a suspense account for something not yet
// identified.
//
// HAND-TYPED ON PURPOSE. source_type is left NULL, which is what makes lib/bankLedger.js count it:
// that source deliberately admits only hand-typed journals and excludes the GL mirrors of
// documents already in the ledger. A journal written here IS the document -- there is nothing else
// for it to mirror. The link back to the statement line lives on the line's posted_journal_id
// rather than in source_type, precisely so the ledger keeps seeing it.

// Which way round the two sides go, and the wording the journal carries.
function buildEntry({ line, bankAccountId, accountId }) {
  const amount = Number(line.amount);
  const magnitude = Math.abs(amount);
  const bankIsDebit = amount > 0;
  return {
    magnitude,
    rows: [
      { account_id: bankAccountId, debit: bankIsDebit ? magnitude : 0, credit: bankIsDebit ? 0 : magnitude },
      { account_id: accountId, debit: bankIsDebit ? 0 : magnitude, credit: bankIsDebit ? magnitude : 0 },
    ],
  };
}

// Writes the journal and returns the id of its BANK line -- which is the id the reconciliation
// matches on, because lib/bankLedger.js keys journal movements on journal_lines.id (one journal can
// touch the same bank account twice, and each touch is its own movement).
async function postBankOnlyJournal(conn, { line, bankAccountId, accountId, note, userId, postDate }) {
  const { magnitude, rows } = buildEntry({ line, bankAccountId, accountId });

  const bankDate = String(line.txn_date).slice(0, 10);
  const dated = postDate || bankDate;

  // The bank's own description first, because that is what the reader will be looking for when
  // they come back to ask what this was; the operator's note second.
  //
  // When the entry is posted on a different day from the one the bank moved the money -- a closed
  // period is the usual reason -- the bank's date is written into the memo. Otherwise the only
  // record of when it actually happened would be the statement line, and the journal on its own
  // would misdate the event.
  const memo = [
    line.description,
    line.reference ? `Ref ${line.reference}` : null,
    dated !== bankDate ? `Bank date ${bankDate}` : null,
    note,
  ].filter(Boolean).join(' - ').slice(0, 500) || 'Bank-only item';

  const journalNo = await nextDocNo('journals', 'journal_no', 'JRNL-', conn);
  const [res] = await conn.query(
    `INSERT INTO journals (journal_no, date_created, memo, status, total_debit, total_credit,
       created_by_user_id, created_at)
     VALUES (?, ?, ?, 'SAVED', ?, ?, ?, NOW())`,
    [journalNo, dated, memo, magnitude, magnitude, userId],
  );
  const journalId = res.insertId;

  let bankLineId = null;
  let lineNo = 1;
  for (const r of rows) {
    const [lr] = await conn.query(
      `INSERT INTO journal_lines (journal_id, line_no, account_id, debit, credit, memo)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [journalId, lineNo, r.account_id, r.debit, r.credit, memo.slice(0, 255)],
    );
    if (r.account_id === bankAccountId && bankLineId === null) bankLineId = lr.insertId;
    lineNo += 1;
  }

  return { journalId, journalNo, bankLineId };
}

// Withdraws a journal this feature posted, when the mark that caused it is undone.
//
// VOIDED, NOT DELETED. It is a general ledger entry; once written it should leave a trace of
// having been written and withdrawn, the same way a cancelled invoice does. Voiding is also what
// takes it back out of lib/bankLedger.js, so the book balance returns to where it was. Deleting
// would do that too and lose the trail.
//
// Returns how many were voided, so a caller can say so.
async function voidBankOnlyJournals(conn, journalIds, userId) {
  const ids = [...new Set((Array.isArray(journalIds) ? journalIds : [journalIds]).filter(Boolean))];
  if (!ids.length) return 0;
  const [r] = await conn.query(
    `UPDATE journals SET status = 'void', voided_at = NOW(), voided_by_user_id = ?
      WHERE id IN (?) AND voided_at IS NULL`,
    [userId || null, ids],
  );
  return r.affectedRows;
}

// Every journal this reconciliation posted, for the paths that tear down a whole workspace at once
// -- re-importing the statement over the top, or deleting the reconciliation.
async function postedJournalIdsFor(conn, reconciliationId) {
  const [rows] = await conn.query(
    'SELECT posted_journal_id FROM bank_statement_lines WHERE reconciliation_id = ? AND posted_journal_id IS NOT NULL',
    [reconciliationId],
  );
  return rows.map((r) => r.posted_journal_id);
}

module.exports = { postBankOnlyJournal, voidBankOnlyJournals, postedJournalIdsFor, buildEntry };
