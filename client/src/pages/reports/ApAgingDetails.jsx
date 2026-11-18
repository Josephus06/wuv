import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import { headOfficeLocationId } from '../../utils/useHeadOffice';
import { SupplierLink } from '../../components/PartyLink';
import EntityPicker from '../../components/EntityPicker';
import LoadingSpinner from '../../components/LoadingSpinner';
import { REPORT_TIMING } from '../../utils/reportTiming';
import { downloadFile } from '../../utils/downloadFile';
import FilterPicker from '../../components/FilterPicker';

// Accounting > Reports > AP Aging Details (2026-10-09) -- AR Aging Details' twin for payables: the
// documents behind AP Aging, grouped by vendor: every vendor bill still carrying a balance, every bill
// credit not yet used up, every bill payment with money still unapplied, with what it is and how old.
//
// Built from the same open items as AP Aging and grouped the same way (lib/apAging.js), so a vendor's
// rows always add up to that vendor's Total Balance on AP Aging.
function money(v) {
  const n = Number(v);
  return Number.isFinite(n)
    ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '';
}
function dmy(v) {
  if (!v) return '';
  const [y, m, d] = String(v).slice(0, 10).split('-');
  return y && m && d ? `${m}-${d}-${y}` : String(v).slice(0, 10);
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Every row opens its own document; an opening-balance row the source never handed over has no id and
// stays plain text.
const PATH_BY_TYPE = {
  'Vendor Bill': 'vendor-bills',
  'Bill Credit': 'bill-credits',
  'Unapplied Payment': 'bill-payments',
};
const linkFor = (it) => (it.id == null ? null : `/${PATH_BY_TYPE[it.type]}/${it.id}`);

const PAGE_SIZES = [25, 50, 100, 200];

export default function ApAgingDetails() {
  const [filters, setFilters] = useState({
    supplier: null, locationId: '', noLocation: false, nameStarts: '', asOf: today(),
  });
  const [applied, setApplied] = useState(null);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [locations, setLocations] = useState([]);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [supplierOptions, setSupplierOptions] = useState([]);

  useEffect(() => {
    api.get('/lookups/locations').then(({ data }) => setLocations(data)).catch(() => {});
  }, []);

  // Location starts on Head Office (2026-10-14; utils/useHeadOffice), unless one is already chosen.
  useEffect(() => {
    headOfficeLocationId().then((id) => { if (id) setFilters((f) => (f.locationId === '' ? { ...f, locationId: id } : f)); });
  }, []);

  const paramsOf = useCallback((f, extra = {}) => {
    const p = { asOf: f.asOf, ...extra };
    if (f.supplier) p.supplierId = f.supplier.id;
    if (f.noLocation) p.noLocation = 'true';
    else if (f.locationId) p.locationId = f.locationId;
    if (f.nameStarts) p.nameStarts = f.nameStarts;
    return p;
  }, []);

  const load = useCallback(async (f, pageNum, pageSize) => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/reports/ap-aging-details', {
        params: paramsOf(f, { page: pageNum, limit: pageSize }),
      });
      setReport(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to generate the report.');
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [paramsOf]);

  // Nothing runs until Generate, matching AP Aging beside it: this reads every vendor bill, bill
  // payment and bill credit in the database, so it is not something to fire on
  // arrival or on each keystroke.
  useEffect(() => {
    if (applied) load(applied, page, limit);
  }, [applied, page, limit, load]);

  function generate() {
    setPage(1);
    setApplied({ ...filters });
  }

  // The Vendor picker's search, handed to the server; the current selection is kept in the list so
  // the picker's trigger never blanks a filter that is still in force.
  function searchSuppliers(text) {
    api.get('/reports/ap-aging-details/suppliers', { params: { q: (text || '').trim() } })
      .then(({ data }) => setSupplierOptions(() => {
        const sel = filters.supplier;
        return sel && !data.some((c) => String(c.id) === String(sel.id)) ? [sel, ...data] : data;
      }))
      .catch(() => {});
  }

  async function download() {
    try {
      const res = await api.get('/reports/ap-aging-details', {
        params: paramsOf(applied || filters, { format: 'csv' }),
        responseType: 'blob',
      });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ap-aging-details-${(applied || filters).asOf}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError('Could not download the report.');
    }
  }

  // Extract: every vendor's documents (not just this page of them) as an Excel workbook.
  const [extracting, setExtracting] = useState(false);
  async function extract() {
    setExtracting(true);
    try {
      const f = applied || filters;
      await downloadFile('/reports/ap-aging-details', paramsOf(f, { format: 'xlsx' }), `ap-aging-details-${f.asOf}.xlsx`);
    } catch {
      setError('Could not extract the report.');
    } finally {
      setExtracting(false);
    }
  }

  const activeLocation = locations.find((l) => String(l.id) === String((applied || filters).locationId));
  const rows = report?.rows || [];

  return (
    <div>
      <div className="page-header">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span className="badge badge-muted" style={{ fontSize: 13 }}>
            {(applied || filters).noLocation ? 'No location' : activeLocation?.location_name || 'All locations'}
          </span>
          <span>AP Aging Details</span>
        </h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm btn-primary" disabled={extracting} onClick={extract}>{extracting ? 'Extracting...' : 'Extract'}</button>
          <button className="btn btn-sm" disabled={!report || loading} onClick={download}>Download CSV</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Vendor</label>
            <EntityPicker
              label="Vendor"
              items={supplierOptions}
              value={filters.supplier?.id ?? ''}
              getLabel={(c) => c.name}
              columns={[{ key: 'name', label: 'Vendor' }]}
              searchKeys={['name']}
              placeholder="--ALL--"
              onSearch={searchSuppliers}
              onSelect={(c) => setFilters((f) => ({ ...f, supplier: c || null }))}
              onClear={() => setFilters((f) => ({ ...f, supplier: null }))}
            />
          </div>
          <div className="field">
            <label>Location</label>
            <FilterPicker label="Location" items={locations} value={filters.locationId} onChange={(v) => setFilters({ ...filters, locationId: v })}
              getLabel={(l) => l.location_name} allLabel="--ALL--" disabled={filters.noLocation} />
          </div>
          <div className="field">
            <label>Name Starts (eg. ABCD)</label>
            <input
              value={filters.nameStarts}
              placeholder="Name Starts"
              onChange={(e) => setFilters({ ...filters, nameStarts: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') generate(); }}
            />
          </div>
          <div className="field">
            <label>No Location</label>
            <input
              type="checkbox"
              checked={filters.noLocation}
              onChange={(e) => setFilters({ ...filters, noLocation: e.target.checked })}
            />
          </div>
          <div className="field">
            <label>Date as of</label>
            <input type="date" value={filters.asOf} onChange={(e) => setFilters({ ...filters, asOf: e.target.value })} />
          </div>
          <div className="field">
            <label>Vendors per page</label>
            <select value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}>
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={generate} disabled={loading}>
          {loading ? 'Generating...' : 'Generate'}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading && <LoadingSpinner label="Generating..." expectedMs={REPORT_TIMING.arAging} />}

      {!loading && report?.totals?.unevidenced_count > 0 && (
        <div className="warning-banner" style={{ marginBottom: 16 }}>
          <strong>{report.totals.unevidenced_count.toLocaleString()} vendor bills</strong> below are marked
          paid on the bill itself, with no bill payment or bill credit in this system settling them -- listed the
          way AP Aging counts them.
        </div>
      )}

      {!loading && report && (
        <div className="card">
          <div style={{ marginBottom: 12, display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <strong>As of {report.as_of}</strong>
            <span>{report.totals.vendor_count.toLocaleString()} vendors</span>
            <span>{report.totals.item_count.toLocaleString()} open items</span>
            <span>Total open balance: <strong>{money(report.totals.open_balance)}</strong></span>
            <span className="muted" style={{ fontSize: 13 }}>
              Page {report.page} of {report.total_pages.toLocaleString()}
            </span>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th>Trans Date</th>
                  <th>Trans #</th>
                  <th>Ref #</th>
                  <th>Memo</th>
                  <th>PO #</th>
                  <th>Date Due</th>
                  <th style={{ textAlign: 'right' }}>Age</th>
                  <th style={{ textAlign: 'right' }}>Open Balance</th>
                  <th>Location</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    Nothing outstanding for these filters as of this date.
                  </td></tr>
                )}
                {rows.map((g) => [
                  <tr key={`v-${g.row_key || g.supplier_id}`} style={{ background: 'var(--color-neutral-bg)' }}>
                    <td colSpan={8} style={{ fontWeight: 600 }}>
                      <span style={{ color: 'var(--color-accent, #14b8a6)', marginRight: 8 }}>●</span>
                      {g.supplier_name ? <SupplierLink id={g.supplier_id} name={g.supplier_name} /> : <span className="muted">(no vendor name)</span>}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{money(g.total_balance)}</td>
                    <td></td>
                  </tr>,
                  ...g.items.map((it) => {
                    const href = PATH_BY_TYPE[it.type] ? linkFor(it) : null;
                    return (
                      <tr key={`${it.type}-${it.id}`}>
                        <td></td>
                        <td style={{ whiteSpace: 'nowrap' }}>{dmy(it.trans_date)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {href ? <Link to={href}>{it.trans_no}</Link> : it.trans_no}
                          {it.marked_paid_unevidenced && (
                            <span
                              className="badge badge-warning"
                              style={{ marginLeft: 6 }}
                              title="The vendor bill is marked paid, but no bill payment or bill credit in this system settles it."
                            >
                              marked paid
                            </span>
                          )}
                          {/* Settled by a payment / credit dated after the as-of date: still owed on it (2026-11-13). */}
                          {it.paid_later && (
                            <span className="badge badge-info" style={{ marginLeft: 6 }}
                              title={`Still owed on the as-of date: ${it.paid_later.ref} settles it, dated ${dmy(it.paid_later.date)}.`}>
                              paid {dmy(it.paid_later.date)} · {it.paid_later.ref}
                            </span>
                          )}
                        </td>
                        <td>{it.ref_no || ''}</td>
                        <td style={{ maxWidth: 260 }}>{it.memo || ''}</td>
                        <td>{it.po_no || ''}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{dmy(it.date_due)}</td>
                        <td style={{ textAlign: 'right' }}>{it.age}</td>
                        <td style={{ textAlign: 'right', color: Number(it.open_balance) < 0 ? '#b91c1c' : undefined }}>
                          {money(it.open_balance)}
                        </td>
                        <td>{it.location_name || ''}</td>
                      </tr>
                    );
                  }),
                ])}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr style={{ fontWeight: 700 }}>
                    <td colSpan={8} style={{ textAlign: 'right' }}>This page :</td>
                    <td style={{ textAlign: 'right' }}>{money(report.page_total)}</td>
                    <td></td>
                  </tr>
                  <tr style={{ fontWeight: 700 }}>
                    <td colSpan={8} style={{ textAlign: 'right' }}>All {report.totals.vendor_count.toLocaleString()} vendors :</td>
                    <td style={{ textAlign: 'right' }}>{money(report.totals.open_balance)}</td>
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

          <div className="muted" style={{ marginTop: 16, fontSize: 13, lineHeight: 1.6 }}>
            <div>
              <strong>Age</strong> counts days from the due date for a vendor bill, and from the document date for a bill credit or an
              unapplied bill payment, which have none. A negative age is a bill not yet due.
            </div>
            <div>
              <strong>Open Balance</strong> is signed the way the payable is: a bill&apos;s unpaid remainder is positive, a bill
              credit not yet used and money paid out but not yet applied are negative.
            </div>
            <div>
              The rows for a vendor add up to that vendor&apos;s Total Balance on <Link to="/reports/ap-aging">AP Aging</Link> —
              both reports are built from the same open items, as of the same date.
              {report.totals.zero_net_vendor_count > 0 && (
                <>
                  {' '}The vendor <em>counts</em> differ by {report.totals.zero_net_vendor_count.toLocaleString()}:
                  that many vendors here hold open documents that cancel out exactly, so their balance is zero and
                  AP Aging has no row for them.
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
