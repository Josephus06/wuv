import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import { COMPANY } from '../config/company';
import { amountInWords } from '../utils/amountInWords';

// Commission Voucher, printed as the old system prints it (2026-10-26) -- a "Payment Voucher": A4,
// letterhead, Date / Paid To / Payee Name / Memo, Ref # and the amount in words, then the voucher's
// GL entry (Account Code, Month -- the commission month on each Commission Payable debit --, Account
// Title, Debit, Credit), the total, and Prepared / Checked / Approved / Received sign-off lines.
// Printing is gated server-side (GET /commission-vouchers/:id/print, can_print).

const money = (v) => {
  const n = Number(v || 0);
  return n ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
};
// Paper keeps the source's own date format: "Sep 30, 2026".
const longDate = (v) => (v ? new Date(`${String(v).slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : '');
const monthName = (v) => (v ? new Date(`${String(v).slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'long' }) : '');

export default function CommissionVoucherPrint() {
  const { id } = useParams();
  const [cv, setCv] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/commission-vouchers/${id}/print`)
      .then(({ data }) => setCv(data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load this Commission Voucher.'));
  }, [id]);
  useEffect(() => { if (cv) document.title = `${cv.voucher_no} ${cv.employee_name || ''}`.trim(); }, [cv]);

  if (error) {
    return (
      <div style={{ maxWidth: 620, margin: '80px auto', padding: 24, textAlign: 'center', font: '14px/1.6 system-ui, sans-serif' }}>
        <h2 style={{ marginBottom: 8 }}>Can&rsquo;t print this Commission Voucher</h2>
        <p style={{ color: '#64748b' }}>{error}</p>
      </div>
    );
  }
  if (!cv) return <LoadingSpinner />;

  const total = Number(cv.total_payments || 0);
  const sign = (label, i) => (
    <div key={label}>
      <div>{label}</div>
      <div className="sig-ink" style={{ '--sig-h': '8mm' }}>
        {i === 0 && cv.prepared_signature ? <img src={cv.prepared_signature} alt="" /> : null}
      </div>
      <div className="cvp-line" />
      <div style={{ minHeight: '1.4em' }}>{i === 0 ? (cv.created_by_name || '') : ''}</div>
    </div>
  );

  return (
    <div className="cvp">
      <style>{`
        .cvp { background: #f1f5f9; padding: 16px 0 40px; }
        .cvp-toolbar { max-width: 210mm; margin: 0 auto 12px; display: flex; justify-content: flex-end; gap: 8px; }
        .cvp-sheet { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 14mm 16mm; background: #fff; color: #1f2937;
          font-family: system-ui, 'Segoe UI', sans-serif; font-size: 8.5pt; line-height: 1.5; box-shadow: 0 1px 6px rgba(0,0,0,.25);
          display: flex; flex-direction: column; position: relative; box-sizing: border-box; }
        .cvp-head { display: flex; justify-content: space-between; align-items: flex-start; }
        .cvp-logo { width: 62mm; height: auto; }
        .cvp-addr { text-align: right; font-size: 7.5pt; color: #475569; line-height: 1.45; }
        .cvp-title { text-align: center; font-size: 12pt; font-weight: 600; margin: 8mm 0 7mm; }
        .cvp-cols { display: flex; justify-content: space-between; gap: 12mm; }
        .cvp-cols > div { flex: 1; }
        .cvp-table { width: 100%; border-collapse: collapse; margin-top: 8mm; font-size: 8pt; table-layout: fixed; }
        .cvp-table th, .cvp-table td { border: 1px solid #cbd5e1; padding: 4px 3px; font-weight: 400; background: none; white-space: normal; overflow-wrap: anywhere; }
        .cvp-table th { color: #334155; text-align: left; }
        .cvp-num { text-align: right !important; }
        .cvp-total { margin-top: auto; text-align: right; padding: 4mm 0 8mm; }
        .cvp-sign { display: flex; justify-content: space-between; gap: 6mm; padding: 0 4mm; }
        .cvp-sign > div { flex: 1; text-align: center; }
        .cvp-received { display: flex; justify-content: center; padding: 4mm 4mm 6mm; }
        .cvp-received > div { width: 33%; text-align: center; }
        .cvp-line { margin-top: 2mm; border-top: 1px dashed #64748b; }
        .cvp-void { position: absolute; top: 40%; left: 0; right: 0; text-align: center; font-size: 64pt; font-weight: 800;
          color: rgba(220,38,38,.18); transform: rotate(-20deg); pointer-events: none; }
        @media print {
          html, body, #root, .cvp { background: #fff !important; }
          .cvp { padding: 0; }
          .cvp-no-print { display: none !important; }
          .cvp-sheet { box-shadow: none; margin: 0; }
          @page { size: A4 portrait; margin: 0; }
        }
      `}</style>

      <div className="cvp-toolbar cvp-no-print">
        <button className="btn btn-sm btn-primary" onClick={() => window.print()}>Print</button>
      </div>

      <div className="cvp-sheet">
        {cv.status === 'void' && <div className="cvp-void">VOID</div>}
        <div className="cvp-head">
          <div className="cvp-logo" style={{ fontSize: 26, fontWeight: 800, color: '#2E3F1C' }}>{COMPANY.short}</div>
          <div className="cvp-addr">
            <strong>{COMPANY.name}</strong><br />
            {COMPANY.addressLine1}{COMPANY.addressLine1 && <br />}
            {COMPANY.addressLine2}{COMPANY.addressLine2 && <br />}
            {COMPANY.phone && <>Tel. {COMPANY.phone}<br /></>}
            {COMPANY.website}
          </div>
        </div>
        <div className="cvp-title">Payment Voucher</div>
        <div className="cvp-cols">
          <div>
            <div>Date : {longDate(cv.date_created)}</div>
            <div>Paid To : {cv.employee_name || ''}</div>
            <div>Payee Name : {cv.payee_name || cv.employee_name || ''}</div>
            <div>Memo : {cv.memo || ''}</div>
          </div>
          <div>
            <div>Trans. # : {cv.voucher_no}</div>
            <div>Ref # : {cv.reference_no || ''}</div>
            <div>Amount in words : {amountInWords(total)}</div>
          </div>
        </div>
        <table className="cvp-table">
          <thead>
            <tr>
              <th style={{ width: '15%' }}>Account Code</th>
              <th style={{ width: '14%' }}>Month</th>
              <th>Account Title</th>
              <th className="cvp-num" style={{ width: '15%' }}>Debit</th>
              <th className="cvp-num" style={{ width: '15%' }}>Credit</th>
            </tr>
          </thead>
          <tbody>
            {(cv.entries || []).map((l, i) => (
              <tr key={i}>
                <td>{l.account_code}</td>
                <td>{monthName(l.month)}</td>
                <td>{l.account_name}</td>
                <td className="cvp-num">{money(l.debit)}</td>
                <td className="cvp-num">{money(l.credit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="cvp-total">Total : {Number(total).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        <div className="cvp-sign">{['Prepared By:', 'Checked By:', 'Approved By:'].map(sign)}</div>
        <div className="cvp-received">{sign('Received BY:', 3)}</div>
      </div>
    </div>
  );
}
