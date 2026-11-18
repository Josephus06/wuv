import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import { computeProcessCosting } from '../utils/costing';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayAuditTime } from '../utils/dates';
import { PROCESS_COSTING_COLUMNS, processCostingHeaderGroups, fmt2 } from '../utils/processCostingColumns';

// One process's costing brackets, read-only, as the source's process cost view: the process name
// in the banner, Costing and System Information tabs, a row per quantity bracket. Every figure is
// computeProcessCosting's, the same as the estimate wizard prices with.
export default function ProcessCostingView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [process, setProcess] = useState(null);
  const [brackets, setBrackets] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [tab, setTab] = useState('costing');
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState('');

  // Update (2026-11-04): INK takes New INK Cost -- the process's ink cost per unit from Lookups >
  // Processes > Ink, which New INK Cost follows by itself -- so the two match again.
  const inkBehind = brackets.some((b) => b.new_ink_cost != null && Number(b.new_ink_cost) !== Number(b.ink_cost ?? NaN));
  async function applyInkCost() {
    setUpdating(true); setError('');
    try {
      const { data } = await api.post(`/processes/${id}/cost-brackets/apply-ink-cost`);
      setBrackets(data.brackets);
      api.get(`/processes/${id}/audit-logs`).then((a) => setAuditLogs(a.data)).catch(() => {});
    } catch (e) {
      setError(e.response?.data?.error || 'Could not update INK.');
    } finally { setUpdating(false); }
  }

  useEffect(() => {
    Promise.all([
      api.get('/lookups/processes'),
      api.get(`/processes/${id}/cost-brackets`),
      api.get(`/processes/${id}/audit-logs`).catch(() => ({ data: [] })),
    ]).then(([p, b, a]) => {
      setProcess(p.data.find((x) => String(x.id) === String(id)) || null);
      setBrackets(b.data);
      setAuditLogs(a.data);
      setLoading(false);
    });
  }, [id]);

  if (loading) return <LoadingSpinner />;
  if (!process) return <div className="card">Process not found.</div>;

  const groups = processCostingHeaderGroups();

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={'/process-costing'}>Back</Link>
          {(can('/process-costing', 'can_edit') || can('/process-costing', 'can_add')) && (
            <Link className="btn btn-sm btn-primary" to={`/process-costing/${id}/edit`}>Edit</Link>
          )}
          {can('/process-costing', 'can_edit') && (
            <button type="button" className="btn btn-sm btn-primary" disabled={updating || !inkBehind} onClick={applyInkCost}
              title={inkBehind ? 'Set INK to the New INK Cost on every bracket' : 'INK already equals the New INK Cost'}>
              {updating ? 'Updating…' : 'Update'}
            </button>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {inkBehind && (
        <div className="muted" style={{ marginBottom: 8, color: '#b45309' }}>
          New INK Cost has changed from the process&apos;s Ink set-up. Click Update to make INK the same.
        </div>
      )}
      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1 style={{ fontSize: '2em' }}>{process.process_name}</h1>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 16 }}>
        <button type="button" className={`status-tab ${tab === 'costing' ? 'active' : ''}`} onClick={() => setTab('costing')}>Costing</button>
        <button type="button" className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Information</button>
      </div>

      {tab === 'costing' && (
        <div className="card">
          <div className="spreadsheet-wrap">
            <table className="spreadsheet-table pc-table">
              <thead>
                <tr>
                  <th>Qty Bracket</th>
                  {groups.map((g, i) => (
                    <th key={i} colSpan={g.span} className={`${g.shade ? 'pc-shade' : ''}${g.highlight ? ' pc-highlight' : ''}`}>{g.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {brackets.length === 0 && (
                  <tr><td colSpan={PROCESS_COSTING_COLUMNS.length + 1} className="muted" style={{ textAlign: 'center', padding: 20 }}>No costing brackets yet.</td></tr>
                )}
                {brackets.map((b) => {
                  const c = computeProcessCosting(b) || {};
                  return (
                    <tr key={b.id}>
                      <td className="text-right" style={{ whiteSpace: 'nowrap' }}>{`${Number(b.qty_min)}-${Number(b.qty_max)}`}</td>
                      {PROCESS_COSTING_COLUMNS.map((col) => (
                        <td
                          key={col.key || col.calc}
                          className={`${col.text ? '' : 'text-right'}${col.shade ? ' pc-shade' : ''}${col.highlight ? ' pc-highlight' : ''}`}
                          style={{ whiteSpace: 'nowrap' }}
                        >
                          {col.text ? (b[col.key] || '') : fmt2(col.calc ? c[col.calc] : b[col.key])}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'system' && (
        <div className="card">
          <DataTable
            columns={[
              { key: 'set_at', label: 'Date Time', render: (r) => displayAuditTime(r.set_at) },
              { key: 'set_by_name', label: 'Set By' },
              { key: 'event_type', label: 'Type' },
              { key: 'field_name', label: 'Field' },
              { key: 'old_value', label: 'Old Value' },
              { key: 'new_value', label: 'New Value' },
            ]}
            rows={auditLogs}
            emptyLabel="No changes recorded for this process yet."
          />
        </div>
      )}
    </div>
  );
}
