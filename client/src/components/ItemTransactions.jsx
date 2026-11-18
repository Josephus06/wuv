import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from './LoadingSpinner';
import Pagination from './Pagination';
import { displayDate } from '../utils/dates';

const PAGE_SIZE = 25;
// Short codes as the documents are known on the floor, in the order they happen to stock.
const TYPES = [
  ['Purchase Requisition', 'PR'], ['Purchase Order', 'PO'], ['Receiving Report', 'RR'], ['Vendor Return', 'VR'], ['Transfer Order', 'TO'],
  ['Item Fulfillment', 'IF'], ['Item Receipt', 'IR'], ['Assembly Build', 'AB'], ['Inventory Adjustment', 'IA'],
  ['Office Supply Fulfillment', 'OSRF'],
];
// Where each document opens. The ledger's doc_id is that document's own id.
const LINK = {
  'Purchase Requisition': (id) => `/purchase-requisitions/${id}`,
  'Purchase Order': (id) => `/purchase-orders/${id}`,
  'Receiving Report': (id) => `/purchase-orders/receipts/${id}`,
  'Vendor Return': (id) => `/purchase-orders/returns/${id}`,
  'Transfer Order': (id) => `/transfer-orders/${id}`,
  'Item Fulfillment': (id) => `/transfer-orders/item-fulfillments/${id}`,
  'Item Receipt': (id) => `/transfer-orders/item-receipts/${id}`,
  'Assembly Build': (id) => `/assembly-builds/${id}`,
  'Inventory Adjustment': (id) => `/inventory-adjustments/${id}`,
  'Office Supply Fulfillment': (id) => `/office-supply-requisitions/fulfillments/${id}`,
};

function qty(v) {
  if (v == null) return '';
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '';
}
function day(v) { return v ? displayDate(v) : ''; }
function label(s) { return s ? String(s).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : ''; }

// The Inventory Item's Transactions tab: every document this item appears on, newest first, from
// GET /inventory/:id/transactions. Stock movements show In/Out in the Base Unit -- the same figures
// as the Bin Card. Purchase Requisitions, Purchase Orders and Transfer Orders ask for stock without moving it, so they
// show their own ordered/requested quantity and status instead.
export default function ItemTransactions({ itemId, baseUnit }) {
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setData(null); setError('');
    api.get(`/inventory/${itemId}/transactions`, { params: { page, page_size: PAGE_SIZE, ...(type ? { type } : {}) } })
      .then(({ data: d }) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e.response?.data?.error || 'Could not load transactions.'); });
    return () => { cancelled = true; };
  }, [itemId, type, page]);

  const counts = data?.counts || {};
  const all = Object.values(counts).reduce((s, n) => s + n, 0);
  const pick = (t) => { setType(t); setPage(1); };

  return (
    <div className="card">
      <div className="status-tabs" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <button type="button" className={`status-tab ${!type ? 'active' : ''}`} onClick={() => pick('')}>All {data ? all.toLocaleString() : ''}</button>
        {TYPES.map(([t, code]) => (
          <button key={t} type="button" title={t} className={`status-tab ${type === t ? 'active' : ''}`} onClick={() => pick(t)}>
            {code} {counts[t] ? counts[t].toLocaleString() : 0}
          </button>
        ))}
      </div>
      {error && <div className="error-banner">{error}</div>}
      {!data && !error ? <LoadingSpinner /> : data && (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th><th>Type</th><th>Transaction #</th><th>Reference</th><th>From</th><th>To</th>
                  <th style={{ textAlign: 'right' }}>In ({baseUnit || 'Base'})</th>
                  <th style={{ textAlign: 'right' }}>Out ({baseUnit || 'Base'})</th>
                  <th style={{ textAlign: 'right' }}>Ordered / Requested</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && (
                  <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 20 }}>No transactions{type ? ` of this type` : ''} for this item.</td></tr>
                )}
                {data.rows.map((r, i) => {
                  const to = LINK[r.trans_type]?.(r.doc_id);
                  return (
                    <tr key={`${r.trans_type}-${r.doc_id}-${i}`}>
                      <td>{day(r.trans_date)}</td>
                      <td>{r.trans_type}</td>
                      <td>{to ? <Link to={to}>{r.trans_no}</Link> : r.trans_no}</td>
                      <td>{r.ref_no || ''}</td>
                      <td>{r.from_location_name || ''}</td>
                      <td>{r.to_location_name || ''}</td>
                      <td style={{ textAlign: 'right' }}>{qty(r.qty_in)}</td>
                      <td style={{ textAlign: 'right' }}>{qty(r.qty_out)}</td>
                      <td style={{ textAlign: 'right' }}>{r.doc_qty != null ? `${qty(r.doc_qty)} ${r.doc_uom || ''}` : ''}</td>
                      <td>{label(r.status)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination page={page} totalPages={Math.max(1, Math.ceil(data.total / PAGE_SIZE))} onChange={setPage} />
        </>
      )}
    </div>
  );
}
