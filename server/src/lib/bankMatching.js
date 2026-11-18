// Matching a bank statement to the documents that produced it.
//
// The system PROPOSES; a person CONFIRMS. Nothing here writes a confirmed match -- every match it
// makes lands as "awaiting review" with a confidence saying how it was arrived at, and a
// reconciliation cannot be finished while any proposal is still unreviewed. An auto-matcher that
// quietly decided what cleared would be worse than no auto-matcher at all: it would produce a
// reconciliation that balances and means nothing.
//
// THREE PASSES, strongest first, each claiming what it is sure of before the next runs. Order is
// the whole algorithm -- a weak amount-only guess must never take a document that a later line
// could have claimed by its cheque number.
//
//   1. exact              the statement quotes the document's cheque number AND the amount agrees.
//   1b ref_amount_differs the statement quotes the cheque number and the amount does NOT agree.
//                         Still matched -- a cheque number identifies one cheque, while an amount
//                         identifies a value dozens of cheques share -- and flagged, because the
//                         bank taking a different figure from the one written is precisely what a
//                         reconciliation is for. It will not balance until somebody explains it.
//   2. strong             the transaction date AND the amount agree. Run to exhaustion before
//                         anything looser, so a line never takes a document belonging to another
//                         line that could have matched it exactly.
//   3. strong / weak      the amount agrees and the date is within the window -- a cheque clears
//                         days after it is handed over, so the date rarely agrees exactly. Strong
//                         when only one document could be it, weak when several could, because on
//                         these statements several cheques a week share a round amount and only a
//                         person can say which one the bank took.
//
// Everything left over stays unmatched: statement lines with nothing to match (bank charges,
// interest, a document never entered) and documents the statement does not show (outstanding
// cheques, deposits in transit) -- which is exactly the information a reconciliation exists to
// produce.

// How far apart a statement line and a document may be and still be the same event. A cheque
// clears days after it is handed over, and a deposit posts a day or two after it is made; beyond
// a fortnight the amount agreeing is a coincidence rather than evidence.
const DATE_WINDOW_DAYS = 14;

// Amounts are compared in CENTAVOS as integers. Comparing two DECIMAL(15,2) values through JS
// floats is how 4406.43 fails to equal 4406.43.
const cents = (v) => Math.round(Number(v || 0) * 100);

const daysApart = (a, b) => {
  if (!a || !b) return Number.MAX_SAFE_INTEGER;
  const ms = Math.abs(new Date(String(a).slice(0, 10)) - new Date(String(b).slice(0, 10)));
  return Math.round(ms / 86400000);
};

// Digit runs of 4 or more from a statement line's reference and description. Banks write the
// cheque number in whichever of the two they feel like, padded, prefixed, or buried in a sentence
// -- so pull every plausible number out and see whether one of them IS the document's reference.
function referenceCandidates(line) {
  const text = `${line.reference || ''} ${line.description || ''}`;
  return new Set(
    (text.match(/\d{4,}/g) || [])
      .map((s) => s.replace(/^0+/, ''))
      // An all-zero field means "no cheque number", not cheque number zero. Metrobank writes
      // 0000000000 in the Check Number column on every deposit and transfer; keeping it would turn
      // that into a reference every such line shares, and the first document whose own reference
      // normalised to nothing would be matched to all of them as if the numbers agreed.
      .filter(Boolean),
  );
}

// The digit runs in a DOCUMENT's reference, same treatment as the statement line's.
//
// Stripping every non-digit and welding what is left together looks equivalent and is not: real
// cheque_number values here read "200045270466 - 02/08/2021" -- the number with the cheque date
// appended -- and concatenating gives 20004527046602082021, a twenty-digit figure matching
// nothing, while the sibling stored as a bare "200045270466" matched everything quoting it. The
// document's own number became unreachable. Runs keep 200045270466 addressable as itself.
//
// The FIRST run is the primary key: banks and clerks write the number first and the date after,
// so when two documents answer to the same quoted number, the one for which it is the primary is
// the better bet.
function referenceKeys(movement) {
  const raw = String(movement.reference || '');
  return (raw.match(/\d{4,}/g) || []).map((s) => s.replace(/^0+/, '')).filter(Boolean);
}

const normalisedRef = (movement) => referenceKeys(movement)[0] || null;

// statementLines and movements are plain rows; nothing is written here. Returns the proposals and
// what was left over on both sides.
function proposeMatches(statementLines, movements, { windowDays = DATE_WINDOW_DAYS } = {}) {
  const takenMovements = new Set();
  const takenLines = new Set();
  const proposals = [];

  // Index the book side by amount, so each pass is a lookup rather than a scan of 16,000 rows per
  // statement line.
  const byAmount = new Map();
  for (const m of movements) {
    const key = cents(m.amount);
    if (!byAmount.has(key)) byAmount.set(key, []);
    byAmount.get(key).push(m);
  }

  const available = (key) => (byAmount.get(key) || []).filter((m) => !takenMovements.has(`${m.source_kind}:${m.source_id}`));

  const claim = (line, m, confidence) => {
    takenMovements.add(`${m.source_kind}:${m.source_id}`);
    takenLines.add(line.id);
    proposals.push({
      statement_line_id: line.id,
      source_kind: m.source_kind,
      source_id: m.source_id,
      amount: m.amount,
      confidence,
    });
  };

  // THE CHEQUE NUMBER COMES FIRST, BEFORE ANY AMOUNT IS CONSIDERED.
  //
  // A cheque number identifies one cheque. An amount identifies a value that dozens of cheques
  // share. So when the statement quotes a number we hold on this account, that IS the cheque --
  // and if the amounts then disagree, that is a DISCREPANCY TO REPORT, not a reason to pretend
  // they are unrelated documents. The earlier version required both to agree before matching at
  // all, which quietly hid exactly the case a reconciliation exists to catch: the bank took a
  // different figure from the one written.
  //
  // Indexed by reference rather than scanned, since this pass no longer has an amount to narrow by.
  // Indexed under EVERY digit run the reference contains, so "200045270466 - 02/08/2021" is found
  // by the number as well as by the date somebody appended to it.
  const byRef = new Map();
  for (const m of movements) {
    for (const key of referenceKeys(m)) {
      if (!byRef.has(key)) byRef.set(key, []);
      byRef.get(key).push(m);
    }
  }

  for (const line of statementLines) {
    if (takenLines.has(line.id)) continue;
    const refs = referenceCandidates(line);
    if (!refs.size) continue;

    // Every document whose number this line quotes. Usually one; more only when two documents on
    // the same account somehow carry the same cheque number.
    const hits = [...refs]
      .flatMap((r) => byRef.get(r) || [])
      .filter((m) => !takenMovements.has(`${m.source_kind}:${m.source_id}`));
    if (!hits.length) continue;

    // Prefer the one whose amount also agrees -- that is the ordinary case and the one that needs
    // no further thought. Deduplicated because a document can be reached by more than one of its
    // own digit runs.
    const unique = [...new Map(hits.map((m) => [`${m.source_kind}:${m.source_id}`, m])).values()];
    const agreeing = unique.find((m) => cents(m.amount) === cents(line.amount));
    if (agreeing) {
      claim(line, agreeing, 'exact');
      continue;
    }

    // The number matches and the amount does not. When several documents answer to that number,
    // take the one it is the PRIMARY number for, and failing that the nearest by date -- guessing
    // is unavoidable here, so guess in the order a person would.
    const ranked = [...unique].sort((a, b) => {
      const aPrimary = refs.has(normalisedRef(a)) ? 0 : 1;
      const bPrimary = refs.has(normalisedRef(b)) ? 0 : 1;
      if (aPrimary !== bPrimary) return aPrimary - bPrimary;
      return daysApart(a.txn_date, line.txn_date) - daysApart(b.txn_date, line.txn_date);
    });
    // Matched deliberately, flagged loudly: the reconciliation will not balance until somebody
    // explains the difference, which is the point.
    claim(line, ranked[0], 'ref_amount_differs');
  }

  // Passes 2 and 3 take the MOST CONSTRAINED LINE FIRST -- the one with fewest candidates left.
  //
  // Without that, plain top-to-bottom order loses matches it had no need to lose: two statement
  // lines of the same amount days apart, the first takes whichever document it likes, and the
  // second is left with none in its window and reported unmatched even though its own document was
  // sitting there. Measured on a statement built from real July documents, that cost one match in
  // sixty. A line with one possible document must be allowed to take it before a line with five
  // does. Recomputed each round because every claim changes what is left.
  const remaining = () => statementLines.filter((l) => !takenLines.has(l.id));
  const candidatesWithin = (line, days) => available(cents(line.amount))
    .filter((m) => daysApart(m.txn_date, line.txn_date) <= days)
    .sort((a, b) => daysApart(a.txn_date, line.txn_date) - daysApart(b.txn_date, line.txn_date));

  // Amount and date, in two rounds: the SAME DAY first, then anywhere in the window.
  //
  // Running the same-day round to exhaustion before the loose one is what stops a line dated the
  // 3rd taking a document dated the 5th while the line dated the 5th, which that document
  // actually belongs to, is left with nothing. Same reasoning as taking the most constrained line
  // first, one level up: commit to what is certain before spending anything on what is merely
  // possible.
  const roundsOf = (days, exactDay) => {
    for (;;) {
      const options = remaining()
        .map((line) => ({ line, candidates: candidatesWithin(line, days) }))
        .filter((x) => x.candidates.length > 0)
        // Fewest candidates first: a line with one possible document must be allowed to take it
        // before a line with five does. Recomputed each round because every claim changes what is
        // left.
        .sort((a, b) => a.candidates.length - b.candidates.length);
      if (!options.length) break;
      const { line, candidates } = options[0];
      // On the same day, one candidate is as good as a reference; across the window it is only
      // "nothing else it could be". Several candidates is a guess either way.
      const confidence = candidates.length === 1 ? 'strong' : (exactDay ? 'strong' : 'weak');
      claim(line, candidates[0], confidence);
    }
  };

  // Pass 2 -- the transaction date and the amount both agree.
  roundsOf(0, true);

  // Pass 3 -- the amount agrees and the date is close. A cheque clears days after it is handed
  // over and a deposit posts a day or two after it is made, so the date rarely agrees exactly.
  roundsOf(windowDays, false);

  return {
    proposals,
    unmatchedLines: statementLines.filter((l) => !takenLines.has(l.id)),
    unmatchedMovements: movements.filter((m) => !takenMovements.has(`${m.source_kind}:${m.source_id}`)),
  };
}

// What the reconciliation adds up to, given what has been CONFIRMED.
//
//   statement balance                        what the bank says
//   less deposits the bank has not shown     money in, in transit
//   add back cheques the bank has not paid   money out, still outstanding
//   = adjusted bank balance, which must equal the balance per book
//
// Written out rather than collapsed into one expression because this is the arithmetic somebody
// will check by hand against the printed statement.
function reconciliationSummary({ statementBalance, bookBalance, outstanding }) {
  const depositsInTransit = outstanding
    .filter((m) => Number(m.amount) > 0)
    .reduce((s, m) => s + Number(m.amount), 0);
  const outstandingPayments = outstanding
    .filter((m) => Number(m.amount) < 0)
    .reduce((s, m) => s + Number(m.amount), 0); // negative

  const adjustedBank = Number(statementBalance) + depositsInTransit + outstandingPayments;
  const difference = Number((adjustedBank - Number(bookBalance)).toFixed(2));

  return {
    statement_balance: Number(Number(statementBalance).toFixed(2)),
    deposits_in_transit: Number(depositsInTransit.toFixed(2)),
    outstanding_payments: Number(Math.abs(outstandingPayments).toFixed(2)),
    adjusted_bank_balance: Number(adjustedBank.toFixed(2)),
    book_balance: Number(Number(bookBalance).toFixed(2)),
    difference,
    balanced: Math.abs(difference) < 0.005,
  };
}

module.exports = { DATE_WINDOW_DAYS, proposeMatches, reconciliationSummary, cents, daysApart };
