import { rate6 } from '../utils/rate';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import { COMPANY } from '../config/company';
import { displayDate } from '../utils/dates';

// Printable Purchase Order -- the copy that goes to the supplier.
//
// Printing is gated server-side (GET /purchase-orders/:id/print): System Admin prints any PO,
// everyone else needs can_print on /purchase-orders AND a PO that has been APPROVED. This page
// renders whatever refusal the server gives rather than deciding for itself, so the rule lives in
// exactly one place -- the same arrangement as JobOrderPrint.
//
// Laid out like the Job Order sheet (A4 portrait, letterhead, label/value header, one line table,
// totals) so the two documents read as coming from the same company, because they do.

function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : displayDate(d);
}

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

// The document-trail rows, in the order the live system's box prints them.
const TRAIL_TYPES = ['RR', 'VB', 'BC', 'JRNL', 'BPAY', 'PAY'];

// The PO Category, spelled out. The column stores the live system's code.
const TYPE_LABELS = {
  PO1: 'Inventory with JO', PO2: 'Inventory without JO',
  PO3: 'Services with JO', PO4: 'Services/Non-Inventory without JO',
};

function Row({ label, children }) {
  return (
    <div className="po-row">
      <span className="po-lbl">{label} :</span>
      <span className="po-val">{children}</span>
    </div>
  );
}

function Signature({ image, name, role }) {
  return (
    <div className="po-sig">
      <div className="po-sig-ink sig-ink" style={{ '--sig-h': '12mm' }}>{image ? <img src={image} alt="" /> : null}</div>
      <div className="po-sig-name">{name || ''}</div>
      <div className="po-line">{role}</div>
    </div>
  );
}

export default function PurchaseOrderPrint() {
  const { id } = useParams();
  const [po, setPo] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/purchase-orders/${id}/print`)
      .then(({ data }) => setPo(data))
      .catch((err) => setError(err.response?.data?.error || 'Could not load this Purchase Order.'));
  }, [id]);

  if (error) {
    return (
      <div style={{ maxWidth: 620, margin: '80px auto', padding: 24, textAlign: 'center', font: '14px/1.6 system-ui, sans-serif' }}>
        <h2 style={{ marginBottom: 8 }}>Can&rsquo;t print this Purchase Order</h2>
        <p style={{ color: '#64748b' }}>{error}</p>
      </div>
    );
  }
  if (!po) return <LoadingSpinner />;

  const lines = po.lines || [];
  // Whoever actually signed it off. A PO over the threshold carries the GM; under it, the
  // Purchasing Supervisor. The printed copy names them, because a supplier holding this page is
  // entitled to know the order was authorised and by whom.
  const approver = po.approved_by_gm_name || po.approved_by_supervisor_name || '';
  const approvedAt = po.approved_by_gm_at || po.approved_by_supervisor_at;

  return (
    <div className="po-print">
      <style>{`
        .po-print { background: #f1f5f9; padding: 16px 0 40px; }
        .po-sheet {
          width: 210mm; min-height: 279mm; margin: 0 auto 16px; padding: 10mm 12mm;
          background: #fff; color: #1f2937; font-family: system-ui, 'Segoe UI', sans-serif;
          font-size: 9pt; line-height: 1.5; box-shadow: 0 1px 6px rgba(0,0,0,.25);
        }
        .po-toolbar { max-width: 210mm; margin: 0 auto 12px; display: flex; justify-content: flex-end; gap: 8px; }
        .po-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; }
        .po-logo { width: 46mm; height: auto; display: block; }
        .po-addr { text-align: right; font-size: 7.5pt; color: #64748b; line-height: 1.45; }
        .po-title { text-align: center; font-size: 14pt; color: #1e3a8a; font-weight: 600; margin: 2px 0 2px; }
        .po-no { text-align: center; color: #1e3a8a; font-weight: 600; letter-spacing: .3px; margin-bottom: 10px; }
        .po-cols { display: flex; justify-content: space-between; gap: 20px; }
        .po-row { display: flex; gap: 6px; line-height: 1.4; }
        .po-lbl { min-width: 32mm; color: #334155; }
        .po-val { font-weight: 500; }
        .po-band { text-align: center; color: #1e3a8a; margin: 10px 0 4px; letter-spacing: .5px; }
        /* FIXED layout, so the table can never grow wider than the sheet. It used to size itself to
           its content: one long item code that will not break (LFP-STKR-VINYL-...-1.37MX50M) pushed
           it past 210mm, and Chrome then shrank the WHOLE page to fit -- the order printed at about
           three-quarters size with the Amount column still hanging off the edge. Every column now
           has a width, and text breaks inside its own column instead. */
        /* The app's own table rules (index.css) keep every cell on one line and set a 13px font;
           both are overridden here, or text spills across the neighbouring columns. */
        .po-table { width: 100%; border-collapse: collapse; margin-top: 6px; table-layout: fixed; font-size: 8.5pt; }
        .po-table th { text-align: left; font-weight: 600; color: #334155; border-bottom: 1px solid #cbd5e1; padding: 4px 4px; font-size: 8.5pt; white-space: normal; background: none; }
        .po-table td { padding: 4px 4px; vertical-align: top; border: none; white-space: normal; overflow-wrap: anywhere; word-break: break-word; line-height: 1.35; }
        .po-table th.po-num, .po-table td.po-num, .po-table th.po-qty, .po-table td.po-qty { white-space: nowrap; }
        .po-table tbody tr:hover { background: none; }
        .po-code { width: 28mm; font-size: 8pt; }
        .po-jo { width: 18mm; }
        .po-table tbody tr { border-bottom: 1px solid #e2e8f0; }
        .po-idx { color: #ea580c; width: 6mm; }
        /* Fixed widths on the numeric tail so Description keeps the slack and the figures never
           wrap -- the same reason JobOrderPrint pins its trailing columns. */
        .po-num { text-align: right; white-space: nowrap; width: 19mm; }
        .po-disc { width: 11mm; }
        .po-qty { text-align: right; white-space: nowrap; width: 14mm; }
        .po-unit { width: 13mm; }
        .po-totals { margin-top: 6px; margin-left: auto; width: 70mm; }
        .po-totals .po-row { justify-content: space-between; }
        .po-totals .po-lbl { min-width: 0; }
        .po-grand { border-top: 1px solid #cbd5e1; margin-top: 4px; padding-top: 4px; font-weight: 600; }
        /* The trail box and the signatures are ONE block that never splits: when the items leave no
           room for it -- about six ordinary lines on Letter -- the whole block moves to the next
           page together, rather than the box on one page and the signatures on the other. */
        .po-foot { break-inside: avoid; page-break-inside: avoid; padding-top: 6mm; }
        .po-trail { width: 100%; border-collapse: collapse; font-size: 8pt; break-inside: avoid; }
        .po-trail th, .po-trail td { border: 1px solid #cbd5e1; padding: 2px 6px; text-align: center; font-weight: 400; height: 5.5mm; }
        .po-trail th { color: #334155; }
        .po-trail .po-trail-type { color: #1e3a8a; }
        .po-trail img { max-height: 7mm; max-width: 34mm; object-fit: contain; display: block; margin: 0 auto; }
        .po-trail .po-trail-remarks { text-align: left; height: 9mm; vertical-align: top; }
        .po-sign { display: flex; justify-content: space-between; gap: 14px; margin-top: 6mm; break-inside: avoid; }
        .po-sig { flex: 1; min-width: 0; }
        /* Room for a drawn signature, kept even when there is none so the three lines stay level. */
        /* Drawn twice its box's height and over the name: the shared .sig-ink (index.css). */
        .po-sig-name { text-align: center; font-weight: 600; min-height: 1.5em; }
        .po-sign .po-line { border-top: 1px solid #94a3b8; padding-top: 4px; font-size: 8pt; color: #64748b; text-align: center; }
        @media print {
          /* White paper, not the app's page colour, behind and below the sheet. */
          html, body, #root, .po-print { background: #fff !important; }
          .po-print { padding: 0; }
          .po-no-print { display: none !important; }
          /* No fixed paper size: the printer's own (Letter at the office, or A4) -- the sheet fits both. */
          @page { margin: 0; }
          /* No forced full-page height when printing: 297mm plus rounding is what spills an empty
             second page. The sheet ends where its content does. */
          .po-sheet { box-shadow: none; margin: 0; min-height: 0; }
        }
      `}</style>

      <div className="po-toolbar po-no-print">
        <button className="btn btn-sm btn-primary" onClick={() => window.print()}>Print</button>
      </div>

      <div className="po-sheet">
        <div className="po-head">
          <div><div className="po-logo" style={{ fontSize: 26, fontWeight: 800, color: '#2E3F1C' }}>{COMPANY.short}</div></div>
          <div className="po-addr">
            <strong>{COMPANY.name}</strong><br />
            {COMPANY.addressLine1}{COMPANY.addressLine1 && <br />}
            {COMPANY.addressLine2}{COMPANY.addressLine2 && <br />}
            {COMPANY.phone && <>Tel. {COMPANY.phone}<br /></>}
            {COMPANY.website}
          </div>
        </div>

        <div className="po-title">Purchase Order</div>
        <div className="po-no">{po.po_no}</div>

        <div className="po-cols">
          <div style={{ flex: 1 }}>
            <Row label="Supplier">{po.supplier_name}</Row>
            <Row label="Address">{po.supplier_address}</Row>
            <Row label="TIN">{po.supplier_tin}</Row>
            <Row label="Contact No">{po.supplier_contact_no}</Row>
          </div>
          <div style={{ flex: 1 }}>
            <Row label="Date Created">{fmtDate(po.date_created)}</Row>
            <Row label="Need by Date">{fmtDate(po.need_by_date)}</Row>
            <Row label="Term">{po.term_name || po.supplier_credit_term}</Row>
            <Row label="Reference #">{po.ref_no}</Row>
            <Row label="PO Category">{TYPE_LABELS[po.type] || po.type}</Row>
            {po.parent_po_no && <Row label="Landed Cost of">{po.parent_po_no}</Row>}
          </div>
        </div>

        {po.memo && <div style={{ marginTop: 10 }}><Row label="Memo">{po.memo}</Row></div>}

        <div className="po-band">M A T E R I A L S</div>
        <table className="po-table">
          <thead>
            <tr>
              <th className="po-idx">#</th>
              <th className="po-code">Item Code</th>
              <th>Description</th>
              <th className="po-jo">Job Order</th>
              <th className="po-qty">Qty</th>
              <th className="po-unit">Unit</th>
              <th className="po-num">Rate</th>
              <th className="po-num po-disc">Disc %</th>
              <th className="po-num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr><td colSpan={9} style={{ textAlign: 'center', color: '#64748b', padding: 14 }}>No materials on this order.</td></tr>
            )}
            {lines.map((l, i) => (
              <tr key={l.id}>
                <td className="po-idx">{i + 1}</td>
                <td className="po-code">{l.item_code}</td>
                <td>{l.purchase_description || l.item_name}</td>
                <td className="po-jo">{l.job_order_no || ''}</td>
                <td className="po-qty">{money(l.qty)}</td>
                <td className="po-unit">{l.purchase_unit || l.unit_title || ''}</td>
                <td className="po-num">{rate6(l.rate)}</td>
                <td className="po-num po-disc">{l.disc_formula || (Number(l.disc_percent) ? money(l.disc_percent) : '')}</td>
                <td className="po-num">{money(l.ext_price)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="po-totals">
          <div className="po-row"><span className="po-lbl">Subtotal</span><span className="po-val">{money(po.subtotal)}</span></div>
          <div className="po-row"><span className="po-lbl">Discount</span><span className="po-val">{money(po.discount_amount)}</span></div>
          <div className="po-row"><span className="po-lbl">Net of Tax</span><span className="po-val">{money(po.net_of_tax)}</span></div>
          <div className="po-row"><span className="po-lbl">Tax</span><span className="po-val">{money(po.tax_amount)}</span></div>
          <div className="po-row po-grand"><span className="po-lbl">Total Amount</span><span className="po-val">{money(po.total_amount)}</span></div>
        </div>

        {/* The document trail (asked 2026-10-08, the live system's box): each Receiving Report,
            Vendor Bill, Bill Credit, Journal, Bill Payment and check release that followed this
            order, filled from T1S -- who processed it and their signature on file. A type with
            nothing yet still prints its empty row. */}
        <div className="po-foot">
        <table className="po-trail">
          <thead>
            <tr><th style={{ width: '17%' }}>Date</th><th style={{ width: '23%' }}>Transaction Type</th><th style={{ width: '17%' }}>Ref. No.</th><th style={{ width: '21%' }}>Processed By</th><th>Signature</th></tr>
          </thead>
          <tbody>
            {TRAIL_TYPES.flatMap((type) => {
              const docs = po.trail?.[type] || [];
              return (docs.length ? docs : [{}]).map((d, i) => (
                <tr key={`${type}-${i}`}>
                  <td>{d.date ? fmtDate(d.date) : ''}</td>
                  <td className="po-trail-type">{type}</td>
                  <td>{d.ref || ''}</td>
                  <td>{d.processed_by || ''}</td>
                  <td>{d.signature ? <img src={d.signature} alt="" /> : ''}</td>
                </tr>
              ));
            })}
            <tr><td className="po-trail-remarks">Remarks:</td><td className="po-trail-remarks" colSpan={4} /></tr>
          </tbody>
        </table>

        {/* Signature above the name, then the rule and the role -- the way a hand-signed order
            reads, and the same layout as the Form printouts. The approver is always named: the
            order reached this page because it was approved, and who approved it is the value of
            the paper to the supplier. A signer with no signature on file leaves the ink space
            blank to be signed by hand. */}
        <div className="po-sign">
          <Signature image={po.prepared_signature} name={po.created_by_name} role="Prepared by" />
          <Signature image={po.approved_signature} name={approver}
            role={`Pre-Approved by${approvedAt ? ` — ${fmtDate(approvedAt)}` : ''}`} />
          <Signature image={po.final_approver_signature} name={po.final_approver_name} role="Approved by" />
          <Signature name="" role="Received by (Supplier)" />
        </div>
        </div>
      </div>
    </div>
  );
}
