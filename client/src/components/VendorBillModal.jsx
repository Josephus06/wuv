import { rate6 } from '../utils/rate';
import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import EntityPicker from './EntityPicker';
import LoadingSpinner from './LoadingSpinner';
import { lineDepartmentError } from '../utils/requireDepartment';

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}
function accountLabel(a) { return a ? `${a.account_code} — ${a.account_name}` : ''; }
function wtaxLabel(w) { return w ? `${w.code} — ${w.name} (${w.rate}%)` : ''; }

// price_per_unit/disc_percent/tax rate are fixed per-unit rates -- Total Disc/Net of
// Tax/Tax Amt/Ext Price are recomputed live off qty x unit_price, mirroring the real
// Create Vendor Bill modal's instant recalculation. This is display-only: the backend
// recomputes everything again from scratch on Save and never trusts these numbers.
function computeLine(l, wtaxRate) {
  const q = Number(l.qty) || 0;
  const unitPrice = Number(l.unit_price) || 0;
  const discPercent = Number(l.disc_percent) || 0;
  const taxRate = Number(l.tax_rate) || 0;
  // A typed Amount (net of VAT) stands as typed; otherwise it is qty x unit price less discount.
  const typed = l.amount !== undefined && l.amount !== '' && Number.isFinite(Number(l.amount));
  // Billed at the PO line's own unit price and discount: the PO line's figures, in proportion to
  // the qty billed -- what the server saves (vendorBills.js computeLineFromPoLine), so the bill
  // cannot come out a centavo off the PO it was billed from.
  const same = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) < 0.000001;
  const share = Number(l.po_qty) > 0 && l.po_net_of_tax != null && same(unitPrice, l.rate) && same(discPercent, l.po_disc_percent)
    ? q / Number(l.po_qty) : null;
  const r2 = (v) => Number((Number(v || 0) * share).toFixed(2));
  const netOfTax = typed ? Number(l.amount) : (share != null ? r2(l.po_net_of_tax) : q * unitPrice * (1 - discPercent / 100));
  const discAmount = typed ? (discPercent > 0 && discPercent < 100 ? netOfTax / (1 - discPercent / 100) - netOfTax : 0)
    : (share != null ? r2(l.po_disc_amount) : q * unitPrice * (discPercent / 100));
  // A typed Tax Amount (tax_typed) stands; otherwise Net x the line's tax rate.
  const taxTyped = l.tax_typed !== undefined && l.tax_typed !== '' && Number.isFinite(Number(l.tax_typed));
  const taxAmount = taxTyped ? Number(l.tax_typed) : (share != null && !typed ? r2(l.po_tax_amount) : netOfTax * (taxRate / 100));
  const extPrice = netOfTax + taxAmount;
  // A typed withholding (wtax_typed) stands; otherwise Net x the bill's rate.
  const wtTyped = l.wtax_typed !== undefined && l.wtax_typed !== '' && Number.isFinite(Number(l.wtax_typed));
  const wtaxAmount = l.is_withhold ? (wtTyped ? Number(l.wtax_typed) : netOfTax * (Number(wtaxRate || 0) / 100)) : 0;
  return { disc_amount: discAmount, net_of_tax: netOfTax, tax_amount: taxAmount, ext_price: extPrice, wtax_amount: wtaxAmount, amount_due: extPrice - wtaxAmount };
}

// Mirrors the real "Create Vendor Bill" popup, reached from a Received Purchase Order's
// "Bill" button -- confirmed field-for-field against the live system. Every line is
// pre-populated from its PO line's still-billable qty (RR Qty - Billed Qty); Rate is a
// read-only snapshot of the PO's own rate, Unit Price is independently editable (defaults
// to the same value) since the actual vendor price at billing time can differ.
export default function VendorBillModal({ purchaseOrderId, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [dateCreated, setDateCreated] = useState(new Date().toISOString().slice(0, 10));
  const [referenceNo, setReferenceNo] = useState('');
  const [account, setAccount] = useState(null);
  const [officeLocation, setOfficeLocation] = useState(null);
  // Term defaults to the PO's and can be changed to any Payment Term; Date Due follows its days.
  const [paymentTerms, setPaymentTerms] = useState([]);
  const [term, setTerm] = useState({ name: '', days: 0 });
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState([]);
  const [tab, setTab] = useState('items');
  const [wtax, setWtax] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [locations, setLocations] = useState([]);
  const [withholdingTaxes, setWithholdingTaxes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // For bill lines whose PO line carries no department: one must be chosen here (required on save).
  const [departments, setDepartments] = useState([]);

  useEffect(() => {
    Promise.all([
      api.get(`/vendor-bills/for-purchase-order/${purchaseOrderId}`),
      api.get('/lookups/chart-of-accounts'),
      api.get('/lookups/locations'),
      api.get('/lookups/withholding-taxes'),
      api.get('/lookups/payment-terms').catch(() => ({ data: [] })),
    ]).then(([poRes, acctRes, locRes, wtaxRes, ptRes]) => {
      setPaymentTerms((ptRes.data || []).filter((t) => t.is_active !== 0 && t.is_active !== false));
      setDepartments(poRes.data.departments || []);
      const d = poRes.data;
      setData(d);
      setAccounts(acctRes.data);
      setLocations(locRes.data);
      setWithholdingTaxes(wtaxRes.data);
      setMemo(d.memo || '');
      if (d.default_account) setAccount(d.default_account);
      // The PO's own term and the location its lines use (asked 2026-10-03).
      setTerm({ name: d.term_name || '', days: Number(d.no_of_days) || 0 });
      if (d.default_office_location) setOfficeLocation(d.default_office_location);
      // po_disc_percent: the PO line's own discount, kept aside so a line billed on the PO's terms
      // can be told from one whose discount was changed here (computeLine).
      setLines(d.lines.map((l) => ({ ...l, po_disc_percent: l.disc_percent, is_withhold: false })));
      setLoading(false);
    });
  }, [purchaseOrderId]);

  const wtaxRate = wtax ? Number(wtax.rate) : 0;
  const dateDue = data ? addDays(dateCreated, term.days) : '';

  const computedLines = useMemo(() => lines.map((l) => ({ ...l, ...computeLine(l, wtaxRate) })), [lines, wtaxRate]);

  if (loading || !data) {
    return (
      <div className="modal-overlay">
        <div className="modal modal-xl"><LoadingSpinner /></div>
      </div>
    );
  }

  const subtotal = computedLines.reduce((s, l) => s + l.net_of_tax + l.disc_amount, 0);
  const discountAmount = computedLines.reduce((s, l) => s + l.disc_amount, 0);
  const netOfTax = computedLines.reduce((s, l) => s + l.net_of_tax, 0);
  const taxAmount = computedLines.reduce((s, l) => s + l.tax_amount, 0);
  const grossAmount = computedLines.reduce((s, l) => s + l.ext_price, 0);
  const wtaxAmount = computedLines.reduce((s, l) => s + l.wtax_amount, 0);
  const amountDue = grossAmount - wtaxAmount;

  // Editing Qty, Unit Price or Discount drops a typed Amount (it is recomputed from them again);
  // typing an Amount sets Unit Price = Amount / Qty (before discount), shown to 4 decimals.
  function updateLine(purchaseOrderLineId, patch) {
    setLines((prev) => prev.map((l) => {
      if (l.purchase_order_line_id !== purchaseOrderLineId) return l;
      const next = { ...l, ...patch };
      if ('qty' in patch || 'unit_price' in patch || 'disc_percent' in patch) {
        if (!('amount' in patch)) delete next.amount;
      }
      // A new amount puts the withholding back on Net x rate.
      if (('amount' in patch || 'qty' in patch || 'unit_price' in patch || 'disc_percent' in patch) && !('wtax_typed' in patch)) delete next.wtax_typed;
      // ...and the tax back on Net x rate.
      if (('amount' in patch || 'qty' in patch || 'unit_price' in patch || 'disc_percent' in patch) && !('tax_typed' in patch)) delete next.tax_typed;
      if ('amount' in patch) {
        const q = Number(next.qty) || 0;
        const d = Number(next.disc_percent) || 0;
        const sub = d > 0 && d < 100 ? Number(patch.amount || 0) / (1 - d / 100) : Number(patch.amount || 0);
        if (q > 0) next.unit_price = Number((sub / q).toFixed(6));
      }
      return next;
    }));
  }

  async function handleSave() {
    setError('');
    if (!lines.length) { setError('Nothing to bill.'); return; }
    // Only the lines being billed (Qty above 0), as the server counts them.
    const deptError = lineDepartmentError(lines.filter((l) => Number(l.qty) > 0));
    if (deptError) { setError(deptError); return; }
    setSaving(true);
    try {
      const { data: vb } = await api.post('/vendor-bills', {
        purchase_order_id: purchaseOrderId,
        date_created: dateCreated,
        date_due: dateDue,
        term: term.name || null,
        reference_no: referenceNo,
        account_id: account?.id || null,
        office_location_id: officeLocation?.id || null,
        memo,
        wtax_id: wtax?.id || null,
        lines: lines.map((l) => ({
          purchase_order_line_id: l.purchase_order_line_id,
          qty: l.qty,
          unit_price: l.unit_price,
          // Sent only when typed; the server then keeps it exactly and derives Unit Price.
          amount: l.amount !== undefined && l.amount !== '' ? Number(l.amount) : undefined,
          disc_percent: l.disc_percent,
          // Sent only when typed; the server then keeps it (withTypedTax).
          tax_amount: l.tax_typed !== undefined && l.tax_typed !== '' ? Number(l.tax_typed) : undefined,
          is_withhold: l.is_withhold,
          // Sent only when typed; the server then keeps it (lineWtax).
          wtax_amount: l.is_withhold && l.wtax_typed !== undefined && l.wtax_typed !== '' ? Number(l.wtax_typed) : undefined,
          department_id: l.department_id || null,
        })),
      });
      onSaved(vb);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-xl" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="estimate-banner" style={{ borderRadius: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <h2 style={{ margin: 0, color: '#fff' }}>Create Vendor Bill</h2>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 24, lineHeight: 1, cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ padding: 24 }}>
          {error && <div className="error-banner">{error}</div>}

          <div className="review-grid" style={{ gridTemplateColumns: '1fr 1fr 260px' }}>
            <div>
              <div className="field"><label>Date</label><input type="date" value={dateCreated} onChange={(e) => setDateCreated(e.target.value)} /></div>
              <div className="field"><label>Date Due</label><input readOnly tabIndex={-1} value={dateDue} /></div>
              <div>Vendor : <span className="hi">{data.supplier_name}</span></div>
              <div>Created Form : <span className="hi">{data.po_no}</span></div>
              <div className="field">
                <label>Reference #</label>
                <input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} />
              </div>
            </div>
            <div>
              <div className="field">
                <label>Account</label>
                <EntityPicker
                  label="Account" items={accounts} value={account?.id || ''} getLabel={accountLabel}
                  columns={[{ key: 'account_code', label: 'Code' }, { key: 'account_name', label: 'Name' }, { key: 'account_type', label: 'Type' }]}
                  searchKeys={['account_code', 'account_name']}
                  onSelect={setAccount}
                />
              </div>
              <div className="field">
                <label>Office Location</label>
                <EntityPicker
                  label="Office Location" items={locations} value={officeLocation?.id || ''} getLabel={(l) => l.location_name}
                  columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']}
                  onSelect={setOfficeLocation}
                />
              </div>
              <div className="field">
                <label>Term</label>
                <EntityPicker
                  label="Term" items={paymentTerms}
                  value={paymentTerms.find((t) => String(t.term_name).trim().toLowerCase() === String(term.name).trim().toLowerCase())?.id || ''}
                  getLabel={(t) => t.term_name}
                  columns={[{ key: 'term_name', label: 'Term' }, { key: 'no_of_days', label: 'Days', render: (t) => Number(t.no_of_days || 0) }]}
                  searchKeys={['term_name']} placeholder={term.name || 'Select Term...'}
                  onSelect={(t) => setTerm(t ? { name: t.term_name, days: Number(t.no_of_days) || 0 } : { name: '', days: 0 })}
                  onClear={() => setTerm({ name: '', days: 0 })}
                />
              </div>
              <div className="field"><label>Memo</label><textarea rows={3} value={memo} onChange={(e) => setMemo(e.target.value)} /></div>
            </div>
            <div className="card" style={{ background: 'var(--surface-2, #f3f4f6)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Sub Total</span><span className="hi">{money(subtotal)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Discount Amount</span><span className="hi">{money(discountAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Net of Tax</span><span className="hi">{money(netOfTax)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Tax Amount</span><span className="hi">{money(taxAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Gross Amount</span><span className="hi">{money(grossAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Withholding Tax Amount</span><span className="hi">{money(wtaxAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Amount</span><span className="hi">{money(grossAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}><span>Amount Due</span><span>{money(amountDue)}</span></div>
            </div>
          </div>

          <div className="status-tabs" style={{ marginTop: 20 }}>
            <button className={`status-tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>Items</button>
            <button className={`status-tab ${tab === 'wtax' ? 'active' : ''}`} onClick={() => setTab('wtax')}>Withholding Tax {money(wtaxAmount)}</button>
          </div>

          {tab === 'items' && (
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table>
                <thead>
                  <tr>
                    <th>Item Code</th><th>Purchase Desc.</th><th>Location</th><th>Department *</th>
                    <th>RR Qty</th><th>Billed Qty</th><th>Qty to Bill</th><th>Purchase Unit</th>
                    <th>Rate</th><th>Unit Price</th><th>Discount %</th><th>Total Disc. Amt.</th>
                    <th>Total Amt. (Net of Tax)</th><th>Tax Code</th><th>Tax Amt.</th><th>Ext. Price</th>
                    <th>Apply Withholding Tax</th><th>Withholding Tax Amount</th><th>Amount Due</th>
                  </tr>
                </thead>
                <tbody>
                  {computedLines.length === 0 && (
                    <tr><td colSpan={19} className="muted" style={{ textAlign: 'center', padding: 20 }}>Nothing left to bill.</td></tr>
                  )}
                  {computedLines.map((l) => (
                    <tr key={l.purchase_order_line_id}>
                      <td>{l.item_code} {l.item_name ? `— ${l.item_name}` : ''}</td>
                      <td>{l.purchase_description}</td>
                      <td>{l.location_name}</td>
                      <td>
                        {l.department_name || (
                          <select value={l.department_id || ''} onChange={(e) => updateLine(l.purchase_order_line_id, { department_id: e.target.value })}
                            style={!l.department_id ? { borderColor: 'var(--danger, #b91c1c)' } : undefined} title="Required: this PO line has no department">
                            <option value="">--Required--</option>
                            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                          </select>
                        )}
                      </td>
                      <td>{qty(l.rr_qty)}</td>
                      <td>{qty(l.billed_qty)}</td>
                      <td>
                        <input
                          type="number" step="0.000001" style={{ width: 90 }}
                          value={l.qty}
                          onChange={(e) => updateLine(l.purchase_order_line_id, { qty: e.target.value })}
                        />
                      </td>
                      <td>{l.purchase_unit || l.unit_title}</td>
                      <td>{rate6(l.rate)}</td>
                      <td>
                        <input
                          type="number" step="0.00001" style={{ width: 100 }}
                          value={l.unit_price}
                          onChange={(e) => updateLine(l.purchase_order_line_id, { unit_price: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          type="number" step="0.01" style={{ width: 70 }}
                          value={l.disc_percent}
                          onChange={(e) => updateLine(l.purchase_order_line_id, { disc_percent: e.target.value })}
                        />
                      </td>
                      <td>{money(l.disc_amount)}</td>
                      <td>
                        <input
                          type="number" step="0.01" style={{ width: 110 }}
                          value={l.amount !== undefined ? l.amount : Number(l.net_of_tax.toFixed(2))}
                          onChange={(e) => updateLine(l.purchase_order_line_id, { amount: e.target.value })}
                          title="Type the Amount (net of VAT); Unit Price follows"
                        />
                      </td>
                      <td>{l.tax_code}</td>
                      <td>
                        <input type="number" step="0.01" style={{ width: 90 }} title="Tax for this line -- Net x the tax rate unless typed"
                          value={l.tax_typed !== undefined ? l.tax_typed : Number(l.tax_amount.toFixed(2))}
                          onChange={(e) => updateLine(l.purchase_order_line_id, { tax_typed: e.target.value })} />
                      </td>
                      <td>{money(l.ext_price)}</td>
                      <td>
                        <input
                          type="checkbox" checked={!!l.is_withhold}
                          onChange={(e) => updateLine(l.purchase_order_line_id, { is_withhold: e.target.checked })}
                        />
                      </td>
                      <td>
                        {l.is_withhold ? (
                          <input type="number" step="0.01" min="0" style={{ width: 90 }} title="Withholding for this line -- Net x rate unless typed"
                            value={l.wtax_typed !== undefined ? l.wtax_typed : Number(l.wtax_amount.toFixed(2))}
                            onChange={(e) => updateLine(l.purchase_order_line_id, { wtax_typed: e.target.value })} />
                        ) : money(l.wtax_amount)}
                      </td>
                      <td>{money(l.amount_due)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'wtax' && (
            <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: 12 }}>
              <div className="field">
                <label>Withholding Tax</label>
                <EntityPicker
                  label="Withholding Tax" items={withholdingTaxes} value={wtax?.id || ''} getLabel={wtaxLabel}
                  columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'rate', label: 'Rate %' }]}
                  searchKeys={['code', 'name']}
                  onSelect={setWtax}
                />
              </div>
              <div className="field"><label>Withholding Tax Description</label><input readOnly tabIndex={-1} value={wtax?.name || ''} /></div>
              <div className="field"><label>Withholding Tax Amount</label><input readOnly tabIndex={-1} value={money(wtaxAmount)} /></div>
            </div>
          )}

          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={saving || computedLines.length === 0} onClick={handleSave}>
              {saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
