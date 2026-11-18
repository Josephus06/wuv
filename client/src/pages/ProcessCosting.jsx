import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import useAutoSearch from '../utils/useAutoSearch';
import SearchInput from '../components/SearchInput';

const PAGE_SIZE = 15;

// Costing > Process Costing, laid out as the source's PROCESS COSTING list: General Searching, then
// Process Code / Process Name / UOM with a View button. View opens the process's costing brackets
// (ProcessCostingView), Edit there opens the bracket form (ProcessCostingEdit).
export default function ProcessCosting() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [processes, setProcesses] = useState([]);
  const [unitCode, setUnitCode] = useState(new Map());
  const [search, setSearch] = useState('');
  // Every process is listed, inactive ones too, as the source's list does (asked 2026-10-07): with
  // inactive ones left out, a process like SUBCON-SIGN-FF-INST-OC -- inactive in the source as well
  // -- looked as if it had never been migrated. Status narrows it.
  const [status, setStatus] = useState('all');
  const [applied, setApplied] = useState('');
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  useEffect(() => {
    Promise.all([api.get('/lookups/processes'), api.get('/lookups/units-of-measure')]).then(([p, u]) => {
      setProcesses(p.data.sort((a, b) => String(a.process_code).localeCompare(String(b.process_code))));
      setUnitCode(new Map(u.data.map((x) => [x.id, x.code])));
      setLoading(false);
    });
  }, []);

  function runSearch() { setApplied(search); setPage(1); }
  useAutoSearch(search, runSearch);

  // Word by word, not the exact text (asked 2026-11-10): a full process name pasted in found nothing
  // when its spacing or dashes differed from the stored one ("SqFt -151" vs "SqFt - 151", a double or
  // non-breaking space). Every word typed must appear in the code or the name, in any order.
  const words = (s) => String(s || '').toLowerCase().split(/[\s \-–—_/,]+/).filter(Boolean);
  const terms = words(applied);
  const rows = processes.filter((p) => {
    if (status !== 'all' && (status === 'active') !== !!p.is_active) return false;
    if (!terms.length) return true;
    const hay = ` ${words(p.process_code).join(' ')} ${words(p.process_name).join(' ')} `;
    return terms.every((t) => hay.includes(t));
  });
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <div className="page-header">
        <h1>Process Costing <span className="muted" style={{ fontSize: '0.55em', fontWeight: 400 }}>Lists</span></h1>
        {can('/process-costing', 'can_add') && (
          <Link className="btn btn-primary" to={'/process-costing/new'}>Add New</Link>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '1 1 480px', maxWidth: 860 }}>
            <label>General Searching</label>
            <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="Search" />
          </div>
          <div className="field" style={{ width: 160 }}>
            <label>Status</label>
            <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
        </div>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr><th>Process Code</th><th>Process Name</th><th>UOM</th><th style={{ width: 70 }} /></tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No processes found.</td></tr>
                )}
                {pageRows.map((p) => (
                  <tr key={p.id}>
                    <td data-label="Process Code">{p.process_code}</td>
                    <td data-label="Process Name">
                      {p.process_name}
                      {!p.is_active && <span className="badge badge-muted" style={{ marginLeft: 8 }}>Inactive</span>}
                    </td>
                    <td data-label="UOM">{unitCode.get(p.base_unit_id) || ''}</td>
                    <td><Link className="btn btn-sm btn-primary" to={`/process-costing/${p.id}`}>View</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} totalPages={totalPages} onChange={setPage} />
      </div>
    </div>
  );
}
