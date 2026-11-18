import { useState } from 'react';
import api from '../api/client';
import Modal from './Modal';
import EntityPicker from './EntityPicker';

// Merge two customers or two suppliers (asked 2026-10-08). RETAIN keeps its record; DELETE's
// transactions are moved onto it and DELETE's record is removed -- server/src/lib/partyMerge.js.
// The server is asked first with dry_run, so the person sees exactly what will move before the
// merge, which cannot be undone.
const TABLE_LABELS = {
  estimates: 'Estimates', sales_orders: 'Sales Orders', sales_invoices: 'Sales Invoices', customer_payments: 'Customer Payments',
  credit_memos: 'Credit Memos', customer_refunds: 'Customer Refunds', non_standard_sales_orders: 'Non-Standard SOs',
  non_standard_job_orders: 'Non-Standard JOs', warranty_certificates: 'Warranty Certificates', blanket_pos: 'Blanket POs',
  customer_contacts: 'Contacts', customer_addresses: 'Addresses', customer_attachments: 'Attachments',
  customer_relationships: 'Relationships', customer_tags: 'Tags', leads: 'Leads', opening_ar_items: 'Opening AR balances',
  purchase_orders: 'Purchase Orders', vendor_bills: 'Vendor Bills', bill_payments: 'Bill Payments', bill_credits: 'Bill Credits',
  supplier_contacts: 'Contacts', supplier_addresses: 'Addresses', supplier_attachments: 'Attachments',
  inventory_supplier_prices: 'Item supplier prices', opening_ap_items: 'Opening AP balances',
  cheques: 'Cheques', journal_lines: 'Journal lines', bank_deposit_lines: 'Deposit lines',
};

export default function MergePartyModal({ kind, items, onClose, onMerged }) {
  const noun = kind === 'customer' ? 'Customer' : 'Supplier';
  const endpoint = kind === 'customer' ? '/customers/merge' : '/suppliers/merge';
  const [retain, setRetain] = useState(null);
  const [remove, setRemove] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const picker = (label, value, onSelect, exclude) => (
    <EntityPicker label={label} items={items.filter((i) => !exclude || i.id !== exclude.id)} value={value?.id || ''}
      getLabel={(i) => i?.name} placeholder="--Select--"
      columns={[{ key: 'name', label: 'Name' }, { key: kind === 'customer' ? 'customer_code' : 'supplier_code', label: 'Code' }]}
      searchKeys={['name', kind === 'customer' ? 'customer_code' : 'supplier_code']}
      onSelect={(i) => { onSelect(i); setPreview(null); setError(''); }} />
  );

  async function check() {
    setBusy(true); setError('');
    try {
      const { data } = await api.post(endpoint, { retain_id: retain.id, delete_id: remove.id, dry_run: true });
      setPreview(data);
    } catch (e) { setError(e.response?.data?.error || 'Could not check the merge.'); }
    setBusy(false);
  }

  async function merge() {
    if (!window.confirm(`Merge "${remove.name}" into "${retain.name}"?\n\n"${remove.name}" will be deleted and its transactions moved to "${retain.name}". This cannot be undone.`)) return;
    setBusy(true); setError('');
    try {
      const { data } = await api.post(endpoint, { retain_id: retain.id, delete_id: remove.id });
      onMerged(data);
    } catch (e) { setError(e.response?.data?.error || 'The merge failed; nothing was changed.'); setBusy(false); }
  }

  const total = preview ? preview.moves.reduce((s, m) => s + m.rows, 0) : 0;
  return (
    <Modal title={`Merge ${noun}s`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <div className="field">
        <label>Retain (kept)</label>
        {picker('Retain', retain, setRetain, remove)}
      </div>
      <div className="field">
        <label>Delete (removed — its transactions move to Retain)</label>
        {picker('Delete', remove, setRemove, retain)}
      </div>

      {preview && (
        <div className="card" style={{ padding: 12, marginTop: 8, fontSize: 13 }}>
          <div style={{ marginBottom: 6 }}>
            <strong>{preview.remove.name}</strong> will be deleted.{' '}
            {total ? <>These move to <strong>{preview.retain.name}</strong>:</> : 'It has no transactions to move.'}
          </div>
          {total > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {preview.moves.map((m) => (
                <li key={`${m.table}.${m.column}`}>{TABLE_LABELS[m.table] || m.table.replace(/_/g, ' ')}: {m.rows.toLocaleString()}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        {!preview ? (
          <button type="button" className="btn btn-primary" disabled={busy || !retain || !remove} onClick={check}>
            {busy ? 'Checking…' : 'Review merge'}
          </button>
        ) : (
          <button type="button" className="btn btn-danger" disabled={busy} onClick={merge}>{busy ? 'Merging…' : 'Merge'}</button>
        )}
      </div>
    </Modal>
  );
}
