import { useEffect, useState } from 'react';
import api from '../api/client';
import { COMPANY } from '../config/company';
import { getBirCompanyId, setBirCompanyId } from '../utils/birCompany';

// "Filing company" on every BIR page: which company's books the report is prepared from, and whose
// TIN / registered name the 2307 prints. The choice is remembered and sent with every BIR request
// (api/client.js), so changing it reloads the page onto the other company.
export default function BirCompanyPicker() {
  const [companies, setCompanies] = useState([]);
  const current = getBirCompanyId();
  useEffect(() => {
    api.get('/lookups/company-branches').then(({ data }) => setCompanies(data.companies || [])).catch(() => {});
  }, []);
  return (
    <div className="field" style={{ minWidth: 220, margin: 0 }}>
      <label>Filing company</label>
      <select value={current} onChange={(e) => { setBirCompanyId(e.target.value); window.location.reload(); }}>
        <option value="">{COMPANY.name} (all)</option>
        {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </div>
  );
}
