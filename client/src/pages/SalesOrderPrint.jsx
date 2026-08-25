import { Fragment, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import { COMPANY } from '../config/company';
import {
  STATUS_LABELS, DAILY_COLLECTION_COLUMNS, LINE_COLUMNS, money, moneyOrBlank, salesOrderTotals,
} from '../utils/salesOrderColumns';

// Sales Order hand-out. Shares the estimate/voucher print sheet, but carries the company
// logo's teal through the letterhead rule, the title band and the table heads so the
// printed page reads as the same document family as the logo at the top of it.
//
// The order's two shapes print as two different grids, exactly as they do on screen: a
// job-line order lists its items, while a Z-Reading import lists one row per trading day.
// Both run wide -- fifteen columns for the daily grid, twenty-six for the item grid -- so
// the sheet claims a landscape page either way; portrait squeezes the money columns until
// they wrap into an unreadable block.
function longDate(v) {
  return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : '';
}

// A detail row is only worth the ink if it has something in it -- an order imported from a
// POS shift report leaves most of the estimate-shaped fields blank, and printing a column
// of empty labels reads as data missing rather than data not applicable. A block whose
// every row is blank drops out of the grid entirely.
function Block({ title, rows }) {
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!shown.length) return null;
  return (
    <div>
      <h4 className="so-print-block-title">{title}</h4>
      <dl className="voucher-fields">
        {shown.map(([label, value]) => (
          <Fragment key={label}><dt>{label} :</dt><dd>{value}</dd></Fragment>
        ))}
      </dl>
    </div>
  );
}

export default function SalesOrderPrint() {
  const { id } = useParams();
  const [so, setSo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [logoOk, setLogoOk] = useState(true);

  useEffect(() => {
    api.get(`/sales-orders/${id}`).then(({ data }) => { setSo(data); setLoading(false); });
  }, [id]);

  if (loading || !so) return <LoadingSpinner />;

  const lines = so.lines || [];
  const isDailyCollections = so.sales_layout === 'daily_collections';
  const columns = isDailyCollections ? DAILY_COLLECTION_COLUMNS : LINE_COLUMNS;
  const { netOfTax, discountTotal, taxTotal, totalAmount } = salesOrderTotals(lines, isDailyCollections);
  const gl = so.gl_impact || [];

  return (
    <div className="estimate-print so-print">
      <div className="print-toolbar">
        <button className="btn btn-primary" onClick={() => window.print()}>Print</button>
      </div>

      <div className="print-sheet so-sheet">
        {/* Left names us, right names them. The logo already carries the company name, so
            repeating it opposite would say nothing -- the corner a reader checks first for
            "who is this for" holds the customer instead, and the company's address details
            sit under the mark that identifies them. */}
        <div className="print-letterhead so-letterhead">
          <div className="so-letterhead-us">
            {/* The company logo lives at client/public/company-logo.png. If it is ever missing
                the name alone still prints, rather than a broken-image icon. */}
            {logoOk
              ? <img src="/company-logo.png" alt={COMPANY.name} className="print-logo-img" onError={() => setLogoOk(false)} />
              : <div className="print-logo">{COMPANY.short}</div>}
            <div className="so-letterhead-address">
              {COMPANY.addressLine1}{COMPANY.addressLine1 && <br />}
              {COMPANY.addressLine2}{COMPANY.addressLine2 && <br />}
              {COMPANY.phone && <>Tel. {COMPANY.phone}<br /></>}
              {COMPANY.website}
            </div>
          </div>
          <div className="so-letterhead-customer">
            <div className="so-letterhead-customer-label">Customer</div>
            <strong>{so.customer_name}</strong>
            {so.contact_name && <><br />Attn: {so.contact_name}</>}
          </div>
        </div>

        <div className="so-print-band">
          <div className="so-print-band-title">
            Sales Order
            <span className="so-print-no">{so.sales_order_no}</span>
          </div>
          <span className="so-print-status">{STATUS_LABELS[so.status] || so.status}</span>
        </div>

        <div className="so-print-info">
          {/* No 'Customer' row: the letterhead already names them, and a hand-out that
              states the same name twice invites the reader to check whether they differ. */}
          <Block title="Customer Details" rows={[
            ['Contact Name', so.contact_name],
            ['Contact Title', so.contact_title],
            ['Contact Email', so.contact_email],
            ['Contact Phone', so.contact_phone],
            ['Blanket PO', so.blanket_po_no],
            ['Blanket PO Memo', so.blanket_po_memo],
          ]} />

          <Block title="Order Details" rows={[
            // Always printed, whatever the order's shape -- the date is what someone
            // filing or querying the hand-out looks for first.
            ['Date Created', longDate(so.date_created) || '—'],
            ['Estimate #', so.estimate_no],
            ['Sales Division', so.sales_division_name],
            ['Office Location', so.office_location_name],
            ['Department', so.department_name],
            ['Contract Desc.', so.contract_description],
            ['Ref #', so.ref_no],
            ['Memo', so.memo],
            ['Shipping Address', so.shipping_address],
          ]} />

          <Block title="Other Details" rows={[
            ['Sales Rep', so.sales_rep_name],
            ['Prepared By', so.prepared_by_name],
            ['Approved By', so.approved_by_name],
            ['Production Lead Time', so.production_lead_time],
            ['Price Validity', so.price_validity],
            ['Order Confirmation', so.order_confirmation_type],
          ]} />

          <Block title="Billing Details" rows={[
            ['Credit Term', so.credit_term],
            ['Credit Limit', so.credit_limit],
            ['Credit Balance', so.credit_balance],
            ['Bill to Contact Number', so.bill_to_contact_number],
          ]} />
        </div>

        <h3 className="so-print-section">{isDailyCollections ? 'Daily Sales & Collections' : 'Items'}</h3>
        <div className="so-print-table-wrap">
          <table className={`print-table so-print-table${isDailyCollections ? '' : ' so-print-table--dense'}`}>
            <thead>
              <tr>
                {!isDailyCollections && <th className="num">#</th>}
                {!isDailyCollections && <th>JO #</th>}
                {columns.map((c) => <th key={c.key} className={c.money ? 'num' : undefined}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr>
                  <td colSpan={columns.length + (isDailyCollections ? 0 : 2)} style={{ textAlign: 'center' }}>
                    {isDailyCollections ? 'No days recorded.' : 'No items.'}
                  </td>
                </tr>
              )}
              {lines.map((l, idx) => (
                <tr key={l.id}>
                  {!isDailyCollections && <td className="num">{idx + 1}</td>}
                  {!isDailyCollections && <td>{l.job_order_no || '—'}</td>}
                  {columns.map((c) => (
                    <td key={c.key} className={c.money ? 'num' : undefined}>
                      {c.render ? c.render(l) : (c.money ? money(l[c.key]) : l[c.key])}
                    </td>
                  ))}
                </tr>
              ))}
              {/* Only the money columns carry a total -- the rest hold dates, names and
                  descriptions, and summing those would just print a stray figure. The label
                  sits under the row's leading identity columns: the date on the daily grid,
                  and #/JO #/Job Type on the item grid. */}
              {lines.length > 0 && columns.some((c) => c.money) && (
                <tr className="so-print-total-row">
                  <td colSpan={isDailyCollections ? 1 : 3}><strong>Total</strong></td>
                  {columns.slice(1).map((c) => (
                    <td key={c.key} className={c.money ? 'num' : undefined}>
                      {c.money && <strong>{(c.blankWhenZero ? moneyOrBlank : money)(lines.reduce((s, l) => s + Number(l[c.key] || 0), 0))}</strong>}
                    </td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* The journal entry the order posts. Only imported counter sales carry one -- an
            estimate-derived order posts nothing until it is invoiced. */}
        {gl.length > 0 && (
          <>
            <h3 className="so-print-section">GL Impact</h3>
            <table className="print-table so-print-table">
              <thead>
                <tr>
                  <th>Account Code</th>
                  <th>Account Title</th>
                  <th className="num">Debit</th>
                  <th className="num">Credit</th>
                </tr>
              </thead>
              <tbody>
                {gl.map((r, i) => (
                  <tr key={i}>
                    <td>{r.account_code}</td>
                    <td>{r.account_name}</td>
                    <td className="num">{r.debit ? money(r.debit) : ''}</td>
                    <td className="num">{r.credit ? money(r.credit) : ''}</td>
                  </tr>
                ))}
                <tr className="so-print-total-row">
                  <td colSpan={2}><strong>Total</strong></td>
                  <td className="num"><strong>{money(gl.reduce((s, r) => s + Number(r.debit || 0), 0))}</strong></td>
                  <td className="num"><strong>{money(gl.reduce((s, r) => s + Number(r.credit || 0), 0))}</strong></td>
                </tr>
              </tbody>
            </table>
          </>
        )}

        <div className="so-print-totals">
          <div><span>Net of Tax</span><span>{money(netOfTax)}</span></div>
          <div><span>Discount</span><span>{money(discountTotal)}</span></div>
          <div><span>Tax</span><span>{money(taxTotal)}</span></div>
          <div className="so-print-grand"><span>Total Amount</span><span>{money(totalAmount)}</span></div>
        </div>

        <div className="print-signatures so-print-signatures">
          <div>
            <div className="print-sig-label">Prepared By:</div>
            <div className="print-sig-name">{so.prepared_by_name || '\u00A0'}</div>
            <div className="print-sig-line">&nbsp;</div>
          </div>
          <div>
            <div className="print-sig-label">Acknowledge By:</div>
            <div className="print-sig-name">&nbsp;</div>
            <div className="print-sig-line">&nbsp;</div>
          </div>
          <div>
            <div className="print-sig-label">Checked By:</div>
            <div className="print-sig-name">&nbsp;</div>
            <div className="print-sig-line">&nbsp;</div>
          </div>
          <div>
            <div className="print-sig-label">Approved By:</div>
            <div className="print-sig-name">{so.approved_by_name || '\u00A0'}</div>
            <div className="print-sig-line">&nbsp;</div>
          </div>
        </div>

        <div className="so-print-footnote">
          {so.sales_order_no} · Printed {new Date().toLocaleString('en-US', { month: 'short', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    </div>
  );
}
