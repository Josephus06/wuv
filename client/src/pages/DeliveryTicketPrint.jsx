import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import PrintLetterhead from '../components/PrintLetterhead';
import { COMPANY } from '../config/company';
import { qtyText } from '../utils/invoicePrint';
import { displayDate } from '../utils/dates';

// The DELIVERY TICKET print, laid out as the source system's own: letterhead, Sold To / Address /
// Business Style beside the ticket number, date and term, then the items -- description, quantity
// and units only, no prices, since this is the paper that travels with the goods -- with the
// Sales Order it came from as the table's last row. Terms and Conditions and the customer's
// receiving signature sit at the foot of the page.
//
// One A4 portrait sheet; the footer is pinned to the bottom of the page in print, so a short
// ticket still has the signature box where the customer expects it.
// The company's name and its courts' city come from config/company.js; with no jurisdiction set the
// litigation sentence is left off rather than naming another company's city.
const TERMS = `Make all cheques payable to ${COMPANY.name}. Our responsibility cease when merchandise is/are `
  + 'delivered to carrier in good order and condition. In case of default in payment of the total amount '
  + 'or part thereof, the unpaid amount shall be bear 2.5% interest monthly from date of default plus 25% '
  + 'of the amount due of the account is turned over to attorney for collection.'
  + (COMPANY.jurisdiction
    ? ' In case of litigation arising from this transaction, parties hereby agree to submit themselves to the '
      + `jurisdiction of the courts of ${COMPANY.jurisdiction} without anyway attempting to divert jurisdiction to any other court.`
    : '');

export default function DeliveryTicketPrint() {
  const { id } = useParams();
  const [dt, setDt] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/delivery-tickets/${id}`)
      .then(({ data }) => setDt(data))
      .catch((err) => setError(err.response?.data?.error || 'This Delivery Ticket could not be loaded.'));
  }, [id]);

  if (error) return <div className="card" style={{ margin: 24, padding: 24 }}>{error}</div>;
  if (!dt) return <LoadingSpinner />;

  const lines = dt.lines || [];

  return (
    <div className="estimate-print">
      <style>{`
        @page { size: A4 portrait; margin: 12mm; }
        .dtp-sheet { display: flex; flex-direction: column; min-height: 1000px; }
        .dtp-head { display: flex; justify-content: space-between; gap: 24px; font-size: 12px; margin-bottom: 22px; }
        .dtp-head > div:first-child { flex: 1; }
        .dtp-head > div:last-child { min-width: 180px; }
        .dtp-head div div { margin-bottom: 3px; }
        .dtp-items { width: 100%; border-collapse: collapse; table-layout: fixed; }
        .dtp-items th, .dtp-items td {
          border: 1px solid #ccc; padding: 6px 6px; font-size: 12px; text-align: left;
          white-space: normal; vertical-align: top;
        }
        .dtp-items th { font-weight: 500; color: #333; padding: 10px 6px; }
        .dtp-items col.c-no { width: 5%; }
        .dtp-items col.c-desc { width: 77%; }
        .dtp-items col.c-qty { width: 9%; }
        .dtp-items col.c-units { width: 9%; }
        .dtp-items .c-no-cell { text-align: center; }
        .dtp-items .dtp-order { color: #666; font-size: 11px; }
        .dtp-desc { overflow-wrap: anywhere; }
        .dtp-foot { margin-top: auto; padding-top: 28px; display: flex; gap: 6px; break-inside: avoid; page-break-inside: avoid; }
        .dtp-box { border: 1px solid #555; padding: 6px 8px; font-size: 9.5px; line-height: 1.35; }
        .dtp-terms { flex: 1.45; }
        .dtp-recv { flex: 1; }
        .dtp-box h5 { margin: 0 0 4px; font-size: 9.5px; font-weight: 600; }
        .dtp-sig { margin-top: 14px; display: flex; gap: 8px; align-items: flex-end; }
        .dtp-sig .line { flex: 1; text-align: center; border-top: 1px dashed #555; padding-top: 2px; }
        @media print {
          .estimate-print .print-sheet { padding: 0; }
          .dtp-sheet { min-height: 270mm; }
        }
      `}</style>

      <div className="print-toolbar">
        <button className="btn btn-primary" onClick={() => window.print()}>Print</button>
      </div>

      <div className="print-sheet dtp-sheet">
        <PrintLetterhead />
        <h2 className="print-title">Delivery Ticket</h2>

        <div className="dtp-head">
          <div>
            <div><strong>SOLD TO :</strong> {dt.customer_name}</div>
            <div>Address : {dt.customer_address || ''}</div>
            <div>Business Style : {dt.business_style || ''}</div>
          </div>
          <div>
            <div><strong>Delivery Ticket # :</strong> {dt.dt_no}</div>
            <div>Date : {displayDate(dt.date_created)}</div>
            <div>Term : {dt.term || ''}</div>
            <div>PO # : {dt.po_no || ''}</div>
          </div>
        </div>

        <table className="dtp-items">
          <colgroup>
            <col className="c-no" /><col className="c-desc" /><col className="c-qty" /><col className="c-units" />
          </colgroup>
          <thead>
            <tr><th className="c-no-cell">#</th><th>Description</th><th>Quantity</th><th>Units</th></tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr><td colSpan={4} style={{ textAlign: 'center' }}>No items on this delivery ticket.</td></tr>
            )}
            {lines.map((l, idx) => (
              <tr key={l.id}>
                <td className="c-no-cell">{idx + 1}</td>
                <td className="dtp-desc">{l.description}</td>
                <td>{qtyText(l.quantity)}</td>
                <td>{l.units}</td>
              </tr>
            ))}
            {dt.sales_order_no && (
              <tr><td /><td className="dtp-order">Order ID : {dt.sales_order_no}</td><td /><td /></tr>
            )}
          </tbody>
        </table>

        <div className="dtp-foot">
          <div className="dtp-box dtp-terms">
            <h5>TERMS AND CONDITIONS:</h5>
            {TERMS}
          </div>
          <div className="dtp-box dtp-recv">
            <div>Received the above articles good order and condition</div>
            <div className="dtp-sig"><span>By :</span><span className="line">Name and Signature</span></div>
            <div className="dtp-sig"><span>On :</span><span className="line">Date</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}
