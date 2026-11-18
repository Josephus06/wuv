import { useEffect, useState } from 'react';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import { money } from './CoaTreeRows';

// The transactions behind one clicked Balance Sheet amount (GET /reports/balance-sheet/transactions):
// every entry making up the account's balance as of the date, oldest first, with a running balance
// -- the source's own Balance Sheet drill-down. Entries from before the cut-over are the old
// system's documents, read from it live; each Trans # opens its document in a new tab.
export default function AccountTransactionsModal({ account, asOf, scope, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // A busy account is cut to its latest 1,000 lines (older ones brought forward as one); Show all lifts it.
  const [all, setAll] = useState(false);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError('');
    api.get('/reports/balance-sheet/transactions', { params: { accountCode: account.account_code, asOf, all: all ? 1 : undefined, ...(scope || {}) } })
      .then((r) => { if (alive) { setData(r.data); setLoading(false); } })
      .catch((e) => { if (alive) { setError(e.response?.data?.error || 'Failed to load transactions'); setLoading(false); } });
    return () => { alive = false; };
  }, [account.account_code, asOf, all]);

  let running = 0;
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 50, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 24, overflow: 'auto' }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ maxWidth: 1000, width: '100%', maxHeight: '85vh', overflow: 'auto', marginTop: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <strong>{account.account_code} | {account.account_name} &nbsp;·&nbsp; as of {asOf}</strong>
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </div>
        {loading && <LoadingSpinner label="Reading the account's transactions..." />}
        {error && <div style={{ color: '#b91c1c' }}>{error}</div>}
        {data && !loading && data.total_count > data.shown_count && (
          <div className="muted" style={{ marginBottom: 8 }}>
            Showing the latest {data.shown_count.toLocaleString('en-US')} of {data.total_count.toLocaleString('en-US')} transactions; the earlier ones are carried as one brought-forward line, so the total still matches.{' '}
            <button type="button" className="link-btn" style={{ textDecoration: 'underline' }} onClick={() => setAll(true)}>Show all</button> (may be slow)
          </div>
        )}
        {data && !loading && (
          <div className="table-wrap">
            <table className="responsive-cards">
              <thead>
                <tr><th>Trans #</th><th>Date</th><th>Name</th><th style={{ textAlign: 'right' }}>Debit</th><th style={{ textAlign: 'right' }}>Credit</th><th style={{ textAlign: 'right' }}>Balance</th></tr>
              </thead>
              <tbody>
                {data.rows.map((r, i) => {
                  running += (Number(r.debit) || 0) - (Number(r.credit) || 0);
                  return (
                    <tr key={i}>
                      <td data-label="Trans #">{r.link
                        ? <a href={r.link} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--link, #2563eb)', textDecoration: 'underline' }}>{r.source_no}</a>
                        : r.source_no}</td>
                      <td data-label="Date">{(r.entry_date || '').slice(0, 10)}</td>
                      <td data-label="Name">{r.name}</td>
                      <td data-label="Debit" style={{ textAlign: 'right' }}>{money(r.debit)}</td>
                      <td data-label="Credit" style={{ textAlign: 'right' }}>{money(r.credit)}</td>
                      <td data-label="Balance" style={{ textAlign: 'right' }}>{money(Math.round(running * 100) / 100) || '0.00'}</td>
                    </tr>
                  );
                })}
                {!data.rows.length && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--muted,#888)' }}>No transactions.</td></tr>}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700 }}>
                  <td colSpan={3}>TOTAL ({data.rows.length} transaction{data.rows.length === 1 ? '' : 's'})</td>
                  <td style={{ textAlign: 'right' }}>{money(data.total_debit)}</td>
                  <td style={{ textAlign: 'right' }}>{money(data.total_credit)}</td>
                  <td style={{ textAlign: 'right' }}>{money(data.balance) || '0.00'}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
