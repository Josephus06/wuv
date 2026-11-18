import { useEffect, useState } from 'react';
import api from '../api/client';
import Modal from './Modal';
import Pagination from './Pagination';
import LoadingSpinner from './LoadingSpinner';

const PAGE_SIZE = 10;

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

// Looks like EntityPicker and behaves like it, but asks the SERVER for each page instead of
// filtering an array it was handed. EntityPicker is right for employees, locations and
// departments -- a few hundred rows that arrive once -- and wrong for estimates, of which there
// are 69,588: loading them to let someone pick one is the whole-table-to-show-ten problem again.
//
// `invoiceable=1` narrows it to the estimates that may actually be billed: approved by a
// supervisor, and carrying line items. That is 1,208 of the 70,125 -- the rest are migrated
// headers with no lines, or have not cleared supervisor approval, or are cancelled or
// disapproved. See server/src/lib/estimateBilling.js, which is also what refuses the save.
export default function EstimatePicker({ value, selectedLabel, onSelect, disabled }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    const t = setTimeout(() => {
      setLoading(true);
      api.get('/estimates', { params: { search: search.trim() || undefined, page, limit: PAGE_SIZE, invoiceable: 1 } })
        .then(({ data }) => {
          if (cancelled) return;
          setRows(data.rows || []);
          setTotal(Number(data.total) || 0);
        })
        .finally(() => { if (!cancelled) setLoading(false); });
      // Debounced so typing an estimate number does not fire a query per keystroke.
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
          placeholder="Select Estimate..."
          onClick={() => !disabled && setOpen(true)}
          disabled={disabled}
        />
        <button type="button" className="btn" onClick={() => setOpen(true)} disabled={disabled} aria-label="Search Estimate">
          🔍
        </button>
      </div>

      {open && (
        <Modal title="Estimate" onClose={() => setOpen(false)} large>
          <div className="picker-search" style={{ margin: '0 -24px 16px' }}>
            <input
              autoFocus
              placeholder="Estimate #, customer or description..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              style={{ width: '100%' }}
            />
          </div>
          <div className="muted" style={{ marginBottom: 8 }}>
            {loading ? 'Searching…' : `${total} estimate(s) approved by a supervisor and carrying line items.`}
          </div>
          <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Estimate #</th><th>Date</th><th>Customer</th><th>Description</th>
                  <th style={{ textAlign: 'right' }}>Total</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {!loading && rows.length === 0 && (
                  <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                    No supervisor-approved estimate with line items matches.
                  </td></tr>
                )}
                {loading && (
                  <tr><td colSpan={7} style={{ padding: 20 }}><LoadingSpinner /></td></tr>
                )}
                {!loading && rows.map((e) => (
                  <tr key={e.id}>
                    <td>{e.estimate_no}</td>
                    <td>{String(e.date_created || '').slice(0, 10)}</td>
                    <td>{e.customer_name}</td>
                    <td>{(e.contract_description || '').slice(0, 40)}</td>
                    <td style={{ textAlign: 'right' }}>{money(e.effective_total_amount ?? e.total_amount)}</td>
                    <td>{e.status}</td>
                    <td>
                      <button
                        type="button"
                        className={`btn btn-sm ${String(e.id) === String(value) ? '' : 'btn-primary'}`}
                        onClick={() => { onSelect(e); setOpen(false); }}
                      >
                        {String(e.id) === String(value) ? 'Selected' : 'Select'}
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
