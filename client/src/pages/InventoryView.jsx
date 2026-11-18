import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/useAuth';
import DataTable from '../components/DataTable';
import EntityPicker from '../components/EntityPicker';
import LoadingSpinner from '../components/LoadingSpinner';
import ItemTransactions from '../components/ItemTransactions';
import { SupplierLink } from '../components/PartyLink';
import { displayDateTime, displayAuditTime } from '../utils/dates';

// Full-page read-only Inventory item view, mirroring the real system's Inventory View
// screen -- banner + info grid + tabs. "Related Records" (Item Receipts/Invoices/
// Transfer Orders/Receiving Reports/Vendor Bills/Purchase Requisitions/Purchase
// Orders) is deliberately skipped -- it needs seven transactional modules this build
// doesn't have.
const YES_NO = (v) => (v ? 'Yes' : 'No');

function num(v) { return v === null || v === undefined || v === '' ? 0 : Number(v); }
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
}

export default function InventoryView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, user } = useAuth();

  const [item, setItem] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('purchasing');
  const [auditLogs, setAuditLogs] = useState([]);

  const [suppliers, setSuppliers] = useState([]);
  const [inventoryItems, setInventoryItems] = useState([]);
  const [newSupplierPrice, setNewSupplierPrice] = useState({ supplier_id: '', price: '', last_purchase_date: '', ref_no: '' });
  const [newSubItemQty, setNewSubItemQty] = useState(1);
  const [newUom, setNewUom] = useState('');
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState('');

  function load() {
    return api.get(`/inventory/${id}`).then(({ data }) => { setItem(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    api.get('/suppliers').then(({ data }) => setSuppliers(data));
    api.get('/inventory').then(({ data }) => setInventoryItems(data));
  }, []);

  useEffect(() => {
    if (tab === 'system') {
      api.get(`/inventory/${id}/audit-logs`).then(({ data }) => setAuditLogs(data));
    }
  }, [tab, id]);

  async function addSupplierPrice() {
    if (!newSupplierPrice.supplier_id || !newSupplierPrice.price) return;
    await api.post(`/inventory/${id}/supplier-prices`, newSupplierPrice);
    setNewSupplierPrice({ supplier_id: '', price: '', last_purchase_date: '', ref_no: '' });
    load();
  }

  async function removeSupplierPrice(priceId) {
    await api.delete(`/inventory/${id}/supplier-prices/${priceId}`);
    load();
  }

  async function addSubItem(child) {
    await api.post(`/inventory/${id}/sub-items`, { child_inventory_id: child.id, qty: newSubItemQty || 1 });
    setNewSubItemQty(1);
    load();
  }

  async function removeSubItem(subItemId) {
    await api.delete(`/inventory/${id}/sub-items/${subItemId}`);
    load();
  }

  async function addUom() {
    if (!newUom.trim()) return;
    await api.post(`/inventory/${id}/unit-of-measures`, { code: newUom.trim() });
    setNewUom('');
    load();
  }

  async function removeUom(uomId) {
    await api.delete(`/inventory/${id}/unit-of-measures/${uomId}`);
    load();
  }

  async function handleApproveCosting() {
    setApproving(true);
    setApproveError('');
    try {
      await api.put(`/inventory/${id}/approve-costing`);
      await load();
    } catch (err) {
      setApproveError(err.response?.data?.error || 'Approve Costing failed');
    } finally {
      setApproving(false);
    }
  }

  async function handleApproveAccounting() {
    setApproving(true);
    setApproveError('');
    try {
      await api.put(`/inventory/${id}/approve-accounting`);
      await load();
    } catch (err) {
      setApproveError(err.response?.data?.error || 'Approve Accounting failed');
    } finally {
      setApproving(false);
    }
  }

  if (loading || !item) return <LoadingSpinner />;

  const canEdit = can('/inventory', 'can_edit');
  const canAdd = can('/inventory', 'can_add');
  const canApprove = can('/inventory', 'can_approve');
  // Per location from the stock ledger (routes/inventories.js), not the stale snapshot table.
  const stock = item.stock_by_location || [];
  const totalQtyOnHand = stock.reduce((s, r) => s + num(r.qty_on_hand), 0);
  const hasStockUnit = num(item.conversion_factor) > 1 && !!item.stock_unit_title;
  const qty4 = (v) => (v == null ? '' : num(v).toLocaleString('en-US', { maximumFractionDigits: 4 }));
  const totalValue = totalQtyOnHand * num(item.average_cost);
  const otherInventories = inventoryItems.filter((i) => i.id !== item.id);

  const costingReady = Number(item.selling_price) > 0;
  // Any one of Asset / COGS / Income set is enough to approve (2026-10-26) -- the server's rule.
  const accountingReady = !!(item.asset_account_id || item.cogs_account_id || item.income_account_id);
  // Only stock items go through Costing / Accounting approval, as on the source (and the list's
  // tabs, routes/inventories.js NON_STOCK_SQL); a Non-Inventory, Service, Discount or Landed Cost
  // item is simply approved.
  const nonStock = ['Non-Inventory', 'Service', 'Discount', 'Landed Cost'].includes(item.item_type);
  // Non-Inventory items have their own create/edit screen (NonInventoryEdit.jsx).
  const isNonInventory = item.item_type === 'Non-Inventory';
  // Service items too (2026-10-27): THERMAL SCANNING is a Service item but this page called it an
  // Inventory Item and sent Back / Add New to the Inventory list.
  const isService = String(item.item_type || '').toLowerCase() === 'service';
  const kindTitle = isNonInventory ? 'Non-Inventory Item' : isService ? 'Service Item' : nonStock ? `${item.item_type} Item` : 'Inventory Item';
  const costingPending = !nonStock && !item.is_costing_approved;
  const accountingPending = !nonStock && !item.is_accounting_approved;
  // A System Admin always gets the approve buttons, even on an item that is not ready. The
  // readiness rules are there to stop ordinary approvers waving through half-configured
  // items, not to lock out the person who has to unstick them. The server allows the same
  // override and records it in the audit log.
  const isSystemAdmin = user?.account_type === 'System Admin';
  const showApproveCosting = canApprove && item.is_active && costingPending && (costingReady || isSystemAdmin);
  const showApproveAccounting = canApprove && item.is_active && accountingPending && (accountingReady || isSystemAdmin);
  const fullyApproved = !costingPending && !accountingPending;

  return (
    <div>
      <div className="page-header">
        <div />
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to={isNonInventory ? '/non-inventories' : isService ? '/service-items' : '/inventory'}>Back to Lists</Link>
          {canEdit && <Link className="btn btn-sm btn-primary" to={isNonInventory ? `/non-inventories/${id}/edit` : isService ? `/service-items/${id}/edit` : `/inventory/${id}/edit`}>Edit</Link>}
          {canAdd && <Link className="btn btn-sm" to={isNonInventory ? '/non-inventories/new' : isService ? '/service-items/new' : '/inventory/new'}>Add New</Link>}
          {showApproveCosting && (
            <button className="btn btn-sm btn-primary" disabled={approving} onClick={handleApproveCosting}
              title={costingReady ? undefined : 'Selling Price is not set — approving as System Admin overrides that, and the override is recorded.'}>
              Approve Costing{costingReady ? '' : ' *'}
            </button>
          )}
          {showApproveAccounting && (
            <button className="btn btn-sm btn-primary" disabled={approving} onClick={handleApproveAccounting}
              title={accountingReady ? undefined : 'None of the Asset / COGS / Income accounts is set — approving as System Admin overrides that, and the override is recorded.'}>
              Approve Accounting{accountingReady ? '' : ' *'}
            </button>
          )}
        </div>
      </div>

      {approveError && <div className="error-banner">{approveError}</div>}

      <div className="estimate-banner">
        <div className="estimate-banner-title">
          <h1>{kindTitle}</h1>
          <span className="estimate-no">{item.item_code}</span>
        </div>
        <div className="estimate-status">
          {!item.is_active ? 'Inactive' : fullyApproved ? 'Approved' : (
            <>
              {costingPending && <span className="estimate-so-link" style={{ background: 'rgba(245, 159, 0, 0.35)' }}>For Approval Costing</span>}
              {accountingPending && <span className="estimate-so-link" style={{ background: 'rgba(245, 159, 0, 0.35)' }}>For Approval Accounting</span>}
            </>
          )}
        </div>

        <div className="estimate-detail-grid">
          <div>
            <h4>Basic Info</h4>
            <div>Item Code : <span className="hi">{item.item_code}</span></div>
            <div>Category : <span className="hi">{item.category_name}</span></div>
            <div>Type : <span className="hi">{item.item_type}</span></div>
            <div>Active : <span className="hi">{YES_NO(item.is_active)}</span></div>
          </div>
          <div>
            <h4>Description</h4>
            <div>Display Name : <span className="hi">{item.display_name}</span></div>
            <div>Purchase Description : <span className="hi">{item.purchase_description}</span></div>
            <div>Sales Description : <span className="hi">{item.sales_description}</span></div>
            <div>Sub-Item Of : {item.subItemOf ? (
              <Link className="link-btn" to={`/inventory/${item.subItemOf.parent_inventory_id}`}>
                {item.subItemOf.item_code} — {item.subItemOf.display_name}
              </Link>
            ) : <span className="hi">—</span>}</div>
          </div>
          <div>
            <h4>Flags</h4>
            <div>TO Type : <span className="hi">{item.to_type || '—'}</span></div>
            <div>Office Supply Requisition : <span className="hi">{YES_NO(item.is_office_supply)}</span></div>
            <div>TO Item : <span className="hi">{YES_NO(item.is_to_item)}</span></div>
            <div>Reorder Point : <span className="hi">{item.reorder_point ?? 0}</span></div>
            {item.item_type === 'Service' && (
              <>
                <div>With JO : <span className="hi">{YES_NO(item.is_with_jo)}</span></div>
                <div>PO : <span className="hi">{YES_NO(item.is_po)}</span></div>
                <div>JO : <span className="hi">{YES_NO(item.is_jo)}</span></div>
              </>
            )}
            {isNonInventory && (
              <>
                <div>With JO : <span className="hi">{YES_NO(item.is_with_jo)}</span></div>
                <div>PO : <span className="hi">{YES_NO(item.is_po)}</span></div>
                <div>Length x Width : <span className="hi">{item.length ?? '—'} x {item.width ?? '—'}</span></div>
                <div>Conversion Type : <span className="hi">{item.conversion_type || '—'}</span></div>
                <div>Can be Received : <span className="hi">{YES_NO(item.can_be_received)}</span></div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="status-tabs" style={{ marginTop: 20 }}>
        <button className={`status-tab ${tab === 'purchasing' ? 'active' : ''}`} onClick={() => setTab('purchasing')}>Purchasing / Inventory</button>
        <button className={`status-tab ${tab === 'detail' ? 'active' : ''}`} onClick={() => setTab('detail')}>Inventory Detail</button>
        <button className={`status-tab ${tab === 'pricing' ? 'active' : ''}`} onClick={() => setTab('pricing')}>Sales / Pricing</button>
        <button className={`status-tab ${tab === 'accounting' ? 'active' : ''}`} onClick={() => setTab('accounting')}>Accounting</button>
        <button className={`status-tab ${tab === 'stocks' ? 'active' : ''}`} onClick={() => setTab('stocks')}>Warehouse Stocks</button>
        <button className={`status-tab ${tab === 'transactions' ? 'active' : ''}`} onClick={() => setTab('transactions')}>Transactions</button>
        <button className={`status-tab ${tab === 'suppliers' ? 'active' : ''}`} onClick={() => setTab('suppliers')}>Supplier Prices</button>
        <button className={`status-tab ${tab === 'subitems' ? 'active' : ''}`} onClick={() => setTab('subitems')}>Sub-Items</button>
        <button className={`status-tab ${tab === 'uom' ? 'active' : ''}`} onClick={() => setTab('uom')}>Unit of Measures</button>
        <button className={`status-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>System Info</button>
      </div>

      {tab === 'purchasing' && (
        <div className="card">
          <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div>Base Unit : <span className="hi">{item.base_unit_title} ({item.base_unit_code})</span></div>
            <div>Purchase Unit : <span className="hi">{item.purchase_unit_title || '—'}</span></div>
            <div>Stock Unit : <span className="hi">{item.stock_unit_title || '—'}</span></div>
            <div>Sales Unit : <span className="hi">{item.sales_unit_title || '—'}</span></div>
            <div>Conversion Factor : <span className="hi">{item.conversion_factor ?? 1}</span></div>
            <div />
            <div>Last Purchase Price : <span className="hi">{money(item.last_purchase_price)}</span></div>
            <div>Last Purchase Date : <span className="hi">{item.last_purchase_date ? String(item.last_purchase_date).slice(0, 10) : '—'}</span></div>
            <div>Average Cost : <span className="hi">{money(item.average_cost)}</span></div>
          </div>
        </div>
      )}

      {tab === 'detail' && (
        <div className="card">
          <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div>Priced by Length : <span className="hi">{YES_NO(item.is_length_based)}</span></div>
            <div>Priced by Width : <span className="hi">{YES_NO(item.is_width_based)}</span></div>
            <div>Price Indicator : <span className="hi">{item.price_indicator ?? 0}</span></div>
            <div>Tolerance % : <span className="hi">{item.tolerance_pct ?? 0}</span></div>
          </div>
        </div>
      )}

      {tab === 'pricing' && (
        <div className="card">
          {!costingPending ? (
            <p className="muted" style={{ marginTop: 0 }}>Costing approved by <strong>{item.costing_approved_by_name}</strong> on {item.costing_approved_at ? displayDateTime(item.costing_approved_at) : ''}.</p>
          ) : (
            <p className="muted" style={{ marginTop: 0 }}>Costing pending approval{!costingReady ? ' — Selling Price must be filled in before it can be approved.' : '.'}</p>
          )}
          <div className="review-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <div>Material Cost : <span className="hi">{money(item.material_cost)}</span></div>
            <div>Wastage Allowance % : <span className="hi">{item.wastage_allowance_pct ?? 0}</span></div>
            <div>Mark-Up % : <span className="hi">{item.markup_pct ?? 0}</span></div>
            <div>Selling Price : <span className="hi">{money(item.selling_price)}</span></div>
            <div>Beg. Selling Price : <span className="hi">{money(item.beg_selling_price)}</span></div>
            <div>Disc. Ceiling % : <span className="hi">{item.disc_ceiling_pct ?? 0}</span></div>
            <div>Disc. Supervisor % : <span className="hi">{item.disc_supervisor_pct ?? 0}</span></div>
            <div>Disc. Manager % : <span className="hi">{item.disc_manager_pct ?? 0}</span></div>
            <div>Disc. GM % : <span className="hi">{item.disc_gm_pct ?? 0}</span></div>
          </div>
          <h3 className="subsection">Price Tiers</h3>
          <DataTable
            columns={[
              { key: 'min_qty', label: 'Min Qty' },
              { key: 'max_qty', label: 'Max Qty', render: (r) => r.max_qty ?? '∞' },
              { key: 'unit_price', label: 'Unit Price', render: (r) => money(r.unit_price) },
            ]}
            rows={item.priceTiers || []}
            emptyLabel="No price tiers."
          />
        </div>
      )}

      {tab === 'accounting' && (
        <div className="card">
          {!accountingPending ? (
            <p className="muted" style={{ marginTop: 0 }}>Accounting approved by <strong>{item.accounting_approved_by_name}</strong> on {item.accounting_approved_at ? displayDateTime(item.accounting_approved_at) : ''}.</p>
          ) : (
            <p className="muted" style={{ marginTop: 0 }}>Accounting pending approval{!accountingReady ? ' — Asset, COGS, and Income accounts must all be set before it can be approved.' : '.'}</p>
          )}
          <div className="review-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div>Expense Account : <span className="hi">{item.expense_account_code ? `${item.expense_account_code} — ${item.expense_account_name}` : '—'}</span></div>
            <div>COGS Account : <span className="hi">{item.cogs_account_code ? `${item.cogs_account_code} — ${item.cogs_account_name}` : '—'}</span></div>
            <div>Asset Account : <span className="hi">{item.asset_account_code ? `${item.asset_account_code} — ${item.asset_account_name}` : '—'}</span></div>
            <div>Income Account : <span className="hi">{item.income_account_code ? `${item.income_account_code} — ${item.income_account_name}` : '—'}</span></div>
          </div>
        </div>
      )}

      {tab === 'stocks' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Location</th>
                  <th style={{ textAlign: 'right' }}>Qty On Hand ({item.base_unit_title || 'Base Unit'})</th>
                  {hasStockUnit && <th style={{ textAlign: 'right' }}>In {item.stock_unit_title}</th>}
                  <th style={{ textAlign: 'right' }}>Qty Committed</th><th style={{ textAlign: 'right' }}>Qty In Transit</th>
                  <th style={{ textAlign: 'right' }}>Average Cost</th><th style={{ textAlign: 'right' }}>Total Value</th>
                </tr>
              </thead>
              <tbody>
                {stock.length === 0 && (
                  <tr><td colSpan={hasStockUnit ? 7 : 6} className="muted" style={{ textAlign: 'center', padding: 20 }}>No location has used this item yet.</td></tr>
                )}
                {stock.map((s) => (
                  <tr key={s.location_id}>
                    <td>{s.location_name}</td>
                    <td style={{ textAlign: 'right', color: num(s.qty_on_hand) < 0 ? 'var(--danger)' : undefined }}>{qty4(s.qty_on_hand)}</td>
                    {hasStockUnit && <td style={{ textAlign: 'right' }}>{qty4(s.qty_on_hand_stock_unit)}</td>}
                    <td style={{ textAlign: 'right' }}>{qty4(s.qty_committed)}</td>
                    <td style={{ textAlign: 'right' }}>{qty4(s.qty_in_transit)}</td>
                    <td style={{ textAlign: 'right' }}>{money(item.average_cost)}</td>
                    <td style={{ textAlign: 'right' }}>{money(num(s.qty_on_hand) * num(item.average_cost))}</td>
                  </tr>
                ))}
              </tbody>
              {stock.length > 0 && (
                <tfoot>
                  <tr>
                    <td><strong>Total</strong></td>
                    <td style={{ textAlign: 'right' }}><strong>{qty4(totalQtyOnHand)}</strong></td>
                    {hasStockUnit && <td style={{ textAlign: 'right' }}><strong>{qty4(totalQtyOnHand / num(item.conversion_factor))}</strong></td>}
                    <td></td>
                    <td></td>
                    <td></td>
                    <td style={{ textAlign: 'right' }}><strong>{money(totalValue)}</strong></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          {/* Where these come from, so nobody reconciles them against a number they cannot see. */}
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
            On hand is the running total of every stock movement (the same figure as the Bin Card and Production's
            On Hand). Every location that has used this item is listed, including ones now at zero. A negative
            balance means that location's movement history is incomplete.
          </p>
        </div>
      )}

      {tab === 'transactions' && <ItemTransactions itemId={item.id} baseUnit={item.base_unit_title} />}

      {tab === 'suppliers' && (
        <div className="card">
          <DataTable
            columns={[
              { key: 'supplier_name', label: 'Supplier', render: (r) => <SupplierLink id={r.supplier_id} name={r.supplier_name} /> },
              { key: 'price', label: 'Price', render: (r) => money(r.price) },
              { key: 'last_purchase_date', label: 'Last Purchase Date', render: (r) => (r.last_purchase_date ? String(r.last_purchase_date).slice(0, 10) : '') },
              { key: 'ref_no', label: 'Ref No.' },
            ]}
            rows={item.supplierPrices || []}
            actions={canEdit ? (r) => <button className="btn btn-sm btn-danger" onClick={() => removeSupplierPrice(r.id)}>Remove</button> : undefined}
            emptyLabel="No supplier prices yet."
          />
          {canEdit && (
            <div className="inline-form" style={{ marginTop: 10 }}>
              <div className="field">
                <label>Supplier</label>
                <select value={newSupplierPrice.supplier_id} onChange={(e) => setNewSupplierPrice({ ...newSupplierPrice, supplier_id: e.target.value })}>
                  <option value="">—</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Price</label>
                <input type="number" step="0.0001" value={newSupplierPrice.price} onChange={(e) => setNewSupplierPrice({ ...newSupplierPrice, price: e.target.value })} />
              </div>
              <div className="field">
                <label>Last Purchase Date</label>
                <input type="date" value={newSupplierPrice.last_purchase_date} onChange={(e) => setNewSupplierPrice({ ...newSupplierPrice, last_purchase_date: e.target.value })} />
              </div>
              <div className="field">
                <label>Ref No.</label>
                <input value={newSupplierPrice.ref_no} onChange={(e) => setNewSupplierPrice({ ...newSupplierPrice, ref_no: e.target.value })} />
              </div>
              <button type="button" className="btn" onClick={addSupplierPrice}>Add</button>
            </div>
          )}
        </div>
      )}

      {tab === 'subitems' && (
        <div className="card">
          <DataTable
            columns={[
              { key: 'item_code', label: 'Code' },
              { key: 'display_name', label: 'Name' },
              { key: 'sales_description', label: 'Description' },
              { key: 'qty', label: 'Qty' },
            ]}
            rows={item.subItems || []}
            actions={canEdit ? (r) => <button className="btn btn-sm btn-danger" onClick={() => removeSubItem(r.id)}>Remove</button> : undefined}
            emptyLabel="No sub-items yet."
          />
          {canEdit && (
            <div className="inline-form" style={{ marginTop: 10 }}>
              <div className="field">
                <label>Qty</label>
                <input type="number" step="0.0001" style={{ width: 100 }} value={newSubItemQty} onChange={(e) => setNewSubItemQty(e.target.value)} />
              </div>
              <div className="field">
                <label>Item</label>
                <EntityPicker
                  label="Item" items={otherInventories} value="" getLabel={(i) => i.display_name}
                  columns={[{ key: 'item_code', label: 'Code' }, { key: 'display_name', label: 'Name' }, { key: 'category_name', label: 'Category' }]}
                  searchKeys={['item_code', 'display_name']}
                  onSelect={addSubItem}
                  placeholder="Add Items..."
                />
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'uom' && (
        <div className="card">
          <p className="muted" style={{ marginTop: 0 }}>
            Unit codes usable for this item specifically -- these populate the Unit dropdown on Estimate process lines once this item is selected.
          </p>
          <DataTable
            columns={[{ key: 'code', label: 'Unit Of Measure' }]}
            rows={item.unitOfMeasures || []}
            actions={canEdit ? (r) => <button className="btn btn-sm btn-danger" onClick={() => removeUom(r.id)}>Delete</button> : undefined}
            emptyLabel="No unit of measures yet."
          />
          {canEdit && (
            <div className="inline-form" style={{ marginTop: 10 }}>
              <div className="field">
                <label>Code</label>
                <input value={newUom} onChange={(e) => setNewUom(e.target.value)} placeholder="e.g. GAL" />
              </div>
              <button type="button" className="btn" onClick={addUom}>Add Unit of Measure</button>
            </div>
          )}
        </div>
      )}

      {tab === 'system' && (
        <div className="card">
          <DataTable
            columns={[
              { key: 'set_at', label: 'When', render: (r) => displayAuditTime(r.set_at) },
              { key: 'set_by_name', label: 'Set By' },
              { key: 'event_type', label: 'Type' },
              { key: 'field_name', label: 'Field' },
              { key: 'old_value', label: 'Old Value' },
              { key: 'new_value', label: 'New Value' },
            ]}
            rows={auditLogs}
            emptyLabel="No audit history yet."
          />
        </div>
      )}
    </div>
  );
}
