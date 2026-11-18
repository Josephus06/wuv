const pool = require('../db');

// What is sitting in the parking accounts (23100 Deposit, 23200 Disbursement) waiting to be
// identified.
//
// WHY THIS EXISTS. Those accounts carry exclude_from_reports, so nothing in the Trial Balance,
// Balance Sheet, Income Statement or General Ledger totals them -- that was asked for, and the
// cost is that the money became invisible. A suspense account only works because somebody looks at
// it and asks why something is still there. This is that look, and the nightly reminder built on
// it is what makes it happen without anyone remembering to.
//
// THE BALANCE IS SUPPOSED TO BE ZERO. Every item here is a bank movement with no document behind
// it yet. When the document arrives and the statement line is matched to it, the parked journal is
// voided and the item leaves this report by itself. Anything that stays is either paperwork that
// never came or an entry nobody chased.
//
// LIVE ENTRIES ONLY: a voided journal is settled, not outstanding, and must not be counted.
//
// The route back to where it came from is bank_statement_lines.posted_journal_id, which is how a
// row here can name the reconciliation, the bank account and the bank's own description of the
// line -- the things somebody needs in order to go and ask about it.

const PARKED_JOIN = `
    FROM journal_lines jl
    JOIN journals j ON j.id = jl.journal_id AND j.voided_at IS NULL AND j.status <> 'void'
    JOIN chart_of_accounts c ON c.id = jl.account_id AND c.exclude_from_reports = 1`;

// One row per parking account: how much is in it and how old the oldest item is.
async function parkedSummary(q = pool) {
  const [rows] = await q.query(
    `SELECT c.id AS account_id, c.account_code, c.account_name,
            COUNT(*) AS items,
            ROUND(SUM(jl.debit - jl.credit), 2) AS net_debit,
            ROUND(SUM(ABS(jl.debit - jl.credit)), 2) AS gross,
            MIN(j.date_created) AS oldest,
            DATEDIFF(CURDATE(), MIN(j.date_created)) AS oldest_days
       ${PARKED_JOIN}
      GROUP BY c.id, c.account_code, c.account_name
      ORDER BY c.account_code`);
  return rows.map((r) => ({
    ...r,
    // Signed the way the account reads: Deposit holds credits (money in), Disbursement debits.
    balance: Number(r.net_debit),
    items: Number(r.items),
  }));
}

// Every individual item, with enough context to go and chase it.
async function parkedItems({ accountCode = null, q = pool } = {}) {
  const params = [];
  let where = '';
  if (accountCode) { where = 'WHERE c.account_code = ?'; params.push(accountCode); }
  const [rows] = await q.query(
    `SELECT c.account_code, c.account_name,
            j.id AS journal_id, j.journal_no, j.date_created AS posted_on, j.memo,
            ROUND(jl.debit - jl.credit, 2) AS amount,
            DATEDIFF(CURDATE(), j.date_created) AS age_days,
            l.id AS statement_line_id, l.txn_date AS bank_date, l.description AS bank_description,
            l.reference AS bank_reference,
            r.id AS reconciliation_id, r.recon_no, r.status AS reconciliation_status,
            ba.account_code AS bank_account_code, ba.account_name AS bank_account_name,
            u.display_name AS posted_by
       ${PARKED_JOIN}
       LEFT JOIN bank_statement_lines l ON l.posted_journal_id = j.id
       LEFT JOIN bank_reconciliations r ON r.id = l.reconciliation_id
       LEFT JOIN chart_of_accounts ba ON ba.id = r.account_id
       LEFT JOIN users u ON u.id = j.created_by_user_id
       ${where}
      ORDER BY j.date_created, j.id`,
    params);
  return rows;
}

// Everything the report and the reminder both need, from one read so the two can never disagree
// about whether there is anything to chase.
async function parkedReport(options = {}) {
  const [summary, items] = await Promise.all([parkedSummary(options.q), parkedItems(options)]);
  const outstanding = summary.reduce((s, a) => s + Math.abs(Number(a.balance)), 0);
  return {
    summary,
    items,
    total_items: items.length,
    // Absolute, not net: a 47,309.32 unexplained receipt and a 47,309.32 unexplained payment are
    // two problems, and a net of zero would report them as none.
    total_outstanding: Number(outstanding.toFixed(2)),
    all_clear: items.length === 0,
  };
}

module.exports = { parkedSummary, parkedItems, parkedReport };
