import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';
import { CustomerLink } from '../components/PartyLink';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(v) { return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: '2-digit' }) : ''; }

// Replaces the old Opportunities kanban (a hand-typed estimated_value, manually
// dragged/picked through prospecting -> won). Every deal already leaves a real trail
// through estimates -> sales_orders -> job_orders, so this is read-only: the stage and
// dollar value are derived server-side (server/src/routes/crmPipeline.js) from
// whichever document the deal has actually progressed to. Moving a card here would mean
// moving it in the real ERP flow instead (approve the estimate, convert it, etc.).
export default function Pipeline() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [stages, setStages] = useState({ labels: {}, openStages: [] });
  const [showClosed, setShowClosed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.get('/crm-pipeline'),
      api.get('/crm-pipeline/meta/stages'),
    ]).then(([p, s]) => {
      setRows(p.data);
      setStages(s.data);
      setLoading(false);
    });
  }, []);

  if (loading) return <LoadingSpinner />;

  const stageKeys = Object.keys(stages.labels);
  const visibleStages = showClosed ? stageKeys : stageKeys.filter((k) => stages.openStages.includes(k));
  const totalOpenValue = rows.filter((r) => stages.openStages.includes(r.stage)).reduce((s, r) => s + r.value, 0);

  function openDeal(row) {
    if (row.sales_order_id) navigate(`/sales-orders/${row.sales_order_id}`);
    else navigate(`/estimates/${row.estimate_id}`);
  }

  return (
    <div>
      <div className="page-header">
        <h1>Pipeline</h1>
        <button className="btn" onClick={() => setShowClosed((v) => !v)}>{showClosed ? 'Hide Won/Lost' : 'Show Won/Lost'}</button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <span className="muted">Open Pipeline Value</span>
        <div className="hi-lg">{money(totalOpenValue)}</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${visibleStages.length}, minmax(220px, 1fr))`, gap: 12, overflowX: 'auto' }}>
        {visibleStages.map((key) => {
          const stageRows = rows.filter((r) => r.stage === key);
          const stageValue = stageRows.reduce((s, r) => s + r.value, 0);
          return (
            <div key={key} className="card" style={{ minHeight: 200 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <strong>{stages.labels[key]}</strong>
                <span className="muted">{stageRows.length}</span>
              </div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>{money(stageValue)}</div>
              {stageRows.map((r) => (
                <div
                  key={r.estimate_id}
                  className="card"
                  style={{ marginBottom: 8, padding: 10, cursor: 'pointer' }}
                  onClick={() => openDeal(r)}
                >
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>{r.customer_name ? <CustomerLink id={r.customer_id} name={r.customer_name} /> : '—'}</div>
                  <div className="muted" style={{ fontSize: 12 }}>{r.current_doc_no}</div>
                  <div style={{ fontSize: 13, marginTop: 4 }}>{money(r.value)}</div>
                  {r.sales_rep_name && <div className="muted" style={{ fontSize: 11 }}>{r.sales_rep_name}</div>}
                  <div className="muted" style={{ fontSize: 11 }}>{formatDate(r.date_created)}</div>
                </div>
              ))}
              {stageRows.length === 0 && <div className="muted" style={{ fontSize: 12 }}>No deals here.</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
