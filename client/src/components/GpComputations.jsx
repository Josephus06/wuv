// The estimate's GP Computations tab, laid out as the working (asked 2026-10-02): per line
// Subtotal - Discount = Net of Tax, Net of Tax - Total Cost = GP Amount, GP Amount / Net of Tax =
// GP Rate, against the job type's Passing Rate; then the same sums for the whole estimate, which is
// the footer's Est. GP Rate. lineGp / lineCost come from EstimateView so the tab and the footer
// can never be worked out two ways.
const right = { textAlign: 'right' };
const pct = (v) => (v == null || !Number.isFinite(v) ? '' : `${v.toFixed(2)}%`);

export default function GpComputations({ jobOrders, lineGp, lineCost, money, num }) {
  const rows = jobOrders.map((jo) => {
    const net = num(jo.subtotal) - num(jo.disc_amount);
    const gp = lineGp(jo);
    const cost = net - gp;
    const procCost = lineCost(jo);
    // The line's saved GP is what it is judged on. When its process lines add up to a different
    // cost, say so: on a migrated estimate those fields are the old system's rates, not costs.
    const savedBasis = jo.gp_amount != null && jo.gp_amount !== '' && Math.abs(procCost - cost) > 0.01;
    const rate = net ? (gp / net) * 100 : null;
    const passing = jo.passing_gp_rate != null ? Number(jo.passing_gp_rate) : null;
    const pass = passing != null && rate != null ? rate >= passing : null;
    return { jo, net, gp, cost, procCost, savedBasis, rate, passing, pass };
  });
  const sumNet = rows.reduce((s, r) => s + r.net, 0);
  const sumGp = rows.reduce((s, r) => s + r.gp, 0);

  return (
    <div className="card">
      <div className="muted" style={{ marginBottom: 10, fontSize: 13 }}>
        Net of Tax = Subtotal − Discount &nbsp;·&nbsp; GP Amount = Net of Tax − Total Cost &nbsp;·&nbsp;
        GP Rate = GP Amount ÷ Net of Tax × 100 &nbsp;·&nbsp; a line passes when its GP Rate is at least its job type&apos;s Passing Rate.
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th><th>Job Type</th><th>Description</th>
              <th style={right}>Subtotal</th><th style={right}>− Discount</th><th style={right}>= Net of Tax</th>
              <th style={right}>− Total Cost</th><th style={right}>= GP Amount</th>
              <th style={right}>GP Rate</th><th style={right}>Passing Rate</th><th>Result</th><th>Cost basis</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={12} className="muted" style={{ textAlign: 'center', padding: 20 }}>No job orders.</td></tr>
            )}
            {rows.map(({ jo, net, gp, cost, procCost, savedBasis, rate, passing, pass }) => (
              <tr key={jo.id}>
                <td>{jo.line_no}</td>
                <td>{jo.job_type_name}</td>
                <td style={{ whiteSpace: 'normal' }}>{jo.description}</td>
                <td style={right}>{money(jo.subtotal)}</td>
                <td style={right}>{money(jo.disc_amount)}</td>
                <td style={right}>{money(net)}</td>
                <td style={right}>{money(cost)}</td>
                <td style={right}>{money(gp)}</td>
                <td style={{ ...right, fontWeight: 600 }} title={net ? `${money(gp)} ÷ ${money(net)} × 100` : ''}>{pct(rate)}</td>
                <td style={right}>{passing != null ? pct(passing) : '—'}</td>
                <td style={{ color: pass === false ? '#b91c1c' : pass ? '#15803d' : undefined, fontWeight: 600 }}>
                  {pass == null ? '—' : pass ? 'Passed' : (jo.is_approved_low_gp ? 'Below (approved)' : 'Below')}
                </td>
                <td style={{ whiteSpace: 'normal', fontSize: 12 }} className="muted">
                  {savedBasis ? `GP saved on the estimate (process lines total ${money(procCost)}, not used)` : 'Process lines'}
                </td>
              </tr>
            ))}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td colSpan={5}>Estimate</td>
                <td style={right}>{money(sumNet)}</td>
                <td style={right}>{money(sumNet - sumGp)}</td>
                <td style={right}>{money(sumGp)}</td>
                <td style={right}>{sumNet ? pct((sumGp / sumNet) * 100) : ''}</td>
                <td colSpan={3} className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
                  {sumNet ? `Est. GP Rate = ${money(sumGp)} ÷ ${money(sumNet)} × 100` : ''}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
