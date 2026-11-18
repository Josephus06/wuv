import { money, qtyText, formatDate, layoutPages, billingAddress } from '../utils/invoicePrint';

// TYPE 1 -- overlay for the PRE-PRINTED "SERVICE INVOICE" pad.
//
// The physical form already carries the letterhead, column headings, the totals labels and
// every rule and box. So this prints DATA ONLY -- no titles, no borders, no table chrome --
// positioned to land inside the form's blanks. That is why it looks half-empty on screen:
// what you see is only the overlay, not the document.
//
// CALIBRATION: every position lives in FORM below, in millimetres from the top-left of the
// sheet. Nothing else in this file needs editing to fit the paper. Turn on the guides to
// overlay a 10mm grid and outline each field, print that onto a real form, and nudge the
// numbers until the data sits in the blanks.
export const FORM = {
  // The physical CEBU GRAPHICSTAR "SERVICE INVOICE" pad measures 8.3 x 5.4 inches. Every
  // coordinate below is millimetres from the top-left of THAT FORM, never of the paper it is
  // fed on -- `sheet` below carries the paper, so moving the form around the sheet costs
  // nothing in re-calibration.
  page: { width: 210.8, height: 137.2 },

  // The paper that actually goes through the printer: A4 portrait, with the pre-printed form
  // occupying the top band of it. `formTop` is how far down the sheet the form starts -- raise
  // it if the pad is fed lower down.
  sheet: { width: 210, height: 297, formTop: 0 },

  baseFontPt: 7.5,
  fontFamily: "'Courier New', Courier, monospace", // monospace keeps columns aligned in the blanks

  // Header blanks. The form prints its own "Sold to :", "TIN:" and "Address:" labels at the
  // left, so these x values sit just past them. NOTE: the form's serial (the red "No. 03041")
  // is pre-printed and is the document's legal identity -- we must never print over it, which
  // is why there is no invoice-number field here.
  // `bold: true` prints that blank in bold -- who the invoice is for, when it is dated and on
  // what terms, and the two figures anyone reading it looks for first. Everything else stays
  // regular weight so the emphasis means something.
  header: {
    customerName: { x: 30, y: 19, w: 105, bold: true },
    customerTin: { x: 30, y: 24, w: 105, bold: true },
    customerAddress: { x: 30, y: 27, w: 105, lines: 2, bold: true },
    date: { x: 175, y: 21, w: 26, bold: true },
    terms: { x: 175, y: 28, w: 26, lines: 2, bold: true },
  },

  // Line-item band: QUANTITY | UNIT | DESCRIPTION | UNIT PRICE | AMOUNT.
  // `right: true` means x is the RIGHT edge -- how the money columns align on the form.
  items: {
    top: 43,
    rowHeight: 5,
    // How far down the form the item band may run, counted in the pad's own 5mm rules: 7 x 5mm
    // = 35mm, so items occupy 43mm to 78mm and the Order ID / PO # lines land at 83 / 87mm, clear of
    // the totals at 95mm.
    //
    // It was 6. At 7.5pt a text line is 3.04mm, so a 30mm band held nine lines and a ten-item
    // invoice went onto a second pre-printed form -- INV-82896 needs eleven lines, because its
    // first description wraps. Eleven fit in 35mm. Raising this does NOT spread a sparse sheet
    // out: the pitch is still clamped at rowHeight, so anything up to seven items lands on the
    // printed rules exactly as before.
    rowsPerPage: 7,
    columns: {
      qty: { x: 24, w: 16, right: true },
      unit: { x: 28, w: 18 },
      description: { x: 48, w: 95 },
      unitPrice: { x: 171, w: 26, right: true },
      amount: { x: 201, w: 28, right: true },
    },
    // "Order ID : SO-#####" sits under the last item in the description area, "PO # : #####"
    // on the line below it.
    orderId: { x: 48, w: 95, gap: 5 },
    poNo: { x: 48, w: 95, gap: 9 },
  },

  // Totals band. Left block is the BIR VAT breakdown the form labels VATABLE (V) /
  // VAT-Exempt (E) / Zero Rated (Z) / VAT (12%); right block is Total Sales /
  // Less: Withholding Tax / TOTAL AMOUNT DUE.
  totals: {
    vatableSales: { x: 138, w: 22, y: 95, right: true, bold: true },
    vatExempt: { x: 138, w: 22, y: 100, right: true, bold: true },
    zeroRated: { x: 138, w: 22, y: 102, right: true, bold: true },
    vat: { x: 138, w: 26, y: 106, right: true, bold: true },
    totalSales: { x: 201, w: 28, y: 96, right: true, bold: true },
    lessWithholding: { x: 201, w: 28, y: 101, right: true, bold: true },
    amountDue: { x: 201, w: 28, y: 105, right: true, bold: true },
  },
};

// One positioned value. Renders nothing when empty so a blank never paints over the form.
function Field({ spec, children, calibrate, name }) {
  if (children === null || children === undefined || children === '') {
    return calibrate ? <Outline spec={spec} name={name} /> : null;
  }
  return (
    <>
      {calibrate && <Outline spec={spec} name={name} />}
      <div
        style={{
          position: 'absolute',
          left: `${spec.right ? spec.x - spec.w : spec.x}mm`,
          top: `${spec.y}mm`,
          width: `${spec.w}mm`,
          textAlign: spec.right ? 'right' : 'left',
          whiteSpace: spec.lines ? 'normal' : 'nowrap',
          overflow: 'hidden',
          fontWeight: spec.bold ? 700 : 400,
        }}
      >
        {children}
      </div>
    </>
  );
}

function Outline({ spec, name }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: `${spec.right ? spec.x - spec.w : spec.x}mm`,
        top: `${spec.y}mm`,
        width: `${spec.w}mm`,
        height: `${(spec.lines || 1) * 5}mm`,
        outline: '0.2mm dashed rgba(220,38,38,.7)',
        pointerEvents: 'none',
      }}
    >
      <span style={{ position: 'absolute', top: '-3.4mm', left: 0, fontSize: '5pt', color: '#dc2626' }}>{name}</span>
    </div>
  );
}

// 10mm grid so a test print can be measured against the real form.
function Grid({ page }) {
  const lines = [];
  for (let x = 10; x < page.width; x += 10) {
    lines.push(<div key={`v${x}`} style={{ position: 'absolute', left: `${x}mm`, top: 0, bottom: 0, width: 0, borderLeft: '0.1mm solid rgba(59,130,246,.35)' }} />);
    if (x % 50 === 0) lines.push(<div key={`vl${x}`} style={{ position: 'absolute', left: `${x + 0.5}mm`, top: '1mm', fontSize: '5pt', color: '#3b82f6' }}>{x}</div>);
  }
  for (let y = 10; y < page.height; y += 10) {
    lines.push(<div key={`h${y}`} style={{ position: 'absolute', top: `${y}mm`, left: 0, right: 0, height: 0, borderTop: '0.1mm solid rgba(59,130,246,.35)' }} />);
    if (y % 50 === 0) lines.push(<div key={`hl${y}`} style={{ position: 'absolute', top: `${y + 0.5}mm`, left: '1mm', fontSize: '5pt', color: '#3b82f6' }}>{y}</div>);
  }
  return <>{lines}</>;
}

// The Unit Price blank is the line's Gross Amount over its quantity -- the price actually billed per
// unit, discount taken off and VAT in -- so Unit Price x Qty = Amount (the line's Gross) on the
// paper. INV-81981: 23,682.00 / 150 = 157.88, where the list price 159.58 printed before.
// Falls back to the list price only when there is no quantity to divide by.
const grossUnitPrice = (l) => {
  const qty = Number(l.quantity);
  return qty > 0 ? Number(l.gross_amount || 0) / qty : l.price_per_unit;
};

export default function InvoicePrintType1({ si, totals, calibrate }) {
  const pages = layoutPages(si.lines || [], FORM);

  return (
    <>
      <style>{`
        .si-sheet {
          position: relative;
          width: ${FORM.sheet.width}mm;
          height: ${FORM.sheet.height}mm;
          margin: 0 auto 16px;
          background: #fff;
          color: #000;
          box-shadow: 0 1px 6px rgba(0,0,0,.25);
          /* The pad is a hair wider than the sheet; clipping that overhang stops the printer
             from seeing content past the paper edge and spilling a blank page after each. */
          overflow: hidden;
        }
        /* The overlay proper -- the coordinate space every FORM measurement is written in,
           parked wherever the pre-printed form sits on the sheet. */
        .si-form {
          position: absolute;
          left: 0;
          top: ${FORM.sheet.formTop}mm;
          width: ${FORM.page.width}mm;
          height: ${FORM.page.height}mm;
          font-family: ${FORM.fontFamily};
          font-size: ${FORM.baseFontPt}pt;
          line-height: 1.15;
        }
        @media print {
          /* The page box is the PAPER, not the form. Orientation has no switch of its own:
             the box being taller than it is wide IS portrait, and the form's own
             210.8 x 137.2mm sitting here -- wider than tall -- is what used to turn every
             sheet sideways. Lengths rather than the A4-portrait keyword pair, because CSS
             accepts a named size or lengths but never both -- and long bond, if this ever
             moves to it, has no CSS name at all.
             No margin: the pre-printed artwork is the margin, and any page offset would
             shift every field off its blank. */
          @page { size: ${FORM.sheet.width}mm ${FORM.sheet.height}mm; margin: 0; }
          /* On screen a sheet is a full page of paper; on paper it only has to be as tall
             as the form band. Leaving it at the page height risks rounding one hair past
             the box and ejecting a blank sheet after every invoice -- the break below is
             what starts the next one, not the height. */
          .si-sheet {
            box-shadow: none;
            margin: 0;
            height: ${FORM.sheet.formTop + FORM.page.height}mm;
            page-break-after: always;
          }
          .si-sheet:last-child { page-break-after: auto; }
        }
      `}</style>

      {pages.map((page, pageIdx) => {
        const isLast = pageIdx === pages.length - 1;
        return (
          <div className="si-sheet" key={pageIdx}>
            <div className="si-form">
              {calibrate && <Grid page={FORM.page} />}

              {/* Header blanks repeat on every sheet -- a continuation page is a second
                  pre-printed form with its own serial, so it has to identify its customer too. */}
              <Field spec={FORM.header.customerName} calibrate={calibrate} name="customerName">{si.customer_name}</Field>
              <Field spec={FORM.header.customerTin} calibrate={calibrate} name="customerTin">{si.customer_tin}</Field>
              <Field spec={FORM.header.customerAddress} calibrate={calibrate} name="customerAddress">
                {billingAddress(si)}
              </Field>
              <Field spec={FORM.header.date} calibrate={calibrate} name="date">{formatDate(si.date_created)}</Field>
              <Field spec={FORM.header.terms} calibrate={calibrate} name="terms">{si.term}</Field>

              {/* `y` is decided by the layout, not by the row index: the pitch between items
                  closes up as a sheet fills, so a position cannot be derived from a count here. */}
              {page.items.map(({ line: l, wrapped, y }, rowIdx) => {
                const c = FORM.items.columns;
                return (
                  <div key={l.id}>
                    <Field spec={{ ...c.qty, y }} calibrate={calibrate && rowIdx === 0} name="qty">{qtyText(l.quantity)}</Field>
                    <Field spec={{ ...c.unit, y }} calibrate={calibrate && rowIdx === 0} name="unit">{l.units}</Field>
                    {/* Pre-wrapped: each line is its own nowrap row, so the break points are the
                        ones measured above rather than whatever the browser decides. */}
                    <Field spec={{ ...c.description, y }} calibrate={calibrate && rowIdx === 0} name="description">
                      {wrapped.length
                        ? wrapped.map((t, i) => <div key={i} style={{ whiteSpace: 'nowrap' }}>{t}</div>)
                        : ''}
                    </Field>
                    <Field spec={{ ...c.unitPrice, y }} calibrate={calibrate && rowIdx === 0} name="unitPrice">{money(grossUnitPrice(l))}</Field>
                    <Field spec={{ ...c.amount, y }} calibrate={calibrate && rowIdx === 0} name="amount">{money(l.gross_amount)}</Field>
                  </div>
                );
              })}

              {isLast && (
                <Field
                  spec={{ ...FORM.items.orderId, y: page.itemsBottom + FORM.items.orderId.gap }}
                  calibrate={calibrate}
                  name="orderId"
                >
                  {`Order ID : ${si.sales_order_no || ''}`}
                </Field>
              )}
              {isLast && (
                <Field
                  spec={{ ...FORM.items.poNo, y: page.itemsBottom + FORM.items.poNo.gap }}
                  calibrate={calibrate}
                  name="poNo"
                >
                  {`PO # : ${si.po_no || ''}`}
                </Field>
              )}

              {/* Totals print once, on the final sheet. */}
              {isLast && totals && (
                <>
                  {/* ONLY THE BOXES THIS INVOICE ACTUALLY USES CARRY A FIGURE. A zero-rated sale
                      was printing 0.00 into VATable Sales and into VAT (12%) beside the one real
                      number, which reads as four competing answers on a form whose whole left
                      block is a choice between them. Exempt and Zero Rated already blanked
                      themselves; these two now do the same, so a VATable invoice shows VATable
                      and VAT, a zero-rated one shows Zero Rated alone, and an empty box means
                      the category does not apply rather than "nil". Total Sales and Amount Due
                      are the document's own totals and always print. */}
                  <Field spec={FORM.totals.vatableSales} calibrate={calibrate} name="vatableSales">{totals.vatable ? money(totals.vatable) : ''}</Field>
                  <Field spec={FORM.totals.vatExempt} calibrate={calibrate} name="vatExempt">{totals.exempt ? money(totals.exempt) : ''}</Field>
                  <Field spec={FORM.totals.zeroRated} calibrate={calibrate} name="zeroRated">{totals.zeroRated ? money(totals.zeroRated) : ''}</Field>
                  <Field spec={FORM.totals.vat} calibrate={calibrate} name="vat">{totals.vat ? money(totals.vat) : ''}</Field>
                  <Field spec={FORM.totals.totalSales} calibrate={calibrate} name="totalSales">{money(totals.totalSales)}</Field>
                  <Field spec={FORM.totals.lessWithholding} calibrate={calibrate} name="lessWithholding">
                    {totals.withholding ? money(totals.withholding) : ''}
                  </Field>
                  <Field spec={FORM.totals.amountDue} calibrate={calibrate} name="amountDue">{money(totals.amountDue)}</Field>
                </>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
