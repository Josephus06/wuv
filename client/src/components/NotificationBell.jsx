import { useEffect, useRef, useState } from 'react';
import {
  announce, chime, speak, soundEnabled, setSoundEnabled, primeSpeech,
  desktopNotify, requestDesktopPermission, availableVoice,
} from '../utils/notificationSound';
import { useNavigate, Link } from 'react-router-dom';
import api from '../api/client';
import { parseUtc } from '../utils/datetime';
import { hiddenPollGate } from '../utils/backgroundPoll';

const POLL_MS = 5000;
const TOAST_MS = 6000;

function formatTime(v) {
  // UTC in the database, no marker on the wire -- see utils/datetime.js.
  return v ? parseUtc(v).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: 'numeric', minute: '2-digit' }) : '';
}

function notificationTypeLabel(type) {
  switch (type) {
    case 'ticket_pending_approval': return 'Pending Approval';
    case 'bir_deadline': return 'BIR Deadline';
    case 'vehicle_registration_due': case 'vehicle_insurance_due': case 'vehicle_emission_due': case 'vehicle_pms_due': return 'Vehicle Due';
    case 'vehicle_registration_overdue': case 'vehicle_insurance_overdue': case 'vehicle_emission_overdue': case 'vehicle_pms_overdue': return 'Vehicle Overdue';
    case 'ticket_received': return 'New Ticket';
    case 'ticket_ready': return 'Ticket Ready';
    case 'ticket_assigned': return 'Assigned';
    case 'ticket_approved': return 'Approved';
    case 'ticket_resolved': return 'Resolved';
    case 'gm_approval_needed': return 'GM Approval';
    case 'feed_new_post': return 'New Post';
    case 'feed_comment': return 'Comment';
    case 'feed_reaction': return 'Reaction';
    case 'feed_post_updated': return 'Post Updated';
    case 'nsso_rma_approval': return 'RMA Approval';
    case 'parked_bank_items': return 'Bank Items';
    case 'feed_post': return 'New Post';
    case 'feed_reply': return 'Reply';
    case 'po_pending_approval': return 'PO Approval';
    case 'po_approved': return 'PO Approved';
    case 'form_pending_note': return 'For Noting';
    case 'form_pending_approval': return 'Form Approval';
    case 'form_noted': return 'Form Noted';
    case 'form_approved': return 'Form Approved';
    case 'form_rejected': return 'Form Rejected';
    default:
      if (!type) return '';
      return type.replace(/_/g, ' ').replace(/\b\w/g, (match) => match.toUpperCase());
  }
}

// Bell + unread badge in the topnav, plus a toast popup for anything that arrives
// after mount -- polled every 5s (same setInterval pattern as ChatWidget's ticket
// thread) plus an immediate extra poll whenever the tab regains focus/visibility, so
// coming back from another tab/app doesn't leave you waiting out the rest of the
// interval. General enough to cover any future notification type -- tickets.js fires
// one on creation (pending approval), on approval (ready to work), and on resolution.
export default function NotificationBell() {
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [sound, setSound] = useState(soundEnabled);
  // Shown in the bell menu when the voice does not start, instead of leaving someone to
  // guess whether the feature is broken or their speakers are.
  const [voiceNote, setVoiceNote] = useState('');
  const lastSeenMaxId = useRef(null);
  const rootRef = useRef(null);

  async function poll() {
    try {
      const { data } = await api.get('/notifications');
      setNotifications(data.notifications);
      setUnreadCount(data.unread_count);

      if (lastSeenMaxId.current === null) {
        // First load -- establish the baseline silently, don't toast a backlog of
        // everything that was already unread before this session started.
        lastSeenMaxId.current = data.notifications[0]?.id || 0;
        return;
      }
      const fresh = data.notifications.filter((n) => n.id > lastSeenMaxId.current);
      if (fresh.length) {
        lastSeenMaxId.current = Math.max(...data.notifications.map((n) => n.id));
        setToasts((prev) => [...prev, ...fresh]);
        fresh.forEach((n) => {
          setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== n.id)), TOAST_MS);
        });
        // Chime, then read the headline. Raised here rather than in the toast so what is
        // heard and what is shown can never disagree, and sorted newest-first so the one
        // read aloud is the one that just landed.
        const newest = [...fresh].sort((a, b) => b.id - a.id);
        announce(newest.map((n) => n.title), setVoiceNote);
        desktopNotify({
          title: newest[0].title,
          body: newest.length > 1 ? `${newest[0].message || ''} (+${newest.length - 1} more)` : (newest[0].message || ''),
          onClick: () => openNotification(newest[0]),
        });
      }
    } catch {
      // Polling hiccup -- just try again next tick, not worth surfacing to the user.
    }
  }

  useEffect(() => {
    poll();
    // Every POLL_MS while the tab is shown; once a minute while hidden (utils/backgroundPoll.js).
    const gate = hiddenPollGate();
    const t = setInterval(() => { if (gate()) poll(); }, POLL_MS);
    function onVisible() { if (document.visibilityState === 'visible') poll(); }
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function onClickOutside(e) {
      if (open && rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  // Opening one marks it read; it stays in the list until a newer notification pushes it out,
  // so what was just looked at can be found again.
  // Where a notification leads, or null when it is not about a record. One place, so the list's
  // links (which can open in a new tab -- asked 2026-10-09) and the toast's click agree.
  function notificationUrl(n) {
    if (n.related_type === 'Ticket' && n.related_id) return `/tickets/${n.related_id}`;
    // The unidentified-bank-items reminder is about a BALANCE, not a record, so there is no id to
    // carry -- it opens the report that lists what is still parked.
    if (n.related_type === 'ParkedBankItems') return '/reports/parked-bank-items';
    if (n.related_type === 'PurchaseOrder' && n.related_id) return `/purchase-orders/${n.related_id}`;
    if (n.related_type === 'WarrantyCertificate' && n.related_id) return `/warranty-certificates/${n.related_id}`;
    // Fleet reminders (lib/fleet.js): registration / insurance / emission / PMS due on a vehicle.
    if (n.related_type === 'Vehicle' && n.related_id) return `/assets/fleet/${n.related_id}`;
    if (n.related_type === 'Form' && n.related_id) return `/forms/${n.related_id}`;
    if (n.related_type === 'IncidentReport' && n.related_id) return `/hrd/incident-reports/${n.related_id}`;
    // Examinations (2026-10-21): an exam scheduled for you, its result, an orientation date.
    if (n.related_type === 'ExamAttempt' && n.related_id) return `/exams/${n.related_id}`;
    if (n.related_type === 'ExamSchedule' && n.related_id) return `/hrd/exams/schedules/${n.related_id}`;
    if (n.related_type === 'TrainingEnrollment' && n.related_id) return `/trainings/${n.related_id}`;
    if (n.related_type === 'PerfEvaluation' && n.related_id) return `/performance/${n.related_id}`;
    // Certificate of Employment (2026-10-22): waiting for the GM's approval, or approved / rejected.
    if (n.related_type === 'HrCoe') return '/hrd/coe';
    if (n.related_type === 'HrMemo') return '/hrd/memo';
    if (n.related_type === 'HrRegularization') return '/hrd/regularization';
    if (n.related_type === 'HrSalaryAdjustment') return '/hrd/salary-adjustment';
    // BIR filing deadlines (lib/birDeadlines.js): Bir:<ewt|cwt|vat>, the month as YYYYMM.
    if (String(n.related_type || '').startsWith('Bir:')) {
      const m = String(n.related_id || '');
      return `/reports/bir-${n.related_type.slice(4)}${m.length === 6 ? `?month=${m.slice(0, 4)}-${m.slice(4)}` : ''}`;
    }
    // Design hand-off notifications. An artist told the work is theirs goes straight to the
    // run screen where they start the timer; everyone else goes to the order itself.
    if (n.related_type === 'JobOrder' && n.related_id) {
      return n.type === 'design_artist_assigned' ? `/assigned-jo/${n.related_id}` : `/job-orders/${n.related_id}`;
    }
    // Design Schedule (2026-10-31): forwarded / confirmed / rejected / rescheduled slots open on the calendar.
    if (n.related_type === 'DesignSchedule' && n.related_id) return `/design-schedule?id=${n.related_id}`;
  if (n.related_type === 'DesignScheduleBatch' && n.related_id) return `/design-schedule?batch=${n.related_id}`;
    if (n.related_type === 'NonStandardSalesOrder' && n.related_id) return `/non-standard-sales-orders/${n.related_id}`;
    if (n.related_type === 'NonStandardJobOrder' && n.related_id) {
      return n.type === 'design_artist_assigned' ? `/assigned-jo/nstdjo/${n.related_id}` : `/non-standard-job-orders/${n.related_id}`;
    }
    // Feed posts live on the dashboard's Feed tab; the hash is what Feed.jsx anchors each post with.
    // wu: the feed is the dashboard itself, so a post opens there with ?post= -- which pins that
    // one to the top and highlights it.
    if (n.related_type === 'FeedPost' && n.related_id) return `/dashboard?post=${n.related_id}`;
    return null;
  }

  // Marks it read -- not awaited, so opening (here or in a new tab) never waits on it.
  function markRead(n) {
    if (n.is_read) return;
    api.put(`/notifications/${n.id}/read`).then(() => {
      setNotifications((prev) => prev.map((x) => (x.id === n.id ? { ...x, is_read: true } : x)));
      setUnreadCount((c) => Math.max(0, c - 1));
    }).catch(() => {
      // Non-critical -- worst case it just stays "unread" until the next poll settles it.
    });
  }

  function openNotification(n) {
    setOpen(false);
    markRead(n);
    if (n.related_type === 'FeedPost') localStorage.setItem('dashboard.tab', 'feed');
    const url = notificationUrl(n);
    if (url) navigate(url);
  }

  // A click on a notification link. A plain click opens it here (and closes the panel); Ctrl/Cmd/
  // Shift or a middle click is left to the browser, which opens it in a new tab. Either way it is
  // marked read.
  function onLinkClick(e, n) {
    if (n.related_type === 'FeedPost') localStorage.setItem('dashboard.tab', 'feed');
    markRead(n);
    if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) setOpen(false);
  }

  // Clears the badge. The rows stay -- the server keeps the five most recent either way -- so
  // this needs no confirmation: nothing is being thrown away that a newer notification would
  // not have pushed out anyway.
  async function markAllRead() {
    try {
      await api.put('/notifications/read-all');
      setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
      setUnreadCount(0);
    } catch {
      // Non-critical.
    }
  }

  // Deleting is for good, unlike Mark all read -- so Clear all asks first; a single delete does not.
  async function deleteNotification(n) {
    try {
      await api.delete(`/notifications/${n.id}`);
      setNotifications((prev) => prev.filter((x) => x.id !== n.id));
      if (!n.is_read) setUnreadCount((c) => Math.max(0, c - 1));
    } catch {
      // Non-critical.
    }
  }
  async function clearAll() {
    if (!window.confirm('Delete all your notifications?')) return;
    try {
      await api.delete('/notifications');
      setNotifications([]);
      setUnreadCount(0);
    } catch {
      // Non-critical.
    }
  }

  function dismissToast(id) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  return (
    <>
      <div ref={rootRef} style={{ position: 'relative' }}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          title="Notifications"
          style={{
            position: 'relative', background: 'transparent', border: 'none', cursor: 'pointer',
            fontSize: 18, padding: 4, lineHeight: 1,
          }}
        >
          🔔
          {unreadCount > 0 && (
            <span
              style={{
                position: 'absolute', top: -2, right: -2, background: 'var(--danger, #e05252)', color: '#fff',
                borderRadius: '999px', fontSize: 10, minWidth: 16, height: 16, display: 'flex',
                alignItems: 'center', justifyContent: 'center', padding: '0 4px', fontWeight: 600,
              }}
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>

        {open && (
          <div
            className="card"
            style={{
              position: 'absolute', right: 0, top: '100%', marginTop: 8, width: 320, maxHeight: 400,
              overflowY: 'auto', padding: 0, zIndex: 300, boxShadow: '0 8px 30px rgba(0,0,0,0.25)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
              <strong style={{ fontSize: 14 }}>Notifications</strong>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {/* Anything that speaks needs an off switch within reach of the thing that
                    speaks -- burying this in a settings page would be its own annoyance. */}
                <button
                  type="button"
                  className="btn btn-sm"
                  title={sound ? 'Sound and voice on — click to mute' : 'Muted — click to turn sound and voice on'}
                  aria-label={sound ? 'Mute notification sound' : 'Unmute notification sound'}
                  onClick={async () => {
                    const next = !sound;
                    setSound(next); setSoundEnabled(next);
                    if (next) { await requestDesktopPermission(); announce(['Notification sound on']); }
                  }}
                >
                  {sound ? '🔊' : '🔇'}
                </button>
                {/* A deterministic way to check the voice works, rather than waiting for
                    a real notification to find out that it does not. */}
                <button type="button" className="btn btn-sm" title="Read a sample aloud"
                  onClick={() => {
                    setVoiceNote('');
                    primeSpeech();
                    chime();
                    setTimeout(() => speak('TICKET-211 was sent to your department', setVoiceNote), 450);
                  }}>
                  Test
                </button>
                {unreadCount > 0 && (
                  <button type="button" className="btn btn-sm" onClick={markAllRead}>Mark all read</button>
                )}
                {notifications.length > 0 && (
                  <button type="button" className="btn btn-sm btn-danger" onClick={clearAll} title="Delete all your notifications">Clear all</button>
                )}
              </div>
            </div>
            {voiceNote && (
              <div className="muted" style={{ fontSize: 11, padding: '6px 14px', borderBottom: '1px solid var(--border)' }}>
                {voiceNote}
              </div>
            )}
            {sound && availableVoice() && (
              <div className="muted" style={{ fontSize: 11, padding: '6px 14px', borderBottom: '1px solid var(--border)' }}>
                Voice: {availableVoice()}
              </div>
            )}
            {notifications.length === 0 && (
              <div className="muted" style={{ padding: 16, textAlign: 'center' }}>No notifications yet.</div>
            )}
            {notifications.map((n) => {
              const url = notificationUrl(n);
              const body = (
                <>
                  {/* Title, message, then type and time -- stacked, so a long title or type label never runs into the other or under the delete button. */}
                  <div style={{ fontSize: 13, fontWeight: n.is_read ? 400 : 600, overflowWrap: 'anywhere' }}>{n.title}</div>
                  {n.message && <div className="muted" style={{ fontSize: 12, marginTop: 2, overflowWrap: 'anywhere' }}>{n.message}</div>}
                  <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{notificationTypeLabel(n.type)} · {formatTime(n.created_at)}</div>
                </>
              );
              const rowStyle = { display: 'block', padding: '10px 34px 10px 14px', color: 'inherit', textDecoration: 'none', cursor: url ? 'pointer' : 'default' };
              return (
                <div key={n.id} style={{ position: 'relative', borderBottom: '1px solid var(--border)', background: n.is_read ? 'transparent' : 'var(--panel-2, #f3f4f6)' }}>
                  {/* A real link, so it can be opened in a new tab (Ctrl/middle click, right-click). */}
                  {url ? (
                    <Link to={url} style={rowStyle} onClick={(e) => onLinkClick(e, n)} onAuxClick={(e) => onLinkClick(e, n)}>{body}</Link>
                  ) : (
                    <div style={rowStyle} onClick={() => { setOpen(false); markRead(n); }}>{body}</div>
                  )}
                  {/* Outside the link, so deleting never opens the notification. */}
                  <button type="button" title="Delete this notification" aria-label="Delete notification"
                    onClick={() => deleteNotification(n)}
                    style={{ position: 'absolute', top: 9, right: 10, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--danger, #e05252)', fontSize: 14, lineHeight: 1, padding: '0 2px' }}>
                    🗑
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Classed so print can hide it: a toast that happens to be on screen when someone hits
          Print would otherwise land in the corner of the paper. */}
      <div className="toast-stack" style={{ position: 'fixed', top: 20, right: 20, zIndex: 400, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {toasts.map((t) => (
          <div
            key={t.id}
            className="card"
            onClick={() => { dismissToast(t.id); openNotification(t); }}
            style={{ width: 300, padding: 12, cursor: 'pointer', boxShadow: '0 8px 30px rgba(0,0,0,0.3)', borderLeft: '3px solid var(--accent)' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <div>
                <strong style={{ fontSize: 13 }}>{t.title}</strong>
                <div className="muted" style={{ fontSize: 11 }}>{notificationTypeLabel(t.type)}</div>
              </div>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); dismissToast(t.id); }}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 13, opacity: 0.6 }}
              >
                ✕
              </button>
            </div>
            {t.message && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{t.message}</div>}
          </div>
        ))}
      </div>
    </>
  );
}
