import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import { COMPANY } from '../config/company';

// Transfer Order, printed as the warehouse's pick/transfer slip (asked 2026-10-03): A4, letterhead,
// from / to locations, the items with the quantity asked for (after any adjustment) and what has
// been fulfilled and received so far, then Requested / Prepared / Approved / Released / Received
// sign-off lines. Same look as the Fund Transfer voucher (FundTransferPrint.jsx).
//
// Read from GET /transfer-orders/:id, so whoever can open a Transfer Order can print it -- it is
// the slip the warehouse picks from.

const qty = (v) => (v == null || v === '' ? '' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 4 }));
// Paper keeps the source's own date format: "Sep 30, 2026".
const longDate = (v) => (v ? new Date(`${String(v).slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : '');
// Same labels as TransferOrderView.
const STATUS = {
  pending_fulfillment: 'Pending Fulfillment', partially_fulfilled: 'Partially Fulfilled', pending_receipt: 'Pending Receipt',
  pending_receipt_partially_fulfilled: 'Pending Receipt / Partially Fulfilled', received: 'Received', cancelled: 'Cancelled',
};

export default function TransferOrderPrint() {
  const { id } = useParams();
  const [to, setTo] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/transfer-orders/${id}`)
      .then(({ data }) => setTo(data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load this Transfer Order.'));
  }, [id]);

  if (error) {
    return (
      <div style={{ maxWidth: 620, margin: '80px auto', padding: 24, textAlign: 'center', font: '14px/1.6 system-ui, sans-serif' }}>
        <h2 style={{ marginBottom: 8 }}>Can&rsquo;t print this Transfer Order</h2>
        <p style={{ color: '#64748b' }}>{error}</p>
      </div>
    );
  }
  if (!to) return <LoadingSpinner />;

  const lines = to.lines || [];
  const sign = (label, name) => (
    <div key={label}>
      <div>{label}</div>
      <div style={{ height: '8mm' }} />
      <div className="top-line" />
      <div style={{ minHeight: '1.4em' }}>{name || ''}</div>
    </div>
  );

  return (
    <div className="top">
      <style>{`
        .top { background: #f1f5f9; padding: 16px 0 40px; }
        .top-toolbar { max-width: 210mm; margin: 0 auto 12px; display: flex; justify-content: flex-end; gap: 8px; }
        .top-sheet { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 14mm 14mm; background: #fff; color: #1f2937;
          font-family: system-ui, 'Segoe UI', sans-serif; font-size: 8.5pt; line-height: 1.5; box-shadow: 0 1px 6px rgba(0,0,0,.25);
          display: flex; flex-direction: column; position: relative; box-sizing: border-box; }
        .top-head { display: flex; justify-content: space-between; align-items: flex-start; }
        .top-logo { width: 62mm; height: auto; }
        .top-addr { text-align: right; font-size: 7.5pt; color: #475569; line-height: 1.45; }
        .top-title { text-align: center; font-size: 12pt; font-weight: 600; margin: 8mm 0 6mm; }
        .top-cols { display: flex; justify-content: space-between; gap: 10mm; }
        .top-cols > div { flex: 1; }
        .top-table { width: 100%; border-collapse: collapse; margin-top: 7mm; font-size: 8pt; table-layout: fixed; }
        .top-table th, .top-table td { border: 1px solid #cbd5e1; padding: 4px 3px; font-weight: 400; background: none; white-space: normal; overflow-wrap: anywhere; vertical-align: top; }
        .top-table th { color: #334155; text-align: left; }
        .top-num { text-align: right !important; }
        .top-count { margin-top: 3mm; text-align: right; }
        .top-sign { display: flex; justify-content: space-between; gap: 6mm; padding: 0 2mm; margin-top: auto; padding-top: 12mm; }
        .top-sign > div { flex: 1; text-align: center; }
        .top-line { margin-top: 2mm; border-top: 1px dashed #64748b; }
        .top-void { position: absolute; top: 40%; left: 0; right: 0; text-align: center; font-size: 64pt; font-weight: 800;
          color: rgba(220,38,38,.18); transform: rotate(-20deg); pointer-events: none; }
        @media print {
          html, body, #root, .top { background: #fff !important; }
          .top { padding: 0; }
          .top-no-print { display: none !important; }
          .top-sheet { box-shadow: none; margin: 0; }
          @page { size: A4 portrait; margin: 0; }
        }
      `}</style>

      <div className="top-toolbar top-no-print">
        <button className="btn btn-sm btn-primary" onClick={() => window.print()}>Print</button>
      </div>

      <div className="top-sheet">
        {to.status === 'cancelled' && <div className="top-void">CANCELLED</div>}
        <div className="top-head">
          <div className="top-logo" style={{ fontSize: 26, fontWeight: 800, color: '#2E3F1C' }}>{COMPANY.short}</div>
          <div className="top-addr">
            <strong>{COMPANY.name}</strong><br />
            {COMPANY.addressLine1}{COMPANY.addressLine1 && <br />}
            {COMPANY.addressLine2}{COMPANY.addressLine2 && <br />}
            {COMPANY.phone && <>Tel. {COMPANY.phone}<br /></>}
            {COMPANY.website}
          </div>
        </div>
        {/* The order's memo prints under Transfer To, as the screen shows it (asked 2026-10-21); the
            lines' memos stay off the printout (asked 2026-10-07). */}
        <div className="top-title">Transfer Order</div>
        <div className="top-cols">
          <div>
            <div>Withdraw From : {to.withdraw_from_name || ''}</div>
            <div>Transfer To : {to.transfer_to_name || ''}</div>
            {to.memo && <div style={{ whiteSpace: 'pre-wrap' }}>Memo : {to.memo}</div>}
            <div>Requestor : {to.requestor_name || ''}</div>
            {to.job_order_no && <div>Job Order : {to.job_order_no}</div>}
          </div>
          <div>
            <div>TO # : {to.to_no}</div>
            <div>Date : {longDate(to.date_created)}</div>
            <div>Date Needed : {longDate(to.date_needed)}</div>
            <div>Status : {STATUS[to.status] || to.status}</div>
          </div>
        </div>
        <table className="top-table">
          <thead>
            <tr>
              <th style={{ width: '4%' }}>#</th>
              <th style={{ width: '15%' }}>Item Code</th>
              <th>Description</th>
              <th style={{ width: '13%' }}>JO #</th>
              <th className="top-num" style={{ width: '9%' }}>Qty</th>
              <th style={{ width: '8%' }}>Unit</th>
              <th className="top-num" style={{ width: '9%' }}>Fulfilled</th>
              <th className="top-num" style={{ width: '9%' }}>Received</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && <tr><td colSpan={8} style={{ textAlign: 'center' }}>No items.</td></tr>}
            {lines.map((l, i) => (
              <tr key={l.id}>
                <td>{i + 1}</td>
                <td>{l.item_code}</td>
                <td>{l.item_name}</td>
                <td>{l.job_order_no || ''}</td>
                {/* The quantity being asked for: the adjusted one where the warehouse changed it.
                    new_qty is stored 0.0000 rather than NULL when nobody changed it (67,746 lines,
                    2026-10-05), so `new_qty ?? qty` printed 0 for TO-39365's 30 SHT. */}
                <td className="top-num">{qty(l.adjusted_qty ?? (Number(l.new_qty) > 0 ? l.new_qty : l.qty))}</td>
                <td>{l.unit || ''}</td>
                <td className="top-num">{qty(l.fulfilled)}</td>
                <td className="top-num">{qty(l.received)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="top-count">{lines.length} item(s)</div>
        <div className="top-sign">
          {sign('Requested By:', to.requestor_name)}
          {sign('Prepared By:', to.created_by_name)}
          {sign('Approved By:', '')}
          {sign('Released By:', to.fulfilled_by_name)}
          {sign('Received By:', '')}
        </div>
      </div>
    </div>
  );
}
