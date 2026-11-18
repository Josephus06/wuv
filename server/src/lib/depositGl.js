// GL Impact of one Bank Deposit (BD-####). Used by the deposit's own GL Impact tab and by the
// ledger-wide lib/glImpact.js, so the two can never tell different stories about the same deposit.
//
//   DR <bank account>              total_amount (the net that reaches the bank)
//   CR 10006 Undeposited Funds     the customer payments' share
//   CR <each Other Deposit acct>   its amount -- money in that no customer payment explains
//   DR <each Cash Back acct>       its amount -- cash kept back instead of banked
//
// The payments' share is not stored; it is whatever the lines do not explain: total - other +
// cash back. For a deposit with no lines -- every one that predates Other Deposit / Cash Back, and
// every one imported from live, whose payments were never linked -- that is the whole total, which
// is exactly what these deposits posted before. See src/db/add-deposit-other-lines.js.
//
// `d` needs total_amount, status, account_code, account_name. `lines` are bank_deposit_lines rows
// joined to chart_of_accounts (account_code, account_name). `uf` is the 10006 account, if found.
const round2 = (v) => Number((Number(v) || 0).toFixed(2));

function depositGlRows(d, lines, uf) {
  const total = round2(d.total_amount);
  if (d.status === 'void' || !total || !d.account_code) return [];
  const other = lines.filter((l) => l.line_type === 'other');
  const cashback = lines.filter((l) => l.line_type === 'cashback');
  const sum = (ls) => ls.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const paymentsShare = round2(total - sum(other) + sum(cashback));

  const rows = [{ account_code: d.account_code, account_name: d.account_name, debit: total, credit: 0 }];
  for (const l of cashback) {
    rows.push({
      account_code: l.account_code, account_name: l.account_name, debit: round2(l.amount), credit: 0,
      department_id: l.department_id || null, location_id: l.location_id || null,
    });
  }
  if (paymentsShare) {
    rows.push({ account_code: uf?.account_code || '10006', account_name: uf?.account_name || 'Undeposited Funds', debit: 0, credit: paymentsShare });
  }
  for (const l of other) {
    rows.push({
      account_code: l.account_code, account_name: l.account_name, debit: 0, credit: round2(l.amount),
      department_id: l.department_id || null, location_id: l.location_id || null,
    });
  }
  return rows;
}

module.exports = { depositGlRows };
