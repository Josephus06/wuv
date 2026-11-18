// Content + layout model for the Filing Request Forms workflow in the Manual module (2026-10-22).
//
// Same shape as processFlow.js -- NODES / EDGES / GUIDES / LEGEND on a fixed virtual canvas -- so the
// one chart renderer draws it. Written against the forms screens as they are after the requestor
// started choosing their own Noter and Approver (routes/forms.js chosenRoute): if a label on those
// screens changes, change the matching guide here too.
//
// Colours say WHO acts at each box: the requestor (green), the noter (pink), the approver (blue).
import { NODE_W, NODE_H, DIAMOND } from './processFlow';

export { NODE_W, NODE_H, DIAMOND };

export const CANVAS_W = 1000;
export const CANVAS_H = 1000;

const SPINE_X = 300;       // left edge of the main top-to-bottom column
const SPINE_DIAMOND = 323; // a diamond centred on the same spine
const SIDE_X = 700;        // the noter's step, to the right
const LEFT_X = 40;         // the "returned" loop-back, to the left

export const NODES = [
  { id: 'open-forms', label: 'Open Forms', kind: 'procurement', x: SPINE_X, y: 20 },
  { id: 'pick-form', label: 'Pick the form', kind: 'procurement', x: SPINE_X, y: 120 },
  { id: 'fill-details', label: 'Fill in the details', kind: 'procurement', x: SPINE_X, y: 220 },
  { id: 'choose-people', label: 'Choose Noter & Approver', kind: 'procurement', x: SPINE_X, y: 320 },
  { id: 'save-submit', label: 'Save, then Submit', kind: 'procurement', x: SPINE_X, y: 420 },

  { id: 'has-noter', label: 'Noter chosen?', kind: 'decision', x: SPINE_DIAMOND, y: 520 },
  { id: 'noter-notes', label: 'Noter notes it', kind: 'design', x: SIDE_X, y: 550 },

  { id: 'approver-decides', label: 'Approver approves?', kind: 'decision', x: SPINE_DIAMOND, y: 700 },
  { id: 'approved', label: 'Approved', kind: 'accounting', x: SPINE_X, y: 880 },

  { id: 'returned', label: 'Returned to you', kind: 'procurement', x: LEFT_X, y: 730 },
];

export const EDGES = [
  { from: 'open-forms', to: 'pick-form' },
  { from: 'pick-form', to: 'fill-details' },
  { from: 'fill-details', to: 'choose-people' },
  { from: 'choose-people', to: 'save-submit' },
  { from: 'save-submit', to: 'has-noter' },

  { from: 'has-noter', to: 'noter-notes', fromSide: 'right', toSide: 'left', label: 'Yes', tone: 'yes' },
  { from: 'has-noter', to: 'approver-decides', label: 'No', tone: 'no' },
  { from: 'noter-notes', to: 'approver-decides', fromSide: 'bottom', toSide: 'right', viaX: 640 },

  { from: 'approver-decides', to: 'approved', label: 'Yes', tone: 'yes' },
  { from: 'approver-decides', to: 'returned', fromSide: 'left', toSide: 'right', label: 'No', tone: 'no' },
  { from: 'returned', to: 'fill-details', fromSide: 'top', toSide: 'left', viaX: 130 },
];

export const LEGEND = [
  { kind: 'procurement', label: 'Requestor' },
  { kind: 'design', label: 'Noter' },
  { kind: 'accounting', label: 'Approver' },
  { kind: 'decision', label: 'Decision' },
];

export const GUIDES = {
  'open-forms': {
    where: 'Forms (top menu)',
    route: '/forms',
    who: 'Anyone with access to Forms.',
    summary: 'The Forms page lists every form you have filed and what each one is waiting for. New forms start from here.',
    steps: [
      'Click Forms in the top menu.',
      'Check the Status column for forms you already filed: For Noting, For Approval, Approved or Rejected.',
      'Click Fill Out a Form at the top right to start a new one.',
    ],
    notes: [
      'Search by REQ #, name or department, or filter by form type and status.',
    ],
  },

  'pick-form': {
    where: 'Forms → Fill Out a Form',
    route: '/forms/new',
    who: 'Anyone with access to Forms.',
    summary: 'Every request is one of these forms. HR forms are on the first row; money and travel forms on the second.',
    steps: [
      'HR: Attendance Adjustment, Overtime Request, Leave Application, Undertime Form, Employee Gate Pass, Life & Health Enrollment / Deletion, BPI Deletion.',
      'Finance: Liquidation, Request for Payment, Fund Transfer Request, Business Trip, Revolving Fund, Fuel Request.',
      'Click the one you need. The form opens with its own fields.',
    ],
  },

  'fill-details': {
    where: 'The form you picked',
    who: 'The requestor.',
    summary: 'Check your Department and Name, then fill in the form\'s own fields. Fields marked * are required.',
    steps: [
      'Check Department and Name at the top. They are filled from your account.',
      'Fill in the form itself, e.g. for a Leave Application: the type of leave, the dates and the reason.',
      'Money forms (payment, liquidation, revolving fund, fund transfer) also need their lines: date, particulars and amount.',
    ],
    notes: [
      'A returned form comes back here: open it, click Edit, fix what the reason asks and save.',
    ],
  },

  'choose-people': {
    where: 'The Approval section near the bottom of every form',
    who: 'The requestor.',
    summary: 'You decide who notes and who approves this request. The Approver is required; the Noter is optional.',
    steps: [
      'Approver: starts as the General Manager (Jimmy Wu). Change it if someone else should approve this request.',
      'Noter: leave it as None to send the form straight to the Approver, or pick someone, such as your supervisor or department head, to note it first.',
    ],
    notes: [
      'You cannot pick yourself, and the Noter and the Approver have to be two different people.',
      'Only the people you choose can note and approve the form.',
    ],
  },

  'save-submit': {
    where: 'The bottom of the form, then the form itself',
    who: 'The requestor.',
    summary: 'Saving keeps the form as a Draft, and nobody is told yet. Submitting sends it.',
    steps: [
      'Add any Remarks the approver should know, then click Save.',
      'The saved form opens. Attach any files it needs, such as a receipt or a medical certificate.',
      'Click Submit. The Noter, or the Approver if you chose no Noter, is notified right away.',
    ],
    notes: [
      'A draft saved before 22 October 2026 has no Approver yet: click Edit, pick one, save, then submit.',
    ],
  },

  'has-noter': {
    where: 'Decided by your choice in the Approval section',
    route: '/forms',
    who: 'Automatic.',
    summary: 'With a Noter the form waits for them first (status For Noting). With none it goes straight to the Approver (status For Approval).',
    steps: [
      'Noter chosen: the form reads For Noting until the Noter notes it.',
      'No Noter: the form reads For Approval as soon as it is submitted.',
    ],
    notes: [
      'While nobody has noted it yet you can still change the Noter: Edit the form and save. Removing the Noter moves it straight to For Approval.',
    ],
  },

  'noter-notes': {
    where: 'Forms → Approval Queue → Submitted tab',
    route: '/forms/approval',
    who: 'The Noter chosen on the form.',
    summary: 'The Noter checks the request before it reaches the Approver.',
    steps: [
      'Open the notification, or go to Forms → Approval Queue; the form is under the Submitted tab.',
      'Click Review to open it and read it.',
      'Click Note to pass it on to the Approver, or Reject with a reason to send it back to the requestor.',
    ],
  },

  'approver-decides': {
    where: 'Forms → Approval Queue → Noted tab',
    route: '/forms/approval',
    who: 'The Approver chosen on the form.',
    summary: 'The Approver makes the decision.',
    steps: [
      'Open the notification, or go to Forms → Approval Queue; the form is under the Noted tab.',
      'Click Review to open it.',
      'Click Approve, or Reject and give the reason.',
    ],
    notes: [
      'Only the person chosen as Approver can approve the form.',
    ],
  },

  approved: {
    where: 'Forms',
    route: '/forms',
    who: 'The requestor is notified.',
    summary: 'The request is approved. A few forms have one more step after approval.',
    steps: [
      'Overtime for someone else: the employee accepts or declines it, and the actual time worked is confirmed afterwards.',
      'Employee Gate Pass: the guard records Time OUT and Time IN.',
      'Fuel Request for a Fleet vehicle: added to that vehicle\'s fuel log automatically.',
      'Request for Payment, Liquidation, Fund Transfer: Accounting raises the voucher or bill from it.',
    ],
  },

  returned: {
    where: 'Forms → your form',
    route: '/forms',
    who: 'The requestor.',
    summary: 'A rejected form comes back to you with the reason (and, on money forms, a remark on the lines concerned).',
    steps: [
      'Open the form and read the reason at the top.',
      'Click Edit, fix what was asked, and save.',
      'It goes back to the Noter or Approver automatically. There is nothing else to submit.',
    ],
  },
};
