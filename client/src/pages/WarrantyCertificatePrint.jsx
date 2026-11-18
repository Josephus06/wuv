import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import { COMPANY } from '../config/company';

function formatDate(v) { return v ? displayDate(v) : ''; }

const COVERAGE_TERMS = [
  ['Structural', 'Poles, Foundation and Frames'],
  ['Electrical', 'Lighting Fixtures, Electrical Accessories'],
  ['Sticker Printing Without Laminate (Non 3M)', 'Non 3M Stickers against Peel-off and Color Fastness'],
  ['Sticker Printing With Cold UV Laminate (Non 3M)', 'Non 3M Laminates against Peel-off and Color Fastness'],
  ['Sticker Printing Without Laminate (3M)', '3M Stickers against Peel-off and Color Fastness'],
  ['Sticker Printing With Cold UV Laminate (3M)', '3M Laminates against Peel-off and Color Fastness'],
  ['Flex Printing (Non 3M)', 'Non 3M Flex against Color Fastness'],
  ['Flex Printing (3M)', '3M Flex against Color Fastness'],
];

// Printable Warranty Certificate -- renders standalone (no app chrome) and triggers the print
// dialog once loaded, mirroring the live 2-page PDF (terms page + certificate details page).
export default function WarrantyCertificatePrint() {
  const { id } = useParams();
  const [wc, setWc] = useState(null);

  useEffect(() => {
    api.get(`/warranty-certificates/${id}`).then(({ data }) => {
      setWc(data);
      setTimeout(() => window.print(), 400);
    });
  }, [id]);

  if (!wc) return <LoadingSpinner />;
  const lines = wc.lines || [];
  const groups = lines.reduce((acc, l) => {
    // A line may carry several coverages ("Structural, Electrical"); it is listed under each.
    const keys = String(l.coverage || '').split(',').map((x) => x.trim()).filter(Boolean);
    for (const k of keys.length ? keys : ['—']) (acc[k] = acc[k] || []).push(l);
    return acc;
  }, {});
  const validities = Object.keys(groups).filter((k) => k !== '—');

  return (
    <div className="wc-print">
      <style>{`
        .wc-print { max-width: 820px; margin: 0 auto; padding: 32px; color: #1f2937; font-size: 13px; line-height: 1.55; }
        .wc-print h2 { color: #4338ca; margin: 0 0 4px; }
        .wc-brand { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px; margin-bottom: 18px; }
        /* Replaces the typed GRAPHICSTAR wordmark. "IMAGING CORP." came off the address line
           with it -- the artwork carries the name, and printing it twice read as a mistake. */
        .wc-logo { width: 48mm; height: auto; display: block; margin-bottom: 4px; }
        .wc-title { background: linear-gradient(90deg,#4338ca,#a5b4fc); color: #fff; padding: 10px 16px; border-radius: 4px; font-size: 20px; font-weight: 700; }
        .wc-print h3 { margin: 20px 0 6px; color: #111827; }
        .wc-print .band { background: #eef2f7; font-weight: 700; padding: 6px 10px; margin-top: 14px; }
        .wc-print table { width: 100%; border-collapse: collapse; margin-top: 6px; }
        .wc-print th, .wc-print td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
        .wc-row { display: grid; grid-template-columns: 180px 1fr; padding: 3px 8px; }
        .wc-page-break { page-break-before: always; }
        @media print { .wc-no-print { display: none; } @page { margin: 14mm; } }
      `}</style>

      <div className="wc-no-print" style={{ textAlign: 'right', marginBottom: 10 }}>
        <button className="btn btn-sm btn-primary" onClick={() => window.print()}>Print</button>
      </div>

      {/* Page 1 -- terms */}
      <div className="wc-brand">
        <div>
          <div className="co">{COMPANY.short}</div>
          <div style={{ fontSize: 11 }}>{COMPANY.name}<br />{COMPANY.addressLine1} {COMPANY.addressLine2}<br />{COMPANY.phone ? `Tel. ${COMPANY.phone} / ` : ''}{COMPANY.website}</div>
        </div>
        <div className="wc-title">Warranty Certificate</div>
      </div>

      <p>{COMPANY.name} aims to provide maximum <b>Quality</b> and <b>Efficiency</b> with minimal maintenance and costs. In most instances, any problems arising from our installed signage in your establishment due to deficiency will be covered by this agreement. <b>You are agreeable to the terms and conditions stated below.</b> This warranty covers premature failure due to unsatisfactory workmanship, fading, discoloration, grazing, peeling, blistering, excessive dimensional change, and loss of adhesion. Materials used are also warranted to retain acceptable appearance for their intended use over their warranted life when viewed from normal viewing distance. As graphics age and are subject to natural wear and tear, there can be gradual gloss reduction, slight color changes, small lifting at edges or around rivets and, ultimately, minor cracking which will not materially detract appearance. These changes are not evidence of material failure, but are normal consequences of wear and tear, therefore not covered by warranty. If any material is proven to be defective and it fails to perform as stated in the Warranty Certificate, this will be replaced by {COMPANY.name} at NO COST to the customer.</p>

      <h3>LIMITATIONS and EXCLUSIONS</h3>
      <p>However, damages i.e accidents, fortuitous events, negligence on the part of the client or any other causes which are beyond our control shall not be covered by this warranty. {COMPANY.name} will also not cover any repair or replacement required as a direct result of unauthorized modification of item.</p>
      <div>
        {COVERAGE_TERMS.map(([k, v]) => <div key={k} style={{ padding: '2px 0' }}><b>{k} :</b> {v}</div>)}
      </div>

      <h3>WARRANTY CLAIMS</h3>
      <p>Present this Warranty Certificate to our Account Officers when claiming. This will be forwarded to the Quality Assurance Department for checking and verification. Please give us three (3) working days to process your claim upon the approval of the Quality Assurance Supervisor.</p>

      {/* Page 2 -- certificate details */}
      <div className="wc-page-break" />
      <div className="wc-brand">
        <div>
          <div className="co">{COMPANY.short}</div>
          <div style={{ fontSize: 11 }}>{COMPANY.name}<br />{COMPANY.addressLine1} {COMPANY.addressLine2}<br />{COMPANY.phone ? `Tel. ${COMPANY.phone} / ` : ''}{COMPANY.website}</div>
        </div>
        <div className="wc-title">Warranty Certificate</div>
      </div>
      <div style={{ textAlign: 'right', color: '#6b7280', marginBottom: 8 }}>Warranty # : <b>{wc.wc_no}</b></div>

      <div className="band">Customer Information</div>
      <div className="wc-row"><span>Customer :</span><span>{wc.customer_name}</span></div>
      <div className="wc-row"><span>Contact Person :</span><span>{wc.contact_name}</span></div>
      <div className="wc-row"><span>Contact Number :</span><span>{wc.contact_number}</span></div>
      <div className="wc-row"><span>Address :</span><span>{wc.address}</span></div>

      <div className="band">Project Information</div>
      <div className="wc-row"><span>Project Name :</span><span>{wc.contract_description}</span></div>
      <div className="wc-row"><span>Sales Order No. :</span><span>{wc.sales_order_no}</span></div>
      <div className="wc-row"><span>Sales Order Date :</span><span>{formatDate(wc.sales_order_date)}</span></div>

      {Object.entries(groups).map(([coverage, gls]) => (
        <div key={coverage}>
          <div className="band" style={{ textAlign: 'center' }}>{coverage}</div>
          <table>
            <thead><tr><th>Job Order #</th><th>Job Description</th><th>Warranty Coverage Date</th><th>Remarks</th></tr></thead>
            <tbody>
              {gls.map((l) => (
                <tr key={l.id}>
                  <td>{l.job_order_no}</td><td>{l.job_description}</td>
                  <td>{formatDate(l.warranty_date_from)} to {formatDate(l.warranty_date_to)}</td>
                  <td>{l.remarks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <div className="band">Warranty Coverage</div>
      <table>
        <thead><tr><th>COVERAGE</th><th>VALIDITY</th></tr></thead>
        <tbody>
          {validities.map((c) => <tr key={c}><td>{c}</td><td>1 YEAR</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}
