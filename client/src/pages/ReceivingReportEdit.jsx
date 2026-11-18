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

// Mirrors the real Purchase Order's "Receive" flow -- creates a Receiving Report
// (RR-#) that lands each line's Qty Received as stock at its chosen Location. Only
// reachable once the PO is Approved. Rate/Discount %/Tax Code default from the PO line
// but are re-editable here (invoice price can differ from what was ordered), matching
// the real Receiving Report form.
//
// Also the EDIT form for a saved RR (2026-10-12; /receiving-reports/:receiptId/edit): opened on its
// lines, saved with PUT /purchase-orders/receipts/:receiptId, which moves received qty and stock by
// the difference. Lines are not added or removed there.
export default function ReceivingReportEdit() {
  const { id: poParam, receiptId } = useParams();
  const isEdit = !!receiptId;
  const [poId, setPoId] = useState(poParam || null);
  const [receiptNo, setReceiptNo] = useState('');
  const id = poId;
  const navigate = useNavigate();
  const [po, setPo] = useState(null);
  const [locations, setLocations] = useState([]);
  const [taxes, setTaxes] = useState([]);
  const [dateCreated, setDateCreated] = useState(new Date().toISOString().slice(0, 10));
  const [refNo, setRefNo] = useState('');
  const [memo, setMemo] = useState('');
  const [isOnHold, setIsOnHold] = useState(false);
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      // Editing: the receipt first -- it names its PO.
      const rr = isEdit ? (await api.get(`/receiving-reports/${receiptId}`)).data : null;
      const thePoId = rr ? rr.purchase_order_id : poParam;
      const [poRes, locRes, taxRes] = await Promise.all([
        api.get(`/purchase-orders/${thePoId}`),
        api.get('/lookups/locations'),
        api.get('/lookups/taxes'),
      ]);
      setPoId(thePoId);
      setPo(poRes.data);
      setLocations(locRes.data);
      setTaxes(taxRes.data);
      if (rr) {
        setReceiptNo(rr.receipt_no);
        setDateCreated(String(rr.date_created).slice(0, 10));
        setRefNo(rr.ref_no || '');
        setMemo(rr.memo || '');
        setIsOnHold(!!rr.is_on_hold);
        const polById = new Map(poRes.data.lines.map((l) => [l.id, l]));
        setLines(rr.lines.map((rl) => {
          const pl = polById.get(rl.purchase_order_line_id) || {};
          return {
            id: rl.id, purchase_order_line_id: rl.purchase_order_line_id,
            item_code: rl.item_code, item_name: rl.item_name, item_id: rl.item_id,
            // "Already Received" here is what OTHER receipts took of the PO line.
            po_qty: pl.qty, received_qty: Number(pl.received_qty || 0) - Number(rl.qty_received || 0),
            location_id: rl.location_id || '', department_name: rl.department_name || '',
            qty_received: Number(rl.qty_received), rate: rl.rate, disc_percent: rl.disc_percent,
            tax_code_id: rl.tax_code_id || '',
            po_rate: pl.rate, po_disc: pl.disc_percent, po_tax: pl.tax_code_id || '', po_ext: pl.ext_price,
          };
        }));
        setLoading(false);
        return;
      }
      setLines(
        poRes.data.lines
          .filter((l) => Number(l.qty) > Number(l.received_qty))
          .map((l) => ({
            purchase_order_line_id: l.id,
            item_code: l.item_code, item_name: l.item_name, item_id: l.item_id,
            po_qty: l.qty, received_qty: l.received_qty,
            location_id: l.location_id || '',
            // Carried from the purchase order line and shown read-only. A receipt is a delivery
            // against an order that is already charged to a department, so there is no second
            // decision to make here -- and nothing to keep in step, because the receipt has no
            // department of its own to drift from the order's.
            department_name: l.department_name || '',
            qty_received: Number(l.qty) - Number(l.received_qty),
            rate: l.rate, disc_percent: l.disc_percent,
            tax_code_id: l.tax_code_id || '',
            po_rate: l.rate, po_disc: l.disc_percent, po_tax: l.tax_code_id || '', po_ext: l.ext_price,
          }))
      );
      setLoading(false);
    })().catch((e) => { setError(e.response?.data?.error || 'Could not load.'); setLoading(false); });
  }, [poParam, receiptId, isEdit]);

  // Quantities are kept to 4 decimals.
  const qty4 = (v) => Math.round(Number(v || 0) * 10000) / 10000;

  function updateLine(key, patch) {
    setLines((prev) => prev.map((l) => (l.purchase_order_line_id === key ? { ...l, ...patch } : l)));
  }

  // Received at the PO line's own terms, a line is priced as the server prices it: its share of the
  // PO line's own amount -- PO-21208's 0.0533 at 51,000 is the PO's 2,720.00, not 0.0533 x 51,000 =
  // 2,718.30 (which had people typing 0.053333 to make it match, and being told it was over, 2026-10-23).
  function lineCalc(l) {
    const q = qty4(l.qty_received);
    const poQty = Number(l.po_qty || 0);
    const sameTerms = Math.abs(Number(l.rate || 0) - Number(l.po_rate || 0)) < 1e-9
      && Math.abs(Number(l.disc_percent || 0) - Number(l.po_disc || 0)) < 1e-9
      && String(l.tax_code_id || '') === String(l.po_tax || '');
    if (poQty > 0 && l.po_ext != null && sameTerms) return { extPrice: Math.round(Number(l.po_ext) * (q / poQty) * 100) / 100 };
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
    if (isEdit && lines.some((l) => !(Number(l.qty_received) > 0))) { setError('Rec. Qty must be above 0 on every line.'); return; }
    const submitLines = lines.filter((l) => Number(l.qty_received) > 0);
    if (!submitLines.length) { setError('Enter a Qty Received greater than 0 for at least one line.'); return; }
    if (submitLines.some((l) => !l.location_id)) { setError('Select a Location for every line being received.'); return; }
    setSaving(true);
    try {
      if (isEdit) {
        await api.put(`/purchase-orders/receipts/${receiptId}`, {
          date_created: dateCreated, ref_no: refNo, memo, is_on_hold: isOnHold,
          lines: lines.map((l) => ({
            id: l.id, location_id: l.location_id, qty_received: l.qty_received,
            rate: l.rate, disc_percent: l.disc_percent, tax_code_id: l.tax_code_id || null,
          })),
        });
        navigate(`/receiving-reports/${receiptId}`);
        return;
      }
      const { data } = await api.post(`/purchase-orders/${id}/receipts`, {
        date_created: dateCreated,
        ref_no: refNo,
        memo,
        is_on_hold: isOnHold,
        lines: submitLines.map((l) => ({
          purchase_order_line_id: l.purchase_order_line_id,
          location_id: l.location_id,
          qty_received: l.qty_received,
          rate: l.rate,
          disc_percent: l.disc_percent,
          tax_code_id: l.tax_code_id || null,
        })),
      });
      navigate(`/purchase-orders/receipts/${data.id}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingSpinner />;
  if (!po) return <div className="error-banner">{error || 'Could not load.'}</div>;

  return (
    <div>
      <div className="page-header">
        <h1>{isEdit ? `Edit ${receiptNo}` : 'Receiving Report'} — {po.po_no}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn" to={isEdit ? `/receiving-reports/${receiptId}` : `/purchase-orders/${id}`}>{isEdit ? 'Cancel' : 'Back to Lists'}</Link>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="field"><label>Supplier</label><input value={po.supplier_name} disabled /></div>
          <div className="field"><label>Created From</label><input value={po.po_no} disabled /></div>
          <div className="field">
            <label>Date Created</label>
            <input type="date" value={dateCreated} onChange={(e) => setDateCreated(e.target.value)} />
          </div>
          <div className="field"><label>Ref. #</label><input value={refNo} onChange={(e) => setRefNo(e.target.value)} /></div>
          <div className="field"><label>Memo</label><input value={memo} onChange={(e) => setMemo(e.target.value)} /></div>
          <div className="field field-checkbox">
            <input type="checkbox" id="is-on-hold" checked={isOnHold} onChange={(e) => setIsOnHold(e.target.checked)} />
            <label htmlFor="is-on-hold">On Hold</label>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h3 className="subsection" style={{ marginTop: 0 }}>Materials</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th><th>Location</th><th>Department</th><th>PO Qty</th><th>{isEdit ? 'Received Elsewhere' : 'Already Received'}</th><th>Rec. Qty</th>
                <th>Rate</th><th>Discount %</th><th>Tax Code</th><th>Ext. Price</th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 20 }}>Every line on this PO has already been fully received.</td></tr>
              )}
              {lines.map((l) => {
                const calc = lineCalc(l);
                const remaining = Number(l.po_qty) - Number(l.received_qty);
                return (
                  <tr key={l.purchase_order_line_id}>
                    <td>{l.item_code} — {l.item_name}</td>
                    <td>
                      <EntityPicker
                        label="Location" items={locations} value={l.location_id} getLabel={(loc) => loc?.location_name}
                        columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']}
                        onSelect={(loc) => updateLine(l.purchase_order_line_id, { location_id: loc.id })}
                      />
                    </td>
                    <td>{l.department_name || '—'}</td>
                    <td>{qty(l.po_qty)}</td>
                    <td>{qty(l.received_qty)}</td>
                    <td>
                      <input
                        type="number" step="0.0001" max={remaining} style={{ width: 90 }}
                        value={l.qty_received} onChange={(e) => updateLine(l.purchase_order_line_id, { qty_received: e.target.value })}
                        onBlur={(e) => e.target.value !== '' && updateLine(l.purchase_order_line_id, { qty_received: String(qty4(e.target.value)) })}
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
