import { rate6 } from '../utils/rate';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
const round2 = (n) => Math.round(n * 100) / 100;
const day = (v) => (v ? String(v).slice(0, 10) : '');
// Date Due = Date + the term's days, on the calendar date (UTC arithmetic, so no timezone shift).
const addDays = (d, n) => { if (!d) return ''; const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const termKey = (s) => String(s || '').trim().toLowerCase().replace(/s+/g, ' ');
// Preview of the server's arithmetic. Each line carries its Amount (net of VAT): it starts at the
// stored figure, follows Qty / Unit Price / Discount when those are edited, and can be typed --
// Unit Price then follows it. The server keeps a sent Amount exactly.
function amountOf(l) {
  const sub = Number(l.qty || 0) * Number(l.unit_price || 0);
  return round2(sub - sub * (Number(l.disc_percent || 0) / 100));
}
function lineAmounts(l, taxRate, wtaxRate) {
  const net = round2(Number(l.amount || 0));
  // A typed Tax Amount (tax_typed) stands; otherwise Net x the tax code's rate.
  const taxTyped = l.tax_typed !== undefined && l.tax_typed !== '';
  const tax = taxTyped ? round2(Number(l.tax_typed)) : round2(net * (Number(taxRate || 0) / 100));
  const gross = round2(net + tax);
  // A typed withholding (wtax_typed) stands; otherwise Net x the bill's rate.
  const typed = l.wtax_typed !== undefined && l.wtax_typed !== '';
  const wtax = l.is_withhold ? (typed ? round2(Number(l.wtax_typed)) : round2(net * (Number(wtaxRate || 0) / 100))) : 0;
  return { net, tax, gross, wtax, due: round2(gross - wtax) };
}
const newKey = () => Math.random().toString(36).slice(2);

// Edit a saved Vendor Bill (/vendor-bills/:id/edit). The server decides what may change and says
// so through /edit-meta:
//   - details (dates, term, reference, location, memo) always;
//   - the money -- lines, withholding, and on an expense bill the vendor and payable account --
//     only while nothing is applied to the bill and it was raised in T1S. Otherwise the lines
//     are shown read-only with the reason.
// A PO bill keeps its items and quantities (they are what was received and billed off the PO);
// its prices, discounts, tax codes, departments and withholding may change. An expense bill's
// lines can be edited, added and removed freely.
export default function VendorBillEdit() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [vb, setVb] = useState(null);
  const [meta, setMeta] = useState(null);
  const [locations, setLocations] = useState([]);
  // Term is picked from Master Lists > Payment Terms (asked 2026-10-03); Date Due follows its days.
  const [paymentTerms, setPaymentTerms] = useState([]);
  const [moneyInfo, setMoneyInfo] = useState({ applied: 0, oldGl: false, lockReason: null });
  const [header, setHeader] = useState(null);
  const [supplier, setSupplier] = useState(null);
  const [apAccount, setApAccount] = useState(null);
  const [wtaxId, setWtaxId] = useState('');
  const [lines, setLines] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get(`/vendor-bills/${id}`), api.get(`/vendor-bills/${id}/edit-meta`),
      api.get('/vendor-bills/standalone-meta'), api.get('/lookups/locations'),
      api.get('/lookups/payment-terms').catch(() => ({ data: [] })),
    ]).then(([b, em, m, loc, pt]) => {
      setPaymentTerms((pt.data || []).filter((t) => t.is_active !== 0 && t.is_active !== false));
      const bill = b.data;
      setVb(bill); setMeta(m.data); setLocations(loc.data || []); setMoneyInfo({ applied: Number(em.data.applied_amount || 0), oldGl: !!em.data.old_system_gl, lockReason: em.data.money_lock_reason || null });
      setHeader({
        date_created: day(bill.date_created), date_due: day(bill.date_due), term: bill.term || '',
        reference_no: bill.reference_no || '', office_location_id: bill.office_location_id || '', memo: bill.memo || '',
      });
      setSupplier(m.data.suppliers.find((s) => s.id === bill.supplier_id) || (bill.supplier_id ? { id: bill.supplier_id, name: bill.supplier_name } : null));
      setApAccount(m.data.accounts.find((a) => a.id === bill.account_id) || null);
      // Bills from the old system often carry VAT and withholding as AMOUNTS with no code (22,026
      // lines, 12,849 bills). Re-pricing from a blank code would drop them, so the code is read back
      // off the amounts -- 5.36 on 44.64 is 12% (VAT12), 0.45 is 1% (WC 158) -- and shown, changeable.
      const rateOf = (part, whole) => (Number(whole) > 0 ? Math.round((Number(part) / Number(whole)) * 10000) / 100 : 0);
      const taxForRate = (r) => m.data.taxes.find((t) => Math.abs(Number(t.rate) - r) < 0.05);
      let wtaxGuess = bill.wtax_id ? String(bill.wtax_id) : '';
      if (!wtaxGuess && Number(bill.wtax_amount) > 0) {
        const base = bill.lines.filter((l) => l.is_withhold).reduce((s2, l) => s2 + Number(l.net_of_tax || 0), 0) || Number(bill.net_of_tax);
        const r = rateOf(bill.wtax_amount, base);
        const w = m.data.wtaxes.find((x) => Math.abs(Number(x.rate) - r) < 0.05);
        if (w) wtaxGuess = String(w.id);
      }
      setWtaxId(wtaxGuess);
      // A stored withholding that is not Net x rate (typed earlier, or the source's own) opens as typed,
      // so saving does not quietly recompute it.
      const guessRate = Number(m.data.wtaxes.find((w) => String(w.id) === wtaxGuess)?.rate || 0);
      const keepWtax = (l) => (l.is_withhold && Math.abs(Number(l.wtax_amount || 0) - round2(Number(l.net_of_tax || 0) * guessRate / 100)) > 0.01
        ? String(Number(l.wtax_amount || 0)) : undefined);
      // Likewise a stored Tax Amount that is not Net x its code's rate opens as typed.
      const keepTax = (l, taxCodeId) => {
        const r = Number(m.data.taxes.find((t) => String(t.id) === String(taxCodeId))?.rate || 0);
        return Math.abs(Number(l.tax_amount || 0) - round2(Number(l.net_of_tax || 0) * r / 100)) > 0.01 ? String(Number(l.tax_amount || 0)) : undefined;
      };
      const acctById = new Map(m.data.accounts.map((a) => [a.id, a]));
      setLines(bill.lines.map((l) => {
        const taxCodeId = l.tax_code_id ? String(l.tax_code_id)
          : (Number(l.tax_amount) > 0 ? String(taxForRate(rateOf(l.tax_amount, l.net_of_tax))?.id || '') : '');
        return {
          key: newKey(), id: l.id, item_code: l.item_code, item_name: l.item_name,
          account: l.account_id ? (acctById.get(l.account_id) || { id: l.account_id, account_code: l.line_account_code, account_name: l.line_account_name }) : null,
          description: l.description || '', department_id: l.department_id ? String(l.department_id) : '',
          qty: Number(l.qty), unit_price: Number(l.unit_price), disc_percent: Number(l.disc_percent || 0), amount: Number(l.net_of_tax || 0),
          tax_code_id: taxCodeId, tax_typed: keepTax(l, taxCodeId),
          is_withhold: !!l.is_withhold, wtax_typed: keepWtax(l),
        };
      }));
    }).catch((err) => setError(err.response?.data?.error || 'Could not load this Vendor Bill.'));
  }, [id]);

  if (!vb || !meta || !header) return error ? <div className="error-banner">{error}</div> : <LoadingSpinner />;

  const isItemBill = !!vb.purchase_order_id || vb.lines.some((l) => l.purchase_order_line_id || l.item_id);
  const moneyLocked = !!moneyInfo.lockReason;
  const taxRate = (tid) => Number((meta.taxes.find((t) => String(t.id) === String(tid)) || {}).rate || 0);
  const wtax = meta.wtaxes.find((w) => String(w.id) === String(wtaxId));
  const priced = lines.map((l) => ({ ...l, amt: lineAmounts(l, taxRate(l.tax_code_id), Number(wtax?.rate || 0)) }));
  const sum = (k) => priced.reduce((s, l) => s + l.amt[k], 0);
  const setH = (patch) => setHeader((h) => ({ ...h, ...patch }));
  // Qty / Unit Price / Discount move the Amount; a typed Amount moves Unit Price (Amount / Qty).
  const setLine = (key, patch) => setLines((ls) => ls.map((l) => {
    if (l.key !== key) return l;
    const next = { ...l, ...patch };
    if ('amount' in patch) {
      const q = Number(next.qty) || 0; const d = Number(next.disc_percent) || 0;
      const sub = d > 0 && d < 100 ? Number(patch.amount || 0) / (1 - d / 100) : Number(patch.amount || 0);
      next.unit_price = q > 0 ? Number((sub / q).toFixed(6)) : sub;
    } else if ('qty' in patch || 'unit_price' in patch || 'disc_percent' in patch) {
      next.amount = amountOf(next);
    }
    // A new amount puts the withholding back on Net x rate; a typed one is for the figure as it was.
    if (('amount' in patch || 'qty' in patch || 'unit_price' in patch || 'disc_percent' in patch) && !('wtax_typed' in patch)) next.wtax_typed = undefined;
    // So does the tax: a new amount or tax code puts it back on Net x rate.
    if (('amount' in patch || 'qty' in patch || 'unit_price' in patch || 'disc_percent' in patch || 'tax_code_id' in patch) && !('tax_typed' in patch)) next.tax_typed = undefined;
    return next;
  }));

  async function handleSave() {
    setError('');
    const body = { ...header };
    if (!moneyLocked) {
      if (!isItemBill && !supplier) { setError('Choose a vendor.'); return; }
      const noDept = lines.findIndex((l) => !l.department_id);
      if (noDept >= 0) { setError(`Choose a department on line ${noDept + 1}.`); return; }
      if (!isItemBill) {
        const noAcct = lines.findIndex((l) => !l.account);
        if (noAcct >= 0) { setError(`Choose an account on line ${noAcct + 1}.`); return; }
      }
      if (lines.some((l) => l.is_withhold) && !wtaxId) { setError('Choose the Withholding Tax for the lines ticked to withhold.'); return; }
      Object.assign(body, {
        wtax_id: wtaxId || null,
        supplier_id: supplier?.id || null,
        account_id: apAccount?.id || null,
        lines: lines.map((l) => ({
          id: l.id, account_id: l.account?.id || null, description: l.description, department_id: Number(l.department_id) || null,
          qty: Number(l.qty), unit_price: Number(l.unit_price || 0), disc_percent: Number(l.disc_percent || 0),
          tax_code_id: l.tax_code_id || null, is_withhold: l.is_withhold, amount: Number(l.amount || 0),
          tax_amount: l.tax_typed !== undefined && l.tax_typed !== '' ? Number(l.tax_typed) : undefined,
          wtax_amount: l.is_withhold && l.wtax_typed !== undefined && l.wtax_typed !== '' ? Number(l.wtax_typed) : undefined,
        })),
      });
    }
    setSaving(true);
    try {
      await api.put(`/vendor-bills/${id}`, body);
      navigate(`/vendor-bills/${id}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  const ro = moneyLocked;
  return (
    <div>
      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>Vendor Bill — Edit</h1>
          <span className="estimate-no">{vb.bill_no}</span>
        </div>
        {vb.po_no && <div style={{ opacity: 0.85 }}>From {vb.po_no}</div>}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {(moneyInfo.applied > 0 || moneyInfo.oldGl || moneyInfo.lockReason) && (
        <div className="error-banner" style={{ background: '#fff7e6', color: '#8a5a00', borderColor: '#f5d38a' }}>
          {moneyInfo.lockReason && <div><b>The amount of this bill cannot be changed:</b> {moneyInfo.lockReason}. Its dates, term, reference, location and memo can still be edited.</div>}
          {!moneyInfo.lockReason && moneyInfo.applied > 0 && <div>{money(moneyInfo.applied)} of this bill is already paid or credited -- the new total (net of withholding) cannot go below it; Amount Due becomes the new total less it.</div>}
          {moneyInfo.oldGl && <div>This bill came from the old system. If its amount changes, its old-system GL entries are replaced by entries computed from these lines.</div>}
        </div>
      )}

      <div className="card">
        <div className="review-grid" style={{ gridTemplateColumns: '1fr 1fr 280px' }}>
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="field"><label>Date</label><input type="date" value={header.date_created} onChange={(e) => {
                const t = paymentTerms.find((x) => termKey(x.term_name) === termKey(header.term));
                setH(t && e.target.value ? { date_created: e.target.value, date_due: addDays(e.target.value, Number(t.no_of_days) || 0) } : { date_created: e.target.value });
              }} /></div>
              <div className="field"><label>Date Due</label><input type="date" value={header.date_due} onChange={(e) => setH({ date_due: e.target.value })} /></div>
            </div>
            <div className="field">
              <label>Vendor</label>
              {isItemBill || ro
                ? <input value={vb.supplier_name || ''} disabled />
                : (
                  <EntityPicker
                    label="Vendor" items={meta.suppliers} value={supplier?.id || ''} getLabel={(s) => s.name}
                    columns={[{ key: 'name', label: 'Name' }, { key: 'supplier_code', label: 'Code' }, { key: 'tin', label: 'TIN' }]}
                    searchKeys={['name', 'supplier_code', 'tin']} placeholder={supplier?.name || 'Select Vendor...'} onSelect={setSupplier}
                  />
                )}
            </div>
            {/* Both kinds of bill: the payable credited on an expense bill, the debit offset on a PO bill. */}
            {(
              <div className="field">
                <label>Account</label>
                {ro
                  ? <input value={vb.account_name || ''} disabled />
                  : (
                    <EntityPicker
                      label="Account" items={meta.accounts} value={apAccount?.id || ''} getLabel={(a) => `${a.account_code} — ${a.account_name}`}
                      columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Account' }, { key: 'account_type', label: 'Type' }]}
                      searchKeys={['account_code', 'account_name']} onSelect={setApAccount}
                    />
                  )}
              </div>
            )}
            <div className="field"><label>Reference #</label><input value={header.reference_no} onChange={(e) => setH({ reference_no: e.target.value })} /></div>
          </div>
          <div>
            <div className="field">
              <label>Office Location</label>
              <select value={header.office_location_id} onChange={(e) => setH({ office_location_id: e.target.value })}>
                <option value="">--Select--</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.location_name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Term</label>
              <EntityPicker
                label="Term" items={paymentTerms}
                value={paymentTerms.find((t) => termKey(t.term_name) === termKey(header.term))?.id || ''}
                getLabel={(t) => t.term_name}
                columns={[{ key: 'term_name', label: 'Term' }, { key: 'no_of_days', label: 'Days', render: (t) => Number(t.no_of_days || 0) }]}
                searchKeys={['term_name']} placeholder={header.term || 'Select Term...'}
                onSelect={(t) => setH(t ? { term: t.term_name, date_due: addDays(header.date_created, Number(t.no_of_days) || 0) } : { term: '' })}
                onClear={() => setH({ term: '' })}
              />
            </div>
            <div className="field">
              <label>Withholding Tax</label>
              <select value={wtaxId} disabled={ro} onChange={(e) => { setWtaxId(e.target.value); setLines((ls) => ls.map((x) => ({ ...x, wtax_typed: undefined }))); }}>
                <option value="">None</option>
                {meta.wtaxes.map((w) => <option key={w.id} value={w.id}>{w.code} — {Number(w.rate)}% — {w.name}</option>)}
              </select>
            </div>
            <div className="field"><label>Memo</label><textarea rows={3} value={header.memo} onChange={(e) => setH({ memo: e.target.value })} /></div>
          </div>
          <div className="card" style={{ background: 'var(--surface-2, #f3f4f6)' }}>
            {(ro
              ? [['Net of Tax', vb.net_of_tax], ['Tax Amount', vb.tax_amount], ['Gross Amount', vb.gross_amount], ['Withholding Tax', vb.wtax_amount]]
              : [['Net of Tax', sum('net')], ['Tax Amount', sum('tax')], ['Gross Amount', sum('gross')], ['Withholding Tax', sum('wtax')]]
            ).map(([label, v]) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">{label}</span><span className="hi">{money(v)}</span></div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
              <span>{ro ? 'Amount Due' : 'Total Due'}</span><span>{money(ro ? vb.amount_due : sum('due'))}</span>
            </div>
          </div>
        </div>

        <div className="table-wrap" style={{ marginTop: 16 }}>
          <table>
            <thead>
              <tr>
                {isItemBill ? <><th>Item</th><th>Description</th></> : <><th style={{ minWidth: 150 }}>Account</th><th>Account Title</th><th style={{ minWidth: 180 }}>Description</th></>}
                <th>Department *</th><th>Qty</th><th>Unit Price</th>{isItemBill && <th>Disc %</th>}<th>Amount</th><th>Tax Code</th>
                <th style={{ textAlign: 'right' }}>Tax</th><th style={{ textAlign: 'right' }}>Gross</th><th>WTax</th>
                <th style={{ textAlign: 'right' }}>WTax Amt</th><th style={{ textAlign: 'right' }}>Amount Due</th>{!isItemBill && !ro && <th></th>}
              </tr>
            </thead>
            <tbody>
              {priced.map((l) => (
                <tr key={l.key}>
                  {isItemBill ? (
                    <><td>{l.item_code || ''}</td><td>{l.item_name || l.description}</td></>
                  ) : (
                    <>
                      <td>
                        {ro ? (l.account?.account_code || '') : (
                          <EntityPicker
                            label="Account" items={meta.accounts} value={l.account?.id || ''} getLabel={(a) => a.account_code}
                            columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Account' }, { key: 'account_type', label: 'Type' }]}
                            searchKeys={['account_code', 'account_name']} placeholder={l.account?.account_code || 'Select...'}
                            onSelect={(a) => setLine(l.key, { account: a })}
                          />
                        )}
                      </td>
                      <td>{l.account?.account_name || ''}</td>
                      <td>{ro ? l.description : <input value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} />}</td>
                    </>
                  )}
                  <td>
                    <select value={l.department_id} disabled={ro} onChange={(e) => setLine(l.key, { department_id: e.target.value })}>
                      <option value="">Select Department</option>
                      {meta.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </td>
                  <td>{isItemBill || ro ? l.qty : <input type="number" min="0" step="any" style={{ width: 70 }} value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} />}</td>
                  <td>{ro ? rate6(l.unit_price) : <input type="number" step="any" style={{ width: 110 }} value={l.unit_price} onChange={(e) => setLine(l.key, { unit_price: e.target.value })} />}</td>
                  {isItemBill && <td>{ro ? l.disc_percent : <input type="number" min="0" max="100" step="any" style={{ width: 60 }} value={l.disc_percent} onChange={(e) => setLine(l.key, { disc_percent: e.target.value })} />}</td>}
                  <td><input type="number" step="0.01" style={{ width: 120 }} disabled={ro} value={l.amount} title="Amount net of VAT; Unit Price follows" onChange={(e) => setLine(l.key, { amount: e.target.value })} /></td>
                  <td>
                    <select value={l.tax_code_id} disabled={ro} onChange={(e) => setLine(l.key, { tax_code_id: e.target.value })}>
                      <option value="">Select Tax</option>
                      {meta.taxes.map((t) => <option key={t.id} value={t.id}>{t.code} ({Number(t.rate)}%)</option>)}
                    </select>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {ro ? money(l.amt.tax) : (
                      <input type="number" step="0.01" style={{ width: 100 }} title="Tax for this line -- Net x the tax code's rate unless typed"
                        value={l.tax_typed !== undefined ? l.tax_typed : l.amt.tax} onChange={(e) => setLine(l.key, { tax_typed: e.target.value })} />
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>{money(l.amt.gross)}</td>
                  <td style={{ textAlign: 'center' }}><input type="checkbox" disabled={ro} checked={l.is_withhold} onChange={(e) => setLine(l.key, { is_withhold: e.target.checked })} /></td>
                  <td style={{ textAlign: 'right' }}>
                    {ro || !l.is_withhold ? money(l.amt.wtax) : (
                      <input type="number" step="0.01" style={{ width: 100 }} title="Withholding for this line -- Net x rate unless typed"
                        value={l.wtax_typed !== undefined ? l.wtax_typed : l.amt.wtax} onChange={(e) => setLine(l.key, { wtax_typed: e.target.value })} />
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>{money(l.amt.due)}</td>
                  {!isItemBill && !ro && (
                    <td>{lines.length > 1 && <button type="button" className="btn btn-sm btn-danger" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>Delete</button>}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!isItemBill && !ro && (
          <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 8 }}
            onClick={() => setLines((ls) => [...ls, { key: newKey(), id: null, account: null, description: '', department_id: '', qty: 1, unit_price: '', disc_percent: 0, amount: 0, tax_code_id: '', is_withhold: false }])}>
            Add Expense
          </button>
        )}

        <div className="modal-actions">
          <Link className="btn" to={`/vendor-bills/${id}`}>Cancel</Link>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? 'Saving...' : 'SAVE'}</button>
        </div>
      </div>
    </div>
  );
}
