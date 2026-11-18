import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import Modal from '../components/Modal';
import NewTicketModal from '../components/NewTicketModal';
import { parseUtc } from '../utils/datetime';

// Doubles as the status filter tabs, so 'declined' being here is what gives the queue a way to
// look at what was refused rather than only at what is still moving.
const STATUS_LABELS = { open: 'Open', in_progress: 'In Progress', resolved: 'Resolved', closed: 'Closed', declined: 'Declined' };
const STATUS_BADGE = { open: 'badge-info', in_progress: 'badge-muted', resolved: 'badge-success', closed: 'badge-success', declined: 'badge-danger' };

function formatDate(v) {
  // UTC in the database, no marker on the wire -- see utils/datetime.js.
  return v ? parseUtc(v).toLocaleString('en-US', { month: 'short', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
}

// Regular users mostly work through the floating chat widget (ChatWidget.jsx) rather
// than this page -- this is the queue view for department heads (departments.head_user_id,
// server/src/lib/ticketVisibility.js) to see, assign, and resolve what's routed to them.
// GET /tickets already scopes rows to what the viewer is allowed to see, so no extra
// client-side filtering is needed for visibility -- only for which action buttons to offer.
export default function Tickets() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [rows, setRows] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [usersByDept, setUsersByDept] = useState({});
  const [status, setStatus] = useState('');
  // SBU 1 / SBU 2 tabs. The endpoint returns an empty list for anyone who is not an SBU,
  // which is what keeps the strip hidden for them; '' is the "both groups" tab.
  const [sbuGroups, setSbuGroups] = useState([]);
  const [sbuTab, setSbuTab] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  // The ticket being declined, and the reason being typed for it. Null when no modal is open.
  const [declining, setDeclining] = useState(null);
  const [declineReason, setDeclineReason] = useState('');
  const [declineError, setDeclineError] = useState('');
  const [declineBusy, setDeclineBusy] = useState(false);

  const headDepartmentIds = useMemo(
    () => new Set(departments.filter((d) => d.head_user_id === user?.id).map((d) => d.id)),
    [departments, user]
  );
  const isSystemAdminHead = useMemo(
    () => departments.some((d) => d.name === 'System Admin' && d.head_user_id === user?.id),
    [departments, user]
  );

  async function load() {
    setLoading(true);
    const params = {};
    if (status) params.status = status;
    if (sbuTab) params.sbu = sbuTab;
    const [t, d] = await Promise.all([
      api.get('/tickets', { params }),
      api.get('/tickets/meta/departments'),
    ]);
    setRows(t.data);
    setDepartments(d.data);
    setLoading(false);
  }

  useEffect(() => { load(); }, [status, sbuTab]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.get('/tickets/meta/sbu-groups').then(({ data }) => setSbuGroups(data.groups || []));
  }, []);

  function canManage(row) {
    return isSystemAdminHead || headDepartmentIds.has(row.department_id);
  }

  // A supervisor can only assign within their own department, not org-wide (see
  // server/src/routes/tickets.js's /meta/assignable-users). A System Admin head's
  // queue can span several departments, so this fetches per-department, once each,
  // for every department that actually appears among the manageable rows.
  useEffect(() => {
    const deptIds = [...new Set(rows.filter(canManage).map((r) => r.department_id))]
      .filter((id) => !(id in usersByDept));
    if (!deptIds.length) return;
    Promise.all(deptIds.map((id) => api.get('/tickets/meta/assignable-users', { params: { department_id: id } }).then(({ data }) => [id, data])))
      .then((pairs) => setUsersByDept((prev) => ({ ...prev, ...Object.fromEntries(pairs) })))
      .catch(() => {});
  }, [rows, headDepartmentIds, isSystemAdminHead]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleAssign(row, assignee) {
    try {
      await api.put(`/tickets/${row.id}/assign`, { assigned_to_user_id: assignee.id });
      await load();
    } catch (err) {
      alert(err.response?.data?.error || 'Assign failed');
    }
  }

  async function handleResolve(row) {
    try {
      await api.put(`/tickets/${row.id}/status`, { status: 'resolved' });
      await load();
    } catch (err) {
      alert(err.response?.data?.error || 'Update failed');
    }
  }

  async function handleApprove(row) {
    try {
      await api.put(`/tickets/${row.id}/approve`);
      await load();
    } catch (err) {
      alert(err.response?.data?.error || 'Approve failed');
    }
  }

  async function handleForward(row) {
    if (!confirm(`Forward ${row.ticket_no} to the General Manager for approval? It won't be assignable until they sign off.`)) return;
    try {
      await api.put(`/tickets/${row.id}/forward-to-gm`);
      await load();
    } catch (err) {
      alert(err.response?.data?.error || 'Forward failed');
    }
  }

  async function handleGmApprove(row) {
    try {
      await api.put(`/tickets/${row.id}/gm-approve`);
      await load();
    } catch (err) {
      alert(err.response?.data?.error || 'Approve failed');
    }
  }

  // Declining asks a question first, which is why this queue only ever offered Approve: the
  // server refuses an empty reason, and there was nowhere on a table row to type one. The
  // reason matters -- it is what the requester is told, and it decides whether they rework the
  // request or drop it -- so it gets a modal here rather than being skipped.
  async function submitDecline() {
    const reason = declineReason.trim();
    if (!reason) { setDeclineError('Say why -- the requester is told this, and it decides whether they rework it or drop it.'); return; }
    setDeclineBusy(true);
    try {
      await api.put(`/tickets/${declining.id}/decline`, { reason });
      setDeclining(null);
      setDeclineReason('');
      setDeclineError('');
      await load();
    } catch (err) {
      setDeclineError(err.response?.data?.error || 'Decline failed');
    } finally {
      setDeclineBusy(false);
    }
  }

  function isPending(row) {
    // A declined ticket is not waiting on anybody. Without the last clause it stays "Pending
    // Approval" for ever, because it never got approved -- which is how a refused ticket ended
    // up showing Declined and Pending Approval side by side.
    return !!row.approver_names && !row.approved_at && !row.declined_at;
  }

  function isGmPending(row) {
    // Same as above: a declined ticket is not waiting on the General Manager either.
    return !!row.forwarded_to_gm_at && !row.gm_approved_at && !row.declined_at;
  }

  function isBlocked(row) {
    // A declined ticket is finished, so it offers no actions either -- the server refuses assign,
    // forward and status changes on it.
    return isPending(row) || isGmPending(row) || !!row.declined_at;
  }

  const columns = [
    { key: 'ticket_no', label: 'Ticket #' },
    { key: 'department_name', label: 'Department' },
    { key: 'subject', label: 'Subject' },
    {
      key: 'status',
      label: 'Status',
      render: (r) => (
        <>
          <span className={`badge ${STATUS_BADGE[r.status] || 'badge-muted'} ticket-status-${r.status}`}>{STATUS_LABELS[r.status] || r.status}</span>
          {isPending(r) && <span className="badge badge-danger" style={{ marginLeft: 6 }} title={`Awaiting: ${r.approver_names}`}>Pending Approval</span>}
          {isGmPending(r) && <span className="badge badge-danger" style={{ marginLeft: 6 }}>Pending GM Approval</span>}
        </>
      ),
    },
    { key: 'created_by_name', label: 'Requested By', render: (r) => r.created_by_name || '—' },
    { key: 'assigned_to_name', label: 'Assigned To', render: (r) => r.assigned_to_name || '—' },
    { key: 'created_at', label: 'Created', render: (r) => formatDate(r.created_at) },
  ];

  async function handleDownloadReport() {
    try {
      const res = await api.get('/reports/tickets?format=csv', { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ticket-report.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to download report');
    }
  }

  async function handleShowSummary() {
    try {
      const res = await api.get('/reports/tickets');
      const { summary } = res.data;
      alert(`Total tickets: ${summary.total}\nResolved: ${summary.resolved}\nUnresolved: ${summary.unresolved}`);
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to fetch summary');
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Tickets</h1>
        {/* Besides the chatbot (2026-10-13). */}
        <button className="btn btn-primary" onClick={() => setCreating(true)}>New Ticket</button>
      </div>
      {creating && (
        <NewTicketModal
          departments={departments}
          onClose={() => setCreating(false)}
          onCreated={(t) => { setCreating(false); navigate(`/tickets/${t.id}`); }}
        />
      )}

      {/* Both SBUs see both groups' tickets, and Marketing's -- these tabs separate whose
          group raised the ticket, they do not grant or remove access. Labels come from the
          server so a third group appears here without a change on this side. Hidden for
          everyone who is not an SBU. */}
      {sbuGroups.length > 1 && (
        <div className="status-tabs">
          <button className={`status-tab ${sbuTab === '' ? 'active' : ''}`} onClick={() => setSbuTab('')}>All SBUs</button>
          {sbuGroups.map((group) => (
            <button key={group.index} title={group.name}
              className={`status-tab ${String(sbuTab) === String(group.index) ? 'active' : ''}`}
              onClick={() => setSbuTab(String(group.index))}>{group.label}</button>
          ))}
        </div>
      )}

      <div className="status-tabs">
        <button className={`status-tab ${status === '' ? 'active' : ''}`} onClick={() => setStatus('')}>All</button>
        {Object.entries(STATUS_LABELS).map(([key, label]) => (
          <button key={key} className={`status-tab ${status === key ? 'active' : ''}`} onClick={() => setStatus(key)}>{label}</button>
        ))}
        <Link className="status-tab" to={'/reports/ticket-summary'}>Ticket Summary</Link>
        <button className="status-tab" onClick={handleDownloadReport}>Download CSV</button>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        {loading ? <LoadingSpinner /> : (
          <DataTable
            paginate
            columns={columns}
            rows={rows}
            emptyLabel="No tickets yet."
            actions={(row) => (
              <>
                <Link className="btn btn-sm" to={`/tickets/${row.id}`}>View</Link>
                {/* Approve and Decline are the same decision, so they belong together. Both are
                    gated exactly as the server gates them, and as the ticket's own page does. */}
                {row.is_my_approval && !row.approved_at && !row.declined_at && (
                  <>
                    <button className="btn btn-sm btn-primary" onClick={() => handleApprove(row)}>Approve</button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => { setDeclineError(''); setDeclineReason(''); setDeclining(row); }}
                    >
                      Decline
                    </button>
                  </>
                )}
                {row.is_gm && isGmPending(row) && !row.declined_at && (
                  <>
                    <button className="btn btn-sm btn-primary" onClick={() => handleGmApprove(row)}>GM Approve</button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => { setDeclineError(''); setDeclineReason(''); setDeclining(row); }}
                    >
                      GM Decline
                    </button>
                  </>
                )}
                {canManage(row) && !isBlocked(row) && (
                  <EntityPicker
                    label="Assign To" items={usersByDept[row.department_id] || []} value={row.assigned_to_user_id}
                    getLabel={(u) => u?.display_name}
                    columns={[{ key: 'display_name', label: 'Name' }, { key: 'username', label: 'Username' }]}
                    searchKeys={['display_name', 'username']}
                    onSelect={(u) => handleAssign(row, u)}
                    triggerLabel="Assign"
                    triggerClassName="btn btn-sm"
                  />
                )}
                {canManage(row) && !row.assigned_to_user_id && !row.forwarded_to_gm_at && !row.declined_at && (
                  <button className="btn btn-sm" onClick={() => handleForward(row)}>Forward to GM</button>
                )}
                {!isBlocked(row) && (canManage(row) || row.assigned_to_user_id === user?.id) && row.status !== 'resolved' && row.status !== 'closed' && (
                  <button className="btn btn-sm btn-primary" onClick={() => handleResolve(row)}>Resolve</button>
                )}
              </>
            )}
          />
        )}
      </div>

      {/* Word for word the ticket's own Decline prompt -- the same decision reached from the
          queue instead of from the ticket should not read differently. */}
      {declining && (
        <Modal title={`Decline ${declining.ticket_no}`} onClose={() => setDeclining(null)}>
          <div className="muted" style={{ marginBottom: 10 }}>{declining.subject}</div>
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
            <button className="btn btn-sm" disabled={declineBusy} onClick={() => setDeclining(null)}>Cancel</button>
            <button className="btn btn-sm btn-danger" disabled={declineBusy} onClick={submitDecline}>Decline Ticket</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
