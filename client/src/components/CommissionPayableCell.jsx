import { Link } from 'react-router-dom';

// CP # column of the Commission report and Commission Summary (asked 2026-11-18): the month's
// Commission Payable(s), linked; a month that earned commission (or had some released) with no
// payable reads "No CP" in red -- a Commission Voucher can only release against a payable, so
// that month's commission cannot be paid until one is created.
export default function CommissionPayableCell({ row }) {
  const payables = row.payables || [];
  if (payables.length) {
    return payables.map((p, i) => (
      <span key={p.id}>
        {i > 0 && ', '}
        <Link to={`/commission-payables/${p.id}`} title={`Status: ${p.status}`}>{p.commission_payable_no}</Link>
      </span>
    ));
  }
  const earned = Number(row.expected_commission) > 0 || Number(row.released_commission) !== 0;
  return earned
    ? <span style={{ color: '#b91c1c', fontWeight: 600 }} title="No Commission Payable for this month -- it cannot be released on a voucher">No CP</span>
    : null;
}
