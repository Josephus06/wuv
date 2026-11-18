import { Link } from 'react-router-dom';

// A customer's or supplier's name, opening their record in Master Lists (asked 2026-10-06: every
// transaction's customer / supplier name clickable). Plain text when the id is not known -- a
// migrated row with only a name, or a document that names nobody -- so a dead link is never drawn.
//
// The click stops there: many list rows are themselves clickable (open the document), and following
// the name must not also open the row.
function PartyLink({ to, name, title }) {
  if (!name) return null;
  if (!to) return <>{name}</>;
  return (
    <Link to={to} className="party-link" title={title} onClick={(e) => e.stopPropagation()}>
      {name}
    </Link>
  );
}

export function CustomerLink({ id, name }) {
  return <PartyLink to={id ? `/customers/${id}` : null} name={name} title="Open this customer in Master Lists" />;
}

export function SupplierLink({ id, name }) {
  return <PartyLink to={id ? `/suppliers/${id}` : null} name={name} title="Open this supplier in Master Lists" />;
}
