import { useEffect, useState } from 'react';
import api from '../api/client';
import Modal from './Modal';
import LoadingSpinner from './LoadingSpinner';
import { parseUtc } from '../utils/datetime';

const displayDateTime = (v) => parseUtc(v)?.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) || '';

// The employee profile, after the old payroll system's Employee Form: Personal Info, Employment
// Info and Other Info (ported from the GSUITE_CLONE v1 build). HR's -- the server sends and accepts
// it only for users with Edit on Employees (routes/employees.js); everyone else edits the directory
// fields alone. Shifts and rest days are not on this form: they are dated Shift Assignments.
//
// Pay Rate / Pay Type are not fields on the record: each change is a dated entry (employee_compensation),
// so the rate a past payroll used is never overwritten.
const SELECTS = {
  sex: ['Male', 'Female'],
  civil_status: ['Single', 'Married', 'Widowed', 'Separated', 'Annulled'],
  blood_type: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'],
  tax_status: ['Z', 'S', 'S1', 'S2', 'S3', 'S4', 'ME', 'ME1', 'ME2', 'ME3', 'ME4'],
};
// Suggested values, plus whatever is already in use (GET /employees/meta/profile-options).
const SUGGEST = {
  educational_attainment: ['Elementary', 'High School', 'Senior High School', 'Vocational', 'College Undergraduate', 'College Graduate', 'Post Graduate'],
  employment_status: ['Probationary', 'Regular', 'Contractual', 'Project-Based', 'Casual', 'Resigned', 'Terminated', 'End of Contract'],
  employment_type: ['Company Hired', 'Agency'],
  labor_type: ['Direct', 'Indirect'],
  nationality: ['FILIPINO'],
  religion: ['Roman Catholic', 'Christian', 'Iglesia ni Cristo', 'Islam', 'Seventh-day Adventist', 'Born Again'],
};

const BLANK = {
  employee_code: '', new_employee_no: '', bank_account_no: '', nickname: '', first_name: '', last_name: '', middle_initial: '',
  address: '', phone: '', email: '', birth_date: '', birth_place: '', sex: '', no_lunch_policy: false, nationality: 'FILIPINO',
  religion: '', civil_status: '', height: '', weight: '', blood_type: '', educational_attainment: '', course: '',
  sss_no: '', tin: '', hdmf_no: '', philhealth_no: '', photo_data: '',
  employment_status: '', position_code: '', position_title: '', department_id: '', company_id: '', branch_id: '',
  biometric_user_id: '', months_probation: '', date_probationary: '', months_regular: '', date_regularized: '', date_separated: '',
  prof_license_no: '', license_expiry: '', date_hired: '', supervisor_employee_id: '', labor_type: '', compute_ot_pay: '',
  compute_absences: '', is_confidential: '0', uniform_size: '', shoe_size: '', tax_status: '', employment_type: 'Company Hired',
  doc_ok_probationary: '', doc_ok_regular: '', months_before_eoc: '', eoc_date: '', is_special: false, is_active: true,
  emergency_contact_name: '', emergency_contact_address: '', emergency_contact_phone: '', emergency_contact_relationship: '',
  spouse_name: '', spouse_occupation: '', bank_group: '', compensation_group: '', classification: '', employee_level: '',
  tams_id: '', pay_threshold: '',
};
const DATE_KEYS = ['birth_date', 'date_probationary', 'date_regularized', 'date_separated', 'license_expiry', 'date_hired', 'eoc_date'];
const TRI_KEYS = ['compute_ot_pay', 'compute_absences', 'doc_ok_probationary', 'doc_ok_regular', 'is_confidential'];

function fromRow(r) {
  const f = { ...BLANK };
  for (const k of Object.keys(BLANK)) {
    if (r[k] === undefined || r[k] === null) continue;
    if (DATE_KEYS.includes(k)) f[k] = String(r[k]).slice(0, 10) === '0000-00-00' ? '' : String(r[k]).slice(0, 10);
    else if (TRI_KEYS.includes(k)) f[k] = String(Number(r[k]));
    else if (['no_lunch_policy', 'is_special', 'is_active'].includes(k)) f[k] = !!Number(r[k]);
    else f[k] = r[k];
  }
  return f;
}

function ageOf(birth) {
  if (!birth) return '';
  const b = new Date(`${birth}T00:00:00`);
  const t = new Date();
  let a = t.getFullYear() - b.getFullYear();
  if (t.getMonth() < b.getMonth() || (t.getMonth() === b.getMonth() && t.getDate() < b.getDate())) a -= 1;
  return a >= 0 ? a : '';
}

// A photo, shrunk to 300 px so it rides in the record as a small data URL.
function shrinkPhoto(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const src = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, 300 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(src);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(src); reject(new Error('Not an image')); };
    img.src = src;
  });
}

const TABS = [['personal', 'Personal Info'], ['employment', 'Employment Info'], ['other', 'Other Info']];

export default function EmployeeProfileModal({ employeeId, isHr, departments, companies, locations, employees, onClose, onSaved }) {
  const isNew = !employeeId;
  const [tab, setTab] = useState('personal');
  const [form, setForm] = useState(BLANK);
  const [meta, setMeta] = useState(null); // created / updated / by
  const [pay, setPay] = useState(null);
  const [options, setOptions] = useState({});
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    if (isHr) api.get('/employees/meta/profile-options').then(({ data }) => setOptions(data)).catch(() => {});
    if (isNew) return;
    api.get(`/employees/${employeeId}`).then(({ data }) => {
      setForm(fromRow(data));
      setMeta({ created_at: data.created_at, updated_at: data.updated_at, updated_by: data.updated_by_name });
      setPay(data.pay || null);
      setLoading(false);
    }).catch((e) => { setError(e.response?.data?.error || 'Could not load this employee.'); setLoading(false); });
  }, [employeeId, isNew, isHr]);

  async function save(e) {
    e.preventDefault();
    setSaving(true); setError('');
    const payload = { ...form };
    for (const k of TRI_KEYS) payload[k] = form[k] === '' ? null : Number(form[k]);
    if (!isHr) {
      for (const k of Object.keys(payload)) {
        if (!['employee_code', 'first_name', 'last_name', 'department_id', 'company_id', 'branch_id', 'position_title', 'email', 'phone', 'date_hired', 'is_active'].includes(k)) delete payload[k];
      }
    }
    try {
      if (isNew) await api.post('/employees', payload);
      else await api.put(`/employees/${employeeId}`, payload);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
      setSaving(false);
    }
  }

  // One labelled input, by kind.
  const listId = (k) => `emp-opt-${k}`;
  function F({ k, label, type = 'text', req, width, rows }) {
    let input;
    if (type === 'select') {
      input = (
        <select value={form[k] ?? ''} onChange={(e) => set(k, e.target.value)}>
          <option value="">—</option>
          {SELECTS[k].map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    } else if (type === 'yesno') {
      input = (
        <select value={form[k] ?? ''} onChange={(e) => set(k, e.target.value)}>
          <option value="">—</option><option value="1">Yes</option><option value="0">No</option>
        </select>
      );
    } else if (type === 'check') {
      input = <input type="checkbox" checked={!!form[k]} onChange={(e) => set(k, e.target.checked)} style={{ width: 'auto' }} />;
    } else if (type === 'textarea') {
      input = <textarea rows={rows || 2} value={form[k] ?? ''} onChange={(e) => set(k, e.target.value)} />;
    } else if (type === 'suggest') {
      const list = [...new Set([...(SUGGEST[k] || []), ...(options[k] || [])])];
      input = (
        <>
          <input list={listId(k)} value={form[k] ?? ''} onChange={(e) => set(k, e.target.value)} />
          <datalist id={listId(k)}>{list.map((o) => <option key={o} value={o} />)}</datalist>
        </>
      );
    } else {
      input = (
        <input type={type} required={req} value={form[k] ?? ''} step={type === 'number' ? 'any' : undefined}
          onChange={(e) => set(k, e.target.value)} />
      );
    }
    return (
      <div className="field" style={width ? { maxWidth: width } : undefined}>
        <label>{label}{req ? ' *' : ''}</label>
        {input}
      </div>
    );
  }
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0 16px' };

  // Company, then Branch from that company. A branch no company has been set on yet is offered
  // under every company (so nothing is unpickable before Lookups > Locations is filled in), and
  // the employee's current branch stays listed even if it no longer fits, so editing doesn't
  // silently blank it. The server refuses a branch from a different company either way.
  const branchOptions = locations.filter((l) => (
    !l.company_id || String(l.company_id) === String(form.company_id) || String(l.id) === String(form.branch_id)
  ));
  function setCompany(companyId) {
    const branch = locations.find((l) => String(l.id) === String(form.branch_id));
    const keepBranch = branch && (!branch.company_id || String(branch.company_id) === String(companyId));
    setForm((f) => ({ ...f, company_id: companyId, branch_id: keepBranch ? f.branch_id : '' }));
  }
  const companyBranchFields = (
    <>
      <div className="field"><label>Company</label>
        <select value={form.company_id || ''} onChange={(e) => setCompany(e.target.value)}>
          <option value="">—</option>
          {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div className="field"><label>Branch</label>
        <select value={form.branch_id || ''} onChange={(e) => set('branch_id', e.target.value)} disabled={!form.company_id}>
          <option value="">{form.company_id ? '—' : 'Pick a company first'}</option>
          {branchOptions.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
        </select>
      </div>
    </>
  );

  return (
    <Modal title={isNew ? 'Add Employee' : `Employee — ${form.first_name} ${form.last_name}`} onClose={onClose} xl>
      {loading ? <LoadingSpinner /> : (
        <form onSubmit={save}>
          {error && <div className="error-banner">{error}</div>}
          {!isHr ? (
            // Without Edit on Employees: the directory fields only.
            <div style={grid}>
              {F({ k: 'employee_code', label: 'Employee Number' })}
              {F({ k: 'first_name', label: 'First Name', req: true })}
              {F({ k: 'last_name', label: 'Last Name', req: true })}
              {companyBranchFields}
              <div className="field"><label>Department</label>
                <select value={form.department_id} onChange={(e) => set('department_id', e.target.value)}>
                  <option value="">—</option>
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
              {F({ k: 'position_title', label: 'Position' })}
              {F({ k: 'email', label: 'Email', type: 'email' })}
              {F({ k: 'phone', label: 'Telephone No.' })}
              {F({ k: 'date_hired', label: 'Date Hired', type: 'date' })}
            </div>
          ) : (
            <>
              <div className="status-tabs" style={{ marginBottom: 12 }}>
                {TABS.map(([k, label]) => (
                  <button type="button" key={k} className={`status-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{label}</button>
                ))}
              </div>

              {tab === 'personal' && (
                <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 280 }}>
                    <div style={grid}>
                      {F({ k: 'employee_code', label: 'Employee Number' })}
                      {F({ k: 'new_employee_no', label: 'New #' })}
                      {F({ k: 'bank_account_no', label: 'Bank Acct. Number' })}
                      {F({ k: 'nickname', label: 'Nick Name' })}
                      {F({ k: 'first_name', label: 'First Name', req: true })}
                      {F({ k: 'last_name', label: 'Last Name', req: true })}
                      {F({ k: 'middle_initial', label: 'Middle Initial' })}
                      {F({ k: 'phone', label: 'Telephone No.' })}
                      {F({ k: 'email', label: 'Email', type: 'email' })}
                      {F({ k: 'birth_date', label: 'Birth Date', type: 'date' })}
                      <div className="field"><label>Age</label><input value={ageOf(form.birth_date)} readOnly /></div>
                      {F({ k: 'birth_place', label: 'Birth Place' })}
                      {F({ k: 'sex', label: 'Sex', type: 'select' })}
                      {F({ k: 'nationality', label: 'Nationality', type: 'suggest' })}
                      {F({ k: 'religion', label: 'Religion', type: 'suggest' })}
                      {F({ k: 'civil_status', label: 'Civil Status', type: 'select' })}
                      {F({ k: 'height', label: 'Height' })}
                      {F({ k: 'weight', label: 'Weight' })}
                      {F({ k: 'blood_type', label: 'Blood Type', type: 'select' })}
                      {F({ k: 'educational_attainment', label: 'Educational Attainment', type: 'suggest' })}
                      {F({ k: 'sss_no', label: 'SSS Number' })}
                      {F({ k: 'tin', label: 'TIN Number' })}
                      {F({ k: 'hdmf_no', label: 'Pag-IBIG Number' })}
                      {F({ k: 'philhealth_no', label: 'PhilHealth Number' })}
                    </div>
                    {F({ k: 'address', label: 'Address', type: 'textarea' })}
                    {F({ k: 'course', label: 'Course', type: 'textarea' })}
                    <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontWeight: 400 }}>
                      <input type="checkbox" checked={!!form.no_lunch_policy} onChange={(e) => set('no_lunch_policy', e.target.checked)} />
                      No Lunch Out and In Policy
                    </label>
                  </div>
                  <div style={{ width: 180, textAlign: 'center' }}>
                    <div style={{ width: 180, height: 200, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--panel-2, #f6f6f6)' }}>
                      {form.photo_data ? <img src={form.photo_data} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        : <span className="muted" style={{ fontSize: 12 }}>No photo</span>}
                    </div>
                    <label className="btn btn-sm" style={{ marginTop: 8, cursor: 'pointer' }}>
                      {form.photo_data ? 'Change photo' : 'Add photo'}
                      <input type="file" accept="image/*" hidden onChange={async (e) => {
                        const file = e.target.files?.[0]; e.target.value = '';
                        if (file) { try { set('photo_data', await shrinkPhoto(file)); } catch { setError('That file is not an image.'); } }
                      }} />
                    </label>
                    {form.photo_data && <button type="button" className="btn btn-sm" style={{ marginTop: 8, marginLeft: 4 }} onClick={() => set('photo_data', '')}>Remove</button>}
                  </div>
                </div>
              )}

              {tab === 'employment' && (
                <>
                  <div style={grid}>
                    {F({ k: 'employment_status', label: 'Status', type: 'suggest' })}
                    {F({ k: 'position_code', label: 'Position Code', type: 'suggest' })}
                    {F({ k: 'position_title', label: 'Position Description' })}
                    {companyBranchFields}
                    <div className="field"><label>Division / Department</label>
                      <select value={form.department_id} onChange={(e) => set('department_id', e.target.value)}>
                        <option value="">—</option>
                        {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                    </div>
                    {F({ k: 'biometric_user_id', label: 'Machine No.' })}
                    {F({ k: 'date_hired', label: 'Date Hired', type: 'date' })}
                    {F({ k: 'months_probation', label: 'Mnths. Probation', type: 'number' })}
                    {F({ k: 'date_probationary', label: 'Date Probationary', type: 'date' })}
                    {F({ k: 'months_regular', label: 'Mnths. Regular', type: 'number' })}
                    {F({ k: 'date_regularized', label: 'Date Regularized', type: 'date' })}
                    {F({ k: 'date_separated', label: 'Date Separated', type: 'date' })}
                    {F({ k: 'prof_license_no', label: 'Prof. License #' })}
                    {F({ k: 'license_expiry', label: 'License Expiry Date', type: 'date' })}
                    <div className="field"><label>Supervisor</label>
                      <select value={form.supervisor_employee_id || ''} onChange={(e) => set('supervisor_employee_id', e.target.value)}>
                        <option value="">—</option>
                        {employees.filter((x) => x.id !== employeeId && (x.is_active || x.id === Number(form.supervisor_employee_id)))
                          .sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`))
                          .map((x) => <option key={x.id} value={x.id}>{x.first_name} {x.last_name}</option>)}
                      </select>
                    </div>
                    {F({ k: 'labor_type', label: 'Labor Type', type: 'suggest' })}
                    {F({ k: 'compute_ot_pay', label: 'Compute Overtime Pay', type: 'yesno' })}
                    {F({ k: 'compute_absences', label: 'Compute Absences', type: 'yesno' })}
                    <div className="field"><label>Confidential</label>
                      <select value={form.is_confidential ?? ''} onChange={(e) => set('is_confidential', e.target.value)}>
                        <option value="0">Non-Confidential</option><option value="1">Confidential</option>
                      </select>
                    </div>
                    {F({ k: 'uniform_size', label: 'Uniform Size', type: 'suggest' })}
                    {F({ k: 'shoe_size', label: 'Shoe Size', type: 'suggest' })}
                    {F({ k: 'tax_status', label: 'Tax Employee Status', type: 'select' })}
                    {F({ k: 'employment_type', label: 'Employee Type', type: 'suggest' })}
                    {F({ k: 'doc_ok_probationary', label: 'Document OK (Prob.)', type: 'yesno' })}
                    {F({ k: 'doc_ok_regular', label: 'Document OK (Reg.)', type: 'yesno' })}
                    {F({ k: 'months_before_eoc', label: 'Months Before EOC', type: 'number' })}
                    {F({ k: 'eoc_date', label: 'Actual Date for EOC', type: 'date' })}
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Shift and rest days are set under HR → Shift Assignments.</div>
                  <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 4 }}>
                    <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontWeight: 400 }}>
                      <input type="checkbox" checked={!!form.is_special} onChange={(e) => set('is_special', e.target.checked)} /> Special
                    </label>
                    <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontWeight: 400 }}>
                      <input type="checkbox" checked={!!form.is_active} onChange={(e) => set('is_active', e.target.checked)} /> Active
                    </label>
                  </div>
                  <PayRate employeeId={employeeId} pay={pay} onChange={setPay} />
                </>
              )}

              {tab === 'other' && (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '0 24px' }}>
                    <div>
                      <h4 style={{ margin: '0 0 8px' }}>In Case of Emergency</h4>
                      {F({ k: 'emergency_contact_name', label: 'Name' })}
                      {F({ k: 'emergency_contact_address', label: 'Address', type: 'textarea' })}
                      {F({ k: 'emergency_contact_phone', label: 'Telephone No.' })}
                      {F({ k: 'emergency_contact_relationship', label: 'Relationship' })}
                    </div>
                    <div>
                      <h4 style={{ margin: '0 0 8px' }}>Spouse Information (if any)</h4>
                      {F({ k: 'spouse_name', label: 'Spouse Name' })}
                      {F({ k: 'spouse_occupation', label: 'Spouse Occupation' })}
                    </div>
                  </div>
                  <div style={{ ...grid, marginTop: 8 }}>
                    {F({ k: 'bank_group', label: 'Bank Group', type: 'suggest' })}
                    {F({ k: 'compensation_group', label: 'Compensation', type: 'suggest' })}
                    {F({ k: 'classification', label: 'Classification', type: 'suggest' })}
                    {F({ k: 'employee_level', label: 'Level', type: 'suggest' })}
                    {F({ k: 'tams_id', label: 'TAMS I.D.' })}
                    {F({ k: 'pay_threshold', label: 'Pay Threshold', type: 'number' })}
                  </div>
                  {meta && (
                    <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                      Date created: {meta.created_at ? displayDateTime(meta.created_at) : '—'} · Last update: {meta.updated_at ? displayDateTime(meta.updated_at) : '—'}
                      {meta.updated_by ? ` · Last user: ${meta.updated_by}` : ''}
                    </div>
                  )}
                </>
              )}
            </>
          )}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// Pay Rate and Pay Type, as dated entries. Saved on its own (not with the form's Save).
function PayRate({ employeeId, pay, onChange }) {
  const [entry, setEntry] = useState({ effective_date: new Date().toISOString().slice(0, 10), pay_type: '', base_rate: '', remarks: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const cur = pay?.current;
  const money = (v) => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  async function add() {
    setBusy(true); setErr('');
    try {
      const { data } = await api.post(`/employees/${employeeId}/pay-rate`, entry);
      onChange(data);
      setEntry((e) => ({ ...e, base_rate: '', remarks: '' }));
    } catch (e) { setErr(e.response?.data?.error || 'Could not save the pay rate.'); }
    setBusy(false);
  }

  return (
    <div className="card" style={{ marginTop: 14, background: 'var(--panel-2, transparent)' }}>
      <h4 style={{ margin: '0 0 6px' }}>Pay Rate</h4>
      {!employeeId ? (
        <div className="muted" style={{ fontSize: 13 }}>Save the employee first, then add their pay rate here.</div>
      ) : (
        <>
          <div style={{ marginBottom: 8 }}>
            Current: {cur ? <strong>{money(cur.base_rate)} {cur.pay_type === 'daily' ? 'a day' : 'a month'}</strong> : <span className="muted">none set</span>}
            {cur && <span className="muted"> — since {String(cur.effective_date).slice(0, 10)}</span>}
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="field" style={{ maxWidth: 170 }}><label>Effective Date</label>
              <input type="date" value={entry.effective_date} onChange={(e) => setEntry({ ...entry, effective_date: e.target.value })} /></div>
            <div className="field" style={{ maxWidth: 140 }}><label>Pay Type</label>
              <select value={entry.pay_type} onChange={(e) => setEntry({ ...entry, pay_type: e.target.value })}>
                <option value="">—</option><option value="monthly">Monthly</option><option value="daily">Daily</option>
              </select></div>
            <div className="field" style={{ maxWidth: 150 }}><label>Pay Rate</label>
              <input type="number" step="0.01" value={entry.base_rate} onChange={(e) => setEntry({ ...entry, base_rate: e.target.value })} /></div>
            <div className="field" style={{ flex: 1, minWidth: 160 }}><label>Remarks</label>
              <input value={entry.remarks} placeholder="e.g. Regularization increase" onChange={(e) => setEntry({ ...entry, remarks: e.target.value })} /></div>
            <button type="button" className="btn btn-primary" style={{ marginBottom: 12 }} disabled={busy} onClick={add}>Add Rate</button>
          </div>
          {err && <div className="error-banner">{err}</div>}
          <div className="muted" style={{ fontSize: 12 }}>A new rate is added from its date; earlier rates stay as they were, so past payroll keeps the rate it used.</div>
          {(pay?.history || []).length > 0 && (
            <table style={{ marginTop: 8 }}>
              <thead><tr><th>Effective</th><th>Pay Type</th><th style={{ textAlign: 'right' }}>Rate</th><th>Remarks</th><th>Entered By</th></tr></thead>
              <tbody>
                {pay.history.map((h) => (
                  <tr key={h.id}>
                    <td>{String(h.effective_date).slice(0, 10)}</td>
                    <td>{h.pay_type === 'daily' ? 'Daily' : 'Monthly'}</td>
                    <td style={{ textAlign: 'right' }}>{money(h.base_rate)}</td>
                    <td>{h.remarks || ''}</td>
                    <td>{h.created_by || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
