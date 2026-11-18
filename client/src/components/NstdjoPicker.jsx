import { useEffect, useState } from 'react';
import api from '../api/client';
import Modal from './Modal';
import Pagination from './Pagination';
import LoadingSpinner from './LoadingSpinner';

const PAGE_SIZE = 10;

// Tags an Estimate line to a Non-Standard Job Order, replacing the free-text NSTDJO # box.
//
// Reads the NSTDJO module's OWN list endpoint rather than a lookup table of its own, which means
// the module's permission and visibility rules apply here unchanged -- a sales rep sees their own
// orders, an SBU sees their groups', a production department sees its warehouse's. A picker that
// bypassed that would show people orders the module itself would not.
//
// Server-paged and debounced: 569 orders today, all raised since July, and it only grows.
export default function NstdjoPicker({ value, selectedLabel, onSelect, onClear, disabled }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    const t = setTimeout(() => {
      setLoading(true);
      setError('');
      api.get('/non-standard-job-orders', { params: { search: search.trim() || undefined, page, limit: PAGE_SIZE } })
        .then(({ data }) => {
          if (cancelled) return;
          setRows(data.rows || []);
          setTotal(Number(data.total) || 0);
        })
        .catch((err) => {
          if (cancelled) return;
          setRows([]);
          setTotal(0);
          // Worth saying out loud rather than showing an empty table: whoever is writing this
          // estimate may simply not have access to the Non-Standard Job Order module.
          setError(err.response?.status === 403
            ? 'You do not have access to the Non-Standard Job Order module, so there is nothing to tag from.'
            : (err.response?.data?.error || 'Could not load Non-Standard Job Orders.'));
        })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, search ? 250 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [open, search, page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <div className="picker-input">
        <input
          readOnly
          value={selectedLabel || ''}
          placeholder="Tag NSTDJO..."
          onClick={() => !disabled && setOpen(true)}
          disabled={disabled}
        />
        <button type="button" className="btn" onClick={() => setOpen(true)} disabled={disabled} aria-label="Search Non-Standard Job Order">
          🔍
        </button>
      </div>

      {open && (
        <Modal title="Non-Standard Job Order" onClose={() => setOpen(false)} large>
          <div className="picker-search" style={{ margin: '0 -24px 16px', display: 'flex', gap: 12, alignItems: 'center' }}>
            <input
              autoFocus
              placeholder="NSTDJO #, description or customer..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              style={{ flex: 1, minWidth: 0 }}
            />
            {onClear && value && (
              <button
                type="button"
                className="btn"
                style={{ whiteSpace: 'nowrap' }}
                onClick={() => { onClear(); setOpen(false); }}
              >
                Remove tag
              </button>
            )}
          </div>
          {error && <div className="error-banner">{error}</div>}
          {!error && (
            <div className="muted" style={{ marginBottom: 8 }}>
              {loading ? 'Searching…' : `${total} non-standard job order(s).`}
            </div>
          )}
          <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>NSTDJO #</th><th>Date</th><th>Customer</th><th>Description</th>
                  <th>Division</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={7} style={{ padding: 20 }}><LoadingSpinner /></td></tr>
                )}
                {!loading && rows.length === 0 && !error && (
                  <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    No non-standard job order matches.
                  </td></tr>
                )}
                {!loading && rows.map((n) => (
                  <tr key={n.id}>
                    <td>{n.nstdjo_no}</td>
                    <td>{String(n.date_created || '').slice(0, 10)}</td>
                    <td>{n.customer_name}</td>
                    <td>{(n.description || '').slice(0, 40)}</td>
                    <td>{n.sales_division_name}</td>
                    <td>{n.sub_status || n.status}</td>
                    <td>
                      <button
                        type="button"
                        className={`btn btn-sm ${String(n.id) === String(value) ? '' : 'btn-primary'}`}
                        onClick={() => { onSelect(n); setOpen(false); }}
                      >
                        {String(n.id) === String(value) ? 'Selected' : 'Select'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} totalPages={totalPages} onChange={setPage} />
        </Modal>
      )}
    </>
  );
}
