import { useEffect, useState } from 'react';
import { Fragment } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import { COMPANY } from '../config/company';
import { displayDate } from '../utils/dates';
import { isPrintSelected } from '../utils/estimatePrintSelected';

// Mirrors the real system's "Print" report for an estimate (Report Viewer ->
// "Price Quotation | No Items" template) -- one line per Job Order (not per process),
// company letterhead, customer/estimate details, totals, terms, and signature blocks.
//
// Two more, as the source's Print menu (2026-10-28):
//   ?items=1              Print with Selected Items (Hide Discount): under each job, the items of its
//                         Print Selected lines; prices are the discounted ones and no discount shows.
//   ?items=1&discount=1   Print with Selected Items (Show Discount): the same items, with the Unit
//                         Price, Discount %, Rate, and the Total Discount in the totals.
function num(v) { return v === null || v === undefined || v === '' ? 0 : Number(v); }
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(d) {
  if (!d) return '';
  return displayDate(d);
}

export default function EstimatePrint() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const withItems = params.get('items') === '1';
  const showDiscount = withItems && params.get('discount') === '1';
  const [estimate, setEstimate] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/estimates/${id}`, { params: { signatures: 1 } }).then(({ data }) => { setEstimate(data); setLoading(false); });
  }, [id]);

  if (loading || !estimate) return <LoadingSpinner />;

  const jobOrders = estimate.jobOrders || [];
  let subtotal = 0;
  let grossSubtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;
  const lines = jobOrders.map((jo) => {
    const amount = num(jo.subtotal) - num(jo.disc_amount);
    // The line's own 2-decimal tax, as the estimate screen and the Sales Order total it -- summing
    // Net x rate unrounded printed 2,850.01 on an estimate that reads 2,850.00 (EST-105221).
    const tax = jo.tax_amount != null && jo.tax_amount !== ''
      ? num(jo.tax_amount)
      : Math.round(amount * (num(jo.tax_rate) / 100) * 100) / 100;
    subtotal += amount;
    grossSubtotal += num(jo.subtotal);
    discountTotal += num(jo.disc_amount);
    taxTotal += tax;
    const size = [jo.length, jo.width, jo.height].map((v) => (v === null || v === '' ? 0 : v)).join(' x ');
    const items = (jo.processes || []).filter((p) => p.item_id && isPrintSelected(p));
    return { ...jo, amount, items, size: jo.uom ? `${size} ${jo.uom}` : size };
  });
  const total = subtotal + taxTotal;

  return (
    <div className="estimate-print">
      {/* The quotation prints portrait on A4, like the emailed PDF. With no @page rule the browser
          was free to pick landscape. Rendered here, not in index.css, because .print-sheet is
          shared with print pages that may want the other orientation. */}
      <style>{`
        @page { size: A4 portrait; margin: 12mm; }
        @media print {
          .estimate-print .print-sheet { padding: 0; font-size: 11px; }
          .estimate-print .print-items-table { width: 100%; table-layout: auto; }
        }
        .estimate-print .print-sub-row > td { border-top: 0; padding-top: 0; }
        .estimate-print .print-sub-items { width: 75%; border-collapse: collapse; margin: 2px 0 6px; font-size: 0.95em; }
        .estimate-print .print-sub-items th, .estimate-print .print-sub-items td { border: 0; border-bottom: 1px solid #eef0f4; padding: 3px 6px; background: none; font-weight: 400; text-align: left; }
        .estimate-print .print-sub-items th { color: #334155; }
        .estimate-print .print-sub-items .r { text-align: right; }
        .estimate-print .print-sub-items .n { color: #c026d3; width: 24px; }
      `}</style>
      <div className="print-toolbar">
        <button className="btn btn-primary" onClick={() => window.print()}>Print</button>
      </div>

      <div className="print-sheet">
        <div className="print-letterhead">
          <div className="print-logo">WVI ERP</div>
          <div className="print-company-address">
            <strong>{COMPANY.name}</strong><br />
            {COMPANY.addressLine1}{COMPANY.addressLine1 && <br />}
            {COMPANY.addressLine2}{COMPANY.addressLine2 && <br />}
            {COMPANY.phone && <>Tel. {COMPANY.phone}<br /></>}
            {COMPANY.website}
          </div>
        </div>

        <h2 className="print-title">Price Quotation</h2>

        <div className="print-info-grid">
          <div>
            <div><strong>Customer :</strong> {estimate.customer_name}</div>
            <div><strong>Attention :</strong> {estimate.contact_name}</div>
            <div><strong>Contact Title :</strong>{estimate.contact_title}</div>
            <div><strong>Contact # :</strong> {estimate.contact_phone}</div>
            <div><strong>Contact Email :</strong> {estimate.contact_email}</div>
            <br />
            <div><strong>Bill To :</strong></div>
            <div><strong>Bill to Address :</strong> {estimate.shipping_address}</div>
            <br />
            <div><strong>Contract Description :</strong> {estimate.contract_description}</div>
            <div><strong>Memo :</strong> {estimate.memo}</div>
          </div>
          <div className="print-info-right">
            <div><strong>Estimate # :</strong> {estimate.estimate_no}</div>
            <div><strong>Date :</strong> {formatDate(estimate.date_created)}</div>
          </div>
        </div>

        <table className="print-items-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Description</th>
              <th>Size</th>
              <th>Quantity</th>
              <th>Units</th>
              <th>Unit Price</th>
              {(!withItems || showDiscount) && <th>Discount %</th>}
              {(!withItems || showDiscount) && <th>Rate</th>}
              <th>Amount (Vat-Ex)</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((jo, idx) => (
              <Fragment key={jo.id}>
                <tr>
                  <td>{idx + 1}.</td>
                  <td>{jo.description}</td>
                  <td>{jo.size}</td>
                  <td>{jo.quantity}</td>
                  <td>{jo.units}</td>
                  {/* Hide Discount prints the discounted price as the Unit Price. */}
                  <td>{money(withItems && !showDiscount ? (jo.disc_price_per_unit || jo.price_per_unit) : jo.price_per_unit)}</td>
                  {(!withItems || showDiscount) && <td>{money(jo.disc_percent)}</td>}
                  {(!withItems || showDiscount) && <td>{money(jo.disc_price_per_unit || jo.price_per_unit)}</td>}
                  <td>{money(jo.amount)}</td>
                </tr>
                {withItems && jo.items.length > 0 && (
                  <tr className="print-sub-row">
                    <td />
                    <td colSpan={showDiscount ? 8 : 6}>
                      <table className="print-sub-items">
                        <thead><tr><th>#</th><th>Item</th><th className="r">Length</th><th className="r">Width</th><th>UOM</th></tr></thead>
                        <tbody>
                          {jo.items.map((p, pi) => (
                            <tr key={p.id}>
                              <td className="n">{pi + 1}</td>
                              <td>{p.item_name}</td>
                              <td className="r">{Number(p.length) ? p.length : ''}</td>
                              <td className="r">{Number(p.width) ? p.width : ''}</td>
                              <td>{p.uom}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>

        <div className="print-totals-row">
          <div>
            <div><strong>Payment Terms :</strong> {estimate.credit_term}</div>
            <div><strong>Production Lead Time :</strong> {estimate.production_lead_time}</div>
          </div>
          <div className="print-totals">
            {showDiscount ? (
              <>
                <div><span>Subtotal :</span><span>{money(grossSubtotal)}</span></div>
                <div><span>Total Discount :</span><span>{money(discountTotal)}</span></div>
              </>
            ) : <div><span>Subtotal :</span><span>{money(subtotal)}</span></div>}
            <div><span>Tax :</span><span>{money(taxTotal)}</span></div>
            <div className="print-total-final"><span>Total :</span><span>{money(total)}</span></div>
          </div>
        </div>

        <div className="print-terms">
          <h4>Terms and Conditions:</h4>
          <p>1. Delivery date is relative to either of the following:</p>
          <p className="print-indent">- Approval of Final Proof</p>
          <p className="print-indent">- Receipt of Purchase Order and/or Payment</p>
          <p>2. Cancellation of order by oral, written, electronic, or other forms of communication, shall be subject to 25% charge which is based on the TOTAL ORDER AMOUNT.
          The charges shall cover incidental expenses such as Layouting, Site Inspection, Bank Charges and other processing costs. This is applicable only if item/s is/are not produced.</p>

          <h4>Payment Informations:</h4>
          <p>A. For check payments, make all payable to <strong>{COMPANY.name}</strong></p>
          <p>B. Money transfer payments must be made to any of <strong>{COMPANY.name}</strong> bank accounts only:</p>
          <div className="print-bank-grid">
            {COMPANY.bankAccounts.map((acct, i) => <div key={i}>{i + 1}. {acct}</div>)}
          </div>
        </div>

        <div className="print-signatures">
          <div>
            <div className="print-sig-label" style={estimate.prepared_signature ? { marginBottom: 0 } : undefined}>Prepared By:</div>
            {estimate.prepared_signature && <div className="sig-ink" style={{ '--sig-h': '32px' }}><img src={estimate.prepared_signature} alt="" /></div>}
            <div className="print-sig-name">{estimate.prepared_by_name}</div>
            <div className="print-sig-line">___________________</div>
          </div>
          <div>
            <div className="print-sig-label" style={estimate.approved_signature ? { marginBottom: 0 } : undefined}>Approved By:</div>
            {estimate.approved_signature && <div className="sig-ink" style={{ '--sig-h': '32px' }}><img src={estimate.approved_signature} alt="" /></div>}
            <div className="print-sig-name">{estimate.approved_by_name}</div>
            <div className="print-sig-line">___________________</div>
          </div>
          <div>
            <div className="print-sig-label">Customer Name/Signature/Date</div>
            <div className="print-sig-name">&nbsp;</div>
            <div className="print-sig-line">___________________</div>
          </div>
        </div>
      </div>
    </div>
  );
}
