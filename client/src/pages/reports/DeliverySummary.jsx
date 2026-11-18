import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import { CustomerLink } from '../../components/PartyLink';
import LoadingSpinner from '../../components/LoadingSpinner';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function count(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US') : '';
}

// The month just gone -- what you actually want open when you run this in early October.
function lastMonth() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: iso(first), to: iso(last) };
}

// Month-end: how many deliveries went out by each method, and what the outside couriers cost.
export default function DeliverySummary() {
  const [range, setRange] = useState(lastMonth);
  const [applied, setApplied] = useState(lastMonth);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showDetail, setShowDetail] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (r) => {
    setLoading(true); setError('');
    try {
      const { data: d } = await api.get('/reports/delivery-summary', { params: { from: r.from, to: r.to } });
      setData(d);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not load the report.');
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(applied); }, [load, applied]);

  async function download() {
    const res = await api.get('/reports/delivery-summary', {
      params: { from: applied.from, to: applied.to, format: 'csv' },
      responseType: 'blob',
    });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = `delivery-summary-${applied.from}-to-${applied.to}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const rows = data?.rows || [];
  const totals = data?.totals;
  // "Not specified" is a data-quality warning, not a delivery method -- call it out rather than
  // leaving someone to notice a total that does not add up to what they expected.
  const unspecified = rows.find((r) => r.delivery_method_id === null);
  const missingCost = rows
    .filter((r) => r.delivery_method_id !== null && r.missing_cost_count > 0)
    .reduce((n, r) => n + r.missing_cost_count, 0);

  return (
    <div>
      <div className="page-header">
        <h1>Delivery Summary</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to="/item-deliveries">Item Deliveries</Link>
          <button className="btn btn-sm" disabled={!data} onClick={download}>Download CSV</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="field">
            <label>From</label>
            <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          </div>
          <div className="field">
            <label>To</label>
            <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
          </div>
          <div className="field" style={{ alignSelf: 'end' }}>
            <button className="btn btn-primary" onClick={() => setApplied({ ...range })}>Run</button>
          </div>
        </div>
      </div>

      {loading ? <LoadingSpinner /> : (
        <>
          <div className="card" style={{ marginTop: 16 }}>
            <h3 className="subsection" style={{ marginTop: 0 }}>
              {applied.from} to {applied.to}
            </h3>
            <div className="table-wrap">
              <table className="responsive-cards">
                <thead>
                  <tr>
                    <th>Delivered Via</th>
                    <th style={{ textAlign: 'right' }}>Deliveries</th>
                    <th style={{ textAlign: 'right' }}>Qty Delivered</th>
                    <th style={{ textAlign: 'right' }}>Total Cost</th>
                    <th style={{ textAlign: 'right' }}>Cost Not Recorded</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.delivery_method_id ?? 'none'}>
                      <td data-label="Delivered Via">
                        {r.delivery_method_id === null
                          ? <span className="muted">Not specified</span>
                          : r.delivery_method_name}
                        {r.is_third_party && <span className="badge badge-muted" style={{ marginLeft: 6 }}>courier</span>}
                      </td>
                      <td data-label="Deliveries" style={{ textAlign: 'right' }}>{count(r.delivery_count)}</td>
                      <td data-label="Qty Delivered" style={{ textAlign: 'right' }}>{count(r.total_qty)}</td>
                      <td data-label="Total Cost" style={{ textAlign: 'right' }}>
                        {r.delivery_method_id === null ? '--' : money(r.total_cost)}
                      </td>
                      <td data-label="Cost Not Recorded" style={{ textAlign: 'right' }}>
                        {r.missing_cost_count > 0
                          ? <span style={{ color: '#b45309' }}>{count(r.missing_cost_count)}</span>
                          : '--'}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th>Total</th>
                    <th style={{ textAlign: 'right' }}>{count(totals?.delivery_count)}</th>
                    <th style={{ textAlign: 'right' }}>{count(totals?.total_qty)}</th>
                    <th style={{ textAlign: 'right' }}>{money(totals?.total_cost)}</th>
                    <th style={{ textAlign: 'right' }}>{count(totals?.missing_cost_count)}</th>
                  </tr>
                </tfoot>
              </table>
            </div>

            {(unspecified?.delivery_count > 0 || missingCost > 0) && (
              <div className="muted" style={{ marginTop: 12, fontSize: 13 }}>
                {unspecified?.delivery_count > 0 && (
                  <div>
                    {count(unspecified.delivery_count)} deliver{unspecified.delivery_count === 1 ? 'y has' : 'ies have'} no
                    method recorded, so {unspecified.delivery_count === 1 ? 'it is' : 'they are'} not counted under any
                    courier. Deliveries raised before this feature existed will always read this way.
                  </div>
                )}
                {missingCost > 0 && (
                  <div style={{ marginTop: 4 }}>
                    {count(missingCost)} deliver{missingCost === 1 ? 'y has' : 'ies have'} a method but no cost yet, so the
                    total above is lower than the real spend. Open the delivery to add the fare.
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div className="page-header" style={{ marginBottom: 8 }}>
              <h3 className="subsection" style={{ margin: 0 }}>
                Deliveries ({count(data?.detail?.length)})
              </h3>
              <button className="btn btn-sm" onClick={() => setShowDetail((v) => !v)}>
                {showDetail ? 'Hide' : 'Show'}
              </button>
            </div>
            {data?.detail_truncated && (
              <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                Showing the first {count(data.detail_limit)} only. Narrow the dates, or use the CSV.
              </div>
            )}
            {showDetail && (
              <div className="table-wrap">
                <table className="responsive-cards">
                  <thead>
                    <tr>
                      <th>ID #</th><th>Date</th><th>Delivered Via</th><th>Reference</th>
                      <th>SO #</th><th>Customer</th>
                      <th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.detail || []).length === 0 && (
                      <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                        No deliveries in this range.
                      </td></tr>
                    )}
                    {(data?.detail || []).map((r) => (
                      <tr key={r.id}>
                        <td data-label="ID #"><Link to={`/item-deliveries/${r.id}`}>{r.delivery_no}</Link></td>
                        <td data-label="Date">{String(r.date_created).slice(0, 10)}</td>
                        <td data-label="Delivered Via">{r.delivery_method_name}</td>
                        <td data-label="Reference">{r.delivery_reference || '--'}</td>
                        <td data-label="SO #">{r.sales_order_no}</td>
                        <td data-label="Customer"><CustomerLink id={r.customer_id} name={r.customer_name} /></td>
                        <td data-label="Qty" style={{ textAlign: 'right' }}>{count(r.total_qty)}</td>
                        <td data-label="Cost" style={{ textAlign: 'right' }}>
                          {r.delivery_cost == null ? '--' : money(r.delivery_cost)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
