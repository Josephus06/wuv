import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { usePeriodLocked } from '../utils/periodLock';
import { useAuth } from '../context/useAuth';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDate } from '../utils/dates';

function money(v) { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function formatDate(v) { return v ? displayDate(v) : ''; }

// OSR Fulfillment (OSRF-####): the document created when an Office Supply Requisition is fulfilled.
// It moved the stock and posts DR 30504 / CR 15400 for the value withdrawn.
export default function OsrFulfillmentView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [f, setF] = useState(null);
  const [tab, setTab] = useState('items');
  const [loading, setLoading] = useState(true);

  useEffect(() => { api.get(`/office-supply-requisitions/fulfillments/${id}`).then(({ data }) => { setF(data); setLoading(false); }); }, [id]);

  // Closed accounting period: no Edit / Void / Cancel (utils/periodLock.js; the server refuses them too).
  const periodLocked = usePeriodLocked(f?.date_created, 'non_gl');

  if (loading || !f) return <LoadingSpinner />;
  const lines = f.lines || [];
  const gl = f.gl || [];
  const totalDebit = gl.reduce((s, l) => s + num(l.debit), 0);
  const totalCredit = gl.reduce((s, l) => s + num(l.credit), 0);
  // No permission page of its own -- inherits the OSR's edit right.
  const canEdit = (can('/office-supply-requisitions', 'can_edit') && !periodLocked);

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={`/office-supply-requisitions/${f.osr_id}`}>Back</Link>
          {canEdit && <button className="btn btn-sm" disabled title="Editing a saved OSR Fulfillment isn't implemented in this build">Edit</button>}
        </div>
      </div>

      {periodLocked && (
        <div className="warning-banner" style={{ marginBottom: 12 }}>
          The accounting period for this transaction is closed ({periodLocked}), so it can no longer be edited, voided or cancelled.
        </div>
      )}
      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>OSR Fulfillment</h1>
          <span className="estimate-no">{f.osrf_no}</span>
        </div>
        <div className="estimate-detail-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: 12 }}>
          <div>
            <div>OSR Fulfillment # : <span className="hi">{f.osrf_no}</span></div>
            <div>Date : <span className="hi">{formatDate(f.date_created)}</span></div>
            <div>Created From : <Link className="estimate-so-link" to={`/office-supply-requisitions/${f.osr_id}`}>{f.created_from_osr_no}</Link></div>
          </div>
          <div>
            <div>Withdraw From : <span className="hi">{f.withdraw_from_name || ''}</span></div>
            <div>Transfer To : <span className="hi">{f.transfer_to_name || ''}</span></div>
            <div>Memo : <span className="hi">{f.memo || ''}</span></div>
          </div>
          <div>
            <div>Requestor : <span className="hi">{f.requestor_name || ''}</span></div>
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>Items</button>
        <button className={`status-tab ${tab === 'gl' ? 'active' : ''}`} onClick={() => setTab('gl')}>GL Impact</button>
      </div>

      {tab === 'items' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>#</th><th>Item</th><th style={{ textAlign: 'right' }}>Requested Qty</th><th style={{ textAlign: 'right' }}>Fulfilled Qty</th><th style={{ textAlign: 'right' }}>Qty On Hand</th><th>UOM</th><th>Unit</th></tr></thead>
              <tbody>
                {lines.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No items.</td></tr>}
                {lines.map((l, i) => (
                  <tr key={l.id}>
                    <td>{i + 1}</td><td>{l.item_code} — {l.item_name}</td>
                    <td style={{ textAlign: 'right' }}>{num(l.requested_qty)}</td>
                    <td style={{ textAlign: 'right' }}>{num(l.fulfilled_qty)}</td>
                    <td style={{ textAlign: 'right' }}>{l.on_hand == null ? '' : num(l.on_hand)}</td>
                    <td>{l.uom}</td><td>{l.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'gl' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Account Code</th><th>Account Title</th><th style={{ textAlign: 'right' }}>Debit</th><th style={{ textAlign: 'right' }}>Credit</th></tr></thead>
              <tbody>
                {gl.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No GL impact.</td></tr>}
                {gl.map((l, i) => (
                  <tr key={i}><td>{l.account_code}</td><td>{l.account_name}</td><td style={{ textAlign: 'right' }}>{money(l.debit)}</td><td style={{ textAlign: 'right' }}>{money(l.credit)}</td></tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700 }}><td colSpan={2} style={{ textAlign: 'right' }}>Total</td><td style={{ textAlign: 'right' }}>{money(totalDebit)}</td><td style={{ textAlign: 'right' }}>{money(totalCredit)}</td></tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
