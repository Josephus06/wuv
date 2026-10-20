import { useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import { formatDate } from '../utils/payroll';

const ROUTE = '/payroll-holidays';
const EMPTY = { holiday_date: '', name: '', holiday_type: 'regular', company_id: '' };

export default function PayrollHolidays() {
  const { can } = useAuth();
  const [year, setYear] = useState(new Date().getFullYear());
  const [rows, setRows] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');

  async function load(y = year) {
    setLoading(true);
    const { data } = await api.get('/payroll-setup/holidays', { params: { year: y } });
    setRows(data);
    setLoading(false);
  }

  useEffect(() => {
    load();
    api.get('/payroll-setup/companies').then(({ data }) => setCompanies(data)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function open(row) {
    setForm(row ? { holiday_date: row.holiday_date, name: row.name, holiday_type: row.holiday_type, company_id: row.company_id || '' } : { ...EMPTY, holiday_date: `${year}-01-01` });
    setEditing(row ? row.id : 'new');
    setError('');
  }

  async function save(e) {
    e.preventDefault();
    setError('');
    try {
      if (editing === 'new') await api.post('/payroll-setup/holidays', form);
      else await api.put(`/payroll-setup/holidays/${editing}`, form);
      setEditing(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    }
  }

  async function remove(row) {
    if (!confirm(`Delete ${row.name} (${formatDate(row.holiday_date)})?`)) return;
    await api.delete(`/payroll-setup/holidays/${row.id}`);
    load();
  }

  const columns = [
    { key: 'holiday_date', label: 'Date', render: (r) => <>{formatDate(r.holiday_date)}<div className="muted" style={{ fontSize: 11 }}>{new Date(`${r.holiday_date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })}</div></> },
    { key: 'name', label: 'Holiday' },
    { key: 'holiday_type', label: 'Type', render: (r) => (r.holiday_type === 'regular' ? <span className="badge badge-danger">Regular</span> : <span className="badge badge-warning">Special non-working</span>) },
    { key: 'company_name', label: 'Applies to', render: (r) => r.company_name || 'All companies' },
  ];

  return (
    <div>
      <div className="page-header">
        <h1>Holidays</h1>
        {can(ROUTE, 'can_add') && <button className="btn btn-primary" onClick={() => open(null)}>Add Holiday</button>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Year</label>
            <select value={year} onChange={(e) => { setYear(Number(e.target.value)); load(Number(e.target.value)); }}>
              {[year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Regular holidays pay 200% if worked, and daily-paid staff still get a day&apos;s pay if not.
          Special non-working days pay +30% if worked and nothing extra if not. Add each year&apos;s holidays
          from the Presidential proclamation.
        </p>
      </div>

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <DataTable
            columns={columns}
            rows={rows}
            emptyLabel={`No holidays set for ${year}. Payroll treats every day as ordinary until they are added.`}
            actions={(row) => (
              <>
                {can(ROUTE, 'can_edit') && <button className="btn btn-sm" onClick={() => open(row)}>Edit</button>}
                {can(ROUTE, 'can_delete') && <button className="btn btn-sm btn-danger" onClick={() => remove(row)}>Delete</button>}
              </>
            )}
          />
        )}
      </div>

      {editing && (
        <Modal title={editing === 'new' ? 'Add Holiday' : 'Edit Holiday'} onClose={() => setEditing(null)}>
          <form onSubmit={save}>
            {error && <div className="error-banner">{error}</div>}
            <div className="field-row">
              <div className="field">
                <label>Date</label>
                <input type="date" required value={form.holiday_date} onChange={(e) => setForm({ ...form, holiday_date: e.target.value })} />
              </div>
              <div className="field">
                <label>Type</label>
                <select value={form.holiday_type} onChange={(e) => setForm({ ...form, holiday_type: e.target.value })}>
                  <option value="regular">Regular holiday</option>
                  <option value="special">Special non-working day</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label>Name</label>
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Independence Day" />
            </div>
            <div className="field">
              <label>Applies to</label>
              <select value={form.company_id} onChange={(e) => setForm({ ...form, company_id: e.target.value })}>
                <option value="">All companies</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name} only</option>)}
              </select>
            </div>
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
