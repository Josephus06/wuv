import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import QRCode from 'qrcode';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import { companyLogo } from '../utils/payroll';

// Printable time clock QR badges, ID-card size (54 x 86 mm), several to a page with cut lines.
// One employee (?employee_id=) or every active employee of a company / branch; `issue=1` first
// gives a badge to those without one. A badge can be printed again any time -- the code only
// changes when HR makes a new badge, which retires the old one.

export default function QrBadgesPrint() {
  const [params] = useSearchParams();
  const [badges, setBadges] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const query = Object.fromEntries(['employee_id', 'company_id', 'branch_id', 'issue']
      .filter((k) => params.get(k)).map((k) => [k, params.get(k)]));
    api.get('/kiosk-admin/qr-badges', { params: query })
      .then(async ({ data }) => {
        const withQr = await Promise.all(data.map(async (b) => ({
          ...b, qr: await QRCode.toDataURL(b.code, { margin: 1, width: 420, errorCorrectionLevel: 'M' }),
        })));
        setBadges(withQr);
        document.title = data.length === 1 ? `QR Badge - ${data[0].name}` : `QR Badges (${data.length})`;
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not load the badges'));
  }, [params]);

  if (error) return <div className="dtr-page"><div className="error-banner">{error}</div></div>;
  if (!badges) return <LoadingSpinner />;

  return (
    <div className="dtr-page">
      <div className="print-toolbar dtr-toolbar">
        <button className="btn btn-primary" onClick={() => window.print()} disabled={!badges.length}>Print</button>
        <span className="muted">
          {badges.length
            ? `${badges.length} badge${badges.length === 1 ? '' : 's'} · print at 100% scale, then cut along the lines`
            : 'No one here has a QR badge yet. Give badges from the employee profile, or print with "give badges" ticked.'}
        </span>
      </div>
      <div className="qr-badges">
        {badges.map((b) => (
          <div className="qr-badge" key={b.id}>
            <img className="qr-badge-logo" src={companyLogo(b)} alt={b.company_name || ''} />
            <img className="qr-badge-code" src={b.qr} alt={`QR badge of ${b.name}`} />
            <div className="qr-badge-name">{b.name}</div>
            {b.position_title && <div className="qr-badge-sub">{b.position_title}</div>}
            <div className="qr-badge-sub">{[b.employee_code, b.branch_name].filter(Boolean).join(' · ')}</div>
            <div className="qr-badge-foot">Scan at the time clock to Time In / Time Out</div>
          </div>
        ))}
      </div>
    </div>
  );
}
