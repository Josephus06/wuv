import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import CrmCalendar from '../components/CrmCalendar';
import CrmDrafts from '../components/CrmDrafts';
import LoadingSpinner from '../components/LoadingSpinner';
import NeedsAttention from '../components/NeedsAttention';
import { displayDate } from '../utils/dates';

const TABS = [['attention', 'Needs Attention'], ['drafts', 'Email Drafts'], ['calendar', 'Calendar'], ['overview', 'Overview']];

// CRM home. Needs Attention (who to reach out to, and why) is the default tab; the pipeline
// numbers that used to be the whole page are under Overview.
export default function CrmDashboard() {
  const [tab, setTab] = useState('attention');
  return (
    <div>
      <div className="page-header">
        <h1>CRM Dashboard</h1>
      </div>
      <div className="status-tabs" style={{ marginBottom: 16 }}>
        {TABS.map(([k, label]) => (
          <button key={k} type="button" className={`status-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === 'attention' && <NeedsAttention />}
      {tab === 'drafts' && <CrmDrafts />}
      {tab === 'calendar' && <CrmCalendar />}
      {tab === 'overview' && <CrmOverview />}
    </div>
  );
}

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? displayDate(v) : ''; }
function isOverdue(v) { return v && new Date(v) < new Date(new Date().toDateString()); }

// The "does this actually work as a CRM" payoff page -- aggregates the pipeline
// (now derived from real estimates/sales_orders/job_orders, see
// server/src/routes/crmPipeline.js, rather than a manually-tracked Opportunity stage)
// and open follow-ups (crm_activities' My Tasks endpoint) into one view.
function CrmOverview() {
  const navigate = useNavigate();
  const [pipeline, setPipeline] = useState([]);
  const [stages, setStages] = useState({ labels: {}, openStages: [] });
  const [leads, setLeads] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get('/crm-pipeline'),
      api.get('/crm-pipeline/meta/stages'),
      api.get('/leads'),
      api.get('/crm-activities/my-tasks'),
    ]).then(([p, s, l, t]) => {
      setPipeline(p.data);
      setStages(s.data);
      setLeads(l.data.rows);
      setTasks(t.data);
      setLoading(false);
    });
  }, []);

  if (loading) return <LoadingSpinner />;

  const openDeals = pipeline.filter((r) => stages.openStages.includes(r.stage));
  const wonDeals = pipeline.filter((r) => r.stage === 'won');
  const lostDeals = pipeline.filter((r) => r.stage === 'lost');
  const totalPipeline = openDeals.reduce((s, r) => s + r.value, 0);
  const totalWon = wonDeals.reduce((s, r) => s + r.value, 0);
  const closedCount = wonDeals.length + lostDeals.length;
  const winRate = closedCount ? Math.round((wonDeals.length / closedCount) * 100) : 0;
  const openLeads = leads.filter((l) => l.status !== 'converted').length;

  return (
    <div>
      <div className="review-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 20 }}>
        <div className="card"><span className="muted">Open Pipeline Value</span><div className="hi-lg">{money(totalPipeline)}</div></div>
        <div className="card"><span className="muted">Open Deals</span><div className="hi-lg">{openDeals.length}</div></div>
        <div className="card"><span className="muted">Won (Billed)</span><div className="hi-lg">{money(totalWon)}</div></div>
        <div className="card"><span className="muted">Win Rate</span><div className="hi-lg">{winRate}%</div></div>
      </div>

      <div className="review-grid" style={{ gridTemplateColumns: '2fr 1fr', gap: 16 }}>
        <div className="card">
          <h3 className="subsection" style={{ marginTop: 0 }}>Pipeline by Stage</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Stage</th><th>Count</th><th>Value</th></tr></thead>
              <tbody>
                {Object.entries(stages.labels).map(([key, label]) => {
                  const stageRows = pipeline.filter((r) => r.stage === key);
                  const value = stageRows.reduce((s, r) => s + r.value, 0);
                  return (
                    <tr key={key}>
                      <td>{label}</td>
                      <td>{stageRows.length}</td>
                      <td>{money(value)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Link className="btn" style={{ marginTop: 12 }} to={'/pipeline'}>View Pipeline</Link>
        </div>

        <div className="card">
          <h3 className="subsection" style={{ marginTop: 0 }}>My Open Tasks</h3>
          {tasks.length === 0 && <div className="empty-state">No open tasks.</div>}
          {tasks.map((t) => (
            <div key={t.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div>{t.subject}</div>
              {t.due_date && (
                <div className="muted" style={{ fontSize: 12, color: isOverdue(t.due_date) ? 'var(--danger)' : undefined }}>
                  Due {formatDate(t.due_date)}{isOverdue(t.due_date) ? ' (Overdue)' : ''}
                </div>
              )}
            </div>
          ))}
          <h3 className="subsection">Leads</h3>
          <div>Open Leads: <strong>{openLeads}</strong></div>
          <Link className="btn" style={{ marginTop: 12 }} to={'/leads'}>View Leads</Link>
        </div>
      </div>
    </div>
  );
}
