// Where a document opens in the app: by its ledger source_type + id (T1S's own GL lines), or by its
// document NUMBER (lines read from the source system -- migrated documents keep the source's
// numbers, so INV-82398 in the old ledger is INV-82398 here). Used by the report drill-downs.
const pool = require('../db');

// source_type -> table, its document-number column, and the page that shows one.
const DOCS = {
  sales_invoice: { table: 'sales_invoices', no: 'invoice_no', path: (id) => `/sales-invoices/${id}` },
  assembly_build: { table: 'assembly_builds', no: 'ab_no', path: (id) => `/assembly-builds/${id}` },
  item_delivery: { table: 'item_deliveries', no: 'delivery_no', path: (id) => `/item-deliveries/${id}` },
  item_fulfillment: { table: 'item_fulfillments', no: 'fulfillment_no', path: (id) => `/transfer-orders/item-fulfillments/${id}` },
  item_receipt: { table: 'item_receipts', no: 'receipt_no', path: (id) => `/transfer-orders/item-receipts/${id}` },
  customer_payment: { table: 'customer_payments', no: 'customer_payment_no', path: (id) => `/customer-payments/${id}` },
  credit_memo: { table: 'credit_memos', no: 'credit_memo_no', path: (id) => `/credit-memos/${id}` },
  customer_refund: { table: 'customer_refunds', no: 'customer_refund_no', path: (id) => `/customer-refunds/${id}` },
  journal: { table: 'journals', no: 'journal_no', path: (id) => `/journals/${id}` },
  cheque: { table: 'cheques', no: 'cheque_no', path: (id) => `/cheques/${id}` },
  fund_transfer: { table: 'fund_transfers', no: 'ft_no', path: (id) => `/fund-transfers/${id}` },
  bank_deposit: { table: 'bank_deposits', no: 'bd_no', path: (id) => `/deposits/${id}` },
  osr_fulfillment: { table: 'osr_fulfillments', no: 'osrf_no', path: (id) => `/office-supply-requisitions/fulfillments/${id}` },
  commission_payable: { table: 'commission_payables', no: 'commission_payable_no', path: (id) => `/commission-payables/${id}` },
  commission_voucher: { table: 'commission_vouchers', no: 'voucher_no', path: (id) => `/commission-vouchers/${id}` },
  delivery_ticket: { table: 'delivery_tickets', no: 'dt_no', path: (id) => `/delivery-tickets/${id}` },
  vendor_bill: { table: 'vendor_bills', no: 'bill_no', path: (id) => `/vendor-bills/${id}` },
  inventory_adjustment: { table: 'inventory_adjustments', no: 'adjustment_no', path: (id) => `/inventory-adjustments/${id}` },
  bill_credit: { table: 'bill_credits', no: 'bill_credit_no', path: (id) => `/bill-credits/${id}` },
  asset_disposal: { table: 'asset_disposals', no: 'disposal_no', path: (id) => `/asset-disposals/${id}` },
  // Not GL sources in T1S, but they are in the source's ledger.
  bill_payment: { table: 'bill_payments', no: 'bill_payment_no', path: (id) => `/bill-payments/${id}` },
  receiving_report: { table: 'purchase_order_receipts', no: 'receipt_no', path: (id) => `/receiving-reports/${id}` },
};

const linkFor = (sourceType, id) => (id && DOCS[sourceType] ? DOCS[sourceType].path(id) : null);

// Document numbers -> Map(number -> path), for the ones T1S holds. Every table is asked (each
// number column is indexed); a number is unique to its document type by its prefix.
async function linksForNumbers(numbers) {
  const wanted = [...new Set(numbers.filter(Boolean).map(String))];
  const out = new Map();
  if (!wanted.length) return out;
  await Promise.all(Object.values(DOCS).map(async (d) => {
    try {
      const [rows] = await pool.query(`SELECT id, ${d.no} AS no FROM ${d.table} WHERE ${d.no} IN (?)`, [wanted]);
      for (const r of rows) if (!out.has(r.no)) out.set(r.no, d.path(r.id));
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    }
  }));
  return out;
}

module.exports = { DOCS, linkFor, linksForNumbers };
