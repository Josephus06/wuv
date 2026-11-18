// Content + layout model for the Bank Reconciliation workflow in the Manual module.
//
// Same shape as processFlow.js -- NODES / EDGES / GUIDES / LEGEND on a fixed virtual canvas -- so
// the one chart renderer draws either. See that file for how the layout model works.
//
// The steps are written against the real buttons in this build (Accounting > Manage Accounting >
// Bank Reconciliation). If a label on that screen changes, change the matching guide here too.
import { NODE_W, NODE_H, DIAMOND } from './processFlow';

export { NODE_W, NODE_H, DIAMOND };

export const CANVAS_W = 1040;
export const CANVAS_H = 1400;

const SPINE_X = 300;       // left edge of the main top-to-bottom column
const SPINE_DIAMOND = 323; // a diamond centred on the same spine
const SIDE_X = 700;        // the per-line branch, to the right of the spine
const SIDE_DIAMOND = 723;
const LEFT_X = 40;         // the "it does not balance" loop-back, to the left

export const NODES = [
  { id: 'get-statement', label: 'Get the bank statement', kind: 'accounting', x: SPINE_X, y: 20 },
  { id: 'new-recon', label: 'New Reconciliation', kind: 'accounting', x: SPINE_X, y: 120 },
  { id: 'import', label: 'Import Statement', kind: 'accounting', x: SPINE_X, y: 220 },
  { id: 'auto-match', label: 'System matches each line', kind: 'accounting', x: SPINE_X, y: 320 },

  { id: 'line-matched', label: 'Line matched?', kind: 'decision', x: SPINE_DIAMOND, y: 420 },
  { id: 'match-right', label: 'Match correct?', kind: 'decision', x: SPINE_DIAMOND, y: 594 },
  { id: 'confirm', label: 'Confirm', kind: 'accounting', x: SPINE_X, y: 768 },

  // The right-hand branch: a line the system could not match, or matched wrongly.
  { id: 'bank-only', label: 'No document in the book?', kind: 'decision', x: SIDE_DIAMOND, y: 420 },
  { id: 'mark-bank-charge', label: 'Mark as Bank charge', kind: 'accounting', x: SIDE_X, y: 594 },
  { id: 'find-document', label: 'Find the document', kind: 'accounting', x: SIDE_X, y: 768 },

  { id: 'all-decided', label: 'Every line decided?', kind: 'decision', x: SPINE_DIAMOND, y: 880 },
  { id: 'balanced', label: 'Difference = 0.00?', kind: 'decision', x: SPINE_DIAMOND, y: 1054 },
  { id: 'reconcile', label: 'Reconcile', kind: 'accounting', x: SPINE_X, y: 1228 },

  // The left-hand loop-back: it does not balance yet.
  { id: 'investigate', label: 'Find what is missing', kind: 'accounting', x: LEFT_X, y: 1054 },
];

export const EDGES = [
  { from: 'get-statement', to: 'new-recon' },
  { from: 'new-recon', to: 'import' },
  { from: 'import', to: 'auto-match' },
  { from: 'auto-match', to: 'line-matched' },

  { from: 'line-matched', to: 'match-right', label: 'Yes', tone: 'yes' },
  { from: 'line-matched', to: 'bank-only', fromSide: 'right', toSide: 'left', label: 'No', tone: 'no' },

  { from: 'match-right', to: 'confirm', label: 'Yes', tone: 'yes' },
  { from: 'match-right', to: 'find-document', fromSide: 'right', toSide: 'left', label: 'No', tone: 'no' },

  { from: 'bank-only', to: 'mark-bank-charge', label: 'Yes', tone: 'yes' },
  { from: 'bank-only', to: 'find-document', fromSide: 'right', toSide: 'right', viaX: 950, label: 'No', tone: 'no' },

  { from: 'confirm', to: 'all-decided' },
  // Both right-hand outcomes rejoin the spine at the same place: the line now has a decision.
  { from: 'mark-bank-charge', to: 'all-decided', fromSide: 'bottom', toSide: 'right', viaX: 640 },
  { from: 'find-document', to: 'all-decided', fromSide: 'bottom', toSide: 'right', toOffset: 20, viaX: 600 },

  { from: 'all-decided', to: 'balanced', label: 'Yes', tone: 'yes' },
  // Not every line decided: back to the statement to work the rest.
  { from: 'all-decided', to: 'line-matched', fromSide: 'left', toSide: 'left', viaX: 200, label: 'No', tone: 'no' },

  { from: 'balanced', to: 'reconcile', label: 'Yes', tone: 'yes' },
  { from: 'balanced', to: 'investigate', fromSide: 'left', toSide: 'right', label: 'No', tone: 'no' },
  { from: 'investigate', to: 'line-matched', fromSide: 'top', toSide: 'left', toOffset: 20, viaX: 130 },
];

export const LEGEND = [
  { kind: 'accounting', label: 'Accounting' },
  { kind: 'decision', label: 'Decision' },
];

export const GUIDES = {
  'get-statement': {
    where: 'Your bank, not this system',
    who: 'Whoever downloads the statement — Accounting, usually.',
    summary: 'Everything here is checked against one document: the statement for one bank account for one month. Get that first, in a file the system can read.',
    steps: [
      'Download the statement from the bank as CSV or Excel. A legacy .xls is fine — so are .xlsx and .csv.',
      'Export ONE MONTH. Metrobank Business Online defaults to "Last 12 Months", which will pull a year of lines into a single month\'s reconciliation.',
      'Note the closing balance the statement shows. That is the figure everything is reconciled back to.',
    ],
    notes: [
      'A PDF statement cannot be imported. Ask the bank for the spreadsheet export, or key the lines into one.',
      'The file is read by its contents, not its extension, so a statement saved with the wrong suffix still imports.',
    ],
  },

  'new-recon': {
    where: 'Accounting → Manage Accounting → Bank Reconciliation',
    route: '/accounting/bank-reconciliation',
    who: 'Needs can_add on Bank Reconciliation.',
    summary: 'Opens the working sheet for one account and one month. Only one reconciliation can be open per account at a time.',
    steps: [
      'Click New Reconciliation.',
      'Pick the bank account — the operating account, e.g. "11301 EWB Disb Acct. 200001413952", not the bank\'s summary heading.',
      'Pick the statement month. It resolves to the last day of that month, which is the date the closing balance belongs to.',
      'Opening Balance is offered from where that account last reconciled. Confirm it against the statement.',
      'Enter the Closing Balance per Statement exactly as the bank shows it, centavos included.',
      'Click Start.',
    ],
    notes: [
      'The line under the account says when it was last reconciled and to what balance.',
      'Opening Balance is recorded for the audit trail; the arithmetic works off the closing position.',
      'If an open reconciliation already exists on that account you will be told — finish or delete it first.',
    ],
  },

  import: {
    where: 'Inside the reconciliation → Import Statement',
    who: 'Needs can_add on Bank Reconciliation.',
    summary: 'The file is shown to you first, and you say which column means what. No bank layout is assumed, because no two of these banks agree.',
    steps: [
      'Click Import Statement and choose the file. The first rows are displayed as a grid.',
      'Set Header rows to skip so the greyed rows cover the bank\'s letterhead — for the Metrobank export that is 12.',
      'Map Date, Description and Reference / cheque no. to their columns. The preview\'s own numbering is what to go by; banks leave blank columns between the real ones.',
      'If the statement has separate Debit and Credit columns leave that box ticked and map both. Otherwise untick it and map the single signed Amount column.',
      'Click Import and Match.',
    ],
    notes: [
      'The Reference column is optional but worth mapping — it is what lets a cheque be matched by its number rather than by amount alone.',
      'Rows with no date or a zero amount are skipped, which is how subtotals and footers are left out.',
      'Re-importing replaces the statement and releases everything it had matched. Confirmed work is lost, and any journal a Bank charge posted is voided with it, so re-import only to correct the file or the mapping.',
    ],
  },

  'auto-match': {
    where: 'Runs automatically after the import',
    who: 'No action needed.',
    summary: 'Every statement line is compared against the cheques, bill payments and bank deposits recorded on that account, and a match is PROPOSED. Nothing is cleared — every proposal waits for a person.',
    steps: [
      'The cheque number is tried first, on its own. A number identifies one cheque; an amount identifies a value dozens of cheques share.',
      'If the number matches but the amounts differ, the line is still matched and flagged AMOUNT DIFFERS in red — that is a discrepancy to explain, not a reason to call them unrelated.',
      'Otherwise the same transaction date and the same amount, which is the ordinary case.',
      'Otherwise the same amount within a fortnight — a cheque clears days after it is handed over.',
    ],
    notes: [
      'The badge on each line says how the match was reached: "Cheque no. matches", "Only candidate", or "Several candidates — check".',
      'Re-run Matching proposes again for anything still undecided. It never touches a match you have already confirmed.',
      'A document already cleared on another reconciliation can never be proposed again.',
    ],
  },

  'line-matched': {
    where: 'The Statement tab',
    who: 'Needs can_edit on Bank Reconciliation.',
    summary: 'Work down the list. Each line is either matched to something, or it is not — and both need a decision from you before the period can close.',
    steps: [
      'A line showing a document under "Matched to" has a proposal waiting for review.',
      'A line showing "—" found nothing, and is either a bank charge or a document the matcher could not identify.',
    ],
    notes: [
      'The counter above the table says how many are left: "0 confirmed · 0 bank charges · 194 to go".',
      'Nothing is cleared until you say so, so there is no harm in working through it over more than one sitting.',
    ],
  },

  'match-right': {
    where: 'The Statement tab',
    who: 'Needs can_edit on Bank Reconciliation.',
    summary: 'The system proposes; you decide. This is the step the whole feature exists for — an auto-matcher that quietly decided what cleared would produce a reconciliation that balances and means nothing.',
    steps: [
      'Check the document against the line: the payee, the date, and the amount.',
      'Pay most attention to "Several candidates — check" — several documents shared that amount and the nearest by date was proposed.',
      '"Cheque no. matches" is as close to certain as this gets; those can be confirmed quickly.',
      'A red "AMOUNT DIFFERS" means the cheque number matched but the figures do not. Find out why before confirming.',
    ],
    notes: [
      'Unmatch releases the document and puts the line back to needing a decision.',
      'Find lets you pick the right document by hand, searching by number, cheque number or payee.',
    ],
  },

  confirm: {
    where: 'The Statement tab → Confirm',
    who: 'Needs can_edit on Bank Reconciliation.',
    summary: 'Confirming is what actually clears the document. Once cleared it leaves the outstanding list and can never be cleared again on any other reconciliation.',
    steps: [
      'Click Confirm on the line.',
      'The status becomes Confirmed and the counter drops by one.',
    ],
    notes: [
      'Confirmed by mistake? Unmatch puts it back and releases the document.',
      'A document clears exactly once, ever — that constraint is what stops the same cheque being ticked off on two statements, both of which would balance and one of which would be wrong.',
    ],
  },

  'bank-only': {
    where: 'The Statement tab',
    who: 'Needs can_edit on Bank Reconciliation.',
    summary: 'Some lines have no document in the book — the bank did it on its own, or the paperwork has not reached accounting. Those are posted rather than matched.',
    steps: [
      'Ask whether a document for this exists anywhere in the system.',
      'If it does, Find it — that is always the better answer, because it settles the line against the real thing.',
      'If it does not, use Bank charge. That covers both what the bank did on its own (a service charge, interest, a debit memo, a wire fee) and what you simply have no papers for yet (an inward credit with no advice).',
    ],
    notes: [
      'Marking a line this way when a document really does exist will let the reconciliation finish while leaving that cheque outstanding for ever. Use Find when in doubt.',
      'No document YET is not the same as no document EVER. Park it in Deposit or Disbursement rather than coding it to a real account you are guessing at — a deposit booked to Bank Charges makes that expense read wrong by the whole amount.',
      'When the papers arrive later, open the line and use Find to match the real document. The parked journal is voided automatically, so the book counts it once.',
    ],
  },

  'mark-bank-charge': {
    where: 'The Statement tab → Bank charge',
    who: 'Needs can_edit on Bank Reconciliation, AND the right to add a journal — this writes to the general ledger.',
    summary: 'Posts the journal entry for the line and settles it, so the book moves and the difference closes.',
    steps: [
      'Click Bank charge on the line.',
      'Check the account. It is preselected by direction: money in goes to Deposit, money out to Disbursement. Change it when the item is genuinely identified — a real bank fee belongs in Bank Charges, interest in Interest Income.',
      'Check "Post on". It defaults to the day the bank moved the money, which is the right answer whenever that period is open.',
      'Add a note if the bank description is not clear enough.',
      'Press Post and mark. The dialog shows the entry it is about to write — "Debit … , credit …" — before you commit it.',
    ],
    notes: [
      'IT POSTS A JOURNAL. Do not then raise the entry again by hand: the book would count it twice and every later reconciliation would be out by that amount. The line shows which journal it wrote — "Posted JRNL-#### to Deposit".',
      'Undoing the mark withdraws the journal. Unmatch, matching a real document over it, re-marking to another account, and deleting the reconciliation all void it rather than leaving it behind.',
      'A closed period is refused, and says so in the dialog. Change "Post on" to a date in an open period on or before the statement date; the bank\'s own date is kept in the journal memo.',
      'The date must be on or before the statement date. The book balance and the outstanding list are both taken AS AT that date, so a later entry would post and still leave the difference open.',
      'Any proposed match on that line is dropped, releasing the document.',
    ],
  },

  'find-document': {
    where: 'The Statement tab → Find',
    who: 'Needs can_edit on Bank Reconciliation.',
    summary: 'Match a line to its document by hand, for what the matcher could not work out or got wrong.',
    steps: [
      'Click Find on the line.',
      'It opens showing outstanding documents for exactly that amount, which is nearly always what it is.',
      'Search by document number, cheque number or payee. Untick "Only documents for exactly this amount" if the figures genuinely differ.',
      'Click Match on the right document. It is confirmed in the same action.',
    ],
    notes: [
      'Only OUTSTANDING documents are offered — anything already cleared elsewhere is deliberately absent.',
      'Nothing to find? The document may not have been entered at all. Raise it first, then Re-run Matching.',
    ],
  },

  'all-decided': {
    where: 'The Statement tab',
    who: 'Needs can_edit on Bank Reconciliation.',
    summary: 'Every line must end up confirmed or marked as a bank charge. The Reconcile button stays disabled until the count reaches zero.',
    steps: [
      'Read the line above the table: "N statement line(s) still need a decision."',
      'Keep working down the list until it says none.',
    ],
    notes: [
      'The server refuses to reconcile as well, so the button is not the only guard.',
    ],
  },

  balanced: {
    where: 'The panel at the top of the reconciliation',
    who: 'Needs can_edit on Bank Reconciliation.',
    summary: 'The arithmetic that makes it a reconciliation rather than a checklist: the bank\'s closing balance, adjusted for what the bank has not yet seen, must equal the balance per book.',
    steps: [
      'Balance per bank statement — what you entered from the statement.',
      'Add deposits in transit — money you banked that the bank has not yet credited.',
      'Less outstanding cheques and payments — cheques you issued that have not been presented.',
      'That gives the adjusted bank balance, which must equal the balance per book.',
      'The Difference must read 0.00.',
    ],
    notes: [
      'The Outstanding tab lists exactly what is making up those two adjustments.',
      'Expect a very large outstanding list on an account\'s FIRST reconciliation — everything ever issued and never cleared appears. It settles from the second month on.',
    ],
  },

  investigate: {
    where: 'The Statement and Outstanding tabs',
    who: 'Needs can_edit on Bank Reconciliation.',
    summary: 'A difference that will not go to zero is information: something is wrong, and it is usually one of four things.',
    steps: [
      'Check the Closing Balance per Statement against the statement — a typo here can never be reconciled away.',
      'Look for a line flagged AMOUNT DIFFERS: the bank took a different figure from the one written.',
      'Look through Outstanding for something that should have cleared — a cheque presented but matched to the wrong line.',
      'Check whether a document is missing from the books entirely. Enter it, then Re-run Matching.',
      'A line the bank shows and the book has never heard of cannot be matched to anything — it has to be POSTED. Use Bank charge; until something puts it in the book the difference cannot close.',
    ],
    notes: [
      'The difference is the size of the problem, which is often the clue: it may be exactly one line\'s amount, or twice it if something was matched the wrong way round.',
      'A difference equal to a line you already marked as a Bank charge means its journal was refused or has been withdrawn — open that line and check.',
      'Deposits dated before 2015 and cheques released with future dates exist in this data and will sit outstanding.',
    ],
  },

  reconcile: {
    where: 'Inside the reconciliation → Reconcile',
    route: '/accounting/bank-reconciliation',
    who: 'Needs can_approve on Bank Reconciliation.',
    summary: 'Closes the period. Every document confirmed on it is now cleared and will not appear on any future reconciliation.',
    steps: [
      'Check the Difference reads 0.00 and no line still needs a decision.',
      'Click Reconcile.',
      'Use Export for the reconciliation statement — balance per bank, deposits in transit, outstanding cheques, balance per book, plus the outstanding list and any bank charges.',
    ],
    notes: [
      'Reopen unlocks a finished reconciliation without throwing away the review: the matches stay, so fixing one line does not mean re-checking the other four hundred.',
      'Delete is only offered while it is open, and releases every document it had claimed.',
      'Next month, the closing balance you entered here is offered as that account\'s opening balance.',
    ],
  },
};
