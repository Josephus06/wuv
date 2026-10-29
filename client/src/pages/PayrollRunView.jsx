import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import { csvDownload, formatDate, formatPeriod, peso, qtyLabel, RUN_STATUS } from '../utils/payroll';
import { parseUtc } from '../utils/datetime';

const displayDateTime = (v) => parseUtc(v)?.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) || '';

const LINE_GROUPS = [
  ['earning', 'Earnings'],
  ['deduction', 'Deductions'],
  ['employer', 'Employer share (not deducted)'],
];

export default function PayrollRunView() {
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [run, setRun] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [search, setSearch] = useState('');
  const [slipFor, setSlipFor] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(`/payroll/${id}`);
      setRun(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load this payroll');
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function action(kind) {
    const prompts = {
      submit: 'Submit this payroll for checking? It is recomputed one last time and locked; you are recorded as Prepared By.',
      check: 'Mark this payroll as checked? You are recorded as Noted By, and it goes for approval.',
      approve: 'Approve this payroll? It is locked, and its loan deductions count against the loan balances. You are recorded as Approved By.',
      return: 'Return this payroll to draft? Prepared By and Noted By are cleared, and it has to be submitted and checked again.',
      reopen: 'Reopen this payroll? It goes back to draft, and its loan deductions stop counting until it is approved again.',
      delete: 'Delete this draft payroll? Its adjustments are deleted too.',
    };
    if (prompts[kind] && !confirm(prompts[kind])) return;
    setBusy(kind);
    setError('');
    try {
      if (kind === 'delete') {
        await api.delete(`/payroll/${id}`);
        navigate('/payroll');
        return;
      }
      await api.post(`/payroll/${id}/${kind === 'recompute' ? 'compute' : kind}`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Action failed');
    } finally {
      setBusy('');
    }
  }

  const employees = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (run?.employees || []).filter((e) => !q || [e.employee_name, e.employee_code, e.branch_name].filter(Boolean).join(' ').toLowerCase().includes(q));
  }, [run, search]);

  function exportCsv() {
    const header = ['Employee Code', 'Employee', 'Branch', 'Bank Account', 'Pay Type', 'Days Worked', 'Days Absent', 'Late (min)',
      'Undertime (min)', 'Overtime (min)', 'Gross Pay', 'SSS', 'PhilHealth', 'Pag-IBIG', 'Withholding Tax', 'Other Deductions',
      'Total Deductions', 'Net Pay', 'Employer Share'];
    const rows = run.employees.map((e) => {
      const other = Number(e.total_deductions) - Number(e.sss_ee) - Number(e.philhealth_ee) - Number(e.pagibig_ee) - Number(e.withholding_tax);
      return [e.employee_code, e.employee_name, e.branch_name, e.bank_account_no, e.pay_type, e.days_worked, e.days_absent,
        e.late_minutes, e.undertime_minutes, e.overtime_minutes, e.gross_pay, e.sss_ee, e.philhealth_ee, e.pagibig_ee,
        e.withholding_tax, other.toFixed(2), e.total_deductions, e.net_pay, e.employer_cost];
    });
    csvDownload(`payroll_${run.company_name.replace(/\W+/g, '-')}_${run.period_start}_to_${run.period_end}.csv`, header, rows);
  }

  if (!run) return error ? <div className="error-banner">{error}</div> : <LoadingSpinner />;

  const draft = run.status === 'draft';
  const status = RUN_STATUS[run.status] || { label: run.status, badge: 'badge-info' };
  const canCheck = can('/payroll-checking', 'can_approve');
  const canApprove = can('/payroll', 'can_approve');
  const trail = [
    run.prepared_by && `Prepared by ${run.prepared_by} ${displayDateTime(run.prepared_at)}`,
    run.noted_by && `Noted by ${run.noted_by} ${displayDateTime(run.noted_at)}`,
    run.approved_by && `Approved by ${run.approved_by} ${displayDateTime(run.approved_at)}`,
  ].filter(Boolean);
  const totalSss = run.employees.reduce((s, e) => s + Number(e.sss_ee), 0);
  const totalPh = run.employees.reduce((s, e) => s + Number(e.philhealth_ee), 0);
  const totalHdmf = run.employees.reduce((s, e) => s + Number(e.pagibig_ee), 0);
  const totalTax = run.employees.reduce((s, e) => s + Number(e.withholding_tax), 0);
  const flagged = run.employees.filter((e) => e.warnings?.length).length;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 style={{ marginBottom: 4 }}>
            {run.company_name} · {formatPeriod(run.period_start, run.period_end)}
          </h1>
          <div className="muted">
            {run.cutoff === 1 ? '1st' : '2nd'} cutoff · Pay date {formatDate(run.pay_date)}
            {' · '}<span className={`badge ${status.badge}`}>{status.label}</span>
            {run.notes && ` · ${run.notes}`}
          </div>
          {trail.length > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{trail.join(' · ')}</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => navigate('/payroll')}>Back</button>
          {run.employees.length > 0 && <button className="btn" onClick={() => window.open(`/payroll/${run.id}/print`, '_blank')}>Print Payroll</button>}
          {run.employees.length > 0 && <button className="btn" onClick={() => window.open(`/payroll/${run.id}/payslips/print`, '_blank')}>Print Payslips</button>}
          {run.employees.length > 0 && <button className="btn" onClick={exportCsv}>Export CSV</button>}
          {draft && can('/payroll', 'can_edit') && <button className="btn" disabled={!!busy} onClick={() => action('recompute')}>{busy === 'recompute' ? 'Computing…' : 'Recompute'}</button>}
          {draft && can('/payroll', 'can_delete') && <button className="btn btn-danger" disabled={!!busy} onClick={() => action('delete')}>Delete</button>}
          {draft && can('/payroll', 'can_edit') && <button className="btn btn-primary" disabled={!!busy} onClick={() => action('submit')}>{busy === 'submit' ? 'Submitting…' : 'Submit for Checking'}</button>}
          {['for_checking', 'for_approval'].includes(run.status) && (canCheck || canApprove) && <button className="btn" disabled={!!busy} onClick={() => action('return')}>Return to Draft</button>}
          {run.status === 'for_checking' && canCheck && <button className="btn btn-primary" disabled={!!busy} onClick={() => action('check')}>{busy === 'check' ? 'Saving…' : 'Mark as Checked'}</button>}
          {run.status === 'for_approval' && canApprove && <button className="btn btn-primary" disabled={!!busy} onClick={() => action('approve')}>{busy === 'approve' ? 'Approving…' : 'Approve'}</button>}
          {run.status === 'approved' && canApprove && <button className="btn" disabled={!!busy} onClick={() => action('reopen')}>Reopen</button>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {run.warnings.map((w) => <div key={w} className="warning-banner" style={{ marginBottom: 8 }}>{w}</div>)}
      {flagged > 0 && (
        <div className="warning-banner" style={{ marginBottom: 8 }}>
          {flagged} employee{flagged > 1 ? 's have' : ' has'} notes to check — marked ⚠ below. Open them to see why.
        </div>
      )}

      <div className="stat-grid">
        <div className="stat-card"><div className="value">{run.employee_count}</div><div className="label">Employees</div></div>
        <div className="stat-card"><div className="value">{peso(run.total_gross)}</div><div className="label">Gross pay</div></div>
        <div className="stat-card"><div className="value">{peso(run.total_deductions)}</div><div className="label">Deductions</div></div>
        <div className="stat-card"><div className="value">{peso(run.total_net)}</div><div className="label">Net pay to release</div></div>
        <div className="stat-card"><div className="value">{peso(run.total_employer)}</div><div className="label">Employer share (SSS, PhilHealth, Pag-IBIG)</div></div>
      </div>

      <div className="card">
        <div className="filter-grid" style={{ marginBottom: 12 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Search</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Employee, code, branch..." />
          </div>
        </div>
        {employees.length === 0 ? (
          <div className="empty-state">
            {run.employees.length ? 'No employee matches the search.' : 'No employees were paid in this run. Check that employees have this company and a pay rate.'}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="payroll-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th className="num">Days</th>
                  <th className="num">Gross</th>
                  <th className="num">SSS</th>
                  <th className="num">PhilHealth</th>
                  <th className="num">Pag-IBIG</th>
                  <th className="num">Tax</th>
                  <th className="num">Other</th>
                  <th className="num">Net Pay</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((e) => {
                  const other = Number(e.total_deductions) - Number(e.sss_ee) - Number(e.philhealth_ee) - Number(e.pagibig_ee) - Number(e.withholding_tax);
                  return (
                    <tr key={e.id} className="clickable" onClick={() => setSlipFor(e.employee_id)}>
                      <td>
                        {e.warnings?.length > 0 && <span title={e.warnings.join('\n')} style={{ marginRight: 6 }}>⚠</span>}
                        <strong>{e.employee_name}</strong>
                        <div className="muted" style={{ fontSize: 11 }}>{[e.employee_code, e.branch_name, e.pay_type === 'daily' ? 'Daily' : 'Monthly'].filter(Boolean).join(' · ')}</div>
                      </td>
                      <td className="num">{Number(e.days_worked)}{e.days_absent > 0 && <div className="muted" style={{ fontSize: 11 }}>{e.days_absent} absent</div>}</td>
                      <td className="num">{peso(e.gross_pay)}</td>
                      <td className="num">{peso(e.sss_ee)}</td>
                      <td className="num">{peso(e.philhealth_ee)}</td>
                      <td className="num">{peso(e.pagibig_ee)}</td>
                      <td className="num">{peso(e.withholding_tax)}</td>
                      <td className="num">{peso(other)}</td>
                      <td className="num"><strong>{peso(e.net_pay)}</strong></td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th>Total</th>
                  <th />
                  <th className="num">{peso(run.total_gross)}</th>
                  <th className="num">{peso(totalSss)}</th>
                  <th className="num">{peso(totalPh)}</th>
                  <th className="num">{peso(totalHdmf)}</th>
                  <th className="num">{peso(totalTax)}</th>
                  <th className="num">{peso(Number(run.total_deductions) - totalSss - totalPh - totalHdmf - totalTax)}</th>
                  <th className="num">{peso(run.total_net)}</th>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {slipFor && (
        <PayslipModal
          runId={run.id}
          employeeId={slipFor}
          editable={draft && can('/payroll', 'can_edit')}
          adjustments={run.adjustments.filter((a) => a.employee_id === slipFor)}
          onClose={() => setSlipFor(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}

function PayslipModal({ runId, employeeId, editable, adjustments, onClose, onChanged }) {
  const [slip, setSlip] = useState(null);
  const [adding, setAdding] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.get(`/payroll/${runId}/employees/${employeeId}`).then(({ data }) => setSlip(data))
      .catch((err) => setError(err.response?.data?.error || 'Could not load the payslip'));
  }, [runId, employeeId]);

  useEffect(() => { load(); }, [load]);

  async function addAdjustment(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post(`/payroll/${runId}/adjustments`, { ...adding, employee_id: employeeId });
      setAdding(null);
      await onChanged();
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add the adjustment');
    }
  }

  async function removeAdjustment(adj) {
    if (!confirm(`Remove "${adj.label}"?`)) return;
    try {
      await api.delete(`/payroll/${runId}/adjustments/${adj.id}`);
      await onChanged();
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not remove the adjustment');
    }
  }

  return (
    <Modal title={slip ? `Payslip · ${slip.employee_name}` : 'Payslip'} onClose={onClose} large>
      {error && <div className="error-banner">{error}</div>}
      {!slip ? <LoadingSpinner /> : (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <button type="button" className="btn btn-sm" onClick={() => window.open(`/payroll/${runId}/payslips/print?employee_id=${employeeId}`, '_blank')}>
              Print Payslip
            </button>
          </div>
          <div className="muted" style={{ marginBottom: 12 }}>
            {[slip.employee_code, slip.position_title, slip.branch_name].filter(Boolean).join(' · ')}
            {' · '}{slip.pay_type === 'daily' ? `Daily ${peso(slip.base_rate)}` : `Monthly ${peso(slip.base_rate)}`}
            {' · '}Daily rate {peso(slip.daily_rate)} · Hourly {peso(slip.hourly_rate)}
          </div>
          {slip.warnings.map((w) => <div key={w} className="warning-banner" style={{ marginBottom: 8 }}>{w}</div>)}

          {LINE_GROUPS.map(([type, title]) => {
            const lines = slip.lines.filter((l) => l.line_type === type);
            if (!lines.length) return null;
            const total = lines.reduce((s, l) => s + Number(l.amount), 0);
            return (
              <div key={type} className="payslip-group">
                <h4>{title}</h4>
                <table className="payslip-table">
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={i}>
                        <td>
                          {l.label}
                          {type === 'earning' && !l.is_taxable && <span className="muted" style={{ fontSize: 11 }}> · non-taxable</span>}
                        </td>
                        <td className="muted">{qtyLabel(l)}</td>
                        <td className={`num ${Number(l.amount) < 0 ? 'negative' : ''}`}>{peso(l.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th colSpan={2}>{type === 'earning' ? 'Gross pay' : type === 'deduction' ? 'Total deductions' : 'Employer total'}</th>
                      <th className="num">{peso(total)}</th>
                    </tr>
                  </tfoot>
                </table>
              </div>
            );
          })}

          <div className="payslip-net">
            <span>Net pay</span>
            <strong>{peso(slip.net_pay)}</strong>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            Taxable income {peso(slip.taxable_income)} · {slip.days_worked} days worked · {slip.days_absent} absent ·
            {' '}{slip.late_minutes} min late · {slip.undertime_minutes} min undertime · {Math.round(slip.overtime_minutes / 6) / 10} hr overtime
          </div>

          {editable && <ContributionEditor runId={runId} employeeId={employeeId} slip={slip} onSaved={async () => { await onChanged(); load(); }} />}

          {(editable || adjustments.length > 0) && (
            <div className="payslip-group" style={{ marginTop: 18 }}>
              <h4>Adjustments for this cutoff</h4>
              {adjustments.length === 0 && <p className="muted">None. Use one for a one-time bonus, refund or charge.</p>}
              {adjustments.map((a) => (
                <div key={a.id} className="payslip-adjustment">
                  <span>{a.adj_type === 'earning' ? '+' : '−'} {a.label}{a.adj_type === 'earning' && !a.is_taxable && <span className="muted"> · non-taxable</span>}</span>
                  <span className="num">{peso(a.amount)}</span>
                  {editable && <button type="button" className="btn btn-sm" onClick={() => removeAdjustment(a)}>Remove</button>}
                </div>
              ))}
              {editable && !adding && (
                <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setAdding({ adj_type: 'earning', label: '', amount: '', is_taxable: true })}>
                  Add Adjustment
                </button>
              )}
              {adding && (
                <form onSubmit={addAdjustment} style={{ marginTop: 10 }}>
                  <div className="field-row">
                    <div className="field" style={{ maxWidth: 160 }}>
                      <label>Type</label>
                      <select value={adding.adj_type} onChange={(e) => setAdding({ ...adding, adj_type: e.target.value })}>
                        <option value="earning">Addition</option>
                        <option value="deduction">Deduction</option>
                      </select>
                    </div>
                    <div className="field">
                      <label>Description</label>
                      <input required value={adding.label} onChange={(e) => setAdding({ ...adding, label: e.target.value })} placeholder="e.g. Performance bonus" />
                    </div>
                    <div className="field" style={{ maxWidth: 150 }}>
                      <label>Amount</label>
                      <input type="number" step="0.01" min="0.01" required value={adding.amount} onChange={(e) => setAdding({ ...adding, amount: e.target.value })} />
                    </div>
                  </div>
                  {adding.adj_type === 'earning' && (
                    <div className="field field-checkbox">
                      <input type="checkbox" id="adj-taxable" checked={adding.is_taxable} onChange={(e) => setAdding({ ...adding, is_taxable: e.target.checked })} />
                      <label htmlFor="adj-taxable">Taxable</label>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="submit" className="btn btn-primary btn-sm">Add &amp; Recompute</button>
                    <button type="button" className="btn btn-sm" onClick={() => setAdding(null)}>Cancel</button>
                  </div>
                </form>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// This cutoff's SSS / PhilHealth / Pag-IBIG employee share, changed for this payroll only.
const CONTRIBUTIONS = [
  ['SSS', 'SSS', 'sss_ee'],
  ['PHILHEALTH', 'PhilHealth', 'philhealth_ee'],
  ['PAGIBIG', 'Pag-IBIG', 'pagibig_ee'],
];
function ContributionEditor({ runId, employeeId, slip, onSaved }) {
  const [editing, setEditing] = useState(null); // { code, amount }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const overridden = (code) => (slip.contribution_overrides || []).some((o) => o.code === code);

  async function save(code, amount) {
    setBusy(true);
    setError('');
    try {
      await api.put(`/payroll/${runId}/contribution-overrides`, { employee_id: employeeId, code, amount });
      setEditing(null);
      await onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not change the contribution');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="payslip-group" style={{ marginTop: 18 }}>
      <h4>Contributions for this cutoff</h4>
      <p className="muted" style={{ fontSize: 12, margin: '0 0 6px' }}>
        Change an amount for this payroll only. For an amount every payroll should use, set it on the employee&apos;s profile.
      </p>
      {error && <div className="error-banner">{error}</div>}
      {CONTRIBUTIONS.map(([code, label, field]) => (
        <div key={code} className="payslip-adjustment">
          <span>
            {label}
            {overridden(code) && <span className="badge badge-info" style={{ marginLeft: 6 }}>changed</span>}
          </span>
          {editing?.code === code ? (
            <form style={{ display: 'flex', gap: 6, alignItems: 'center' }} onSubmit={(e) => { e.preventDefault(); save(code, editing.amount); }}>
              <input type="number" step="0.01" min="0" required autoFocus style={{ width: 110 }} value={editing.amount}
                onChange={(e) => setEditing({ code, amount: e.target.value })} />
              <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Save</button>
              <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button>
            </form>
          ) : (
            <>
              <span className="num">{peso(slip[field])}</span>
              <span style={{ display: 'flex', gap: 6 }}>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setEditing({ code, amount: String(Number(slip[field])) })}>Change</button>
                {overridden(code) && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => save(code, null)}>Use computed</button>}
              </span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
