// POS shift sales -> Sales Invoice (Sales Invoices > Import POS Sales), the way the company records
// them in Odoo.
//
// ONE SHIFT = ONE INVOICE. The POS "CATEGORY SALES" report (lib/posCategorySales.js) is the invoice:
// one line per item it lists, under the POS category it was sold in, at the price it was sold for --
// the zero-priced lines too (DETERGENT 50ML, PLASTIC ... used up by a full-service load), because
// they still take stock off the shelf. Revenue goes to each item's own income account, which is what
// the Odoo invoices show (30110 Laundry, 30120 Water, 30130 Product Sales).
//
// THE SAME SHIFT'S Z-READING PAYS IT. Uploaded alongside, it is matched by counter / shift / close time
// (the Category Sales "880/FIRSTSHIFT" and the Z-Reading "Z:880/FIRSTSHIFT" are the same shift), and its
// CASH PAYMENT and OTHER PAYMENT (GCash) become Customer Payments applied to the invoice -- cash waiting
// in Undeposited Funds for the Bank Deposit. Whatever was not paid stays as the invoice's balance.
//
// STOCK AND COST. A line for a stocked item (type Inventory / JIT) leaves the branch's stock
// (lib/stockLedger.js) and posts its cost -- the item's average cost at the time, frozen on the line --
// as Dr cost of sales / Cr inventory (lib/glImpact.js computeSalesInvoiceGl). Services move nothing.
//
// NEW ITEMS ARE CREATED. A POS item no item in Master Lists matches (by name or code) is created on
// import, set up from its POS category (pos_category_accounts: type and income / inventory / cost
// accounts) -- except that a zero-priced line under a service category is a consumable the service
// uses up (DETERGENT 50ML, PLASTIC, CAPSEAL), so it is created as a stocked item, unless its name says
// it is a service itself ("40 MINS DRY").
//
// It REPLACES the Z-Reading Sales Order for the shift: a shift already imported as a counter-sales
// Sales Order is refused here, and routes/salesOrders.js refuses a Z-Reading whose shift is already
// invoiced -- either way, a shift's sales are booked once.
const { parseCategorySales } = require('./posCategorySales');
const { parseZReading } = require('./posZReading');
const { isNonStockItem } = require('./itemTypes');
const { assignDocNo } = require('./docNumber');

const round2 = (n) => Number((Number(n) || 0).toFixed(2));
const norm = (s) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
// The PDF wraps long names wherever the line ran out ("ALL ITEMS / CLOTHING 1-\n5KG", "THI\nCK
// BLANKETS"), so names are matched with every space removed -- and a new item's name has the obvious
// hyphen breaks ("1- 5KG") repaired. A break inside a word cannot be told from a real space; such a name can
// be corrected once in Master Lists and keeps matching afterwards.
const matchKey = (s) => norm(s).replace(/ /g, '');
const tidyName = (s) => norm(s).replace(/(\w)- (?=\w)/g, '$1-');
const SERVICE_NAME = /\b(MINS?|MINUTES?|HRS?|HOURS?|DRY|WASH|SERVICE|REFILL)\b/i;

// The shift a report is for, the same for both documents: "880/FIRSTSHIFT|2026-10-01 19:55".
const shiftKeyOf = (parsed) => (parsed && parsed.import_key ? String(parsed.import_key).replace(/^Z:/, '') : null);

// What a PDF's text is, read by the parser for it.
function readReport(text) {
  if (/CATEGORY\s+SALES/i.test(text)) return { kind: 'category', parsed: parseCategorySales(text) };
  if (/Z\s*READING/i.test(text)) return { kind: 'z', parsed: parseZReading(text) };
  return { kind: 'unknown', parsed: { ok: false, errors: ['Not a CATEGORY SALES or Z READING report.'] } };
}

// How an item first met under `category` is set up (pos_category_accounts), plus the zero-price rule.
function newItemSetup(categoryRow, line) {
  let type = (categoryRow && categoryRow.item_type) || 'Service';
  if (isNonStockItem(type) && !Number(line.unit_price) && !SERVICE_NAME.test(line.description)) type = 'Inventory';
  return {
    item_type: type,
    income_account_id: categoryRow ? (categoryRow.item_income_account_id || categoryRow.account_id) : null,
    asset_account_id: isNonStockItem(type) ? null : (categoryRow ? categoryRow.asset_account_id : null),
    cogs_account_id: isNonStockItem(type) ? null : (categoryRow ? categoryRow.cogs_account_id : null),
  };
}

// Every active item, by normalised name and by normalised code.
async function itemIndex(db) {
  const [items] = await db.query(
    `SELECT id, item_code, display_name, item_type, average_cost, last_purchase_price,
            income_account_id, asset_account_id, cogs_account_id
       FROM inventories WHERE is_active = 1`);
  const byKey = new Map();
  for (const i of items) {
    for (const k of [matchKey(i.display_name), matchKey(i.item_code)]) if (k && !byKey.has(k)) byKey.set(k, i);
  }
  return byKey;
}

async function categoryIndex(db) {
  const [rows] = await db.query('SELECT category_name, account_id, item_income_account_id, item_type, asset_account_id, cogs_account_id FROM pos_category_accounts');
  return new Map(rows.map((r) => [norm(r.category_name), r]));
}

// The cost a stocked item is taken out at: its average cost, else its last purchase price.
const unitCostOf = (item) => (item && !isNonStockItem(item.item_type)
  ? Number(item.average_cost) || Number(item.last_purchase_price) || 0 : 0);

// Pairs the parsed reports into shifts and works out everything the preview shows.
async function buildShifts(db, reports) {
  const items = await itemIndex(db);
  const categories = await categoryIndex(db);
  const byKey = new Map();
  const problems = [];
  for (const r of reports) {
    if (!r.parsed.ok) { problems.push({ source_file: r.source_file, errors: r.parsed.errors || ['Could not be read.'] }); continue; }
    if (r.kind === 'unknown') { problems.push({ source_file: r.source_file, errors: r.parsed.errors }); continue; }
    const key = shiftKeyOf(r.parsed);
    if (!byKey.has(key)) byKey.set(key, { key });
    const s = byKey.get(key);
    // A day off the salons' daily-summary workbook (lib/posDailySummary.js) is its own invoice source
    // and carries its own payment -- no Z-Reading to pair it with.
    if (r.kind === 'daily') {
      if (s.category) { problems.push({ source_file: r.source_file, errors: [`${key} appears twice -- only one row per branch and day.`] }); continue; }
      s.category = r.parsed;
      s.category_file = r.source_file;
      s.daily_payment = r.parsed.payment;
      continue;
    }
    if (s[r.kind]) { problems.push({ source_file: r.source_file, errors: [`A second ${r.kind === 'z' ? 'Z-Reading' : 'Category Sales'} report for shift ${key} -- only one of each per shift.`] }); continue; }
    s[r.kind] = r.parsed;
    s[`${r.kind}_file`] = r.source_file;
  }

  const shifts = [];
  for (const s of byKey.values()) {
    const warnings = [];
    const errors = [];
    if (!s.category) {
      errors.push('No Category Sales report for this shift -- the invoice is made from it. Upload it with the Z-Reading.');
      shifts.push({ key: s.key, ok: false, errors, z_file: s.z_file });
      continue;
    }
    const c = s.category;
    const lines = [];
    const created = new Map();
    for (const cat of c.categories) {
      const catRow = categories.get(norm(cat.name)) || null;
      if (!catRow) warnings.push(`POS category ${cat.name} has no account set up -- its new items post to Sales (30100).`);
      for (const it of cat.items) {
        const name = matchKey(it.description);
        const item = items.get(name) || null;
        const line = { pos_category: cat.name, description: it.description, quantity: it.quantity, unit_price: it.unit_price, amount: it.amount };
        if (item) {
          lines.push({ ...line, item_id: item.id, item_code: item.item_code, item_type: item.item_type, unit_cost: unitCostOf(item) });
        } else {
          const setup = newItemSetup(catRow, it);
          if (!created.has(name)) created.set(name, { display_name: tidyName(it.description), pos_category: cat.name, ...setup });
          lines.push({ ...line, item_id: null, new_item: true, item_type: setup.item_type, unit_cost: 0 });
        }
      }
    }
    const total = round2(lines.reduce((t, l) => t + Number(l.amount || 0), 0));
    if (Math.abs(total - Number(c.total_amount)) > 0.01) {
      errors.push(`The lines add up to ${total.toFixed(2)}, the report's TOTAL AMOUNT says ${Number(c.total_amount).toFixed(2)} -- the report was misread.`);
    }
    const noCost = lines.filter((l) => l.item_id && !isNonStockItem(l.item_type) && !l.unit_cost).map((l) => l.description);
    if (noCost.length) warnings.push(`No cost on file for ${[...new Set(noCost)].join(', ')} -- they leave stock at 0.00 cost.`);

    let payment = null;
    if (s.daily_payment) {
      // The salons' daily sheet makes the invoice only: it is left Open, and the money is recorded
      // with Pay on the invoice (asked 2026-11-20 -- "make the status open since no payment created").
      // No payments and no cash short / over journal are made from the sheet any more.
      const p = s.daily_payment;
      warnings.push(`Left open: record the day's ${[p.cash ? `cash ${p.cash.toFixed(2)}` : '', p.gcash ? `GCash ${p.gcash.toFixed(2)}` : '', p.gc_used ? `gift certificates ${p.gc_used.toFixed(2)}` : ''].filter(Boolean).join(', ') || 'payments'} with Pay on the invoice.`);
    } else if (s.z) {
      // The Z-Reading's amounts are under .figures (lib/posZReading.js).
      const z = s.z.figures || {};
      const cash = round2(z.cash_payment);
      const gcash = round2(Number(z.other_payment || 0) + Number(z.credit_card || 0) + Number(z.debit_card || 0));
      const applied = Math.min(round2(cash + gcash), total);
      payment = { cash, gcash, applied, unpaid: round2(total - applied), net_sales: round2(z.net_sales) };
      if (Math.abs(round2(z.net_sales) - total) > 0.01) {
        warnings.push(`The Z-Reading's NET SALES is ${round2(z.net_sales).toFixed(2)}; the Category Sales total is ${total.toFixed(2)}.`);
      }
      if (round2(cash + gcash) > total + 0.005) {
        warnings.push(`${round2(cash + gcash - total).toFixed(2)} more was collected than this shift's sales (collections of earlier credit) -- record that as its own Customer Payment.`);
      }
    } else {
      warnings.push('No Z-Reading for this shift -- the invoice is made but left unpaid. Upload the Z-Reading with it to record the cash and GCash.');
    }

    // Already booked? As an invoice (this import) or as a Z-Reading counter-sales Sales Order.
    const [[inv]] = await db.query('SELECT id, invoice_no FROM sales_invoices WHERE pos_import_key = ?', [s.key]);
    const [[so]] = await db.query(
      `SELECT so.id, so.sales_order_no FROM sales_order_lines sol JOIN sales_orders so ON so.id = sol.sales_order_id
        WHERE sol.pos_import_key = ? AND so.status <> 'cancelled' LIMIT 1`, [`Z:${s.key}`]);
    if (inv) errors.push(`Already imported as ${inv.invoice_no}.`);
    if (so) errors.push(`Already recorded as counter-sales Sales Order ${so.sales_order_no} -- cancel it first, or this shift's sales are booked twice.`);

    shifts.push({
      key: s.key, ok: !errors.length, errors, warnings, daily: !!s.daily_payment,
      store: c.store_name, shift: c.shift, branch_code: c.branch_code,
      date: c.closed_date, closed_by: c.closed_by,
      category_file: s.category_file, z_file: s.z_file || null,
      total, lines, new_items: [...created.values()], payment,
      existing_invoice: inv || null,
    });
  }
  return { shifts, problems };
}

// Creates the items a shift needs that do not exist yet. Returns normalised name -> item.
async function createMissingItems(conn, shift, userId) {
  const items = await itemIndex(conn);
  const [[unit]] = await conn.query("SELECT id FROM units_of_measure WHERE code IN ('PC', 'PCS') ORDER BY code LIMIT 1");
  const [[anyUnit]] = await conn.query('SELECT id FROM units_of_measure ORDER BY id LIMIT 1');
  const unitId = unit ? unit.id : anyUnit ? anyUnit.id : null;
  if (!unitId) throw Object.assign(new Error('Set up at least one Unit of Measure before importing POS sales.'), { status: 400 });
  for (const n of shift.new_items) {
    const key = matchKey(n.display_name);
    if (items.has(key)) continue;
    // A code from the name, kept unique: "ARIEL SUNRISE" -> "POS-ARIEL-SUNRISE".
    const base = `POS-${key.replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`.slice(0, 90);
    let code = base;
    for (let i = 2; ; i += 1) {
      const [[dup]] = await conn.query('SELECT id FROM inventories WHERE item_code = ?', [code]);
      if (!dup) break;
      code = `${base}-${i}`;
    }
    const [r] = await conn.query(
      `INSERT INTO inventories (item_code, display_name, sales_description, base_unit_id, item_type, is_active,
                                income_account_id, asset_account_id, cogs_account_id, is_costing_approved, is_accounting_approved)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, FALSE, FALSE)`,
      [code, n.display_name, `Created from the POS (${n.pos_category})`, unitId, n.item_type,
        n.income_account_id || null, n.asset_account_id || null, n.cogs_account_id || null]);
    await conn.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, new_value, set_by_user_id)
       VALUES ('Inventory', ?, 'Created', 'item_code', ?, ?)`, [r.insertId, `${code} (POS import)`, userId]).catch(() => {});
    items.set(key, { id: r.insertId, item_code: code, display_name: n.display_name, item_type: n.item_type, average_cost: 0, last_purchase_price: 0 });
  }
  return items;
}

// One shift -> invoice (+ payments). Runs inside the caller's transaction on `conn`.
async function importShift(conn, shift, { customerId, locationId, departmentId, userId, salesRepId }) {
  const items = await createMissingItems(conn, shift, userId);
  const lines = shift.lines.map((l) => {
    const item = items.get(matchKey(l.description));
    const unitCost = unitCostOf(item);
    return {
      ...l, item_id: item.id,
      unit_cost: unitCost || null,
      cost_amount: unitCost ? round2(unitCost * Number(l.quantity)) : null,
      net: round2(l.amount),
    };
  });
  const total = round2(lines.reduce((t, l) => t + l.net, 0));
  const memo = shift.daily
    ? `Daily sales -- ${shift.store || shift.branch_code} (${shift.date}), from the daily sales sheet`
    : `POS shift ${shift.branch_code}/${shift.shift} -- ${shift.store || ''} (closed ${shift.date}${shift.closed_by ? ` by ${shift.closed_by}` : ''})`;
  const [r] = await conn.query(
    `INSERT INTO sales_invoices
       (invoice_no, invoice_type, customer_id, date_created, date_due, office_location_id, department_id, sales_rep_id, memo,
        withholding_tax_pct, subtotal, discount_amount, net_of_tax, ewt_amount, tax_amount, gross_amount, amount_due,
        created_by_user_id, pos_import_key)
     VALUES ('', 'SI', ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, 0, 0, ?, ?, ?, ?)`,
    [customerId, shift.date, shift.date, locationId, departmentId || null, salesRepId || null, memo.slice(0, 1000),
      total, total, total, total, userId, shift.key]);
  const invoiceId = r.insertId;
  const invoiceNo = await assignDocNo(conn, { table: 'sales_invoices', column: 'invoice_no', prefix: 'INV-', id: invoiceId });
  for (const l of lines) {
    await conn.query(
      `INSERT INTO sales_invoice_lines
         (sales_invoice_id, item_id, description, quantity, units, price_per_unit, subtotal, disc_percent, disc_amount,
          disc_price_per_unit, net_of_tax, tax_code, tax_amount, gross_amount, unit_cost, cost_amount, pos_category)
       VALUES (?, ?, ?, ?, NULL, ?, ?, 0, 0, ?, ?, NULL, 0, ?, ?, ?, ?)`,
      [invoiceId, l.item_id, l.description, l.quantity, l.unit_price, l.net, l.unit_price, l.net, l.net,
        l.unit_cost, l.cost_amount, l.pos_category]);
  }
  await conn.query(
    `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, new_value, set_by_user_id)
     VALUES ('SalesInvoice', ?, 'Created', 'invoice_no', ?, ?)`, [invoiceId, `${invoiceNo} (POS shift ${shift.key})`, userId]);

  // Payments, up to the invoice total: gift certificates redeemed first, then GCash, then cash.
  //   GC     paid out of Customer Deposits (23000), where the certificate's money sat since it was sold:
  //          Dr 23000 / Cr A/R. Nothing to bank, so it is not offered to a Bank Deposit.
  //   GCASH / CASH  waiting in Undeposited Funds (10006) for the Bank Deposit.
  const payments = [];
  const source = shift.daily ? 'daily sales sheet' : 'Z-Reading';
  if (shift.payment && total > 0) {
    let left = total;
    const [methods] = await conn.query("SELECT id, name FROM payment_methods WHERE name IN ('CASH', 'GCASH')");
    const methodId = (n) => (methods.find((m) => m.name === n) || {}).id || null;
    const [[giftAcct]] = await conn.query("SELECT id FROM chart_of_accounts WHERE account_code = '23000'");
    const tenders = [['GC', shift.payment.gc_used || 0], ['GCASH', shift.payment.gcash], ['CASH', shift.payment.cash]];
    for (const [method, amt] of tenders) {
      const apply = round2(Math.min(Number(amt) || 0, left));
      if (apply <= 0) continue;
      if (method === 'GC' && !giftAcct) throw Object.assign(new Error('Gift certificates were used but account 23000 Customer Deposits is not in the chart.'), { status: 400 });
      left = round2(left - apply);
      const label = method === 'CASH' ? 'Cash' : method === 'GCASH' ? 'GCash' : 'Gift certificates used';
      const [p] = await conn.query(
        `INSERT INTO customer_payments
           (customer_payment_no, date_created, customer_id, department_id, office_location_id, receipt_type, or_no,
            payment_type, issued_by_user_id, payment_method_id, payment_amount, applied_amount, unapplied_amount, memo,
            created_by_user_id, reference_no, deposit_account_id, status)
         VALUES ('', ?, ?, ?, ?, 'Official Receipt', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        [shift.date, customerId, departmentId || null, locationId, `${shift.daily ? 'DAY' : 'Z'} ${shift.branch_code}`.slice(0, 60),
          left > 0 ? 'Partial Payment' : 'Full Payment', userId, method === 'GC' ? null : methodId(method), apply, apply,
          `${label} from ${source} ${shift.branch_code}${shift.daily ? '' : `/${shift.shift}`} (${shift.date})`, userId,
          method === 'GCASH' ? `${shift.daily ? 'DAY' : 'Z'} ${shift.branch_code}`.slice(0, 60) : null,
          method === 'GC' ? giftAcct.id : null, method === 'GC' ? 'deposited' : 'not_deposited']);
      const paymentNo = await assignDocNo(conn, { table: 'customer_payments', column: 'customer_payment_no', prefix: 'CPAY-', id: p.insertId });
      await conn.query('INSERT INTO customer_payment_lines (customer_payment_id, sales_invoice_id, applied_amount) VALUES (?, ?, ?)', [p.insertId, invoiceId, apply]);
      payments.push({ id: p.insertId, customer_payment_no: paymentNo, method, amount: apply });
    }
    const due = round2(left);
    await conn.query(
      "UPDATE sales_invoices SET amount_due = ?, status = IF(? <= 0.005, 'paid_in_full', status) WHERE id = ?", [due, due, invoiceId]);
  }

  // Cash short / over (the daily sheet's Cash Sales less what was deposited): the cash payment above is
  // what the till should have held, so the difference comes out of Undeposited Funds into Cash Short and
  // Over -- leaving exactly what was handed over to be banked. Short: Dr 30705 / Cr 10006; over: reversed.
  let journal = null;
  const short = round2(shift.payment && shift.payment.short);
  if (short) {
    const [[soAcct]] = await conn.query("SELECT id FROM chart_of_accounts WHERE account_code = '30705'");
    const [[ufAcct]] = await conn.query("SELECT id FROM chart_of_accounts WHERE account_code = '10006'");
    if (!soAcct || !ufAcct) throw Object.assign(new Error('Cash short / over needs accounts 30705 Cash Short and Over and 10006 Undeposited Funds -- run db/add-pos-sales-invoices.js.'), { status: 400 });
    const amt = Math.abs(short);
    const memo = `Cash ${short > 0 ? 'short' : 'over'} ${amt.toFixed(2)} -- ${shift.branch_code} ${shift.date} (${invoiceNo})`;
    const [j] = await conn.query(
      `INSERT INTO journals (journal_no, date_created, location_id, memo, status, total_debit, total_credit, created_by_user_id)
       VALUES ('', ?, ?, ?, 'SAVED', ?, ?, ?)`, [shift.date, locationId, memo, amt, amt, userId]);
    const journalNo = await assignDocNo(conn, { table: 'journals', column: 'journal_no', prefix: 'JRNL-', id: j.insertId });
    const [dr, cr] = short > 0 ? [soAcct.id, ufAcct.id] : [ufAcct.id, soAcct.id];
    await conn.query(
      `INSERT INTO journal_lines (journal_id, line_no, account_id, department_id, debit, credit, memo) VALUES (?, 1, ?, ?, ?, 0, ?), (?, 2, ?, ?, 0, ?, ?)`,
      [j.insertId, dr, departmentId || null, amt, memo, j.insertId, cr, departmentId || null, amt, memo]);
    journal = { id: j.insertId, journal_no: journalNo, amount: short };
  }
  return { id: invoiceId, invoice_no: invoiceNo, total, payments, journal };
}

module.exports = { readReport, buildShifts, importShift, shiftKeyOf };
