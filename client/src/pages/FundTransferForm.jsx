import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

function money(v) { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'; }
function today() { return new Date().toISOString().slice(0, 10); }

// Create or edit a Fund Transfer: move an amount from one bank account to another. GL: DR To / CR From.
export default function FundTransferForm() {
  const navigate = useNavigate();
  const { id } = useParams(); // set when editing (/fund-transfers/:id/edit)
  // ?ftr=<form id>: Create Fund Transfer Voucher on an approved Fund Transfer Request (2026-10-14).
  // Starts filled from it -- its banks and what is left to post -- and is saved against it.
  const [searchParams] = useSearchParams();
  const ftrId = id ? null : Number(searchParams.get('ftr')) || null;
  const [ftrNo, setFtrNo] = useState('');
  const [meta, setMeta] = useState(null);
  const [ftNo, setFtNo] = useState('');
  const [header, setHeader] = useState({ date_created: today(), from_account_id: '', to_account_id: '', amount: '', memo: '', office_location_id: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.get('/fund-transfers/meta'), id ? api.get(`/fund-transfers/${id}`) : null,
      ftrId ? api.get(`/forms/${ftrId}`) : null])
      .then(([m, ft, fr]) => {
        setMeta(m.data);
        if (fr) {
          const f = fr.data;
          const d = f.detail || {};
          const items = (f.items || []).filter((it) => Number(it.amount) !== 0);
          const first = items[0] || {};
          setFtrNo(f.request_no);
          setHeader((h) => ({
            ...h,
            from_account_id: d.from_account_id || first.from_account_id || '',
            to_account_id: d.to_account_id || first.to_account_id || '',
            amount: Number(f.voucher_remaining) || Number(d.total_amount) || '',
            memo: [f.request_no, ...items.map((it) => it.particulars).filter(Boolean)].join(' -- ').slice(0, 1000),
          }));
        }
        if (ft) {
          const d = ft.data;
          setFtNo(d.ft_no);
          setHeader({
            date_created: String(d.date_created || '').slice(0, 10), from_account_id: d.from_account_id || '',
            to_account_id: d.to_account_id || '', amount: d.amount ?? '', memo: d.memo || '',
            office_location_id: d.office_location_id || '',
          });
        }
        setLoading(false);
      })
      .catch((e) => { setError(e.response?.data?.error || 'Failed to load.'); setLoading(false); });
  }, [id, ftrId]);

  const setH = (patch) => setHeader((h) => ({ ...h, ...patch }));
  const acct = (id) => (meta?.accounts || []).find((a) => String(a.id) === String(id));
  const amt = Number(header.amount) || 0;

  async function save() {
    setError('');
    if (!header.from_account_id || !header.to_account_id) { setError('Select both a From and a To account.'); return; }
    if (String(header.from_account_id) === String(header.to_account_id)) { setError('From and To accounts must be different.'); return; }
    if (amt <= 0) { setError('Enter an amount greater than 0.'); return; }
    setSaving(true);
    try {
      const { data } = id
        ? await api.put(`/fund-transfers/${id}`, { ...header, amount: amt })
        : await api.post('/fund-transfers', { ...header, amount: amt, ...(ftrId ? { form_request_id: ftrId } : {}) });
      navigate(`/fund-transfers/${data.id}`);
    } catch (e) { setError(e.response?.data?.error || 'Save failed.'); setSaving(false); }
  }

  if (loading) return <LoadingSpinner />;
  if (!meta) return <div className="error-banner">{error || 'Failed to load.'}</div>;
  const from = acct(header.from_account_id);
  const to = acct(header.to_account_id);

  return (
    <div>
      <div className="page-header">
        <div style={{ fontWeight: 600 }}>Fund Transfer <span className="muted">/ {id ? `Edit ${ftNo}` : ftrNo ? `Create from ${ftrNo}` : 'Create'}</span></div>
        <div style={{ display: 'flex', gap: 8 }}>
          {id && <Link className="btn btn-sm" to={`/fund-transfers/${id}`}>Cancel</Link>}
          <Link className="btn btn-sm" to={'/fund-transfers'}>Back to Lists</Link>
          <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="field"><label>Date</label><input type="date" value={header.date_created} onChange={(e) => setH({ date_created: e.target.value })} /></div>
            <div className="field">
              <label>From Account</label>
              <EntityPicker label="From Account" items={meta.accounts} value={header.from_account_id} getLabel={(a) => `${a.account_code} — ${a.account_name}`}
                columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }]} searchKeys={['account_code', 'account_name']} placeholder="--Select--" onSelect={(a) => setH({ from_account_id: a?.id || '' })} />
            </div>
            <div className="field">
              <label>To Account</label>
              <EntityPicker label="To Account" items={meta.accounts} value={header.to_account_id} getLabel={(a) => `${a.account_code} — ${a.account_name}`}
                columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }]} searchKeys={['account_code', 'account_name']} placeholder="--Select--" onSelect={(a) => setH({ to_account_id: a?.id || '' })} />
            </div>
            <div className="field"><label>Amount</label><input type="number" step="0.01" value={header.amount} onChange={(e) => setH({ amount: e.target.value })} /></div>
            {/* The branch -- and so the company -- whose books this transfer belongs to. */}
            <div className="field">
              <label>Branch</label>
              <select value={header.office_location_id} onChange={(e) => setH({ office_location_id: e.target.value })}>
                <option value="">--Select--</option>
                {(meta.locations || []).map((l) => (
                  <option key={l.id} value={l.id}>{l.company_name ? `${l.company_name} — ` : ''}{l.location_name}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="field"><label>Memo</label><textarea rows={5} value={header.memo} onChange={(e) => setH({ memo: e.target.value })} /></div>
        </div>
      </div>

      <div className="card">
        <div className="status-tabs" style={{ marginBottom: 8 }}><button className="status-tab active">GL Impact</button></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Account Code</th><th>Account Title</th><th style={{ textAlign: 'right' }}>Debit</th><th style={{ textAlign: 'right' }}>Credit</th></tr></thead>
            <tbody>
              <tr><td>{to?.account_code || ''}</td><td>{to?.account_name || ''}</td><td style={{ textAlign: 'right' }}>{money(amt)}</td><td style={{ textAlign: 'right' }}>{money(0)}</td></tr>
              <tr><td>{from?.account_code || ''}</td><td>{from?.account_name || ''}</td><td style={{ textAlign: 'right' }}>{money(0)}</td><td style={{ textAlign: 'right' }}>{money(amt)}</td></tr>
            </tbody>
            <tfoot><tr style={{ fontWeight: 700 }}><td colSpan={2} style={{ textAlign: 'right' }}>Total</td><td style={{ textAlign: 'right' }}>{money(amt)}</td><td style={{ textAlign: 'right' }}>{money(amt)}</td></tr></tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}
