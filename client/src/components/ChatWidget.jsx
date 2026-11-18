import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import { speak } from '../utils/notificationSound';
import { listenOnce, voiceSupported, voiceUnavailableReason } from '../utils/voiceInput';
import { hiddenPollGate } from '../utils/backgroundPoll';

// Floating chat widget, mounted once in Layout.jsx so it persists across navigation.
// Default mode is a small data-Q&A assistant (server/src/lib/chatbotIntents.js);
// typing "create ticket" switches the same conversation into a guided intake flow
// (department -> issue) that creates a real Ticket, after which further messages
// become replies on that ticket's own thread (server/src/routes/tickets.js), polled
// every 6s so a department head's reply shows up without a manual refresh -- mirrors
// the setInterval pattern already used in client/src/pages/AssignedJobOrderRun.jsx.
const GREETING = "Hi! Ask me things like \"how many estimates today\" or \"my weighted sales this month\" — or type \"create ticket\" to reach a department.";
const POLL_MS = 6000;
// The "Hey Jot" wake word was removed (2026-10-29): it held the microphone open in every tab. The
// 🎤 button -- ask one question by voice -- stays.

// Phrases that mean "stop talking to the department, talk to the assistant again". Matched
// only as a whole message, deliberately: a genuine ticket reply that happens to contain
// "ask the bot" must still reach the department rather than being swallowed as a command.
const LEAVE_THREAD = /^\s*(ask (the )?(bot|assistant)|back to (the )?(bot|assistant)|new question|exit ticket|leave ticket)\s*[.!?]?\s*$/i;

function formatTime(v) {
  return v ? new Date(v).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
}

const POS_KEY = 'chatWidgetPos';
// The mascot tucked away into a small corner bubble (asked 2026-10-07: it sat on top of list
// buttons). Remembered per browser; the chat still opens from the bubble.
const TUCK_KEY = 'chatWidget.tucked';
const DEFAULT_POS = { right: 20, bottom: 20 };
const DRAG_THRESHOLD = 4; // px of movement before a press counts as a drag rather than a click

// The open panel's footprint, used to keep it on screen no matter where the launcher was
// dropped. Must match the card's inline width/height/marginBottom below and the 52px
// open-state button.
const PANEL_W = 320;
const PANEL_H = 420;
const PANEL_GAP = 10;
const OPEN_BTN_H = 52;

// While the panel is open the anchor may have to move inward so the card stays fully
// visible. The stored drag position is deliberately left untouched, so closing the chat
// returns the mascot to exactly where it was dropped.
function anchorFor(pos, open) {
  if (!open) return pos;
  const maxRight = Math.max(0, window.innerWidth - PANEL_W);
  const maxBottom = Math.max(0, window.innerHeight - (PANEL_H + PANEL_GAP + OPEN_BTN_H));
  return { right: Math.min(pos.right, maxRight), bottom: Math.min(pos.bottom, maxBottom) };
}

// Keeps the launcher fully on screen. Measures the widget when it can; falls back to the
// 112px mascot box on the first render, before the ref is attached.
function clampPos({ right, bottom }, el) {
  const w = el?.offsetWidth || 112;
  const h = el?.offsetHeight || 112;
  const maxRight = Math.max(0, window.innerWidth - w);
  const maxBottom = Math.max(0, window.innerHeight - h);
  return {
    right: Math.min(Math.max(0, right), maxRight),
    bottom: Math.min(Math.max(0, bottom), maxBottom),
  };
}

export default function ChatWidget() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [tucked, setTucked] = useState(() => {
    try { return localStorage.getItem(TUCK_KEY) === '1'; } catch { return false; }
  });
  const [hoverMascot, setHoverMascot] = useState(false);
  const setTuck = (v) => {
    setTucked(v);
    try { localStorage.setItem(TUCK_KEY, v ? '1' : '0'); } catch { /* this session only */ }
  };
  // Launcher icon is the full-body mascot GIF at /chat-icon.gif (drop it in client/public/); falls
  // back to the 💬 emoji if that file isn't present.
  const [iconError, setIconError] = useState(false);
  const [localMessages, setLocalMessages] = useState([{ sender: 'bot', text: GREETING, at: new Date().toISOString() }]);
  const [ticket, setTicket] = useState(null);
  const [ticketMessages, setTicketMessages] = useState([]);
  const [mode, setMode] = useState('chat'); // chat | awaiting_department | awaiting_issue | ticket_thread
  const [departments, setDepartments] = useState([]);
  const [pendingDepartmentId, setPendingDepartmentId] = useState(null);
  // An action the bot has offered to carry out and is waiting on a yes for. Held here and
  // handed back with the next message: the server re-checks permission and the order before
  // doing anything, so this only says WHAT was offered, never that it was allowed.
  const [pendingAction, setPendingAction] = useState(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef(null);

  // ------------------------------------------------------------------ voice
  const voiceOk = voiceSupported();
  const [listening, setListening] = useState(false);
  // What the transcriber has heard so far. Shown while it is still guessing, because a mic button
  // that lights up and shows nothing for three seconds reads as broken.
  const [partial, setPartial] = useState('');
  const [voiceNote, setVoiceNote] = useState('');
  const cancelListenRef = useRef(null);

  // Draggable launcher. Position is stored as a distance from the RIGHT/BOTTOM edges so the
  // widget keeps its corner-relative spot when the window is resized -- the same reason the
  // default is `right: 20, bottom: 20` rather than absolute coordinates.
  const [pos, setPos] = useState(() => {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (Number.isFinite(p?.right) && Number.isFinite(p?.bottom)) return p;
      }
    } catch { /* corrupt or blocked storage -- fall through to the default corner */ }
    return DEFAULT_POS;
  });
  const dragRef = useRef(null);
  // Distinguishes a click (open the chat) from a drag (move it). Without this every drop
  // would also toggle the panel open.
  const [dragging, setDragging] = useState(false);
  const movedRef = useRef(false);
  const wrapRef = useRef(null);

  // Keep the launcher on screen when the window shrinks -- otherwise a position set on a wide
  // monitor can strand it off-canvas on a laptop, with no way to grab it back.
  useEffect(() => {
    const onResize = () => setPos((p) => clampPos(p, wrapRef.current));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  function handlePointerDown(e) {
    // Left button / touch only, and never while the panel is open (the X must stay a button).
    if (open || (e.pointerType === 'mouse' && e.button !== 0)) return;
    movedRef.current = false;
    dragRef.current = { startX: e.clientX, startY: e.clientY, right: pos.right, bottom: pos.bottom };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    // A few pixels of slop so a slightly shaky click still counts as a click.
    if (!movedRef.current && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    movedRef.current = true;
    setDragging(true);
    // Dragging right/down must DECREASE the right/bottom offsets.
    setPos(clampPos({ right: d.right - dx, bottom: d.bottom - dy }, wrapRef.current));
  }

  function handlePointerUp(e) {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    if (movedRef.current) {
      try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch { /* position is per-session then */ }
    }
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  useEffect(() => {
    if (open && departments.length === 0) {
      api.get('/tickets/meta/departments').then(({ data }) => setDepartments(data)).catch(() => {});
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || !ticket || mode !== 'ticket_thread') return undefined;
    const poll = () => api.get(`/tickets/${ticket.id}`).then(({ data }) => setTicketMessages(data.messages)).catch(() => {});
    poll();
    const gate = hiddenPollGate(); // a hidden tab checks once a minute (2026-10-29)
    const t = setInterval(() => { if (gate()) poll(); }, POLL_MS);
    return () => clearInterval(t);
  }, [open, ticket, mode]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [localMessages, ticketMessages, open]);

  function pushLocal(sender, text) {
    setLocalMessages((prev) => [...prev, { sender, text, at: new Date().toISOString() }]);
  }

  function findDepartment(text) {
    const q = text.trim().toLowerCase();
    return departments.find((d) => d.name.toLowerCase() === q)
      || departments.find((d) => d.name.toLowerCase().includes(q) || q.includes(d.name.toLowerCase()));
  }

  // Reads a reply out -- the answer to a question asked with the 🎤 button.
  function sayAloud(text) {
    speak(text);
  }

  async function submit(text, { spoken = false } = {}) {
    if (!text || sending) return;
    setSending(true);
    // Spoken in, spoken out. A typed question is answered in silence -- an office does not want
    // every answer read aloud because one person prefers to type.
    const reply = (t) => { pushLocal('bot', t); if (spoken) sayAloud(t); };
    try {
      // Typed way out of the thread, for anyone who types rather than hunting for the button
      // in the header. Someone who has just raised a ticket and wants to ask something else
      // says so in words -- and until this existed, every one of those words was filed as a
      // reply to the ticket instead.
      if (mode === 'ticket_thread' && LEAVE_THREAD.test(text)) {
        pushLocal('user', text);
        setMode('chat');
        reply( `You're back with the assistant — messages are no longer going to ${ticket?.ticket_no}. Ask away, or press "Reply to ticket" to go back to it.`);
        return;
      }

      if (mode === 'ticket_thread' && ticket) {
        await api.post(`/tickets/${ticket.id}/messages`, { message: text });
        const { data } = await api.get(`/tickets/${ticket.id}`);
        setTicketMessages(data.messages);
        return;
      }

      pushLocal('user', text);

      if (mode === 'chat') {
        // Send the prior turns so the bot can answer follow-up questions in context.
        // (localMessages here is the pre-message state -- the setState from pushLocal above
        // hasn't applied yet -- so it's exactly the conversation before this message.)
        const history = localMessages.map((m) => ({ role: m.sender === 'user' ? 'user' : 'assistant', content: m.text }));
        const { data } = await api.post('/chatbot/ask', { message: text, history, pendingAction });
        reply( data.reply);
        // Cleared on every turn and only set again if this reply is itself an offer, so an
        // offer never survives past the answer to it.
        setPendingAction(data.pendingAction || null);
        if (data.isTicketTrigger) setMode('awaiting_department');
        return;
      }

      if (mode === 'awaiting_department') {
        const dept = findDepartment(text);
        if (!dept) {
          const names = departments.filter((d) => d.name !== 'System Admin').map((d) => d.name).join(', ');
          reply( `I couldn't match that to a department. Try one of: ${names}`);
          return;
        }
        setPendingDepartmentId(dept.id);
        reply( `Got it — ${dept.name}. Please describe the issue.`);
        setMode('awaiting_issue');
        return;
      }

      if (mode === 'awaiting_issue') {
        const { data: newTicket } = await api.post('/tickets', { department_id: pendingDepartmentId, description: text });
        reply( `Ticket ${newTicket.ticket_no} created. Someone from that department will reply here.`);
        setTicket(newTicket);
        setMode('ticket_thread');
      }
    } catch (err) {
      reply(err.response?.data?.error || 'Something went wrong — please try again.');
    } finally {
      setSending(false);
    }
  }

  function handleSend(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput('');
    submit(text);
  }

  // ---------------------------------------------------------------- listening

  // One question, then stop.
  function startListening() {
    if (!voiceOk) { setVoiceNote(voiceUnavailableReason()); return; }
    if (listening) { cancelListenRef.current?.(); return; }
    setVoiceNote('');
    setPartial('');
    setListening(true);
    cancelListenRef.current = listenOnce({
      onPartial: setPartial,
      onResult: (text) => { setPartial(''); submit(text, { spoken: true }); },
      onError: (msg) => setVoiceNote(msg),
      onEnd: (heard) => {
        setListening(false);
        setPartial('');
        cancelListenRef.current = null;
        if (!heard) setVoiceNote('I did not catch that.');
      },
    });
  }

  // Leaving the page with the microphone live leaves the browser's recording dot on.
  useEffect(() => () => { cancelListenRef.current?.(); }, []);

  const anchor = anchorFor(pos, open);

  const combined = [
    ...localMessages,
    ...ticketMessages.map((m) => ({
      sender: m.sender_user_id === user?.id ? 'user' : 'other',
      text: m.message, at: m.created_at,
      senderName: m.sender_user_id === user?.id ? null : m.sender_name,
    })),
  ];

  // Tucked away and closed: a small corner bubble in place of the 112px figure, so it covers no
  // buttons. It opens the chat as the figure does; "Show assistant" inside brings the figure back.
  if (tucked && !open) {
    return (
      <div className="chat-widget" style={{ position: 'fixed', right: 14, bottom: 14, zIndex: 200 }}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="Support chat"
          style={{
            width: 38, height: 38, borderRadius: '50%', background: 'var(--accent)', color: '#fff', border: 'none',
            fontSize: 18, cursor: 'pointer', boxShadow: '0 3px 10px rgba(0,0,0,0.25)', opacity: 0.85, outline: 'none',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
          }}
        >
          💬
        </button>
      </div>
    );
  }

  return (
    // The class is what lets print hide it. Without one, nothing could select this element and
    // the assistant printed onto every run sheet, job order and invoice in the app.
    <div
      className="chat-widget" ref={wrapRef}
      style={{ position: 'fixed', right: anchor.right, bottom: anchor.bottom, zIndex: 200 }}
      onMouseEnter={() => setHoverMascot(true)} onMouseLeave={() => setHoverMascot(false)}
    >
      {open && (
        <div className="card" style={{ width: 320, height: 420, display: 'flex', flexDirection: 'column', marginBottom: 10, padding: 0, overflow: 'hidden', boxShadow: '0 8px 30px rgba(0,0,0,0.25)' }}>
          <div style={{ background: 'var(--accent)', color: '#fff', padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ fontSize: 14 }}>Jot With Us{ticket ? ` · ${ticket.ticket_no}` : ''}</strong>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {/* Once a ticket exists, everything typed goes into its thread. Without a way
                  back, raising a ticket permanently ends the ability to ask the assistant
                  anything -- it looks like the bot has stopped answering. */}
              {mode === 'ticket_thread' && (
                <button
                  type="button"
                  onClick={() => { setMode('chat'); pushLocal('bot', `You're back with the assistant. Ask me anything — your messages are no longer going to ${ticket?.ticket_no}. Type "open ticket" to return to it.`); }}
                  title="Stop replying to the ticket and ask the assistant instead"
                  style={{ background: 'rgba(255,255,255,0.18)', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 11, borderRadius: 10, padding: '2px 8px' }}
                >
                  Ask assistant
                </button>
              )}
              {mode === 'chat' && ticket && (
                <button
                  type="button"
                  onClick={() => { setMode('ticket_thread'); pushLocal('bot', `Back on ${ticket.ticket_no}. What you type now goes to that department.`); }}
                  title="Reply to the ticket again"
                  style={{ background: 'rgba(255,255,255,0.18)', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 11, borderRadius: 10, padding: '2px 8px' }}
                >
                  Reply to ticket
                </button>
              )}
              {ticket && (
                <Link to={`/tickets/${ticket.id}`} title="Open full ticket" style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 13 }}>↗</Link>
              )}
              {/* Tucked: the mascot is a corner bubble; this brings the figure back. */}
              {tucked && (
                <button
                  type="button"
                  onClick={() => setTuck(false)}
                  title="Show the assistant figure again"
                  style={{ background: 'rgba(255,255,255,0.18)', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 11, borderRadius: 10, padding: '2px 8px' }}
                >
                  Show assistant
                </button>
              )}
              <button type="button" onClick={() => setOpen(false)} style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 16 }}>✕</button>
            </div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {combined.map((m, i) => (
              <div key={i} style={{ alignSelf: m.sender === 'bot' || m.sender === 'other' ? 'flex-start' : 'flex-end', maxWidth: '80%' }}>
                <div style={{
                  background: m.sender === 'bot' || m.sender === 'other' ? 'var(--panel-2, #f3f4f6)' : 'var(--accent)',
                  color: m.sender === 'bot' || m.sender === 'other' ? 'var(--text)' : '#fff',
                  borderRadius: 12, padding: '6px 10px', fontSize: 13, whiteSpace: 'pre-wrap',
                }}
                >
                  {m.senderName && <div style={{ fontSize: 10, opacity: 0.7, marginBottom: 2 }}>{m.senderName}</div>}
                  {m.text}
                </div>
                <div className="muted" style={{ fontSize: 10, marginTop: 2, textAlign: m.sender === 'bot' || m.sender === 'other' ? 'left' : 'right' }}>{formatTime(m.at)}</div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
          {/* What the microphone is doing, in words. A mic button that lights up and says nothing
              is indistinguishable from one that is broken. */}
          {(listening || partial || voiceNote) && (
            <div style={{
              padding: '6px 12px', fontSize: 12, borderTop: '1px solid var(--border)',
              background: listening ? 'rgba(220,38,38,0.08)' : 'var(--panel-2, #f3f4f6)',
              color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 6,
            }}
            >
              {listening && <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--danger)', flex: '0 0 auto' }} />}
              <span style={{ opacity: partial ? 1 : 0.75 }}>
                {partial || (listening ? 'Listening…' : voiceNote)}
              </span>
            </div>
          )}
          <form onSubmit={handleSend} style={{ display: 'flex', borderTop: '1px solid var(--border)' }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={listening ? 'Listening…' : 'Type a message...'}
              disabled={sending}
              style={{ flex: 1, border: 'none', padding: '10px 12px', fontSize: 13, outline: 'none' }}
            />
            {/* Push to talk. Hidden entirely where the browser cannot listen rather than shown
                dead: see utils/voiceInput.js for the two conditions. */}
            {voiceOk && (
              <button
                type="button"
                onClick={startListening}
                disabled={sending}
                title={listening ? 'Stop listening' : 'Ask by voice'}
                style={{
                  border: 'none', background: listening ? 'var(--danger)' : 'transparent',
                  color: listening ? '#fff' : 'var(--text)', cursor: 'pointer',
                  fontSize: 16, padding: '0 12px',
                }}
              >
                {listening ? '■' : '🎤'}
              </button>
            )}
            <button type="submit" className="btn btn-primary" disabled={sending} style={{ borderRadius: 0 }}>Send</button>
          </form>
        </div>
      )}
      <button
        type="button"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={() => { if (!movedRef.current) setOpen((o) => !o); }}
        title={open ? 'Close chat' : 'Support chat -- drag to move'}
        style={open || iconError
          // Open (or no GIF): a solid accent circle so the ✕ / 💬 reads clearly.
          ? {
            width: 52, height: 52, borderRadius: '50%', background: 'var(--accent)', color: '#fff',
            border: 'none', fontSize: 22, cursor: 'pointer', boxShadow: '0 4px 14px rgba(0,0,0,0.3)',
            padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }
          // Closed: no circle/background -- the transparent full-body mascot floats. Square box so the
          // standing figure shows at full height without letterboxing.
          : {
            width: 112, height: 112, borderRadius: 0, background: 'transparent',
            border: 'none', padding: 0, display: 'block', outline: 'none',
            cursor: dragging ? 'grabbing' : 'grab',
            touchAction: 'none', userSelect: 'none',
          }}
      >
        {open ? '✕' : (iconError
          ? '💬'
          : <img src="/chat-icon.gif" alt="Support chat" draggable={false} onError={() => setIconError(true)}
              style={{ width: '100%', height: '100%', objectFit: 'contain', filter: 'drop-shadow(0 4px 8px rgba(0,0,0,0.3))' }} />
        )}
      </button>
      {/* Hide: tucks the figure into the corner bubble (shown on hover, so it adds no clutter). */}
      {!open && hoverMascot && !dragging && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setHoverMascot(false); setTuck(true); }}
          title="Hide the assistant -- it stays as a small chat bubble in the corner"
          style={{
            position: 'absolute', top: 2, left: 2, width: 22, height: 22, borderRadius: '50%',
            background: 'rgba(0,0,0,0.55)', color: '#fff', border: 'none', fontSize: 15, lineHeight: '20px',
            cursor: 'pointer', padding: 0, outline: 'none',
          }}
        >
          –
        </button>
      )}
    </div>
  );
}
