// Content + layout model for the Process Flow module (/process-flow).
//
// This is the end-to-end order-to-cash flow drawn as a clickable chart: every node
// opens a short "how do I actually do this" manual for that step. The steps are written
// against the real buttons in this build -- if a screen's action label changes, update
// the matching guide here too.
//
// Layout is a fixed virtual canvas (CANVAS_W x CANVAS_H) in px; the page scales it down
// to fit the viewport, so coordinates never need to be responsive. Process nodes are
// NODE_W x NODE_H, decision diamonds are DIAMOND x DIAMOND.

export const CANVAS_W = 1040;
export const CANVAS_H = 2070;
export const NODE_W = 170;
export const NODE_H = 64;
export const DIAMOND = 124;

const SPINE_X = 435;      // left edge of the main top-to-bottom column
const SPINE_DIAMOND = 458; // left edge of a diamond centred on the spine

// kind: 'sales' | 'design' | 'production' | 'procurement' | 'accounting' | 'decision'
export const NODES = [
  { id: 'estimate', label: 'Create Estimate', kind: 'sales', x: SPINE_X, y: 20 },
  { id: 'sales-order', label: 'Generate Sales Order', kind: 'sales', x: SPINE_X, y: 120 },
  { id: 'job-order', label: 'Create Job Order', kind: 'sales', x: SPINE_X, y: 220 },

  { id: 'forward-pms', label: 'Forward to PMS', kind: 'design', x: SPINE_X, y: 320 },
  { id: 'assign-artist', label: 'Assign Artist', kind: 'design', x: SPINE_X, y: 420 },
  { id: 'forward-sales', label: 'Forward JO back to Sales', kind: 'design', x: SPINE_X, y: 520 },
  { id: 'sales-approval', label: 'Sales Approval', kind: 'design', x: SPINE_X, y: 620 },

  { id: 'production', label: 'Production', kind: 'production', x: SPINE_X, y: 720 },
  { id: 'enough-material', label: 'Enough Material?', kind: 'decision', x: SPINE_DIAMOND, y: 810 },
  { id: 'assign-staff', label: 'Assigning Staff', kind: 'design', x: SPINE_X, y: 964 },
  { id: 'damaged-wip', label: 'Damaged?', kind: 'decision', x: SPINE_DIAMOND, y: 1054 },
  { id: 'complete', label: 'Complete', kind: 'production', x: SPINE_X, y: 1208 },
  { id: 'assembly-build', label: 'Assembly Build', kind: 'production', x: SPINE_X, y: 1308 },
  { id: 'quality-control', label: 'Quality Control', kind: 'production', x: SPINE_X, y: 1408 },
  { id: 'damaged-qc', label: 'Damaged?', kind: 'decision', x: SPINE_DIAMOND, y: 1498 },

  { id: 'invoice', label: 'Invoice', kind: 'accounting', x: SPINE_X, y: 1652 },
  { id: 'item-delivery', label: 'Item Delivery', kind: 'production', x: SPINE_X, y: 1752 },
  { id: 'customer-payment', label: 'Customer Payment', kind: 'accounting', x: SPINE_X, y: 1852 },
  { id: 'apply-close', label: 'Apply to Close Invoice', kind: 'accounting', x: SPINE_X, y: 1952 },

  // Material-shortage branch (left)
  { id: 'transfer-order', label: 'Create Transfer Order', kind: 'procurement', x: 210, y: 964 },
  { id: 'have-on-hand', label: 'Have on hand?', kind: 'decision', x: 233, y: 1078 },
  { id: 'item-fulfill', label: 'Item Fulfill', kind: 'procurement', x: 210, y: 1232 },
  { id: 'create-po', label: 'Create PO', kind: 'procurement', x: 20, y: 1232 },
  { id: 'receive-item', label: 'Receive Item', kind: 'procurement', x: 20, y: 1332 },
  { id: 'vendor-bill', label: 'Vendor Bill', kind: 'accounting', x: 20, y: 1432 },
  { id: 'bill-payment', label: 'Bill Payment', kind: 'accounting', x: 20, y: 1532 },

  // Rework branches (right)
  { id: 'create-rwip', label: 'Create RWIP', kind: 'production', x: 740, y: 1054 },
  { id: 'create-rfqc', label: 'Create RFQC', kind: 'production', x: 740, y: 1498 },
];

// from/to are node ids. fromSide/toSide pick the port; `label` is the Yes/No tag.
// `viaX`/`viaY` force the elbow onto a specific channel so long loop-backs don't run
// through the middle of the chart. `tone` colours the edge (yes = green, no = red).
export const EDGES = [
  { from: 'estimate', to: 'sales-order' },
  { from: 'sales-order', to: 'job-order' },
  { from: 'job-order', to: 'forward-pms' },
  { from: 'forward-pms', to: 'assign-artist' },
  { from: 'assign-artist', to: 'forward-sales' },
  { from: 'forward-sales', to: 'sales-approval' },
  { from: 'sales-approval', to: 'production' },
  { from: 'production', to: 'enough-material' },

  { from: 'enough-material', to: 'assign-staff', label: 'Yes', tone: 'yes' },
  { from: 'enough-material', to: 'transfer-order', fromSide: 'left', toSide: 'top', label: 'No', tone: 'no' },

  { from: 'transfer-order', to: 'have-on-hand' },
  { from: 'have-on-hand', to: 'item-fulfill', label: 'Yes', tone: 'yes' },
  { from: 'have-on-hand', to: 'create-po', fromSide: 'left', toSide: 'top', label: 'No', tone: 'no' },
  { from: 'create-po', to: 'receive-item' },
  { from: 'receive-item', to: 'vendor-bill' },
  { from: 'vendor-bill', to: 'bill-payment' },
  // Into Item Fulfill's underside rather than its left edge: the purchasing column sits
  // only 20px to its left, which is too tight for a clean elbow.
  { from: 'bill-payment', to: 'item-fulfill', fromSide: 'right', toSide: 'bottom', label: 'stock received' },
  { from: 'item-fulfill', to: 'production', fromSide: 'right', toSide: 'left', viaX: 405, label: 'back to Production' },

  { from: 'assign-staff', to: 'damaged-wip' },
  { from: 'damaged-wip', to: 'create-rwip', fromSide: 'right', toSide: 'left', label: 'Yes', tone: 'yes' },
  { from: 'create-rwip', to: 'production', fromSide: 'right', toSide: 'right', viaX: 960, toOffset: -14, label: 'rework then resume' },
  { from: 'damaged-wip', to: 'complete', label: 'No', tone: 'no' },

  { from: 'complete', to: 'assembly-build' },
  { from: 'assembly-build', to: 'quality-control' },
  { from: 'quality-control', to: 'damaged-qc' },
  { from: 'damaged-qc', to: 'create-rfqc', fromSide: 'right', toSide: 'left', label: 'Yes', tone: 'yes' },
  { from: 'create-rfqc', to: 'production', fromSide: 'right', toSide: 'right', viaX: 1010, toOffset: 14, label: 'rework then resume' },
  { from: 'damaged-qc', to: 'invoice', label: 'No', tone: 'no' },

  { from: 'invoice', to: 'item-delivery' },
  { from: 'item-delivery', to: 'customer-payment' },
  { from: 'customer-payment', to: 'apply-close' },
];

// One manual per node. `where` names the screen, `route` deep-links to it, `who` is the
// permission the action is gated on, `steps` is the click-path, `notes` are the gotchas.
export const GUIDES = {
  estimate: {
    where: 'Sales → Estimates',
    route: '/estimates',
    who: 'Needs can_add on Estimates. Approving out of "Pending Supervisor Approval" additionally needs the Can Approve Sales Estimate flag on your account type.',
    summary: 'The estimate is the quotation and the costing sheet in one. Everything downstream — the Sales Order, the Job Orders, the commission GP check — is copied from what you enter here, so this is the step worth getting right.',
    steps: [
      'Go to Sales → Estimates and click Add Estimate. The wizard opens on the header step.',
      'Fill in the customer, sales rep, date, and terms. The customer picker searches as you type — pick the existing record rather than typing a new name, or the order will not roll up under that customer.',
      'On the Job Orders step, add one line per item to be produced. Each line carries a job type, description, quantity, size (length/width/height), unit price, discount, and tax code.',
      'Open each job line and fill in its Processes — the material and process rows that make up its cost. This is what produces the GP rate, and it is copied into the Job Order later as its Materials/Processes tabs.',
      'On the Billing step, click Recalculate from Job Orders so the header totals match the lines. The header figures are blank or stale until you do.',
      'Save. The estimate starts at Pending Supervisor Approval.',
      'A supervisor with the approve flag moves it to Pending Customer Approval, then to Approved once the customer confirms.',
    ],
    notes: [
      'Reaching Approved is what generates the Sales Order — there is no separate "convert" button.',
      'If any job line is below the required GP rate, an Admin or General Manager must tick that line during approval for it to count toward commission.',
      'Print only appears once the estimate has cleared supervisor approval.',
      'Replicate copies an estimate into a fresh draft — faster than re-keying a repeat order.',
    ],
  },

  'sales-order': {
    where: 'Sales → Sales Orders',
    route: '/sales-orders',
    who: 'Generated automatically by the system when an estimate is approved. Viewing needs can_view on Sales Orders.',
    summary: 'The Sales Order is the customer-facing commitment. It is a snapshot of the estimate at the moment of approval, not a live link — later edits to the estimate do not change an order already placed.',
    steps: [
      'Set the estimate to Approved on the Estimate view. The Sales Order is created in the same transaction.',
      'Open Sales → Sales Orders and find the new SO- number, or click the SO link in the estimate banner.',
      'Check the header (customer, rep, shipping address, contact) and the line totals against the estimate.',
      'The Details tab shows one line per estimate job line, carrying its quantity, price, discount, and tax.',
    ],
    notes: [
      'The SO number is derived from the record id (SO-6xxxx), not from the estimate number.',
      'Totals are recomputed fresh from the job lines during generation, so they are trustworthy even if the estimate header was never recalculated.',
      'A below-GP line approved by an Admin/GM carries that flag onto the SO line, which is where the commission report reads it.',
      'Sales Orders cannot be edited after generation in this build — amend the originating estimate instead.',
    ],
  },

  'job-order': {
    where: 'Sales → Sales Orders → open the SO → Details tab',
    route: '/sales-orders',
    who: 'Needs can_add on Sales Orders — a sales rep forwarding their own order to production, not an edit of the order.',
    summary: 'A Job Order is the production record for one Sales Order line. Every line that has to be made needs its own JO before production can start.',
    steps: [
      'Open the Sales Order and go to the Details tab.',
      'On the line you want to produce, click Create JO in the action cell.',
      'The Job Order is created and the line now links to it — the JO number reads JO-<so number>-<line>-<total lines>, so JO-63615-2-3 is line 2 of 3.',
      'Repeat for each remaining line. A line that already has a JO will refuse a second one.',
      'Open the new JO from Sales → Job Orders to review its Materials and Processes tabs, which were copied from the estimate costing.',
    ],
    notes: [
      'The cost breakdown you entered on the estimate is what lands in the JO — if it was blank there, the JO has nothing to work from.',
      'A Job Order starts in the design phase with sub-status Pending.',
    ],
  },

  'forward-pms': {
    where: 'Sales → Job Orders → open the JO',
    route: '/job-orders',
    who: 'The owning sales rep, or anyone with can_edit on Job Orders.',
    summary: 'Hands the Job Order over to the design/PMS side so a layout artist can be assigned. Nothing can be assigned until this is done.',
    steps: [
      'Open the Job Order from Sales → Job Orders while its sub-status is still Pending.',
      'Click Forward to Design Supervisor in the header.',
      'The sub-status moves out of Pending and the JO appears on the design supervisor\'s queue.',
    ],
    notes: [
      'Only the sales rep who owns the order, or a user with Job Order edit rights, sees this button.',
      'The button disappears once the JO has left Pending — it is a one-way handover.',
    ],
  },

  'assign-artist': {
    where: 'Sales → Job Orders → open the JO (design supervisor)',
    route: '/job-orders',
    who: 'The design supervisor, or anyone with can_edit on Job Orders.',
    summary: 'Picks the layout job type and the artist who will do the work. The JO then shows up on that artist\'s Assigned JO list with a running timer.',
    steps: [
      'Open the forwarded Job Order.',
      'Click Assign Layout Job Type / Artist.',
      'Choose the layout job type and the artist employee, then save. The button becomes Reassign Artist afterwards if you need to change it.',
      'The sub-status moves to For Artist and the JO lands in Design → Assigned JO for that artist.',
      'The artist opens it from Assigned JO and works through it; the elapsed time is a real stopwatch against the budgeted hours.',
    ],
    notes: [
      'The layout job type list comes from PMS Job Types, not the sales Job Types list.',
      'The timer keeps running until the artist clicks Hold. Forgetting to Hold burns budget — that is deliberate, not a bug.',
    ],
  },

  'forward-sales': {
    where: 'Design → Assigned JO, or the Job Order view',
    route: '/assigned-jo',
    who: 'The assigned artist, or anyone with can_edit on Job Orders.',
    summary: 'Once the layout is finished the artist sends it back to sales so the rep can show it to the customer.',
    steps: [
      'Open the Job Order while its sub-status is For Artist (or For Artist Revision after a rejected round).',
      'Click Sales Approval in the header.',
      'The sub-status moves to Sales Approval and the JO goes back to the sales rep\'s queue.',
    ],
    notes: [
      'Only the assigned artist or a Job Order editor sees this button.',
      'If the layout comes back For Revision, the JO returns to For Artist (Revision) and this same step repeats.',
    ],
  },

  'sales-approval': {
    where: 'Sales → Job Orders → open the JO',
    route: '/job-orders',
    who: 'Needs can_approve on Job Orders.',
    summary: 'The gate between design and production. Approving here is what releases the Job Order to the factory floor.',
    steps: [
      'Open the Job Order while its sub-status is Sales Approval.',
      'Review the layout with the customer.',
      'Click Approved to release it to production, or For Revision to send it back to the artist with your comments.',
      'After Approved, click Forward to Production to move it onto the production queue.',
    ],
    notes: [
      'For Revision returns the JO to the artist as For Artist (Revision) — the loop can run as many times as needed.',
      'Only users whose account type carries Job Order approve rights see these buttons.',
    ],
  },

  production: {
    where: 'Production → Production',
    route: '/production',
    who: 'Needs can_view on Production; the actions below need can_edit.',
    summary: 'The production queue. From here the JO is checked for materials, staffed, run through its processes, built, and inspected.',
    steps: [
      'Open Production → Production and find the released Job Order.',
      'Open it to see its Processes and Materials tabs — the process rows are the work to be done, the material rows are what it consumes.',
      'Check the material rows against on-hand stock before starting (the next step in this flow).',
      'Work down the chart from here: staff it, run the processes, complete, Assembly Build, then Quality Inspection.',
    ],
    notes: [
      'Hold pauses a Job Order and stops its clock; Resume restarts it.',
      'A JO with an open RWIP cannot be built until that rework is finished.',
    ],
  },

  'enough-material': {
    where: 'Production → Production → the JO\'s Materials tab',
    route: '/production',
    who: 'Production staff with can_view on Production and Inventory.',
    summary: 'The branch point: does the production location already hold enough of every material the Job Order needs?',
    steps: [
      'Open the Job Order\'s Materials tab and read the required quantity against the on-hand quantity for each item.',
      'Cross-check anything doubtful in Inventory → Stock Ledger or Bin Card for that item and location.',
      'If everything is covered, go straight to Assigning Staff.',
      'If anything is short, raise a Transfer Order to pull it from another location — that is the No branch.',
    ],
    notes: [
      'On-hand is per location, so a company-wide total being sufficient does not mean this location can start.',
    ],
  },

  'transfer-order': {
    where: 'Inventory → Transfer Orders',
    route: '/transfer-orders',
    who: 'Needs can_add on Transfer Orders.',
    summary: 'Moves stock from a location that has it to the location that needs it. This is the first thing to try when production is short — buying is the fallback.',
    steps: [
      'Go to Inventory → Transfer Orders and click Add New.',
      'Set Withdraw From (the source location) and Transfer To (the production location), plus the requestor and a memo.',
      'Add one line per item with the quantity needed.',
      'Save. The Transfer Order sits at Pending until it is fulfilled.',
    ],
    notes: [
      'Edit is only available while the TO is still Pending.',
      'If the source location does not actually hold the stock, this is where the flow branches to a Purchase Order instead.',
    ],
  },

  'have-on-hand': {
    where: 'Inventory → Transfer Orders → the TO lines',
    route: '/transfer-orders',
    who: 'Warehouse staff with can_view on Transfer Orders and Inventory.',
    summary: 'Does the source location actually have the stock to release? Yes fulfils the transfer; No sends it to Purchasing.',
    steps: [
      'Open the Transfer Order and read the on-hand column against each line quantity.',
      'If the stock is there, click Fulfill (the Yes branch).',
      'If it is not, raise a Purchase Requisition and Purchase Order for the shortfall (the No branch).',
    ],
    notes: [
      'A partial position is normal: fulfil what is available and purchase the balance.',
    ],
  },

  'item-fulfill': {
    where: 'Inventory → Transfer Orders → open the TO → Fulfill',
    route: '/transfer-orders',
    who: 'Needs can_approve on Transfer Orders.',
    summary: 'Releases the stock from the source location and creates the Item Fulfillment document. The receiving location then confirms it with an Item Receipt.',
    steps: [
      'Open the Transfer Order and click Fulfill.',
      'Enter the quantity being released per line and confirm. An Item Fulfillment (IF) document is created.',
      'At the receiving end, open the same TO and click Receive, pick the Item Fulfillment, and confirm the quantities. That creates the Item Receipt and lands the stock.',
      'Review either document from Inventory → Item Fulfillment / Item Receipt.',
      'With the material now at the production location, go back to the Job Order and carry on.',
    ],
    notes: [
      'Fulfil and receive are two separate actions — stock is only on hand at the destination after the receipt.',
      'Saved Item Fulfillments and Item Receipts cannot be edited in this build; cancel the transfer and redo it.',
    ],
  },

  'create-po': {
    where: 'Purchasing → Purchase Requisitions, then Purchase Orders',
    route: '/purchase-orders',
    who: 'Needs can_add on Purchase Requisitions / Purchase Orders; releasing needs can_approve.',
    summary: 'Buys the shortfall from a supplier. The requisition is the internal ask; the purchase order is the document that goes to the vendor.',
    steps: [
      'Go to Purchasing → Purchase Requisitions and click Add New. Add the items and quantities needed and save — it starts Pending.',
      'An approver opens the PR and approves it.',
      'Go to Purchasing → Purchase Orders and create the PO against the chosen supplier, carrying the requisition lines with prices and terms.',
      'Save. The PO sits at Pending Approval.',
      'An approver opens the PO and clicks Approve. Only then can it be received.',
    ],
    notes: [
      'Edit on a PO is only offered while it is still awaiting approval.',
      'Once approved, the Receive button appears on the PO and stays until it is fully received.',
    ],
  },

  'receive-item': {
    where: 'Purchasing → Purchase Orders → open the PO → Receive',
    route: '/purchase-orders',
    who: 'Needs can_edit on Purchase Orders.',
    summary: 'Books the supplier\'s delivery against the PO and raises the Receiving Report. This is the step that actually increases stock.',
    steps: [
      'Open the approved Purchase Order and click Receive.',
      'Enter the quantity actually delivered per line — it can be less than ordered, and the PO stays partially received.',
      'Save. A Receiving Report is created and the stock lands at the receiving location.',
      'Open the Receiving Report from the PO\'s related records to check its GL impact.',
      'If anything is faulty, use Vendor Return on the PO to send it back.',
    ],
    notes: [
      'Receiving is what makes the line billable — the Bill button only appears for quantity received but not yet billed.',
      'Saved Receiving Reports cannot be edited in this build.',
    ],
  },

  'vendor-bill': {
    where: 'Purchasing → Purchase Orders → open the PO → Bill',
    route: '/vendor-bills',
    who: 'Needs can_edit on Purchase Orders to raise it; can_view on Vendor Bills to read it.',
    summary: 'Records the supplier\'s invoice against what was received, creating the payable.',
    steps: [
      'Open the Purchase Order once at least one line has been received.',
      'Click Bill. The modal lists the received-but-unbilled quantity per line.',
      'Enter the supplier\'s invoice number, date, and terms, adjust the billable quantities if the invoice differs, and save.',
      'The Vendor Bill opens with status Open and the payable is posted.',
      'Read it any time from Accounting → Vendor Bill.',
    ],
    notes: [
      'Bill Credit on the Vendor Bill handles a supplier credit note against the same bill.',
      'Saved Vendor Bills cannot be edited in this build — cancel and re-raise.',
    ],
  },

  'bill-payment': {
    where: 'Accounting → Vendor Bill → open the bill → Bill Payment',
    route: '/bill-payments',
    who: 'Needs can_view on Vendor Bills and can_add on Bill Payments.',
    summary: 'Settles the supplier. This closes out the purchasing leg of the flow.',
    steps: [
      'Open the Vendor Bill while it is still Open.',
      'Click Bill Payment.',
      'Pick the paying bank account, the date, and the amount — a part payment leaves the bill partially settled.',
      'Save. The Bill Payment posts and the bill\'s outstanding balance drops.',
      'Read the payment later from Accounting → Bill Payment.',
    ],
    notes: [
      'Void is available on an open Bill Payment; there is no edit in this build.',
      'With the goods received and paid for, the material can now be fulfilled to production.',
    ],
  },

  'assign-staff': {
    where: 'Production → Production → open the JO → Processes tab',
    route: '/production',
    who: 'Needs can_edit on Production.',
    summary: 'Puts names against the process rows so the work can start and be timed.',
    steps: [
      'Open the Job Order in Production and go to its Processes tab.',
      'Assign the operator and machine/work centre to each process row.',
      'Use Production → Scheduled JO to sequence the work where it needs slotting against a schedule.',
      'Operators open their own queue and run each process from there.',
    ],
    notes: [
      'Time booked against a process is what feeds the process costing figures later.',
      'Hold on the Job Order stops the clock for everyone on it.',
    ],
  },

  'damaged-wip': {
    where: 'Production → Production → open the JO',
    route: '/production',
    who: 'Production staff with can_edit on Production.',
    summary: 'Checkpoint during the run: was anything damaged while in process? Yes raises an RWIP rework job; No carries on to Complete.',
    steps: [
      'Inspect the work in process as each stage finishes.',
      'If units are damaged, raise an RWIP against this Job Order (the Yes branch).',
      'If everything is sound, complete the processes and move on (the No branch).',
    ],
    notes: [
      'Damage found here is in-process damage. Damage found after the build is caught by Quality Control instead, which raises an RFQC.',
    ],
  },

  'create-rwip': {
    where: 'Production → Production → open the JO → RWIP tab',
    route: '/rwip-job-orders',
    who: 'Needs can_edit on Production to raise it; can_approve on Production to approve it.',
    summary: 'RWIP (RWIP-###) is a rework Job Order taken off the in-process mother JO for units damaged mid-run.',
    steps: [
      'Open the mother Job Order in Production and go to its RWIP tab.',
      'Click Add, enter the quantity to rework and the reason, and save. The RWIP is created as its own Job Order.',
      'An approver opens it from Production → RWIP and clicks Approve RWIP.',
      'Run the rework through its processes, build it, and put it through Quality Inspection like any other JO.',
      'Once it is finished, the mother Job Order can be built and completed again.',
    ],
    notes: [
      'The mother JO is blocked from Assembly Build while any RWIP against it is still open — the button explains why.',
      'RWIP comes off an in-process JO; RFQC comes off the RMA quantity on a Quality Inspection.',
    ],
  },

  complete: {
    where: 'Production → Production → open the JO → Processes tab',
    route: '/production',
    who: 'Needs can_edit on Production.',
    summary: 'Marks the process work as finished so the Job Order can be built.',
    steps: [
      'Open the Job Order and work down the Processes tab.',
      'Complete each process row as its operator finishes it.',
      'When every process is done the Job Order is ready for Assembly Build.',
    ],
    notes: [
      'Completing processes is what stops the time booking against them.',
    ],
  },

  'assembly-build': {
    where: 'Production → Production → open the JO → Assembly Build',
    route: '/assembly-builds',
    who: 'Needs can_edit on Production.',
    summary: 'Turns the completed work into finished units: consumes the material and books the built quantity against the Job Order.',
    steps: [
      'Open the Job Order in Production and click Assembly Build.',
      'Enter the quantity built and confirm.',
      'The Assembly Build document is created, the material is consumed, and the JO\'s built quantity goes up.',
      'Read the build later from Production → Assembly Build, including its GL impact.',
    ],
    notes: [
      'The button is disabled while any RWIP against this JO is still open.',
      'Saved Assembly Builds cannot be edited in this build; Cancel reverses one.',
    ],
  },

  'quality-control': {
    where: 'Production → Production → open the JO → Quality Inspection',
    route: '/quality-inspections',
    who: 'Needs Can Add on Quality Inspection.',
    summary: 'Inspects the built units and splits them into passed quantity and RMA (rejected) quantity. Only inspected units can be delivered.',
    steps: [
      'Open the Job Order once it has an uninspected build and click Quality Inspection.',
      'Enter the quantity that passed and the quantity rejected, with the reason.',
      'Save. The Quality Inspection document is created and the JO\'s inspected quantity goes up.',
      'Read it later from Production → Quality Inspection.',
    ],
    notes: [
      'The button only appears while there is a build that has not been inspected yet.',
      'Item Delivery is capped at the lower of built and inspected quantity, so skipping inspection blocks delivery.',
      'Saved Quality Inspections cannot be edited in this build; Cancel reverses one.',
    ],
  },

  'damaged-qc': {
    where: 'Production → Quality Inspection',
    route: '/quality-inspections',
    who: 'Production staff with Can Add on Quality Inspection.',
    summary: 'Did the inspection reject anything? A rejected (RMA) quantity raises an RFQC rework job; a clean pass goes on to invoicing.',
    steps: [
      'Read the RMA quantity on the Quality Inspection.',
      'If it is above zero, raise an RFQC for that quantity (the Yes branch).',
      'If everything passed, the Job Order is ready to bill and deliver (the No branch).',
    ],
    notes: [
      'You can invoice the passed quantity while the rejected quantity is still being reworked.',
    ],
  },

  'create-rfqc': {
    where: 'Production → Production → open the JO → RFQC',
    route: '/rfqc-job-orders',
    who: 'Needs can_edit on Production to raise it; can_approve on Production to approve it.',
    summary: 'RFQC (RFQC-###) is the rework Job Order for units the Quality Inspection rejected.',
    steps: [
      'From the Job Order, raise an RFQC against the RMA quantity on the Quality Inspection.',
      'An approver opens it from Production → RFQC and clicks Approve RFQC.',
      'Run the rework, build it, and put it back through Quality Inspection.',
      'Once it passes, that quantity rejoins the deliverable total.',
    ],
    notes: [
      'The quantity is bounded by the RMA quantity on the inspection — you cannot rework more than was rejected.',
      'The mother Job Order cannot be completed while an RFQC against it is open.',
    ],
  },

  invoice: {
    where: 'Sales → Sales Orders → open the SO → Bill',
    route: '/sales-invoices',
    who: 'Needs can_view on Sales Orders and can_add on the document you raise.',
    summary: 'Bills the customer for the delivered quantity. Bill offers SI (Sales Invoice) and DT (Delivery Ticket) — DT is the internal billing document that becomes an Invoice when it is paid.',
    steps: [
      'Open the Sales Order once at least one Job Order line has been delivered but not yet invoiced.',
      'Click Bill and pick SI for a straight Sales Invoice, or DT for a Delivery Ticket.',
      'The modal lists the billable quantity per line. Check the amounts, terms, and date.',
      'Save. The document posts the receivable and appears under Accounting → Invoice or Delivery Ticket.',
    ],
    notes: [
      'The Bill button only appears when there is quantity delivered but not yet invoiced.',
      'A Delivery Ticket converts to an Invoice on payment, and the converted invoice carries the DT number, not the SO number.',
      'Saved Invoices cannot be edited in this build — Void and re-raise.',
    ],
  },

  'item-delivery': {
    where: 'Sales → Sales Orders → open the SO → Item Delivery',
    route: '/item-deliveries',
    who: 'Needs can_edit on Sales Orders.',
    summary: 'Ships the finished units to the customer and reduces finished-goods stock.',
    steps: [
      'Open the Sales Order. Item Delivery appears once a line has built and inspected quantity that has not shipped yet.',
      'Click Item Delivery, enter the quantity going out per line, and save.',
      'The Item Delivery document is created and the delivered quantity on the SO line goes up.',
      'Read it later from Production → Item Delivery.',
    ],
    notes: [
      'Deliverable quantity is capped at the lower of built and inspected quantity minus what has already gone out.',
      'Saved Item Deliveries cannot be edited in this build; Cancel reverses one.',
    ],
  },

  'customer-payment': {
    where: 'Accounting → Invoice → open the invoice → Accept Payment',
    route: '/customer-payments',
    who: 'Needs can_edit on Sales Invoices to accept it; can_view on Customer Payments to read it.',
    summary: 'Records what the customer paid and applies it against their open invoices.',
    steps: [
      'Open the Sales Invoice while it is still settleable and click Accept Payment.',
      'Enter the date, method, reference, and amount received.',
      'Apply the amount across the open invoices being settled, then save.',
      'The Customer Payment posts and appears under Accounting → Customer Payments with status Not Deposited.',
      'Click Deposit on the payment to sweep it into a bank account as a Bank Deposit.',
    ],
    notes: [
      'A part payment leaves the invoice partially settled — the balance stays open.',
      'Credit Memo on the invoice handles a customer credit note instead of cash.',
      'Saved Customer Payments cannot be edited in this build; Void and re-enter.',
    ],
  },

  'apply-close': {
    where: 'Accounting → Invoice',
    route: '/sales-invoices',
    who: 'Needs can_edit on Sales Invoices.',
    summary: 'The last step: once payments and any credit memos cover the invoice in full, it is closed and the order is done.',
    steps: [
      'Open the Sales Invoice and check the applied total against the invoice total.',
      'Apply any remaining Customer Payments or Credit Memos until the balance is nil.',
      'The invoice moves to paid/closed and stops appearing as outstanding on the A/R Aging report.',
      'Check Accounting → Reports → A/R Aging to confirm nothing is left open for that customer.',
    ],
    notes: [
      'A Delivery Ticket becomes a real Invoice at this point, carrying the DT number.',
      'Commission on the order is calculated from the paid position, so an unpaid invoice will not show up as commissionable.',
    ],
  },
};

export const LEGEND = [
  { kind: 'sales', label: 'Sales' },
  { kind: 'design', label: 'Design / PMS' },
  { kind: 'production', label: 'Production' },
  { kind: 'procurement', label: 'Inventory / Purchasing' },
  { kind: 'accounting', label: 'Accounting' },
  { kind: 'decision', label: 'Decision' },
];
