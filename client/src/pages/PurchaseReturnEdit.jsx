import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}

// Mirrors the real Purchase Order's "Vendor Return" flow -- creates a Purchase Return
// (VR-#) that gives back previously-received qty to the supplier. Only lines with
// received_qty > 0 are eligible, and Qty to Return is capped at that (never below what a
// Receiving Report actually landed). Location is fixed to wherever the line was received
// -- not editable here, matching the real form.
export default function PurchaseReturnEdit() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [po, setPo] = useState(null);
  const [taxes, setTaxes] = useState([]);
  const [dateCreated, setDateCreated] = useState(new Date().toISOString().slice(0, 10));
  const [refNo, setRefNo] = useState('');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get(`/purchase-orders/${id}`),
      api.get('/lookups/taxes'),
    ]).then(([poRes, taxRes]) => {
      setPo(poRes.data);
      setTaxes(taxRes.data);
      setLines(
        poRes.data.lines
          .filter((l) => Number(l.received_qty) > 0)
          .map((l) => ({
            purchase_order_line_id: l.id,
            item_code: l.item_code, item_name: l.item_name, item_id: l.item_id,
            location_name: l.location_name,
            received_qty: l.received_qty,
            qty_returned: 0,
            rate: l.rate, disc_percent: l.disc_percent,
            tax_code_id: l.tax_code_id || '',
          }))
      );
      setLoading(false);
    });
  }, [id]);

  function updateLine(key, patch) {
    setLines((prev) => prev.map((l) => (l.purchase_order_line_id === key ? { ...l, ...patch } : l)));
  }

  function lineCalc(l) {
    const q = Number(l.qty_returned || 0);
    const rate = Number(l.rate || 0);
    const subtotal = q * rate;
    const discAmount = subtotal * (Number(l.disc_percent || 0) / 100);
    const netOfTax = subtotal - discAmount;
    const tax = taxes.find((t) => t.id === l.tax_code_id);
    const taxAmount = netOfTax * (Number(tax?.rate || 0) / 100);
    return { extPrice: netOfTax + taxAmount };
  }

  const grandTotal = lines.reduce((s, l) => s + lineCalc(l).extPrice, 0);

  async function handleSave() {
    setError('');
    const submitLines = lines.filter((l) => Number(l.qty_returned) > 0);
    if (!submitLines.length) { setError('Enter a Qty to Return greater than 0 for at least one line.'); return; }
    setSaving(true);
    try {
      const { data } = await api.post(`/purchase-orders/${id}/returns`, {
        date_created: dateCreated,
        ref_no: refNo,
        memo,
        lines: submitLines.map((l) => ({
          purchase_order_line_id: l.purchase_order_line_id,
          qty_returned: l.qty_returned,
          rate: l.rate,
          disc_percent: l.disc_percent,
          tax_code_id: l.tax_code_id || null,
        })),
      });
      navigate(`/purchase-orders/returns/${data.id}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="page-header">
        <h1>Vendor Return — {po.po_no}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn" to={`/purchase-orders/${id}`}>Back to Lists</Link>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="field"><label>Vendor</label><input value={po.supplier_name} disabled /></div>
          <div className="field"><label>Created From</label><input value={po.po_no} disabled /></div>
          <div className="field">
            <label>Date</label>
            <input type="date" value={dateCreated} onChange={(e) => setDateCreated(e.target.value)} />
          </div>
          <div className="field"><label>Reference #</label><input value={refNo} onChange={(e) => setRefNo(e.target.value)} /></div>
          <div className="field"><label>Memo</label><input value={memo} onChange={(e) => setMemo(e.target.value)} /></div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h3 className="subsection" style={{ marginTop: 0 }}>Items</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th><th>Location</th><th>RR Qty</th><th>Qty to Return</th>
                <th>Rate</th><th>Discount %</th><th>Tax Code</th><th>Ext. Price</th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>Nothing has been received on this Purchase Order yet.</td></tr>
              )}
              {lines.map((l) => {
                const calc = lineCalc(l);
                return (
                  <tr key={l.purchase_order_line_id}>
                    <td>{l.item_code} — {l.item_name}</td>
                    <td>{l.location_name || '—'}</td>
                    <td>{qty(l.received_qty)}</td>
                    <td>
                      <input
                        type="number" step="0.0001" max={l.received_qty} style={{ width: 90 }}
                        value={l.qty_returned} onChange={(e) => updateLine(l.purchase_order_line_id, { qty_returned: e.target.value })}
                      />
                    </td>
                    <td><input type="number" step="0.000001" style={{ width: 90 }} value={l.rate} onChange={(e) => updateLine(l.purchase_order_line_id, { rate: e.target.value })} /></td>
                    <td><input type="number" step="0.01" style={{ width: 70 }} value={l.disc_percent} onChange={(e) => updateLine(l.purchase_order_line_id, { disc_percent: e.target.value })} /></td>
                    <td>
                      <EntityPicker
                        label="Tax Code" items={taxes} value={l.tax_code_id} getLabel={(t) => t?.code}
                        columns={[{ key: 'code', label: 'Code' }, { key: 'rate', label: 'Rate' }]} searchKeys={['code']}
                        onSelect={(t) => updateLine(l.purchase_order_line_id, { tax_code_id: t.id })}
                      />
                    </td>
                    <td>{money(calc.extPrice)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {lines.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
            <div className="hi-lg">Total: {money(grandTotal)}</div>
          </div>
        )}
      </div>
    </div>
  );
}
