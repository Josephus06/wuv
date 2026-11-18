import { useEffect, useState, Fragment } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import CompanyBranchFilter from '../../components/CompanyBranchFilter';
import { headOfficeLocationId } from '../../utils/useHeadOffice';
import { CustomerLink } from '../../components/PartyLink';
import LoadingSpinner from '../../components/LoadingSpinner';
import { REPORT_TIMING } from '../../utils/reportTiming';
import Modal from '../../components/Modal';
import { money } from './CoaTreeRows';

import { displayDate } from '../../utils/dates';

function today() { return new Date().toISOString().slice(0, 10); }
import { downloadFile } from '../../utils/downloadFile';
import FilterPicker from '../../components/FilterPicker';
import EntityPicker from '../../components/EntityPicker';
function formatDate(v) { return v ? displayDate(String(v).slice(0, 10)) : ''; }

// Mirrors the real system's Accounting > Reports > AR Aging: a Location / Name Starts /
// No Location / Date-as-of filter bar + Generate, then a customer-per-row table split into
// Current / 1-30 / 31-60 / 61-90 / Over-90 buckets with a totals row. DETAILS and LEDGER
// drill each customer down to the open items behind the number, and the full transaction
// history, respectively.
// Each transaction in the Details and Ledger popups opens its own record (asked 2026-10-05).
const PATH_BY_TYPE = {
  Invoice: 'sales-invoices',
  'Credit Memo': 'credit-memos',
  'Unapplied Payment': 'customer-payments',
  Payment: 'customer-payments',
};
function DocLink({ type, id, children }) {
  return PATH_BY_TYPE[type] && id != null ? <Link to={`/${PATH_BY_TYPE[type]}/${id}`}>{children}</Link> : children;
}

// The heading shade on the SBU layout, as on the SBU heads' own sheet.
const SBU_FILL = '#F8CBAD';

export default function ArAging() {
  const [asOf, setAsOf] = useState(today());
  const [locationId, setLocationId] = useState('');
  const [noLocation, setNoLocation] = useState(false);
  // Company (Fresh n Tidy, Cuts For Tots ...): every branch of it, when no single Location is picked.
  const [companyScope, setCompanyScope] = useState({ companyId: '', locationId: '' });
  // Include / exclude the customers whose balance is a credit -- we owe them (2026-11-13).
  const [credit, setCredit] = useState('include');
  const [nameStarts, setNameStarts] = useState('');
  const [locations, setLocations] = useState([]);
  // Per Term, per Account Officer, per Customer (2026-10-13). Term and Account Officer are each invoice's own.
  const [termId, setTermId] = useState('');
  const [officerId, setOfficerId] = useState('');
  const [customer, setCustomer] = useState(null);
  const [terms, setTerms] = useState([]);
  const [officers, setOfficers] = useState([]);
  // Per SBU / Sales Group (2026-10-14): each invoice's own sales group; an SBU is its groups.
  const [sbu, setSbu] = useState('');
  const [salesGroupId, setSalesGroupId] = useState('');
  const [sbus, setSbus] = useState([]);
  const [salesGroups, setSalesGroups] = useState([]);
  const [customerOptions, setCustomerOptions] = useState([]);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [drill, setDrill] = useState(null); // { mode: 'details'|'ledger', customer, data }
  const [drillLoading, setDrillLoading] = useState(false);

  useEffect(() => {
    api.get('/lookups/locations').then(({ data }) => setLocations(data)).catch(() => {});
    api.get('/reports/ar-aging/filter-options').then(({ data }) => { setTerms(data.terms || []); setOfficers(data.officers || []); setSbus(data.sbus || []); setSalesGroups(data.salesGroups || []); }).catch(() => {});
  }, []);

  // Location starts on Head Office (2026-10-14; utils/useHeadOffice), unless one is already chosen.
  useEffect(() => {
    headOfficeLocationId().then((id) => { if (id) setLocationId((v) => (v === '' ? id : v)); });
  }, []);

  function queryParams() {
    const params = { asOf };
    if (noLocation) params.noLocation = true;
    else if (locationId) params.locationId = locationId;
    else if (companyScope.companyId) params.companyId = companyScope.companyId;
    if (nameStarts) params.nameStarts = nameStarts;
    if (termId) params.term = termId;
    if (officerId) params.officerId = officerId;
    if (salesGroupId) params.salesGroupId = salesGroupId;
    else if (sbu) params.sbu = sbu;
    if (customer) params.customerId = customer.id;
    if (credit === 'exclude') params.credit = 'exclude';
    return params;
  }

  // The customer list is searched on the server (over 20,000 customers); the selection is kept in it.
  function searchCustomers(text) {
    api.get('/reports/ar-aging/customers', { params: { q: (text || '').trim() } })
      .then(({ data }) => setCustomerOptions(customer && !data.some((c) => String(c.id) === String(customer.id)) ? [customer, ...data] : data))
      .catch(() => {});
  }

  // Extract: the same report, as an Excel workbook, under the filters on screen.
  const [extracting, setExtracting] = useState(false);
  async function extract() {
    setExtracting(true);
    try {
      await downloadFile('/reports/ar-aging', { ...queryParams(), format: 'xlsx' }, `ar-aging-${asOf}.xlsx`);
    } catch {
      setError('Could not extract the report.');
    } finally {
      setExtracting(false);
    }
  }

  async function generate() {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/reports/ar-aging', { params: queryParams() });
      setReport(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to generate report');
    } finally {
      setLoading(false);
    }
  }

  async function openDrill(mode, customer) {
    setDrill({ mode, customer, data: null });
    setDrillLoading(true);
    try {
      const { data } = await api.get(`/reports/ar-aging/customer/${customer.customer_id}/${mode}`, { params: { asOf } });
      setDrill({ mode, customer, data });
    } catch (err) {
      setDrill({ mode, customer, data: null, error: err.response?.data?.error || 'Failed to load' });
    } finally {
      setDrillLoading(false);
    }
  }

  // Filtered by SBU, the report comes back in sections (lib/arAging.js buildSbuLayout).
  const sbuLayout = report?.sbu_layout || null;

  // One customer row. In the SBU layout the role column is blank and the officer is the section's.
  function renderRow(row, key, sectionName) {
    return (
                  <tr key={key}>
                    <td data-label="Customer"><CustomerLink id={row.customer_id} name={row.customer_name} /></td>
                    <td data-label="Term">{row.term_name || '—'}</td>
                    {sbuLayout && <td></td>}
                    <td data-label="Account Officer">{row.officer_name || sectionName || '—'}</td>
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
                          title={`${row.unevidenced_count} invoice(s) marked Paid In Full with no payment recorded`}
                        >
                          {money(row.unevidenced_amount)} unevidenced
                        </div>
                      )}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {/* An opening balance whose source customer matched none in T1S has no customer to
                          open; its documents are listed in AR Aging Details. */}
                      {row.customer_id ? (
                        <>
                          <button className="btn btn-sm btn-primary" style={{ marginRight: 4 }} onClick={() => openDrill('details', row)}>Details</button>
                          <button className="btn btn-sm btn-primary" onClick={() => openDrill('ledger', row)}>Ledger</button>
                        </>
                      ) : <span className="muted" style={{ fontSize: 11 }}>Not a customer in this system</span>}
                    </td>
                  </tr>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1>AR Aging</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <CompanyBranchFilter value={companyScope} showBranch={false} onChange={(v) => { setCompanyScope(v); setLocationId(''); }} />
          <div className="field">
            <label>Location</label>
            <FilterPicker label="Location" items={companyScope.companyId ? locations.filter((l) => String(l.company_id) === String(companyScope.companyId)) : locations} value={locationId} onChange={(v) => setLocationId(v)}
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
            <label>Term</label>
            <FilterPicker label="Term" items={terms} value={termId} onChange={(v) => setTermId(v)}
              getLabel={(t) => t.term_name} allLabel="--ALL--" />
          </div>
          <div className="field">
            <label>Account Officer</label>
            <FilterPicker label="Account Officer" items={officers} value={officerId} onChange={(v) => setOfficerId(v)}
              getLabel={(o) => o.name} allLabel="--ALL--" />
          </div>
          <div className="field">
            <label>SBU</label>
            <FilterPicker label="SBU" items={sbus} value={sbu} getLabel={(g) => g.name} allLabel="--ALL--"
              onChange={(v) => {
                setSbu(v);
                // A group outside the newly chosen SBU would quietly override it.
                const g = sbus.find((x) => String(x.id) === String(v));
                if (g && salesGroupId && !g.departmentIds.map(String).includes(String(salesGroupId))) setSalesGroupId('');
              }} />
          </div>
          <div className="field">
            <label>Sales Group</label>
            <FilterPicker label="Sales Group" value={salesGroupId} onChange={(v) => setSalesGroupId(v)}
              items={(() => { const g = sbus.find((x) => String(x.id) === String(sbu)); return g ? salesGroups.filter((d) => g.departmentIds.map(String).includes(String(d.id))) : salesGroups; })()}
              getLabel={(d) => d.name} allLabel="--ALL--" />
          </div>
          <div className="field">
            <label>Customer</label>
            <EntityPicker
              label="Customer" items={customerOptions} value={customer?.id ?? ''} getLabel={(c) => c.name}
              columns={[{ key: 'name', label: 'Customer' }]} searchKeys={['name']} placeholder="--ALL--"
              onSearch={searchCustomers}
              onSelect={(c) => setCustomer(c || null)}
              onClear={() => setCustomer(null)}
            />
          </div>
          <div className="field">
            <label>Credit Balance</label>
            <select value={credit} onChange={(e) => setCredit(e.target.value)} title="A credit balance is a customer whose balance is below zero -- we owe them">
              <option value="include">Include credit balance</option>
              <option value="exclude">Exclude credit balance</option>
            </select>
          </div>
          <div className="field">
            <label>Date as of</label>
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={generate} disabled={loading}>
          {loading ? 'Generating...' : 'Generate'}
        </button>
        <button className="btn" style={{ marginTop: 12, marginLeft: 8 }} onClick={extract} disabled={extracting}>
          {extracting ? 'Extracting...' : 'Extract'}
        </button>
      </div>

      {error && <div className="card" style={{ color: '#b91c1c', marginBottom: 16 }}>{error}</div>}

      {loading && <LoadingSpinner label="Generating..." expectedMs={REPORT_TIMING.arAging} />}

      {/* Said before the numbers, not after: it changes how every figure below should be
          read. The amount is still IN the totals -- dropping it would hide the receivable on
          the strength of a flag with nothing behind it -- but the reader is told how much of
          the report rests on that disagreement. */}
      {!loading && report?.totals?.unevidenced_count > 0 && (
        <div className="warning-banner" style={{ marginBottom: 16 }}>
          <strong>{report.totals.unevidenced_count.toLocaleString()} invoices</strong> totalling{' '}
          <strong>{money(report.totals.unevidenced_amount)}</strong> are counted below but are marked
          “Paid In Full” on the invoice itself, with no payment or credit memo in the system settling them.
          They are included because the payment record is missing, not because the money is known to be owed —
          open a customer’s <em>Details</em> to see which.
        </div>
      )}

      {!loading && report && (
        <div className="card">
          <div style={{ marginBottom: 12 }}><strong>As of {report.as_of}</strong></div>
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr>
                  <th>Customer Name</th>
                  <th>Term</th>
                  {sbuLayout && <th></th>}
                  <th>Account Officer</th>
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
                  <tr><td colSpan={sbuLayout ? 11 : 10} className="muted" style={{ textAlign: 'center', padding: 20 }}>No outstanding balances as of this date.</td></tr>
                )}
                {!sbuLayout && report.rows.map((row) => renderRow(row, row.row_key || row.customer_id))}
                {sbuLayout && sbuLayout.sections.map((sec, k) => (
                  <Fragment key={`sec-${k}`}>
                    <tr style={{ fontWeight: 700 }}>
                      <td></td><td></td>
                      <td style={{ background: SBU_FILL, color: '#1f2937' }}>{sec.label}</td>
                      <td style={{ background: SBU_FILL, color: '#1f2937' }}>{sec.name}</td>
                      <td colSpan={7}></td>
                    </tr>
                    {sec.rows.map((row) => renderRow(row, `${k}-${row.row_key || row.customer_id}`, sec.name))}
                  </Fragment>
                ))}
              </tbody>
              {report.rows.length > 0 && (
                <tfoot>
                  <tr style={{ fontWeight: 700 }}>
                    <td colSpan={sbuLayout ? 4 : 3} style={{ textAlign: 'right' }}>Total :</td>
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
        </div>
      )}

      {drill && (
        <Modal
          title={`${drill.mode === 'details' ? 'AR Details' : 'Customer Ledger'} — ${drill.customer.customer_name}`}
          onClose={() => setDrill(null)}
          xl
        >
          {drillLoading && <LoadingSpinner />}
          {drill.error && <div className="error-banner">{drill.error}</div>}
          {!drillLoading && drill.data && drill.mode === 'details' && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Type</th><th>Reference</th><th>Date</th><th>Due Date</th><th style={{ textAlign: 'right' }}>Original</th><th style={{ textAlign: 'right' }}>Balance</th><th style={{ textAlign: 'right' }}>Days Overdue</th><th>Note</th></tr>
                </thead>
                <tbody>
                  {drill.data.items.length === 0 && (
                    <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>No open items.</td></tr>
                  )}
                  {drill.data.items.map((it, idx) => (
                    <tr key={idx}>
                      <td>{it.type}</td>
                      <td><DocLink type={it.type} id={it.id}>{it.reference}</DocLink></td>
                      <td>{formatDate(it.date)}</td>
                      <td>{formatDate(it.due_date)}</td>
                      <td style={{ textAlign: 'right' }}>{money(it.original_amount)}</td>
                      <td style={{ textAlign: 'right' }}>{money(it.balance)}</td>
                      <td style={{ textAlign: 'right' }}>{it.days_overdue}</td>
                      {/* The answer to "why is this here when the invoice says Paid In Full",
                          on the line that raises the question. */}
                      <td>
                        {it.marked_paid_unevidenced && (
                          <span className="badge badge-warning" title="The invoice is marked Paid In Full and amount due is 0, but no payment or credit memo in this system settles it. Included here because the payment record is missing, not because the money is known to be owed.">
                            marked paid, no payment recorded
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700 }}>
                    <td colSpan={5} style={{ textAlign: 'right' }}>Total Open Invoices :</td>
                    <td style={{ textAlign: 'right' }}>{money(drill.data.total_balance)}</td>
                    <td></td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
              {/* Invoices only (asked 2026-10-13). The customer's credits still count on the report's
                  row, so the difference is said here; the Ledger lists them. */}
              {drill.data.credits_count > 0 && (
                <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                  Not listed: {drill.data.credits_count} unapplied payment{drill.data.credits_count === 1 ? '' : 's'} / credit
                  memo{drill.data.credits_count === 1 ? '' : 's'} totalling {money(drill.data.credits_balance)}.
                  With them, the customer&apos;s Total Balance is {money(drill.data.customer_balance)} — see the Ledger.
                </div>
              )}
            </div>
          )}
          {!drillLoading && drill.data && drill.mode === 'ledger' && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Date</th><th>Type</th><th>Reference</th><th style={{ textAlign: 'right' }}>Amount</th><th style={{ textAlign: 'right' }}>Running Balance</th></tr>
                </thead>
                <tbody>
                  {drill.data.ledger.length === 0 && (
                    <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No transactions.</td></tr>
                  )}
                  {drill.data.ledger.map((e, idx) => (
                    <tr key={idx}>
                      <td>{formatDate(e.date)}</td>
                      <td>{e.type}</td>
                      <td><DocLink type={e.type} id={e.id}>{e.reference}</DocLink></td>
                      <td style={{ textAlign: 'right' }}>{money(e.amount)}</td>
                      <td style={{ textAlign: 'right' }}>{money(e.balance)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700 }}>
                    <td colSpan={4} style={{ textAlign: 'right' }}>Total Balance :</td>
                    <td style={{ textAlign: 'right' }}>{money(drill.data.total_balance)}</td>
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
