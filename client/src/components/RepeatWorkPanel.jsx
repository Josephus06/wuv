import { useEffect, useState } from 'react';
import api from '../api/client';

import { displayMonth } from '../utils/dates';

// "We have made this before."
//
// A third of what this company prints, it has printed before -- 6,981 descriptions repeat
// across 40,845 job orders -- and until now the only way to find the last one was to remember
// it. This sits under the job order lines on an estimate and answers the question the rep
// actually has: what do we normally charge for this.
//
// IT SHOWS A BAND, NOT A PRICE. Deliberately. For POSTER at qty 1 the mean is 179.59 and the
// median is 100.00, because one line at 18,342.86 drags it -- a single number would have quoted
// this at nearly double. "Normally 91 to 226" is an honest answer; "the price is 179" is not.
//
// GP is shown only when it exists, with the count it is based on. Only 13% of historical lines
// carry a non-zero gp_rate, so "68.9% GP" unqualified would read as fact when it is 115 rows
// out of 6,856.

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
}
function shortDate(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : displayMonth(d);
}

export default function RepeatWorkPanel({ lineNo, description, jobTypeId, quantity, units }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const desc = String(description || '').trim();

  useEffect(() => {
    if (desc.length < 3) { setData(null); return undefined; }
    // Debounced: this hangs off a field somebody is typing into, and a request per keystroke
    // would be both wasteful and jumpy to read.
    let cancelled = false;
    const t = setTimeout(() => {
      setLoading(true);
      api.get('/repeat-work', {
        params: {
          description: desc,
          job_type_id: jobTypeId || undefined,
          quantity: quantity || undefined,
          units: units || undefined,
        },
      })
        .then(({ data: d }) => { if (!cancelled) setData(d); })
        // Silent: this is an aid, never a blocker. A rep who cannot reach it should still be
        // able to finish the quote.
        .catch(() => { if (!cancelled) setData(null); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [desc, jobTypeId, quantity, units]);

  if (desc.length < 3) return null;
  if (loading && !data) return <div className="muted" style={{ fontSize: 12, padding: '6px 0' }}>Checking past jobs for “{desc}”…</div>;
  if (!data?.summary) {
    return (
      <div className="muted" style={{ fontSize: 12, padding: '6px 0' }}>
        Line {lineNo}: no comparable past job for “{desc}”{units ? ` in ${units}` : ''}.
      </div>
    );
  }

  const s = data.summary;

  return (
    <div className="card" style={{ padding: '10px 14px', marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13 }}>Line {lineNo} · {desc}</strong>
        <span style={{ fontSize: 13 }}>
          normally{' '}
          <span className="hi">{money(s.price_p25)}</span> – <span className="hi">{money(s.price_p75)}</span>
          {' '}· median <span className="hi">{money(s.price_median)}</span>
        </span>
        <span className="muted" style={{ fontSize: 12 }}>
          from {s.sample.toLocaleString()} past line{s.sample === 1 ? '' : 's'}
          {s.narrowed_by?.units ? ` in ${s.narrowed_by.units}` : ''}
          {s.narrowed_by?.quantity_within ? ', similar quantity' : ''}
        </span>
        {s.gp_sample > 0 && (
          <span className="muted" style={{ fontSize: 12 }}>
            · GP <span className="hi">{Number(s.gp_median).toFixed(1)}%</span> (from {s.gp_sample} that recorded one)
          </span>
        )}
        <button
          type="button"
          className="btn btn-sm"
          style={{ marginLeft: 'auto' }}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          {open ? 'Hide' : `Show ${data.matches.length} job${data.matches.length === 1 ? '' : 's'}`}
        </button>
      </div>

      {/* The full range is kept out of the headline and shown here: it is useful context for
          "is this job ever wildly different" but it is not what the rep should quote from. */}
      {open && (
        <div style={{ marginTop: 10 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            Full range {money(s.price_min)} – {money(s.price_max)}.
            {s.scoped && ' The jobs listed are yours; the figures above are company-wide.'}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Sales Order</th><th>When</th><th>Customer</th><th>Job Type</th>
                  <th style={{ textAlign: 'right' }}>Qty</th><th>Unit</th>
                  <th style={{ textAlign: 'right' }}>Price/Unit</th><th style={{ textAlign: 'right' }}>GP</th>
                </tr>
              </thead>
              <tbody>
                {data.matches.length === 0 && (
                  <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 14 }}>
                    None of these are on your own sales orders.
                  </td></tr>
                )}
                {data.matches.map((m) => (
                  <tr key={m.id}>
                    <td><a href={`/sales-orders/${m.sales_order_id}`} target="_blank" rel="noreferrer">{m.sales_order_no}</a></td>
                    <td>{shortDate(m.date_created)}</td>
                    <td>{m.customer_name || '—'}</td>
                    <td>{m.job_type_name || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{m.quantity}</td>
                    <td>{m.units || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{money(m.price_per_unit)}</td>
                    <td style={{ textAlign: 'right' }}>{Number(m.gp_rate) > 0 ? `${Number(m.gp_rate).toFixed(1)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
