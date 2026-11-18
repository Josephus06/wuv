import { useEffect, useState } from 'react';
import api from '../api/client';
import Modal from './Modal';
import LoadingSpinner from './LoadingSpinner';
import { displayDate } from '../utils/dates';

const money = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// Apply to Invoice: put a payment's unapplied balance against the customer's open invoices
// (PUT /customer-payments/:id/apply). Works on a deposited payment too. It only adds
// applications -- the payment's own fields (Department, Issued By, OR #, amount, date) are not
// sent and so cannot change.
export default function ApplyPaymentModal({ payment, onClose, onApplied }) {
  const [invoices, setInvoices] = useState(null);
  const [amounts, setAmounts] = useState({});
  // Customer Refunds the payment can settle too (2026-11-05), keyed by customer_refund_id.
  const [refunds, setRefunds] = useState([]);
  const [refundAmounts, setRefundAmounts] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const unapplied = r2(payment.unapplied_amount);

  useEffect(() => {
    api.get(`/customer-payments/for-customer/${payment.customer_id}`)
      .then(({ data }) => {
        setInvoices((data.apply_lines || []).filter((l) => Number(l.amount_due) > 0.005));
        setRefunds((data.refund_lines || []).filter((l) => Number(l.amount_due) > 0.005));
      })
      .catch((e) => setError(e.response?.data?.error || 'Could not load the open invoices.'));
  }, [payment.customer_id]);

  const total = r2([...Object.values(amounts), ...Object.values(refundAmounts)].reduce((t, v) => t + (Number(v) || 0), 0));
  const left = r2(unapplied - total);

  // Ticking fills the invoice's balance, capped at what is still unapplied.
  function toggle(inv, on) {
    setAmounts((a) => {
      const next = { ...a };
      if (!on) { delete next[inv.sales_invoice_id]; return next; }
      const used = r2(Object.entries(next).reduce((t, [k, v]) => t + (Number(k) === inv.sales_invoice_id ? 0 : Number(v) || 0), 0)
        + Object.values(refundAmounts).reduce((t, v) => t + (Number(v) || 0), 0));
      next[inv.sales_invoice_id] = String(r2(Math.min(Number(inv.amount_due), unapplied - used)));
      return next;
    });
  }

  function toggleRefund(rf, on) {
    setRefundAmounts((a) => {
      const next = { ...a };
      if (!on) { delete next[rf.customer_refund_id]; return next; }
      const used = r2(Object.entries(next).reduce((t, [k, v]) => t + (Number(k) === rf.customer_refund_id ? 0 : Number(v) || 0), 0)
        + Object.values(amounts).reduce((t, v) => t + (Number(v) || 0), 0));
      next[rf.customer_refund_id] = String(r2(Math.min(Number(rf.amount_due), unapplied - used)));
      return next;
    });
  }

  async function apply() {
    setError('');
    const lines = Object.entries(amounts).filter(([, v]) => Number(v) > 0)
      .map(([k, v]) => ({ sales_invoice_id: Number(k), applied_amount: r2(v) }));
    for (const [k, v] of Object.entries(refundAmounts)) {
      if (Number(v) > 0) lines.push({ customer_refund_id: Number(k), applied_amount: r2(v) });
    }
    if (!lines.length) { setError('Enter an amount on at least one invoice or refund.'); return; }
    if (total > unapplied + 0.005) { setError(`That is more than the ${money(unapplied)} still unapplied.`); return; }
    setSaving(true);
    try {
      await api.put(`/customer-payments/${payment.id}/apply`, { lines });
      onApplied();
    } catch (e) { setError(e.response?.data?.error || 'Apply failed.'); setSaving(false); }
  }

  return (
    <Modal title={`Apply — ${payment.customer_payment_no}`} onClose={onClose} large>
      {error && <div className="error-banner">{error}</div>}
      <div style={{ display: 'flex', gap: 24, marginBottom: 12, flexWrap: 'wrap' }}>
        <span>Unapplied <strong>{money(unapplied)}</strong></span>
        <span>Applying <strong>{money(total)}</strong></span>
        <span>Left unapplied <strong style={{ color: left < -0.005 ? '#dc2626' : undefined }}>{money(left)}</strong></span>
      </div>
      {!invoices ? <LoadingSpinner /> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th></th><th>Invoice #</th><th>SI / BS #</th><th>Date</th>
                <th style={{ textAlign: 'right' }}>Gross</th><th style={{ textAlign: 'right' }}>Amount Due</th>
                <th style={{ textAlign: 'right' }}>Apply</th>
              </tr>
            </thead>
            <tbody>
              {invoices.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center' }}>This customer has no open invoices.</td></tr>}
              {invoices.map((inv) => (
                <tr key={inv.sales_invoice_id}>
                  <td><input type="checkbox" checked={amounts[inv.sales_invoice_id] !== undefined} onChange={(e) => toggle(inv, e.target.checked)} /></td>
                  <td>{inv.invoice_no}</td>
                  <td>{inv.bs_si_no || ''}</td>
                  <td>{displayDate(String(inv.date_created).slice(0, 10))}</td>
                  <td style={{ textAlign: 'right' }}>{money(inv.gross_amount)}</td>
                  <td style={{ textAlign: 'right' }}>{money(inv.amount_due)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <input type="number" min="0" step="0.01" style={{ width: 120, textAlign: 'right' }}
                      value={amounts[inv.sales_invoice_id] ?? ''}
                      onChange={(e) => setAmounts((a) => ({ ...a, [inv.sales_invoice_id]: e.target.value }))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {refunds.length > 0 && (
            <table style={{ marginTop: 14 }}>
              <thead>
                <tr>
                  <th></th><th>Customer Refund #</th><th>Date</th>
                  <th style={{ textAlign: 'right' }}>Refund Amount</th><th style={{ textAlign: 'right' }}>Amount Due</th>
                  <th style={{ textAlign: 'right' }}>Apply</th>
                </tr>
              </thead>
              <tbody>
                {refunds.map((rf) => (
                  <tr key={rf.customer_refund_id}>
                    <td><input type="checkbox" checked={refundAmounts[rf.customer_refund_id] !== undefined} onChange={(e) => toggleRefund(rf, e.target.checked)} /></td>
                    <td>{rf.customer_refund_no}</td>
                    <td>{displayDate(String(rf.date_created).slice(0, 10))}</td>
                    <td style={{ textAlign: 'right' }}>{money(rf.refund_amount)}</td>
                    <td style={{ textAlign: 'right' }}>{money(rf.amount_due)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <input type="number" min="0" step="0.01" style={{ width: 120, textAlign: 'right' }}
                        value={refundAmounts[rf.customer_refund_id] ?? ''}
                        onChange={(e) => setRefundAmounts((a) => ({ ...a, [rf.customer_refund_id]: e.target.value }))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving || !total} onClick={apply}>{saving ? 'Applying…' : 'Apply'}</button>
      </div>
    </Modal>
  );
}
