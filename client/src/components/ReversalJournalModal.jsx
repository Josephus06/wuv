import { useEffect, useState } from 'react';
import api from '../api/client';
import EntityPicker from './EntityPicker';
import LoadingSpinner from './LoadingSpinner';
import { displayDate } from '../utils/dates';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
}
function today() { return new Date().toISOString().slice(0, 10); }
function longDate(v) { return v ? displayDate(`${v}T00:00:00`) : ''; }

// Mirrors live's "Reversal Journal" popup, shown when a Sales Invoice is voided. Nothing is voided
// until Save: the table is the reversing entry the void will post (the invoice's own GL Impact,
// debits and credits swapped), read from GET /sales-invoices/:id/reversal-preview, which is built by
// the same code the void posts with. The user picks the reversal date, location and memo; each
// line's Department is the invoice's own and is shown, not chosen. PUT /sales-invoices/:id/cancel
// does the rest.
//
// Shared with Cheques (2026-10-08): pass previewPath / voidPath (and docLabel) for any document whose
// server answers the same way -- GET preview { doc_no, doc_date, location, rows[] } and PUT void
// { reversal_date, location_id, memo }. A row may carry its own department_name (a cheque's lines
// each have one); otherwise the document's department is shown on every line.
export default function ReversalJournalModal({ invoiceId, previewPath, voidPath, docLabel = 'invoice', onClose, onSaved }) {
  const previewUrl = previewPath || `/sales-invoices/${invoiceId}/reversal-preview`;
  const voidUrl = voidPath || `/sales-invoices/${invoiceId}/cancel`;
  const [preview, setPreview] = useState(null);
  const [date, setDate] = useState(today());
  const [location, setLocation] = useState(null);
  const [memo, setMemo] = useState('');
  const [locations, setLocations] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const pick = (d) => (Array.isArray(d) ? d : (d?.rows || []));
    Promise.all([
      api.get(previewUrl),
      api.get('/lookups/locations'),
    ]).then(([p, l]) => {
      setPreview(p.data);
      setLocation(p.data.location);
      setLocations(pick(l.data));
    }).catch((e) => setError(e.response?.data?.error || 'Could not load the reversal.'));
  }, [previewUrl]);

  async function save() {
    setError('');
    if (!date) { setError('Date is required.'); return; }
    if (!location) { setError('Location is required.'); return; }
    setSaving(true);
    try {
      const { data } = await api.put(voidUrl, {
        reversal_date: date, location_id: location.id, memo,
      });
      onSaved(data);
    } catch (e) {
      setError(e.response?.data?.error || 'Void failed.');
      setSaving(false);
    }
  }

  const rows = preview?.rows || [];
  const docNo = preview?.doc_no || preview?.invoice_no;
  const docDate = preview?.doc_date || preview?.invoice_date;
  const totalDebit = rows.reduce((s, r) => s + Number(r.debit || 0), 0);
  const totalCredit = rows.reduce((s, r) => s + Number(r.credit || 0), 0);

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <div className="modal modal-xl" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="estimate-banner" style={{ borderRadius: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <h2 style={{ margin: 0, color: '#fff' }}>Reversal Journal</h2>
          <button type="button" onClick={onClose} disabled={saving} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 24, lineHeight: 1, cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ padding: 24 }}>
          {error && <div className="error-banner">{error}</div>}
          {!preview ? (!error && <LoadingSpinner />) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                <div>
                  <div className="field">
                    <label>Date <span className="req">*</span></label>
                    <input type="date" value={date} min={String(docDate || '').slice(0, 10) || undefined} onChange={(e) => setDate(e.target.value)} />
                  </div>
                  <div>Reversal # : <span className="hi">{docNo}</span></div>
                  <div>Reversal Date : <span className="hi">{longDate(date)}</span></div>
                </div>
                <div>
                  <div className="field">
                    <label>Location <span className="req">*</span></label>
                    <EntityPicker
                      label="Location" items={locations} value={location?.id || ''} getLabel={(l) => l.location_name || l.name}
                      columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']}
                      onSelect={(l) => setLocation(l ? { id: l.id, location_name: l.location_name || l.name } : null)}
                    />
                  </div>
                  <div className="field"><label>Memo</label><textarea rows={2} value={memo} onChange={(e) => setMemo(e.target.value)} /></div>
                </div>
              </div>

              <div className="status-tabs" style={{ marginTop: 16 }}><button type="button" className="status-tab active">GL Impact</button></div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Account Code</th><th>Account Title</th><th>Department</th><th>Memo</th><th style={{ textAlign: 'right' }}>Debit</th><th style={{ textAlign: 'right' }}>Credit</th></tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>This {docLabel} posted nothing, so there is nothing to reverse.</td></tr>}
                    {rows.map((r, i) => (
                      <tr key={i}>
                        <td>{r.account_code}</td>
                        <td>{r.account_name}</td>
                        {/* The line's own department where it has one (a cheque's expense lines), else the
                            document's, on every line. "—" when there is none. */}
                        <td>{r.department_name || preview.department?.name || '—'}</td>
                        <td>Voided from {docNo}</td>
                        <td style={{ textAlign: 'right' }}>{money(r.debit)}</td>
                        <td style={{ textAlign: 'right' }}>{money(r.credit)}</td>
                      </tr>
                    ))}
                  </tbody>
                  {rows.length > 0 && (
                    <tfoot><tr style={{ fontWeight: 700 }}><td colSpan={4} style={{ textAlign: 'right' }}>Total</td>
                      <td style={{ textAlign: 'right' }}>{money(totalDebit)}</td><td style={{ textAlign: 'right' }}>{money(totalCredit)}</td></tr></tfoot>
                  )}
                </table>
              </div>

              <div className="modal-actions">
                <button type="button" className="btn" disabled={saving} onClick={onClose}>Cancel</button>
                <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
                  {saving ? <LoadingSpinner inline size="sm" label="Voiding..." /> : 'Save'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
