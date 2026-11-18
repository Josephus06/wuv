// Shared by qualityInspections.js, itemDeliveries.js, and salesInvoices.js -- every
// place that can move a Sales Order's status forward recomputes it fresh from every one
// of its lines, rather than each route guessing its own next-status in isolation.
//
// The core rule: a line that's already fully delivered/invoiced is "done" and doesn't
// drag the order backward -- but a line that hasn't even gotten a Job Order yet (or has
// one still in production, nothing built+QI'd) always wins over a further-along line.
//
// "Partially Delivered" means there's ready stock (built+QI'd) sitting undelivered on
// some line -- an action is owed (ship it). That's different from a line where
// Built === Inspected === Delivered but short of the full ordered qty: nothing produced
// so far is sitting around unshipped, it's just not fully produced yet, so whatever *has*
// shipped is fully billable right now. That's 'pending_billing_partially_delivered' --
// distinct from plain 'pending_billing', which means the *entire* order shipped and is
// just waiting on the invoice.
//
// One rule sits above all of that: once the order has a billing document -- a Delivery Ticket
// (not voided) or a Sales Invoice / Delivery Receipt (not cancelled) -- it is past billing: Billed
// when every line is invoiced (or on an open ticket), PARTIALLY BILLED while some still is not
// (asked 2026-10-07: SO-70419, 1 of 12 lines invoiced, read Billed). The lines carry that as
// has_billing_doc (see invoicedOrTicketedSql).
//
// partially_billed is written only once the column takes it (db/add-so-partially-billed-status.js);
// until then such an order reads Billed, as it did before, so code and schema deploy in either order.
const pool = require('../db');
let partialBilledSupported = false;
// A script that computes a status right away awaits this first (statusRuleReady).
const statusRuleReady = pool.query("SHOW COLUMNS FROM sales_orders LIKE 'status'")
  .then(([rows]) => { partialBilledSupported = String(rows?.[0]?.Type || '').includes("'partially_billed'"); })
  .catch(() => {});

function everyLineInvoiced(lines) {
  return lines.length > 0 && lines.every((l) => l.job_order_id && Number(l.quantity_invoiced || 0) >= Number(l.quantity || 0));
}

function computeSalesOrderStatus(lines) {
  if (lines.some((l) => Number(l.has_billing_doc))) {
    return everyLineInvoiced(lines) || !partialBilledSupported ? 'billed' : 'partially_billed';
  }
  let hasAnyJO = false;
  let allFullyInvoiced = true;
  let allFullyDelivered = true;
  let anyNotReady = false;
  let anyPartial = false;
  let anySettledPartial = false;
  let anyReadyUndelivered = false;

  for (const l of lines) {
    const qty = Number(l.quantity || 0);
    if (!l.job_order_id) {
      allFullyInvoiced = false;
      allFullyDelivered = false;
      anyNotReady = true;
      continue;
    }
    hasAnyJO = true;
    const built = Number(l.quantity_built || 0);
    const inspected = Number(l.quantity_inspected || 0);
    const delivered = Number(l.quantity_delivered || 0);
    const invoiced = Number(l.quantity_invoiced || 0);
    const cap = Math.min(built, inspected);

    if (invoiced < qty) allFullyInvoiced = false;
    if (delivered < qty) allFullyDelivered = false;

    if (qty > 0 && delivered >= qty) continue; // this line is finished -- doesn't drag the order backward

    if (cap <= 0) { anyNotReady = true; continue; }

    const readyUndelivered = cap - delivered;
    if (delivered <= 0) { anyReadyUndelivered = true; continue; }
    if (readyUndelivered > 0) { anyPartial = true; continue; }
    anySettledPartial = true; // delivered caught up to everything ready -- just not the full order yet
  }

  if (!hasAnyJO) return 'pending_for_jo';
  if (allFullyInvoiced) return 'billed';
  if (allFullyDelivered) return 'pending_billing';
  if (anyNotReady) return 'jo_in_process';
  if (anyPartial) return 'partially_delivered';
  if (anySettledPartial) return 'pending_billing_partially_delivered';
  if (anyReadyUndelivered) return 'pending_delivery';
  return 'jo_in_process';
}

// Quantity on a Sales Order line that sits on an OPEN Delivery Ticket. A ticket does not advance
// job_orders.quantity_invoiced (see routes/deliveryTickets.js) -- it is billed when it is converted
// -- but the quantity on it is spoken for: billing it again from the Sales Order, or raising a
// second ticket for it, bills the same goods twice (SO-71114, 2026-10-05). So it counts as billed
// for the order's status and is left out of what the order still has to bill. A converted ticket
// drops out here because its invoice has advanced quantity_invoiced; a voided one frees its qty.
const openDtQtySql = (lineAlias = 'sol') => `COALESCE((SELECT SUM(dtl.quantity)
  FROM delivery_ticket_lines dtl JOIN delivery_tickets dt ON dt.id = dtl.delivery_ticket_id
 WHERE dt.status = 'open' AND dtl.sales_order_line_id = ${lineAlias}.id), 0)`;
// Whether the line's Sales Order has any billing document: a Delivery Ticket that is not voided, or
// a Sales Invoice / Delivery Receipt (both sales_invoices, told apart by invoice_type) that is not
// cancelled. Any one of them makes the order Billed.
const hasBillingDocSql = (lineAlias = 'sol') => `(EXISTS (SELECT 1 FROM delivery_tickets bdt
   WHERE bdt.sales_order_id = ${lineAlias}.sales_order_id AND bdt.status <> 'void')
  OR EXISTS (SELECT 1 FROM sales_invoices bsi
   WHERE bsi.sales_order_id = ${lineAlias}.sales_order_id AND bsi.status <> 'cancelled'))`;
// For the status queries: invoiced, counting what is on open tickets, under the name the status
// rule reads -- plus has_billing_doc, which the rule checks first.
const invoicedOrTicketedSql = (joAlias = 'jo', lineAlias = 'sol') => `(${joAlias}.quantity_invoiced + ${openDtQtySql(lineAlias)}) AS quantity_invoiced,
  ${hasBillingDocSql(lineAlias)} AS has_billing_doc`;

module.exports = { computeSalesOrderStatus, openDtQtySql, invoicedOrTicketedSql, hasBillingDocSql, statusRuleReady };
