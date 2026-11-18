// Posting an approved Fund Transfer Request (Forms) to the books (asked 2026-10-14): Accounting
// raises a Check Voucher (a cheque drawn on the From bank) or a Fund Transfer Voucher (From -> To)
// from it -- one, or several that together cover its total. The request itself posts nothing; the
// vouchers do. Each voucher carries form_request_id (db/add-fund-transfer-request-link.js).
//
// Before that column exists every request reads as unposted and the routes save no link, so the
// code deploys ahead of the migration without failing.

const round2 = (v) => Math.round(Number(v || 0) * 100) / 100;

async function hasLink(conn, table) {
  const [col] = await conn.query(`SHOW COLUMNS FROM ${table} LIKE 'form_request_id'`);
  return col.length > 0;
}

// The vouchers raised from a request -- voided ones too, for the history -- and how much of the
// request the live ones cover.
async function fundTransferRequestPosting(conn, formId) {
  const vouchers = [];
  if (await hasLink(conn, 'cheques')) {
    const [rows] = await conn.query(
      `SELECT 'Check Voucher' AS type, id, cheque_no AS doc_no, date_created, status, total_amount AS amount, payee_name AS party
         FROM cheques WHERE form_request_id = ? ORDER BY id`, [formId]);
    vouchers.push(...rows.map((r) => ({ ...r, path: `/cheques/${r.id}` })));
  }
  if (await hasLink(conn, 'fund_transfers')) {
    const [rows] = await conn.query(
      `SELECT 'Fund Transfer' AS type, id, ft_no AS doc_no, date_created, status, amount, NULL AS party
         FROM fund_transfers WHERE form_request_id = ? ORDER BY id`, [formId]);
    vouchers.push(...rows.map((r) => ({ ...r, path: `/fund-transfers/${r.id}` })));
  }
  const live = vouchers.filter((v) => String(v.status).toLowerCase() !== 'void');
  const [[form]] = await conn.query(
    `SELECT COALESCE(d.total_amount, (SELECT SUM(amount) FROM form_request_items WHERE form_request_id = f.id), 0) AS total
       FROM form_requests f LEFT JOIN form_payment_details d ON d.form_request_id = f.id WHERE f.id = ?`, [formId]);
  const total = round2(form?.total);
  const posted = round2(live.reduce((s, v) => s + Number(v.amount || 0), 0));
  return { vouchers, live, total, posted, remaining: round2(Math.max(total - posted, 0)), fullyPosted: total > 0 && posted >= total - 0.005 };
}

// Why a voucher for this amount cannot be raised from the request, or null when it can.
async function fundTransferPostError(conn, formId, amount) {
  const [[form]] = await conn.query('SELECT type, status, request_no FROM form_requests WHERE id = ?', [formId]);
  if (!form) return 'That Fund Transfer Request no longer exists.';
  if (form.type !== 'fund_transfer') return `${form.request_no} is not a Fund Transfer Request.`;
  if (form.status !== 'approved') return `${form.request_no} is not approved yet.`;
  const p = await fundTransferRequestPosting(conn, formId);
  if (p.fullyPosted) return `${form.request_no} is already posted (${p.live.map((v) => v.doc_no).join(', ')}).`;
  if (round2(amount) > p.remaining + 0.005) {
    return `${form.request_no} has ${p.remaining.toLocaleString('en-US', { minimumFractionDigits: 2 })} left to post; this voucher is for ${round2(amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}.`;
  }
  return null;
}

module.exports = { fundTransferRequestPosting, fundTransferPostError, hasLink };
