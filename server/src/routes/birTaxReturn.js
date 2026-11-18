const express = require('express');
const { companyScopeMiddleware, scopedTable, currentScope } = require('../lib/requestScope');
const ExcelJS = require('exceljs');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { helpers } = require('./birReports');

const { withheldDocs, atcOptions, VAT_CLASS, RETURN_LINE, r2 } = helpers;
const router = express.Router();
// One company's filing (?companyId=, lib/requestScope.js): its branches' documents only.
router.use(companyScopeMiddleware());
const ROUTE = '/reports/bir-tax-return';

// BIR Reports > Tax Return (asked 2026-11-07, after Odoo's Tax Return page): one page, a period, a
// Report switcher, Comparison, PDF and XLSX.
//
//   2550Q (PH)               the quarterly VAT return -- Part II Tax Payable (15-26) and Part IV Details
//                            of VAT Computation (31-59). Lines T1S cannot know (carry-overs, importations,
//                            advance payments, penalties) are entered on the page and flow through.
//   SAWT & QAP (PH)          the alphalists -- QAP what WE withheld from suppliers (the Expanded
//                            Withholding Tax documents), SAWT what customers withheld from US (the
//                            invoices' creditable withholding). Month > payee > document > ATC.
//   Group by Tax > Account,  Net and Tax per tax, by the GL account each line posts to (and the reverse).
//   Account > Tax
//   Generic Tax report       one line per tax: Net and Tax, Sales then Purchases.
//
// Every view is built from ONE set of tax lines for the period (taxLines below), so the views agree with
// each other and with BIR Reports > VAT Computation (same documents, VAT_CLASS, RETURN_LINE, header tax).
//
//   Sales      Sales Invoice lines by their tax code, less returns (Credit Memo lines), and the
//              withholding customers made on the invoices (negative, as Odoo shows it).
//   Purchases  Vendor Bill lines, direct Cheque lines and Bill Credit lines (negative) -- VAT by class:
//              capital goods (posted to a 17xxx fixed-asset account), goods (an item that is not a
//              service), services (a Service item or no item) -- and the withholding on them (negative).
//              A document whose lines' tax does not add up to its header tax gets the difference on its
//              main line, so the totals are the header totals the VAT Computation uses.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT = MONTHS.map((m) => m.slice(0, 3));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const ymd = (d) => d.toISOString().slice(0, 10);
const dayOf = (v) => String(v instanceof Date ? v.toISOString() : v || '').slice(0, 10);
const num = (v) => Number(v) || 0;

function periodLabel(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const lastOfTo = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  if (fd === 1 && td === lastOfTo) {
    if (fy === ty && fm === tm) return `${MONTHS[fm - 1]} ${fy}`;
    if (fy === ty && fm === 1 && tm === 12) return String(fy);
    return fy === ty ? `${SHORT[fm - 1]} - ${SHORT[tm - 1]} ${fy}` : `${SHORT[fm - 1]} ${fy} - ${SHORT[tm - 1]} ${ty}`;
  }
  return `${from} to ${to}`;
}
// The period of the same length right before, or a year earlier.
function shiftPeriod(from, to, how) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const lastOfTo = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  if (how === 'last_year') return { from: `${fy - 1}${from.slice(4)}`, to: ymd(new Date(Date.UTC(ty - 1, tm - 1, Math.min(td, new Date(Date.UTC(ty - 1, tm, 0)).getUTCDate())))) };
  if (fd === 1 && td === lastOfTo) { // whole months: the same number of months before
    const months = (ty - fy) * 12 + (tm - fm) + 1;
    const start = new Date(Date.UTC(fy, fm - 1 - months, 1));
    const end = new Date(Date.UTC(fy, fm - 1, 0));
    return { from: ymd(start), to: ymd(end) };
  }
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  return { from: ymd(new Date(Date.parse(`${from}T00:00:00Z`) - days * 86400000)), to: ymd(new Date(Date.parse(`${from}T00:00:00Z`) - 86400000)) };
}

const SALES_TAX = {
  vatable: { key: 'S-12', label: '12% VAT (Sales)', rate: 12 },
  zero_rated: { key: 'S-ZR', label: '0% VAT Zero-rated (Sales)', rate: 0 },
  exempt: { key: 'S-EX', label: 'VAT Exempt (Sales)', rate: 0 },
  unclassified: { key: 'S-NA', label: 'No tax code (Sales)', rate: 0 },
};
const PURCHASE_TAX = {
  capital: { key: 'P-12-CG', label: '12% VAT Capital Goods (Purchases)', rate: 12 },
  goods: { key: 'P-12-G', label: '12% VAT Goods (Purchases)', rate: 12 },
  services: { key: 'P-12-S', label: '12% VAT Services (Purchases)', rate: 12 },
  none: { key: 'P-0', label: 'No input tax (Purchases)', rate: 0 },
};
const purchaseClass = (taxed, accountCode, itemType, itemId) => {
  if (!taxed) return 'none';
  if (String(accountCode || '').startsWith('17')) return 'capital';
  if (!itemId || /service/i.test(itemType || '')) return 'services';
  return 'goods';
};

// ---------------------------------------------------------------------------------------------------
// The period's tax lines. One row per (document line, tax):
//   { side, doc_type, doc_id, doc_no, date, partner, tin, government, tax_key, tax_label, rate, kind,
//     net, tax, account_code, account_name, atc }
async function taxLines(from, to) {
  const [coaRows] = await pool.query('SELECT account_code, account_name FROM chart_of_accounts');
  const coa = new Map(coaRows.map((a) => [String(a.account_code), a.account_name]));
  const acct = (code) => ({ account_code: code || '', account_name: coa.get(String(code)) || (code ? '' : 'No account') });
  const out = [];

  // ---- Sales: invoice lines
  const [sil] = await pool.query(
    `SELECT si.id AS doc_id, si.invoice_no AS doc_no, si.date_created AS date, c.id AS partner_id, c.name AS partner, c.tin,
            c.customer_type, ${VAT_CLASS('sil.tax_code')} AS cls, sil.net_of_tax AS net, sil.tax_amount AS tax,
            ia.account_code AS income_code
       FROM sales_invoice_lines sil
       JOIN sales_invoices si ON si.id = sil.sales_invoice_id
       LEFT JOIN sales_orders so ON so.id = si.sales_order_id
       LEFT JOIN estimates e ON e.id = si.estimate_id
       LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id
       LEFT JOIN customers c ON c.id = COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id)
       LEFT JOIN inventories inv ON inv.id = sil.item_id
       LEFT JOIN chart_of_accounts ia ON ia.id = inv.income_account_id
      WHERE si.status <> 'cancelled' AND si.date_created BETWEEN ? AND ?`, [from, to]);
  for (const l of sil) {
    const t = SALES_TAX[l.cls] || SALES_TAX.unclassified;
    out.push({
      side: 'sales', doc_type: 'Sales Invoice', doc_id: l.doc_id, doc_no: l.doc_no, date: dayOf(l.date), partner_id: l.partner_id,
      partner: l.partner || '', tin: l.tin || '', government: /gov/i.test(l.customer_type || ''), tax_key: t.key, tax_label: t.label,
      rate: t.rate, kind: 'vat', cls: l.cls, net: num(l.net), tax: num(l.tax), ...acct(l.income_code || '30100'),
    });
  }
  // ---- Sales returns: credit memo lines (as the VAT Computation counts them)
  const [cml] = await pool.query(
    `SELECT cm.id AS doc_id, cm.credit_memo_no AS doc_no, cm.date_created AS date, c.id AS partner_id, c.name AS partner, c.tin, c.customer_type,
            ${VAT_CLASS('cml.tax_code')} AS cls, cml.net_of_tax AS net, cml.tax_amount AS tax
       FROM credit_memo_lines cml JOIN credit_memos cm ON cm.id = cml.credit_memo_id
       LEFT JOIN customers c ON c.id = cm.customer_id
       LEFT JOIN chart_of_accounts a ON a.id = cm.source_account_id
      WHERE cm.voided_at IS NULL AND cm.date_created BETWEEN ? AND ? AND ${RETURN_LINE}`, [from, to]);
  for (const l of cml) {
    const t = SALES_TAX[l.cls] || SALES_TAX.unclassified;
    out.push({
      side: 'sales', doc_type: 'Credit Memo', doc_id: l.doc_id, doc_no: l.doc_no, date: dayOf(l.date), partner_id: l.partner_id,
      partner: l.partner || '', tin: l.tin || '', government: /gov/i.test(l.customer_type || ''), tax_key: t.key, tax_label: t.label,
      rate: t.rate, kind: 'vat', cls: l.cls, net: -num(l.net), tax: -num(l.tax), ...acct('30100'),
    });
  }

  // ---- Sales: withholding customers made on our invoices (SAWT), ATC suggested from the rate
  const options = await atcOptions();
  const [cwt] = await pool.query(
    `SELECT si.id AS doc_id, si.invoice_no AS doc_no, si.date_created AS date, c.id AS partner_id, c.name AS partner, c.tin,
            si.net_of_tax AS base, si.withholding_tax_pct AS pct, si.ewt_amount AS tax
       FROM ${scopedTable('sales_invoices')} si
       LEFT JOIN sales_orders so ON so.id = si.sales_order_id
       LEFT JOIN estimates e ON e.id = si.estimate_id
       LEFT JOIN non_standard_sales_orders ns ON ns.id = si.nsso_id
       LEFT JOIN customers c ON c.id = COALESCE(si.customer_id, so.customer_id, e.customer_id, ns.customer_id)
      WHERE si.status <> 'cancelled' AND si.ewt_amount > 0 AND si.date_created BETWEEN ? AND ?`, [from, to]);
  for (const r of cwt) {
    const base = num(r.base); const tax = num(r.tax);
    const rate = num(r.pct) || (base ? Math.round((tax / base) * 10000) / 100 : 0);
    const guess = options.find((o) => Math.abs(o.rate - rate) <= 0.05 && /^WC/i.test(o.atc)) || options.find((o) => Math.abs(o.rate - rate) <= 0.05);
    const atc = guess ? guess.atc : '';
    out.push({
      side: 'sales', doc_type: 'Sales Invoice', doc_id: r.doc_id, doc_no: r.doc_no, date: dayOf(r.date), partner_id: r.partner_id,
      partner: r.partner || '', tin: r.tin || '', tax_key: `S-W-${atc || rate}`, tax_label: `${rate}% ${atc || 'Withheld by customer'} (Sales)`,
      rate: -rate, kind: 'wht', atc, nature: guess ? guess.nature : '', net: base, tax: -tax, ...acct('14200'),
    });
  }

  // ---- Purchases: vendor bill lines, cheque lines, bill credit lines -- VAT
  const [vbl] = await pool.query(
    `SELECT vb.id AS doc_id, vb.bill_no AS doc_no, vb.date_created AS date, s.id AS partner_id, s.name AS partner, s.tin,
            vb.net_of_tax AS h_net, vb.tax_amount AS h_tax, ha.account_code AS h_code,
            vbl.id AS line_id, vbl.net_of_tax AS net, vbl.tax_amount AS tax, vbl.is_withhold, vbl.wtax_amount,
            la.account_code AS l_code, vbl.item_id, inv.item_type, iaa.account_code AS item_asset_code, iea.account_code AS item_expense_code
       FROM ${scopedTable('vendor_bills')} vb
       LEFT JOIN vendor_bill_lines vbl ON vbl.vendor_bill_id = vb.id
       LEFT JOIN purchase_orders po ON po.id = vb.purchase_order_id
       LEFT JOIN suppliers s ON s.id = COALESCE(po.supplier_id, vb.supplier_id)
       LEFT JOIN chart_of_accounts ha ON ha.id = vb.account_id
       LEFT JOIN chart_of_accounts la ON la.id = vbl.account_id
       LEFT JOIN inventories inv ON inv.id = vbl.item_id
       LEFT JOIN chart_of_accounts iaa ON iaa.id = inv.asset_account_id
       LEFT JOIN chart_of_accounts iea ON iea.id = inv.expense_account_id
      WHERE vb.status <> 'cancelled' AND vb.date_created BETWEEN ? AND ?
      ORDER BY vb.id, vbl.id`, [from, to]);
  // The account a bill line is FOR: its own account when it names one (standalone / non-inventory
  // lines), else its item's -- the inventory (asset) account for stock items, the expense account
  // otherwise. A PO bill posts its inventory lines to the clearing account 20300 Inventory Received Not
  // Billed, which says nothing about what was bought, so it is only the fallback (as is the header's).
  const billAccount = (l) => {
    if (l.l_code) return l.l_code;
    const stock = /^(INVENTORY|JIT)$/i.test(String(l.item_type || ''));
    const item = stock ? (l.item_asset_code || l.item_expense_code) : (l.item_expense_code || l.item_asset_code);
    if (item) return item;
    return ['20100', '20200'].includes(String(l.h_code || '')) || !l.h_code ? '20300' : l.h_code;
  };
  const [chl] = await pool.query(
    `SELECT ch.id AS doc_id, ch.cheque_no AS doc_no, ch.date_created AS date, s.id AS partner_id, COALESCE(s.name, ch.payee_name) AS partner, s.tin,
            ch.net_of_tax AS h_net, ch.tax_amount AS h_tax, NULL AS h_code,
            cl.id AS line_id, cl.amount AS net, cl.tax_amount AS tax, cl.apply_withholding_tax AS is_withhold, cl.withholding_tax_amount AS wtax_amount,
            a.account_code AS l_code, NULL AS item_id, NULL AS item_type
       FROM ${scopedTable('cheques')} ch
       LEFT JOIN cheque_lines cl ON cl.cheque_id = ch.id
       LEFT JOIN chart_of_accounts a ON a.id = cl.account_id
       LEFT JOIN suppliers s ON ch.payee_type IN ('VENDOR', 'supplier') AND s.id = ch.payee_id
      WHERE ch.status <> 'void' AND ch.tax_amount > 0 AND ch.date_created BETWEEN ? AND ?
      ORDER BY ch.id, cl.id`, [from, to]);
  const [bcl] = await pool.query(
    `SELECT bc.id AS doc_id, bc.bill_credit_no AS doc_no, bc.date_created AS date, s.id AS partner_id, s.name AS partner, s.tin,
            bc.subtotal AS h_net, bc.tax_amount AS h_tax, NULL AS h_code,
            l.id AS line_id, l.amount AS net, l.tax_amount AS tax, l.is_withhold, l.wtax_amount,
            a.account_code AS l_code, NULL AS item_id, NULL AS item_type
       FROM ${scopedTable('bill_credits')} bc
       LEFT JOIN bill_credit_lines l ON l.bill_credit_id = bc.id
       LEFT JOIN chart_of_accounts a ON a.id = l.account_id
       LEFT JOIN suppliers s ON s.id = bc.supplier_id
      WHERE bc.status <> 'void' AND bc.tax_amount > 0 AND bc.date_created BETWEEN ? AND ?
      ORDER BY bc.id, l.id`, [from, to]);

  const docLines = new Map(); // "type:id" -> its purchase VAT rows, for spreading its withholding by account
  const addPurchaseDocs = (rows, docType, sign, accountOf) => {
    const byDoc = new Map();
    for (const r of rows) { if (!byDoc.has(r.doc_id)) byDoc.set(r.doc_id, []); byDoc.get(r.doc_id).push(r); }
    for (const [docId, ls] of byDoc) {
      const h = ls[0];
      const real = ls.filter((l) => l.line_id);
      const base = {
        side: 'purchases', doc_type: docType, doc_id: docId, doc_no: h.doc_no, date: dayOf(h.date), partner_id: h.partner_id,
        partner: h.partner || '', tin: h.tin || '', kind: 'vat',
      };
      const mine = [];
      const push = (net, tax, code, itemId, itemType, withhold, wtax) => {
        const cls = purchaseClass(Math.abs(tax) > 0.005, code, itemType, itemId);
        const t = PURCHASE_TAX[cls];
        const row = { ...base, tax_key: t.key, tax_label: t.label, rate: t.rate, cls, net: sign * net, tax: sign * tax, ...acct(code), withhold: !!withhold, wtax: num(wtax) };
        out.push(row); mine.push(row);
      };
      if (!real.length) push(num(h.h_net), num(h.h_tax), accountOf(h), null, null, false, 0);
      else {
        for (const l of real) push(num(l.net), num(l.tax), accountOf(l), l.item_id, l.item_type, l.is_withhold, l.wtax_amount);
        // The header is what the VAT Computation counts: any difference goes on the main line.
        const dTax = r2(num(h.h_tax) - real.reduce((s, l) => s + num(l.tax), 0));
        if (Math.abs(dTax) > 0.005) {
          const main = real.reduce((a, b) => (Math.abs(num(b.net)) > Math.abs(num(a.net)) ? b : a));
          const row = mine.find((m) => m.account_code === accountOf(main)) || mine[0];
          // Taxed now, so it is VAT of that line's class (or goods when the line had none).
          if (row.cls === 'none') {
            const t = PURCHASE_TAX[purchaseClass(true, row.account_code, main.item_type, main.item_id)];
            out.push({ ...base, tax_key: t.key, tax_label: t.label, rate: t.rate, cls: 'goods', net: 0, tax: sign * dTax, ...acct(row.account_code) });
          } else row.tax = r2(row.tax + sign * dTax);
        }
      }
      docLines.set(`${docType}:${docId}`, mine);
    }
  };
  addPurchaseDocs(vbl, 'Vendor Bill', 1, billAccount);
  addPurchaseDocs(chl, 'Cheque', 1, (l) => l.l_code || '');
  addPurchaseDocs(bcl, 'Bill Credit', -1, (l) => l.l_code || '');

  // ---- Purchases: withholding (QAP) -- the Expanded Withholding Tax documents, spread over each
  // document's lines (its Withhold lines when it marks any) by Net, so it lands on the accounts paid.
  // A cheque carries no withholding when it has no tax, so cheques' come straight from their lines.
  const wdocs = await withheldDocs(from, to);
  for (const d of wdocs) {
    const lines = (docLines.get(`${d.doc_type}:${d.id}`) || []).filter((l) => Math.abs(l.net) > 0.005);
    const pick = lines.filter((l) => l.withhold).length ? lines.filter((l) => l.withhold) : lines;
    const weight = pick.reduce((s, l) => s + Math.abs(l.net), 0);
    const rate = d.rate != null ? Number(d.rate) : (d.eff_rate || 0);
    const base = {
      side: 'purchases', doc_type: d.doc_type, doc_id: d.id, doc_no: d.doc_no, date: d.date_created, partner_id: d.supplier_id,
      partner: d.supplier_name || '', tin: d.supplier_tin || '', kind: 'wht', atc: d.atc || '', nature: d.nature || '',
      atc_suggested: d.atc_suggested, tax_key: `P-W-${d.atc || rate}`, tax_label: `${rate}% ${d.atc || 'No ATC'} (Purchases)`, rate: -rate,
    };
    if (!weight) { out.push({ ...base, net: d.tax_base, tax: -d.wtax_amount, ...acct(lines[0]?.account_code || '21402') }); continue; }
    let leftBase = d.tax_base; let leftTax = d.wtax_amount;
    pick.forEach((l, i) => {
      const last = i === pick.length - 1;
      const share = Math.abs(l.net) / weight;
      const b = last ? r2(leftBase) : r2(d.tax_base * share);
      const t = last ? r2(leftTax) : r2(d.wtax_amount * share);
      leftBase -= b; leftTax -= t;
      out.push({ ...base, net: b, tax: -t, account_code: l.account_code, account_name: l.account_name });
    });
  }
  // Direct cheques with withholding but no VAT are not in docLines (only taxed cheques are read for
  // VAT); withheldDocs already listed them above with their own base.
  return out;
}

// ---------------------------------------------------------------------------------------------------
// The views. Each returns { groups: [{ label, cols: [{ label, num }] }], rows: [{ id, parent, level,
// style, label, cells, input? }] } -- one renderer (page, print, XLSX) draws them all.

function sumBy(lines, keyFn, labelFn) {
  const m = new Map();
  for (const l of lines) {
    const k = keyFn(l);
    if (!m.has(k)) m.set(k, { key: k, label: labelFn(l), net: 0, tax: 0, lines: [] });
    const e = m.get(k); e.net += l.net; e.tax += l.tax; e.lines.push(l);
  }
  return [...m.values()];
}
const SIDES = [['sales', 'Sales'], ['purchases', 'Purchases']];
const taxOrder = (k) => ['S-12', 'S-ZR', 'S-EX', 'S-NA', 'P-12-G', 'P-12-S', 'P-12-CG', 'P-0'].indexOf(k) + 1 || 50;

// Generic, Tax > Account, Account > Tax: Net and Tax per period. `periods` is an array of line sets.
function groupedView(periodsLines, labels, mode) {
  const groups = labels.map((label) => ({ label, cols: [{ label: 'Net', num: true }, { label: 'Tax', num: true }] }));
  const rows = [];
  const cellsFor = (pick) => periodsLines.flatMap((ls) => { const sel = ls.filter(pick); return [r2(sel.reduce((s, l) => s + l.net, 0)), r2(sel.reduce((s, l) => s + l.tax, 0))]; });
  const taxOnly = (pick) => periodsLines.flatMap((ls) => [null, r2(ls.filter(pick).reduce((s, l) => s + l.tax, 0))]);
  const all = periodsLines.flat();
  for (const [side, sideLabel] of SIDES) {
    const sideLines = all.filter((l) => l.side === side);
    if (!sideLines.length) continue;
    const sid = `side:${side}`;
    rows.push({ id: sid, level: 0, style: 'section', label: sideLabel, cells: taxOnly((l) => l.side === side) });
    if (mode === 'generic') {
      for (const t of sumBy(sideLines, (l) => l.tax_key, (l) => l.tax_label).sort((a, b) => taxOrder(a.key) - taxOrder(b.key) || a.label.localeCompare(b.label))) {
        rows.push({ id: `${sid}:${t.key}`, parent: sid, level: 1, style: 'line', label: t.label, cells: cellsFor((l) => l.side === side && l.tax_key === t.key) });
      }
    } else {
      const outer = mode === 'tax_account'
        ? sumBy(sideLines, (l) => l.tax_key, (l) => l.tax_label).sort((a, b) => taxOrder(a.key) - taxOrder(b.key) || a.label.localeCompare(b.label))
        : sumBy(sideLines, (l) => l.account_code, (l) => `${l.account_code} ${l.account_name}`.trim()).sort((a, b) => String(a.key).localeCompare(String(b.key)));
      for (const o of outer) {
        const oid = `${sid}:${o.key}`;
        const inOuter = (l) => l.side === side && (mode === 'tax_account' ? l.tax_key === o.key : l.account_code === o.key);
        rows.push({ id: oid, parent: sid, level: 1, style: 'subhead', label: o.label, cells: taxOnly(inOuter) });
        const inner = mode === 'tax_account'
          ? sumBy(o.lines, (l) => l.account_code, (l) => `${l.account_code} ${l.account_name}`.trim()).sort((a, b) => String(a.key).localeCompare(String(b.key)))
          : sumBy(o.lines, (l) => l.tax_key, (l) => l.tax_label).sort((a, b) => taxOrder(a.key) - taxOrder(b.key));
        for (const i of inner) {
          rows.push({ id: `${oid}:${i.key}`, parent: oid, level: 2, style: 'line', label: i.label,
            cells: cellsFor((l) => inOuter(l) && (mode === 'tax_account' ? l.account_code === i.key : l.tax_key === i.key)) });
        }
        rows.push({ id: `${oid}:total`, parent: sid, level: 1, style: 'total', label: `Total ${o.label}`, cells: taxOnly(inOuter) });
      }
    }
    rows.push({ id: `${sid}:total`, level: 0, style: 'total', label: `Total ${sideLabel}`, cells: taxOnly((l) => l.side === side) });
  }
  return { groups, rows };
}

// 2550Q. `manual` holds the lines entered on the page (current period only).
const MANUAL_2550Q = ['16', '17', '18', '19', '22', '23', '24', '36', '37', '38', '39', '40', '43A', '43B', '44A', '44B', '45A', '45B', '47A', '50', '51', '52', '53', '54', '56'];
function compute2550q(lines, manual = {}) {
  const m = (k) => num(manual[k]);
  const vat = lines.filter((l) => l.kind === 'vat');
  const s = (pick, f) => r2(vat.filter(pick).reduce((t, l) => t + l[f], 0));
  const sales = (cls, gov) => (l) => l.side === 'sales' && l.cls === cls && (gov == null || !!l.government === gov);
  const v = {};
  v['31A'] = s(sales('vatable', false), 'net'); v['31B'] = s(sales('vatable', false), 'tax');
  v['32A'] = s(sales('vatable', true), 'net'); v['32B'] = s(sales('vatable', true), 'tax');
  v['33A'] = s(sales('zero_rated'), 'net');
  v['34A'] = s(sales('exempt'), 'net');
  v['35A'] = r2(v['31A'] + v['32A'] + v['33A'] + v['34A']); v['35B'] = r2(v['31B'] + v['32B']);
  for (const k of ['36', '37', '38', '39', '40']) v[k] = m(k);
  v['41'] = r2(v['36'] + v['37'] + v['38'] + v['39'] + v['40']);
  const taxedP = (l) => l.side === 'purchases' && l.cls !== 'none';
  v['42A'] = s(taxedP, 'net'); v['42B'] = s(taxedP, 'tax');
  for (const k of ['43A', '43B', '44A', '44B', '45A', '45B', '47A']) v[k] = m(k);
  v['46A'] = s((l) => l.side === 'purchases' && l.cls === 'none', 'net');
  v['48A'] = r2(v['42A'] + v['43A'] + v['44A'] + v['45A'] + v['46A'] + v['47A']);
  v['48B'] = r2(v['42B'] + v['43B'] + v['44B'] + v['45B']);
  v['49'] = r2(v['41'] + v['48B']);
  for (const k of ['50', '51', '52', '53', '54', '56']) v[k] = m(k);
  v['55'] = r2(v['50'] + v['51'] + v['52'] + v['53'] + v['54']);
  v['57'] = r2(v['55'] - v['56']);
  v['58'] = r2(v['49'] - v['57']);
  v['59'] = r2(v['35B'] - v['58']);
  v['15'] = v['59'];
  for (const k of ['16', '17', '18', '19']) v[k] = m(k);
  v['20'] = r2(v['16'] + v['17'] + v['18'] + v['19']);
  v['21'] = r2(v['15'] - v['20']);
  for (const k of ['22', '23', '24']) v[k] = m(k);
  v['25'] = r2(v['22'] + v['23'] + v['24']);
  v['26'] = r2(v['21'] + v['25']);
  return v;
}
// [no, label, A key, B key, kind]: kind 'section' / 'subsection' heads, else a line.
const LAYOUT_2550Q = [
  ['', 'Tax Payable', null, null, 'section'],
  ['15', 'Net VAT Payable (Excess Input Tax)', null, '15'],
  ['16', 'Creditable VAT Withheld', null, '16'],
  ['17', 'Advance VAT Payments', null, '17'],
  ['18', 'VAT paid in return previously filed, if this is an amended return', null, '18'],
  ['19', 'Other Credits/Payment', null, '19'],
  ['20', 'Total Tax Credits/Payment', null, '20'],
  ['21', 'Tax Still Payable/(Excess Credits)', null, '21'],
  ['', 'Add: Penalties', null, null, 'subsection'],
  ['22', 'Surcharge', null, '22'],
  ['23', 'Interest', null, '23'],
  ['24', 'Compromise', null, '24'],
  ['25', 'Total Penalties', null, '25'],
  ['26', 'Total Amount Payable', null, '26'],
  ['', 'Details of VAT Computation', null, null, 'section'],
  ['31', 'VATable Sales to Private Individuals/Corporations', '31A', '31B'],
  ['32', 'VATable Sales to Government', '32A', '32B'],
  ['33', 'Zero-Rated Sales', '33A', null],
  ['34', 'Exempt Sales', '34A', null],
  ['35', 'Total Sales & Output Tax Due', '35A', '35B'],
  ['36', 'Input Tax Carried Over from Previous Quarter', null, '36'],
  ['37', 'Input Tax Deferred on Capital Goods Exceeding P1 Million from Previous Quarter', null, '37'],
  ['38', 'Transitional Input Tax', null, '38'],
  ['39', 'Presumptive Input Tax', null, '39'],
  ['40', 'Others', null, '40'],
  ['41', 'Total (Sum of Items 36 to 40)', null, '41'],
  ['', 'Current Transactions', null, null, 'subsection'],
  ['42', 'Domestic Purchases', '42A', '42B'],
  ['43', 'Services Rendered by Non-residents', '43A', '43B'],
  ['44', 'Importations', '44A', '44B'],
  ['45', 'Others', '45A', '45B'],
  ['46', 'Domestic Purchases with No Input Tax', '46A', null],
  ['47', 'VAT-Exempt Importations', '47A', null],
  ['48', 'Total Current Purchases/Input Tax (Sum of Items 42 to 47)', '48A', '48B'],
  ['49', 'Total Available Input Tax (Sum of Items 41 and 48B)', null, '49'],
  ['', 'Less: Deductions from Input Tax', null, null, 'subsection'],
  ['50', 'Input Tax on Purchases/Importation of Capital Goods exceeding P1 Million deferred for the succeeding period', null, '50'],
  ['51', 'Input Tax Attributable to VAT Exempt Sales', null, '51'],
  ['52', 'VAT Refund/TCC Claimed', null, '52'],
  ['53', 'Input VAT on Unpaid Payables', null, '53'],
  ['54', 'Others', null, '54'],
  ['55', 'Total Deductions from Input Tax (Sum of Items 50 to 54)', null, '55'],
  ['56', 'Add: Input VAT on Settled Unpaid Payables Previously Deducted', null, '56'],
  ['57', 'Adjusted Deductions from Input Tax (Item 55 less Item 56)', null, '57'],
  ['58', 'Total Allowable Input Tax (Item 49 less Item 57)', null, '58'],
  ['59', 'Net VAT Payable/(Excess Input Tax) (Item 35B less Item 58)', null, '59'],
];
const TOTAL_2550Q = ['15', '20', '21', '25', '26', '35', '41', '48', '49', '55', '57', '58', '59'];
function view2550q(periodsLines, labels, manual, curIdx) {
  const vals = periodsLines.map((ls, i) => compute2550q(ls, i === curIdx ? manual : {}));
  const groups = labels.map((label) => ({ label, cols: [{ label: 'Tax base', num: true }, { label: 'Balance', num: true }] }));
  const rows = LAYOUT_2550Q.map(([no, label, a, b, kind], i) => {
    if (kind) return { id: `q${i}`, level: 0, style: kind === 'section' ? 'section' : 'subhead', label, cells: vals.flatMap(() => [null, null]) };
    return {
      id: `q${i}`, level: 1, style: TOTAL_2550Q.includes(no) ? 'total' : 'line', label: `${no} ${label}`,
      cells: vals.flatMap((v) => [a ? v[a] : null, b ? v[b] : null]),
      // Entered on the page: which of this line's two cells take a typed figure.
      input: [a && MANUAL_2550Q.includes(a) ? a : null, b && MANUAL_2550Q.includes(b) ? b : null],
    };
  });
  return { groups, rows };
}

// SAWT (sales withholding) or QAP (purchases withholding): month > payee > document > ATC.
function alphalistView(lines, label, side) {
  const cols = [
    { label: 'Taxpayer ID Number' }, { label: 'Register Name' }, { label: 'ATC Code' },
    { label: 'Amount of Income Payment', num: true }, { label: 'Tax Rate', pct: true }, { label: 'Amount Tax Withheld', num: true },
  ];
  const w = lines.filter((l) => l.kind === 'wht' && l.side === side);
  const rows = [];
  const months = [...new Set(w.map((l) => l.date.slice(0, 7)))].sort().reverse();
  const tot = (ls) => [r2(ls.reduce((s, l) => s + l.net, 0)), r2(ls.reduce((s, l) => s + l.tax, 0))];
  for (const mo of months) {
    const ml = w.filter((l) => l.date.startsWith(mo));
    const [y, mm] = mo.split('-').map(Number);
    const mid = `m:${mo}`;
    rows.push({ id: mid, level: 0, style: 'section', label: `${MONTHS[mm - 1]} ${y}`, cells: ['', '', '', ...tot(ml).slice(0, 1), null, tot(ml)[1]] });
    const payees = sumBy(ml, (l) => `${l.partner_id || ''}:${l.partner}`, (l) => l.partner).sort((a, b) => a.label.localeCompare(b.label));
    for (const p of payees) {
      const pid = `${mid}:${p.key}`;
      const tin = p.lines.find((l) => l.tin)?.tin || '';
      rows.push({ id: pid, parent: mid, level: 1, style: 'subhead', label: p.label || '(no name)', cells: ['', '', '', null, null, null] });
      const docs = sumBy(p.lines, (l) => `${l.doc_type}:${l.doc_id}`, (l) => l.doc_no);
      for (const d of docs) {
        const did = `${pid}:${d.key}`;
        const [b, t] = tot(d.lines);
        rows.push({ id: did, parent: pid, level: 2, style: 'doc', label: d.label, cells: ['', '', '', b, null, t], collapsed: true });
        for (const a of sumBy(d.lines, (l) => l.atc || l.tax_label, (l) => l)) {
          const l0 = a.lines[0];
          rows.push({ id: `${did}:${a.key}`, parent: did, level: 3, style: 'line',
            label: `${Math.abs(l0.rate)}% ${l0.atc || ''}${l0.nature ? ` - ${l0.nature}` : ''}${l0.atc_suggested ? ' (ATC suggested from the rate)' : ''}`,
            cells: ['', '', l0.atc || '', r2(a.net), Math.abs(l0.rate), r2(a.tax)] });
        }
      }
      const [pb, pt] = tot(p.lines);
      rows.push({ id: `${pid}:total`, parent: mid, level: 1, style: 'total', label: `Total ${p.label}`, cells: [tin, p.label, '', pb, null, pt] });
    }
  }
  if (!rows.length) rows.push({ id: 'none', level: 0, style: 'line', label: `Nothing was withheld in ${label}.`, cells: ['', '', '', null, null, null] });
  return { groups: [{ label, cols }], rows };
}

const REPORTS = {
  '2550q': 'Report: 2550Q (PH)',
  sawt_qap: 'Report: SAWT & QAP (PH)',
  tax_account: 'Report: Group by: Tax > Account',
  account_tax: 'Report: Group by: Account > Tax',
  generic: 'Report: Generic Tax report',
};

async function buildReport(q) {
  const report = REPORTS[q.report] ? q.report : '2550q';
  if (!isDate(q.from) || !isDate(q.to) || q.to < q.from) { const e = new Error('Choose the period (from and to).'); e.status = 400; throw e; }
  const periods = [{ from: q.from, to: q.to }];
  // Comparison (not on the alphalists, which are lists of payees, as in Odoo).
  if (report !== 'sawt_qap') {
    const n = Math.min(12, Math.max(1, Number(q.compare_count) || 1));
    if (q.compare === 'previous' || q.compare === 'last_year') {
      let p = periods[0];
      for (let i = 0; i < n; i += 1) { p = shiftPeriod(p.from, p.to, q.compare); periods.push(p); }
    } else if (q.compare === 'custom' && isDate(q.compare_from) && isDate(q.compare_to)) periods.push({ from: q.compare_from, to: q.compare_to });
  }
  if (q.order === 'ascending') periods.reverse();
  const labels = periods.map((p) => periodLabel(p.from, p.to));
  const lineSets = await Promise.all(periods.map((p) => taxLines(p.from, p.to)));
  let manual = {};
  try { manual = q.manual ? JSON.parse(q.manual) : {}; } catch { manual = {}; }
  // The period asked for: first, or last when the columns run oldest first. Lines typed on the page
  // (2550Q) apply to it only.
  const curIdx = q.order === 'ascending' ? lineSets.length - 1 : 0;
  let view;
  if (report === '2550q') view = view2550q(lineSets, labels, manual, curIdx);
  else if (report === 'sawt_qap') {
    view = alphalistView(lineSets[0], labels[0], q.tab === 'sawt' ? 'sales' : 'purchases');
  } else view = groupedView(lineSets, labels, report);
  return {
    report, title: REPORTS[report], from: q.from, to: q.to, label: labels[curIdx], periods, tab: q.tab === 'sawt' ? 'sawt' : 'qap',
    manual_lines: report === '2550q' ? MANUAL_2550Q : [], current_group: curIdx, ...view,
  };
}

const fail = (res, next, err) => (err.status ? res.status(err.status).json({ error: err.message }) : next(err));

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try { res.json(await buildReport(req.query)); } catch (err) { fail(res, next, err); }
});

router.get('/xlsx', requireAuth, requirePermission(ROUTE, 'can_print'), async (req, res, next) => {
  try {
    const r = await buildReport(req.query);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Tax Return');
    const ncols = r.groups.reduce((s, g) => s + g.cols.length, 0);
    ws.columns = [{ width: 70 }, ...Array(ncols).fill({ width: 18 })];
    ws.addRow([`Tax Return — ${r.title.replace(/^Report: /, '')}${r.report === 'sawt_qap' ? ` (${r.tab.toUpperCase()})` : ''}`]).font = { bold: true, size: 13 };
    ws.addRow([]);
    const g1 = ws.addRow(['', ...r.groups.flatMap((g) => g.cols.map((_, i) => (i === 0 ? g.label : '')))]);
    g1.font = { bold: true };
    let c = 2;
    for (const g of r.groups) { if (g.cols.length > 1) ws.mergeCells(g1.number, c, g1.number, c + g.cols.length - 1); c += g.cols.length; }
    ws.addRow(['', ...r.groups.flatMap((g) => g.cols.map((col) => col.label))]).font = { bold: true };
    const colDefs = r.groups.flatMap((g) => g.cols);
    for (const row of r.rows) {
      const x = ws.addRow([`${'    '.repeat(row.level || 0)}${row.label}`, ...row.cells.map((v) => (v == null ? '' : v))]);
      if (['section', 'total', 'subhead'].includes(row.style)) x.font = { bold: true };
      if (row.style === 'section') x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDE1E6' } };
      colDefs.forEach((col, i) => { if (col.num) x.getCell(i + 2).numFmt = '#,##0.00;[Red]-#,##0.00'; });
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="tax-return-${r.report}${r.report === 'sawt_qap' ? `-${r.tab}` : ''}-${r.from}_${r.to}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { fail(res, next, err); }
});

module.exports = router;
module.exports.taxLines = taxLines;
module.exports.compute2550q = compute2550q;
