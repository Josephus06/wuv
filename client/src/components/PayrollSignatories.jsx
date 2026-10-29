// Prepared By / Noted By / Approved By on a payroll printout: the people who did each step of
// the run's review, name over the line and position under it. A step not done yet prints an
// empty line to sign by hand. `received` adds the employee's own line (payslips).
const STEPS = [
  ['prepared', 'Prepared by'],
  ['noted', 'Noted by'],
  ['approved', 'Approved by'],
];

export default function PayrollSignatories({ signatories, received = false }) {
  const s = signatories || {};
  return (
    <div className="pay-signatories">
      {STEPS.map(([key, label]) => (
        <div key={key}>
          <div className="pay-sig-label">{label}:</div>
          <div className="pay-sig-name">{s[key]?.name ? s[key].name.toUpperCase() : ' '}</div>
          <div className="pay-sig-title">{s[key]?.title ? s[key].title.toUpperCase() : ' '}</div>
        </div>
      ))}
      {received && (
        <div>
          <div className="pay-sig-label">Received by:</div>
          <div className="pay-sig-name">&nbsp;</div>
          <div className="pay-sig-title">SIGNATURE / DATE</div>
        </div>
      )}
    </div>
  );
}
