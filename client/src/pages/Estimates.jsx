import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useHeadOfficeFilter } from '../utils/useHeadOffice';
import { useAuth } from '../context/useAuth';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import useAutoSearch from '../utils/useAutoSearch';
import { CustomerLink } from '../components/PartyLink';
import FilterPicker from '../components/FilterPicker';
import SearchInput from '../components/SearchInput';
import { downloadFile } from '../utils/downloadFile';

// Mirrors the real system's Estimates list: status tabs with counts (instead of a
// plain flat table), a collapsible filter panel, and a "View" action per row that
// opens a read-only detail page rather than jumping straight into edit.
const STATUS_TABS = [
  // Quotes raised on the customer-facing website arrive with no sales rep -- nobody took the
  // enquiry -- so they wait here until the Marketing Manager assigns one.
  { key: 'for_csa_assignment', label: 'For CSA Assignment' },
  { key: 'pending_supervisor_approval', label: 'Pending Supervisor Approval' },
  { key: 'pending_customer_approval', label: 'Pending Customer Approval' },
  { key: 'approved', label: 'Approved' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'disapproved', label: 'Disapproved' },
];

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

export default function Estimates() {
  const { can, user } = useAuth();
  const navigate = useNavigate();

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [showFilters, setShowFilters] = useState(true); // shown by default; Toggle Filter hides them (asked 2026-10-06)
  const [syncing, setSyncing] = useState(false);

  const [status, setStatus] = useState('pending_supervisor_approval');
  const [search, setSearch] = useState('');
  const [salesRepId, setSalesRepId] = useState('');
  // Head Office by default (2026-10-14; utils/useHeadOffice); null until known, and the list waits for it.
  const [officeLocationId, setOfficeLocationId] = useHeadOfficeFilter();
  const [asOf, setAsOf] = useState('');
  const [page, setPage] = useState(1);
  const limit = 10;

  const [employees, setEmployees] = useState([]);
  const [locations, setLocations] = useState([]);

  // For CSA Assignment only: one rep picker for the tab rather than one per row, since the queue
  // is worked a few at a time and re-choosing the same person for each is busywork.
  const [assignRepId, setAssignRepId] = useState('');
  const [assigning, setAssigning] = useState(null);
  const isCsaTab = status === 'for_csa_assignment';
  const canAssign = can('/estimates-csa-assignment', 'can_approve');

  // The filters and tab, as the server takes them -- shared by the list and its Extract.
  function filterParams() {
    const params = { status };
    if (search) params.search = search;
    if (salesRepId) params.sales_rep_id = salesRepId;
    if (officeLocationId) params.office_location_id = officeLocationId;
    if (asOf) params.as_of = asOf;
    return params;
  }

  // Extract (asked 2026-11-13): every estimate under the filters and tab -- not just this page -- as a workbook.
  const [extracting, setExtracting] = useState(false);
  async function extract() {
    setExtracting(true);
    try {
      await downloadFile('/estimates', { ...filterParams(), format: 'xlsx' }, `estimates-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch {
      alert('Extract failed. Please try again.');
    } finally {
      setExtracting(false);
    }
  }

  async function load() {
    setLoading(true);
    const params = { ...filterParams(), page, limit };
    const { data } = await api.get('/estimates', { params });
    setRows(data.rows);
    setTotal(data.total);
    setCounts(data.counts);
    setLoading(false);
  }

  useEffect(() => {
    api.get('/employees').then(({ data }) => setEmployees(data));
    api.get('/lookups/locations').then(({ data }) => setLocations(data));
  }, []);

  useEffect(() => { if (officeLocationId === null) return; load(); }, [status, page, officeLocationId === null]); // eslint-disable-line react-hooks/exhaustive-deps

  function runSearch() {
    setPage(1);
    load();
  }
  useAutoSearch(search, runSearch);

  // Assigning a rep to a website quote. It is the transition as well as the assignment -- the
  // server moves the estimate to Pending Customer Approval in the same step -- so the row leaves
  // this tab once it succeeds, which is why the whole list reloads afterwards.
  async function handleAssign(row) {
    const rep = employees.find((e) => String(e.id) === String(assignRepId));
    if (!rep) { alert('Choose a sales rep first.'); return; }
    if (!confirm(`Assign ${rep.name || `${rep.first_name} ${rep.last_name}`} to ${row.estimate_no}?\n\nIt moves to Pending Customer Approval.`)) return;
    setAssigning(row.id);
    try {
      await api.put(`/estimates/${row.id}/assign-csa`, { sales_rep_id: assignRepId });
      setAssignRepId('');
      await load();
    } catch (err) {
      alert(err.response?.data?.error || 'Could not assign that estimate.');
    } finally {
      setAssigning(null);
    }
  }

  async function handleDelete(row) {
    if (!confirm(`Delete estimate "${row.estimate_no}"? This removes its job orders and process lines too.`)) return;
    try {
      await api.delete(`/estimates/${row.id}`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Delete failed');
    }
  }

  async function handleSync() {
    setSyncing(true);
    try {
      const { data } = await api.post('/admin/sync-estimates');
      alert(`Sync complete. Checked ${data.checked}, imported ${data.imported} new, ${data.skipped} already present, ${data.errored} errored.`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div>
      <div className="page-header">
        <h1>Saved Estimates</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => setShowFilters((s) => !s)}>Toggle Filter</button>
          {user?.account_type === 'System Admin' && (
            <button className="btn btn-sm" disabled={syncing} onClick={handleSync}>
              {syncing ? <LoadingSpinner inline size="sm" label="Syncing..." /> : 'Sync New Estimates'}
            </button>
          )}
          {can('/estimates', 'can_add') && <Link className="btn btn-primary" to={'/estimates/new'}>Add Estimate</Link>}
        </div>
      </div>

      {showFilters && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="filter-grid">
            <div className="field">
              <label>General Searching</label>
              <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..." />
            </div>
            <div className="field">
              <label>Sales Rep</label>
              <FilterPicker label="Sales Rep" items={employees} value={salesRepId} onChange={(v) => setSalesRepId(v)}
              getLabel={(e) => `${e.first_name} ${e.last_name}`} allLabel="All" />
            </div>
            <div className="field">
              <label>Location</label>
              <FilterPicker label="Location" items={locations} value={officeLocationId ?? ''} onChange={(v) => setOfficeLocationId(v)}
              getLabel={(l) => l.location_name} allLabel="All" />
            </div>
            <div className="field">
              <label>Date Created (As of)</label>
              <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            </div>
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={runSearch}>Search</button>
            <button className="btn" disabled={extracting} onClick={extract} title="Download every estimate under the filters and tab above">
              {extracting ? 'Extracting...' : 'Extract'}
            </button>
          </div>
        </div>
      )}

      <div className="status-tabs">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            className={`status-tab ${status === t.key ? 'active' : ''}`}
            onClick={() => { setStatus(t.key); setPage(1); }}
          >
            {t.label} <span className="badge badge-muted">{counts[t.key] ?? 0}</span>
          </button>
        ))}
      </div>

      {/* Quotes raised on the website arrive with no sales rep. Pick who takes it, then Assign on
          the row -- which also moves it to Pending Customer Approval, so it leaves this tab. */}
      {isCsaTab && (
        <div className="card" style={{ marginTop: 16, marginBottom: 16 }}>
          {canAssign ? (
            <div className="filter-grid" style={{ alignItems: 'end' }}>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Assign these to</label>
                <select value={assignRepId} onChange={(e) => setAssignRepId(e.target.value)}>
                  <option value="">— choose a sales rep —</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>{e.name || `${e.first_name} ${e.last_name}`}</option>
                  ))}
                </select>
                <div className="muted" style={{ fontSize: '0.85em', marginTop: 6 }}>
                  Assigning also moves the estimate to Pending Customer Approval.
                </div>
              </div>
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              These quotations came from the website and have no sales rep yet. Assigning one is
              restricted — ask the Marketing Manager to pick up this queue.
            </p>
          )}
        </div>
      )}

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <>
            <div className="table-wrap">
              <table className="responsive-cards">
                <thead>
                  <tr>
                    <th>Estimate No</th>
                    <th>Date Created</th>
                    <th>Location</th>
                    <th>Customer</th>
                    <th>Contract Description</th>
                    <th>Sales Rep.</th>
                    <th>Prepared By</th>
                    <th>Total Amount</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>No estimates found.</td></tr>
                  )}
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td data-label="Estimate No">{row.estimate_no}</td>
                      <td data-label="Date Created">{row.date_created ? String(row.date_created).slice(0, 10) : ''}</td>
                      <td data-label="Location">{row.location_name}</td>
                      <td data-label="Customer"><CustomerLink id={row.customer_id} name={row.customer_name} /></td>
                      <td data-label="Contract Description">{row.contract_description}</td>
                      <td data-label="Sales Rep.">{row.sales_rep_name}</td>
                      <td data-label="Prepared By">{row.prepared_by_name}</td>
                      {/* effective_total_amount, not total_amount: the stored header is blank on
                          estimates nobody has run "Recalculate from Job Orders" on, so it showed
                          0.00 for estimates that plainly had money in their lines. The server
                          falls back between the two. */}
                      <td data-label="Total Amount">{money(row.effective_total_amount)}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <Link className="btn btn-sm btn-primary" to={`/estimates/${row.id}`}>View</Link>
                          {isCsaTab && canAssign && (
                            <button
                              className="btn btn-sm"
                              disabled={!assignRepId || assigning === row.id}
                              title={assignRepId ? undefined : 'Choose a sales rep above first'}
                              onClick={() => handleAssign(row)}
                            >
                              {assigning === row.id ? 'Assigning…' : 'Assign'}
                            </button>
                          )}
                          {can('/estimates', 'can_delete') && <button className="btn btn-sm btn-danger" onClick={() => handleDelete(row)}>Delete</button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} totalPages={totalPages} onChange={setPage} />
          </>
        )}
      </div>
    </div>
  );
}
