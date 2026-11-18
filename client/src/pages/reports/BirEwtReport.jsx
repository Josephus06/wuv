import { useEffect, useState } from 'react';
import BirCompanyPicker from '../../components/BirCompanyPicker';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import { SupplierLink } from '../../components/PartyLink';
import { DeadlineBanner, MonthPicker, Stat, day, money, useCsvDownload, useMonth } from './BirTaxCommon';

// BIR Reports > Expanded Withholding Tax (asked 2026-10-21): what we withheld from suppliers in the
// month, by ATC -- the figures for the 0619-E / 1601-EQ and the QAP. Due the 5th of the next month.
export default function BirEwtReport() {
  const [month, setMonth] = useMonth(-1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [atc, setAtc] = useState('');
  const csv = useCsvDownload('/reports/bir/ewt', { month }, `bir-ewt-${month}.csv`);

  useEffect(() => {
    let live = true;
    setLoading(true); setError(''); setAtc('');
    api.get('/reports/bir/ewt', { params: { month } })
      .then(({ data: d }) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e.response?.data?.error || 'Could not load the report.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [month]);

  const rows = (data?.rows || []).filter((r) => !atc || r.atc === atc);

  return (
    <div>
      <div className="page-header">
        <h1>Expanded Withholding Tax</h1>
        <BirCompanyPicker />
        <button className="btn btn-primary" disabled={csv.busy || !data?.rows?.length} onClick={csv.download}>
          {csv.busy ? 'Preparing…' : 'Download CSV'}
        </button>
      </div>
      {(error || csv.error) && <div className="error-banner">{error || csv.error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <MonthPicker month={month} onChange={setMonth} />
      </div>

      {loading ? <LoadingSpinner /> : data && (
        <>
          <DeadlineBanner deadline={data.deadline} what={`Expanded Withholding Tax for ${data.label} (0619-E / 1601-EQ)`} />
          <div className="stat-grid">
            <Stat label="Tax withheld" value={money(data.totals.wtax_amount)} />
            <Stat label="Tax base" value={money(data.totals.tax_base)} />
            <Stat label="Documents" value={data.totals.count} />
            {data.no_atc > 0 && <Stat label="Without an ATC — fix on the bill" value={data.no_atc} tone="warning" />}
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ marginTop: 0 }}>Summary by ATC</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>ATC</th><th>Nature of Income Payment</th><th style={{ textAlign: 'right' }}>Rate</th><th style={{ textAlign: 'right' }}>Docs</th><th style={{ textAlign: 'right' }}>Tax Base</th><th style={{ textAlign: 'right' }}>Tax Withheld</th></tr>
                </thead>
                <tbody>
                  {data.summary.map((s) => (
                    <tr key={s.atc} onClick={() => setAtc(atc === s.atc ? '' : s.atc)} style={{ cursor: 'pointer', background: atc === s.atc ? 'var(--accent-bg)' : undefined }}>
                      <td><strong>{s.atc}</strong></td>
                      <td style={{ maxWidth: 420 }}>{s.nature || (s.atc === 'Not set' ? 'No withholding tax chosen on the document' : '')}</td>
                      <td style={{ textAlign: 'right' }}>{s.rate != null ? `${Number(s.rate)}%` : ''}</td>
                      <td style={{ textAlign: 'right' }}>{s.count}</td>
                      <td style={{ textAlign: 'right' }}>{money(s.tax_base)}</td>
                      <td style={{ textAlign: 'right' }}><strong>{money(s.wtax_amount)}</strong></td>
                    </tr>
                  ))}
                  {!data.summary.length && <tr><td colSpan={6} className="muted">Nothing withheld in {data.label}.</td></tr>}
                </tbody>
                {data.summary.length > 0 && (
                  <tfoot>
                    <tr><th colSpan={3}>Total</th><th style={{ textAlign: 'right' }}>{data.totals.count}</th><th style={{ textAlign: 'right' }}>{money(data.totals.tax_base)}</th><th style={{ textAlign: 'right' }}>{money(data.totals.wtax_amount)}</th></tr>
                  </tfoot>
                )}
              </table>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>Click an ATC to list only its documents below.</div>
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Documents{atc ? ` — ${atc}` : ''}</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>ATC</th><th>Document</th><th>Date</th><th>Supplier</th><th>TIN</th><th style={{ textAlign: 'right' }}>Tax Base</th><th style={{ textAlign: 'right' }}>Withheld</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.doc_type}-${r.id}`}>
                      <td>{r.atc}</td>
                      <td>{r.doc_type} {r.doc_no}{r.reference_no ? <div className="muted" style={{ fontSize: 12 }}>{r.reference_no}</div> : null}</td>
                      <td>{day(r.date_created)}</td>
                      <td><SupplierLink id={r.supplier_id} name={r.supplier_name || '—'} /></td>
                      <td>{r.supplier_tin || <span className="muted">none</span>}</td>
                      <td style={{ textAlign: 'right' }}>{money(r.tax_base)}</td>
                      <td style={{ textAlign: 'right' }}>{money(r.wtax_amount)}</td>
                    </tr>
                  ))}
                  {!rows.length && <tr><td colSpan={7} className="muted">No documents.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
