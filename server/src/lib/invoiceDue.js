// An invoice's Amount Due on GROSS (2026-10-12): Gross Amount less every payment applied to it (not
// voided) and every credit memo applied to it (not voided) -- the balance AR Aging carries for it
// (lib/arAging.js collectOpenItems). INV-80196: Gross 24,114.94, paid 23,684.32 net of its 430.62
// EWT, so 430.62 is still due -- the EWT, cleared by the customer's EWT credit memo (CM-5608).
//
// sales_invoices.amount_due stays what it was: the CASH still to collect, net of EWT. It read 0 on
// INV-80196, which is why the credit memo could not be applied to it.
const paidSql = (a) => `COALESCE((SELECT SUM(cpl.applied_amount) FROM customer_payment_lines cpl
    JOIN customer_payments cp ON cp.id = cpl.customer_payment_id
   WHERE cpl.sales_invoice_id = ${a}.id AND cp.status <> 'voided'), 0)`;
const creditedSql = (a) => `COALESCE((SELECT SUM(cma.applied_amount) FROM credit_memo_applications cma
    JOIN credit_memos cmx ON cmx.id = cma.credit_memo_id
   WHERE cma.sales_invoice_id = ${a}.id AND cmx.status <> 'voided'), 0)`;
// SQL for one invoice row aliased `a`: its gross Amount Due, never below zero.
const grossDueSql = (a) => `GREATEST(ROUND(${a}.gross_amount - ${paidSql(a)} - ${creditedSql(a)}, 2), 0)`;

async function grossDue(conn, invoiceId) {
  const [[r]] = await conn.query(`SELECT ${grossDueSql('si')} AS due FROM sales_invoices si WHERE si.id = ?`, [invoiceId]);
  return r ? Number(r.due) : 0;
}

module.exports = { grossDueSql, grossDue };
