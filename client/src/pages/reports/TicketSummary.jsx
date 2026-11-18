import { useState } from 'react';
import api from '../../api/client';
import LoadingSpinner from '../../components/LoadingSpinner';
import { parseUtc } from '../../utils/datetime';

function today() {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(v) {
  // Ticket timestamps are written by this app with MySQL NOW(), and the database runs on UTC,
  // so they arrive as UTC wall-clock with no marker -- parseUtc, not new Date, or every time
  // reads 8 hours behind in Cebu. See utils/datetime.js.
  return v ? parseUtc(v).toLocaleString('en-US', {
    month: 'short', day: '2-digit', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }) : '—';
}

function firstDayOfMonth() {
  const d = new Date();
  d.setDate(1);
  return d.toISOString().slice(0, 10);
}

export default function TicketSummary() {
  const [filterType, setFilterType] = useState('period_from');
  const [asOf, setAsOf] = useState(today());
  const [fromDate, setFromDate] = useState(firstDayOfMonth());
  const [toDate, setToDate] = useState(today());
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [downloadLoading, setDownloadLoading] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  function buildParams() {
    const params = {};
    if (filterType === 'period_from') {
      params.from = fromDate;
      params.to = toDate;
    } else {
      params.asOf = asOf;
    }
    return params;
  }

  async function generate() {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/reports/tickets', { params: buildParams() });
      setSummary(data.summary);
      setRows(data.rows || []);
      setLoaded(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to generate ticket summary');
      setLoaded(false);
    } finally {
      setLoading(false);
    }
  }

  async function downloadCsv() {
    setDownloadLoading(true);
    setError('');
    try {
      const res = await api.get('/reports/tickets', {
        params: { ...buildParams(), format: 'csv' },
        responseType: 'blob',
      });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ticket-report.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to download ticket report');
    } finally {
      setDownloadLoading(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Ticket Summary</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filter-grid">
          <div className="field">
            <label>Filter by created date</label>
            <select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
              <option value="as_of">As of </option>
              <option value="period_from">Created </option>
            </select>
          </div>
          {filterType === 'period_from' && (
            <div className="field">
              <label>Created from</label>
              <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </div>
          )}
          <div className="field">
            <label>{filterType === 'period_from' ? 'Created to' : 'Created date as of'}</label>
            <input type="date" value={filterType === 'period_from' ? toDate : asOf} onChange={(e) => filterType === 'period_from' ? setToDate(e.target.value) : setAsOf(e.target.value)} />
          </div>
        </div>
        <div style={{ marginTop: 10, color: '#555', fontSize: 13 }}>
          This report is filtered by ticket creation date, so a June 1–30 range returns tickets created in that period.
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
          <button className="btn btn-primary" onClick={generate} disabled={loading || downloadLoading}>
            {loading ? 'Generating...' : 'Generate'}
          </button>
          <button className="btn btn-secondary" onClick={downloadCsv} disabled={loading || downloadLoading}>
            {downloadLoading ? 'Downloading...' : 'Download CSV'}
          </button>
        </div>
      </div>

      {error && <div className="card" style={{ color: '#b91c1c', marginBottom: 16 }}>{error}</div>}
      {loading && <LoadingSpinner />}

      {loaded && !loading && !error && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <div className="summary-card">
                <div className="summary-card-label">Total Tickets</div>
                <div className="summary-card-value">{summary?.total ?? '—'}</div>
              </div>
              <div className="summary-card">
                <div className="summary-card-label">Resolved</div>
                <div className="summary-card-value">{summary?.resolved ?? '—'}</div>
              </div>
              <div className="summary-card">
                <div className="summary-card-label">Unresolved</div>
                <div className="summary-card-value">{summary?.unresolved ?? '—'}</div>
              </div>
            </div>
          </div>

          <div className="card">
            <div style={{ marginBottom: 12 }}><strong>Recent tickets</strong></div>
            <div className="table-wrap">
              <table className="responsive-cards">
                <thead>
                  <tr>
                    <th>Ticket #</th>
                    <th>Department</th>
                    <th>Created By</th>
                    <th>Created At</th>
                    <th>Approved By</th>
                    <th>Approved At</th>
                    <th>GM Approved By</th>
                    <th>GM Approved At</th>
                    <th>Assigned To</th>
                    <th>Assigned At</th>
                    <th>Resolved At</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={11} className="muted" style={{ textAlign: 'center', padding: 20 }}>No ticket data available.</td></tr>
                  )}
                  {rows.map((row, index) => (
                    <tr key={`${row.ticket_no}-${row.created_at}-${index}`}>
                      <td>{row.ticket_no}</td>
                      <td>{row.department_name}</td>
                      <td>{row.created_by_name || '—'}</td>
                      <td>{formatDate(row.created_at)}</td>
                      <td>{row.approved_by_name || '—'}</td>
                      <td>{formatDate(row.approved_at)}</td>
                      <td>{row.gm_approved_by_name || '—'}</td>
                      <td>{formatDate(row.gm_approved_at)}</td>
                      <td>{row.assigned_to_name || '—'}</td>
                      <td>{formatDate(row.assigned_at)}</td>
                      <td>{formatDate(row.resolved_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
