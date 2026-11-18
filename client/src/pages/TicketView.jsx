import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import EntityPicker from '../components/EntityPicker';
import Modal from '../components/Modal';
import TicketAttachments from '../components/TicketAttachments';
import LoadingSpinner from '../components/LoadingSpinner';
import { parseUtc } from '../utils/datetime';

const STATUS_LABELS = { open: 'Open', in_progress: 'In Progress', resolved: 'Resolved', closed: 'Closed', declined: 'Declined' };
const STATUS_BADGE = { open: 'badge-info', in_progress: 'badge-muted', resolved: 'badge-success', closed: 'badge-success', declined: 'badge-danger' };

function formatDateTime(v) {
  // UTC in the database, no marker on the wire -- see utils/datetime.js.
  return v ? parseUtc(v).toLocaleString('en-US', { month: 'short', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
}

// Full-page equivalent of the chat widget's ticket thread (ChatWidget.jsx) -- reached
// either from the Tickets queue (department heads) or the widget's "open full ticket"
// shortcut. Same visibility/authorization rules as the widget: GET /tickets/:id already
// scopes to what this viewer is allowed to see, so a 404 here just means "not yours."
export default function TicketView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, can } = useAuth();
  const [ticket, setTicket] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [users, setUsers] = useState([]);
  const [reply, setReply] = useState('');
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [declineError, setDeclineError] = useState('');
  const bottomRef = useRef(null);

  async function load() {
    try {
      const [t, d] = await Promise.all([
        api.get(`/tickets/${id}`),
        api.get('/tickets/meta/departments'),
      ]);
      setTicket(t.data);
      setDepartments(d.data);
    } catch (err) {
      if (err.response?.status === 404) setNotFound(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [ticket]);

  const canManage = useMemo(() => {
    if (!ticket) return false;
    return departments.some((d) => d.head_user_id === user?.id && (d.id === ticket.department_id || d.name === 'System Admin'));
  }, [departments, ticket, user]);

  useEffect(() => {
    // Scoped to this ticket's own department -- a supervisor can only assign within
    // their department, not org-wide (see server/src/routes/tickets.js's
    // /meta/assignable-users, which now requires department_id).
    if (canManage && ticket?.department_id && users.length === 0) {
      api.get('/tickets/meta/assignable-users', { params: { department_id: ticket.department_id } })
        .then(({ data }) => setUsers(data)).catch(() => {});
    }
  }, [canManage, ticket?.department_id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleReply(e) {
    e.preventDefault();
    if (!reply.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api.post(`/tickets/${id}/messages`, { message: reply.trim() });
      setReply('');
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send message');
    } finally {
      setBusy(false);
    }
  }

  async function handleAssign(u) {
    try {
      await api.put(`/tickets/${id}/assign`, { assigned_to_user_id: u.id });
      await load();
    } catch (err) {
      alert(err.response?.data?.error || 'Assign failed');
    }
  }

  async function handleStatus(next) {
    try {
      await api.put(`/tickets/${id}/status`, { status: next });
      await load();
    } catch (err) {
      alert(err.response?.data?.error || 'Update failed');
    }
  }

  async function handleApprove() {
    try {
      await api.put(`/tickets/${id}/approve`);
      await load();
    } catch (err) {
      alert(err.response?.data?.error || 'Approve failed');
    }
  }

  // Declining is the one approval action that asks a question first: the server refuses an empty
  // reason, so demanding it here rather than after a round trip keeps the refusal in one step.
  async function handleDecline() {
    const reason = declineReason.trim();
    if (!reason) { setDeclineError('Say why -- the requester is told this, and it decides whether they rework it or drop it.'); return; }
    setBusy(true);
    try {
      await api.put(`/tickets/${id}/decline`, { reason });
      setDeclining(false);
      setDeclineReason('');
      setDeclineError('');
      await load();
    } catch (err) {
      setDeclineError(err.response?.data?.error || 'Decline failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleForward() {
    if (!confirm(`Forward ${ticket.ticket_no} to the General Manager for approval? It won't be assignable until they sign off.`)) return;
    try {
      await api.put(`/tickets/${id}/forward-to-gm`);
      await load();
    } catch (err) {
      alert(err.response?.data?.error || 'Forward failed');
    }
  }

  async function handleGmApprove() {
    try {
      await api.put(`/tickets/${id}/gm-approve`);
      await load();
    } catch (err) {
      alert(err.response?.data?.error || 'Approve failed');
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete ticket ${ticket.ticket_no}? This cannot be undone.`)) return;
    try {
      await api.delete(`/tickets/${id}`);
      navigate('/tickets');
    } catch (err) {
      alert(err.response?.data?.error || 'Delete failed');
    }
  }

  if (loading) return <LoadingSpinner />;
  if (notFound || !ticket) return <div className="empty-state">Ticket not found.</div>;

  const isAssignee = ticket.assigned_to_user_id === user?.id;
  const canDelete = can('/tickets', 'can_delete');
  const canAct = canManage || isAssignee;
  const isClosedOut = ticket.status === 'resolved' || ticket.status === 'closed';
  const isDeclined = !!ticket.declined_at;
  const isPending = !!ticket.approver_names && !ticket.approved_at && !isDeclined;
  const isGmPending = !!ticket.forwarded_to_gm_at && !ticket.gm_approved_at && !isDeclined;
  // A declined ticket is finished, not stuck: nothing may be assigned, forwarded or restatused on
  // it, which is what the server enforces too.
  const isBlocked = isPending || isGmPending || isDeclined;

  return (
    <div>
      <div className="page-header">
        <div>
          <Link className="btn btn-sm" to={'/tickets'}>← Back to Tickets</Link>
          <h1 style={{ marginTop: 8 }}>{ticket.ticket_no}</h1>
        </div>
        <span className={`badge ${STATUS_BADGE[ticket.status] || 'badge-muted'}`}>{STATUS_LABELS[ticket.status] || ticket.status}</span>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        {isPending && (
          <div className="warning-banner" style={{ marginBottom: 12 }}>
            ⏳ Pending approval from {ticket.approver_names} — this can't be assigned or worked on yet.
          </div>
        )}
        {ticket.approved_at && ticket.approved_by_name && (
          <div className="muted" style={{ marginBottom: 12, fontSize: 13 }}>
            ✓ Approved by {ticket.approved_by_name} on {formatDateTime(ticket.approved_at)}
          </div>
        )}
        {isDeclined && (
          <div className="warning-banner" style={{ marginBottom: 12 }}>
            ✕ Declined by {ticket.declined_by_name || 'an approver'} on {formatDateTime(ticket.declined_at)}
            {ticket.decline_reason ? ` — ${ticket.decline_reason}` : ''}
            <div style={{ marginTop: 4, fontSize: 13 }}>This ticket is closed to further work. Raise a new one to pursue it.</div>
          </div>
        )}
        {isGmPending && (
          <div className="warning-banner" style={{ marginBottom: 12 }}>
            ⏳ Forwarded to the General Manager by {ticket.forwarded_by_name} — this can't be assigned or worked on until they approve.
          </div>
        )}
        {ticket.gm_approved_at && ticket.gm_approved_by_name && (
          <div className="muted" style={{ marginBottom: 12, fontSize: 13 }}>
            ✓ GM-approved by {ticket.gm_approved_by_name} on {formatDateTime(ticket.gm_approved_at)}
          </div>
        )}

        <div className="field-row">
          <div className="field"><label>Department</label><div>{ticket.department_name}</div></div>
          <div className="field"><label>Requested By</label><div>{ticket.created_by_name || '—'}</div></div>
          <div className="field"><label>Assigned To</label><div>{ticket.assigned_to_name || '—'}</div></div>
        </div>
        <div className="field"><label>Subject</label><div>{ticket.subject}</div></div>

        {ticket.is_my_approval && !ticket.approved_at && !isDeclined && (
          <div className="modal-actions" style={{ justifyContent: 'flex-start', marginTop: 12 }}>
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={handleApprove}>Approve</button>
            <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => { setDeclineError(''); setDeclining(true); }}>Decline</button>
          </div>
        )}
        {ticket.is_gm && isGmPending && (
          <div className="modal-actions" style={{ justifyContent: 'flex-start', marginTop: 12 }}>
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={handleGmApprove}>GM Approve</button>
            <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => { setDeclineError(''); setDeclining(true); }}>GM Decline</button>
          </div>
        )}

        {canManage && !isBlocked && (
          <div className="field" style={{ maxWidth: 260 }}>
            <label>Assign To</label>
            <EntityPicker
              label="Assign To" items={users} value={ticket.assigned_to_user_id}
              getLabel={(u) => u?.display_name}
              columns={[{ key: 'display_name', label: 'Name' }, { key: 'username', label: 'Username' }]}
              searchKeys={['display_name', 'username']}
              onSelect={handleAssign}
            />
          </div>
        )}

        {canDelete && (
          <div className="modal-actions" style={{ justifyContent: 'flex-start', marginTop: 12 }}>
            <button className="btn btn-sm btn-danger" onClick={handleDelete}>Delete Ticket</button>
          </div>
        )}

        {canManage && !ticket.assigned_to_user_id && !ticket.forwarded_to_gm_at && (
          <div className="modal-actions" style={{ justifyContent: 'flex-start', marginTop: 12 }}>
            <button className="btn btn-sm" onClick={handleForward}>Forward to GM</button>
          </div>
        )}

        {canAct && !isBlocked && !isClosedOut && (
          <div className="modal-actions" style={{ justifyContent: 'flex-start', marginTop: 12 }}>
            {ticket.status !== 'in_progress' && <button className="btn btn-sm" onClick={() => handleStatus('in_progress')}>Mark In Progress</button>}
            <button className="btn btn-sm btn-primary" onClick={() => handleStatus('resolved')}>Mark Resolved</button>
            <button className="btn btn-sm" onClick={() => handleStatus('closed')}>Close</button>
          </div>
        )}
      </div>

      {declining && (
        <Modal title={`Decline ${ticket.ticket_no}`} onClose={() => setDeclining(false)}>
          <div className="field">
            <label>Reason</label>
            <textarea
              rows={4} maxLength={500} autoFocus value={declineReason}
              placeholder="Why is this being refused? The requester is shown exactly this."
              onChange={(e) => { setDeclineReason(e.target.value); setDeclineError(''); }}
            />
            <small className="muted">{500 - declineReason.length} characters left. Declining is final -- the ticket cannot be approved, assigned or reopened afterwards.</small>
          </div>
          {declineError && <div className="warning-banner" style={{ marginBottom: 12 }}>{declineError}</div>}
          <div className="modal-actions">
            <button className="btn btn-sm" disabled={busy} onClick={() => setDeclining(false)}>Cancel</button>
            <button className="btn btn-sm btn-danger" disabled={busy} onClick={handleDecline}>Decline Ticket</button>
          </div>
        </Modal>
      )}

      {/* Above the conversation rather than below it: the picture is usually the point of
          the ticket, and burying it under a thread means it is read last. */}
      <TicketAttachments ticketId={id} currentUserId={user?.id} isAdmin={user?.account_type === 'System Admin'} />

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Conversation</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 400, overflowY: 'auto', padding: '4px 2px' }}>
          {ticket.messages.map((m) => (
            <div key={m.id} style={{ alignSelf: m.sender_user_id === user?.id ? 'flex-end' : 'flex-start', maxWidth: '75%' }}>
              <div style={{
                background: m.sender_user_id === user?.id ? 'var(--accent)' : 'var(--panel-2, #f3f4f6)',
                color: m.sender_user_id === user?.id ? '#fff' : 'var(--text)',
                borderRadius: 12, padding: '8px 12px', fontSize: 14, whiteSpace: 'pre-wrap',
              }}
              >
                <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 2 }}>{m.sender_name}</div>
                {m.message}
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 2, textAlign: m.sender_user_id === user?.id ? 'right' : 'left' }}>{formatDateTime(m.created_at)}</div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {error && <div className="error-banner" style={{ marginTop: 12 }}>{error}</div>}
        <form onSubmit={handleReply} style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input
            style={{ flex: 1 }}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Type a reply..."
            disabled={busy}
          />
          <button type="submit" className="btn btn-primary" disabled={busy}>Send</button>
        </form>
      </div>
    </div>
  );
}
