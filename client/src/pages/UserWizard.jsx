import { Fragment, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import { PLANNER_FLAGS } from '../utils/plannerRoles';
import { ACCOUNT_TYPE_OPTIONS } from '../utils/accountTypes';

// Mirrors the real system's "Add / Update User" screen: a 4-step wizard (User
// Account -> User Branches -> User Permissions and Restrictions -> Account Type)
// instead of a single modal form + a separate permissions modal.
const STEPS = ['User Account', 'User Branches', 'User Permissions and Restrictions', 'Account Type'];

const PERMISSION_ACTIONS = [
  { key: 'can_view', label: 'Can View' },
  { key: 'can_add', label: 'Can Add' },
  // These two were ONE checkbox until now, and it was labelled with the wrong one's name:
  // can_edit has been shown as "Can Update" since the grid was built, so ticking it to let
  // somebody advance a document actually handed them the Edit form.
  { key: 'can_edit', label: 'Can Edit' },
  // Move the transaction along without being able to rewrite it -- an artist sending a layout
  // for Sales Approval needs exactly this and nothing more.
  { key: 'can_update', label: 'Can Update' },
  // Whose records you see once you are on the screen, as opposed to whether you may open it
  // at all. Without it a page shows a person only their own rows; with it, everyone's.
  { key: 'can_view_all', label: 'Can View All' },
  { key: 'can_delete', label: 'Can Delete' },
  { key: 'can_approve', label: 'Can Approve' },
  // Printing a Job Order is granted separately from viewing one -- the printed sheet is what
  // goes to the production floor, so it is handed out deliberately.
  { key: 'can_print', label: 'Can Print' },
  // Voiding a POSTED document -- an invoice, cheque, payment, journal -- reverses it in the books,
  // so it is granted on its own rather than coming with the right to edit.
  { key: 'can_void', label: 'Can Void' },
];

const EMPTY_ACCOUNT = {
  is_active: true, username: '', password: '', email: '', display_name: '', employee_id: '', default_branch_id: '',
  // The drawn signature, as a data URL. null means "cleared"; undefined means "not touched", which
  // is what stops a save from wiping one that already exists.
  signature_data: null, signature_set_at: null,
};

const EMPTY_ACCOUNT_TYPE = {
  user_group_id: '', account_type: '', can_approve_sales_estimate: false, is_account_officer: false,
  is_supervisor: false, is_sales_manager: false, is_sales_marketing_director: false, is_sales_business_unit: false,
  is_design_supervisor: false, is_purchasing_supervisor: false, can_edit_approved_po: false, is_accounts_payable: false,
  ...Object.fromEntries(PLANNER_FLAGS.map((flag) => [flag, false])),
  is_production_supervisor: false, approval_code: '', supervisor_ids: [],
  sales_division_ids: [],
  // Monthly fuel limit (2026-10-19): a Fuel Request past it is refused at submit.
  has_fuel_limit: false, fuel_limit_liters: '', is_fuel_approver: false,
};

const EMPTY_BRANCH = { location_id: '', department_id: '', can_override_date: false, remarks: '', is_default: false };

// A signature photo can be several MB straight off a phone; printed it is a few centimetres wide.
// Scaled to at most 900 x 360 px here (PNG keeps a transparent background; a JPG stays JPG), which
// keeps it well under the server's 2 MB cap for signature_data.
function signatureFromFile(file) {
  return new Promise((resolve, reject) => {
    if (!['image/png', 'image/jpeg'].includes(String(file.type).toLowerCase())) { reject(new Error('Upload a PNG or JPG picture of the signature.')); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not a picture this browser can open.'));
      img.onload = () => {
        const scale = Math.min(1, 900 / img.width, 360 / img.height);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const png = /png$/i.test(file.type);
        resolve(canvas.toDataURL(png ? 'image/png' : 'image/jpeg', 0.92));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

export default function UserWizard() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [userId, setUserId] = useState(id ? Number(id) : null);
  const [account, setAccount] = useState(EMPTY_ACCOUNT);
  const [accountType, setAccountType] = useState(EMPTY_ACCOUNT_TYPE);
  const [branches, setBranches] = useState([]);
  const [permMap, setPermMap] = useState({});

  const [employees, setEmployees] = useState([]);
  const [locations, setLocations] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [userGroups, setUserGroups] = useState([]);
  const [salesDivisions, setSalesDivisions] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [pages, setPages] = useState([]);
  const [permSearch, setPermSearch] = useState('');
  // Default permission matrices per account type, keyed by type name. Applied on demand from
  // the Permissions step rather than the moment an account type is picked -- an admin who has
  // just hand-ticked a dozen boxes shouldn't lose them to a dropdown change.
  const [templates, setTemplates] = useState({});
  const [templateType, setTemplateType] = useState('');
  const [templateNote, setTemplateNote] = useState('');

  useEffect(() => { init(); }, [id]);

  async function init() {
    setLoading(true);
    const [emp, loc, dept, groups, divs, pgs, usrs] = await Promise.all([
      api.get('/employees'),
      api.get('/lookups/locations'),
      api.get('/lookups/departments'),
      api.get('/lookups/user-groups'),
      api.get('/lookups/sales-divisions'),
      api.get('/users/meta/pages'),
      api.get('/users'),
    ]);
    // Non-fatal: if the templates table hasn't been migrated yet the wizard still works,
    // it just has nothing to apply.
    try {
      const tpl = await api.get('/account-type-permissions');
      setTemplates(tpl.data || {});
    } catch { setTemplates({}); }
    setEmployees(emp.data);
    setLocations(loc.data);
    setDepartments(dept.data);
    setUserGroups(groups.data);
    setSalesDivisions(divs.data);
    setPages(pgs.data);
    setAllUsers(usrs.data.filter((u) => !id || u.id !== Number(id)));

    if (id) {
      const { data } = await api.get(`/users/${id}`);
      setUserId(data.id);
      setAccount({
        is_active: !!data.is_active, username: data.username, password: '', email: data.email,
        display_name: data.display_name, employee_id: data.employee_id || '', default_branch_id: data.default_branch_id || '',
        signature_data: data.signature_data || null, signature_set_at: data.signature_set_at || null,
      });
      setAccountType({
        user_group_id: data.user_group_id || '', account_type: data.account_type || '',
        can_approve_sales_estimate: !!data.can_approve_sales_estimate, is_account_officer: !!data.is_account_officer,
        is_supervisor: !!data.is_supervisor, is_sales_manager: !!data.is_sales_manager,
        is_sales_marketing_director: !!data.is_sales_marketing_director, is_sales_business_unit: !!data.is_sales_business_unit,
        is_design_supervisor: !!data.is_design_supervisor, is_purchasing_supervisor: !!data.is_purchasing_supervisor, is_accounts_payable: !!data.is_accounts_payable,
        can_edit_approved_po: !!data.can_edit_approved_po,
        ...Object.fromEntries(PLANNER_FLAGS.map((flag) => [flag, !!data[flag]])),
        is_production_supervisor: !!data.is_production_supervisor,
        approval_code: data.approval_code || '', supervisor_ids: data.supervisor_ids || [],
        sales_division_ids: data.sales_division_ids || [],
        has_fuel_limit: !!data.has_fuel_limit, fuel_limit_liters: data.fuel_limit_liters ?? '', is_fuel_approver: !!data.is_fuel_approver,
      });
      setBranches((data.branches || []).map((b) => ({
        location_id: b.location_id, department_id: b.department_id || '',
        can_override_date: !!b.can_override_date, remarks: b.remarks || '', is_default: !!b.is_default,
      })));
      const map = {};
      for (const p of data.permissions) map[p.page_id] = p;
      setPermMap(map);
      setTemplateType(data.account_type || '');
    }
    setLoading(false);
  }

  function handleEmployeeSelect(emp) {
    setAccount((a) => ({ ...a, employee_id: emp.id, display_name: `${emp.first_name} ${emp.last_name}` }));
  }

  function addBranchRow() {
    setBranches((prev) => [...prev, { ...EMPTY_BRANCH }]);
  }

  function updateBranch(idx, field, value) {
    setBranches((prev) => prev.map((b, i) => {
      if (i !== idx) {
        // Only one branch can be the default login location.
        if (field === 'is_default' && value) return { ...b, is_default: false };
        return b;
      }
      return { ...b, [field]: value };
    }));
  }

  function removeBranch(idx) {
    setBranches((prev) => prev.filter((_, i) => i !== idx));
  }

  function togglePerm(pageId, key) {
    setPermMap((prev) => {
      const current = prev[pageId] || { page_id: pageId, can_view: false, can_add: false, can_edit: false, can_update: false, can_view_all: false, can_delete: false, can_approve: false, can_print: false, can_void: false };
      return { ...prev, [pageId]: { ...current, [key]: !current[key] } };
    });
  }

  // Replaces the whole matrix with the template rather than merging into it: "apply the Sales
  // template" should leave you with exactly Sales access, not Sales plus whatever was ticked
  // before. Anything extra is added back by hand afterwards.
  function applyTemplate() {
    const rows = templates[templateType] || [];
    const map = {};
    rows.forEach((r) => {
      map[r.page_id] = {
        page_id: r.page_id,
        can_view: !!r.can_view,
        can_add: !!r.can_add,
        can_edit: !!r.can_edit,
        can_view_all: !!r.can_view_all,
        can_delete: !!r.can_delete,
        can_update: !!r.can_update,
        can_approve: !!r.can_approve,
        can_print: !!r.can_print,
        can_void: !!r.can_void,
      };
    });
    setPermMap(map);
    const grants = rows.reduce(
      (n, r) => n + PERMISSION_ACTIONS.map((a) => a.key).filter((a) => r[a]).length,
      0
    );
    setTemplateNote(rows.length
      ? `Applied the ${templateType} template -- ${rows.length} page(s), ${grants} permission(s). Adjust below before saving.`
      : `The ${templateType} template is empty, so every box was cleared. Set it up under Users & Permissions > Permission Templates.`);
  }

  async function handleSave() {
    setError('');
    const payload = { ...account, ...accountType, employee_id: account.employee_id || null, default_branch_id: account.default_branch_id || null, user_group_id: accountType.user_group_id || null };
    if (!payload.password) delete payload.password;
    setSaving(true);
    try {
      let uid = userId;
      if (!uid) {
        if (!payload.username || !payload.password || !payload.email || !payload.display_name) {
          setError('Username, Password, Email Address, and Employee Name are required.');
          return false;
        }
        const { data } = await api.post('/users', payload);
        uid = data.id;
        setUserId(uid);
        navigate(`/users/${uid}/edit`, { replace: true });
      } else {
        await api.put(`/users/${uid}`, payload);
      }
      await api.put(`/users/${uid}/branches`, { branches });
      await api.put(`/users/${uid}/permissions`, { permissions: Object.values(permMap) });
      return true;
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function goNext() {
    if (await handleSave()) setStep((s) => Math.min(4, s + 1));
  }

  async function handleSubmit() {
    if (await handleSave()) navigate('/users');
  }

  const employeeLabel = (e) => `${e.first_name} ${e.last_name}`;
  const filteredPages = pages.filter((p) => p.name.toLowerCase().includes(permSearch.toLowerCase()));

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="page-header">
        <h1>Add / Update User</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn" to={'/users'}>Back</Link>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="wizard-steps">
          {STEPS.map((label, i) => (
            <Fragment key={label}>
              <button
                type="button"
                className={`wizard-step ${step === i + 1 ? 'active' : ''}`}
                disabled={i + 1 > 1 && !userId}
                onClick={() => setStep(i + 1)}
              >
                <span className="num">{i + 1}</span> {label}
              </button>
              {i < STEPS.length - 1 && <span className="wizard-step-line" />}
            </Fragment>
          ))}
        </div>

        {step === 1 && (
          <div>
            <h3 className="subsection" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>Enter your User Account Details</h3>
            <div className="field-checkbox">
              <input type="checkbox" id="user-active" checked={account.is_active} onChange={(e) => setAccount({ ...account, is_active: e.target.checked })} />
              <label htmlFor="user-active">Active</label>
            </div>
            <div className="field">
              <label>Username</label>
              <input value={account.username} onChange={(e) => setAccount({ ...account, username: e.target.value })} />
            </div>
            <div className="field">
              <label>Password {userId && <span className="muted">(leave blank to keep unchanged)</span>}</label>
              <input type="password" value={account.password} onChange={(e) => setAccount({ ...account, password: e.target.value })} />
            </div>
            <div className="field">
              <label>Email Address</label>
              <input type="email" value={account.email} onChange={(e) => setAccount({ ...account, email: e.target.value })} />
            </div>
            <div className="field">
              <label>Employee Name</label>
              <EntityPicker
                label="Employee" items={employees} value={account.employee_id} getLabel={employeeLabel}
                columns={[{ key: 'name', label: 'Name', render: employeeLabel }, { key: 'position_title', label: 'Position' }]}
                searchKeys={['first_name', 'last_name']}
                onSelect={handleEmployeeSelect}
              />
            </div>
            <div className="field">
              <label>Signature</label>
              {/* The person's assigned signature, reused wherever they sign off -- the Requested By /
                  Noted By / Approved By lines on printed documents. An admin UPLOADS a picture of it
                  here (asked 2026-10-08) rather than drawing one; nobody sets their own. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ width: 260, height: 100, border: '1px dashed var(--border, #cbd5e1)', borderRadius: 6, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                  {account.signature_data
                    ? <img src={account.signature_data} alt="Signature" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                    : <span className="muted" style={{ fontSize: 12 }}>No signature uploaded</span>}
                </div>
                <label className="btn btn-sm" style={{ cursor: 'pointer', margin: 0 }}>
                  {account.signature_data ? 'Replace picture' : 'Upload picture'}
                  <input type="file" accept="image/png,image/jpeg" style={{ display: 'none' }}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (!file) return;
                      try {
                        const data = await signatureFromFile(file);
                        setAccount((a) => ({ ...a, signature_data: data }));
                      } catch (err) { alert(err.message); }
                    }} />
                </label>
                {account.signature_data && (
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => setAccount((a) => ({ ...a, signature_data: null }))}>Remove</button>
                )}
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>A PNG or JPG of the signature, ideally on a white or transparent background.</div>
              {account.signature_set_at && (
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  On file since {String(account.signature_set_at).slice(0, 10)}.
                </div>
              )}
            </div>
            <div className="wizard-actions">
              <span />
              <button type="button" className="btn btn-primary" disabled={saving} onClick={goNext}>Next Step</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <h3 className="subsection" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>Define User Branches that it can access</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Location</th>
                    <th>Department</th>
                    <th>Can Override Date</th>
                    <th>Remarks</th>
                    <th>Default Login Location</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {branches.map((b, idx) => (
                    <tr key={idx}>
                      <td>
                        <select value={b.location_id} onChange={(e) => updateBranch(idx, 'location_id', e.target.value)}>
                          <option value="">Select...</option>
                          {locations.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
                        </select>
                      </td>
                      <td>
                        <select value={b.department_id} onChange={(e) => updateBranch(idx, 'department_id', e.target.value)}>
                          <option value="">—</option>
                          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </select>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <input type="checkbox" checked={b.can_override_date} onChange={(e) => updateBranch(idx, 'can_override_date', e.target.checked)} />
                      </td>
                      <td>
                        <input value={b.remarks} onChange={(e) => updateBranch(idx, 'remarks', e.target.value)} />
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <input type="checkbox" checked={b.is_default} onChange={(e) => updateBranch(idx, 'is_default', e.target.checked)} />
                      </td>
                      <td><button type="button" className="btn btn-sm btn-danger" onClick={() => removeBranch(idx)}>✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} onClick={addBranchRow}>Add Branch</button>
            <div className="wizard-actions">
              <button type="button" className="btn" onClick={() => setStep(1)}>Previous</button>
              <button type="button" className="btn btn-primary" disabled={saving} onClick={goNext}>Next Step</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <h3 className="subsection" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>Define User Permission and Restrictions</h3>
            <div className="perm-template-bar">
              <label htmlFor="perm-template">Start from an account type</label>
              <select id="perm-template" value={templateType} onChange={(e) => { setTemplateType(e.target.value); setTemplateNote(''); }}>
                <option value="">Select...</option>
                {ACCOUNT_TYPE_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {o}{(templates[o]?.length || 0) === 0 ? ' (empty)' : ''}
                  </option>
                ))}
              </select>
              <button type="button" className="btn btn-primary" disabled={!templateType} onClick={applyTemplate}>
                Apply template
              </button>
              <span className="muted">Fills the boxes below with that role's defaults, replacing what's ticked now.</span>
            </div>
            {templateNote && <div className="perm-template-note">{templateNote}</div>}
            <div className="field" style={{ maxWidth: 320 }}>
              <input placeholder="Search..." value={permSearch} onChange={(e) => setPermSearch(e.target.value)} />
            </div>
            <div className="table-wrap">
              <table className="perm-table">
                <thead>
                  <tr>
                    <th>Page</th>
                    {PERMISSION_ACTIONS.map((a) => <th key={a.key}>{a.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {filteredPages.map((page) => {
                    const perm = permMap[page.id] || {};
                    return (
                      <tr key={page.id}>
                        <td>{page.name}</td>
                        {PERMISSION_ACTIONS.map((a) => (
                          <td key={a.key} style={{ textAlign: 'center' }}>
                            <input type="checkbox" checked={!!perm[a.key]} onChange={() => togglePerm(page.id, a.key)} />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="wizard-actions">
              <button type="button" className="btn" onClick={() => setStep(2)}>Previous</button>
              <button type="button" className="btn btn-primary" disabled={saving} onClick={goNext}>Next Step</button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div>
            <h3 className="subsection" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>Define Account Type</h3>
            <div className="field">
              <label>User Group</label>
              <EntityPicker
                label="User Group" items={userGroups} value={accountType.user_group_id} getLabel={(g) => g.name}
                columns={[{ key: 'name', label: 'Name' }]}
                searchKeys={['name']}
                onSelect={(g) => setAccountType({ ...accountType, user_group_id: g.id })}
              />
            </div>
            <div className="field">
              <label>Account Type</label>
              <select value={accountType.account_type} onChange={(e) => { setAccountType({ ...accountType, account_type: e.target.value }); setTemplateType(e.target.value); }}>
                <option value="">Select...</option>
                {ACCOUNT_TYPE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            {[
              ['can_approve_sales_estimate', 'Can Approve Sales Estimate'],
              ['is_account_officer', 'Account Officer'],
              ['is_supervisor', 'Supervisor'],
              ['is_sales_manager', 'Sales Manager'],
              ['is_sales_marketing_director', 'Sales and Marketing Director'],
              ['is_sales_business_unit', 'Sales Business Unit'],
              ['is_design_supervisor', 'Design Supervisor'],
              ['is_purchasing_supervisor', 'Purchasing Supervisor'],
              ['is_signage_planner', 'Signage Planner'],
              ['is_DPOD_planner', 'DPOD Planner'],
              ['is_CNC_planner', 'CNC Planner'],
              ['is_LFP_planner', 'LFP Planner'],
              ['is_production_supervisor', 'Production Supervisor'],
              ['can_edit_approved_po', 'Can Edit Approved PO'],
              ['is_accounts_payable', 'Accounts Payable (notes liquidations)'],
            ].map(([key, label]) => (
              <div className="field-checkbox" key={key}>
                <input type="checkbox" id={key} checked={accountType[key]} onChange={(e) => setAccountType({ ...accountType, [key]: e.target.checked })} />
                <label htmlFor={key}>{label}</label>
              </div>
            ))}

            {/* A Sales Business Unit owns whole sales divisions -- its commission rolls up
                every sale in the divisions ticked here plus its own. Revealed only when the
                SBU flag is set, the same way the real form surfaces it. */}
            {accountType.is_sales_business_unit && (
              <div className="field" style={{ marginLeft: 24, marginTop: 4 }}>
                <label>Sales Divisions under this SBU</label>
                {salesDivisions.length === 0 && <div className="muted">No sales divisions defined.</div>}
                {salesDivisions.map((d) => {
                  const checked = accountType.sales_division_ids.includes(d.id);
                  return (
                    <div className="field-checkbox" key={d.id}>
                      <input
                        type="checkbox" id={`div-${d.id}`} checked={checked}
                        onChange={(e) => setAccountType((at) => ({
                          ...at,
                          sales_division_ids: e.target.checked
                            ? [...at.sales_division_ids, d.id]
                            : at.sales_division_ids.filter((x) => x !== d.id),
                        }))}
                      />
                      <label htmlFor={`div-${d.id}`}>{d.name}</label>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="field">
              <label>Approval Code</label>
              <input value={accountType.approval_code} onChange={(e) => setAccountType({ ...accountType, approval_code: e.target.value })} />
            </div>
            {/* Fuel limit (2026-10-19): ticked, the user's Fuel Requests may not take a month past
                this many litres -- submitted, noted and approved requests count. */}
            <div className="field">
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={!!accountType.has_fuel_limit}
                  onChange={(e) => setAccountType({ ...accountType, has_fuel_limit: e.target.checked })} />
                Has monthly fuel limit
              </label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
                <input type="checkbox" checked={!!accountType.is_fuel_approver}
                  onChange={(e) => setAccountType({ ...accountType, is_fuel_approver: e.target.checked })} />
                Fuel Approver (approves Fuel Requests)
              </label>
              {accountType.has_fuel_limit && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                  <input type="number" step="0.01" min="0" style={{ maxWidth: 160 }} value={accountType.fuel_limit_liters}
                    onChange={(e) => setAccountType({ ...accountType, fuel_limit_liters: e.target.value })} placeholder="e.g. 60" />
                  <span className="muted">litres per month</span>
                </div>
              )}
            </div>
            {/* A user can report to several supervisors -- the picker adds one at a time and
                each stays listed until removed. Their data rolls up to every supervisor here,
                so all of them see it on their Dashboard and in their commission team total. */}
            <div className="field">
              <label>Supervisors <span className="muted">(who this Account Officer's Dashboard data rolls up to — one or more)</span></label>
              <EntityPicker
                label="Add supervisor" items={allUsers.filter((u) => u.id !== Number(id) && !accountType.supervisor_ids.includes(u.id))}
                value={null} getLabel={(u) => u.display_name}
                columns={[{ key: 'display_name', label: 'Name' }, { key: 'username', label: 'Username' }]}
                searchKeys={['display_name', 'username']}
                onSelect={(u) => setAccountType((at) => (
                  at.supervisor_ids.includes(u.id) ? at : { ...at, supervisor_ids: [...at.supervisor_ids, u.id] }
                ))}
              />
              {accountType.supervisor_ids.length === 0 && <div className="muted">No supervisor assigned.</div>}
              {accountType.supervisor_ids.map((sid) => {
                const su = allUsers.find((u) => u.id === sid);
                return (
                  <div className="field-checkbox" key={sid}>
                    <span>{su ? su.display_name : `User #${sid}`}</span>
                    <button
                      type="button" className="btn btn-link" style={{ marginLeft: 8 }}
                      onClick={() => setAccountType((at) => ({
                        ...at, supervisor_ids: at.supervisor_ids.filter((x) => x !== sid),
                      }))}
                    >Remove</button>
                  </div>
                );
              })}
            </div>
            <div className="wizard-actions">
              <button type="button" className="btn" onClick={() => setStep(3)}>Previous</button>
              <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSubmit}>Submit</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
