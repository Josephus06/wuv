import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import DraftEditorModal from './DraftEditorModal';
import LoadingSpinner from './LoadingSpinner';

const KIND_BADGE = { checkin: ['Check-in', 'badge-info'], birthday: ['Birthday', 'badge-success'] };

function formatDateTime(v) { return v ? new Date(String(v).replace(' ', 'T')).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: 'numeric', minute: '2-digit' }) : ''; }

// The rep's outbox-in-waiting: drafts written overnight (or on request) for them to review and
// send, plus what was already sent or thrown away.
export default function CrmDrafts() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('draft');
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);

  async function load(s = status) {
    const { data: d } = await api.get('/crm/drafts', { params: { status: s } });
    setData(d);
  }

  useEffect(() => { setData(null); load(status); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div className="status-tabs" style={{ marginBottom: 12 }}>
        {[['draft', 'To Review'], ['sent', 'Sent'], ['discarded', 'Discarded']].map(([k, l]) => (
          <button key={k} type="button" className={`status-tab ${status === k ? 'active' : ''}`} onClick={() => setStatus(k)}>{l}</button>
        ))}
      </div>
      {!data ? <LoadingSpinner /> : (
        <div className="card">
          {!data.ai && status === 'draft' && (
            <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
              AI writing is off on this server (no OpenAI key), so drafts use a plain template. They can still be edited before sending.
            </div>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Customer</th><th>To</th><th>Type</th><th>Subject</th><th>Why</th><th>{status === 'sent' ? 'Sent' : 'Written'}</th><th /></tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && (
                  <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    {status === 'draft' ? 'No drafts waiting. New ones are written every night, or use Draft Email on a customer.' : 'Nothing here.'}
                  </td></tr>
                )}
                {data.rows.map((d) => {
                  const [label, badge] = KIND_BADGE[d.kind] || [d.kind, 'badge-muted'];
                  return (
                    <tr key={d.id}>
                      <td><Link className="link-btn" to={`/customers/${d.customer_id}?tab=activity`}>{d.customer_name}</Link></td>
                      <td>{d.contact_name || ''}<div className="muted" style={{ fontSize: 12 }}>{d.to_email}</div></td>
                      <td><span className={`badge ${badge}`}>{label}</span></td>
                      <td>{d.subject}</td>
                      <td style={{ maxWidth: 320, fontSize: 12 }} className="muted">{d.error ? <span style={{ color: 'var(--color-danger-text)' }}>{d.error}</span> : d.reason}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(status === 'sent' ? d.sent_at : d.created_at)}{status === 'sent' && d.sent_by_name ? <div className="muted" style={{ fontSize: 12 }}>{d.sent_by_name}</div> : null}</td>
                      <td>{status === 'draft' && <button type="button" className="btn btn-sm btn-primary" onClick={() => setOpen(d)}>Review</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {open && <DraftEditorModal draft={open} customerName={open.customer_name} onClose={() => setOpen(null)} onChanged={() => load()} />}
    </div>
  );
}
