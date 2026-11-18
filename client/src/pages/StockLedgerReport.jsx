import { Fragment, useEffect, useState } from 'react';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

const PAGE_SIZE = 10;

// "Inventory > Inventory Reports > Stock Ledger": per Item + Location, Beginning balance /
// Input / Output / Ending balance, grouped as an Item header row followed by one row per
// Location.
//
// Beginning / Input / Output are now summed from this app's own stock movements -- receiving
// reports, item receipts and fulfillments, purchase returns, inventory adjustments and assembly
// builds -- so the Date filter genuinely selects a period instead of being decorative, and a
// receiving report entered here shows up. Clicking a Location row lists the documents behind
// its figures.
function qtyFmt(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}
function moneyFmt(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

export default function StockLedgerReport() {
  const [showFilters, setShowFilters] = useState(true);
  const [item, setItem] = useState(null);
  const [location, setLocation] = useState(null);
  const [period, setPeriod] = useState('as_of');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [dateFrom, setDateFrom] = useState(new Date().toISOString().slice(0, 10));

  const [inventoryItems, setInventoryItems] = useState([]);
  const [locations, setLocations] = useState([]);
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  // The period the rows on screen were generated for, so the drill-down asks about the same one
  // even after the filter inputs have been changed but not re-generated.
  const [shownPeriod, setShownPeriod] = useState(null);
  const [openCell, setOpenCell] = useState(null); // `${inventory_id}-${location_id}`
  const [movements, setMovements] = useState({});

  useEffect(() => {
    // include_inactive: a discontinued item still has stock on a shelf and a history worth
    // reading. This is a report, not a form -- hiding it here would hide real stock.
    api.get('/inventory', { params: { include_inactive: 1 } }).then(({ data }) => setInventoryItems(data));
    api.get('/lookups/locations').then(({ data }) => setLocations(data));
  }, []);

  function currentParams() {
    const params = {};
    if (period === 'period_from') { params.from = dateFrom; params.to = date; }
    else { params.to = date; } // "As of": everything up to the date
    return params;
  }

  // The period plus the Item / Location filters -- what both Generate and Extract send.
  function reportParams() {
    const params = currentParams();
    if (item) params.item_id = item.id;
    if (location) params.location_id = location.id;
    return params;
  }

  // Extract: the whole report under the filters above, as a workbook (same params as Generate).
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  async function runExport() {
    setExporting(true); setExportError('');
    try {
      const { data } = await api.get('/stock-ledger-reports/export', { params: reportParams(), responseType: 'blob' });
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url; a.download = 'stock-ledger.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setExportError('Could not extract the stock ledger.');
    } finally {
      setExporting(false);
    }
  }

  async function generate() {
    setLoading(true);
    setOpenCell(null);
    setMovements({});
    const params = reportParams();
    const { data } = await api.get('/stock-ledger-reports', { params });
    setRows(data);
    setShownPeriod(currentParams());
    setPage(1);
    setLoading(false);
  }

  // Expand a Location row into the documents that produced its Input and Output.
  async function toggleCell(r) {
    const key = `${r.inventory_id}-${r.location_id}`;
    if (openCell === key) { setOpenCell(null); return; }
    setOpenCell(key);
    if (movements[key]) return;
    setMovements((m) => ({ ...m, [key]: 'loading' }));
    try {
      const { data } = await api.get('/stock-ledger-reports/movements', {
        params: { ...(shownPeriod || {}), item_id: r.inventory_id, location_id: r.location_id },
      });
      setMovements((m) => ({ ...m, [key]: data }));
    } catch {
      setMovements((m) => ({ ...m, [key]: [] }));
    }
  }

  // Group flat rows by item for the header-row + location-sub-rows layout.
  const grouped = [];
  if (rows) {
    const byItem = new Map();
    for (const r of rows) {
      if (!byItem.has(r.inventory_id)) byItem.set(r.inventory_id, { item_code: r.item_code, unit_title: r.unit_title, locations: [] });
      // Items with no inventory_locations row yet (never had a stock count entered)
      // come back with a null location_id from the LEFT JOIN -- skip those instead of
      // rendering a confusing blank sub-row; the item header row alone is enough.
      if (r.location_id) byItem.get(r.inventory_id).locations.push(r);
    }
    grouped.push(...byItem.values());
  }

  const totalPages = Math.max(1, Math.ceil(grouped.length / PAGE_SIZE));
  const pageGroups = grouped.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <div className="page-header">
        <h1>Stock Ledger</h1>
        <button className="btn btn-sm" onClick={() => setShowFilters((s) => !s)}>Toggle Filter</button>
      </div>

      {showFilters && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="filter-grid">
            <div className="field">
              <label>Item:</label>
              <EntityPicker
                label="Item" items={inventoryItems} value={item?.id || ''} getLabel={(i) => i.display_name}
                columns={[{ key: 'item_code', label: 'Code' }, { key: 'display_name', label: 'Name' }]}
                searchKeys={['item_code', 'display_name']}
                placeholder="--ALL--"
                onSelect={(i) => setItem(i)}
              />
            </div>
            <div className="field">
              <label>Location:</label>
              <EntityPicker
                label="Location" items={locations} value={location?.id || ''} getLabel={(l) => l.location_name}
                columns={[{ key: 'location_name', label: 'Name' }, { key: 'location_code', label: 'Code' }]}
                searchKeys={['location_name', 'location_code']}
                placeholder="--ALL--"
                onSelect={(l) => setLocation(l)}
              />
            </div>
            <div className="field">
              <label>Period:</label>
              <select value={period} onChange={(e) => setPeriod(e.target.value)}>
                <option value="as_of">As of</option>
                <option value="period_from">Period from</option>
              </select>
            </div>
            {period === 'as_of' ? (
              <div className="field">
                <label>Date</label>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
            ) : (
              <>
                <div className="field">
                  <label>From</label>
                  <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
                </div>
                <div className="field">
                  <label>To</label>
                  <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </div>
              </>
            )}
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={generate}>
              Generate
            </button>
            <button className="btn" disabled={exporting} onClick={runExport} title="Download the whole stock ledger under the filters above">
              {exporting ? 'Extracting...' : 'Extract'}
            </button>
            {exportError && <span style={{ color: 'var(--danger)' }}>{exportError}</span>}
          </div>
        </div>
      )}

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Item Code</th>
                  <th>Location</th>
                  <th>Unit Title</th>
                  <th>Beg. Inv. Qty On-hand</th>
                  <th>Beg. Ave. Cost</th>
                  <th>Beg. Inv. On-hand Value</th>
                  <th>Input</th>
                  <th>Value of Inputs</th>
                  <th>Output</th>
                  <th>Value of Outputs</th>
                  <th>Ending Inv. Qty On-hand (Stock Unit)</th>
                  <th>Ending Inv. Qty On-hand (Base Unit)</th>
                  <th>Ending Ave. Cost</th>
                  <th>Ending Inv On-hand Value</th>
                </tr>
              </thead>
              <tbody>
                {rows === null && (
                  <tr><td colSpan={14} className="muted" style={{ textAlign: 'center', padding: 20 }}>Set your filters and click Generate.</td></tr>
                )}
                {rows !== null && grouped.length === 0 && (
                  <tr><td colSpan={14} className="muted" style={{ textAlign: 'center', padding: 20 }}>No stock ledger data found.</td></tr>
                )}
                {pageGroups.map((g) => (
                  <Fragment key={g.item_code}>
                    <tr>
                      <td><strong>{g.item_code}</strong></td>
                      <td></td>
                      <td>{g.unit_title}</td>
                      <td colSpan={11}></td>
                    </tr>
                    {g.locations.map((r) => {
                      const key = `${r.inventory_id}-${r.location_id}`;
                      const open = openCell === key;
                      const detail = movements[key];
                      return (
                        <Fragment key={key}>
                          <tr
                            onClick={() => toggleCell(r)}
                            style={{ cursor: 'pointer' }}
                            title="Show the documents behind these figures"
                          >
                            <td></td>
                            <td>{open ? '▾ ' : '▸ '}{r.location_name}</td>
                            <td></td>
                            <td>{qtyFmt(r.beg_qty)}</td>
                            <td>{moneyFmt(r.beg_cost)}</td>
                            <td>{moneyFmt(r.beg_value)}</td>
                            {/* Input / Output to 4 places like the other quantities (2026-11-13): Output read
                                1.134965625 beside an Ending of 1.3650, so Beg. + Input looked short of
                                Output + Ending by the rounding alone. */}
                            <td>{Number(r.input) ? qtyFmt(r.input) : ''}</td>
                            <td>{r.value_of_inputs ? moneyFmt(r.value_of_inputs) : ''}</td>
                            <td>{Number(r.output) ? qtyFmt(r.output) : ''}</td>
                            <td>{r.value_of_outputs ? moneyFmt(r.value_of_outputs) : ''}</td>
                            <td>{qtyFmt(r.ending_qty)} {r.stock_unit_code && <span className="muted">{r.stock_unit_code}</span>}</td>
                            <td>{qtyFmt(r.ending_qty_base)} {r.base_unit_code && <span className="muted">{r.base_unit_code}</span>}</td>
                            <td>{moneyFmt(r.ending_cost)}</td>
                            <td>{moneyFmt(r.ending_value)}</td>
                          </tr>
                          {open && (
                            <tr>
                              <td colSpan={14} style={{ padding: '8px 24px', background: 'rgba(127,127,127,0.06)' }}>
                                {detail === 'loading' && <span className="muted">Loading movements...</span>}
                                {detail !== 'loading' && (!detail || detail.length === 0) && (
                                  <span className="muted">No movements in this period. The Beginning balance is the opening figure carried forward.</span>
                                )}
                                {detail !== 'loading' && detail && detail.length > 0 && (
                                  <table style={{ width: 'auto', minWidth: 520 }}>
                                    <thead>
                                      <tr>
                                        <th>Date</th><th>Source</th><th>Document</th>
                                        <th style={{ textAlign: 'right' }}>In</th>
                                        <th style={{ textAlign: 'right' }}>Out</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {detail.map((m, i) => (
                                        <tr key={`${m.source}-${m.doc_id}-${i}`}>
                                          <td>{String(m.move_date || '').slice(0, 10)}</td>
                                          <td>{m.source}</td>
                                          <td>{m.doc_no}</td>
                                          <td style={{ textAlign: 'right' }}>{m.direction === 'in' ? qtyFmt(m.qty) : ''}</td>
                                          <td style={{ textAlign: 'right' }}>{m.direction === 'out' ? qtyFmt(m.qty) : ''}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} totalPages={totalPages} onChange={setPage} />
      </div>
    </div>
  );
}
