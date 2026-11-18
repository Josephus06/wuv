import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import EntityPicker from '../components/EntityPicker';
import { useSeason } from '../utils/season';

// Seasonal themes (styles/spooky.css, styles/xmas.css), display only: an account type as a dot.
const TYPE_DOT = {
  spooky: { Asset: '#5AB0FF', Liability: '#FF9A4A', Expense: '#FF6B8A', Revenue: '#8EF08A', Equity: '#9B6BFF', 'Cost of Sales': '#FFC46B' },
  christmas: { Asset: '#7FC8F8', Liability: '#C6A8FF', Expense: '#FF8A80', Revenue: '#9FE8C8', Equity: '#E6F4FF', 'Cost of Sales': '#FFD48A' },
};
// What the search box and the Active pills say in each.
const SEASON_TEXT = {
  spooky: { search: 'Search the crypt…', yes: 'Alive', no: 'Dormant' },
  christmas: { search: 'Check it twice…', yes: 'Nice', no: 'Frozen' },
};

const CONFIG = [
  { key: 'chart-of-accounts', label: 'Chart of Accounts', fields: [
    { name: 'account_code', label: 'Account Code', type: 'text', required: true },
    { name: 'account_name', label: 'Account Name', type: 'text', required: true },
    { name: 'account_type', label: 'Account Type', type: 'select', options: ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense', 'Cost of Sales'], required: true },
    { name: 'parent_account_id', label: 'Parent Account', type: 'ref', ref: 'chart-of-accounts', refLabel: 'account_name' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'companies', label: 'Companies', fields: [
    { name: 'code', label: 'Code', type: 'text', required: true },
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'locations', label: 'Locations', fields: [
    { name: 'location_code', label: 'Code', type: 'text', required: true },
    { name: 'location_name', label: 'Name', type: 'text', required: true },
    { name: 'location_type', label: 'Type', type: 'select', options: ['Branch', 'Warehouse', 'Design', 'Damaged', 'Delivery Charge', 'Technical', 'Subcon', 'Other'] },
    // The company a branch belongs to -- what scopes the Branch picker on an employee.
    { name: 'company_id', label: 'Company', type: 'ref', ref: 'companies', refLabel: 'name' },
    { name: 'address', label: 'Address', type: 'textarea' },
    { name: 'telephone', label: 'Telephone', type: 'text' },
    { name: 'contact_person', label: 'Contact Person', type: 'text' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'business-styles', label: 'Business Styles', fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'description', label: 'Description', type: 'textarea' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'departments', label: 'Departments', fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'description', label: 'Description', type: 'textarea' },
    { name: 'head_user_id', label: 'Department Head', type: 'user-ref' },
    // Empty means the department sees every warehouse's job orders; set it and its people see
    // only that warehouse's (server/src/lib/jobLocationVisibility.js).
    { name: 'job_location_id', label: 'Job Location Restriction', type: 'ref', ref: 'locations', refLabel: 'location_name' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'units-of-measure', label: 'Units of Measure', fields: [
    { name: 'code', label: 'Code', type: 'text', required: true },
    { name: 'title', label: 'Title', type: 'text', required: true },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'unit-conversions', label: 'Unit Conversions', fields: [
    { name: 'from_unit_id', label: 'From Unit', type: 'ref', ref: 'units-of-measure', refLabel: 'title', required: true },
    { name: 'to_unit_id', label: 'To Unit', type: 'ref', ref: 'units-of-measure', refLabel: 'title', required: true },
    { name: 'multiplier', label: 'Multiplier', type: 'number', step: '0.000001', required: true },
  ] },
  { key: 'inventory-categories', label: 'Inventory Categories', fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'description', label: 'Description', type: 'textarea' },
    { name: 'parent_category_id', label: 'Parent Category', type: 'ref', ref: 'inventory-categories', refLabel: 'name' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'taxes', label: 'Taxes', fields: [
    { name: 'code', label: 'Code', type: 'text', required: true },
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'rate', label: 'Rate (%)', type: 'number', step: '0.01', required: true },
    { name: 'tax_account_id', label: 'Tax Account', type: 'ref', ref: 'chart-of-accounts', refLabel: 'account_name' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'withholding-taxes', label: 'Withholding Taxes', fields: [
    { name: 'code', label: 'Code', type: 'text', required: true },
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'rate', label: 'Rate (%)', type: 'number', step: '0.01', required: true },
    { name: 'atc_code', label: 'ATC Code', type: 'text' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'payment-terms', label: 'Payment Terms', fields: [
    { name: 'term_name', label: 'Term Name', type: 'text', required: true },
    { name: 'no_of_days', label: 'No. of Days', type: 'number' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'payment-methods', label: 'Payment Methods', fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'requires_reference', label: 'Requires Reference', type: 'checkbox' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'warranties', label: 'Warranties', fields: [
    { name: 'warranty_type', label: 'Type', type: 'select', options: ['Print', 'Structure', 'Electrical'], required: true },
    { name: 'duration_label', label: 'Duration Label', type: 'text', required: true },
    { name: 'duration_months', label: 'Duration (Months)', type: 'number', required: true },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'reasons', label: 'Reasons', fields: [
    { name: 'reason_type', label: 'Type', type: 'select', options: ['Cancellation', 'Disapproval', 'Return', 'Adjustment', 'Other', 'RFQC', 'RMA', 'Reschedule'], required: true },
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'sales-divisions', label: 'Sales Divisions', fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'discount-items', label: 'Discount Items', fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'discount_type', label: 'Type', type: 'select', options: ['Percent', 'Fixed'] },
    { name: 'value', label: 'Value', type: 'number', step: '0.0001' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  // item_id is the inventory item a Landed Cost PO line records for this charge. Editable here
  // because it is the only place to set it, and a landed cost without one cannot be put on a PO --
  // the picker on that screen shows it greyed with the reason rather than hiding it.
  { key: 'landed-costs', label: 'Landed Costs', fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'allocation_method', label: 'Allocation Method', type: 'select', options: ['By Value', 'By Quantity', 'By Weight'] },
    { name: 'item_id', label: 'Inventory Item', type: 'ref', ref: 'landed-cost-items', refLabel: 'label' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  // Non-Inventory Items and Service Items used to be thin four-column tabs here. They are full
  // item master records in live -- units, expense account, JO/PO flags, last purchase price --
  // and purchase order, receipt and vendor bill lines all reference `inventories`, so they live
  // there and have their own Master Lists pages (/non-inventories, /service-items). Keeping a
  // second, poorer copy of the same items in a lookup table only invited them to disagree.
  { key: 'items', label: 'Costing Items', fields: [
    { name: 'item_name', label: 'Item Name', type: 'text', required: true },
    { name: 'item_type', label: 'Type', type: 'select', options: ['Material', 'Labor', 'Service'], required: true },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'processes', label: 'Processes', fields: [
    { name: 'process_code', label: 'Process Code', type: 'text', required: true },
    { name: 'process_name', label: 'Process Name', type: 'text', required: true },
    { name: 'base_unit_id', label: 'Base Unit', type: 'ref', ref: 'units-of-measure', refLabel: 'title', required: true },
    { name: 'default_location_id', label: 'Default Location', type: 'ref', ref: 'locations', refLabel: 'location_name' },
    { name: 'minutes_per_unit', label: 'Minutes per Unit', type: 'number' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'asset-assigned-locations', label: 'Asset Assigned Locations', fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'description', label: 'Description', type: 'textarea' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  { key: 'user-groups', label: 'User Groups', fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ] },
  // Flat, company-wide list (general_managers), not a row-editable table -- rendered
  // as its own dedicated list+picker below instead of the generic DataTable/Modal
  // flow, same reasoning as the per-department Ticket Approvers section.
  { key: 'general-managers', label: 'General Managers', fields: [] },
];

function emptyForm(fields) {
  const form = {};
  for (const f of fields) form[f.name] = f.type === 'checkbox' ? f.name === 'is_active' : '';
  return form;
}

// Department heads are picked from `users`, not from another lookup table, so they're
// fetched via /users (once, whenever the active tab needs it) rather than the generic
// /lookups/:ref path the 'ref' field type uses.


// The forms a department head notes, and how a head's note_form_types reads: empty means all of them.
const NOTED_FORM_TYPES = [['payment', 'Request for Payment'], ['fund_transfer', 'Fund Transfer'], ['revolving_fund', 'Revolving Fund'], ['attendance_adjustment', 'Attendance Adjustment'], ['business_trip', 'Business Trip'], ['overtime', 'Overtime'], ['gate_pass', 'Gate Pass'], ['hmo_enrollment', 'Life & Health Enrollment'], ['hmo_deletion', 'Life & Health Deletion'], ['bpi_deletion', 'BPI Deletion']];
// No 'leave': a Leave Application is not noted, it goes straight to approval (2026-10-19).
const noteTypesOf = (a) => (a.note_form_types ? String(a.note_form_types).split(',') : NOTED_FORM_TYPES.map(([t]) => t));

export default function Lookups() {
  const { can } = useAuth();
  const season = useSeason();
  const themed = !!SEASON_TEXT[season];
  const navigate = useNavigate();
  // ?tab=processes: the process view / edit pages come back to their own tab.
  const [params] = useSearchParams();
  const [activeKey, setActiveKey] = useState(CONFIG.some((c) => c.key === params.get('tab')) ? params.get('tab') : CONFIG[0].key);
  // A process has its own view and edit pages (Materials, Ink and the Ink Calculation -- 2026-11-04).
  const isProcesses = activeKey === 'processes';
  const [rows, setRows] = useState([]);
  const [refOptions, setRefOptions] = useState({});
  const [userOptions, setUserOptions] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [approvers, setApprovers] = useState([]);

  const active = useMemo(() => CONFIG.find((c) => c.key === activeKey), [activeKey]);
  const refKeys = useMemo(() => [...new Set(active.fields.filter((f) => f.type === 'ref').map((f) => f.ref))], [active]);
  const needsUsers = useMemo(
    () => active.fields.some((f) => f.type === 'user-ref') || activeKey === 'general-managers',
    [active, activeKey]
  );

  async function load() {
    setLoading(true);
    const { data } = await api.get(`/lookups/${activeKey}`);
    setRows(data);
    const refs = {};
    for (const refKey of refKeys) {
      const res = await api.get(`/lookups/${refKey}`);
      refs[refKey] = res.data;
    }
    setRefOptions(refs);
    if (needsUsers) {
      const res = await api.get('/users');
      setUserOptions(res.data);
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, [activeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  function openCreate() {
    if (isProcesses) { navigate('/processes/new'); return; }
    setForm(emptyForm(active.fields));
    setEditing('new');
    setError('');
  }

  function openEdit(row) {
    if (isProcesses) { navigate(`/processes/${row.id}/edit`); return; }
    const f = {};
    for (const field of active.fields) f[field.name] = field.type === 'checkbox' ? !!row[field.name] : (row[field.name] ?? '');
    setForm(f);
    setEditing(row.id);
    setError('');
    if (activeKey === 'departments') loadApprovers(row.id);
  }

  // Ticket approvers are many-to-many (department_ticket_approvers), so they're managed
  // as their own immediately-persisted list here rather than folded into the generic
  // single-row Save/Cancel form above -- each add/remove is its own request.
  async function loadApprovers(departmentId) {
    const { data } = await api.get(`/lookups/departments/${departmentId}/ticket-approvers`);
    setApprovers(data);
  }

  async function addApprover(u) {
    await api.post(`/lookups/departments/${editing}/ticket-approvers`, { user_id: u.id });
    loadApprovers(editing);
  }

  async function removeApprover(u) {
    await api.delete(`/lookups/departments/${editing}/ticket-approvers/${u.id}`);
    loadApprovers(editing);
  }

  // Ticked straight through, like adding and removing -- this section is its own
  // immediately-persisted list and never waits on the form's Save button. The row is updated
  // locally first so the box does not visibly lag the click, then reloaded from the server.
  async function setApproverRole(u, patch) {
    setApprovers((rows) => rows.map((r) => (r.id === u.id ? { ...r, ...patch } : r)));
    // note_form_types is held here as the stored comma list; the server takes an array.
    const body = patch.note_form_types === undefined ? patch
      : { ...patch, note_form_types: patch.note_form_types ? patch.note_form_types.split(',') : [] };
    try {
      await api.put(`/lookups/departments/${editing}/ticket-approvers/${u.id}`, body);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not change that.');
    }
    loadApprovers(editing);
  }

  // General Managers: same immediately-persisted list pattern as Ticket Approvers
  // above, just company-wide rather than per-department -- `rows` already holds the
  // current GM list since GET /lookups/general-managers matches the generic load().
  async function addGeneralManager(u) {
    await api.post('/lookups/general-managers', { user_id: u.id });
    load();
  }

  async function removeGeneralManager(u) {
    await api.delete(`/lookups/general-managers/${u.id}`);
    load();
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const payload = {};
    for (const f of active.fields) {
      // An empty SELECT is nothing chosen, which for a nullable ENUM column means NULL -- sending
      // '' instead is rejected outright ("Data truncated for column ..."), because '' is not one of
      // the enum's values. That is why editing a Landed Cost failed: every row holds '' for
      // allocation_method, the select shows nothing, and saving handed '' straight back.
      const blank = form[f.name] === '' || form[f.name] === undefined;
      payload[f.name] = blank && (f.type === 'ref' || f.type === 'user-ref' || f.type === 'select')
        ? null
        : form[f.name];
    }
    try {
      if (editing === 'new') {
        await api.post(`/lookups/${activeKey}`, payload);
      } else {
        await api.put(`/lookups/${activeKey}/${editing}`, payload);
      }
      setEditing(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    }
  }

  async function handleDelete(row) {
    if (!confirm('Delete this record?')) return;
    try {
      await api.delete(`/lookups/${activeKey}/${row.id}`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Delete failed');
    }
  }

  // A seasonal theme (Halloween / Christmas), display only: the account code muted, the name bright, the type
  // as a coloured dot, Active as Alive / Dormant. The values themselves are unchanged and the
  // search reads them (searchRaw), not what is drawn.
  const seasonRender = (f) => {
    if (!themed) return null;
    const text = SEASON_TEXT[season];
    if (f.name === 'account_type') return (r) => <span><i className="sp-dot" style={{ background: TYPE_DOT[season][r.account_type] || '#A8BCD6' }} />{r.account_type}</span>;
    if (f.name === 'account_code') return (r) => <span className="sp-code">{r.account_code}</span>;
    if (f.name === 'account_name') return (r) => <span className="sp-name">{r.account_name}</span>;
    if (f.type === 'checkbox') {
      const xmas = season === 'christmas';
      return (r) => (r[f.name]
        ? (
          <span className={`sp-pill ${xmas ? 'xm-nice' : 'sp-alive'}`}>
            {xmas
              ? <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor" aria-hidden="true"><path d="M8 1l2 4.5 5 .5-3.8 3.3 1.1 4.9L8 11.6 3.7 14.2l1.1-4.9L1 6l5-.5z" /></svg>
              : <i />}
            {text.yes}
          </span>
        )
        : (
          <span className={`sp-pill ${xmas ? 'xm-frozen' : 'sp-dormant'}`}>
            {xmas
              ? <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 2v20M4.9 4.9l14.2 14.2M2 12h20M4.9 19.1L19.1 4.9" /></svg>
              : <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M8 1a5 5 0 0 0-5 5v8l2-1.5L6.5 14 8 12.5 9.5 14 11 12.5l2 1.5V6a5 5 0 0 0-5-5zM6 5.5a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm4 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2z" /></svg>}
            {text.no}
          </span>
        ));
    }
    return null;
  };

  const columns = active.fields
    .filter((f) => f.type !== 'textarea')
    .map((f) => {
      const sp = seasonRender(f);
      if (sp) return { key: f.name, label: f.label, render: sp, searchRaw: true };
      return {
        key: f.name,
        label: f.label,
        render: f.type === 'checkbox'
          ? (r) => (r[f.name] ? <span className="badge badge-success">Yes</span> : <span className="badge badge-muted">No</span>)
          : f.type === 'ref'
            ? (r) => {
              const list = refOptions[f.ref] || [];
              const match = list.find((o) => o.id === r[f.name]);
              return match ? match[f.refLabel] : '—';
            }
            : f.type === 'user-ref'
              ? (r) => {
                const match = userOptions.find((u) => u.id === r[f.name]);
                return match ? match.display_name : '—';
              }
              : (isProcesses && f.name === 'process_code' ? (r) => <Link to={`/processes/${r.id}`}>{r.process_code}</Link> : undefined),
      };
    });

  // Search box over whichever tab is open: matches any column as shown (a referenced name, not its id).
  const q = search.trim().toLowerCase();
  const shownRows = !q ? rows : rows.filter((r) => columns.some((c) => {
    // A link (the process code) searches by its own text.
    const v = c.render && !c.searchRaw && !(isProcesses && c.key === 'process_code') ? c.render(r) : r[c.key];
    return (typeof v === 'string' || typeof v === 'number') && String(v).toLowerCase().includes(q);
  }));

  return (
    <div>
      <div className="page-header">
        <h1>Lookups</h1>
        {activeKey !== 'general-managers' && can('/lookups', 'can_add') && (
          <button className="btn btn-primary" onClick={openCreate}><span className="sp-only" aria-hidden="true" style={{ marginRight: 6 }}>+</span>Add Record</button>
        )}
      </div>
      <div className="tabs">
        {CONFIG.map((c) => (
          <button key={c.key} className={c.key === activeKey ? 'active' : ''} onClick={() => { setActiveKey(c.key); setSearch(''); }}>
            {c.label}
          </button>
        ))}
      </div>
      <div className="card">
        {loading ? <LoadingSpinner /> : activeKey === 'general-managers' ? (
          <div>
            <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
              Whoever a department head forwards a ticket to for extra sign-off (Tickets page's "Forward to GM"). Any one of these people approving clears it -- company-wide, not tied to a department.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
              {rows.length === 0 && <div className="muted">No General Managers tagged.</div>}
              {rows.map((u) => (
                <div key={u.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', maxWidth: 360 }}>
                  <span>{u.display_name}</span>
                  {can('/lookups', 'can_edit') && (
                    <button className="btn btn-sm btn-danger" onClick={() => removeGeneralManager(u)}>Remove</button>
                  )}
                </div>
              ))}
            </div>
            {can('/lookups', 'can_edit') && (
              <EntityPicker
                label="Add General Manager" items={userOptions.filter((u) => !rows.some((r) => r.id === u.id))}
                getLabel={(u) => u?.display_name}
                columns={[{ key: 'display_name', label: 'Name' }, { key: 'username', label: 'Username' }]}
                searchKeys={['display_name', 'username']}
                onSelect={addGeneralManager}
                triggerLabel="Add General Manager"
                triggerClassName="btn btn-sm"
              />
            )}
          </div>
        ) : (
          <>
          {themed ? (
            // Spooky: the tab's name, a count, and the search on the right.
            <div className="sp-card-head">
              <div>
                <h2>{active.label}</h2>
                <div className="sp-count">{shownRows.length} of {rows.length} {active.key === 'chart-of-accounts' ? 'accounts' : 'records'}{q ? ' matching' : ''}</div>
              </div>
              <input type="search" placeholder={SEASON_TEXT[season].search} value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 360, width: '100%' }} />
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <input type="search" placeholder={`Search ${active.label}…`} value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 360 }} />
              {q && <span className="muted" style={{ fontSize: 13 }}>{shownRows.length} of {rows.length}</span>}
            </div>
          )}
          <DataTable
            paginate
            columns={columns}
            rows={shownRows}
            emptyLabel={q ? 'No matches.' : undefined}
            actions={(row) => (
              <>
                {can('/lookups', 'can_edit') && <button className="btn btn-sm" onClick={() => openEdit(row)}>Edit</button>}
                {can('/lookups', 'can_delete') && <button className="btn btn-sm btn-danger" onClick={() => handleDelete(row)}>Delete</button>}
              </>
            )}
          />
          </>
        )}
      </div>

      {editing && (
        <Modal title={`${editing === 'new' ? 'Add' : 'Edit'} — ${active.label}`} onClose={() => setEditing(null)}>
          <form onSubmit={handleSubmit}>
            {error && <div className="error-banner">{error}</div>}
            {active.fields.map((f) => (
              <div className="field" key={f.name}>
                {f.type === 'checkbox' ? (
                  <div className="field-checkbox">
                    <input
                      type="checkbox" id={f.name}
                      checked={!!form[f.name]}
                      onChange={(e) => setForm({ ...form, [f.name]: e.target.checked })}
                    />
                    <label htmlFor={f.name}>{f.label}</label>
                  </div>
                ) : f.type === 'select' ? (
                  <>
                    <label>{f.label}</label>
                    <select required={f.required} value={form[f.name] ?? ''} onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}>
                      <option value="">—</option>
                      {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </>
                ) : f.type === 'ref' ? (
                  <>
                    <label>{f.label}</label>
                    <select required={f.required} value={form[f.name] ?? ''} onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}>
                      <option value="">—</option>
                      {(refOptions[f.ref] || []).map((o) => <option key={o.id} value={o.id}>{o[f.refLabel]}</option>)}
                    </select>
                  </>
                ) : f.type === 'user-ref' ? (
                  <>
                    <label>{f.label}</label>
                    <select required={f.required} value={form[f.name] ?? ''} onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}>
                      <option value="">—</option>
                      {userOptions.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
                    </select>
                  </>
                ) : f.type === 'textarea' ? (
                  <>
                    <label>{f.label}</label>
                    <textarea rows={3} value={form[f.name] ?? ''} onChange={(e) => setForm({ ...form, [f.name]: e.target.value })} />
                  </>
                ) : (
                  <>
                    <label>{f.label}</label>
                    <input
                      type={f.type === 'number' ? 'number' : 'text'}
                      step={f.step}
                      required={f.required}
                      value={form[f.name] ?? ''}
                      onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}
                    />
                  </>
                )}
              </div>
            ))}

            {activeKey === 'departments' && editing !== 'new' && (
              <div className="field">
                <label>Department Heads</label>
                {/* One list, two jobs, ticked per person. They were the same list already -- the
                    Forms module read the ticket approvers to decide who notes an expense claim --
                    so the boxes make that explicit rather than letting one grant imply the other. */}
                <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                  Tickets: any ticket created by someone in this department needs sign-off from one of these people
                  before the receiving department can assign it. Forms: a Request for Payment, Fund Transfer, Revolving Fund or
                  Attendance Adjustment filed from this department is noted by one of them -- tick which forms each one notes.
                  Leave follows each person's Supervisors (Users &amp; Permissions): their supervisor notes, and the first SBU,
                  General Manager or person ticked Approve leave up the line approves; an SBU's leave is approved by whoever
                  they report to. Someone with no supervisors set: approved by this department's Approve leave person.
                  Leave empty for no approval gate.
                </div>
                <div className="dept-heads">
                  {approvers.length === 0 && <div className="muted">No heads tagged.</div>}
                  {approvers.map((a) => (
                    <div key={a.id} className="dept-head">
                      <div className="dept-head-top">
                        <span className="dept-head-name">{a.display_name}</span>
                        <label className="check">
                          <input
                            type="checkbox" checked={!!a.can_approve_ticket}
                            onChange={(e) => setApproverRole(a, { can_approve_ticket: e.target.checked })}
                          />
                          Approve ticket
                        </label>
                        <label className="check">
                          <input
                            type="checkbox" checked={!!a.can_note_form}
                            onChange={(e) => setApproverRole(a, { can_note_form: e.target.checked })}
                          />
                          Note form
                        </label>
                        {/* Approves this department's Leave Applications (2026-10-19); see routes/forms.js mayApprove. */}
                        <label className="check">
                          <input
                            type="checkbox" checked={!!a.can_approve_leave}
                            onChange={(e) => setApproverRole(a, { can_approve_leave: e.target.checked })}
                          />
                          Approve leave
                        </label>
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => removeApprover(a)}>Remove</button>
                      </div>
                      {/* Which forms this head notes (asked 2026-10-08). None picked on the server means
                          all, so unticking the last one turns Note form off instead. */}
                      {!!a.can_note_form && (
                        <div className="dept-head-forms">
                          <span className="muted dept-head-forms-label">Notes these forms:</span>
                          {NOTED_FORM_TYPES.map(([type, label]) => {
                            const current = noteTypesOf(a);
                            return (
                              <label key={type} className="check">
                                <input type="checkbox" checked={current.includes(type)}
                                  onChange={(e) => {
                                    const next = e.target.checked ? [...current, type] : current.filter((t) => t !== type);
                                    setApproverRole(a, next.length
                                      ? { note_form_types: next.length === NOTED_FORM_TYPES.length ? null : next.join(',') }
                                      : { can_note_form: false, note_form_types: null });
                                  }} />
                                {label}
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <EntityPicker
                  label="Add Approver" items={userOptions.filter((u) => !approvers.some((a) => a.id === u.id))}
                  getLabel={(u) => u?.display_name}
                  columns={[{ key: 'display_name', label: 'Name' }, { key: 'username', label: 'Username' }]}
                  searchKeys={['display_name', 'username']}
                  onSelect={addApprover}
                  triggerLabel="Add Approver"
                  triggerClassName="btn btn-sm"
                />
              </div>
            )}

            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Save</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
