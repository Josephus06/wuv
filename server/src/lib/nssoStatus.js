// A Non-Standard Sales Order's status, recomputed from its lines' Job Orders by the same rule a
// Sales Order uses (computeSalesOrderStatus) -- delivering or billing one moves it exactly as it
// would move a Sales Order. Its lines point at their JO through created_job_order_id.
//
// An NSSO still awaiting approval, or cancelled, is left as it is: those are decisions, not
// progress, and no delivery or invoice can reach one anyway.
const { computeSalesOrderStatus } = require('./salesOrderStatus');

async function recomputeNssoStatus(conn, nssoId) {
  const [[n]] = await conn.query('SELECT status FROM non_standard_sales_orders WHERE id = ?', [nssoId]);
  if (!n || n.status === 'pending_approval' || n.status === 'cancelled') return n ? n.status : null;
  const [lines] = await conn.query(
    `SELECT l.created_job_order_id AS job_order_id, l.quantity,
            jo.quantity_built, jo.quantity_inspected, jo.quantity_delivered, jo.quantity_invoiced
       FROM non_standard_sales_order_lines l
       LEFT JOIN job_orders jo ON jo.id = l.created_job_order_id
      WHERE l.nsso_id = ?`,
    [nssoId]
  );
  const status = computeSalesOrderStatus(lines);
  if (status !== n.status) {
    await conn.query('UPDATE non_standard_sales_orders SET status = ?, updated_at = NOW() WHERE id = ?', [status, nssoId]);
  }
  return status;
}

module.exports = { recomputeNssoStatus };
