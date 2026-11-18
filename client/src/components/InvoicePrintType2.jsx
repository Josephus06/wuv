import { money, qtyText, formatDate, paginate, CURRENCY, billingAddress } from '../utils/invoicePrint';

// TYPE 2 -- the export-style INVOICE. Unlike Type 1 this uses NO pre-printed stationery:
// the page draws its own title, boxes, column headings and rules, so it prints on plain
// paper. Layout follows the supplied template: title + DATE/INV. NO/MARK block, a bill-to
// panel, a PROJECT / PAYMENT / DELIVERY TERMS band, then
// Item | PO# | JO# | Item Code | Description | QTY | Unit Price | Amount
// closing with a TOTAL AMOUNT row and the Supplier / Export Department / Issued by footer.
const ROWS_PER_PAGE = 20;

export default function InvoicePrintType2({ si, totals }) {
  const pages = paginate(si.lines || [], ROWS_PER_PAGE);

  return (
    <>
      <style>{`
        .t2-sheet {
          width: 210mm;
          min-height: 297mm;
          margin: 0 auto 16px;
          padding: 10mm;
          background: #fff;
          color: #000;
          font-family: Arial, Helvetica, sans-serif;
          font-size: 9pt;
          box-shadow: 0 1px 6px rgba(0,0,0,.25);
          display: flex;
          flex-direction: column;
        }
        .t2-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        /* white-space and padding are reset explicitly: the app's global "th, td" rule sets
           nowrap, which makes long descriptions run straight over the QTY column. */
        .t2-table td, .t2-table th {
          border: 1px solid #000; padding: 2px 4px; vertical-align: top;
          white-space: normal; overflow-wrap: break-word;
        }
        .t2-title { font-size: 26pt; font-style: italic; font-weight: 700; letter-spacing: 1px; padding-left: 10mm !important; }
        .t2-lbl { font-size: 8pt; font-weight: 700; }
        .t2-band { text-align: center; font-weight: 700; font-size: 8pt; }
        .t2-head td { text-align: center; font-size: 8pt; font-weight: 700; }
        .t2-billto { height: 26mm; }
        .t2-mark { height: 26mm; }
        .t2-num { text-align: right; }
        .t2-mid { text-align: center; }
        .t2-row { height: 6mm; }
        .t2-total td { font-weight: 700; }
        .t2-total .t2-amt { text-decoration: underline; text-align: right; }
        .t2-foot { margin-top: auto; }
        .t2-foot table { width: 100%; border-collapse: collapse; }
        .t2-foot td { border: 1px solid #000; padding: 4px 6px; font-size: 8pt; height: 9mm; vertical-align: top; }
        .t2-supplier { height: 14mm !important; }
        @media print {
          @page { size: A4 portrait; margin: 0; }
          .t2-sheet { box-shadow: none; margin: 0; page-break-after: always; }
          .t2-sheet:last-child { page-break-after: auto; }
        }
      `}</style>

      {pages.map((pageLines, pageIdx) => {
        const isLast = pageIdx === pages.length - 1;
        return (
          <div className="t2-sheet" key={pageIdx}>
            <table className="t2-table">
              <colgroup>
                <col style={{ width: '7%' }} />
                <col style={{ width: '11%' }} />
                <col style={{ width: '13%' }} />
                <col style={{ width: '15%' }} />
                {/* QTY carries the PAYMENT heading in the band above it, so it cannot go
                    narrower than that word without breaking it mid-way. */}
                <col style={{ width: '24%' }} />
                <col style={{ width: '10%' }} />
                <col style={{ width: '10%' }} />
                <col style={{ width: '10%' }} />
              </colgroup>
              <tbody>
                <tr>
                  <td className="t2-title" colSpan={5} rowSpan={2}>{si.invoice_type === 'DR' ? 'DELIVERY RECEIPT' : 'INVOICE'}</td>
                  <td className="t2-lbl">DATE:</td>
                  <td colSpan={2}>{formatDate(si.date_created)}</td>
                </tr>
                <tr>
                  <td className="t2-lbl">INV. NO:</td>
                  <td colSpan={2}>{si.invoice_no}</td>
                </tr>
                <tr>
                  {/* The template leaves this panel unlabelled; it is the bill-to block. */}
                  <td className="t2-billto" colSpan={5}>
                    <div style={{ fontWeight: 700 }}>{si.customer_name}</div>
                    {si.customer_tin && <div>TIN: {si.customer_tin}</div>}
                    <div>{billingAddress(si)}</div>
                  </td>
                  <td className="t2-mark" colSpan={3}>
                    <span className="t2-lbl">MARK:</span>
                  </td>
                </tr>
                <tr>
                  <td className="t2-band" colSpan={5}>PROJECT</td>
                  <td className="t2-band">PAYMENT</td>
                  <td className="t2-band" colSpan={2}>DELIVERY TERMS</td>
                </tr>
                <tr>
                  {/* memo is the only free-text descriptor an invoice carries, so it stands in
                      for PROJECT; term is a credit term ("30 DAYS"), the closest thing this
                      schema has to the template's PAYMENT ("T/T"). DELIVERY TERMS has no
                      source at all and stays blank rather than being invented. */}
                  <td colSpan={5}>{si.memo || ''}</td>
                  <td className="t2-mid">{si.term || ''}</td>
                  <td colSpan={2}>&nbsp;</td>
                </tr>
                {/* The column headings stay inside this tbody as an ordinary row: a <thead>
                    is hoisted to the top of the table by the browser regardless of source
                    order, which would print it above the INVOICE title. */}
                <tr className="t2-head">
                  <td>Item</td>
                  <td>PO#</td>
                  <td>JO#</td>
                  <td>Item Code</td>
                  <td>Description</td>
                  <td>QTY</td>
                  <td>Unit Price</td>
                  <td>Amount</td>
                </tr>
                {pageLines.map((l, rowIdx) => (
                  <tr className="t2-row" key={l.id}>
                    <td className="t2-mid">{pageIdx * ROWS_PER_PAGE + rowIdx + 1}</td>
                    <td>{si.po_no || ''}</td>
                    <td>{l.job_order_no || ''}</td>
                    <td>{l.item_code || ''}</td>
                    <td>{l.description}</td>
                    <td className="t2-num">{qtyText(l.quantity)}</td>
                    <td className="t2-num">{money(l.price_per_unit)}</td>
                    <td className="t2-num">{money(l.gross_amount)}</td>
                  </tr>
                ))}
                {isLast && (
                  <tr className="t2-total">
                    <td colSpan={4} />
                    <td className="t2-mid">TOTAL AMOUNT</td>
                    <td className="t2-num">{qtyText(totals.quantity)}</td>
                    <td />
                    <td className="t2-amt">{CURRENCY.symbol}{money(totals.totalSales)}</td>
                  </tr>
                )}
              </tbody>
            </table>

            {isLast && (
              <div className="t2-foot">
                <table>
                  <tbody>
                    <tr><td className="t2-supplier" colSpan={2}>Supplier :</td></tr>
                    <tr>
                      <td style={{ width: '50%' }}>Export Department:</td>
                      <td>Issued by:</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
