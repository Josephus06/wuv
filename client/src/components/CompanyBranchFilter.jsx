import { useEffect, useState } from 'react';
import api from '../api/client';
import { getActiveCompany } from '../utils/activeCompany';

// Company / Branch picker for the group's books. One set of books covers every company; a report
// can be run for the whole group (COMPANY.name, e.g. Wu Ventures -- the consolidated view), for one
// company (all its branches), or for one branch. `value` is { companyId, locationId }, '' for "all".
//
// toParams(value) turns it into the query string the report routes read (lib/companyScope.js).
export function toParams(value) {
  const p = {};
  if (value?.locationId) p.locationId = value.locationId;
  else if (value?.companyId) p.companyId = value.companyId;
  return p;
}

let cache = null;
function loadCompanyBranches() {
  if (!cache) cache = api.get('/lookups/company-branches').then(({ data }) => data).catch(() => { cache = null; return { companies: [], branches: [] }; });
  return cache;
}

export default function CompanyBranchFilter({ value, onChange, showBranch = true }) {
  const [data, setData] = useState({ companies: [], branches: [] });
  useEffect(() => { loadCompanyBranches().then(setData); }, []);

  // A company picked in the topbar switcher fixes the company here; only its branches are offered.
  const active = getActiveCompany();
  const companyId = active ? String(active.id) : (value?.companyId || '');
  const locationId = value?.locationId || '';
  const branches = data.branches.filter((b) => !companyId || String(b.company_id) === String(companyId));

  return (
    <>
      <div className="field" style={{ minWidth: 180 }}>
        <label>Company</label>
        {active ? (
          <select value={companyId} disabled title="Set by the company switcher at the top left">
            <option value={companyId}>{active.name}</option>
          </select>
        ) : (
          <select value={companyId} onChange={(e) => onChange({ companyId: e.target.value, locationId: '' })}>
            <option value="">All companies</option>
            {data.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
      </div>
      {showBranch && (
        <div className="field" style={{ minWidth: 180 }}>
          <label>Branch</label>
          <select
            value={locationId}
            onChange={(e) => {
              const b = data.branches.find((x) => String(x.id) === e.target.value);
              onChange({ companyId: b?.company_id ? String(b.company_id) : companyId, locationId: e.target.value });
            }}
          >
            <option value="">All branches</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.location_name}</option>)}
          </select>
        </div>
      )}
    </>
  );
}

// The line a scoped report shows above its figures: what it covers, and how many entries with no
// branch were left out (they appear only in the all-companies view).
export function ScopeNote({ scope }) {
  if (!scope) return null;
  return (
    <div className="muted" style={{ margin: '4px 0 10px' }}>
      Showing <strong>{scope.label}</strong> ({scope.branch_count} branch{scope.branch_count === 1 ? '' : 'es'}).
      {scope.unassigned_lines > 0 && (
        <span style={{ color: 'var(--warning)', marginLeft: 6 }}>
          {scope.unassigned_lines} ledger line{scope.unassigned_lines === 1 ? '' : 's'} with no branch {scope.unassigned_lines === 1 ? 'is' : 'are'} not included -- set the branch on those transactions.
        </span>
      )}
      {scope.branch_count === 0 && (
        <span style={{ color: 'var(--warning)', marginLeft: 6 }}>
          No branch is assigned to this company yet -- set it under Lookups &gt; Locations.
        </span>
      )}
    </div>
  );
}
