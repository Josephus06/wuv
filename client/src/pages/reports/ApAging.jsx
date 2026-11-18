import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import { headOfficeLocationId } from '../../utils/useHeadOffice';
import { SupplierLink } from '../../components/PartyLink';
import LoadingSpinner from '../../components/LoadingSpinner';
import Modal from '../../components/Modal';
import { money } from './CoaTreeRows';
import { displayDate } from '../../utils/dates';
import { downloadFile } from '../../utils/downloadFile';
import FilterPicker from '../../components/FilterPicker';

// Accounting > Reports > AP Aging -- the payables mirror of AR Aging, vendor by vendor, in the
// same five buckets and the same layout so the two read as a pair. DETAILS opens the bills,
// credits and payments behind one vendor's number.
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function formatDate(v) { return v ? displayDate(String(v).slice(0, 10)) : ''; }

const DOC_LINK = {
  'Vendor Bill': (it) => `/vendor-bills/${it.id}`,
  'Bill Credit': (it) => `/bill-credits/${it.id}`,
  'Unapplied Payment': (it) => `/bill-payments/${it.id}`,
};

export default function ApAging() {
  const [asOf, setAsOf] = useState(today());
  const [locationId, setLocationId] = useState('');
  const [noLocation, setNoLocation] = useState(false);
  const [nameStarts, setNameStarts] = useState('');
  const [includeUnevidenced, setIncludeUnevidenced] = useState(false);
  // Include / exclude the vendors whose balance is a credit -- they owe us (2026-11-13, as on AR Aging).
  const [credit, setCredit] = useState('include');
  const [locations, setLocations] = useState([]);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [drill, setDrill] = useState(null);
  const [drillLoading, setDrillLoading] = useState(false);

  useEffect(() => {
    api.get('/lookups/locations').then(({ data }) => setLocations(data)).catch(() => {});
  }, []);

  // Location starts on Head Office (2026-10-14; utils/useHeadOffice), unless one is already chosen.
  useEffect(() => {
    headOfficeLocationId().then((id) => { if (id) setLocationId((v) => (v === '' ? id : v)); });
  }, []);

  function queryParams() {
    const params = { asOf };
    if (noLocation) params.noLocation = true;
    else if (locationId) params.locationId = locationId;
    if (nameStarts) params.nameStarts = nameStarts;
    if (includeUnevidenced) params.includeUnevidenced = true;
    if (credit === 'exclude') params.credit = 'exclude';
    return params;
  }

  // Extract: the summary, or AP Aging Details -- every open bill behind it, by vendor -- as Excel,
  // under the filters on screen.
  const [extracting, setExtracting] = useState('');
  async function extract(kind) {
    setExtracting(kind);
    try {
      if (kind === 'details') await downloadFile('/reports/ap-aging/details', queryParams(), `ap-aging-details-${asOf}.xlsx`);
      else await downloadFile('/reports/ap-aging', { ...queryParams(), format: 'xlsx' }, `ap-aging-${asOf}.xlsx`);
    } catch {
      setError('Could not extract the report.');
    } finally {
      setExtracting('');
    }
  }

  async function generate() {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/reports/ap-aging', { params: queryParams() });
      setReport(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to generate report');
    } finally {
      setLoading(false);
    }
  }

  async function openDrill(vendor) {
    setDrill({ vendor, data: null });
    setDrillLoading(true);
    try {
      // A row whose source vendor matched no T1S supplier has no id; its Details are found by name.
      const { data } = vendor.supplier_id
        ? await api.get(`/reports/ap-aging/supplier/${vendor.supplier_id}/details`, { params: queryParams() })
        : await api.get('/reports/ap-aging/unmatched/details', { params: { ...queryParams(), name: vendor.supplier_name } });
      setDrill({ vendor, data });
    } catch (err) {
      setDrill({ vendor, data: null, error: err.response?.data?.error || 'Failed to load' });
    } finally {
      setDrillLoading(false);
    }
  }

  const activeLocation = locations.find((l) => String(l.id) === String(locationId));
  const excluded = report?.excluded_unevidenced;
  const unlinked = report?.excluded_unlinked_payments;

  return (
    <div>
      <div className="page-header">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span className="badge badge-muted" style={{ fontSize: 13 }}>
            {noLocation ? 'No location' : activeLocation?.location_name || 'All locations'}
          </span>
          <span>AP Aging</span>
        </h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Location</label>
            <FilterPicker label="Location" items={locations} value={locationId} onChange={(v) => setLocationId(v)}
              getLabel={(l) => l.location_name} allLabel="--ALL--" disabled={noLocation} />
          </div>
          <div className="field">
            <label>Name Starts (eg. ABCD)</label>
            <input value={nameStarts} onChange={(e) => setNameStarts(e.target.value)} placeholder="Name Starts" />
          </div>
          <div className="field">
            <label>No Location</label>
            <input type="checkbox" checked={noLocation} onChange={(e) => setNoLocation(e.target.checked)} />
          </div>
          <div className="field">
            <label>Credit Balance</label>
            <select value={credit} onChange={(e) => setCredit(e.target.value)} title="A credit balance is a vendor whose balance is below zero -- it owes us">
              <option value="include">Include credit balance</option>
              <option value="exclude">Exclude credit balance</option>
            </select>
          </div>
          <div className="field">
            <label>Date as of</label>
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </div>
          <div className="field">
            <label>Bills marked paid with no payment</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400 }}>
              <input
                type="checkbox"
                checked={includeUnevidenced}
                onChange={(e) => setIncludeUnevidenced(e.target.checked)}
              />
              Include
            </label>
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={generate} disabled={loading}>
          {loading ? 'Generating...' : 'Generate'}
        </button>
        <button className="btn" style={{ marginTop: 12, marginLeft: 8 }} onClick={() => extract('summary')} disabled={!!extracting}>
          {extracting === 'summary' ? 'Extracting...' : 'Extract'}
        </button>
        <button className="btn" style={{ marginTop: 12, marginLeft: 8 }} onClick={() => extract('details')} disabled={!!extracting}>
          {extracting === 'details' ? 'Extracting...' : 'Extract Details'}
        </button>
      </div>

      {error && <div className="card" style={{ color: '#b91c1c', marginBottom: 16 }}>{error}</div>}

      {loading && <LoadingSpinner label="Generating..." expectedMs={3000} />}

      {/* Said before the numbers, because it changes how every figure below should be read.
          Unlike AR Aging, this report leaves these bills OUT by default -- 65% of the bills in
          this database claim to be paid with no payment recorded, and counting them would report
          about twelve times the real payable. The amount is stated here either way. */}
      {!loading && excluded?.count > 0 && (
        <div className="warning-banner" style={{ marginBottom: 16 }}>
          <strong>{excluded.count.toLocaleString()} vendor bills</strong> totalling{' '}
          <strong>{money(excluded.amount)}</strong> are marked paid on the bill itself with no bill payment
          in this system settling them — the bill payment migration is unfinished.
          {excluded.included
            ? ' They ARE counted in the figures below, so this total is the derived-from-documents view, not what the business is carrying.'
            : ' They are NOT counted below. Tick “Include” above to see the derived-from-documents view.'}
        </div>
      )}

      {/* The other half of the same missing link, and it has to be said alongside the first:
          leaving these in while the bills they settled are left out would net a phantom credit
          against nothing and report a negative payable. */}
      {!loading && unlinked?.count > 0 && (
        <div className="warning-banner" style={{ marginBottom: 16 }}>
          <strong>{unlinked.count.toLocaleString()} bill payments</strong> totalling{' '}
          <strong>{money(unlinked.amount)}</strong> carry no application lines at all — the same unfinished
          migration, seen from the payment side. They are
          {unlinked.included ? ' counted below as unapplied cash, which is what pushes the total negative.'
            : ' left out, because money whose links were never imported is not money sitting unapplied.'}{' '}
          Every payment that does carry lines is fully applied by them, so no genuine overpayment is being hidden.
        </div>
      )}

      {!loading && report && (
        <div className="card">
          <div style={{ marginBottom: 12 }}><strong>As of {report.as_of}</strong></div>
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Vendor Name</th>
                  <th style={{ textAlign: 'right' }}>Current</th>
                  <th style={{ textAlign: 'right' }}>1-30 days</th>
                  <th style={{ textAlign: 'right' }}>31-60 days</th>
                  <th style={{ textAlign: 'right' }}>61-90 days</th>
                  <th style={{ textAlign: 'right' }}>Over 90 days</th>
                  <th style={{ textAlign: 'right' }}>Total Balance</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {report.rows.length === 0 && (
                  <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>No outstanding payables as of this date.</td></tr>
                )}
                {report.rows.map((row) => (
                  <tr key={row.row_key || row.supplier_id}>
                    <td data-label="Vendor"><SupplierLink id={row.supplier_id} name={row.supplier_name} /></td>
                    <td data-label="Current" style={{ textAlign: 'right' }}>{money(row.current)}</td>
                    <td data-label="1-30 days" style={{ textAlign: 'right' }}>{money(row.d1_30)}</td>
                    <td data-label="31-60 days" style={{ textAlign: 'right' }}>{money(row.d31_60)}</td>
                    <td data-label="61-90 days" style={{ textAlign: 'right' }}>{money(row.d61_90)}</td>
                    <td data-label="Over 90 days" style={{ textAlign: 'right' }}>{money(row.over_90)}</td>
                    <td data-label="Total Balance" style={{ textAlign: 'right', fontWeight: 600 }}>
                      {money(row.total_balance)}
                      {row.unevidenced_count > 0 && (
                        <div
                          className="muted"
                          style={{ fontSize: 11, fontWeight: 400 }}
                          title={`${row.unevidenced_count} bill(s) marked paid with no payment recorded`}
                        >
                          {money(row.unevidenced_amount)} unevidenced
                        </div>
                      )}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm btn-primary" onClick={() => openDrill(row)}>Details</button>
                    </td>
                  </tr>
                ))}
              </tbody>
              {report.rows.length > 0 && (
                <tfoot>
                  <tr style={{ fontWeight: 700 }}>
                    <td style={{ textAlign: 'right' }}>Total :</td>
                    <td style={{ textAlign: 'right' }}>{money(report.totals.current)}</td>
                    <td style={{ textAlign: 'right' }}>{money(report.totals.d1_30)}</td>
                    <td style={{ textAlign: 'right' }}>{money(report.totals.d31_60)}</td>
                    <td style={{ textAlign: 'right' }}>{money(report.totals.d61_90)}</td>
                    <td style={{ textAlign: 'right' }}>{money(report.totals.over_90)}</td>
                    <td style={{ textAlign: 'right' }}>{money(report.totals.total_balance)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          <div className="muted" style={{ marginTop: 16, fontSize: 13, lineHeight: 1.6 }}>
            <div>
              A bill is aged from its <strong>due date</strong>; a bill credit or an unapplied payment has none and ages from its own
              date. <strong>Current</strong> is not yet due.
            </div>
            <div>
              What is owed on a bill is its gross <strong>less withholding tax</strong> — that part was never the vendor&apos;s money —
              less the payments and bill credits applied to it by the as-of date.
            </div>
            <div>
              A negative balance is the vendor owing us: an unused bill credit, or cash paid and not yet applied to a bill.
            </div>
            {report.header_disagreement?.count > 0 && (
              <div style={{ marginTop: 6 }}>
                <strong>{report.header_disagreement.count.toLocaleString()} bills</strong> above carry a header Amount Due
                lower than their own documents support, by <strong>{money(report.header_disagreement.amount)}</strong> in total —
                something drew those headers down without leaving a payment behind. The figures here follow the documents, so
                that much of the total rests on a disagreement with the bill screen.
              </div>
            )}
          </div>
        </div>
      )}

      {drill && (
        <Modal title={`AP Details — ${drill.vendor.supplier_name}`} onClose={() => setDrill(null)} xl>
          {drillLoading && <LoadingSpinner />}
          {drill.error && <div className="error-banner">{drill.error}</div>}
          {!drillLoading && drill.data && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Type</th><th>Reference</th><th>PO #</th><th>Vendor Ref</th><th>Date</th><th>Due Date</th>
                    <th style={{ textAlign: 'right' }}>Original</th><th style={{ textAlign: 'right' }}>Balance</th>
                    <th style={{ textAlign: 'right' }}>Days Overdue</th><th>Location</th>
                  </tr>
                </thead>
                <tbody>
                  {drill.data.items.length === 0 && (
                    <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 20 }}>No open items.</td></tr>
                  )}
                  {drill.data.items.map((it, idx) => {
                    const href = DOC_LINK[it.type]?.(it);
                    return (
                      <tr key={idx}>
                        <td>{it.type}</td>
                        <td>{href ? <Link to={href}>{it.reference}</Link> : it.reference}
                          {it.marked_paid_unevidenced && (
                            <span className="badge badge-warning" style={{ marginLeft: 6 }} title="Marked paid on the bill, with no bill payment recording it.">
                              marked paid
                            </span>
                          )}
                          {/* Settled by a payment / credit dated after the as-of date: still owed on it (2026-11-13). */}
                          {it.paid_later && (
                            <span className="badge badge-info" style={{ marginLeft: 6 }}
                              title={`Owed as of ${formatDate(asOf)}: ${it.paid_later.ref} settles it, dated ${formatDate(it.paid_later.date)}.`}>
                              paid {formatDate(it.paid_later.date)} · {it.paid_later.ref}
                            </span>
                          )}
                        </td>
                        <td>{it.po_no || ''}</td>
                        <td>{it.ref_no || ''}</td>
                        <td>{formatDate(it.date)}</td>
                        <td>{formatDate(it.due_date)}</td>
                        <td style={{ textAlign: 'right' }}>{money(it.original_amount)}</td>
                        <td style={{ textAlign: 'right' }}>{money(it.balance)}</td>
                        <td style={{ textAlign: 'right' }}>{it.days_overdue}</td>
                        <td>{it.location_name || ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700 }}>
                    <td colSpan={7} style={{ textAlign: 'right' }}>Total Balance :</td>
                    <td style={{ textAlign: 'right' }}>{money(drill.data.total_balance)}</td>
                    <td></td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
