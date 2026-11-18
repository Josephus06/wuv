import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from './LoadingSpinner';
import { displayMonth } from '../utils/dates';
import { WeekHead, withWeeks } from './CalendarWeeks';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ICON = { visit: '🚗', meeting: '👥' };

function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function timeOf(v) {
  const [, t = ''] = String(v).split(' ');
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// Month view of scheduled visits and meetings (GET /crm-activities/calendar). Six fixed weeks so
// the grid does not jump in height between months.
export default function CrmCalendar() {
  const navigate = useNavigate();
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [mine, setMine] = useState(true);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);

  const gridStart = new Date(month);
  gridStart.setDate(1 - month.getDay());
  const days = Array.from({ length: 42 }, (_, i) => { const d = new Date(gridStart); d.setDate(gridStart.getDate() + i); return d; });
  const from = ymd(days[0]);
  const to = ymd(days[41]);

  useEffect(() => {
    setLoading(true);
    api.get('/crm-activities/calendar', { params: { from, to, mine: mine ? 1 : undefined } }).then(({ data }) => {
      setEvents(data);
      setLoading(false);
    });
  }, [from, to, mine]);

  const byDay = new Map();
  for (const e of events) {
    const k = String(e.starts_at).slice(0, 10);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(e);
  }
  const todayKey = ymd(new Date());

  function open(e) {
    if (e.related_type === 'Customer') navigate(`/customers/${e.related_id}?tab=activity`);
    else if (e.related_type === 'Lead') navigate('/leads');
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-sm" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button>
        <h3 style={{ margin: 0, minWidth: 170, textAlign: 'center' }}>{displayMonth(month)}</h3>
        <button type="button" className="btn btn-sm" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button>
        <button type="button" className="btn btn-sm" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }}>Today</button>
        <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only mine
        </label>
      </div>
      {loading ? <LoadingSpinner /> : (
        <div style={{ overflowX: 'auto' }}>
          <div className="cal-inline-weeks" style={{ display: 'grid', gridTemplateColumns: '44px repeat(7, minmax(110px, 1fr))', gap: 1, background: 'var(--color-border)', minWidth: 814 }}>
            <WeekHead className="" style={{ background: 'var(--color-surface)', padding: 6, fontWeight: 600, fontSize: 12 }} />
            {WEEKDAYS.map((w) => <div key={w} style={{ background: 'var(--color-surface)', padding: 6, fontWeight: 600, fontSize: 12 }}>{w}</div>)}
            {withWeeks(days, (d) => {
              const k = ymd(d);
              const list = byDay.get(k) || [];
              const inMonth = d.getMonth() === month.getMonth();
              return (
                <div key={k} style={{ background: 'var(--color-surface)', minHeight: 96, padding: 4, opacity: inMonth ? 1 : 0.45 }}>
                  <div style={{ fontSize: 12, fontWeight: k === todayKey ? 700 : 400, color: k === todayKey ? 'var(--color-primary)' : undefined }}>{d.getDate()}</div>
                  {list.map((e) => (
                    <button
                      key={e.id} type="button" onClick={() => open(e)}
                      title={`${e.subject}${e.location ? ` · ${e.location}` : ''}${e.assigned_to_name ? ` · ${e.assigned_to_name}` : ''}`}
                      className={`badge ${e.is_done ? 'badge-muted' : 'badge-info'}`}
                      style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 11 }}
                    >
                      {ICON[e.activity_type]} {timeOf(e.starts_at)} {e.related_name || e.subject}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
