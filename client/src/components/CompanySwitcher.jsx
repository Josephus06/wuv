import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import { COMPANY } from '../config/company';
import { getActiveCompany, setActiveCompany, brandKey } from '../utils/activeCompany';
import { setBirCompanyId } from '../utils/birCompany';

// The topbar's company switcher (top left, where the company name was).
//   Wu Venture     -> all transactions of every company
//   Fresh and Tidy -> Fresh and Tidy's only
//   Cuts for Tots  -> Cuts for Tots' only
// Picking one stores it (utils/activeCompany.js) and reloads, so every screen -- lists, reports,
// dashboard -- is read again under the new company and the theme takes that company's colours.

// The company's own logo: /logos/<key>.png when it has been saved there, else the drawn mark
// (/logos/<key>.svg), else its initials.
export function CompanyLogo({ company, size = 28 }) {
  const key = brandKey(company);
  const [src, setSrc] = useState(`/logos/${key}.png`);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setSrc(`/logos/${key}.png`); setFailed(false); }, [key]);
  if (failed) {
    const initials = key === 'fnt' ? 'F&T' : key === 'c4t' ? 'C4T' : 'WU';
    return <span className="company-logo company-logo-badge" style={{ width: size, height: size }}>{initials}</span>;
  }
  return (
    <img
      className="company-logo" src={src} alt="" style={{ width: size, height: size }}
      onError={() => (src.endsWith('.png') ? setSrc(`/logos/${key}.svg`) : setFailed(true))}
    />
  );
}

export default function CompanySwitcher() {
  const active = getActiveCompany();
  const [open, setOpen] = useState(false);
  const [companies, setCompanies] = useState([]);
  const ref = useRef(null);

  useEffect(() => {
    api.get('/lookups/company-branches').then(({ data }) => setCompanies(data.companies || [])).catch(() => {});
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  const groupName = 'Wu Venture';
  const pick = (company) => {
    setOpen(false);
    if ((company?.id || null) === (active?.id || null)) return;
    setActiveCompany(company);
    // The BIR pages keep their own company choice; keep it in step with the switcher.
    setBirCompanyId(company ? company.id : '');
    window.location.reload();
  };

  return (
    <div className={`company-switch ${open ? 'open' : ''}`} ref={ref}>
      <button
        type="button" className="company-switch-btn" onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu" aria-expanded={open}
        title={active ? `Showing ${active.name} only` : `Showing all companies (${COMPANY.name})`}
      >
        <CompanyLogo company={active} />
        <span className="company-switch-name">{active ? active.name : groupName}</span>
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="company-switch-menu" role="menu">
          <button type="button" role="menuitem" className={`company-switch-item ${!active ? 'active' : ''}`} onClick={() => pick(null)}>
            <CompanyLogo company={null} />
            <span>{groupName}<small>All companies' transactions</small></span>
            {!active && <span className="check">✓</span>}
          </button>
          {companies.map((c) => {
            const on = active && Number(active.id) === Number(c.id);
            return (
              <button key={c.id} type="button" role="menuitem" className={`company-switch-item ${on ? 'active' : ''}`} onClick={() => pick(c)}>
                <CompanyLogo company={c} />
                <span>{c.name}<small>{c.name}'s transactions only</small></span>
                {on && <span className="check">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
