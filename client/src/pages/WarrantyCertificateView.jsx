import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import LoadingSpinner from '../components/LoadingSpinner';
import { displayDate, displayAuditTime } from '../utils/dates';
import { CustomerLink } from '../components/PartyLink';

const STATUS_LABELS = { pending_approval: 'Pending', approved: 'Approved', voided: 'Voided' };
function formatDate(v) { return v ? displayDate(v) : ''; }
function coverageDate(l) {
  const f = formatDate(l.warranty_date_from); const t = formatDate(l.warranty_date_to);
  return f && t ? `${f} to ${t}` : (f || t || '');
}

export default function WarrantyCertificateView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [wc, setWc] = useState(null);
  const [tab, setTab] = useState('certificate');
  const [auditLogs, setAuditLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function load() { return api.get(`/warranty-certificates/${id}`).then(({ data }) => { setWc(data); setLoading(false); }); }
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'system') api.get(`/warranty-certificates/${id}/audit-logs`).then(({ data }) => setAuditLogs(data)); }, [tab, id]);

  async function act(fn) { setBusy(true); setError(''); try { await fn(); await load(); } catch (e) { setError(e.response?.data?.error || 'Action failed'); } finally { setBusy(false); } }
  const handleApprove = () => { if (confirm('Approve this Warranty Certificate?')) act(() => api.put(`/warranty-certificates/${id}/approve`)); };
  const handleVoid = () => { if (confirm('Void this Warranty Certificate?')) act(() => api.put(`/warranty-certificates/${id}/void`)); };

  if (loading || !wc) return <LoadingSpinner />;
  const lines = wc.lines || [];
  const isApproved = wc.status === 'approved';
  const isVoided = wc.status === 'voided';
  // Group lines by coverage type (each coverage becomes a section header on the certificate).
  const groups = lines.reduce((acc, l) => {
    // A line may carry several coverages ("Structural, Electrical"); it is listed under each.
    const keys = String(l.coverage || '').split(',').map((x) => x.trim()).filter(Boolean);
    for (const k of keys.length ? keys : ['—']) (acc[k] = acc[k] || []).push(l);
    return acc;
  }, {});

  return (
    <div>
      <div className="page-header">
        <div style={{ fontWeight: 600 }}>WARRANTY CERTIFICATE <span className="muted">{STATUS_LABELS[wc.status] || wc.status}</span></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={'/warranty-certificates'}>Back</Link>
          {can('/warranty-certificates', 'can_edit') && !isVoided && !isApproved && <Link className="btn btn-sm btn-primary" to={`/warranty-certificates/${id}/edit`}>Edit</Link>}
          {can('/warranty-certificates', 'can_approve') && wc.status === 'pending_approval' && <button className="btn btn-sm btn-primary" disabled={busy} onClick={handleApprove}>Approve</button>}
          {/* Print is only available once the certificate has been approved. */}
          {isApproved && <button className="btn btn-sm btn-primary" onClick={() => window.open(`/warranty-certificates/${id}/print`, '_blank')}>Print</button>}
          {can('/warranty-certificates', 'can_void') && !isVoided && <button className="btn btn-sm btn-warning" disabled={busy} onClick={handleVoid}>Void</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="status-tabs">
        <button className={`status-tab ${tab === 'certificate' ? 'active' : ''}`} onClick={() => setTab('certificate')}>Certificate</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'certificate' && (
        <div className="card">
          <h1 style={{ margin: '0 0 20px' }}>Warranty # : <span style={{ marginLeft: 30 }}>{wc.wc_no}</span></h1>

          <div className="section-band">Customer Information</div>
          <div style={{ lineHeight: 2, padding: '8px 0' }}>
            <div>Customer : <span className="hi"><CustomerLink id={wc.customer_id} name={wc.customer_name} /></span></div>
            <div>Contact Person : <span className="hi">{wc.contact_name}</span></div>
            <div>Contact Number : <span className="hi">{wc.contact_number}</span></div>
            <div>Address : <span className="hi">{wc.address}</span></div>
          </div>

          <div className="section-band">Project Information</div>
          <div style={{ lineHeight: 2, padding: '8px 0' }}>
            <div>Project Name : <span className="hi">{wc.contract_description}</span></div>
            <div>Sales Order No. : <span className="hi">{wc.sales_order_no}</span></div>
            <div>Sales Order Date : <span className="hi">{formatDate(wc.sales_order_date)}</span></div>
          </div>

          {Object.entries(groups).map(([coverage, gls]) => (
            <div key={coverage} style={{ marginTop: 16 }}>
              <div className="section-band" style={{ textAlign: 'center' }}>{coverage}</div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Job Order #</th><th>Job Description</th><th>Warranty Coverage Date</th><th>Remarks</th></tr></thead>
                  <tbody>
                    {gls.map((l) => (
                      <tr key={l.id}>
                        <td>{l.job_order_no}</td>
                        <td>{l.job_description}</td>
                        <td>{coverageDate(l)}{l.ext_warranty_date_to ? ` (ext. to ${formatDate(l.ext_warranty_date_to)})` : ''}</td>
                        <td>{l.remarks}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'system' && (
        <div className="card">
          <DataTable
            columns={[
              { key: 'set_at', label: 'When', render: (r) => displayAuditTime(r.set_at) },
              { key: 'set_by_name', label: 'Set By' }, { key: 'event_type', label: 'Type' },
              { key: 'field_name', label: 'Field' }, { key: 'old_value', label: 'Old Value' }, { key: 'new_value', label: 'New Value' },
            ]}
            rows={auditLogs}
            emptyLabel="No audit history yet."
          />
        </div>
      )}
    </div>
  );
}
