// A Bill Credit's status follows its applied amount: Fully Applied once all of it is applied,
// Open while any is left -- and Voided stays Voided.
//
// Before this, a credit raised in T1S stayed Open forever: only credits migrated from the source
// carried Fully Applied, and none of the eight places that move applied_amount (create, edit,
// Bill Payment apply / edit / void, Cheque apply / edit / void) touched the status. BC-7431 read
// Open with 0.00 unapplied.
//
// An SQL assignment, appended AFTER `applied_amount = ...` in the same UPDATE: MySQL evaluates a
// single-table UPDATE's assignments left to right, so this sees the new applied_amount.
const CREDIT_STATUS_SQL =
  "status = CASE WHEN status = 'voided' THEN status WHEN applied_amount >= total_amount - 0.005 THEN 'fully_applied' ELSE 'open' END";

// For the paths that set applied_amount some other way (create, edit): re-derive afterwards.
async function syncBillCreditStatus(conn, creditId) {
  await conn.query(`UPDATE bill_credits SET ${CREDIT_STATUS_SQL} WHERE id = ?`, [creditId]);
}



// A cheque paid to a vendor in advance becomes a Bill Credit (bill_credits.cheque_id), and that
// credit is what gets applied to the vendor's bills. Once EVERY credit made from the cheque is
// fully applied, the cheque is FULLY APPLIED -- the source's own status for exactly this; Open
// again if one is reversed. Void stays Void.
//
// Judged on the credits, not on the cheque's total: a credit need not equal its cheque (withholding,
// or the advance split over several credits), and comparing against the cheque total turned 360
// cheques the source shows FULLY APPLIED back to Open on the first backfill.
async function syncChequeForCredit(conn, creditId) {
  await conn.query(
    `UPDATE cheques c
        JOIN (SELECT bc.cheque_id,
                     SUM(bc.status <> 'voided') AS live_credits,
                     SUM(bc.status <> 'voided' AND bc.applied_amount < bc.total_amount - 0.005) AS open_credits
                FROM bill_credits bc
               WHERE bc.cheque_id = (SELECT cheque_id FROM bill_credits WHERE id = ?)
               GROUP BY bc.cheque_id) t ON t.cheque_id = c.id
        SET c.status = IF(t.live_credits > 0 AND t.open_credits = 0, 'fully_applied', 'open')
      WHERE c.status <> 'void'`,
    [creditId]
  );
}
module.exports = { CREDIT_STATUS_SQL, syncBillCreditStatus, syncChequeForCredit };
