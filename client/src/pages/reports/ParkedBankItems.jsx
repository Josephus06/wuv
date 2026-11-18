import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
const day = (v) => (v ? String(v).slice(0, 10) : '');

// An item that has sat for a while is the one worth chasing; the rest are just this month's
// paperwork catching up.
function ageStyle(days) {
  const d = Number(days);
  if (d >= 60) return { color: 'var(--danger)', fontWeight: 600 };
  if (d >= 30) return { color: 'var(--warning)', fontWeight: 600 };
  return undefined;
}

// What is still sitting in 23100 Deposit and 23200 Disbursement.
//
// These two accounts are deliberately kept out of the Trial Balance, Balance Sheet, Income
// Statement and General Ledger -- they hold bank movements that have no document behind them yet,
// and letting them into the statements would overstate the books with amounts nobody has proven.
// The cost of that exclusion is that the money becomes invisible, so this is the one screen that
// looks, and the nightly reminder points here.
//
// BOTH ACCOUNTS SHOULD READ ZERO. Every row is money the bank has moved that the book cannot yet
// explain. When the document turns up and the statement line is matched to it, the parked journal
// is voided and the row disappears from here by itself. Nothing on this page needs a button.
export default function ParkedBankItems() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [account, setAccount] = useState('');

  const load = useCallback(async (accountCode) => {
    setLoading(true); setError('');
    try {
      const { data: d } = await api.get('/reports/parked-bank-items', {
        params: accountCode ? { account_code: accountCode } : {},
      });
      setData(d);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not load the report.');
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(account); }, [load, account]);

  const summary = data?.summary || [];
  const items = data?.items || [];
  // all_clear speaks for the whole thing; filtering to one account must not be able to claim it.
  const allClear = data?.all_clear && !account;

  return (
    <div>
      <div className="page-header">
        <h1>Unidentified Bank Items</h1>
        <button className="btn" disabled={loading} onClick={() => load(account)}>Refresh</button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          Money the bank has moved that the book cannot yet explain, parked in the Deposit and
          Disbursement holding accounts. These accounts are excluded from the Balance Sheet and
          every other accounting report, so this page is the only place they are visible.{' '}
          <strong>Both should read zero.</strong> An item leaves on its own once the document
          arrives and the statement line is matched to it in the reconciliation.
        </p>
      </div>

      {loading ? <LoadingSpinner /> : (
        <>
          {allClear ? (
            <div className="success-banner">
              Nothing is parked. Both holding accounts are at zero — every bank movement is
              accounted for.
            </div>
          ) : (
            <div className="warning-banner">
              {data?.total_items} item{data?.total_items === 1 ? '' : 's'} totalling{' '}
              {money(data?.total_outstanding)} {data?.total_items === 1 ? 'is' : 'are'} still
              unidentified. Each one needs its document found and matched, or a correcting entry.
            </div>
          )}

          {summary.length > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Holding account</th>
                      <th style={{ textAlign: 'right' }}>Items</th>
                      <th style={{ textAlign: 'right' }}>Balance</th>
                      <th>Oldest</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.map((a) => (
                      <tr key={a.account_code}>
                        <td>{a.account_code} — {a.account_name}</td>
                        <td style={{ textAlign: 'right' }}>{a.items}</td>
                        {/* Signed the way each account reads: Deposit holds unexplained receipts,
                            Disbursement unexplained payments. Shown as a magnitude, because the
                            sign is a bookkeeping detail and the question here is how much. */}
                        <td style={{ textAlign: 'right' }}>{money(Math.abs(Number(a.balance)))}</td>
                        <td style={ageStyle(a.oldest_days)}>
                          {a.oldest ? `${day(a.oldest)} (${a.oldest_days} days)` : '—'}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            className="btn btn-sm"
                            onClick={() => setAccount(account === a.account_code ? '' : a.account_code)}
                          >
                            {account === a.account_code ? 'Show all' : 'Show only these'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="card">
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              {items.length} item{items.length === 1 ? '' : 's'}
              {account && <> in {account} — <button className="link-btn" onClick={() => setAccount('')}>show all</button></>}
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Bank date</th><th>Bank description</th><th>Reference</th>
                    <th>Holding account</th><th>Journal</th><th>Reconciliation</th>
                    <th>Posted by</th><th>Age</th><th style={{ textAlign: 'right' }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 && (
                    <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                      Nothing is parked here.
                    </td></tr>
                  )}
                  {items.map((r) => (
                    <tr key={r.journal_id}>
                      {/* The bank's own date, not the posting date -- it is what somebody will
                          quote when they go and ask the bank about the item. Falls back to the
                          posting date for an entry made outside a reconciliation. */}
                      <td>{day(r.bank_date) || day(r.posted_on)}</td>
                      <td>{r.bank_description || r.memo || '—'}</td>
                      <td>{r.bank_reference || '—'}</td>
                      <td>{r.account_code}</td>
                      <td>{r.journal_no || '—'}</td>
                      <td>
                        {r.reconciliation_id ? (
                          <Link to={`/accounting/bank-reconciliation/${r.reconciliation_id}`}>
                            {r.recon_no || `#${r.reconciliation_id}`}
                          </Link>
                        ) : '—'}
                        {r.bank_account_name && <div className="muted" style={{ fontSize: 11 }}>{r.bank_account_name}</div>}
                      </td>
                      <td>{r.posted_by || '—'}</td>
                      <td style={ageStyle(r.age_days)}>{r.age_days} days</td>
                      <td style={{ textAlign: 'right' }}>{money(Math.abs(Number(r.amount)))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
