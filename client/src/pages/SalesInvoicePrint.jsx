import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import InvoicePrintType1, { FORM } from '../components/InvoicePrintType1';
import InvoicePrintType2 from '../components/InvoicePrintType2';
import DeliveryReceiptPrint from '../components/DeliveryReceiptPrint';
import { invoiceTotals } from '../utils/invoicePrint';

// Two invoice print formats, picked with ?type= :
//   Type 1 -- data-only overlay for the pre-printed "SERVICE INVOICE" pad (8.3 x 5.4in),
//             printed as the top band of a portrait A4 sheet.
//   Type 2 -- self-contained export-style INVOICE on plain A4; draws its own grid.
// Type 1 is the default because it is the one tied to the BIR-registered stationery.
//
// A Delivery Receipt takes neither: it has its own form (DeliveryReceiptPrint), which is the one
// the live system prints and the only one a DR has. The ?type= switch is not offered for it.
export default function SalesInvoicePrint() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const [si, setSi] = useState(null);

  // A Delivery Receipt is not a Service Invoice: it never goes on the pre-printed pad, and it
  // does not borrow the export-invoice grid either. It has its own form, whatever the URL asks.
  const isDr = si?.invoice_type === 'DR';
  const type = params.get('type') === '2' ? 2 : 1;
  const calibrate = params.get('calibrate') === '1';

  useEffect(() => {
    api.get(`/sales-invoices/${id}`).then(({ data }) => setSi(data));
  }, [id]);

  const totals = useMemo(() => invoiceTotals(si), [si]);

  if (!si) return <LoadingSpinner />;

  if (isDr) return <DeliveryReceiptPrint si={si} />;

  const setType = (t) => setParams(t === 1 ? {} : { type: '2' });

  return (
    <div className="si-print">
      <style>{`
        .si-print { background: #f1f5f9; padding: 16px 0 40px; }
        .si-toolbar, .si-hint { max-width: 210mm; margin: 0 auto 12px; }
        .si-toolbar { display: flex; gap: 8px; justify-content: flex-end; align-items: center; }
        .si-hint { font: 12px/1.5 system-ui, sans-serif; color: #475569; }
        @media print {
          .si-print { background: none; padding: 0; }
          .si-no-print { display: none !important; }
        }
      `}</style>

      <div className="si-toolbar si-no-print">
        <span style={{ marginRight: 'auto', font: '13px system-ui, sans-serif', color: '#334155' }}>
          {si.invoice_no} — {si.customer_name}
        </span>
        <button className={`btn btn-sm ${type === 1 ? 'btn-primary' : ''}`} onClick={() => setType(1)}>
          Type 1 · Pre-printed
        </button>
        <button className={`btn btn-sm ${type === 2 ? 'btn-primary' : ''}`} onClick={() => setType(2)}>
          Type 2 · Plain paper
        </button>
        {type === 1 && (
          <button className="btn btn-sm" onClick={() => setParams(calibrate ? {} : { calibrate: '1' })}>
            {calibrate ? 'Hide guides' : 'Calibrate'}
          </button>
        )}
        <button className="btn btn-sm btn-primary" onClick={() => window.print()}>Print</button>
      </div>

      {type === 1 && calibrate && (
        <div className="si-hint si-no-print">
          Guides on: 10mm grid, field outlines. Print this over a blank pre-printed form, measure any
          field that misses its box, and adjust <code>FORM</code> in <code>InvoicePrintType1.jsx</code> —
          every position is millimetres from the top-left of the {FORM.page.width}×{FORM.page.height}mm form,
          which prints at the top of a {FORM.sheet.width}×{FORM.sheet.height}mm portrait sheet.
        </div>
      )}

      {type === 1
        ? <InvoicePrintType1 si={si} totals={totals} calibrate={calibrate} />
        : <InvoicePrintType2 si={si} totals={totals} />}
    </div>
  );
}
