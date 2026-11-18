import { useCallback, useEffect, useState } from 'react';
import api from '../../api/client';
import { CustomerLink } from '../../components/PartyLink';
import CollectionForecastCalendar from '../../components/CollectionForecastCalendar';
import Pagination from '../../components/Pagination';
import LoadingSpinner from '../../components/LoadingSpinner';
import EntityPicker from '../../components/EntityPicker';
import { useAuth } from '../../context/useAuth';

const PAGE_SIZE = 25;
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
// DATE columns carry no time -- slice rather than parsing, which would slide the day a timezone.
const day = (v) => (v ? String(v).slice(0, 10) : '');
// Treasury > Collection Forecast.
//
// Two views of one job. The Worklist is where a forecast date gets set -- filter to a customer,
// tick their open invoices, set one date for the lot, because that is what one phone call
// produces. The Calendar is the same data read back: who is expected to pay on which day.
export default function CollectionForecast() {
  const { can } = useAuth();
  const canEdit = can('/treasury/collection-forecast', 'can_edit');
  const [tab, setTab] = useState('worklist');

  return (
    <div>
      <div className="page-header">
        <h1>Collection Forecast</h1>
      </div>
      <div className="tabs">
        <button className={tab === 'worklist' ? 'active' : ''} onClick={() => setTab('worklist')}>Worklist</button>
        <button className={tab === 'calendar' ? 'active' : ''} onClick={() => setTab('calendar')}>Calendar</button>
      </div>
      {tab === 'worklist' ? <Worklist canEdit={canEdit} /> : <div className="card"><CollectionForecastCalendar /></div>}
    </div>
  );
}

// ---------------------------------------------------------------- worklist

function Worklist({ canEdit }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [outstanding, setOutstanding] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [customers, setCustomers] = useState([]);
  const [page, setPage] = useState(1);
  const [refreshKey, setRefreshKey] = useState(0);
  // `form` is what the controls show, `applied` is what the last fetch used -- without the
  // split every keystroke in the search box queries the whole invoice table.
  const [form, setForm] = useState({ search: '', customerId: '', forecast: '' });
  const [applied, setApplied] = useState({ search: '', customerId: '', forecast: '' });
  // Ids only, so a row scrolling out of the page does not lose its tick.
  const [selected, setSelected] = useState(() => new Set());
  const [forecastDate, setForecastDate] = useState('');
  const [saving, setSaving] = useState(false);

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    api.get('/collection-forecast/customers')
      .then(({ data }) => setCustomers(data || []))
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/collection-forecast/open', {
        params: {
          search: applied.search || undefined,
          customer_id: applied.customerId || undefined,
          forecast: applied.forecast || undefined,
          page,
          limit: PAGE_SIZE,
        },
      });
      setRows(data.rows || []);
      setTotal(data.total || 0);
      setOutstanding(data.outstanding || 0);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not load open invoices.');
    }
    setLoading(false);
  }, [applied, page, refreshKey]);

  useEffect(() => { load(); }, [load]);

  function search() {
    setApplied({ ...form });
    setPage(1);
    setSelected(new Set());
  }

  function toggle(id) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  // Ticks only what is on screen, and unticks only what is on screen -- the header box cannot
  // silently reach across pages the user has not seen.
  const pageIds = rows.map((r) => r.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  function toggleAll() {
    setSelected((s) => {
      const next = new Set(s);
      if (allOnPage) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
  }

  async function apply(clear = false) {
    if (!selected.size) return;
    if (!clear && !forecastDate) { setError('Pick a forecast date first.'); return; }
    setSaving(true); setError(''); setNotice('');
    try {
      const { data } = await api.put('/collection-forecast', {
        invoice_ids: [...selected],
        forecast_date: clear ? null : forecastDate,
      });
      // An invoice can stop being open while the list sits on screen -- somebody else collects
      // it. Say so rather than reporting a clean success for work that did not happen.
      setNotice(
        `${data.updated} invoice${data.updated === 1 ? '' : 's'} ${clear ? 'cleared' : `set to ${data.forecast_date}`}.`
        + (data.skipped ? ` ${data.skipped} skipped -- no longer open.` : ''),
      );
      setSelected(new Set());
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not save the forecast.');
    }
    setSaving(false);
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="warning-banner" style={{ marginBottom: 8 }}>{notice}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Search</label>
            <input
              placeholder="Invoice no, BS/SI #, customer, PO" value={form.search}
              onChange={(e) => setField('search', e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
            />
          </div>
          <div className="field">
            <EntityPicker
              label="Customer" items={customers} value={form.customerId}
              getLabel={(c) => c.name}
              columns={[
                { key: 'name', label: 'Customer' },
                { key: 'open_invoices', label: 'Open' },
                { key: 'outstanding', label: 'Outstanding', render: (c) => money(c.outstanding) },
              ]}
              searchKeys={['name']}
              placeholder="All customers"
              onSelect={(c) => setField('customerId', c ? c.id : '')}
              onClear={() => setField('customerId', '')}
            />
          </div>
          <div className="field">
            <label>Forecast</label>
            <select value={form.forecast} onChange={(e) => setField('forecast', e.target.value)}>
              <option value="">All open</option>
              <option value="unset">Not yet forecast</option>
              <option value="set">Already forecast</option>
            </select>
          </div>
          <div className="field" style={{ alignSelf: 'end' }}>
            <button className="btn btn-primary" onClick={search}>Search</button>
          </div>
        </div>
      </div>

      {/* The bulk bar only exists while something is ticked -- an empty date box above an
          untouched list invites setting a date on nothing. */}
      {canEdit && selected.size > 0 && (
        <div className="card" style={{ marginBottom: 16, display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Forecast collection date</label>
            <input type="date" value={forecastDate} onChange={(e) => setForecastDate(e.target.value)} />
          </div>
          <button className="btn btn-primary" disabled={saving} onClick={() => apply(false)}>
            {saving ? 'Saving…' : `Set for ${selected.size} invoice${selected.size === 1 ? '' : 's'}`}
          </button>
          <button className="btn" disabled={saving} onClick={() => apply(true)}>Clear forecast</button>
          <button className="btn" disabled={saving} onClick={() => setSelected(new Set())}>Deselect</button>
        </div>
      )}

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {canEdit && (
                      <th style={{ width: 32 }}>
                        <input type="checkbox" checked={allOnPage} onChange={toggleAll} aria-label="Select all on this page" />
                      </th>
                    )}
                    <th>Invoice No</th>
                    <th>BS/SI #</th>
                    <th>Customer</th>
                    <th>Date Created</th>
                    <th>Due Date</th>
                    <th className="text-right">Amount Due</th>
                    <th>Forecast Collection</th>
                    <th>Set By</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={canEdit ? 9 : 8} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                        No open invoices match this filter.
                      </td>
                    </tr>
                  )}
                  {rows.map((r) => (
                    <tr key={r.id}>
                      {canEdit && (
                        <td>
                          <input
                            type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)}
                            aria-label={`Select ${r.invoice_no}`}
                          />
                        </td>
                      )}
                      <td>{r.invoice_no}</td>
                      <td>{r.bs_si_no || <span className="muted">—</span>}</td>
                      <td><CustomerLink id={r.customer_id} name={r.customer_name} /></td>
                      <td>{day(r.date_created)}</td>
                      <td>{day(r.date_due)}</td>
                      <td className="text-right">{money(r.amount_due)}</td>
                      <td>
                        {r.collection_forecast_date
                          ? <span className="badge badge-success">{day(r.collection_forecast_date)}</span>
                          : <span className="muted">—</span>}
                      </td>
                      <td className="muted">{r.collection_forecast_set_by || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
              <span className="muted">
                {total.toLocaleString()} open invoice{total === 1 ? '' : 's'} · {money(outstanding)} outstanding
                {selected.size > 0 && ` · ${selected.size} selected`}
              </span>
              <Pagination page={page} totalPages={totalPages} onChange={setPage} />
            </div>
          </>
        )}
      </div>
    </>
  );
}

// The calendar itself lives in components/CollectionForecastCalendar.jsx because the dashboard
// shows it too. Two copies would eventually disagree about a day's total, and the whole point
// of the calendar is that the cell and its popup quote the same number.
