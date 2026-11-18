import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import DataTable from '../components/DataTable';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

// Mirrors the real GraphicStar "Setup Job" (Add/Update Job) screen (#/jobs). Unit Type/
// Stock Unit/Purchase Unit/Sales Unit/Base Unit are plain text fields there (confirmed
// against the live API -- free text like "Each"/"EACH", not FK unit codes), not pickers.
// Processes and Customers (a per-customer GP Rate override) are only manageable once the
// job has been saved once, matching the real screen's own behavior for a brand-new job.
const JO_TYPES = ['JO', 'Non Standard JO', 'ECommerce'];

const EMPTY = {
  item_code: '', display_name: '', sales_description: '', purchase_description: '',
  jo_type: 'JO', parent_job_type_id: '', department_id: '',
  unit_type: '', stock_unit: '', purchase_unit: '', sales_unit: '', base_unit: '',
  is_area: false, is_piece: false, is_for_sample: false, is_direct_to_prod: false, is_ecommerce: false,
  income_account_id: '', cogs_account_id: '', asset_account_id: '',
  gp_rate_head: 0, gp_rate_branch: 0, is_active: true,
};

function accountLabel(a) { return a ? `${a.account_code} — ${a.account_name}` : ''; }
function jobTypeLabel(j) { return j ? j.display_name : ''; }
function departmentLabel(d) { return d ? d.name : ''; }
function processLabel(p) { return p ? `${p.process_code} — ${p.process_name}` : ''; }
// Trailing zeros off a DECIMAL(10,4) read as false precision on a screen where 0.12 and 1.63
// are typical -- "1.6300 minutes" invites someone to think four places were measured.
function minutes(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? String(Number(n.toFixed(4))) : null;
}
function customerLabel(c) { return c ? `${c.customer_code} — ${c.name}` : ''; }

export default function JobTypeEdit() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();

  const [form, setForm] = useState(EMPTY);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('processes');

  const [departments, setDepartments] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [jobTypes, setJobTypes] = useState([]);
  const [processesList, setProcessesList] = useState([]);
  const [customersList, setCustomersList] = useState([]);
  const [processes, setProcesses] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [newCustomerGpRate, setNewCustomerGpRate] = useState(0);
  const [editingTimeId, setEditingTimeId] = useState(null);
  const [timeDraft, setTimeDraft] = useState('');
  const [timeError, setTimeError] = useState('');
  const [materials, setMaterials] = useState([]);
  const [inventoryItems, setInventoryItems] = useState([]);
  const [materialError, setMaterialError] = useState('');

  function load() {
    return Promise.all([
      api.get('/lookups/departments'),
      api.get('/lookups/chart-of-accounts'),
      api.get('/job-types'),
      api.get('/lookups/processes'),
      api.get('/customers'),
      isNew ? Promise.resolve(null) : api.get(`/job-types/${id}`),
      api.get('/inventory'),
      isNew ? Promise.resolve({ data: [] }) : api.get(`/job-types/${id}/materials`),
    ]).then(([deptRes, acctRes, jtRes, procRes, custRes, detailRes, invRes, matRes]) => {
      setInventoryItems(invRes.data);
      setMaterials(matRes.data);
      setDepartments(deptRes.data);
      setAccounts(acctRes.data);
      setJobTypes(jtRes.data.filter((j) => !id || j.id !== Number(id)));
      setProcessesList(procRes.data);
      setCustomersList(custRes.data);
      if (detailRes) {
        const data = detailRes.data;
        setForm({
          item_code: data.item_code || '', display_name: data.display_name, sales_description: data.sales_description || '',
          purchase_description: data.purchase_description || '', jo_type: data.jo_type || 'JO',
          parent_job_type_id: data.parent_job_type_id || '', department_id: data.department_id || '',
          unit_type: data.unit_type || '', stock_unit: data.stock_unit || '', purchase_unit: data.purchase_unit || '',
          sales_unit: data.sales_unit || '', base_unit: data.base_unit || '',
          is_area: !!data.is_area, is_piece: !!data.is_piece, is_for_sample: !!data.is_for_sample,
          is_direct_to_prod: !!data.is_direct_to_prod, is_ecommerce: !!data.is_ecommerce,
          income_account_id: data.income_account_id || '', cogs_account_id: data.cogs_account_id || '',
          asset_account_id: data.asset_account_id || '', gp_rate_head: data.gp_rate_head ?? 0,
          gp_rate_branch: data.gp_rate_branch ?? 0, is_active: !!data.is_active,
        });
        setProcesses(data.processes || []);
        setCustomers(data.customers || []);
      }
      setLoading(false);
    });
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    setSaving(true);
    setError('');
    const payload = { ...form };
    ['parent_job_type_id', 'department_id', 'income_account_id', 'cogs_account_id', 'asset_account_id']
      .forEach((k) => { payload[k] = payload[k] || null; });
    try {
      if (isNew) {
        const { data } = await api.post('/job-types', payload);
        navigate(`/job-types/${data.id}/edit`);
      } else {
        await api.put(`/job-types/${id}`, payload);
        await load();
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete job type "${form.display_name}"?`)) return;
    try {
      await api.delete(`/job-types/${id}`);
      navigate('/job-types');
    } catch (err) {
      alert(err.response?.data?.error || 'Delete failed');
    }
  }

  async function addProcess(p) {
    if (processes.some((row) => row.process_id === p.id)) return;
    const { data } = await api.post(`/job-types/${id}/processes`, { process_id: p.id });
    setProcesses((prev) => [...prev, data]);
  }

  async function removeProcess(linkId) {
    await api.delete(`/job-types/${id}/processes/${linkId}`);
    setProcesses((prev) => prev.filter((p) => p.id !== linkId));
  }

  async function addMaterial(processLinkId, item) {
    setMaterialError('');
    try {
      const { data } = await api.post(`/job-types/${id}/processes/${processLinkId}/materials`, { inventory_id: item.id });
      setMaterials((prev) => [...prev, data]);
    } catch (err) {
      setMaterialError(err.response?.data?.error || 'Could not add that material.');
    }
  }

  async function removeMaterial(processLinkId, materialId) {
    setMaterialError('');
    try {
      await api.delete(`/job-types/${id}/processes/${processLinkId}/materials/${materialId}`);
      setMaterials((prev) => prev.filter((m) => m.id !== materialId));
    } catch (err) {
      setMaterialError(err.response?.data?.error || 'Could not remove that material.');
    }
  }

  function startEditTime(row) {
    setTimeError('');
    setEditingTimeId(row.id);
    // Seeded with the override only. Showing the inherited value here would silently turn
    // an inherited row into an overridden one the moment someone opened and saved it.
    setTimeDraft(row.minutes_per_unit === null || row.minutes_per_unit === undefined ? '' : String(row.minutes_per_unit));
  }

  async function saveTime(linkId) {
    setTimeError('');
    const raw = timeDraft.trim();
    if (raw !== '' && (!Number.isFinite(Number(raw)) || Number(raw) < 0)) {
      setTimeError('Time study must be a number of minutes, 0 or greater.');
      return;
    }
    try {
      const { data } = await api.patch(`/job-types/${id}/processes/${linkId}`, { minutes_per_unit: raw === '' ? null : Number(raw) });
      setProcesses((prev) => prev.map((p) => (p.id === linkId ? data : p)));
      setEditingTimeId(null);
    } catch (err) {
      setTimeError(err.response?.data?.error || 'Could not save that time study.');
    }
  }

  async function addCustomer(c) {
    if (customers.some((row) => row.customer_id === c.id)) return;
    const { data } = await api.post(`/job-types/${id}/customers`, { customer_id: c.id, gp_rate: newCustomerGpRate || 0 });
    setCustomers((prev) => [...prev, data]);
    setNewCustomerGpRate(0);
  }

  async function removeCustomer(linkId) {
    await api.delete(`/job-types/${id}/customers/${linkId}`);
    setCustomers((prev) => prev.filter((c) => c.id !== linkId));
  }

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="page-header">
        <h1>{isNew ? 'Add / Update Job' : `Job — ${form.display_name}`}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn" to={'/job-types'}>Back</Link>
          {!isNew && <button className="btn btn-danger" onClick={handleDelete}>Delete Job</button>}
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <h3 className="subsection" style={{ marginTop: 0 }}>Setup Job</h3>
        <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="field"><label>Display Name</label><input required value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} /></div>
          <div className="field"><label>Sales Description</label><input value={form.sales_description} onChange={(e) => setForm({ ...form, sales_description: e.target.value })} /></div>
          <div className="field"><label>Purchase Description</label><input value={form.purchase_description} onChange={(e) => setForm({ ...form, purchase_description: e.target.value })} /></div>

          <div className="field">
            <label>JO Type</label>
            <select value={form.jo_type} onChange={(e) => setForm({ ...form, jo_type: e.target.value })}>
              {JO_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Group</label>
            <EntityPicker
              label="Group" items={jobTypes} value={form.parent_job_type_id} getLabel={jobTypeLabel}
              columns={[{ key: 'display_name', label: 'Display Name' }]} searchKeys={['display_name']}
              onSelect={(j) => setForm({ ...form, parent_job_type_id: j.id })}
            />
          </div>
          <div className="field">
            <label>Department</label>
            <EntityPicker
              label="Department" items={departments} value={form.department_id} getLabel={departmentLabel}
              columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']}
              onSelect={(d) => setForm({ ...form, department_id: d.id })}
            />
          </div>

          <div className="field"><label>Unit Type</label><input value={form.unit_type} onChange={(e) => setForm({ ...form, unit_type: e.target.value })} /></div>
          <div className="field"><label>Stock Unit</label><input value={form.stock_unit} onChange={(e) => setForm({ ...form, stock_unit: e.target.value })} /></div>
          <div className="field"><label>Purchase Unit</label><input value={form.purchase_unit} onChange={(e) => setForm({ ...form, purchase_unit: e.target.value })} /></div>
          <div className="field"><label>Sales Unit</label><input value={form.sales_unit} onChange={(e) => setForm({ ...form, sales_unit: e.target.value })} /></div>
          <div className="field"><label>Base Unit</label><input value={form.base_unit} onChange={(e) => setForm({ ...form, base_unit: e.target.value })} /></div>
          <div />

          <div className="field"><label>Head Office (GP Rate)</label><input type="number" step="0.01" value={form.gp_rate_head} onChange={(e) => setForm({ ...form, gp_rate_head: e.target.value })} /></div>
          <div className="field"><label>Branch Office (GP Rate)</label><input type="number" step="0.01" value={form.gp_rate_branch} onChange={(e) => setForm({ ...form, gp_rate_branch: e.target.value })} /></div>
        </div>

        <div className="field-row" style={{ marginTop: 12 }}>
          <div className="field field-checkbox">
            <input type="checkbox" id="is-piece" checked={form.is_piece} onChange={(e) => setForm({ ...form, is_piece: e.target.checked })} />
            <label htmlFor="is-piece">Piece</label>
          </div>
          <div className="field field-checkbox">
            <input type="checkbox" id="is-area" checked={form.is_area} onChange={(e) => setForm({ ...form, is_area: e.target.checked })} />
            <label htmlFor="is-area">Area</label>
          </div>
          <div className="field field-checkbox">
            <input type="checkbox" id="is-sample" checked={form.is_for_sample} onChange={(e) => setForm({ ...form, is_for_sample: e.target.checked })} />
            <label htmlFor="is-sample">Sample</label>
          </div>
          <div className="field field-checkbox">
            <input type="checkbox" id="is-direct-prod" checked={form.is_direct_to_prod} onChange={(e) => setForm({ ...form, is_direct_to_prod: e.target.checked })} />
            <label htmlFor="is-direct-prod">Direct to Production</label>
          </div>
          <div className="field field-checkbox">
            <input type="checkbox" id="is-active" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
            <label htmlFor="is-active">Active</label>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'processes' ? 'active' : ''}`} onClick={() => setTab('processes')}>Processes {processes.length}</button>
        <button className={`status-tab ${tab === 'materials' ? 'active' : ''}`} onClick={() => setTab('materials')}>Materials {materials.length}</button>
        <button className={`status-tab ${tab === 'accounting' ? 'active' : ''}`} onClick={() => setTab('accounting')}>Accounting</button>
        <button className={`status-tab ${tab === 'customers' ? 'active' : ''}`} onClick={() => setTab('customers')}>Customers</button>
      </div>

      {tab === 'processes' && (
        <div className="card">
          {isNew ? <p className="muted" style={{ marginTop: 0 }}>Save this job first to manage its processes.</p> : (
            <>
              {timeError && <div className="error-banner" style={{ marginBottom: 10 }}>{timeError}</div>}
              <DataTable
                columns={[
                  { key: 'process_code', label: 'Process Code' },
                  { key: 'process_name', label: 'Process Name' },
                  {
                    key: 'effective_minutes_per_unit',
                    label: 'Time Study (min)',
                    render: (r) => (editingTimeId === r.id ? (
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input
                          type="number" min="0" step="0.0001" autoFocus
                          style={{ width: 110 }}
                          value={timeDraft}
                          placeholder={minutes(r.process_minutes_per_unit) ?? 'not set'}
                          onChange={(e) => setTimeDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveTime(r.id);
                            if (e.key === 'Escape') setEditingTimeId(null);
                          }}
                        />
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => saveTime(r.id)}>Save</button>
                        <button type="button" className="btn btn-sm" onClick={() => setEditingTimeId(null)}>Cancel</button>
                      </div>
                    ) : (
                      <button type="button" className="link-btn" onClick={() => startEditTime(r)}>
                        {minutes(r.effective_minutes_per_unit) ?? <span className="muted">Set time</span>}
                      </button>
                    )),
                  },
                  {
                    key: 'source',
                    label: 'Source',
                    // Which number is in play matters: an inherited row moves when the process's
                    // own study is re-measured, an overridden one does not.
                    render: (r) => (r.minutes_per_unit === null || r.minutes_per_unit === undefined
                      ? <span className="muted">Process default{minutes(r.process_minutes_per_unit) === null ? ' (none set)' : ''}</span>
                      : 'This job type'),
                  },
                ]}
                rows={processes}
                actions={(r) => <button className="btn btn-sm btn-danger" onClick={() => removeProcess(r.id)}>Remove</button>}
                emptyLabel="No processes assigned yet."
              />
              <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
                Total time study: <strong>{minutes(processes.reduce((sum, r) => sum + Number(r.effective_minutes_per_unit || 0), 0)) ?? '0'}</strong> minutes per unit.
                Clear a value to fall back to the process's own study.
              </p>
              <div className="inline-form" style={{ marginTop: 10 }}>
                <div className="field">
                  <label>Process</label>
                  <EntityPicker
                    label="Process" items={processesList} value="" getLabel={processLabel}
                    isSelectable={(p) => !!p.is_active}
                    columns={[{ key: 'process_code', label: 'Code' }, { key: 'process_name', label: 'Name' }]}
                    searchKeys={['process_code', 'process_name']}
                    onSelect={addProcess}
                    placeholder="Add Process..."
                  />
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'materials' && (
        <div className="card">
          {isNew ? <p className="muted" style={{ marginTop: 0 }}>Save this job first to define its materials.</p> : (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                The stock each process may draw on when this job type is estimated. A process with
                nothing listed is unrestricted -- the estimate offers the full inventory for it.
              </p>
              {materialError && <div className="error-banner" style={{ marginBottom: 10 }}>{materialError}</div>}
              {processes.length === 0 && <div className="empty-state">Assign a process first, on the Processes tab.</div>}
              {processes.map((proc) => {
                const rows = materials.filter((m) => m.job_type_process_id === proc.id);
                return (
                  <div key={proc.id} className="card" style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
                      <strong>{proc.process_name}</strong>
                      <span className="muted">{proc.process_code} &middot; {rows.length ? `${rows.length} material${rows.length === 1 ? '' : 's'}` : 'unrestricted'}</span>
                    </div>
                    <DataTable
                      columns={[
                        { key: 'item_code', label: 'Code' },
                        { key: 'display_name', label: 'Material' },
                      ]}
                      rows={rows}
                      actions={(m) => <button className="btn btn-sm btn-danger" onClick={() => removeMaterial(proc.id, m.id)}>Remove</button>}
                      emptyLabel="No materials defined -- any item may be chosen."
                    />
                    <div className="inline-form" style={{ marginTop: 10 }}>
                      <div className="field">
                        <label>Material</label>
                        <EntityPicker
                          label="Material" items={inventoryItems} value="" getLabel={(i) => i.display_name}
                          columns={[
                            { key: 'item_code', label: 'Code' },
                            { key: 'display_name', label: 'Name' },
                            { key: 'category_name', label: 'Category' },
                          ]}
                          searchKeys={['item_code', 'display_name']}
                          onSelect={(i) => addMaterial(proc.id, i)}
                          placeholder="Add Material..."
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}

      {tab === 'accounting' && (
        <div className="card">
          <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div className="field">
              <label>COGS</label>
              <EntityPicker
                label="COGS Account" items={accounts} value={form.cogs_account_id} getLabel={accountLabel}
                columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }]}
                searchKeys={['account_code', 'account_name']}
                onSelect={(a) => setForm({ ...form, cogs_account_id: a.id })}
              />
            </div>
            <div className="field">
              <label>Asset</label>
              <EntityPicker
                label="Asset Account" items={accounts} value={form.asset_account_id} getLabel={accountLabel}
                columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }]}
                searchKeys={['account_code', 'account_name']}
                onSelect={(a) => setForm({ ...form, asset_account_id: a.id })}
              />
            </div>
            <div className="field">
              <label>Income</label>
              <EntityPicker
                label="Income Account" items={accounts} value={form.income_account_id} getLabel={accountLabel}
                columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }]}
                searchKeys={['account_code', 'account_name']}
                onSelect={(a) => setForm({ ...form, income_account_id: a.id })}
              />
            </div>
          </div>
        </div>
      )}

      {tab === 'customers' && (
        <div className="card">
          {isNew ? <p className="muted" style={{ marginTop: 0 }}>Save this job first to manage customer GP Rate overrides.</p> : (
            <>
              <DataTable
                columns={[
                  { key: 'customer_code', label: 'Customer Code' },
                  { key: 'customer_name', label: 'Customer Name' },
                  { key: 'gp_rate', label: 'GP Rate' },
                ]}
                rows={customers}
                actions={(r) => <button className="btn btn-sm btn-danger" onClick={() => removeCustomer(r.id)}>Remove</button>}
                emptyLabel="No customer GP Rate overrides yet."
              />
              <div className="inline-form" style={{ marginTop: 10 }}>
                <div className="field">
                  <label>GP Rate</label>
                  <input type="number" step="0.01" style={{ width: 100 }} value={newCustomerGpRate} onChange={(e) => setNewCustomerGpRate(e.target.value)} />
                </div>
                <div className="field">
                  <label>Customer</label>
                  <EntityPicker
                    label="Customer" items={customersList} value="" getLabel={customerLabel}
                    columns={[{ key: 'customer_code', label: 'Code' }, { key: 'name', label: 'Name' }]}
                    searchKeys={['customer_code', 'name']}
                    onSelect={addCustomer}
                    placeholder="Add Customer..."
                  />
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
