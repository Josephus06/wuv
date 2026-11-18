import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import { COMPANY } from '../config/company';
import { amountInWords } from '../utils/amountInWords';

// Fund Transfer Voucher, as the old system prints it: A4, letterhead, the two accounts, the GL entry
// (DR the To account / CR the From account), the total, then Prepared / Checked / Approved and
// Received sign-off lines. Printing is gated server-side (GET /fund-transfers/:id/print, can_print).

const money = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Paper keeps the source's own date format: "Sep 30, 2026".
const longDate = (v) => (v ? new Date(`${String(v).slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : '');

export default function FundTransferPrint() {
  const { id } = useParams();
  const [ft, setFt] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/fund-transfers/${id}/print`)
      .then(({ data }) => setFt(data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load this Fund Transfer.'));
  }, [id]);

  if (error) {
    return (
      <div style={{ maxWidth: 620, margin: '80px auto', padding: 24, textAlign: 'center', font: '14px/1.6 system-ui, sans-serif' }}>
        <h2 style={{ marginBottom: 8 }}>Can&rsquo;t print this Fund Transfer</h2>
        <p style={{ color: '#64748b' }}>{error}</p>
      </div>
    );
  }
  if (!ft) return <LoadingSpinner />;

  const sign = (label, i) => (
    <div key={label}>
      <div>{label}</div>
      <div className="sig-ink" style={{ '--sig-h': '8mm' }}>
        {i === 0 && ft.prepared_signature ? <img src={ft.prepared_signature} alt="" /> : null}
      </div>
      <div className="ftp-line" />
      <div style={{ minHeight: '1.4em' }}>{i === 0 ? (ft.prepared_by_name || '') : ''}</div>
    </div>
  );

  return (
    <div className="ftp">
      <style>{`
        .ftp { background: #f1f5f9; padding: 16px 0 40px; }
        .ftp-toolbar { max-width: 210mm; margin: 0 auto 12px; display: flex; justify-content: flex-end; gap: 8px; }
        .ftp-sheet { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 14mm 16mm; background: #fff; color: #1f2937;
          font-family: system-ui, 'Segoe UI', sans-serif; font-size: 8.5pt; line-height: 1.5; box-shadow: 0 1px 6px rgba(0,0,0,.25);
          display: flex; flex-direction: column; position: relative; box-sizing: border-box; }
        .ftp-head { display: flex; justify-content: space-between; align-items: flex-start; }
        .ftp-logo { width: 62mm; height: auto; }
        .ftp-addr { text-align: right; font-size: 7.5pt; color: #475569; line-height: 1.45; }
        .ftp-title { text-align: center; font-size: 12pt; font-weight: 600; margin: 8mm 0 7mm; }
        .ftp-cols { display: flex; justify-content: space-between; gap: 12mm; }
        .ftp-cols > div { flex: 1; }
        .ftp-table { width: 100%; border-collapse: collapse; margin-top: 8mm; font-size: 8pt; table-layout: fixed; }
        .ftp-table th, .ftp-table td { border: 1px solid #cbd5e1; padding: 4px 3px; font-weight: 400; background: none; white-space: normal; overflow-wrap: anywhere; }
        .ftp-table th { color: #334155; text-align: left; }
        .ftp-num { text-align: right !important; }
        .ftp-total { margin-top: auto; text-align: right; padding: 4mm 0 8mm; }
        .ftp-sign { display: flex; justify-content: space-between; gap: 6mm; padding: 0 4mm; }
        .ftp-sign > div { flex: 1; text-align: center; }
        .ftp-received { display: flex; justify-content: center; padding: 4mm 4mm 6mm; }
        .ftp-received > div { width: 33%; text-align: center; }
        .ftp-line { margin-top: 2mm; border-top: 1px dashed #64748b; }
        .ftp-void { position: absolute; top: 40%; left: 0; right: 0; text-align: center; font-size: 64pt; font-weight: 800;
          color: rgba(220,38,38,.18); transform: rotate(-20deg); pointer-events: none; }
        @media print {
          html, body, #root, .ftp { background: #fff !important; }
          .ftp { padding: 0; }
          .ftp-no-print { display: none !important; }
          .ftp-sheet { box-shadow: none; margin: 0; }
          @page { size: A4 portrait; margin: 0; }
        }
      `}</style>

      <div className="ftp-toolbar ftp-no-print">
        <button className="btn btn-sm btn-primary" onClick={() => window.print()}>Print</button>
      </div>

      <div className="ftp-sheet">
        {ft.status === 'void' && <div className="ftp-void">VOID</div>}
        <div className="ftp-head">
          <div className="ftp-logo" style={{ fontSize: 26, fontWeight: 800, color: '#2E3F1C' }}>{COMPANY.short}</div>
          <div className="ftp-addr">
            <strong>{COMPANY.name}</strong><br />
            {COMPANY.addressLine1}{COMPANY.addressLine1 && <br />}
            {COMPANY.addressLine2}{COMPANY.addressLine2 && <br />}
            {COMPANY.phone && <>Tel. {COMPANY.phone}<br /></>}
            {COMPANY.website}
          </div>
        </div>
        <div className="ftp-title">Fund Transfer Voucher</div>
        <div className="ftp-cols">
          <div>
            <div>Date : {longDate(ft.date_created)}</div>
            <div>From Account : {ft.from_account_name || ''}</div>
            <div>To Account : {ft.to_account_name || ''}</div>
            {ft.memo && <div>Memo : {ft.memo}</div>}
          </div>
          <div>
            <div>Trans. # : {ft.ft_no}</div>
            <div>Amount in words : {amountInWords(ft.amount)}</div>
          </div>
        </div>
        <table className="ftp-table">
          <thead>
            <tr>
              <th style={{ width: '20%' }}>Account Code</th>
              <th className="ftp-num">Account Title</th>
              <th className="ftp-num" style={{ width: '15%' }}>Debit</th>
              <th className="ftp-num" style={{ width: '15%' }}>Credit</th>
            </tr>
          </thead>
          <tbody>
            {ft.lines.map((l, i) => (
              <tr key={i}>
                <td>{l.account_code}</td>
                <td>{l.account_name}</td>
                <td className="ftp-num">{money(l.debit)}</td>
                <td className="ftp-num">{money(l.credit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="ftp-total">Total : {money(ft.amount)}</div>
        <div className="ftp-sign">{['Prepared By:', 'Checked By:', 'Approved By:'].map(sign)}</div>
        <div className="ftp-received">{sign('Received BY:', 3)}</div>
      </div>
    </div>
  );
}
