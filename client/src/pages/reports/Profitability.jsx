import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import { CustomerLink } from '../../components/PartyLink';
import EntityPicker from '../../components/EntityPicker';
import LoadingSpinner from '../../components/LoadingSpinner';
import Modal from '../../components/Modal';
import SearchInput from '../../components/SearchInput';

// Accounting > Reports > Profitability Report -- the real system's report, column for column: one group per
// Sales Order with its lines underneath, estimated against actual on both sides of the margin.
//
// Zeros are PRINTED here (0.00), not blanked the way the accounting reports blank them. On a
// financial statement an empty cell means "nothing posted to this account"; on this report a
// blank in Actual Revenue would read as missing data, when what it means is that the job has not
// been invoiced yet -- which is the single most important thing the row has to say. Margin % is
// the one exception: with no actual revenue there is nothing to take a percentage OF, so it
// stays empty rather than claiming 0%.
function money(v) {
  const n = Number(v);
  return Number.isFinite(n)
    ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '0.00';
}
function qty(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}
function dmy(v) {
  if (!v) return '';
  const [y, m, d] = String(v).slice(0, 10).split('-');
  return y && m && d ? `${m}/${d}/${y}` : String(v).slice(0, 10);
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Negative money reads as red, and only negative money: a report whose whole point is the
// margin should not make the reader subtract in their head to find the losses.
function signColor(v) {
  return Number(v) < 0 ? { color: '#b91c1c' } : undefined;
}

const DATE_MODES = [
  { value: 'as_of', label: 'As of' },
  { value: 'on', label: 'On' },
  { value: 'between', label: 'Between' },
  { value: 'all', label: 'All dates' },
];

const EMPTY_FILTERS = {
  search: '', dateMode: 'as_of', dateFrom: today(), dateTo: today(),
  salesRep: null, customer: null, officeLocation: null, salesDivision: null,
  includeCancelled: false,
};

// One filter field: the app's standard picker plus a one-click clear, which is how the real
// report's filter bar behaves -- every one of its fields carries an x. EntityPicker's own
// "Clear selection" lives inside the modal, which is two clicks and a modal too many for
// undoing a filter.
function PickerFilter({ label, items, value, getLabel, columns, searchKeys, onSelect, onClear }) {
  return (
    <div className="field">
      <label>{label}</label>
      <div style={{ display: 'flex', gap: 4, alignItems: 'stretch' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <EntityPicker
            label={label}
            items={items}
            value={value?.id || ''}
            getLabel={getLabel}
            columns={columns}
            searchKeys={searchKeys}
            onSelect={onSelect}
            onClear={onClear}
            placeholder={label}
          />
        </div>
        <button
          type="button"
          className="btn"
          title={`Clear ${label}`}
          aria-label={`Clear ${label}`}
          disabled={!value}
          onClick={onClear}
          style={{ padding: '7px 10px' }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

export default function Profitability() {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  // What the table currently shows, as opposed to what the filter bar is set to. Generate is
  // what moves one to the other: over 69,761 sales orders, re-running on every keystroke of
  // General Searching would fire a full scan per letter.
  const [applied, setApplied] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [scope, setScope] = useState({ reps: [], locations: [], divisions: [], default_location: null });
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [collapsed, setCollapsed] = useState({});
  const [detail, setDetail] = useState(null); // { line, data } | { line, error }
  const [detailLoading, setDetailLoading] = useState(false);
  const [customerOptions, setCustomerOptions] = useState([]);
  const [customerText, setCustomerText] = useState('');
  const customerTimer = useRef(null);

  const params = useCallback((f, extra = {}) => {
    const p = { page: extra.page ?? page, limit: 10, ...extra };
    if (f.search) p.search = f.search;
    p.date_mode = f.dateMode;
    if (f.dateMode !== 'all') {
      p.date_from = f.dateFrom;
      if (f.dateMode === 'between') p.date_to = f.dateTo;
    }
    if (f.salesRep) p.sales_rep_id = f.salesRep.id;
    if (f.customer) p.customer_id = f.customer.id;
    if (f.officeLocation) p.office_location_id = f.officeLocation.id;
    if (f.salesDivision) p.sales_division_id = f.salesDivision.id;
    if (f.includeCancelled) p.include_cancelled = 'true';
    return p;
  }, [page]);

  // The pickers, plus the user's own office -- which opens in the Office Location filter and
  // names the chip in the header, the way the real report opens on where you work.
  useEffect(() => {
    api.get('/reports/profitability/scope').then(({ data }) => {
      setScope(data);
      if (data.default_location) {
        const loc = { id: data.default_location.id, location_name: data.default_location.location_name };
        setFilters((f) => ({ ...f, officeLocation: loc }));
        setApplied((f) => ({ ...f, officeLocation: loc }));
      }
    }).catch(() => {});
  }, []);

  const load = useCallback(async (f, pageNum) => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/reports/profitability', { params: params(f, { page: pageNum }) });
      setReport(data);
      setCollapsed({});
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to generate the report.');
      setReport(null);
    } finally {
      setLoading(false);
    }
    // params is rebuilt per render; the page number is passed in explicitly instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(applied, page); }, [load, applied, page]);

  function generate() {
    setPage(1);
    setApplied({ ...filters });
  }

  function reset() {
    const fresh = { ...EMPTY_FILTERS, officeLocation: filters.officeLocation };
    setFilters(fresh);
    setCustomerText('');
    setPage(1);
    setApplied(fresh);
  }

  // Debounced, because the customer table is 21,562 rows and the filter is a free-text field --
  // the endpoint searches server-side and returns at most 25, so nothing here loads the list.
  function onCustomerType(text) {
    setCustomerText(text);
    const exact = customerOptions.find((c) => c.name.toLowerCase() === text.trim().toLowerCase());
    setFilters((f) => ({ ...f, customer: exact || null }));
    if (customerTimer.current) clearTimeout(customerTimer.current);
    if (text.trim().length < 2) { setCustomerOptions([]); return; }
    customerTimer.current = setTimeout(() => {
      api.get('/reports/profitability/customers', { params: { q: text.trim() } })
        .then(({ data }) => setCustomerOptions(data))
        .catch(() => setCustomerOptions([]));
    }, 300);
  }

  async function download() {
    setNotice('');
    try {
      const res = await api.get('/reports/profitability', {
        params: params(applied, { format: 'csv', page: 1 }),
        responseType: 'blob',
      });
      const truncated = res.headers['x-report-truncated'];
      if (truncated) {
        setNotice(`The file holds the first ${truncated} sales orders in this filter. Narrow the dates to export the rest.`);
      }
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `profitability-report-${today()}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError('Could not download the report.');
    }
  }

  async function openDetail(order, line) {
    setDetail({ order, line, data: null });
    setDetailLoading(true);
    try {
      const { data } = await api.get(`/reports/profitability/line/${line.line_id}`);
      setDetail({ order, line, data });
    } catch (err) {
      setDetail({ order, line, error: err.response?.data?.error || 'Could not load the detail.' });
    } finally {
      setDetailLoading(false);
    }
  }

  const rows = report?.rows || [];
  const totals = report?.page_totals;
  const COLS = 19;

  return (
    <div>
      {/* The real report's header: which office you are looking at, the report's name, and
          Download. The location is the filter's own value rather than a fixed label -- it is a
          filter, and a chip that kept saying "Head Office" while the table showed a branch
          would be the one piece of chrome on the page that lies. */}
      <div className="page-header">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span className="badge badge-muted" style={{ fontSize: 13 }}>
            {applied.officeLocation?.location_name || 'All locations'}
          </span>
          <span>Profitability Report</span>
        </h1>
        <button className="btn btn-sm" disabled={!report || loading} onClick={download}>Download CSV</button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>General Searching</label>
            <SearchInput
              value={filters.search}
              placeholder="SO #, Est #, JO #, customer, contract"
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') generate(); }}
            />
          </div>
          <div className="field">
            <label>SO Date</label>
            <select value={filters.dateMode} onChange={(e) => setFilters({ ...filters, dateMode: e.target.value })}>
              {DATE_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
          {filters.dateMode !== 'all' && (
            <div className="field">
              <label>{filters.dateMode === 'between' ? 'From' : 'Date'}</label>
              <input type="date" value={filters.dateFrom} onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })} />
            </div>
          )}
          {filters.dateMode === 'between' && (
            <div className="field">
              <label>To</label>
              <input type="date" value={filters.dateTo} onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })} />
            </div>
          )}
          <PickerFilter
            label="Sales Rep"
            items={scope.reps}
            value={filters.salesRep}
            getLabel={(r) => r.name}
            columns={[{ key: 'name', label: 'Name' }]}
            searchKeys={['name']}
            onSelect={(r) => setFilters({ ...filters, salesRep: r })}
            onClear={() => setFilters({ ...filters, salesRep: null })}
          />
          {/* Customer is typed, not picked: 21,562 of them is a picker nobody can page through,
              and the endpoint behind this returns at most 25 matches. */}
          <div className="field">
            <label>Customer</label>
            <div style={{ display: 'flex', gap: 4, alignItems: 'stretch' }}>
              <input
                list="profitability-customers"
                value={customerText}
                placeholder="Customer"
                onChange={(e) => onCustomerType(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') generate(); }}
                style={{ flex: 1, minWidth: 0 }}
              />
              <datalist id="profitability-customers">
                {customerOptions.map((c) => <option key={c.id} value={c.name} />)}
              </datalist>
              <button
                type="button"
                className="btn"
                title="Clear Customer"
                aria-label="Clear Customer"
                disabled={!customerText}
                onClick={() => { setCustomerText(''); setCustomerOptions([]); setFilters({ ...filters, customer: null }); }}
                style={{ padding: '7px 10px' }}
              >
                ✕
              </button>
            </div>
            {/* Typed text that matches no customer would otherwise filter nothing and look as
                though it had -- the difference between "all customers" and "this one". */}
            {customerText.trim() && !filters.customer && (
              <span className="muted" style={{ fontSize: 12 }}>Pick a name from the list to filter by it.</span>
            )}
          </div>
          <PickerFilter
            label="Office Location"
            items={scope.locations}
            value={filters.officeLocation}
            getLabel={(l) => l.location_name}
            columns={[{ key: 'location_name', label: 'Location' }]}
            searchKeys={['location_name']}
            onSelect={(l) => setFilters({ ...filters, officeLocation: l })}
            onClear={() => setFilters({ ...filters, officeLocation: null })}
          />
          <PickerFilter
            label="Sales Division"
            items={scope.divisions}
            value={filters.salesDivision}
            getLabel={(d) => d.name}
            columns={[{ key: 'name', label: 'Division' }]}
            searchKeys={['name']}
            onSelect={(d) => setFilters({ ...filters, salesDivision: d })}
            onClear={() => setFilters({ ...filters, salesDivision: null })}
          />
          <div className="field">
            <label>Cancelled Orders</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400 }}>
              <input
                type="checkbox"
                checked={filters.includeCancelled}
                onChange={(e) => setFilters({ ...filters, includeCancelled: e.target.checked })}
              />
              Include
            </label>
          </div>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" onClick={generate} disabled={loading}>
            {loading ? 'Generating...' : 'Generate'}
          </button>
          <button className="btn" onClick={reset} disabled={loading}>Reset</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="warning-banner" style={{ marginBottom: 16 }}>{notice}</div>}

      {loading && <LoadingSpinner label="Generating..." expectedMs={4000} />}

      {!loading && report && (
        <div className="card">
          <div style={{ marginBottom: 12, display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <strong>{report.total.toLocaleString()} sales order{report.total === 1 ? '' : 's'}</strong>
            <span className="muted" style={{ fontSize: 13 }}>
              Page {report.page} of {report.total_pages.toLocaleString()}
            </span>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Est #</th>
                  <th>SO #</th>
                  <th>SO Date</th>
                  <th>JO #</th>
                  <th>JO Date</th>
                  <th>Sales Rep</th>
                  <th>Sales Div</th>
                  <th>Office Location</th>
                  <th>Customer</th>
                  <th>Contract Desc.</th>
                  <th style={{ textAlign: 'right' }}>Est Revenue</th>
                  <th style={{ textAlign: 'right' }}>Est Cost</th>
                  <th style={{ textAlign: 'right' }}>Actual Revenue</th>
                  <th style={{ textAlign: 'right' }}>Actual Cost</th>
                  <th style={{ textAlign: 'right' }}>Unbilled Receivable</th>
                  <th style={{ textAlign: 'right' }}>Committed Cost</th>
                  <th style={{ textAlign: 'right' }}>Profit</th>
                  <th style={{ textAlign: 'right' }}>Margin %</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={COLS} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    No sales orders match these filters.
                  </td></tr>
                )}
                {rows.map((o) => {
                  const isCollapsed = !!collapsed[o.sales_order_id];
                  return [
                    <tr key={`so-${o.sales_order_id}`} style={{ background: 'var(--color-neutral-bg)' }}>
                      <td>{o.estimate_id
                        ? <Link to={`/estimates/${o.estimate_id}`}>{o.estimate_no}</Link>
                        : o.estimate_no}</td>
                      <td><Link to={`/sales-orders/${o.sales_order_id}`}>{o.sales_order_no}</Link></td>
                      <td style={{ whiteSpace: 'nowrap' }}>{dmy(o.so_date)}</td>
                      <td></td>
                      <td></td>
                      <td>{o.sales_rep_name || ''}</td>
                      <td>{o.sales_division_name || ''}</td>
                      <td>{o.office_location_name || ''}</td>
                      <td><CustomerLink id={o.customer_id} name={o.customer_name} /></td>
                      <td style={{ maxWidth: 240 }}>
                        {o.contract_description || ''}
                        {o.status === 'cancelled' && (
                          <span className="badge badge-muted" style={{ marginLeft: 6 }}>cancelled</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>{money(o.est_revenue)}</td>
                      <td style={{ textAlign: 'right' }}>{money(o.est_cost)}</td>
                      <td style={{ textAlign: 'right' }}>{money(o.actual_revenue)}</td>
                      <td style={{ textAlign: 'right' }}>{money(o.actual_cost)}</td>
                      <td style={{ textAlign: 'right' }}>{money(o.unbilled_receivable)}</td>
                      <td style={{ textAlign: 'right' }}>{money(o.committed_cost)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, ...signColor(o.profit) }}>{money(o.profit)}</td>
                      <td style={{ textAlign: 'right', ...signColor(o.profit) }}>
                        {o.actual_revenue ? `${money(o.margin_pct)}%` : ''}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button
                          className="btn btn-sm btn-primary"
                          style={{ marginRight: 4 }}
                          disabled={o.lines.length === 0}
                          onClick={() => setCollapsed((c) => ({ ...c, [o.sales_order_id]: !isCollapsed }))}
                        >
                          {isCollapsed ? 'Expand' : 'Collapse'}
                        </button>
                        <a
                          className="btn btn-sm"
                          href={`/sales-orders/${o.sales_order_id}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Expand New Tab
                        </a>
                      </td>
                    </tr>,
                    ...(isCollapsed ? [] : o.lines.map((l) => (
                      <tr key={`line-${l.line_id}`}>
                        <td></td>
                        <td></td>
                        <td></td>
                        <td>{l.job_order_id
                          ? <Link to={`/job-orders/${l.job_order_id}`}>{l.job_order_no}</Link>
                          : <span className="muted">no JO yet</span>}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{dmy(l.jo_date)}</td>
                        <td colSpan={5} className="muted" style={{ maxWidth: 320 }}>
                          {l.description || ''}
                          {l.quantity ? ` — ${qty(l.quantity)} ${l.units || ''}` : ''}
                          {l.job_orders.length > 1 && (
                            <span className="badge badge-muted" style={{ marginLeft: 6 }}>
                              {l.job_orders.length} JOs
                            </span>
                          )}
                        </td>
                        <td style={{ textAlign: 'right' }}>{money(l.est_revenue)}</td>
                        <td style={{ textAlign: 'right' }}>{money(l.est_cost)}</td>
                        <td style={{ textAlign: 'right' }}>{money(l.actual_revenue)}</td>
                        <td style={{ textAlign: 'right' }}>{money(l.actual_cost)}</td>
                        <td style={{ textAlign: 'right' }}>{money(l.unbilled_receivable)}</td>
                        <td style={{ textAlign: 'right' }}>{money(l.committed_cost)}</td>
                        <td style={{ textAlign: 'right', ...signColor(l.profit) }}>{money(l.profit)}</td>
                        <td style={{ textAlign: 'right', ...signColor(l.profit) }}>
                          {l.actual_revenue ? `${money(l.margin_pct)}%` : ''}
                        </td>
                        <td>
                          <button className="btn btn-sm btn-primary" onClick={() => openDetail(o, l)}>Details</button>
                        </td>
                      </tr>
                    ))),
                    // Invoiced money that names no job order, so it cannot be put on a line. It is
                    // already counted in the group's Actual Revenue -- this row is what makes the
                    // children add up to the parent, and says why they otherwise would not.
                    ...(isCollapsed || !o.unallocated_revenue ? [] : [
                      <tr key={`unalloc-${o.sales_order_id}`}>
                        <td></td><td></td><td></td><td></td><td></td>
                        <td colSpan={5} className="muted">
                          Invoiced, not attributable to a line
                          <span
                            className="badge badge-warning"
                            style={{ marginLeft: 6 }}
                            title="These invoice lines carry no job order, so the amount cannot be placed on one line. It is counted in this sales order's Actual Revenue."
                          >
                            no JO on the invoice line
                          </span>
                        </td>
                        <td style={{ textAlign: 'right' }}>0.00</td>
                        <td style={{ textAlign: 'right' }}>0.00</td>
                        <td style={{ textAlign: 'right' }}>{money(o.unallocated_revenue)}</td>
                        <td style={{ textAlign: 'right' }}>0.00</td>
                        <td style={{ textAlign: 'right' }}>{money(-o.unallocated_revenue)}</td>
                        <td style={{ textAlign: 'right' }}>0.00</td>
                        <td style={{ textAlign: 'right' }}>{money(o.unallocated_revenue)}</td>
                        <td></td>
                        <td></td>
                      </tr>,
                    ]),
                  ];
                })}
              </tbody>
              {rows.length > 0 && totals && (
                <tfoot>
                  <tr style={{ fontWeight: 700 }}>
                    {/* Labelled "This page" deliberately. A grand total over the whole filter
                        would have to aggregate all 69,761 orders' lines, builds and invoices on
                        every run -- the Download is the honest way to total a large filter. */}
                    <td colSpan={10} style={{ textAlign: 'right' }}>This page :</td>
                    <td style={{ textAlign: 'right' }}>{money(totals.est_revenue)}</td>
                    <td style={{ textAlign: 'right' }}>{money(totals.est_cost)}</td>
                    <td style={{ textAlign: 'right' }}>{money(totals.actual_revenue)}</td>
                    <td style={{ textAlign: 'right' }}>{money(totals.actual_cost)}</td>
                    <td style={{ textAlign: 'right' }}>{money(totals.unbilled_receivable)}</td>
                    <td style={{ textAlign: 'right' }}>{money(totals.committed_cost)}</td>
                    <td style={{ textAlign: 'right', ...signColor(totals.profit) }}>{money(totals.profit)}</td>
                    <td style={{ textAlign: 'right', ...signColor(totals.profit) }}>
                      {totals.actual_revenue ? `${money(totals.margin_pct)}%` : ''}
                    </td>
                    <td></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {report.total_pages > 1 && (
            <div className="picker-pagination" style={{ marginTop: 16 }}>
              <button type="button" disabled={report.page === 1} onClick={() => setPage(report.page - 1)}>Previous</button>
              <span style={{ padding: '0 12px', alignSelf: 'center' }}>
                {report.page.toLocaleString()} / {report.total_pages.toLocaleString()}
              </span>
              <button type="button" disabled={report.page >= report.total_pages} onClick={() => setPage(report.page + 1)}>Next</button>
            </div>
          )}

          {/* Said on the report, not in a wiki: every one of these columns is a choice between
              two or three plausible sources, and the person checking a figure against a Job
              Order needs to know which one was taken. */}
          <div className="muted" style={{ marginTop: 16, fontSize: 13, lineHeight: 1.6 }}>
            <div><strong>Est Revenue</strong> is the sales order line&apos;s gross amount (tax inclusive), so a group adds up to the Sales Order&apos;s own total.</div>
            <div><strong>Est Cost</strong> is the process + material cost of every job order on the line — the same figure the Production job order screen shows as Total Amount.</div>
            <div><strong>Actual Revenue</strong> is what has been invoiced, cancelled invoices excluded — for a group, straight off its invoices; for a line, the invoice lines naming one of its job orders. <strong>Unbilled Receivable</strong> is Est Revenue less that.</div>
            <div><strong>Actual Cost</strong> is completed Assembly Builds plus received purchases charged to the job order; <strong>Committed Cost</strong> is purchases ordered and not yet received.</div>
            <div><strong>Profit</strong> is Actual Revenue less Actual Cost, and Margin % is Profit over Actual Revenue — so a job that has been built but not yet billed shows its cost as a loss until it is invoiced.</div>
            <div style={{ marginTop: 6 }}>
              Three limits worth knowing. <strong>Invoiced, not attributable to a line</strong> rows are invoice lines that carry no job order — 36% of all money invoiced, mostly
              the largest invoices, because the migration did not bring that link across. The amount is in the group&apos;s Actual Revenue and in the page total, but it cannot be
              placed on a job, so those groups show a profit for the order without showing which line earned it. <strong>Committed Cost</strong> and the purchased half of Actual
              Cost read 0.00 throughout, because no purchase order line in this database names a job order yet. And <strong>JO Date</strong> is the job order&apos;s Date Created,
              which for migrated job orders is the date they were imported rather than the date they were raised.
            </div>
          </div>
        </div>
      )}

      {detail && (
        <Modal
          title={`Details — ${detail.line.job_order_no || detail.order.sales_order_no} line ${detail.line.line_no}`}
          onClose={() => setDetail(null)}
          xl
        >
          {detailLoading && <LoadingSpinner />}
          {detail.error && <div className="error-banner">{detail.error}</div>}
          {!detailLoading && detail.data && (
            <>
              <div className="review-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 16 }}>
                <div className="field"><label>Est Revenue</label><div>{money(detail.data.totals.est_revenue)}</div></div>
                <div className="field"><label>Est Cost</label><div>{money(detail.data.totals.est_cost)}</div></div>
                <div className="field"><label>Actual Revenue</label><div>{money(detail.data.totals.actual_revenue)}</div></div>
                <div className="field"><label>Actual Cost</label><div>{money(detail.data.totals.actual_cost)}</div></div>
                <div className="field"><label>Unbilled Receivable</label><div>{money(detail.data.totals.unbilled_receivable)}</div></div>
                <div className="field"><label>Committed Cost</label><div>{money(detail.data.totals.committed_cost)}</div></div>
                <div className="field"><label>Profit</label><div style={signColor(detail.data.totals.profit)}>{money(detail.data.totals.profit)}</div></div>
                <div className="field"><label>Margin %</label>
                  <div style={signColor(detail.data.totals.profit)}>
                    {detail.data.totals.actual_revenue ? `${money(detail.data.totals.margin_pct)}%` : '--'}
                  </div>
                </div>
              </div>

              <h3 className="subsection">Job Orders ({detail.data.job_orders.length})</h3>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>JO #</th><th>Date</th><th>Status</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Built</th><th style={{ textAlign: 'right' }}>Invoiced</th></tr></thead>
                  <tbody>
                    {detail.data.job_orders.length === 0 && (
                      <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 16 }}>No job order has been raised from this line.</td></tr>
                    )}
                    {detail.data.job_orders.map((j) => (
                      <tr key={j.id}>
                        <td><Link to={`/job-orders/${j.id}`}>{j.job_order_no}</Link></td>
                        <td>{dmy(j.jo_date)}</td>
                        <td>{j.status}{j.sub_status ? ` — ${j.sub_status}` : ''}</td>
                        <td style={{ textAlign: 'right' }}>{qty(j.quantity)}</td>
                        <td style={{ textAlign: 'right' }}>{qty(j.quantity_built)}</td>
                        <td style={{ textAlign: 'right' }}>{qty(j.quantity_invoiced)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h3 className="subsection">Est Cost — process costing ({detail.data.processes.length})</h3>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>JO #</th><th>Process</th><th>Category</th><th>Item</th><th style={{ textAlign: 'right' }}>Qty</th><th>Unit</th><th style={{ textAlign: 'right' }}>Process Cost</th><th style={{ textAlign: 'right' }}>Material Cost</th><th style={{ textAlign: 'right' }}>Est Cost</th></tr></thead>
                  <tbody>
                    {detail.data.processes.length === 0 && (
                      <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 16 }}>No process costing on this line&apos;s job orders.</td></tr>
                    )}
                    {detail.data.processes.map((p, i) => (
                      <tr key={i}>
                        <td>{p.job_order_no}</td>
                        <td>{p.process_name || ''}</td>
                        <td>{p.category || ''}</td>
                        <td>{p.item_name || ''}</td>
                        <td style={{ textAlign: 'right' }}>{qty(p.qty)}</td>
                        <td>{p.unit || ''}</td>
                        <td style={{ textAlign: 'right' }}>{money(p.process_cost)}</td>
                        <td style={{ textAlign: 'right' }}>{money(p.material_cost)}</td>
                        <td style={{ textAlign: 'right' }}>{money(p.line_est_cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h3 className="subsection">Actual Cost — assembly builds ({detail.data.builds.length})</h3>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>AB #</th><th>JO #</th><th>Date</th><th>Status</th><th style={{ textAlign: 'right' }}>Qty Built</th><th style={{ textAlign: 'right' }}>Cost</th></tr></thead>
                  <tbody>
                    {detail.data.builds.length === 0 && (
                      <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 16 }}>Nothing has been built against this line yet.</td></tr>
                    )}
                    {detail.data.builds.map((b) => (
                      <tr key={b.id}>
                        <td><Link to={`/assembly-builds/${b.id}`}>{b.ab_no}</Link></td>
                        <td>{b.job_order_no}</td>
                        <td>{dmy(b.date_created)}</td>
                        <td>{b.status}</td>
                        <td style={{ textAlign: 'right' }}>{qty(b.quantity_built)}</td>
                        {/* A build that is still 'saved' is not counted in Actual Cost -- shown
                            so the reader can see why the column is lower than these rows add to. */}
                        <td style={{ textAlign: 'right' }}>
                          {money(b.total_amount)}
                          {b.status !== 'completed' && <span className="muted"> (not counted)</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h3 className="subsection">Actual Revenue — invoices ({detail.data.invoices.length})</h3>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Invoice #</th><th>Date</th><th>Status</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Price</th><th style={{ textAlign: 'right' }}>Net of Tax</th><th style={{ textAlign: 'right' }}>Tax</th><th style={{ textAlign: 'right' }}>Gross</th></tr></thead>
                  <tbody>
                    {detail.data.invoices.length === 0 && (
                      <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 16 }}>This line has not been invoiced.</td></tr>
                    )}
                    {detail.data.invoices.map((inv, i) => (
                      <tr key={i}>
                        <td><Link to={`/sales-invoices/${inv.id}`}>{inv.invoice_no}</Link></td>
                        <td>{dmy(inv.date_created)}</td>
                        <td>{inv.status}</td>
                        <td style={{ textAlign: 'right' }}>{qty(inv.quantity)}</td>
                        <td style={{ textAlign: 'right' }}>{money(inv.price_per_unit)}</td>
                        <td style={{ textAlign: 'right' }}>{money(inv.net_of_tax)}</td>
                        <td style={{ textAlign: 'right' }}>{money(inv.tax_amount)}</td>
                        <td style={{ textAlign: 'right' }}>
                          {money(inv.gross_amount)}
                          {inv.status === 'cancelled' && <span className="muted"> (not counted)</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {detail.data.purchases.length > 0 && (
                <>
                  <h3 className="subsection">Purchases charged to this job ({detail.data.purchases.length})</h3>
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>PO #</th><th>JO #</th><th>Item</th><th>Status</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Received</th><th style={{ textAlign: 'right' }}>Rate</th><th style={{ textAlign: 'right' }}>In Actual Cost</th><th style={{ textAlign: 'right' }}>Committed</th></tr></thead>
                      <tbody>
                        {detail.data.purchases.map((p, i) => (
                          <tr key={i}>
                            <td><Link to={`/purchase-orders/${p.id}`}>{p.po_no}</Link></td>
                            <td>{p.job_order_no}</td>
                            <td>{p.item_name || ''}</td>
                            <td>{p.status}</td>
                            <td style={{ textAlign: 'right' }}>{qty(p.qty)}</td>
                            <td style={{ textAlign: 'right' }}>{qty(p.received_qty)}</td>
                            <td style={{ textAlign: 'right' }}>{money(p.rate)}</td>
                            <td style={{ textAlign: 'right' }}>{money(p.received_cost)}</td>
                            <td style={{ textAlign: 'right' }}>{money(p.committed_cost)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
