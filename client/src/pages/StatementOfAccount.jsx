import { useEffect, useState } from 'react';
import api from '../api/client';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import PrintLetterhead from '../components/PrintLetterhead';
import { displayDate } from '../utils/dates';

// Accounting > Statement of Account (2026-10-08, laid out as live's): pick a customer or vendor and a
// statement date; the page lists their open documents with a running Balance Due and the aging
// summary underneath, and prints on the letterhead. The figures are AR / AP Aging's own
// (routes/statementOfAccounts.js), so the statement and those reports always agree.
const money = (v) => (v === null || v === undefined || v === '' ? ''
  : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const TABS = [{ key: 'customer', label: 'Customer' }, { key: 'vendor', label: 'Vendor' }];

function AccountPicker({ onPick, onClose }) {
  const [type, setType] = useState('customer');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api.get('/statement-of-accounts/parties', { params: { type, search, page } })
        .then(({ data: d }) => setData(d)).catch(() => setData({ rows: [], total: 0, page: 1, page_size: 15 }));
    }, 250);
    return () => clearTimeout(t);
  }, [type, search, page]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  return (
    <Modal title="Accounts" onClose={onClose} large>
      <input autoFocus placeholder="Search" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} style={{ marginBottom: 12 }} />
      <div className="status-tabs">
        {TABS.map((t) => (
          <button key={t.key} type="button" className={`status-tab ${type === t.key ? 'active' : ''}`}
            onClick={() => { setType(t.key); setPage(1); }}>{t.label}</button>
        ))}
      </div>
      {!data ? <LoadingSpinner /> : (
        <>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Code</th><th>Name</th></tr></thead>
              <tbody>
                {data.rows.length === 0 && <tr><td colSpan={2} className="muted" style={{ textAlign: 'center', padding: 16 }}>No matches.</td></tr>}
                {data.rows.map((r) => (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => onPick({ type, id: r.id, name: r.name })}>
                    <td>{r.code || ''}</td><td>{r.name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <span className="muted" style={{ fontSize: 12 }}>{data.total} {type === 'vendor' ? 'vendor' : 'customer'}(s)</span>
            <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
            <span style={{ fontSize: 12 }}>{page} / {pages}</span>
            <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</button>
          </div>
        </>
      )}
    </Modal>
  );
}

export default function StatementOfAccount() {
  const [account, setAccount] = useState(null);
  const [asOf, setAsOf] = useState(today());
  const [picking, setPicking] = useState(false);
  const [soa, setSoa] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!account || !asOf) return;
    setLoading(true); setError('');
    api.get('/statement-of-accounts', { params: { type: account.type, id: account.id, as_of: asOf } })
      .then(({ data }) => setSoa(data))
      .catch((e) => { setSoa(null); setError(e.response?.data?.error || 'Could not load the statement.'); })
      .finally(() => setLoading(false));
  }, [account, asOf]);

  const a = soa?.aging;
  return (
    <div className="soa-page">
      <style>{`
        .soa-table td.num, .soa-table th.num { text-align: right; white-space: nowrap; }
        /* The rows scroll inside their own box with the column headings frozen on top, so a long
           statement never loses its headings (asked 2026-10-09). */
        .soa-scroll { max-height: calc(100vh - 230px); overflow: auto; }
        .soa-table thead th { position: sticky; top: 0; z-index: 2; background: var(--bg); box-shadow: inset 0 -1px 0 var(--border, #ccc); }
        .soa-aging { width: 100%; border-collapse: collapse; margin-top: 28px; }
        .soa-aging th, .soa-aging td { border: 1px solid var(--border, #ccc); padding: 6px 10px; }
        .soa-aging th { text-align: center; font-weight: 600; }
        .soa-aging td { text-align: right; }
        .soa-print-head { display: none; }
        @media print {
          .soa-no-print { display: none !important; }
          .soa-print-head { display: block; margin-bottom: 14px; }
          .soa-page .card { box-shadow: none; border: none; padding: 0; }
          .soa-table th, .soa-table td { font-size: 10.5px; padding: 4px 6px; }
          .soa-scroll { max-height: none; overflow: visible; }
          .soa-table thead th { position: static; box-shadow: none; }
        }
      `}</style>

      <div className="page-header soa-no-print">
        <h1>Statement of Account</h1>
        <button className="btn btn-primary" disabled={!soa} onClick={() => window.print()}>Print</button>
      </div>

      <div className="card soa-no-print" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Account</label>
            <input readOnly value={account ? `${account.name} (${account.type === 'vendor' ? 'Vendor' : 'Customer'})` : ''}
              placeholder="Select an account..." onClick={() => setPicking(true)} style={{ cursor: 'pointer' }} />
          </div>
          <div className="field">
            <label>Statement Date</label>
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </div>
        </div>
      </div>

      {picking && <AccountPicker onClose={() => setPicking(false)} onPick={(acc) => { setAccount(acc); setPicking(false); }} />}
      {error && <div className="error-banner">{error}</div>}
      {loading && <LoadingSpinner />}

      {!loading && soa && (
        <div className="card">
          <div className="soa-print-head">
            <PrintLetterhead />
            <h2 style={{ textAlign: 'center', margin: '8px 0 12px' }}>Statement of Account</h2>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
              <div><strong>{soa.party.name}</strong>{soa.party.address ? <div>{soa.party.address}</div> : null}</div>
              {/* The total owed sits under the date, so the first thing the reader sees is what to pay. */}
              <div style={{ textAlign: 'right' }}>
                <div>Statement Date: <strong>{displayDate(soa.as_of)}</strong></div>
                <div>Amount Due: <strong>{money(soa.aging.total)}</strong></div>
              </div>
            </div>
          </div>

          <div className="table-wrap soa-scroll">
            <table className="soa-table">
              <thead>
                <tr>
                  <th>Date</th><th>Document #</th><th>Terms</th><th>{soa.type === 'vendor' ? 'Reference #' : 'BS/DR #'}</th>{soa.type !== 'vendor' && <th>PO #</th>}
                  <th className="num">{soa.type === 'vendor' ? 'Bill Amount' : 'Invoice Amount'}</th>
                  <th className="num">Amount Due</th><th className="num">{soa.type === 'vendor' ? 'Payment Amount' : 'Receipt Amount'}</th>
                  <th className="num">Balance Due</th>
                </tr>
              </thead>
              <tbody>
                {soa.rows.length === 0 && (
                  <tr><td colSpan={soa.type === 'vendor' ? 8 : 9} className="muted" style={{ textAlign: 'center', padding: 20 }}>Nothing outstanding as of {displayDate(soa.as_of)}.</td></tr>
                )}
                {soa.rows.map((r) => (
                  <tr key={`${r.type}-${r.id}-${r.document_no}`}>
                    <td>{displayDate(r.date)}</td>
                    <td>{r.document_no}{r.type !== 'Invoice' && r.type !== 'Vendor Bill' ? <span className="muted" style={{ fontSize: 11 }}> ({r.type})</span> : null}</td>
                    <td>{r.terms || ''}</td>
                    <td>{r.bs_no || ''}</td>
                    {soa.type !== 'vendor' && <td>{r.po_no || ''}</td>}
                    <td className="num">{money(r.invoice_amount)}</td>
                    <td className="num">{money(r.amount_due)}</td>
                    <td className="num">{money(r.receipt_amount)}</td>
                    <td className="num">{money(r.balance_due)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <table className="soa-aging">
            <thead><tr><th>Current</th><th>1-30 Days</th><th>31-60 Days</th><th>61-90 Days</th><th>Over 90 Days</th><th>Amount Due</th></tr></thead>
            <tbody>
              <tr>
                <td>{money(a.current)}</td><td>{money(a.d1_30)}</td><td>{money(a.d31_60)}</td>
                <td>{money(a.d61_90)}</td><td>{money(a.over_90)}</td><td><strong>{money(a.total)}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
