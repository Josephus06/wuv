import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import Modal from '../../components/Modal';
import { useAuth } from '../../context/useAuth';

// Working a bank reconciliation: import the statement, review what the system matched each line
// to, and reconcile.
//
// The screen is built around the one rule that matters: NOTHING IS CLEARED UNTIL SOMEBODY SAYS
// SO. Every proposed match arrives needing a decision, the counter at the top says how many are
// left, and Reconcile stays disabled until that reaches zero AND the difference is zero. The
// server refuses on both counts too -- this only decides what is worth offering.
const money = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (v) => (v ? String(v).slice(0, 10) : '');

// What the matcher is telling you about a proposal. The wording matters more than the colour:
// "one candidate" and "several candidates" say what the reviewer has to check.
const CONFIDENCE = {
  exact: { label: 'Cheque no. matches', className: 'badge-success' },
  // Matched on the cheque number alone, and the amounts disagree. The loudest thing on the screen,
  // because it is the one case where the match is certain and something is genuinely wrong.
  ref_amount_differs: { label: 'Cheque no. matches — AMOUNT DIFFERS', className: 'badge-danger' },
  strong: { label: 'Only candidate', className: 'badge-info' },
  weak: { label: 'Several candidates — check', className: 'badge-warning' },
  manual: { label: 'Matched by hand', className: 'badge-muted' },
};

const STATUS = {
  unmatched: { label: 'Needs a decision', className: 'badge-danger' },
  matched: { label: 'Awaiting review', className: 'badge-warning' },
  confirmed: { label: 'Confirmed', className: 'badge-success' },
  bank_only: { label: 'Bank charge', className: 'badge-info' },
  ignored: { label: 'Ignored', className: 'badge-muted' },
};

export default function BankReconciliationView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [tab, setTab] = useState('review');
  const [importing, setImporting] = useState(false);
  const [matchFor, setMatchFor] = useState(null);
  const [bankOnlyFor, setBankOnlyFor] = useState(null);
  const [accounts, setAccounts] = useState([]);

  const load = useCallback(() => api.get(`/bank-reconciliation/${id}`).then(({ data: d }) => {
    setData(d);
    setLoading(false);
  }), [id]);

  useEffect(() => {
    load().catch((e) => { setError(e.response?.data?.error || 'Could not load this.'); setLoading(false); });
  }, [load]);
  useEffect(() => {
    api.get('/lookups/chart-of-accounts').then(({ data: d }) => setAccounts(d)).catch(() => {});
  }, []);

  async function act(fn, message) {
    setBusy(true); setError(''); setNote('');
    try {
      await fn();
      await load();
      if (message) setNote(message);
    } catch (e) {
      setError(e.response?.data?.error || 'That did not go through.');
    } finally { setBusy(false); }
  }

  // The confirmation names what is actually lost -- the imported statement and the review done so
  // far -- because "delete this reconciliation" does not convey that somebody's afternoon of
  // ticking goes with it. What it does NOT lose is any document: those are released, not deleted.
  async function remove() {
    const reviewed = data.lines.filter((l) => l.status === 'confirmed' || l.status === 'bank_only').length;
    const detail = data.lines.length
      ? `\n\nIts ${data.lines.length} imported statement line(s)${reviewed ? ` and ${reviewed} confirmed match(es)` : ''} go with it, and the documents it had claimed go back to outstanding.`
      : '';
    if (!confirm(`Delete ${data.recon_no}?${detail}\n\nThis cannot be undone.`)) return;
    setBusy(true); setError('');
    try {
      await api.delete(`/bank-reconciliation/${id}`);
      navigate('/accounting/bank-reconciliation');
    } catch (e) {
      setError(e.response?.data?.error || 'Could not delete that.');
      setBusy(false);
    }
  }

  if (loading) return <LoadingSpinner />;
  if (!data) return <div className="error-banner">{error || 'Not found.'}</div>;

  const open = data.status === 'open';
  const s = data.summary;
  const mayReview = open && can('/accounting/bank-reconciliation', 'can_edit');
  const canFinish = open && data.lines.length > 0 && data.awaiting_review === 0 && s.balanced;

  const confirmedCount = data.lines.filter((l) => l.status === 'confirmed').length;
  const bankOnlyCount = data.lines.filter((l) => l.status === 'bank_only').length;

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn btn-sm" to={'/accounting/bank-reconciliation'}>Back</Link>
          {can('/accounting/bank-reconciliation', 'can_print') && (
            <a className="btn btn-sm" href={`/api/bank-reconciliation/${id}/export`}
              onClick={(e) => { e.preventDefault(); downloadExport(id, setError); }}>Export</a>
          )}
          {open && can('/accounting/bank-reconciliation', 'can_add') && (
            <button className="btn btn-sm" onClick={() => setImporting(true)}>
              {data.lines.length ? 'Re-import Statement' : 'Import Statement'}
            </button>
          )}
          {mayReview && data.lines.length > 0 && (
            <button className="btn btn-sm" disabled={busy}
              onClick={() => act(() => api.post(`/bank-reconciliation/${id}/rematch`), 'Re-matched.')}>
              Re-run Matching
            </button>
          )}
          {open && can('/accounting/bank-reconciliation', 'can_approve') && (
            <button className="btn btn-sm btn-success" disabled={busy || !canFinish}
              title={canFinish ? '' : 'Every line must be reviewed and the difference must be zero'}
              onClick={() => act(() => api.post(`/bank-reconciliation/${id}/reconcile`), 'Reconciled.')}>
              Reconcile
            </button>
          )}
          {!open && can('/accounting/bank-reconciliation', 'can_approve') && (
            <button className="btn btn-sm btn-warning" disabled={busy}
              onClick={() => act(() => api.post(`/bank-reconciliation/${id}/reopen`), 'Reopened.')}>Reopen</button>
          )}
          {/* Only while open -- a finished reconciliation has to be reopened first, which the
              server enforces too. Deleting releases every document it had claimed, so a false
              start does not hold cheques hostage on a reconciliation nobody is working. */}
          {open && can('/accounting/bank-reconciliation', 'can_delete') && (
            <button className="btn btn-sm btn-danger" disabled={busy} onClick={remove}>Delete</button>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {note && <div className="muted" style={{ marginBottom: 8 }}>{note}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>{data.account_code} {data.account_name}</h1>
          <span className="estimate-no">{data.recon_no}</span>
        </div>
        <div className="estimate-status">
          <span className={`badge ${data.status === 'reconciled' ? 'badge-success' : 'badge-warning'}`}>
            {data.status === 'reconciled' ? 'Reconciled' : 'Open'}
          </span>
        </div>
      </div>

      {/* The reconciliation itself, always on screen. Everything below is the work of getting this
          difference to zero, so it is not hidden behind a tab. */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="table-wrap">
          <table>
            <tbody>
              <tr><td>Balance per bank statement, {day(data.statement_date)}</td>
                <td style={{ textAlign: 'right' }}>{money(s.statement_balance)}</td></tr>
              <tr><td>Add: deposits in transit</td>
                <td style={{ textAlign: 'right' }}>{money(s.deposits_in_transit)}</td></tr>
              <tr><td>Less: outstanding cheques and payments</td>
                <td style={{ textAlign: 'right' }}>({money(s.outstanding_payments)})</td></tr>
              <tr style={{ fontWeight: 700 }}><td>Adjusted bank balance</td>
                <td style={{ textAlign: 'right' }}>{money(s.adjusted_bank_balance)}</td></tr>
              <tr style={{ fontWeight: 700 }}><td>Balance per book</td>
                <td style={{ textAlign: 'right' }}>{money(s.book_balance)}</td></tr>
              <tr style={{ fontWeight: 700, color: s.balanced ? 'var(--success, #15803d)' : 'var(--danger, #b91c1c)' }}>
                <td>Difference</td>
                <td style={{ textAlign: 'right' }}>{money(s.difference)}</td></tr>
            </tbody>
          </table>
        </div>
        {open && (
          <div className="muted" style={{ marginTop: 10 }}>
            {data.lines.length === 0 ? 'Import the statement to begin.'
              : data.awaiting_review > 0
                ? `${data.awaiting_review} statement line(s) still need a decision.`
                : s.balanced ? 'Every line reviewed and the difference is zero — ready to reconcile.'
                  : 'Every line reviewed, but the difference is not zero yet.'}
          </div>
        )}
      </div>

      <div className="status-tabs" style={{ marginTop: 16 }}>
        <button className={`status-tab ${tab === 'review' ? 'active' : ''}`} onClick={() => setTab('review')}>
          Statement ({data.lines.length})
        </button>
        <button className={`status-tab ${tab === 'outstanding' ? 'active' : ''}`} onClick={() => setTab('outstanding')}>
          Outstanding ({data.outstanding.length})
        </button>
      </div>

      {tab === 'review' && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="muted" style={{ marginBottom: 8 }}>
            {confirmedCount} confirmed · {bankOnlyCount} bank charges · {data.awaiting_review} to go
          </div>
          <div className="table-wrap" style={{ maxHeight: 520, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Statement line</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                  <th>Matched to</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.lines.length === 0 && (
                  <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    No statement imported yet.
                  </td></tr>
                )}
                {data.lines.map((l) => {
                  const conf = l.match ? (CONFIDENCE[l.match.confidence] || CONFIDENCE.manual) : null;
                  const st = STATUS[l.status] || STATUS.unmatched;
                  return (
                    <tr key={l.id}>
                      <td>{day(l.txn_date)}</td>
                      <td>
                        <div>{l.description || <span className="muted">—</span>}</div>
                        {l.reference && <div className="muted" style={{ fontSize: 11 }}>Ref {l.reference}</div>}
                      </td>
                      <td style={{ textAlign: 'right', color: Number(l.amount) < 0 ? 'var(--danger, #b91c1c)' : undefined }}>
                        {money(l.amount)}
                      </td>
                      <td>
                        {l.match?.document ? (
                          <>
                            <div>{l.match.document.doc_no} <span className="muted">{l.match.document.party || ''}</span></div>
                            <div style={{ marginTop: 2 }}>
                              <span className={`badge ${conf.className}`} style={{ fontSize: 10 }}>{conf.label}</span>
                            </div>
                            {/* Both figures, side by side, when they disagree. Saying only "amount
                                differs" would send somebody to another screen to find out by how
                                much -- and by how much is the whole question. */}
                            {l.match.confidence === 'ref_amount_differs' && (
                              <div style={{ fontSize: 11, color: 'var(--danger, #b91c1c)', marginTop: 2 }}>
                                Bank {money(l.amount)} vs document {money(l.match.document.amount)}
                                {' '}(off by {money(Math.abs(Number(l.amount) - Number(l.match.document.amount)))})
                              </div>
                            )}
                          </>
                        ) : l.status === 'bank_only' ? (
                          <>
                            <span className="muted">{l.note || 'Bank charge / interest'}</span>
                            {/* What it actually wrote. A line that posts to the ledger should say
                                so on the row, not only inside the dialog that posted it. */}
                            {l.posted_journal_no && (
                              <div className="muted" style={{ fontSize: 12 }}>
                                Posted {l.posted_journal_no}
                                {l.bank_only_account_name ? ` to ${l.bank_only_account_name}` : ''}
                              </div>
                            )}
                          </>
                        ) : <span className="muted">—</span>}
                      </td>
                      <td><span className={`badge ${st.className}`}>{st.label}</span></td>
                      <td>
                        {mayReview && (
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            {l.status === 'matched' && (
                              <button className="btn btn-sm btn-success" disabled={busy}
                                onClick={() => act(() => api.post(`/bank-reconciliation/${id}/lines/${l.id}/confirm`))}>
                                Confirm
                              </button>
                            )}
                            {(l.status === 'matched' || l.status === 'confirmed') && (
                              <button className="btn btn-sm" disabled={busy}
                                onClick={() => act(() => api.post(`/bank-reconciliation/${id}/lines/${l.id}/reject`))}>
                                Unmatch
                              </button>
                            )}
                            {l.status !== 'confirmed' && (
                              <button className="btn btn-sm" disabled={busy} onClick={() => setMatchFor(l)}>Find</button>
                            )}
                            {l.status !== 'bank_only' && (
                              <button className="btn btn-sm" disabled={busy} onClick={() => setBankOnlyFor(l)}>Bank charge</button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'outstanding' && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="muted" style={{ marginBottom: 8 }}>
            Documents in the book that this statement does not show — deposits not yet credited and
            cheques not yet presented. These are what reconcile the two balances above.
          </div>
          <div className="table-wrap" style={{ maxHeight: 520, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr><th>Date</th><th>Document</th><th>Reference</th><th>Payee / Memo</th><th style={{ textAlign: 'right' }}>Amount</th></tr>
              </thead>
              <tbody>
                {data.outstanding.length === 0 && (
                  <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>Nothing outstanding.</td></tr>
                )}
                {data.outstanding.slice(0, 500).map((m) => (
                  <tr key={`${m.source_kind}:${m.source_id}`}>
                    <td>{day(m.txn_date)}</td>
                    <td>{m.doc_no}</td>
                    <td>{m.reference || ''}</td>
                    <td>{m.party || m.memo || ''}</td>
                    <td style={{ textAlign: 'right' }}>{money(m.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.outstanding.length > 500 && (
            <div className="muted" style={{ marginTop: 8 }}>
              Showing the first 500 of {data.outstanding.length}. The full list is in the Export.
            </div>
          )}
        </div>
      )}

      {importing && (
        <ImportStatement
          reconciliationId={id}
          onClose={() => setImporting(false)}
          onDone={async (result) => {
            setImporting(false);
            await load();
            setNote(`Imported ${result.imported} lines — ${result.proposed} matched automatically, ${result.unmatched} need a decision.`);
          }}
        />
      )}

      {matchFor && (
        <FindDocument
          line={matchFor}
          movements={data.outstanding}
          onClose={() => setMatchFor(null)}
          onPick={async (m) => {
            setMatchFor(null);
            await act(() => api.post(`/bank-reconciliation/${id}/lines/${matchFor.id}/match`,
              { source_kind: m.source_kind, source_id: m.source_id }), 'Matched.');
          }}
        />
      )}

      {bankOnlyFor && (
        <BankOnly
          line={bankOnlyFor}
          bankAccountName={data.account_name}
          accounts={accounts}
          onClose={() => setBankOnlyFor(null)}
          // Returns the refusal to the dialog instead of closing first. This posts to the general
          // ledger and can be refused -- a closed period, a missing right -- and the page banner is
          // at the top, which on a 194-line statement is nowhere near the row being worked. Closing
          // on failure made a refused post look like nothing happening at all.
          onSave={async (body) => {
            try {
              await api.post(`/bank-reconciliation/${id}/lines/${bankOnlyFor.id}/bank-only`, body);
            } catch (e) {
              return e.response?.data?.error || 'That did not go through.';
            }
            setBankOnlyFor(null);
            await act(() => Promise.resolve(), 'Posted, and the line is accounted for.');
            return null;
          }}
        />
      )}
    </div>
  );
}

// Downloaded through the API client so the request carries the auth header -- a bare href would be
// an unauthenticated GET.
async function downloadExport(id, setError) {
  try {
    const res = await api.get(`/bank-reconciliation/${id}/export`, { responseType: 'blob' });
    const url = URL.createObjectURL(new Blob([res.data]));
    const a = document.createElement('a');
    a.href = url;
    const named = /filename="?([^";]+)"?/.exec(res.headers['content-disposition'] || '');
    a.download = named ? named[1] : 'bank-reconciliation.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    setError('Could not download that.');
  }
}

// Import in two steps: read the file and SHOW it, then say which column means what. No bank format
// is assumed -- these accounts span five banks and no two of their exports agree.
function ImportStatement({ reconciliationId, onClose, onDone }) {
  const fileRef = useRef(null);
  const [preview, setPreview] = useState(null);
  const [payload, setPayload] = useState(null);
  const [skip, setSkip] = useState(1);
  const [twoColumns, setTwoColumns] = useState(true);
  const [map, setMap] = useState({ date: '', description: '', reference: '', amount: '', debit: '', credit: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function choose(file) {
    if (!file) return;
    setBusy(true); setError('');
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read that file'));
        reader.readAsDataURL(file);
      });
      const { data: p } = await api.post('/bank-reconciliation/preview', { data, file_name: file.name });
      setPreview(p);
      setPayload({ data, file_name: file.name });
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Could not read that file.');
    } finally { setBusy(false); }
  }

  async function run() {
    setBusy(true); setError('');
    try {
      const mapping = { date: map.date, description: map.description, reference: map.reference };
      if (twoColumns) { mapping.debit = map.debit; mapping.credit = map.credit; }
      else mapping.amount = map.amount;
      const { data } = await api.post(`/bank-reconciliation/${reconciliationId}/import`,
        { ...payload, skip_rows: Number(skip) || 0, mapping });
      onDone(data);
    } catch (e) {
      setError(e.response?.data?.error || 'Import failed.');
      setBusy(false);
    }
  }

  const columnOptions = Array.from({ length: preview?.columns || 0 }, (_, i) => i);
  const colLabel = (i) => {
    const head = preview?.rows?.[0]?.[i];
    return head ? `${i + 1} — ${String(head).slice(0, 24)}` : `Column ${i + 1}`;
  };

  return (
    <Modal title="Import Bank Statement" onClose={onClose} large>
      {error && <div className="error-banner">{error}</div>}

      {!preview ? (
        <div className="field">
          <label>Statement file</label>
          <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" disabled={busy}
            onChange={(e) => choose(e.target.files?.[0])} />
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            CSV or Excel, as the bank exports it. You choose which column means what on the next step,
            so no particular layout is required.
          </div>
        </div>
      ) : (
        <>
          <div className="muted" style={{ marginBottom: 8 }}>
            {payload.file_name} — {preview.total_rows} rows, {preview.columns} columns.
          </div>
          <div className="table-wrap" style={{ maxHeight: 200, overflow: 'auto', marginBottom: 12 }}>
            <table>
              <tbody>
                {preview.rows.map((row, i) => (
                  <tr key={i} style={{ opacity: i < skip ? 0.45 : 1 }}>
                    <td className="muted" style={{ width: 30 }}>{i + 1}</td>
                    {columnOptions.map((c) => <td key={c} style={{ whiteSpace: 'nowrap' }}>{String(row[c] ?? '')}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="field-row">
            <div className="field">
              <label>Header rows to skip</label>
              <input type="number" min="0" value={skip} onChange={(e) => setSkip(e.target.value)} />
            </div>
            <div className="field">
              <label>Date column</label>
              <select value={map.date} onChange={(e) => setMap({ ...map, date: e.target.value })}>
                <option value="">—</option>
                {columnOptions.map((c) => <option key={c} value={c}>{colLabel(c)}</option>)}
              </select>
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>Description column</label>
              <select value={map.description} onChange={(e) => setMap({ ...map, description: e.target.value })}>
                <option value="">—</option>
                {columnOptions.map((c) => <option key={c} value={c}>{colLabel(c)}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Reference / cheque no. column</label>
              <select value={map.reference} onChange={(e) => setMap({ ...map, reference: e.target.value })}>
                <option value="">—</option>
                {columnOptions.map((c) => <option key={c} value={c}>{colLabel(c)}</option>)}
              </select>
              {/* Worth saying: this column is what turns a guess into a certainty. */}
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                Optional, but it is what lets a cheque be matched by its number rather than by amount alone.
              </div>
            </div>
          </div>

          <div className="field-checkbox">
            <input type="checkbox" id="two-col" checked={twoColumns} onChange={(e) => setTwoColumns(e.target.checked)} />
            <label htmlFor="two-col">The statement has separate Debit and Credit columns</label>
          </div>

          {twoColumns ? (
            <div className="field-row">
              <div className="field">
                <label>Debit (money out)</label>
                <select value={map.debit} onChange={(e) => setMap({ ...map, debit: e.target.value })}>
                  <option value="">—</option>
                  {columnOptions.map((c) => <option key={c} value={c}>{colLabel(c)}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Credit (money in)</label>
                <select value={map.credit} onChange={(e) => setMap({ ...map, credit: e.target.value })}>
                  <option value="">—</option>
                  {columnOptions.map((c) => <option key={c} value={c}>{colLabel(c)}</option>)}
                </select>
              </div>
            </div>
          ) : (
            <div className="field">
              <label>Amount (negative for money out)</label>
              <select value={map.amount} onChange={(e) => setMap({ ...map, amount: e.target.value })}>
                <option value="">—</option>
                {columnOptions.map((c) => <option key={c} value={c}>{colLabel(c)}</option>)}
              </select>
            </div>
          )}
        </>
      )}

      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        {preview && (
          <button className="btn btn-primary" disabled={busy || map.date === '' || (twoColumns ? (map.debit === '' && map.credit === '') : map.amount === '')}
            onClick={run}>
            {busy ? 'Importing…' : 'Import and Match'}
          </button>
        )}
      </div>
    </Modal>
  );
}

// Matching a line by hand. Defaults to documents of the same amount, because that is nearly always
// what it is -- but the whole outstanding list is searchable for the times it is not.
function FindDocument({ line, movements, onClose, onPick }) {
  const [search, setSearch] = useState('');
  const [sameAmountOnly, setSameAmountOnly] = useState(true);

  const cents = (v) => Math.round(Number(v || 0) * 100);
  const terms = search.trim().toLowerCase();
  const shown = movements.filter((m) => {
    if (sameAmountOnly && cents(m.amount) !== cents(line.amount)) return false;
    if (!terms) return true;
    return `${m.doc_no} ${m.reference || ''} ${m.party || ''} ${m.memo || ''}`.toLowerCase().includes(terms);
  }).slice(0, 200);

  return (
    <Modal title={`Find the document for ${money(line.amount)}`} onClose={onClose} large>
      <div className="muted" style={{ marginBottom: 8 }}>
        {day(line.txn_date)} · {line.description || '—'} {line.reference ? `· Ref ${line.reference}` : ''}
      </div>
      <div className="field">
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Document no., cheque no., payee..." />
      </div>
      <div className="field-checkbox">
        <input type="checkbox" id="same-amt" checked={sameAmountOnly} onChange={(e) => setSameAmountOnly(e.target.checked)} />
        <label htmlFor="same-amt">Only documents for exactly this amount</label>
      </div>
      <div className="table-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
        <table>
          <thead><tr><th>Date</th><th>Document</th><th>Reference</th><th>Payee</th><th style={{ textAlign: 'right' }}>Amount</th><th></th></tr></thead>
          <tbody>
            {shown.length === 0 && (
              <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 16 }}>
                Nothing outstanding matches. Untick the amount filter, or mark the line as a bank charge.
              </td></tr>
            )}
            {shown.map((m) => (
              <tr key={`${m.source_kind}:${m.source_id}`}>
                <td>{day(m.txn_date)}</td>
                <td>{m.doc_no}</td>
                <td>{m.reference || ''}</td>
                <td>{m.party || m.memo || ''}</td>
                <td style={{ textAlign: 'right' }}>{money(m.amount)}</td>
                <td><button className="btn btn-sm btn-primary" onClick={() => onPick(m)}>Match</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

// A line the bank raised itself -- a charge, interest, a debit memo. It has no document because
// none was ever raised, so it is accounted for by naming where it belongs.
// The two accounts bank-only items are parked in, by direction: money the bank credited with no
// document goes to Deposit, money it took goes to Disbursement. Preselected rather than left blank
// because the direction is not a judgement -- the statement already says which it is -- and the
// operator is still free to pick a real account when the item IS identified.
const PARKING_CODE = { in: '23100', out: '23200' };

function BankOnly({ line, accounts, bankAccountName, onClose, onSave }) {
  const parking = accounts.find(
    (a) => a.account_code === PARKING_CODE[Number(line.amount) > 0 ? 'in' : 'out'],
  );
  const [accountId, setAccountId] = useState(parking ? String(parking.id) : '');
  const [note, setNote] = useState(line.description || '');
  // The date the entry is posted on, which is an accounting decision rather than something to
  // guess. It defaults to the day the bank moved the money, but a statement being worked months
  // late will have lines in periods that are closed -- and the answer then is to post it in an
  // open one, not to silently fail or to force the period open.
  const [postDate, setPostDate] = useState(day(line.txn_date));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const moneyIn = Number(line.amount) > 0;
  const bankName = bankAccountName || 'the bank account';
  const chosen = accounts.find((a) => String(a.id) === String(accountId));

  async function submit() {
    setSaving(true);
    setError('');
    const message = await onSave({ account_id: accountId, note, post_date: postDate });
    if (message) { setError(message); setSaving(false); }
  }
  return (
    <Modal title="Record a bank-only item" onClose={onClose}>
      <div className="muted" style={{ marginBottom: 10 }}>
        {day(line.txn_date)} · {money(line.amount)} · {line.description || '—'}
      </div>
      {/* Said plainly, because this writes to the general ledger. It used to only tag the line,
          which cleared the review gate and then left the reconciliation unable to balance. */}
      <div className="muted" style={{ marginBottom: 12 }}>
        This posts a journal entry — it is what puts the item in the book, so the two balance.
      </div>
      <div className="field">
        <label>Post to</label>
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">—</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.account_code} {a.account_name}</option>)}
        </select>
      </div>
      {/* The entry spelled out before it is written, so a wrong account is caught here rather than
          in the ledger afterwards. */}
      {chosen && (
        <div className="muted" style={{ marginBottom: 12, fontSize: 13 }}>
          {moneyIn
            ? <>Debit <strong>{bankName}</strong> {money(Math.abs(line.amount))}, credit <strong>{chosen.account_name}</strong> {money(Math.abs(line.amount))}.</>
            : <>Debit <strong>{chosen.account_name}</strong> {money(Math.abs(line.amount))}, credit <strong>{bankName}</strong> {money(Math.abs(line.amount))}.</>}
        </div>
      )}
      <div className="field">
        <label>Post on</label>
        <input type="date" value={postDate} onChange={(e) => { setPostDate(e.target.value); setError(''); }} />
        {postDate !== day(line.txn_date) && (
          <small className="muted">
            The bank moved it on {day(line.txn_date)}; the entry will be dated {postDate}.
          </small>
        )}
      </div>
      <div className="field">
        <label>Note</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {/* Shown here rather than at the top of the page: a refusal belongs next to the thing that
          was refused, not 190 rows above it. */}
      {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="modal-actions">
        <button className="btn" disabled={saving} onClick={onClose}>Cancel</button>
        <button
          className="btn btn-primary"
          disabled={!accountId || !postDate || saving}
          title={accountId ? undefined : 'Choose the account this belongs to'}
          onClick={submit}
        >
          {saving ? 'Posting…' : 'Post and mark'}
        </button>
      </div>
    </Modal>
  );
}
