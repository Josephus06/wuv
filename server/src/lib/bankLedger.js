const pool = require('../db');
const { booksStart, sourceBalance } = require('./openingBalances');

// Every movement that should have hit a bank account, from the documents that caused it.
//
// NOT FROM THE GENERAL LEDGER, and that is measured rather than assumed: of 15,612 cheques only
// 710 carry a journal entry, and bank deposits and bill payments carry none at all. The GL would
// give an almost empty book side to weigh a full bank statement against.
//
// The one exception is the journal typed by hand, which is a document in its own right rather than
// the shadow of one -- see the `journal` source below for why only those, and never the mirrors.
//
// Four sources, unioned the way lib/stockLedger.js unions its six:
//
//   cheque        money out   cheques.account_id          on date_released
//   bill_payment  money out   bill_payments.bank_account_id on date_released
//   deposit       money in    bank_deposits.account_id    on date_created
//   journal       either way  journal_lines.account_id    on journals.date_created
//
// SIGN CONVENTION: positive is money INTO the account, negative is money OUT. The bank statement
// is normalised the same way at import, so the two sides can be compared without either having to
// remember which way round the other counts.
//
// VOIDED DOCUMENTS ARE EXCLUDED. A voided cheque never reached the bank, so it has nothing to
// reconcile against and would sit outstanding for ever.
//
// date_released, not date_created, for both money-out sources: a cheque written in March and
// handed over in May hits the bank in May, and reconciling it against March would leave two
// statements each looking wrong. Deposits and journals have nothing to release, so they are dated
// by date_created.

// The date each source is considered to have hit the bank, per source.
const SOURCE_SQL = {
  cheque: `
    SELECT 'cheque' AS source_kind, c.id AS source_id, c.cheque_no AS doc_no,
           c.cheque_number AS reference, c.date_released AS txn_date,
           c.payee_name AS party, c.memo,
           -c.total_amount AS amount
      FROM cheques c
     WHERE c.account_id = ? AND c.status <> 'void' AND c.date_released IS NOT NULL`,
  bill_payment: `
    SELECT 'bill_payment' AS source_kind, b.id AS source_id, b.bill_payment_no AS doc_no,
           COALESCE(NULLIF(b.check_no, ''), b.reference_no) AS reference, b.date_released AS txn_date,
           b.payee_name AS party, b.memo,
           -b.total_amount AS amount
      FROM bill_payments b
     -- 'voided' is what a voided Bill Payment carries; testing only 'void' left every one in the book.
     WHERE b.bank_account_id = ? AND b.status NOT IN ('void', 'voided') AND b.date_released IS NOT NULL`,
  deposit: `
    SELECT 'deposit' AS source_kind, d.id AS source_id, d.bd_no AS doc_no,
           NULL AS reference, d.date_created AS txn_date,
           NULL AS party, d.memo,
           d.total_amount AS amount
      FROM bank_deposits d
     WHERE d.account_id = ? AND d.status <> 'void'`,
  // The bank charges, checkbook fees, corrections and one-off receipts that no cheque or deposit
  // explains -- 3,550 lines across the bank accounts, and the reason a statement showed movements
  // the book could not account for at all.
  //
  // ONLY HAND-TYPED ENTRIES. A journal carrying source_type is the GL mirror of a document already
  // unioned above: all 728 of them are cheques, and 721 of those reverse a VOIDED cheque, which
  // this ledger deliberately leaves out. Union them and the book double-counts by 50.4M.
  //
  // One row per LINE, not per entry. A journal may touch the same bank account more than once and
  // each touch is its own movement; keying on the line id also keeps (source_kind, source_id)
  // unique, which is what bank_reconciliation_matches relies on to stop a document being cleared
  // twice.
  //
  // 'SAVED' is not a draft -- routes/journals.js writes it on create, after the entry has already
  // been balanced. Only a voided journal is excluded.
  journal: `
    SELECT 'journal' AS source_kind, jl.id AS source_id, j.journal_no AS doc_no,
           NULL AS reference, j.date_created AS txn_date,
           jl.party_name AS party, COALESCE(NULLIF(jl.memo, ''), j.memo) AS memo,
           (jl.debit - jl.credit) AS amount
      FROM journal_lines jl
      JOIN journals j ON j.id = jl.journal_id
     WHERE jl.account_id = ? AND j.source_type IS NULL
       AND j.status <> 'void' AND j.voided_at IS NULL
       AND (jl.debit <> 0 OR jl.credit <> 0)`,
};

// Movements on one account up to and including `asOf`, excluding anything already cleared on ANY
// reconciliation -- that is what "outstanding" means, and the unique key on
// bank_reconciliation_matches is what makes the exclusion trustworthy.
//
// `includeReconciliationId` lets the screen you are working on see its OWN matches, which are
// otherwise excluded by the same rule: while reviewing, a matched item must stay visible.
async function outstandingMovements(accountId, { asOf, includeReconciliationId = null, q = pool } = {}) {
  const parts = [];
  const params = [];
  for (const sql of Object.values(SOURCE_SQL)) {
    parts.push(sql);
    params.push(accountId);
  }

  // Dates are compared as dates. A cheque released ON the statement date belongs to that
  // statement, so the bound is inclusive.
  let dateClause = asOf ? 'AND m.txn_date <= ?' : '';
  const dateParams = asOf ? [asOf] : [];
  // With an opening loaded, everything before the books start is already inside the account's
  // opening balance (lib/openingBalances.js); listing it again as outstanding would ask October's
  // reconciliation to clear years of migrated history.
  const books = await booksStart();
  if (books) { dateClause += ' AND m.txn_date >= ?'; dateParams.push(books.start); }

  const claimed = includeReconciliationId
    ? `AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_matches x
                        WHERE x.source_kind = m.source_kind AND x.source_id = m.source_id
                          AND x.reconciliation_id <> ?)`
    : `AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_matches x
                        WHERE x.source_kind = m.source_kind AND x.source_id = m.source_id)`;
  const claimedParams = includeReconciliationId ? [includeReconciliationId] : [];

  const [rows] = await q.query(
    `SELECT m.* FROM (${parts.join(' UNION ALL ')}) m
      WHERE 1 = 1 ${dateClause} ${claimed}
      ORDER BY m.txn_date, m.source_kind, m.source_id`,
    [...params, ...dateParams, ...claimedParams],
  );
  return rows;
}

// One movement by its (kind, id) -- used when confirming a manual match, so the amount stored on
// the match is read from the document rather than taken from the browser.
async function movement(accountId, sourceKind, sourceId, q = pool) {
  const sql = SOURCE_SQL[sourceKind];
  if (!sql) return null;
  const [rows] = await q.query(
    `SELECT m.* FROM (${sql}) m WHERE m.source_id = ?`, [accountId, sourceId]);
  return rows[0] || null;
}

// The book's own balance for an account as at a date: every movement, cleared or not.
//
// This is the figure the finished reconciliation reports as "balance per book", and it is
// deliberately NOT the sum of what was ticked -- the whole point of the exercise is to show that
// the two agree once outstanding items are allowed for.
async function bookBalance(accountId, asOf, q = pool) {
  const parts = Object.values(SOURCE_SQL);
  const params = parts.map(() => accountId);
  // With an opening loaded and a date on or after the books start: the account's opening balance
  // (the source's own 2025-12-31 figure) plus movements from the start. Before it, history as ever.
  // With the source's figures loaded: its balance up to the date (2025-12-31 plus each month's
  // activity), then this ledger's own movements only after the last source date. Before the
  // cut-over the source's figure IS the book balance.
  const books = await booksStart();
  const day = String(asOf).slice(0, 10);
  if (books && day >= books.first && day < books.start) return Math.round((await sourceBalance(accountId, day)) * 100) / 100;
  const fromOpening = books && day >= books.start;
  const opening = fromOpening ? await sourceBalance(accountId, day) : 0;
  const [[row]] = await q.query(
    `SELECT COALESCE(SUM(m.amount), 0) AS balance FROM (${parts.join(' UNION ALL ')}) m
      WHERE m.txn_date <= ?${fromOpening ? ' AND m.txn_date >= ?' : ''}`,
    fromOpening ? [...params, asOf, books.start] : [...params, asOf],
  );
  return Math.round((opening + Number(row.balance || 0)) * 100) / 100;
}

module.exports = { SOURCE_SQL, outstandingMovements, movement, bookBalance };
