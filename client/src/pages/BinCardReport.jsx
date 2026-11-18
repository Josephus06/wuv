import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import EntityPicker from '../components/EntityPicker';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import { useItemBalances, balanceColumns } from '../utils/itemBalances';
import { displayDate } from '../utils/dates';

const PAGE_SIZE = 20;

function qtyFmt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : '';
}
function moneyFmt(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}

// Ref # opens the record it names (2026-11-11): the PO behind a Receiving Report / Vendor Return,
// the Transfer Order behind an Item Fulfillment / Item Receipt, the JO behind an Assembly Build,
// the requisition behind an Office Supply Fulfillment.
const REF_PATH = {
  'Receiving Report': '/purchase-orders/',
  'Vendor Return': '/purchase-orders/',
  'Item Fulfillment': '/transfer-orders/',
  'Item Receipt': '/transfer-orders/',
  'Assembly Build': '/job-orders/',
  'Office Supply Fulfillment': '/office-supply-requisitions/',
};
function refCell(r) {
  if (!r.ref_no) return '—';
  const base = REF_PATH[r.trans_type];
  return base && r.ref_id ? <Link className="link-btn" to={`${base}${r.ref_id}`}>{r.ref_no}</Link> : r.ref_no;
}

function formatDate(v) { return v ? displayDate(String(v).slice(0, 10)) : ''; }

// Mirrors the real "Bin Card" report -- a chronological, per-Item (+ optional
// per-Location) transaction ledger with a running Balance, distinct from Stock Ledger's
// Beginning/Input/Output *summary*. Every action in this build that actually moves
// inventory_locations.qty_on_hand shows up here as its own Trans # row (Receiving
// Report, Vendor Return, Item Fulfillment, Item Receipt, Assembly Build, Inventory
// Adjustment), so the running Balance always reconciles with the live on-hand snapshot.
export default function BinCardReport() {
  const [showFilters, setShowFilters] = useState(true);
  const [item, setItem] = useState(null);
  const [location, setLocation] = useState(null);
  const [period, setPeriod] = useState('as_of');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  // Period From: hides the rows before it without changing any balance -- the server computes the
  // whole card first and shows what the hidden rows leave behind as a Balance Forward row.
  const [dateFrom, setDateFrom] = useState('');

  const [inventoryItems, setInventoryItems] = useState([]);
  const [locations, setLocations] = useState([]);
  const [rows, setRows] = useState(null);
  const [unitLabels, setUnitLabels] = useState({ stock_unit_label: 'Stock Unit', base_unit_label: 'Base Unit', base_unit_code: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState(null);

  useEffect(() => {
    // include_inactive: a discontinued item still has stock on a shelf and a history worth
    // reading. This is a report, not a form -- hiding it here would hide real stock.
    api.get('/inventory', { params: { include_inactive: 1 } }).then(({ data }) => setInventoryItems(data));
    api.get('/lookups/locations').then(({ data }) => setLocations(data));
  }, []);

  // The balances in the picker are for the location the report is set to, and for Warehouse -
  // Central when it has not been set -- the warehouse nearly everything moves through, and the
  // one the person opening this report is almost always asking about. The column headers name
  // whichever it is, so the figure is never unattributed.
  const balanceLocation = location
    || locations.find((l) => String(l.location_name || '').trim().toLowerCase() === 'warehouse - central')
    || null;

  const { balances: pickerBalances, load: loadPickerBalances } = useItemBalances(balanceLocation?.id ?? null);

  // The filters, shared by Generate and Extract so the file holds exactly the card on screen.
  function cardParams() {
    const params = { item_id: item.id };
    if (location) params.location_id = location.id;
    if (period === 'as_of') {
      params.as_of = date;
      if (dateFrom) params.date_from = dateFrom;
    }
    return params;
  }

  // Extract: every row of the card under the filters above (all pages), as a workbook.
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  async function runExport() {
    setExportError('');
    if (!item) { setExportError('Select an Item.'); return; }
    setExporting(true);
    try {
      const { data } = await api.get('/bin-card-reports/export', { params: cardParams(), responseType: 'blob' });
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url; a.download = 'bin-card.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setExportError('Could not extract the bin card.');
    } finally {
      setExporting(false);
    }
  }

  async function generate() {
    setError('');
    if (!item) { setError('Select an Item.'); return; }
    setLoading(true);
    const params = cardParams();
    try {
      const { data } = await api.get('/bin-card-reports', { params });
      setRows(data.rows);
      setUnitLabels({
        stock_unit_label: data.stock_unit_label,
        base_unit_label: data.base_unit_label,
        base_unit_code: data.base_unit_code,
      });
      setMeta({
        reconciled: data.reconciled,
        opening_at: data.opening_at,
        window_from: data.window_from,
        opening_balance_base: data.opening_balance_base,
        opening_balance_stock: data.opening_balance_stock,
      });
      setPage(1);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to generate report');
    } finally {
      setLoading(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil((rows?.length || 0) / PAGE_SIZE));
  const pageRows = rows ? rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : [];
  // The unit the source document recorded. A movement already scaled to Base Unit carries no uom
  // of its own, so the item's base unit is shown.
  const baseUom = unitLabels.base_unit_code || unitLabels.base_unit_label || '—';
  // The unit of the Qty In/Out beside it -- the unit the source document was written in, which the
  // server works out per row. An adjustment entered as 2 SHT reads "2 ... SHT" here and still moves
  // the balances by 2 SHT and 64 SQFT, because the balance columns stay in Base Unit.
  const rowUom = (r) => r.doc_uom || r.uom || baseUom;
  // The server decides this, using the same helper the ledger converts by (stockLedger.js
  // `unitIsConvertible`). Comparing unit spellings here is what produced the false alarm: the
  // check was against the base CODE alone, so "Square Foot" against a base of SQFT -- the same
  // unit spelled out -- and the MM/IN that job-order lines carry as their length/width unit were
  // all reported as unreliable while the ledger was converting them correctly.
  //
  // A row is only a problem now when it is in some other unit AND the item has no conversion
  // factor to bring it across, which is the one case where the quantity really does land in the
  // balance unconverted.
  // Beginning Balance and Balance Forward rows are balances, not movements.
  const isBalanceRow = (r) => r.is_opening || r.is_balance_forward;
  const mismatched = (r) => !isBalanceRow(r) && !!r.uom && r.uom_convertible === false;
  const mismatchCount = (rows || []).filter(mismatched).length;

  return (
    <div>
      <div className="page-header">
        <h1>Bin Card</h1>
        <button className="btn btn-sm" onClick={() => setShowFilters((s) => !s)}>Toggle Filter</button>
      </div>

      {showFilters && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="filter-grid">
            <div className="field">
              <label>Item:</label>
              <EntityPicker
                label="Item" items={inventoryItems} value={item?.id || ''} getLabel={(i) => i.display_name}
                columns={[
                  { key: 'item_code', label: 'Code' },
                  { key: 'display_name', label: 'Name' },
                  ...balanceColumns(pickerBalances, balanceLocation?.location_name),
                ]}
                searchKeys={['item_code', 'display_name']}
                onSelect={(i) => setItem(i)}
                onVisibleItems={loadPickerBalances}
              />
            </div>
            <div className="field">
              <label>Unit Title:</label>
              <input value={item?.base_unit_title || ''} disabled />
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
                <option value="all">All dates</option>
              </select>
            </div>
            {period === 'as_of' && (
              <div className="field">
                <label>Period From</label>
                <input type="date" value={dateFrom} max={date || undefined} onChange={(e) => setDateFrom(e.target.value)} />
              </div>
            )}
            {period === 'as_of' && (
              <div className="field">
                <label>Date</label>
                <input type="date" value={date} min={dateFrom || undefined} onChange={(e) => setDate(e.target.value)} />
              </div>
            )}
          </div>
          {/* The "Full history" switch that used to sit here is gone. It replayed this database's
              own movements from zero, ignoring the opening balance -- which on an item whose stock
              predates the migration runs the card NEGATIVE while the source system shows a healthy
              bin (SINTRABOARD WHITE 3MM read -17 SHT against the source's 11, a constant 28-sheet
              offset through every row). Both numbers were honest answers to different questions,
              but only one of them is the question a bin card is opened to ask, and the other was a
              switch away. Reconciling the migration itself is src/db/compare-stock-asof.js. */}
          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={generate} disabled={loading}>
              Generate
            </button>
            <button className="btn" disabled={exporting} onClick={runExport} title="Download every row of the bin card under the filters above">
              {exporting ? 'Extracting...' : 'Extract'}
            </button>
            {exportError && <span style={{ color: 'var(--danger)' }}>{exportError}</span>}
          </div>
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      {/* Which of the two ledgers this is. The anchored view is the only one that can be ASKED
          for now, but it is not always available: an install with no imported Beginning Balance,
          or a date earlier than the one that balance was struck for, still falls back to replaying
          what this database holds -- and that has to say so, or it looks like the stock figure is
          simply wrong. */}
      {meta && (
        <div className="muted" style={{ marginBottom: 8, fontSize: 13 }}>
          {meta.reconciled
            ? `Opened from the source system's Beginning Balance as at ${meta.opening_at || meta.window_from}. Movements after that date are added to it; balances before it are derived by running back out of it.`
            : 'No Beginning Balance covers this date, so this is every movement this database holds, run from zero. It does not reconcile with stock on hand.'}
        </div>
      )}

      {/* A running balance that adds rolls to square feet is not a balance. Say so plainly rather
          than letting the reader trust the last row -- but only when it is actually true. The
          ledger converts a stock unit into the base unit using the item's conversion factor, so
          the movements that remain a problem are the ones it has no factor to convert WITH. */}
      {mismatchCount > 0 && (
        <div className="error-banner" style={{ marginBottom: 8 }}>
          {mismatchCount} of these movements {mismatchCount === 1 ? 'was' : 'were'} recorded in a
          unit other than {baseUom} (marked in the UOM column), and this item has no conversion
          factor to bring {mismatchCount === 1 ? 'it' : 'them'} across, so
          {mismatchCount === 1 ? ' it is' : ' they are'} added into the balance unconverted. Set the
          item&apos;s conversion factor to correct the Balance columns below.
        </div>
      )}

      <div className="card">
        {loading ? <LoadingSpinner /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Trans. #</th>
                  <th>Ref. #</th>
                  <th>Withdraw From</th>
                  <th>Transfer To</th>
                  <th>Qty In</th>
                  <th>Qty Out</th>
                  <th>UOM</th>
                  <th>Rate</th>
                  <th>Balance(Stock Unit / {unitLabels.stock_unit_label})</th>
                  <th>Balance(Base Unit / {unitLabels.base_unit_label})</th>
                </tr>
              </thead>
              <tbody>
                {rows === null && (
                  <tr><td colSpan={11} className="muted" style={{ textAlign: 'center', padding: 20 }}>Select an Item and click Generate.</td></tr>
                )}
                {rows !== null && rows.length === 0 && (
                  <tr><td colSpan={11} className="muted" style={{ textAlign: 'center', padding: 20 }}>No transactions found.</td></tr>
                )}
                {pageRows.map((r, idx) => (
                  <tr key={idx} style={isBalanceRow(r) ? { fontWeight: 600 } : undefined}>
                    <td>{formatDate(r.trans_date)}</td>
                    <td>{isBalanceRow(r) ? <span className="muted">{r.is_balance_forward ? 'Balance Forward' : 'Beginning Balance'}</span> : r.trans_no}</td>
                    <td>{refCell(r)}</td>
                    <td>{r.from_location_name || ''}</td>
                    <td>{r.to_location_name || ''}</td>
                    {/* The quantity as the document recorded it, not as it was converted: an
                        adjustment of 2 sheets reads 2, beside a UOM of SHT, while the balance
                        columns move by the 64 square feet that is. Falls back to the Base Unit
                        figure on a row with no document unit of its own. */}
                    <td>{Number(r.qty_in) ? qtyFmt(r.doc_qty_in ?? r.qty_in) : ''}</td>
                    <td>{Number(r.qty_out) ? qtyFmt(r.doc_qty_out ?? r.qty_out) : ''}</td>
                    {/* The unit the source document recorded, shown for every row so the reader
                        can see where each quantity came from -- "2.0000 ROLL" converted into a
                        balance kept in SQFT. Only the rows that could NOT be converted are marked;
                        a converted one is not an error and is no longer coloured like one. */}
                    <td style={mismatched(r) ? { color: '#b45309', fontWeight: 600 } : undefined}>
                      {isBalanceRow(r) ? '' : rowUom(r)}
                      {mismatched(r) && (
                        <span title={`Recorded in ${r.uom}, but this item has no conversion factor, so it goes into the ${baseUom} balance unconverted.`}> !</span>
                      )}
                    </td>
                    <td>{moneyFmt(r.rate)}</td>
                    <td>{qtyFmt(r.balance_stock)}</td>
                    <td>{qtyFmt(r.balance_base)}</td>
                  </tr>
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
