import { useEffect, useState } from 'react';
import api from '../api/client';
import EntityPicker from './EntityPicker';
import LoadingSpinner from './LoadingSpinner';

import { displayDate } from '../utils/dates';
import { lineDepartmentError } from '../utils/requireDepartment';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? displayDate(v) : '—'; }

// Mirrors computeLineAmounts in routes/creditMemos.js exactly, so this preview and the
// record the server writes can never disagree.
function lineAmounts(l) {
  const qty = Number(l.quantity || 0);
  const price = Number(l.price_per_unit || 0);
  const pct = Number(l.disc_percent || 0);
  // Rounded per line exactly as routes/creditMemos.js saves it, so the totals shown are the ones saved.
  const r2 = (v) => Math.round(v * 100) / 100;
  const subtotal = r2(price * qty);
  const discAmount = r2(subtotal * (pct / 100));
  const discPerUnit = Math.round(price * (pct / 100) * 10000) / 10000;
  const netOfTax = r2(subtotal - discAmount);
  const taxAmount = r2(netOfTax * (Number(l.tax_rate || 0) / 100));
  return {
    subtotal, discAmount, discPerUnit, discPricePerUnit: price - discPerUnit,
    netOfTax, taxAmount, grossAmount: r2(netOfTax + taxAmount),
  };
}

// Mirrors the real "Credit Memo" popup, reached from an Open Invoice's Credit Memo
// button. ITEMS starts empty exactly as the real form does -- you add only what's being
// credited back -- but the source invoice's own lines are offered by "Copy from Invoice"
// so a full credit doesn't have to be retyped. APPLY then offsets the customer's open
// invoices by this memo.
//
// Deliberate deviation from the real system: it defaults APPLY to the invoice's full
// total regardless of what ITEMS adds up to and will save with a negative Unapplied
// Amount. That's an accounting error, so this caps applied at the memo's own total and
// the server rejects an over-application rather than clamping it.
export default function CreditMemoModal({ invoiceId, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [dateCreated, setDateCreated] = useState(new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState('');
  const [rows, setRows] = useState([]);
  const [applyAmounts, setApplyAmounts] = useState({});
  const [tab, setTab] = useState('items');
  const [departments, setDepartments] = useState([]);
  const [items, setItems] = useState([]);
  const [taxes, setTaxes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get(`/credit-memos/for-invoice/${invoiceId}`),
      api.get('/lookups/departments'),
      // A credit memo's lines are Discount items (DISCOUNT, EX-DEAL, SALES ADJUSTMENT, WRITE OFF...),
      // as on the source -- the default item list leaves that type out altogether.
      api.get('/inventory', { params: { item_type: 'Discount' } }),
      api.get('/lookups/taxes'),
    ]).then(([srcRes, deptRes, itemRes, taxRes]) => {
      const d = srcRes.data;
      setData(d);
      setDepartments(deptRes.data);
      setItems(Array.isArray(itemRes.data) ? itemRes.data : (itemRes.data?.rows || []));
      setTaxes(taxRes.data);
      setMemo(d.memo || '');
      setLoading(false);
    }).catch((err) => {
      setError(err.response?.data?.error || 'Could not load this Invoice.');
      setLoading(false);
    });
  }, [invoiceId]);

  function updateRow(key, patch) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function addRow() {
    const defaultTax = taxes[0];
    setRows((prev) => [...prev, {
      key: `new-${prev.length}-${prev.reduce((s, r) => s + r.key.length, 0)}`,
      sales_invoice_line_id: null, job_order_id: null, job_order_no: null,
      item_id: null, item_name: '', description: '', department_id: null,
      quantity: 1, units: '', price_per_unit: 0, disc_percent: 0,
      tax_code: defaultTax?.code || null, tax_rate: defaultTax?.rate || 0,
    }]);
  }

  // Pulls the invoice's own lines in, for the common case of crediting it in full.
  function copyFromInvoice() {
    setRows((prev) => [
      ...prev,
      ...data.invoice_lines.map((l, idx) => ({
        key: `inv-${l.sales_invoice_line_id}-${idx}`,
        sales_invoice_line_id: l.sales_invoice_line_id,
        job_order_id: l.job_order_id,
        job_order_no: l.job_order_no,
        item_id: null,
        item_name: '',
        description: l.description,
        department_id: null,
        quantity: l.quantity,
        units: l.units,
        price_per_unit: l.price_per_unit,
        disc_percent: l.disc_percent,
        tax_code: l.tax_code,
        tax_rate: l.tax_rate || 0,
      })),
    ]);
  }

  if (loading) {
    return <div className="modal-overlay"><div className="modal modal-xl"><LoadingSpinner /></div></div>;
  }
  if (!data) {
    return (
      <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal modal-xl">
          <div className="error-banner">{error}</div>
          <div className="modal-actions"><button type="button" className="btn" onClick={onClose}>Close</button></div>
        </div>
      </div>
    );
  }

  const totals = rows.reduce((acc, r) => {
    const a = lineAmounts(r);
    return {
      subtotal: acc.subtotal + a.subtotal,
      discountAmount: acc.discountAmount + a.discAmount,
      netOfTax: acc.netOfTax + a.netOfTax,
      taxAmount: acc.taxAmount + a.taxAmount,
      grossAmount: acc.grossAmount + a.grossAmount,
    };
  }, { subtotal: 0, discountAmount: 0, netOfTax: 0, taxAmount: 0, grossAmount: 0 });

  const appliedTotal = Object.values(applyAmounts).reduce((s, v) => s + (Number(v) || 0), 0);
  const overApplied = appliedTotal > totals.grossAmount + 0.005;

  async function handleSave() {
    setError('');
    const payload = rows.filter((r) => Number(r.quantity) > 0);
    if (!payload.length) { setError('Add at least one item to credit.'); return; }
    const deptError = lineDepartmentError(payload);
    if (deptError) { setError(deptError); return; }
    if (overApplied) {
      setError(`Applied Amount (${money(appliedTotal)}) exceeds this Credit Memo's own total (${money(totals.grossAmount)}).`);
      return;
    }
    setSaving(true);
    try {
      const { data: cm } = await api.post('/credit-memos', {
        sales_invoice_id: invoiceId,
        date_created: dateCreated,
        office_location_id: data.office_location_id || null,
        ar_account_id: data.ar_account_id || null,
        memo,
        lines: payload.map((r) => ({
          sales_invoice_line_id: r.sales_invoice_line_id,
          job_order_id: r.job_order_id,
          item_id: r.item_id,
          item_name: r.item_name,
          description: r.description,
          department_id: r.department_id,
          quantity: r.quantity,
          units: r.units,
          price_per_unit: r.price_per_unit,
          disc_percent: r.disc_percent,
          tax_code: r.tax_code,
        })),
        apply_lines: Object.entries(applyAmounts)
          .filter(([, v]) => Number(v) > 0)
          .map(([id, v]) => ({ sales_invoice_id: Number(id), applied_amount: Number(v) })),
      });
      onSaved(cm);
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
          <h2 style={{ margin: 0, color: '#fff' }}>Credit Memo</h2>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 24, lineHeight: 1, cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ padding: 24 }}>
          {error && <div className="error-banner">{error}</div>}

          <div className="review-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div>
              <div className="field"><label>Date</label><input type="date" value={dateCreated} onChange={(e) => setDateCreated(e.target.value)} /></div>
              <div>Customer : <span className="hi">{data.customer_name}</span></div>
              <div>Office Location : <span className="hi">{data.office_location_name || '—'}</span></div>
              <div>A/R Account : <span className="hi">{data.ar_account_code ? `${data.ar_account_code} ${data.ar_account_name}` : '—'}</span></div>
              <div className="field"><label>Memo</label><textarea rows={4} value={memo} onChange={(e) => setMemo(e.target.value)} /></div>
            </div>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Sub Total :</span><span className="hi">{money(totals.subtotal)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Discount Amount :</span><span className="hi">{money(totals.discountAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Net of Tax :</span><span className="hi">{money(totals.netOfTax)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Tax Amount :</span><span className="hi">{money(totals.taxAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Gross Amount :</span><span className="hi">{money(totals.grossAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}><span>Amount Due :</span><span>{money(data.amount_due)}</span></div>
            </div>
          </div>

          <div className="status-tabs" style={{ marginTop: 20 }}>
            <button className={`status-tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>ITEMS {money(totals.grossAmount)}</button>
            <button className={`status-tab ${tab === 'apply' ? 'active' : ''}`} onClick={() => setTab('apply')}>APPLY {money(appliedTotal)}</button>
          </div>

          {tab === 'items' && (
            <>
              <div className="table-wrap" style={{ marginTop: 12 }}>
                <table>
                  <thead>
                    <tr>
                      <th>#</th><th>JO #</th><th>Item</th><th>Description</th><th>Department *</th><th>Qty</th>
                      <th>Unit</th><th>Price/Unit</th><th>Subtotal</th><th>Disc.%</th><th>Disc. / Unit</th>
                      <th>Disc. Amt</th><th>Disc. Price/Unit</th><th>Net of Tax</th><th>Tax Code</th>
                      <th>Tax Amt</th><th>Gross Amt</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 && (
                      <tr><td colSpan={18} className="muted" style={{ textAlign: 'center', padding: 20 }}>Nothing credited yet. Use Add Item, or Copy from Invoice to credit it in full.</td></tr>
                    )}
                    {rows.map((r, idx) => {
                      const a = lineAmounts(r);
                      const dept = departments.find((d) => String(d.id) === String(r.department_id));
                      return (
                        <tr key={r.key}>
                          <td>{idx + 1}</td>
                          <td>{r.job_order_no || '—'}</td>
                          <td style={{ minWidth: 150 }}>
                            <EntityPicker
                              label="Item" items={items} value={r.item_id || ''} getLabel={(i) => i.display_name}
                              columns={[{ key: 'item_code', label: 'Code' }, { key: 'display_name', label: 'Name' }]}
                              searchKeys={['item_code', 'display_name']}
                              triggerLabel={r.item_name || 'Select item'} triggerClassName="btn btn-sm"
                              onSelect={(i) => updateRow(r.key, { item_id: i.id, item_name: i.display_name })}
                            />
                          </td>
                          <td><input style={{ width: 170 }} value={r.description ?? ''} onChange={(e) => updateRow(r.key, { description: e.target.value })} /></td>
                          <td>
                            <select value={r.department_id || ''} onChange={(e) => updateRow(r.key, { department_id: e.target.value ? Number(e.target.value) : null })}>
                              <option value="">{dept ? dept.name : '—'}</option>
                              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                            </select>
                          </td>
                          <td><input type="number" step="0.0001" style={{ width: 80 }} value={r.quantity ?? ''} onChange={(e) => updateRow(r.key, { quantity: e.target.value })} /></td>
                          <td><input style={{ width: 70 }} value={r.units ?? ''} onChange={(e) => updateRow(r.key, { units: e.target.value })} /></td>
                          <td><input type="number" step="0.0001" style={{ width: 100 }} value={r.price_per_unit ?? ''} onChange={(e) => updateRow(r.key, { price_per_unit: e.target.value })} /></td>
                          <td>{money(a.subtotal)}</td>
                          <td><input type="number" step="0.01" style={{ width: 70 }} value={r.disc_percent ?? ''} onChange={(e) => updateRow(r.key, { disc_percent: e.target.value })} /></td>
                          <td>{money(a.discPerUnit)}</td>
                          <td>{money(a.discAmount)}</td>
                          <td>{money(a.discPricePerUnit)}</td>
                          <td>{money(a.netOfTax)}</td>
                          <td>
                            <select
                              value={r.tax_code || ''}
                              onChange={(e) => {
                                const t = taxes.find((x) => x.code === e.target.value);
                                updateRow(r.key, { tax_code: e.target.value || null, tax_rate: t?.rate || 0 });
                              }}
                            >
                              <option value="">—</option>
                              {taxes.map((t) => <option key={t.id} value={t.code}>{t.code}</option>)}
                            </select>
                          </td>
                          <td>{money(a.taxAmount)}</td>
                          <td>{money(a.grossAmount)}</td>
                          <td><button type="button" className="btn btn-sm" onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}>Delete</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button type="button" className="btn btn-primary" onClick={addRow}>Add Item</button>
                <button type="button" className="btn" onClick={copyFromInvoice}>Copy from {data.invoice_no}</button>
              </div>
            </>
          )}

          {tab === 'apply' && (
            <div className="table-wrap" style={{ marginTop: 12 }}>
              {overApplied && (
                <div className="error-banner">
                  Applied Amount ({money(appliedTotal)}) exceeds this Credit Memo&apos;s own total ({money(totals.grossAmount)}). Add the items you&apos;re crediting, or lower what you&apos;re applying.
                </div>
              )}
              <table>
                <thead>
                  <tr><th></th><th>Invoice #</th><th>Date Created</th><th>Original Amount</th><th>Amount Due</th><th>Applied Amount</th></tr>
                </thead>
                <tbody>
                  {data.apply_lines.length === 0 && (
                    <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>This customer has no open invoices.</td></tr>
                  )}
                  {data.apply_lines.map((l) => {
                    const checked = applyAmounts[l.sales_invoice_id] !== undefined;
                    return (
                      <tr key={l.sales_invoice_id}>
                        <td>
                          <input
                            type="checkbox" checked={checked}
                            onChange={() => setApplyAmounts((prev) => {
                              const next = { ...prev };
                              if (checked) delete next[l.sales_invoice_id];
                              else {
                                // Default to whichever is smaller: what the invoice still
                                // owes, or what this memo is actually worth.
                                const cap = Math.min(Number(l.amount_due), totals.grossAmount);
                                next[l.sales_invoice_id] = String(Math.max(cap, 0).toFixed(2));
                              }
                              return next;
                            })}
                          />
                        </td>
                        <td>{l.invoice_no}</td>
                        <td>{formatDate(l.date_created)}</td>
                        <td>{money(l.gross_amount)}</td>
                        <td>{money(l.amount_due)}</td>
                        <td>
                          <input
                            type="number" step="0.01" style={{ width: 120 }} disabled={!checked}
                            value={applyAmounts[l.sales_invoice_id] ?? ''}
                            onChange={(e) => setApplyAmounts((prev) => ({ ...prev, [l.sales_invoice_id]: e.target.value }))}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={saving || rows.length === 0} onClick={handleSave}>
              {saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
