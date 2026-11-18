// How long each slow report actually takes, so the loading spinner's progress estimate is
// calibrated against something measured rather than guessed.
//
// Measured on the droplet (real migrated volumes -- local and Railway hold far less data, so
// timing either of those would produce an estimate that is wrong everywhere it matters):
//
//   AR Aging, all locations, today      4.6 s   2,332 customers
//   Trial Balance, year to date         7.9 s   219,515 GL lines
//   General Ledger, all time           44.2 s   1,136,976 GL lines
//
// Balance Sheet and Income Statement run through the same getPostedGlLines() as Trial Balance
// and over comparable ranges, so they share its figure.
//
// These are deliberately rounded UP a little. The estimate eases toward the expected time and
// stops at 95%, so an over-estimate simply advances more slowly and still looks alive, whereas an
// under-estimate parks at 95% and reads as stuck -- the exact failure a progress number is
// supposed to prevent.
//
// Re-measure if the underlying queries change. The one that will drift first is General Ledger:
// its cost scales with the whole posted history, so it grows every month the company trades.
// See the financial-reports-perf notes for how these were brought down from 100x worse.

export const REPORT_TIMING = {
  arAging: 5_000,
  trialBalance: 8_000,
  balanceSheet: 8_000,
  incomeStatement: 8_000,
  generalLedger: 45_000,
};

export default REPORT_TIMING;
