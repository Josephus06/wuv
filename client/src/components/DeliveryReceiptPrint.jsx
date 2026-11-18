import PrintLetterhead from './PrintLetterhead';
import { money, qtyText, billingAddress as billingAddressOf } from '../utils/invoicePrint';
import { displayDate } from '../utils/dates';

// The DELIVERY RECEIPT, rebuilt to match the live system's own DR print.
//
// A DR is not a Service Invoice: it is not BIR-registered stationery, so it has no pre-printed
// pad and no VATable / Zero-Rated / VAT-Exempt breakdown. What it is, is the document the
// customer signs to say the goods arrived -- so the money columns are there only to identify
// what was delivered, and the weight of the page sits on the acknowledgement panel at the foot.
//
// It is laid out in the house print style (.print-sheet / .print-letterhead / .print-title, and
// the same info grid the Price Quotation uses) rather than in the export-invoice grid of Type 2,
// because that is what the live DR looks like and what the rest of this app's paper looks like.
// The line table is scoped to .dr-* instead of reusing .print-items-table: that class hard-codes
// nine column widths and right-aligns everything from the fourth column on, and this form has
// six columns with Description in the middle.
//
// DATE FORMAT. The app's own "28 Sept 2026" (utils/dates.js), NOT the yyyy-mm-dd the two invoice
// formats print. The numeric date is an exception earned by the Service Invoice -- a document
// that is filed, sorted and keyed into the customer's own books. A DR is signed and handed over,
// and the live one spells its month out too.
export default function DeliveryReceiptPrint({ si }) {
  const lines = si.lines || [];
  // The DR totals what was delivered, so it adds the lines it actually prints. The header's
  // gross_amount is the INVOICE's total and can differ from the sum of its lines on migrated
  // rows (see invoiceTotals) -- on a receipt the customer is signing, the figure has to be the
  // one they can add up themselves.
  const total = lines.reduce((s, l) => s + Number(l.gross_amount || 0), 0);
  // Billing address: the one typed on this invoice, else the customer's own Bill To Address,
  // else any address on file for them.
  const billingAddress = billingAddressOf(si);
  const orderNo = si.order_ref_no || si.sales_order_no || '';

  return (
    <div className="estimate-print">
      <style>{`
        /* The acknowledgement sits at the FOOT of the page however short the receipt (asked
           2026-10-06), the way the Delivery Ticket's does: the sheet is a page-tall column and the
           box takes the space left with margin-top: auto. A receipt that runs past one page simply
           ends with it, after the last line. */
        @page { size: A4 portrait; margin: 12mm; }
        .dr-sheet { display: flex; flex-direction: column; min-height: 1000px; }
        @media print {
          .estimate-print .print-sheet.dr-sheet { padding: 0; }
          .dr-sheet { min-height: 270mm; }
        }
        .dr-items { width: 100%; table-layout: fixed; border-collapse: collapse; margin-bottom: 16px; }
        /* white-space is reset explicitly: the app's global "th, td { white-space: nowrap }"
           applies outside .table-wrap, and these descriptions run to 200 characters. */
        .dr-items th, .dr-items td {
          border-bottom: 1px solid #ddd; padding: 8px 6px; font-size: 12px;
          text-align: left; white-space: normal; vertical-align: top;
        }
        .dr-items th { color: #555; font-weight: 600; }
        .dr-items col.dr-c-no { width: 5%; }
        .dr-items col.dr-c-qty { width: 11%; }
        .dr-items col.dr-c-units { width: 10%; }
        .dr-items col.dr-c-desc { width: 42%; }
        .dr-items col.dr-c-price { width: 16%; }
        .dr-items col.dr-c-amount { width: 16%; }
        /* A description with no break opportunity -- a part code, a pasted URL -- would spill
           over the figures beside it in a fixed-layout column. */
        .dr-items .dr-desc { overflow-wrap: anywhere; }
        .dr-items .dr-num { text-align: right; }
        .dr-items .dr-mid { text-align: center; }
        .dr-items tfoot td { border-bottom: none; border-top: 1px solid #999; font-weight: 700; padding-top: 10px; }
        /* The acknowledgement. Boxed, because it is the part of the page that is signed, and
           kept off a page break so a signature can never land away from what it acknowledges. */
        /* Inset 2px each side: full-width, its right border sat exactly on the printable edge and
           print scaling rounded it off the page (2026-10-06, "the right part of the box is gone"). */
        .dr-ack {
          border: 1px solid #999; padding: 14px 16px 18px; margin: auto 2px 0;
          break-inside: avoid; page-break-inside: avoid;
        }
        .dr-ack-gap { height: 28px; flex-shrink: 0; }
        .dr-ack-text { font-size: 12px; margin: 0 0 34px; }
        .dr-ack-row { display: flex; justify-content: space-between; gap: 32px; text-align: center; }
        .dr-ack-row > div { flex: 1; }
        .dr-ack-name { margin-bottom: 4px; }
        .dr-ack-line { border-top: 1px solid #999; padding-top: 4px; color: #777; font-size: 11px; }
      `}</style>

      <div className="print-toolbar">
        <button className="btn btn-primary" onClick={() => window.print()}>Print</button>
      </div>

      <div className="print-sheet dr-sheet">
        <PrintLetterhead />

        <h2 className="print-title">Delivery Receipt</h2>

        <div className="print-info-grid">
          <div>
            <div><strong>Sold To :</strong> {si.customer_name}</div>
            <div><strong>Billing Address :</strong> {billingAddress}</div>
            <div><strong>TIN :</strong> {si.customer_tin}</div>
          </div>
          <div className="print-info-right">
            <div><strong>Delivery Receipt # :</strong> {si.invoice_no}</div>
            {/* The order this delivery is against -- what the customer's receiving clerk checks
                the goods off with. */}
            <div><strong>SO # :</strong> {orderNo}</div>
            <div><strong>PO # :</strong> {si.po_no}</div>
            <div><strong>Date :</strong> {displayDate(si.date_created)}</div>
            <div><strong>Term :</strong> {si.term}</div>
          </div>
        </div>

        <table className="dr-items">
          <colgroup>
            <col className="dr-c-no" />
            <col className="dr-c-qty" />
            <col className="dr-c-units" />
            <col className="dr-c-desc" />
            <col className="dr-c-price" />
            <col className="dr-c-amount" />
          </colgroup>
          <thead>
            <tr>
              <th>#</th>
              <th className="dr-num">Quantity</th>
              <th className="dr-mid">Units</th>
              <th>Description</th>
              <th className="dr-num">Unit Price</th>
              <th className="dr-num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr><td colSpan={6} className="dr-mid">No items on this delivery receipt.</td></tr>
            )}
            {lines.map((l, idx) => (
              <tr key={l.id}>
                <td>{idx + 1}.</td>
                <td className="dr-num">{qtyText(l.quantity)}</td>
                <td className="dr-mid">{l.units}</td>
                <td className="dr-desc">{l.description}</td>
                <td className="dr-num">{money(l.price_per_unit)}</td>
                <td className="dr-num">{money(l.gross_amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4} className="dr-num">Total :</td>
              <td />
              <td className="dr-num">{money(total)}</td>
            </tr>
          </tfoot>
        </table>

        {/* Keeps the old 28px clear of the total when the page is full and auto has nothing to give. */}
        <div className="dr-ack-gap" />
        <div className="dr-ack">
          <p className="dr-ack-text">Received the above articles good order and condition.</p>
          {/* Both sides are signed by hand at the door. Nothing is pre-filled here -- in
              particular NOT created_by_name, which is whoever keyed the invoice, not whoever
              drove it out, and is null on all 2,441 migrated DRs anyway. */}
          <div className="dr-ack-row">
            <div>
              <div className="dr-ack-name">&nbsp;</div>
              <div className="dr-ack-line">Received By (Signature Over Printed Name) / Date</div>
            </div>
            <div>
              <div className="dr-ack-name">&nbsp;</div>
              <div className="dr-ack-line">Delivered By</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
