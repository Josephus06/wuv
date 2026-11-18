import { useEffect, useState } from 'react';
import BirCompanyPicker from '../../components/BirCompanyPicker';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import SearchInput from '../../components/SearchInput';
import { CustomerLink } from '../../components/PartyLink';
import { useAuth } from '../../context/useAuth';
import { DeadlineBanner, MonthPicker, Stat, day, money, useCsvDownload, useMonth } from './BirTaxCommon';

const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

// BIR Reports > Creditable Withholding Tax (asked 2026-10-21): the month's invoices our customers
// withheld on, and whether each one's BIR 2307 has come in -- to be collected by the end of the month.
// Whoever has Edit on the page marks a certificate received (date, certificate no.).
export default function BirCwtReport() {
  const { can } = useAuth();
  const mayEdit = can('/reports/bir-cwt', 'can_edit');
  const [month, setMonth] = useMonth(0);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // { id, received_date, certificate_no, remarks }
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const csv = useCsvDownload('/reports/bir/cwt', { month, status: status || undefined, search: applied || undefined }, `bir-2307-${month}.csv`);

  useEffect(() => {
    let live = true;
    setLoading(true); setError('');
    api.get('/reports/bir/cwt', { params: { month, status: status || undefined, search: applied || undefined } })
      .then(({ data: d }) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e.response?.data?.error || 'Could not load the report.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [month, status, applied, reload]);

  async function save(received) {
    setSaving(true); setError('');
    try {
      await api.put(`/reports/bir/cwt/${editing.id}`, received
        ? { received: true, received_date: editing.received_date, certificate_no: editing.certificate_no, remarks: editing.remarks }
        : { received: false });
      setEditing(null);
      setReload((n) => n + 1);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not save.');
    }
    setSaving(false);
  }

  const t = data?.totals;
  return (
    <div>
      <div className="page-header">
        <h1>Creditable Withholding Tax (2307 from Customers)</h1>
        <BirCompanyPicker />
        <button className="btn btn-primary" disabled={csv.busy || !data?.rows?.length} onClick={csv.download}>
          {csv.busy ? 'Preparing…' : 'Download CSV'}
        </button>
      </div>
      {(error || csv.error) && <div className="error-banner">{error || csv.error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid" style={{ alignItems: 'flex-end' }}>
          <MonthPicker month={month} onChange={setMonth} />
          <div className="field">
            <label>2307</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              <option value="pending">Not yet received</option>
              <option value="received">Received</option>
            </select>
          </div>
          <div className="field">
            <label>Search</label>
            <SearchInput placeholder="Customer, invoice, certificate no." value={search}
              onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setApplied(search.trim()); }} />
          </div>
          <div className="field"><button className="btn btn-secondary" onClick={() => setApplied(search.trim())}>Search</button></div>
        </div>
      </div>

      {loading && !data ? <LoadingSpinner /> : data && (
        <>
          <DeadlineBanner deadline={data.deadline} what={`2307s for ${data.label} to be collected from customers`} done={t.count > 0 && t.pending_count === 0} />
          <div className="stat-grid">
            <Stat label={`Withheld by customers (${t.count} invoices)`} value={money(t.ewt_amount)} />
            <Stat label={`2307 received (${t.received_count})`} value={money(t.received_amount)} tone="success" />
            <Stat label={`Not yet received (${t.pending_count})`} value={money(t.pending_amount)} tone={t.pending_count ? 'warning' : undefined} />
            {data.earlier_pending.count > 0 && (
              <Stat label={`Earlier months still without a 2307 (${data.earlier_pending.count}, since ${data.earlier_pending.since})`} value={money(data.earlier_pending.ewt_amount)} tone="danger" />
            )}
          </div>
          {data.cwt_credit_memos.count > 0 && (
            <div className="muted" style={{ marginBottom: 12 }}>
              CWT applied this month (credit memos to Creditable Withholding Tax): {data.cwt_credit_memos.count} · {money(data.cwt_credit_memos.amount)}
            </div>
          )}

          <div className="card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Customer</th><th>TIN</th><th>Invoice</th><th>Date</th>
                    <th style={{ textAlign: 'right' }}>Tax Base</th><th style={{ textAlign: 'right' }}>Rate</th><th style={{ textAlign: 'right' }}>Withheld</th>
                    <th>2307</th>{mayEdit && <th />}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id}>
                      <td><CustomerLink id={r.customer_id} name={r.customer_name || '—'} /></td>
                      <td>{r.customer_tin || <span className="muted">none</span>}</td>
                      <td>{r.invoice_no}{r.bs_si_no ? <div className="muted" style={{ fontSize: 12 }}>BS/SI {r.bs_si_no}</div> : null}</td>
                      <td>{day(r.date_created)}</td>
                      <td style={{ textAlign: 'right' }}>{money(r.tax_base)}</td>
                      <td style={{ textAlign: 'right' }}>{r.rate != null ? `${Number(r.rate)}%` : ''}</td>
                      <td style={{ textAlign: 'right' }}><strong>{money(r.ewt_amount)}</strong></td>
                      <td>
                        {r.received_date ? (
                          <>
                            <span className="badge badge-success">Received {day(r.received_date)}</span>
                            {r.certificate_no && <div className="muted" style={{ fontSize: 12 }}>No. {r.certificate_no}</div>}
                            {r.remarks && <div className="muted" style={{ fontSize: 12 }}>{r.remarks}</div>}
                          </>
                        ) : <span className="badge badge-warning">Not yet</span>}
                      </td>
                      {mayEdit && (
                        <td>
                          <button className="btn btn-secondary btn-sm" onClick={() => setEditing({
                            id: r.id, invoice_no: r.invoice_no, customer_name: r.customer_name, was: !!r.received_date,
                            received_date: day(r.received_date) || today(), certificate_no: r.certificate_no || '', remarks: r.remarks || '',
                          })}>{r.received_date ? 'Edit' : 'Mark received'}</button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {!data.rows.length && <tr><td colSpan={mayEdit ? 9 : 8} className="muted">No invoices with customer withholding{status ? ' for this filter' : ''} in {data.label}.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {editing && (
        <div className="modal-overlay" onClick={() => !saving && setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <h3 style={{ marginTop: 0 }}>2307 for {editing.invoice_no}</h3>
            <div className="muted" style={{ marginBottom: 12 }}>{editing.customer_name}</div>
            <div className="field">
              <label>Date received *</label>
              <input type="date" value={editing.received_date} onChange={(e) => setEditing({ ...editing, received_date: e.target.value })} />
            </div>
            <div className="field">
              <label>Certificate no.</label>
              <input value={editing.certificate_no} onChange={(e) => setEditing({ ...editing, certificate_no: e.target.value })} />
            </div>
            <div className="field">
              <label>Remarks</label>
              <input value={editing.remarks} onChange={(e) => setEditing({ ...editing, remarks: e.target.value })} />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
              {editing.was && <button className="btn btn-danger" disabled={saving} onClick={() => save(false)} style={{ marginRight: 'auto' }}>Not received</button>}
              <button className="btn btn-secondary" disabled={saving} onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={saving || !editing.received_date} onClick={() => save(true)}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
