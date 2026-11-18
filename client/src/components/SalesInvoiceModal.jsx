import { useEffect, useState } from 'react';
import api from '../api/client';
import EntityPicker from './EntityPicker';
import EstimatePicker from './EstimatePicker';
import LoadingSpinner from './LoadingSpinner';
import { headerDepartmentError } from '../utils/requireDepartment';
import { useAuth } from '../context/useAuth';

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
const r2 = (n) => Math.round(n * 100) / 100;
// A line at a Price/Unit the biller typed in: every other figure follows from it, by the same
// formula the server uses when it saves (computeBillableLineAmounts), so what is shown here is
// what gets posted. A blank or invalid entry leaves the line as it came.
function repriced(line, priceText) {
  if (priceText === undefined || priceText === '') return line;
  const price = Number(priceText);
  if (!Number.isFinite(price) || price < 0) return line;
  const q = Number(line.quantity) || 0;
  const subtotal = r2(price * q);
  const discAmount = r2(subtotal * (Number(line.disc_percent) || 0) / 100);
  const netOfTax = r2(subtotal - discAmount);
  const taxAmount = r2(netOfTax * (Number(line.tax_rate) || 0) / 100);
  return {
    ...line, price_per_unit: price, subtotal, disc_amount: discAmount, net_of_tax: netOfTax,
    disc_price_per_unit: q ? netOfTax / q : line.disc_price_per_unit,
    tax_amount: taxAmount, gross_amount: r2(netOfTax + taxAmount),
  };
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Mirrors the real "Create SI" popup, reached three ways: from a Sales Order's Bill
// dropdown, from a Delivery Ticket's own Bill > SI (pass deliveryTicketId), or from Create
// New on the invoice list (pass fromEstimate). Every line starts as a copy of the already-
// computed billing figures; the biller may change a line's Price/Unit (2026-10-01, not on the
// real screen) and the line's amounts and the totals follow, or Delete to exclude a line.
//
// From a Sales Order it bills each line's remaining (Delivered minus already-Invoiced)
// gap. From a Delivery Ticket it bills that ticket's own stored lines verbatim, ad-hoc
// "Add Item" charges included, and converts the ticket -- so the lines are fixed and
// Delete is hidden: you cannot half-convert a ticket.
//
// From an Estimate the form opens EMPTY, with an Estimate field to fill in first -- there is
// no source document until one is picked, which is the difference between this and the other
// two. The Estimate's own lines are billed as they stand, and their JO # column is blank
// because no Job Order exists yet: those are raised when the Estimate becomes a Sales Order.
// Hidden on request (2026-09-29): staff are not to tag or bill an Estimate from Create New. Kept
// behind a flag rather than deleted, since the Estimate flow below still depends on it -- with it
// hidden, Create New cannot pick an Estimate, so it cannot produce an invoice either.
const SHOW_ESTIMATE_FIELD = false;
//
// From a Non-Standard Sales Order (pass nssoId) it is the Sales Order flow over the NSSO's lines:
// each line's delivered-but-uninvoiced gap, billed to the NSSO's customer.

export default function SalesInvoiceModal({ salesOrderId, nssoId, deliveryTicketId, fromEstimate, invoiceType = 'SI', onClose, onSaved }) {
  const [data, setData] = useState(null);
  // Today in the user's own (Philippine) time -- toISOString's UTC date was still yesterday before 8 am,
  // which on the 1st put a DT's conversion into the closed month (2026-10-12).
  const [dateCreated, setDateCreated] = useState(() => new Date().toLocaleDateString('en-CA'));
  const [dateDue, setDateDue] = useState('');
  // `term` is still what gets saved -- sales_invoices.term is the text, and the printed invoice
  // and every existing row read it. `paymentTerm` is only which master row is currently picked.
  const [term, setTerm] = useState('');
  const [paymentTerm, setPaymentTerm] = useState(null);
  const [paymentTerms, setPaymentTerms] = useState([]);
  const [bsSiNo, setBsSiNo] = useState('');
  const [poNo, setPoNo] = useState('');
  const [salesRep, setSalesRep] = useState(null);
  const [officeLocation, setOfficeLocation] = useState(null);
  const [department, setDepartment] = useState(null);
  // Sales Rep, Office Location and Department come from the order being billed; only a System Admin
  // changes them (asked 2026-10-24). One the order does not give stays open to fill.
  const { user } = useAuth();
  const isAdmin = user?.account_type === 'System Admin';
  const [fromOrder, setFromOrder] = useState({});
  const [billToAddress, setBillToAddress] = useState('');
  const [memo, setMemo] = useState('');
  // Several rates may be ticked at once (asked 2026-11-14, e.g. 2% EWT + 5% on a government sale):
  // the invoice withholds their sum, saved as its one withholding_tax_pct.
  const [withholdingPcts, setWithholdingPcts] = useState([]);
  const withholdingPct = withholdingPcts.reduce((s, p) => s + p, 0);
  const [excludedIds, setExcludedIds] = useState(new Set());
  // Price/Unit typed over a line's own, keyed like excludedIds. Not offered when billing an
  // Estimate, whose save path does not take it.
  const [priceEdits, setPriceEdits] = useState({});
  // Partial invoicing (asked 2026-10-24): a Sales Order line with more than 1 to bill can be billed
  // a part at a time -- the rest stays billable for the next invoice.
  const [qtyEdits, setQtyEdits] = useState({});
  const [employees, setEmployees] = useState([]);
  const [locations, setLocations] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Only ever set in the Estimate flow: which Estimate this invoice is being raised against.
  // Null until one is picked, which is why the form can be open with no source at all.
  const [estimate, setEstimate] = useState(null);

  const fromTicket = Boolean(deliveryTicketId);

  useEffect(() => {
    // Nothing to source from yet in the Estimate flow -- the lookups still load, so the
    // Sales Rep and Office Location fields work while an Estimate is being chosen.
    const source = fromTicket
      ? `/sales-invoices/for-delivery-ticket/${deliveryTicketId}`
      : fromEstimate
        ? (estimate ? `/sales-invoices/for-estimate/${estimate.id}` : null)
        : nssoId
          ? `/sales-invoices/for-nsso/${nssoId}`
          : `/sales-invoices/for-sales-order/${salesOrderId}`;
    Promise.all([
      source ? api.get(source) : Promise.resolve(null),
      api.get('/employees'),
      api.get('/lookups/locations'),
      api.get('/lookups/departments'),
      api.get('/lookups/payment-terms'),
    ]).then(([srcRes, empRes, locRes, deptRes, termRes]) => {
      setEmployees(empRes.data);
      setLocations(locRes.data);
      setDepartments(deptRes.data);
      const terms = termRes.data || [];
      setPaymentTerms(terms);
      if (!srcRes) { setData({ lines: [] }); setLoading(false); return; }
      const d = srcRes.data;
      setData(d);
      setBillToAddress(d.shipping_address || '');
      // A ticket already carries its own Term/PO #/Memo, chosen when it was raised --
      // carry them onto the invoice rather than falling back to the customer's default.
      // The order's own credit term first, then the customer's agreed one. An order frequently
      // carries none -- it is not a required field on a Sales Order -- and falling back to the
      // customer's default is what the person raising the invoice would otherwise look up by hand.
      const sourceTerm = d.term || d.credit_term || d.customer_term || '';
      setTerm(sourceTerm);
      // Match what the source document carried back to a master row, so the picker opens showing
      // the term already agreed rather than blank. Compared case- and space-insensitively
      // because these strings were typed for years before the list existed. A term that matches
      // nothing is still shown as the placeholder -- it is what the document says, and blanking
      // it would quietly drop an agreed term.
      const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
      setPaymentTerm(terms.find((t) => norm(t.term_name) === norm(sourceTerm)) || null);
      setPoNo(d.po_no || '');
      setMemo(d.memo || '');
      setFromOrder({ rep: !!d.sales_rep_id, loc: !!d.office_location_id, dept: !!d.department_id });
      if (d.sales_rep_id) setSalesRep({ id: d.sales_rep_id, first_name: d.sales_rep_name?.split(' ')[0], last_name: d.sales_rep_name?.split(' ').slice(1).join(' ') });
      if (d.office_location_id) setOfficeLocation({ id: d.office_location_id, location_name: d.office_location_name });
      if (d.department_id) {
        setDepartment({ id: d.department_id, name: d.department_name });
      } else if (d.sales_division_name) {
        // A Sales Order has no department -- it has a SALES DIVISION, a separate table. The
        // invoice's Department is filled from it, matched by NAME rather than by id: the two
        // id spaces agree for most rows but not all, and where they disagree the id silently
        // files the invoice under the wrong department. Normalised because the same division is
        // "Sales-1" on one table and "Sales - 1" on the other.
        // Letters and digits only: the same unit is "Sales-1" as a division and "Sales - 1" as a
        // department, so collapsing whitespace alone would miss three of the eleven.
        const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const division = deptRes.data.find((x) => key(x.name) === key(d.sales_division_name));
        if (division) { setDepartment(division); setFromOrder((x) => ({ ...x, dept: true })); }
      }
      // From the matched term's own No. of Days where there is one. The flat +30 remains the
      // fallback for a document carrying no term, or one that matches nothing in the list --
      // which is what every invoice got before, so nothing regresses.
      // Date Due comes from the term's No. of Days and from nowhere else. With no term there is
      // no basis for one, so it is left BLANK rather than invented: the old fallback put a flat
      // +30 on every invoice, which is why 4 invoices carry a due date with no term behind it and
      // why plenty more are dated 30 days out on terms that were never 30 days. The column is
      // nullable, all three save paths already write `dateDue || null`, and AR Aging ages a
      // due-date-less invoice by its document date.
      const matched = terms.find((t) => norm(t.term_name) === norm(sourceTerm));
      const today = new Date().toISOString().slice(0, 10);
      setDateDue(matched ? addDays(today, Number(matched.no_of_days) || 0) : '');
      setLoading(false);
    }).catch((err) => {
      setError(err.response?.data?.error || 'Could not load this record.');
      setLoading(false);
    });
  }, [salesOrderId, nssoId, deliveryTicketId, fromTicket, fromEstimate, estimate]);

  if (loading || (!data && !error)) {
    return (
      <div className="modal-overlay">
        <div className="modal modal-xl"><LoadingSpinner /></div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal modal-xl">
          <div className="error-banner">{error}</div>
          <div className="modal-actions"><button type="button" className="btn" onClick={onClose}>Close</button></div>
        </div>
      </div>
    );
  }

  // A ticket-sourced line may be an ad-hoc charge with no sales_order_line_id at all, so
  // it needs its own key; SO-sourced lines keep using theirs, and estimate-sourced lines
  // are keyed on the estimate line they came from.
  const lineKey = (l, idx) => l.delivery_ticket_line_id ?? l.sales_order_line_id ?? l.nsso_line_id ?? l.estimate_job_order_id ?? idx;
  const canEditQty = !fromEstimate && !fromTicket && !nssoId;
  // The quantity typed for a line, when it is a valid part of what is billable; else null.
  const partQty = (l, key) => {
    const v = qtyEdits[key];
    if (!canEditQty || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n < Number(l.quantity) ? n : null;
  };
  const badQty = canEditQty ? data.lines.map((l, idx) => {
    const key = lineKey(l, idx);
    const v = qtyEdits[key];
    if (excludedIds.has(key) || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n <= Number(l.quantity) ? null : idx + 1;
  }).filter(Boolean) : [];
  const shownLines = data.lines.map((l, idx) => {
    const key = lineKey(l, idx);
    const q = partQty(l, key);
    return q == null ? repriced(l, priceEdits[key]) : repriced({ ...l, quantity: q }, priceEdits[key] ?? String(l.price_per_unit ?? 0));
  });
  const includedLines = shownLines.filter((l, idx) => !excludedIds.has(lineKey(data.lines[idx], idx)));
  const qtyOverrides = Object.fromEntries(data.lines
    .map((l, idx) => [lineKey(l, idx), partQty(l, lineKey(l, idx))])
    .filter(([key, q]) => q != null && !excludedIds.has(key)));
  const canEditPrice = !fromEstimate;
  // Only the lines whose price actually changed are sent, keyed by the source line id the
  // server bills from.
  const priceOverrides = Object.fromEntries(data.lines
    .map((l, idx) => [lineKey(l, idx), priceEdits[lineKey(l, idx)], idx])
    .filter(([key, v, idx]) => v !== undefined && v !== '' && !excludedIds.has(key)
      && Number(v) !== Number(data.lines[idx].price_per_unit))
    .map(([key, v]) => [key, Number(v)]));
  // A ticket converted untouched bills the ticket's own totals, as the server does -- summing its
  // rounded lines can land a centavo off them. A changed price means summing the lines.
  const ticketTotals = fromTicket && !Object.keys(priceOverrides).length ? data.ticket_totals : null;
  const subtotal = ticketTotals ? ticketTotals.subtotal : includedLines.reduce((s, l) => s + Number(l.subtotal || 0), 0);
  const discountAmount = ticketTotals ? ticketTotals.discount_amount : includedLines.reduce((s, l) => s + Number(l.disc_amount || 0), 0);
  const netOfTax = ticketTotals ? ticketTotals.net_of_tax : includedLines.reduce((s, l) => s + Number(l.net_of_tax || 0), 0);
  const taxAmount = ticketTotals ? ticketTotals.tax_amount : includedLines.reduce((s, l) => s + Number(l.tax_amount || 0), 0);
  const grossAmount = ticketTotals ? ticketTotals.gross_amount : includedLines.reduce((s, l) => s + Number(l.gross_amount || 0), 0);
  const ewtAmount = netOfTax * (withholdingPct / 100);
  const amountDue = grossAmount - ewtAmount;

  // Billing a Sales Order or a Delivery Ticket as an SI needs the printed BS/SI serial (asked
  // 2026-11-10); a DR does not.
  const bsSiRequired = !fromEstimate && !nssoId && invoiceType !== 'DR';

  async function handleSave() {
    setError('');
    if (fromEstimate && !estimate) { setError('Choose an Estimate first.'); return; }
    if (!includedLines.length) { setError('Include at least one item.'); return; }
    if (badQty.length) { setError(`Line ${badQty.join(', ')}: the quantity to invoice must be more than 0 and no more than what is left to bill.`); return; }
    const deptError = headerDepartmentError(department?.id);
    if (deptError) { setError(deptError); return; }
    if (bsSiRequired && !String(bsSiNo || '').trim()) { setError('Enter the BS/SI #.'); return; }
    setSaving(true);
    try {
      const { data: si } = await api.post('/sales-invoices', {
        // Billing a ticket sends its id and nothing about lines -- the server bills the
        // ticket in full, which is what converting it means. Billing an Estimate sends no
        // sales_order_id at all, because there isn't one.
        ...(fromEstimate
          ? {
            estimate_id: estimate.id,
            estimate_job_order_ids: includedLines.map((l) => l.estimate_job_order_id),
          }
          : fromTicket
            ? { delivery_ticket_id: deliveryTicketId, sales_order_id: data.sales_order_id }
            : nssoId
              ? { nsso_id: nssoId, nsso_line_ids: includedLines.map((l) => l.nsso_line_id) }
              : { sales_order_line_ids: includedLines.map((l) => l.sales_order_line_id) }),
        ...(fromEstimate || nssoId ? {} : { sales_order_id: fromTicket ? data.sales_order_id : salesOrderId }),
        // SI or DR, chosen on the Sales Order's or the Delivery Ticket's Bill menu.
        invoice_type: invoiceType,
        date_created: dateCreated,
        date_due: dateDue,
        term,
        bs_si_no: invoiceType === 'DR' ? '' : bsSiNo,
        po_no: poNo,
        sales_rep_id: salesRep?.id || null,
        office_location_id: officeLocation?.id || null,
        department_id: department?.id || null,
        bill_to_address: billToAddress,
        memo,
        withholding_tax_pct: withholdingPct,
        ...(canEditPrice && Object.keys(priceOverrides).length ? { price_overrides: priceOverrides } : {}),
        ...(Object.keys(qtyOverrides).length ? { qty_overrides: qtyOverrides } : {}),
      });
      onSaved(si);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-xl" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="estimate-banner" style={{ borderRadius: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <h2 style={{ margin: 0, color: '#fff' }}>{fromTicket ? `Create ${invoiceType} from ${data.dt_no}` : `Create ${invoiceType}`}</h2>

          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 24, lineHeight: 1, cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ padding: 24 }}>
          {error && <div className="error-banner">{error}</div>}

          {/* The Estimate has already been billed at least once. Not an error -- an estimate can
              legitimately be billed in stages -- but nothing else on this form would say so, and
              raising the same invoice twice is the mistake this is here to prevent. */}
          {fromEstimate && data.prior_invoice_count > 0 && (
            <div className="error-banner" style={{ background: '#fef3c7', color: '#92400e' }}>
              {data.estimate_no} already has {data.prior_invoice_count} invoice(s) against it,
              totalling {money(data.prior_invoiced_amount)}. Check this is not a duplicate.
            </div>
          )}
          {/* Converted already, so its work flows through a Sales Order that bills on delivered
              quantities. Billing the Estimate as well would bill the same work twice. */}
          {fromEstimate && data.sales_order_no && (
            <div className="error-banner" style={{ background: '#fef3c7', color: '#92400e' }}>
              {data.estimate_no} has already become {data.sales_order_no}. That Sales Order bills
              on what has been delivered — invoicing the Estimate here bills the same work again.
            </div>
          )}

          <div className="review-grid" style={{ gridTemplateColumns: '1fr 1fr 260px' }}>
            <div>
              {fromEstimate && SHOW_ESTIMATE_FIELD && (
                <div className="field">
                  <label>Estimate</label>
                  <EstimatePicker
                    value={estimate?.id || ''}
                    selectedLabel={estimate ? `${estimate.estimate_no}${estimate.customer_name ? ` — ${estimate.customer_name}` : ''}` : ''}
                    // The spinner is raised here rather than in the effect: picking an Estimate
                    // is the event that causes the reload, and setting it inside the effect
                    // starts a second render for no reason.
                    onSelect={(e) => { setLoading(true); setEstimate(e); setExcludedIds(new Set()); }}
                  />
                </div>
              )}
              {/* The term counts its days from the invoice date, so moving the date moves the due
                  date with it. Without this, backdating an invoice left a due date computed from
                  the day the form happened to be opened. */}
              <div className="field">
                <label>Date</label>
                <input
                  type="date" value={dateCreated}
                  onChange={(e) => {
                    setDateCreated(e.target.value);
                    if (paymentTerm && e.target.value) {
                      setDateDue(addDays(e.target.value, Number(paymentTerm.no_of_days) || 0));
                    }
                  }}
                />
              </div>
              {/* Still editable: a term is the default arrangement, not always the one agreed on
                  a particular invoice. Picking a term or changing the date recomputes it. */}
              <div className="field">
                <label>Date Due</label>
                <input
                  type="date" value={dateDue} onChange={(e) => setDateDue(e.target.value)}
                  title={paymentTerm
                    ? `${paymentTerm.term_name} — ${Number(paymentTerm.no_of_days) || 0} day(s) from the invoice date`
                    : 'No term selected, so there is no basis for a due date'}
                />
              </div>
              <div>Customer : <span className="hi">{data.customer_name}</span></div>
              <div>Created Form : <span className="hi">{fromTicket ? `${data.dt_no} (${data.sales_order_no})` : fromEstimate ? (data.estimate_no || '—') : data.sales_order_no}</span></div>
              <div className="field">
                <label>Sales Rep</label>
                <EntityPicker
                  label="Sales Rep" items={employees} value={salesRep?.id || ''} disabled={!isAdmin && fromOrder.rep}
                  getLabel={(e) => `${e.first_name} ${e.last_name}`}
                  columns={[{ key: 'name', label: 'Name', render: (e) => `${e.first_name} ${e.last_name}` }]}
                  searchKeys={['first_name', 'last_name']}
                  onSelect={setSalesRep}
                />
              </div>
              <div className="field">
                <label>Office Location</label>
                <EntityPicker
                  label="Office Location" items={locations} value={officeLocation?.id || ''} getLabel={(l) => l.location_name} disabled={!isAdmin && fromOrder.loc}
                  columns={[{ key: 'location_name', label: 'Name' }]} searchKeys={['location_name']}
                  onSelect={setOfficeLocation}
                />
              </div>
              <div className="field">
                <label>Department *</label>
                <EntityPicker
                  label="Department" items={departments} value={department?.id || ''} getLabel={(d) => d.name} disabled={!isAdmin && fromOrder.dept}
                  columns={[{ key: 'name', label: 'Name' }]} searchKeys={['name']}
                  onSelect={setDepartment}
                />
              </div>
              <div className="field-checkbox" style={{ marginTop: 8 }}>
                <label style={{ marginRight: 12 }}>Withholding Tax</label>
                {[1, 2, 5].map((pct) => (
                  <label key={pct} style={{ marginRight: 12, fontWeight: 400 }}>
                    <input
                      type="checkbox" checked={withholdingPcts.includes(pct)}
                      onChange={() => setWithholdingPcts((list) => (list.includes(pct) ? list.filter((p) => p !== pct) : [...list, pct]))}
                    /> {pct}%
                  </label>
                ))}
                {withholdingPcts.length > 1 && <span className="muted" style={{ fontSize: 12 }}>= {withholdingPct}%</span>}
              </div>
            </div>
            <div>
              {/* Chosen from the Payment Terms master list rather than typed. Free text let a
                  tax code ("VAT_PH:VATIN-12") reach the Term of 9 invoices, and a term nobody
                  can look up is one nothing downstream can reason about. Picking one also sets
                  Date Due from its No. of Days -- that number is the whole point of a term, and
                  it was previously ignored in favour of a flat +30. Date Due stays editable. */}
              <div className="field">
                <label>Term</label>
                <EntityPicker
                  label="Term" items={paymentTerms} value={paymentTerm?.id || ''}
                  getLabel={(t) => t.term_name}
                  columns={[
                    { key: 'term_name', label: 'Term' },
                    { key: 'no_of_days', label: 'Days', render: (t) => Number(t.no_of_days || 0) },
                  ]}
                  searchKeys={['term_name']}
                  placeholder={term || 'Select Term...'}
                  onSelect={(t) => {
                    setPaymentTerm(t);
                    setTerm(t ? t.term_name : '');
                    if (t) setDateDue(addDays(dateCreated, Number(t.no_of_days) || 0));
                  }}
                  onClear={() => { setPaymentTerm(null); setTerm(''); }}
                />
              </div>
              {/* A DR carries no BS/SI # (asked 2026-11-10): the field is not shown on a DR. */}
              {invoiceType !== 'DR' && <div className="field"><label>BS/SI #{bsSiRequired ? ' *' : ''}</label><input value={bsSiNo} onChange={(e) => setBsSiNo(e.target.value)} /></div>}
              <div className="field"><label>PO #</label><input value={poNo} onChange={(e) => setPoNo(e.target.value)} /></div>
              <div className="field"><label>Bill to Address</label><input value={billToAddress} onChange={(e) => setBillToAddress(e.target.value)} /></div>
              <div className="field"><label>Memo</label><textarea rows={4} value={memo} onChange={(e) => setMemo(e.target.value)} /></div>
            </div>
            <div className="card" style={{ background: 'var(--surface-2, #f3f4f6)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Sub Total</span><span className="hi">{money(subtotal)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Discount Amount</span><span className="hi">{money(discountAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Net of Tax</span><span className="hi">{money(netOfTax)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Expanded Withholding Tax</span><span className="hi">{money(ewtAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Tax Amount</span><span className="hi">{money(taxAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Gross Amount</span><span className="hi">{money(grossAmount)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}><span>Amount Due</span><span>{money(amountDue)}</span></div>
            </div>
          </div>

          <div className="table-wrap" style={{ marginTop: 20 }}>
            <table>
              <thead>
                <tr>
                  <th></th><th>#</th><th>JO #</th><th>Item</th><th>Description</th><th>Location</th><th>Qty</th><th>Unit</th>
                  <th>Price/Unit</th><th>Subtotal</th><th>Disc.%</th><th>Disc. Amt</th><th>Disc. Price/Unit</th>
                  <th>Net of Tax</th><th>Tax Code</th><th>Tax Amt</th><th>Gross Amt</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.length === 0 && (
                  <tr><td colSpan={17} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    {fromEstimate
                      ? (estimate ? 'This Estimate has no line items to invoice.' : 'Choose an Estimate to bill.')
                      : 'Nothing left to invoice.'}
                  </td></tr>
                )}
                {shownLines.map((l, idx) => {
                  const key = lineKey(data.lines[idx], idx);
                  const excluded = excludedIds.has(key);
                  return (
                    <tr key={key} style={excluded ? { opacity: 0.4, textDecoration: 'line-through' } : undefined}>
                      {/* First, so it is in view without scrolling the wide table; the totals follow. */}
                      <td>
                        {/* Converting a ticket bills it whole -- there is no partial
                            conversion, so excluding a line isn't offered here. */}
                        {!fromTicket && (
                          <button
                            type="button" className={`btn btn-sm${excluded ? '' : ' btn-danger'}`}
                            onClick={() => setExcludedIds((prev) => {
                              const next = new Set(prev);
                              if (excluded) next.delete(key); else next.add(key);
                              return next;
                            })}
                          >
                            {excluded ? 'Undo' : 'Delete'}
                          </button>
                        )}
                      </td>
                      <td>{idx + 1}</td>
                      {/* Blank only while there genuinely is no Job Order -- an Estimate that has
                          been converted shows the JO its line became. */}
                      <td title={fromEstimate && !l.job_order_no
                        ? 'No Job Order yet -- one is raised when this Estimate becomes a Sales Order'
                        : undefined}
                      >
                        {l.job_order_no || '—'}
                      </td>
                      <td>{l.item_name}</td>
                      <td>{l.description}</td>
                      <td>{l.job_location_name}</td>
                      <td>
                        {canEditQty && !excluded && Number(data.lines[idx].quantity) > 1 ? (
                          <input
                            type="number" min="0" step="any" style={{ width: 80, textAlign: 'right' }}
                            value={qtyEdits[key] ?? data.lines[idx].quantity ?? ''}
                            title={`Bill part of it: up to ${qty(data.lines[idx].quantity)}; the rest stays billable`}
                            onChange={(e) => setQtyEdits((prev) => ({ ...prev, [key]: e.target.value }))}
                          />
                        ) : qty(l.quantity)}
                      </td>
                      <td>{l.units}</td>
                      <td>
                        {canEditPrice && !excluded ? (
                          <input
                            type="number" min="0" step="0.01" style={{ width: 110, textAlign: 'right' }}
                            value={priceEdits[key] ?? data.lines[idx].price_per_unit ?? ''}
                            title="Change the price for this invoice; the amounts follow"
                            onChange={(e) => setPriceEdits((prev) => ({ ...prev, [key]: e.target.value }))}
                          />
                        ) : money(l.price_per_unit)}
                      </td>
                      <td>{money(l.subtotal)}</td>
                      <td>{l.disc_percent}</td>
                      <td>{money(l.disc_amount)}</td>
                      <td>{money(l.disc_price_per_unit)}</td>
                      <td>{money(l.net_of_tax)}</td>
                      <td>{l.tax_code}</td>
                      <td>{money(l.tax_amount)}</td>
                      <td>{money(l.gross_amount)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={saving || includedLines.length === 0} onClick={handleSave}>{saving ? <LoadingSpinner inline size="sm" label="Saving..." /> : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
