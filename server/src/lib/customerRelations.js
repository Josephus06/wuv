const pool = require('../db');

// Customer Relationships (Customers > Relationships tab, 2026-10-19): each row on a customer links
// another customer from the list (customer_relationships.related_customer_id). Its purpose is the
// payment: when customer 1 is on customer 2's Relationships, a Customer Payment from customer 2 may
// be applied to customer 1's invoices -- a parent company settling a branch's bills, say.
//
// One way only, as entered: customer 2's payment reaches customer 1's invoices, not the reverse
// unless customer 2 is also on customer 1's list.

// The customers whose invoices a payment from `customerId` may settle: itself and its related ones.
async function payableCustomerIds(customerId, q = pool) {
  const id = Number(customerId);
  if (!id) return [];
  try {
    const [rows] = await q.query(
      `SELECT DISTINCT r.related_customer_id AS id FROM customer_relationships r
         JOIN customers c ON c.id = r.related_customer_id
        WHERE r.customer_id = ? AND r.related_customer_id IS NOT NULL AND r.related_customer_id <> ?`, [id, id]);
    return [id, ...rows.map((r) => Number(r.id))];
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') return [id]; // db/add-customer-relationship-link.js not run yet
    throw e;
  }
}

module.exports = { payableCustomerIds };
