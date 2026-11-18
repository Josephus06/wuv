import { COMPANY } from '../config/company';

// The company letterhead, shared by every printed document so they cannot drift apart. Same
// layout as the Estimate print-out's: the short name as the logo, the legal name and contact lines
// beside it, all from config/company.js.
export default function PrintLetterhead() {
  return (
    <div className="print-letterhead">
      <div className="print-logo">{COMPANY.short}</div>
      <div className="print-company-address">
        <strong>{COMPANY.name}</strong><br />
        {COMPANY.addressLine1}{COMPANY.addressLine1 && <br />}
        {COMPANY.addressLine2}{COMPANY.addressLine2 && <br />}
        {COMPANY.phone && <>Tel. {COMPANY.phone}<br /></>}
        {COMPANY.website}
      </div>
    </div>
  );
}
