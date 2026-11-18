import { useEffect, useState } from 'react';
import api from '../api/client';
import Modal from './Modal';
import LoadingSpinner from './LoadingSpinner';

function money(v) { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'; }
function pct(v) { const n = Number(v); return Number.isFinite(n) ? `${n.toFixed(2)}%` : ''; }

// Estimate approval modal. Lists each job line with its GP rate vs the passing threshold. Passing
// lines are auto-approved; a below-GP line can only be ticked by an Admin / General Manager, and
// ticking it makes it count toward commission despite failing the GP rate.
export default function EstimateApprovalModal({ estimateId, nextStatus, onClose, onApproved }) {
  const [data, setData] = useState(null);
  const [checked, setChecked] = useState({});
  const [approvalCode, setApprovalCode] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Approving out of Pending Supervisor Approval (next = customer approval) is where low GP is
  // decided. "Approved by Customer" only records the customer's answer -- no GP gate there.
  const gpStage = nextStatus === 'pending_customer_approval';

  useEffect(() => {
    api.get(`/estimates/${estimateId}/approval-lines`).then(({ data: d }) => {
      setData(d);
      // Pre-tick lines already low-GP approved.
      setChecked(Object.fromEntries((d.lines || []).filter((l) => l.is_approved_low_gp).map((l) => [l.id, true])));
    }).catch((e) => setError(e.response?.data?.error || 'Failed to load.'));
  }, [estimateId]);

  async function approve() {
    setError(''); setSaving(true);
    try {
      // Only below-GP lines that were ticked need the override flag (passing lines count anyway).
      // Low-GP approval belongs to the supervisor stage only; recording the customer's answer
      // sends none (the server ignores them there too).
      const approvedLowGp = !gpStage ? [] : (data.lines || [])
        .filter((l) => !l.passed && !l.is_approved_low_gp && checked[l.id]).map((l) => l.id);
      await api.put(`/estimates/${estimateId}/status`, { status: nextStatus, approved_low_gp_line_ids: approvedLowGp });
      onApproved();
    } catch (e) { setError(e.response?.data?.error || 'Approval failed.'); setSaving(false); }
  }

  return (
    <Modal title="Enter your approval code." onClose={onClose} xl>
      {error && <div className="error-banner">{error}</div>}
      {!data ? <LoadingSpinner /> : (
        <div>
          <div className="field" style={{ marginBottom: 12 }}>
            <label>Approval Code</label>
            <input value={approvalCode} onChange={(e) => setApprovalCode(e.target.value)} />
          </div>

          {gpStage && !data.can_approve_low_gp && (data.lines || []).some((l) => !l.passed && !l.is_approved_low_gp) && (
            <div className="muted" style={{ marginBottom: 8 }}>Below-GP lines can only be approved by an Admin or General Manager.</div>
          )}

          <div className="table-wrap">
            <table>
              <thead><tr>
                <th>#</th><th>Job Type</th><th>Description</th><th style={{ textAlign: 'right' }}>Qty</th>
                <th style={{ textAlign: 'right' }}>Price/Unit</th><th style={{ textAlign: 'right' }}>Subtotal</th>
                <th style={{ textAlign: 'right' }}>Disc. Price/Unit</th><th style={{ textAlign: 'right' }}>Net of Tax</th>
                <th>Tax Code</th><th style={{ textAlign: 'right' }}>Gross Amt</th><th>L × W × H / UOM</th>
                <th style={{ textAlign: 'right' }}>GP Rate</th><th style={{ textAlign: 'center' }}>Approve</th>
              </tr></thead>
              <tbody>
                {(data.lines || []).map((l) => (
                  <tr key={l.id} style={!l.passed ? { background: 'rgba(220,38,38,0.06)' } : undefined}>
                    <td>{l.line_no}</td>
                    <td>{l.job_type_name}</td>
                    <td>{l.description}</td>
                    <td style={{ textAlign: 'right' }}>{Number(l.quantity)} {l.units}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.price_per_unit)}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.subtotal)}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.disc_price_per_unit)}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.net_of_tax)}</td>
                    <td>{l.tax_code}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.gross_amount)}</td>
                    <td>{l.length ?? 0}×{l.width ?? 0}×{l.height ?? 0} / {l.uom}</td>
                    <td style={{ textAlign: 'right', color: l.passed ? '#16a34a' : '#dc2626', fontWeight: 600 }}>{pct(l.gp_rate)}</td>
                    <td style={{ textAlign: 'center' }}>
                      {/* Passing lines are informational (already approved by GP); below-GP lines are
                          the ones an Admin/GM can override. */}
                      <input type="checkbox"
                        checked={l.passed ? true : !!checked[l.id]}
                        disabled={l.passed || !gpStage || !data.can_approve_low_gp}
                        onChange={(e) => setChecked((c) => ({ ...c, [l.id]: e.target.checked }))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Matches the button that opened this. nextStatus 'approved' is only reached from
              pending customer approval, so that is the step where what is being recorded is the
              CUSTOMER's decision rather than the operator's own. */}
          <button type="button" className="btn btn-primary" style={{ width: '100%', marginTop: 16 }} disabled={saving} onClick={approve}>
            {saving ? 'Approving...' : (nextStatus === 'approved' ? 'Approved by Customer' : 'Approve')}
          </button>
        </div>
      )}
    </Modal>
  );
}
