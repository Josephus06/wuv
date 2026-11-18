function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Recursively renders one COA node (Trial Balance/Balance Sheet's shared shape:
// account_code, account_name, is_summary, amount, children[]), indenting each level
// to visualize the parent/child rollup -- summary/parent rows are bolded since their
// amount is a computed sum of their children, not a directly posted balance.
// onDrill (optional): makes the amount a link that opens the transactions behind it (Balance Sheet).
export default function CoaTreeRows({ node, depth = 0, normal, onDrill }) {
  const rows = [];
  const isDebitCol = normal === 'DEBIT';
  // The synthetic Current Earnings line has no ledger of its own to open.
  const drillable = onDrill && Number(node.amount) && !String(node.account_code).startsWith('CURRENT');
  const amount = (v) => (drillable && money(v)
    ? <button type="button" className="link-btn" style={{ textDecoration: 'underline' }} title="Show the transactions behind this amount" onClick={() => onDrill(node)}>{money(v)}</button>
    : money(v));
  rows.push(
    <tr key={node.account_code}>
      <td data-label="Account Code" style={{ paddingLeft: 12 + depth * 20 }}>{node.account_code}</td>
      <td data-label="Account Title" style={node.is_summary ? { fontWeight: 600 } : undefined}>{node.account_name}</td>
      <td data-label="Debit" style={{ textAlign: 'right' }}>{isDebitCol ? amount(node.amount) : ''}</td>
      <td data-label="Credit" style={{ textAlign: 'right' }}>{!isDebitCol ? amount(node.amount) : ''}</td>
    </tr>
  );
  for (const child of node.children || []) {
    rows.push(<CoaTreeRows key={child.account_code} node={child} depth={depth + 1} normal={normal} onDrill={onDrill} />);
  }
  return rows;
}

export { money };
