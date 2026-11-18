import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import { computeProcessCosting } from '../utils/costing';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import {
  PROCESS_COSTING_COLUMNS, processCostingHeaderGroups, EMPTY_BRACKET, BRACKET_FIELDS, fmt2,
} from '../utils/processCostingColumns';

// The source's PROCESS COSTING form: the Process, then the Costing grid with Add / Delete on every
// row. Inputs are the bracket's own fields; the shaded cells are computeProcessCosting's formulas,
// live as you type. Nothing reaches the server until Save -- deletes included -- so leaving with
// Back to Lists discards the lot.
//
// /process-costing/new picks the process first; /process-costing/:id/edit opens that one's.
export default function ProcessCostingEdit() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [processes, setProcesses] = useState([]);
  const [processId, setProcessId] = useState(id || '');
  const [rows, setRows] = useState([]);
  const [deletedIds, setDeletedIds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/lookups/processes').then(({ data }) => { setProcesses(data); if (!id) setLoading(false); });
  }, [id]);

  useEffect(() => {
    if (!processId) return;
    setLoading(true);
    api.get(`/processes/${processId}/cost-brackets`).then(({ data }) => {
      setRows(data.length ? data : [{ ...EMPTY_BRACKET, _dirty: true }]);
      setDeletedIds([]);
      setLoading(false);
    });
  }, [processId]);

  const process = processes.find((p) => String(p.id) === String(processId));
  const groups = processCostingHeaderGroups();
  const canDelete = can('/process-costing', 'can_delete');

  function setField(idx, key, value) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, [key]: value, _dirty: true } : r)));
  }
  // Add puts a blank bracket directly under the row it was pressed on.
  function addAfter(idx) {
    setRows((prev) => [...prev.slice(0, idx + 1), { ...EMPTY_BRACKET, _dirty: true }, ...prev.slice(idx + 1)]);
  }
  function remove(idx) {
    const row = rows[idx];
    if (row.id) setDeletedIds((d) => [...d, row.id]);
    setRows((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      return next.length ? next : [{ ...EMPTY_BRACKET, _dirty: true }];
    });
  }

  async function save() {
    if (!processId) { setError('Choose a Process.'); return; }
    // A brand-new, untouched blank row is not a bracket; anything else needs its quantity range.
    const toSave = rows.filter((r) => r.id || r.qty_min !== '' || r.qty_max !== '');
    const incomplete = toSave.find((r) => r._dirty && (r.qty_min === '' || r.qty_max === '' || r.qty_min == null || r.qty_max == null));
    if (incomplete) { setError('Enter both ends of the Qty Bracket on every row before saving.'); return; }
    setSaving(true);
    setError('');
    try {
      for (const bid of deletedIds) await api.delete(`/processes/${processId}/cost-brackets/${bid}`);
      for (const r of toSave) {
        if (!r._dirty) continue;
        const payload = {};
        BRACKET_FIELDS.forEach((f) => { payload[f] = r[f] === '' ? null : r[f]; });
        if (r.id) await api.put(`/processes/${processId}/cost-brackets/${r.id}`, payload);
        else await api.post(`/processes/${processId}/cost-brackets`, payload);
      }
      navigate(`/process-costing/${processId}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed.');
      setSaving(false);
    }
  }

  const input = (r, idx, key, opts = {}) => (
    <input
      type={opts.text ? 'text' : 'number'}
      step="any"
      value={r[key] ?? ''}
      onChange={(e) => setField(idx, key, e.target.value)}
      style={opts.style}
    />
  );

  return (
    <div>
      <div className="page-header">
        <h1>Process Costing</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn" to={'/process-costing'}>Back to Lists</Link>
          <button type="button" className="btn btn-primary" disabled={saving || !processId} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="field" style={{ maxWidth: 560 }}>
          <label>Process:</label>
          {id ? (
            <input value={process?.process_name || ''} readOnly disabled />
          ) : (
            <EntityPicker
              label="Process" items={processes.filter((p) => p.is_active)} value={processId}
              getLabel={(p) => p.process_name}
              columns={[{ key: 'process_code', label: 'Code' }, { key: 'process_name', label: 'Name' }]}
              searchKeys={['process_code', 'process_name']}
              onSelect={(p) => setProcessId(p.id)}
            />
          )}
        </div>

        <div className="status-tabs" style={{ marginTop: 20 }}>
          <button type="button" className="status-tab active">Costing</button>
        </div>

        {!processId ? (
          <p className="muted">Choose a process to set its costing.</p>
        ) : loading ? <LoadingSpinner /> : (
          <div className="spreadsheet-wrap">
            <table className="spreadsheet-table pc-table">
              <thead>
                <tr>
                  <th />
                  <th>Qty Bracket</th>
                  {groups.map((g, i) => (
                    <th key={i} colSpan={g.span} className={`${g.shade ? 'pc-shade' : ''}${g.highlight ? ' pc-highlight' : ''}`}>{g.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => {
                  const c = computeProcessCosting(r) || {};
                  return (
                    <tr key={r.id || `new-${idx}`} title={r._dirty ? 'Unsaved changes' : undefined}
                      style={r._dirty ? { boxShadow: 'inset 3px 0 0 var(--warning, #d97706)' } : undefined}>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => addAfter(idx)}>Add</button>{' '}
                        {canDelete && <button type="button" className="btn btn-sm btn-danger" onClick={() => remove(idx)}>Delete</button>}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {input(r, idx, 'qty_min', { style: { width: 70 } })}
                        <span style={{ margin: '0 4px' }}>-</span>
                        {input(r, idx, 'qty_max', { style: { width: 80 } })}
                      </td>
                      {PROCESS_COSTING_COLUMNS.map((col) => (col.calc ? (
                        <td key={col.calc} className={`text-right${col.shade ? ' pc-shade' : ''}`} style={{ whiteSpace: 'nowrap' }}>
                          {fmt2(c[col.calc])}
                        </td>
                      ) : (
                        <td key={col.key} className={col.highlight ? 'pc-highlight' : ''}>
                          {input(r, idx, col.key, { text: col.text })}
                        </td>
                      )))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
