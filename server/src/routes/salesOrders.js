const express = require('express');
const multer = require('multer');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { getSalesRepEmployeeScope } = require('../lib/salesVisibility');
const { extractPdfText } = require('../lib/posCategorySales');
const { parseZReading } = require('../lib/posZReading');
const { parseConsolidatedZReading, isConsolidatedZReading } = require('../lib/posConsolidatedZReading');
const { computeSalesOrderGl } = require('../lib/glImpact');

const router = express.Router();
const ROUTE = '/sales-orders';

const STATUS_VALUES = [
  'pending_for_jo', 'jo_in_process', 'pending_delivery', 'partially_delivered',
  'pending_billing', 'pending_billing_partially_delivered', 'billed', 'cancelled',
  // Counter sales imported from a POS shift report never enter the production pipeline the
  // others describe. They land UNDEPOSITED (money in the till) and a Bank Deposit moves them
  // to DEPOSITED, exactly like a Customer Payment. 'recorded' predates that split and is kept
  // so nothing that already used it breaks.
  'recorded', 'undeposited', 'deposited',
];

// Each PDF is parsed in memory and thrown away; only the extracted figures are persisted.
// 10MB per file is far above any real shift report (the samples are well under 200KB) and
// exists to stop an oversized upload tying up the process. 62 files covers a month of two
// shifts a day, which is the longest period one sheet realistically spans.
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 62 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname)) return cb(null, true);
    cb(new Error('Only PDF files can be imported.'));
  },
});

// A Z-Reading prints whoever the cashier typed at the terminal -- "MaryRose", "CRISTY" -- not
// an employee code, so the name has to be matched back to an employee record by hand.
//
// Matched in tiers (full name, then first name, then last name) and ONLY when exactly one
// employee answers at that tier. Two people called Cristy means the report does not say which,
// and quietly picking the lower id would put a stranger's name on the day's takings. An
// unmatched name is not an error: the printed name is stored either way, and the order simply
// carries no sales rep.
const normalizeName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function buildEmployeeMatcher(conn) {
  const [employees] = await conn.query(
    'SELECT id, first_name, last_name FROM employees WHERE is_active = TRUE'
  );

  const tiers = [new Map(), new Map(), new Map()]; // full name, first name, last name
  const add = (map, key, id) => {
    if (!key) return;
    // null marks the key as ambiguous, so a later lookup refuses it rather than guessing.
    map.set(key, map.has(key) ? null : id);
  };
  for (const e of employees) {
    add(tiers[0], normalizeName(`${e.first_name} ${e.last_name}`), e.id);
    add(tiers[1], normalizeName(e.first_name), e.id);
    add(tiers[2], normalizeName(e.last_name), e.id);
  }

  return (printedName) => {
    const key = normalizeName(printedName);
    if (!key) return null;
    for (const tier of tiers) {
      const hit = tier.get(key);
      if (hit) return hit;
    }
    return null;
  };
}

// "2026-08-01" + "07:12" -> "2026-08-01 07:12:00", and null for anything malformed rather than
// a MySQL zero-date.
function toDateTime(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return null;
  if (!/^\d{1,2}:\d{2}$/.test(time || '')) return null;
  const [h, m] = time.split(':');
  return `${date} ${h.padStart(2, '0')}:${m}:00`;
}

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const {
      status, search, sales_rep_id: salesRepId, office_location_id: officeLocationId, as_of: asOf,
      customer_id: customerId, page = '1', limit = '10',
    } = req.query;

    const commonWhere = [];
    const commonParams = [];
    if (salesRepId) { commonWhere.push('so.sales_rep_id = ?'); commonParams.push(salesRepId); }
    if (officeLocationId) { commonWhere.push('so.office_location_id = ?'); commonParams.push(officeLocationId); }
    if (asOf) { commonWhere.push('so.date_created <= ?'); commonParams.push(asOf); }
    if (customerId) { commonWhere.push('so.customer_id = ?'); commonParams.push(customerId); }
    if (search) {
      commonWhere.push('(so.sales_order_no LIKE ? OR e.estimate_no LIKE ? OR c.name LIKE ? OR so.contract_description LIKE ?)');
      commonParams.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    // Account Officers only ever see their own sales orders; Supervisors see their own
    // plus their direct reports' -- everyone else is unrestricted.
    const scope = await getSalesRepEmployeeScope(req.user.id);
    if (scope) { commonWhere.push('so.sales_rep_id IN (?)'); commonParams.push(scope); }

    const where = [...commonWhere];
    const params = [...commonParams];
    if (status && STATUS_VALUES.includes(status)) { where.push('so.status = ?'); params.push(status); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const commonWhereSql = commonWhere.length ? `WHERE ${commonWhere.join(' AND ')}` : '';

    const baseFrom = `FROM sales_orders so
       LEFT JOIN estimates e ON e.id = so.estimate_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN employees sr ON sr.id = so.sales_rep_id
       LEFT JOIN employees pb ON pb.id = so.prepared_by_id
       LEFT JOIN locations loc ON loc.id = so.office_location_id`;

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${baseFrom} ${whereSql}`, params);

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 10));
    const offset = (pageNum - 1) * limitNum;

    const [rows] = await pool.query(
      `SELECT so.*, e.estimate_no, c.name AS customer_name, CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              CONCAT(pb.first_name, ' ', pb.last_name) AS prepared_by_name, loc.location_name
       ${baseFrom} ${whereSql}
       ORDER BY so.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    const [countRows] = await pool.query(
      `SELECT so.status, COUNT(*) AS count ${baseFrom} ${commonWhereSql} GROUP BY so.status`,
      commonParams
    );
    const counts = Object.fromEntries(STATUS_VALUES.map((s) => [s, 0]));
    countRows.forEach((r) => { if (counts[r.status] !== undefined) counts[r.status] = r.count; });

    res.json({ rows, total, page: pageNum, limit: limitNum, counts });
  } catch (err) {
    next(err);
  }
});

// Step 1 of the PDF import: read one or more Z-Reading shift reports and hand back what they
// say, WITHOUT writing anything. Several files at once because a day has more than one shift
// and a sheet covers a whole period -- each PDF becomes one row of the grid. Placed above
// /:id so "import" is never mistaken for an order id.
router.post('/import/preview', requireAuth, requirePermission(ROUTE, 'can_add'), pdfUpload.array('files', 62), async (req, res, next) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'Attach at least one Z-Reading PDF.' });

    const shifts = [];
    for (const file of files) {
      let text;
      try {
        text = await extractPdfText(file.buffer);
      } catch {
        shifts.push({
          ok: false, source_file: file.originalname,
          errors: ['This PDF could not be read. If it is a scan rather than a digital export, the text cannot be extracted.'],
        });
        continue;
      }

      // A PDF that is just a picture of a report does not throw -- extraction succeeds and
      // hands back the page furniture and nothing else (one real example: a 587KB file whose
      // entire text was "-- 1 of 1 --", 16 characters, wrapped around a 1919x2122 JPEG). Left
      // to fall through, the parsers would then say "this does not look like a Z-Reading
      // report", which sends the operator hunting for the wrong document when the document
      // was right and only the export was wrong. A real reading runs to thousands of
      // characters, so anything this thin is diagnosed here while the cause is still visible.
      if (text.replace(/\s/g, '').length < 200) {
        shifts.push({
          ok: false, source_file: file.originalname,
          errors: [
            'This PDF has no text in it -- it is an image of the report (a scan, a photo, or a '
            + 'screenshot saved as a PDF), so there is nothing to read. Export the Z-Reading to '
            + 'PDF from the POS itself rather than scanning or screenshotting the print-out.',
          ],
        });
        continue;
      }

      // Two Z-Reading formats are accepted, told apart by the document itself rather than
      // by asking the operator which one they are holding. The consolidated report is
      // checked first: its title also contains "Z-READING", so the per-shift parser would
      // happily claim it and then fail to find a single field.
      const parsed = isConsolidatedZReading(text) ? parseConsolidatedZReading(text) : parseZReading(text);

      // Surfaced, not blocked -- the operator sees which order already covers this shift.
      // The unique index on the line is what actually enforces it at save time.
      let duplicate = null;
      if (parsed.import_key) {
        const [[row]] = await pool.query(
          `SELECT so.id, so.sales_order_no, sol.sale_date
           FROM sales_order_lines sol
           JOIN sales_orders so ON so.id = sol.sales_order_id
           WHERE sol.pos_import_key = ?`,
          [parsed.import_key]
        );
        duplicate = row || null;
      }

      shifts.push({ ...parsed, source_file: file.originalname, duplicate });
    }

    // Chronological, so the grid reads like the sheet regardless of the order the files were
    // picked in.
    shifts.sort((a, b) => `${a.closed_date || ''} ${a.closed_time || ''}`.localeCompare(`${b.closed_date || ''} ${b.closed_time || ''}`));
    res.json({ shifts });
  } catch (err) {
    next(err);
  }
});

// Step 2: create the Sales Order from the rows the preview showed. Figures are stored as the
// report printed them ("read, but verify"), and every internal relationship is re-checked
// here before anything is written -- a row that does not reconcile is refused, not stored.
router.post('/import', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const {
      customer_id: customerId, office_location_id: officeLocationId, department_id: departmentId,
      sales_rep_id: salesRepId, memo, shifts,
    } = req.body;

    if (!customerId) return res.status(400).json({ error: 'Select the customer to record these sales against.' });
    // Required, unlike the office location: this order is the ledger entry for the shift's
    // takings, and without a department its revenue and Undeposited Funds fall out of every
    // department-scoped report with no way to place them after the fact.
    if (!departmentId) return res.status(400).json({ error: 'Select the department these sales belong to.' });
    if (!Array.isArray(shifts) || !shifts.length) return res.status(400).json({ error: 'Nothing to import.' });

    const [[customer]] = await conn.query('SELECT id FROM customers WHERE id = ?', [customerId]);
    if (!customer) return res.status(400).json({ error: 'Customer not found.' });

    const [[department]] = await conn.query('SELECT id, is_active FROM departments WHERE id = ?', [departmentId]);
    if (!department) return res.status(400).json({ error: 'Department not found.' });
    if (!department.is_active) return res.status(400).json({ error: 'That department is no longer active.' });

    const n = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
    const TOLERANCE = 0.01;
    const near = (a, b) => Math.abs(Number(a.toFixed(2)) - Number(b.toFixed(2))) <= TOLERANCE;

    const rows = [];
    const seen = new Set();
    for (const s of shifts) {
      const label = `${s.branch_code || '?'}/${s.shift || '?'} ${s.sale_date || ''}`.trim();
      if (!s.sale_date) return res.status(400).json({ error: `A shift (${s.source_file || label}) has no date.` });

      const r = {
        sale_date: s.sale_date,
        cash: n(s.cash),
        collected_cash: n(s.collected_cash),
        gcash: n(s.gcash),
        collected_gcash: n(s.collected_gcash),
        collected_bank_deposit: n(s.collected_bank_deposit),
        total_daily_sales: n(s.total_daily_sales),
        total_cash_to_deposit: n(s.total_cash_to_deposit),
        total_gcash: n(s.total_gcash),
        uncollected_sales: n(s.uncollected_sales),
        vat_ex: n(s.vat_ex),
        vat_12: n(s.vat_12),
        vat_inc: n(s.vat_inc),
      };

      // The Z-Reading's own arithmetic, re-asserted. Each of these holds on a well-formed
      // report, so a failure means the figures were edited or misread between preview and
      // save -- either way not something to persist.
      if (!near(r.cash + r.gcash, r.total_daily_sales)) {
        return res.status(409).json({ error: `${label}: cash ${r.cash.toFixed(2)} + GCash ${r.gcash.toFixed(2)} does not equal total daily sales ${r.total_daily_sales.toFixed(2)}.` });
      }
      if (!near(r.vat_ex + r.vat_12, r.vat_inc)) {
        return res.status(409).json({ error: `${label}: VAT EX ${r.vat_ex.toFixed(2)} + VAT 12% ${r.vat_12.toFixed(2)} does not equal VAT inclusive ${r.vat_inc.toFixed(2)}.` });
      }
      if (!near(r.vat_inc, r.total_daily_sales)) {
        return res.status(409).json({ error: `${label}: VAT inclusive ${r.vat_inc.toFixed(2)} does not equal total daily sales ${r.total_daily_sales.toFixed(2)}.` });
      }
      // The report prints one COLLECTED total; the operator splits it across cash and GCash,
      // and the split has to add back to what was collected.
      if (!near(r.collected_cash + r.collected_gcash, r.collected_bank_deposit)) {
        return res.status(409).json({ error: `${label}: collected cash ${r.collected_cash.toFixed(2)} + collected GCash ${r.collected_gcash.toFixed(2)} does not equal collected ${r.collected_bank_deposit.toFixed(2)}.` });
      }

      if (s.import_key) {
        if (seen.has(s.import_key)) return res.status(409).json({ error: `${label} was attached twice.` });
        seen.add(s.import_key);
        const [[dupe]] = await conn.query(
          `SELECT so.sales_order_no FROM sales_order_lines sol
           JOIN sales_orders so ON so.id = sol.sales_order_id WHERE sol.pos_import_key = ?`,
          [s.import_key]
        );
        if (dupe) return res.status(409).json({ error: `${label} has already been imported as ${dupe.sales_order_no}.` });
      }

      rows.push({
        ...r,
        // Kept so the GL entry can split revenue between laundry and water refilling; the
        // grid row itself only carries the day's totals.
        categories: (Array.isArray(s.categories) ? s.categories : [])
          .filter((c) => c && c.name)
          .map((c) => ({ name: String(c.name).trim().slice(0, 80), amount: n(c.amount) })),
        import_key: s.import_key || null,
        branch_code: s.branch_code || null,
        shift: s.shift || null,
        cashier: s.closed_by || null,
        // Both attendants as the report printed them, with the times the till was opened and
        // closed -- a shift can change hands mid-day (786 opened and closed on MaryRose, 784
        // opened on MaryRose and closed on CRISTY).
        opened_by: s.opened_by || null,
        opened_at: toDateTime(s.opened_date, s.opened_time),
        closed_at: toDateTime(s.closed_date, s.closed_time),
        beginning_or: s.beginning_or || null,
        ending_or: s.ending_or || null,
        store_name: s.store_name || null,
      });
    }

    // Names on the report resolved to employee records, so the order's Sales Rep is a real
    // person and not a string. Built once for the whole import rather than per shift.
    const matchEmployee = await buildEmployeeMatcher(conn);
    for (const r of rows) {
      r.opened_employee_id = matchEmployee(r.opened_by);
      r.closed_employee_id = matchEmployee(r.cashier);
    }

    rows.sort((a, b) => a.sale_date.localeCompare(b.sale_date));
    const netOfTax = Number(rows.reduce((s, r) => s + r.vat_ex, 0).toFixed(2));
    const taxTotal = Number(rows.reduce((s, r) => s + r.vat_12, 0).toFixed(2));
    const totalAmount = Number(rows.reduce((s, r) => s + r.total_daily_sales, 0).toFixed(2));

    const firstDate = rows[0].sale_date;
    const lastDate = rows[rows.length - 1].sale_date;
    const store = rows[0].store_name;
    const branches = [...new Set(rows.map((r) => r.branch_code).filter(Boolean))].join(', ');
    const period = firstDate === lastDate ? firstDate : `${firstDate} to ${lastDate}`;
    const contractDescription = `Daily Sales & Collections — ${[store, branches].filter(Boolean).join(' ')} — ${period}`.slice(0, 500);

    // The Sales Rep is the cashier the earliest shift was CLOSED by -- the person who ran the
    // Z-Reading and is accountable for the money it reports -- falling back to whoever opened
    // that shift if the closing name matched no employee. An explicit sales_rep_id in the
    // request still wins, and an unmatched name simply leaves the field empty rather than
    // guessing. One order can collect several shifts with different attendants, so the per-line
    // names below are the full record; this is the header's single best answer.
    const headShift = rows[0];
    const resolvedSalesRepId = salesRepId
      || headShift.closed_employee_id
      || headShift.opened_employee_id
      || null;

    // Prepared By is whoever uploaded the PDFs -- the only person this document can attribute
    // the act of importing to. Users are linked to an employee record; an account without one
    // leaves it blank.
    const [[me]] = await conn.query('SELECT employee_id FROM users WHERE id = ?', [req.user.id]);
    const preparedById = me?.employee_id || null;

    await conn.beginTransaction();
    // estimate_id stays NULL: counter sales never had a quotation behind them. Status starts
    // at 'undeposited' -- the money was taken at the counter and is sitting in Undeposited
    // Funds until a Bank Deposit sweeps it, so the order must not land in the production or
    // delivery queues.
    const [result] = await conn.query(
      `INSERT INTO sales_orders
         (sales_order_no, estimate_id, sales_layout, pos_branch_code, pos_source_file, date_created,
          customer_id, office_location_id, department_id, sales_rep_id, prepared_by_id,
          pos_cashier, pos_closed_at, contract_description, memo, status,
          subtotal, discount_total, net_of_tax, tax_total, total_amount, est_gp_rate, est_gp_amount)
       VALUES ('', NULL, 'daily_collections', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'undeposited', ?, 0, ?, ?, ?, 0, 0)`,
      [
        branches || null, shifts.map((s) => s.source_file).filter(Boolean).join(', ').slice(0, 255) || null,
        lastDate, customerId, officeLocationId || null, departmentId, resolvedSalesRepId, preparedById,
        headShift.cashier, headShift.closed_at, contractDescription,
        memo || null, netOfTax, netOfTax, taxTotal, totalAmount,
      ]
    );
    const salesOrderId = result.insertId;
    await conn.query('UPDATE sales_orders SET sales_order_no = ? WHERE id = ?', [`SO-${60000 + salesOrderId}`, salesOrderId]);

    let lineNo = 0;
    for (const r of rows) {
      lineNo += 1;
      const [lineRes] = await conn.query(
        `INSERT INTO sales_order_lines
           (sales_order_id, line_no, pos_import_key, pos_branch_code, pos_shift, pos_cashier,
            pos_opened_by, pos_opened_at, pos_closed_at, pos_opened_employee_id, pos_closed_employee_id,
            pos_beginning_or, pos_ending_or, sale_date, cash, collected_cash, gcash, collected_gcash,
            collected_bank_deposit, total_daily_sales, total_cash_to_deposit, total_gcash,
            uncollected_sales, vat_ex, vat_12, vat_inc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          salesOrderId, lineNo, r.import_key, r.branch_code, r.shift, r.cashier,
          r.opened_by, r.opened_at, r.closed_at, r.opened_employee_id, r.closed_employee_id,
          r.beginning_or, r.ending_or, r.sale_date, r.cash, r.collected_cash, r.gcash, r.collected_gcash,
          r.collected_bank_deposit, r.total_daily_sales, r.total_cash_to_deposit, r.total_gcash,
          r.uncollected_sales, r.vat_ex, r.vat_12, r.vat_inc,
        ]
      );
      const lineId = lineRes.insertId;
      for (const c of r.categories) {
        await conn.query(
          'INSERT INTO sales_order_line_categories (sales_order_line_id, category_name, amount) VALUES (?, ?, ?)',
          [lineId, c.name, c.amount]
        );
      }
    }

    // 'Created' rather than an 'Imported' event type: audit_logs.event_type is a fixed ENUM
    // shared by every module, and widening it for one case would ripple further than this
    // feature warrants. The source documents are recorded in the field/value instead.
    await conn.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES ('SalesOrder', ?, 'Created', 'z_reading_import', NULL, ?, ?)`,
      [salesOrderId, rows.map((r) => r.import_key).filter(Boolean).join('; ').slice(0, 1000) || null, req.user.id]
    );
    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM sales_orders WHERE id = ?', [salesOrderId]);
    res.status(201).json(row);
  } catch (err) {
    await conn.rollback();
    // The unique index is the real guard -- it also catches two operators importing the same
    // shift at the same moment, which the SELECT above cannot.
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'One of these shifts has already been imported.' });
    next(err);
  } finally {
    conn.release();
  }
});


router.get('/:id', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [[so]] = await pool.query(
      `SELECT so.*, e.estimate_no, c.name AS customer_name, cc.contact_name,
              sd.name AS sales_division_name, loc.location_name AS office_location_name,
              dept.name AS department_name, bp.po_number AS blanket_po_no,
              CONCAT(sr.first_name, ' ', sr.last_name) AS sales_rep_name,
              CONCAT(pb.first_name, ' ', pb.last_name) AS prepared_by_name,
              CONCAT(ap.first_name, ' ', ap.last_name) AS approved_by_name
       FROM sales_orders so
       LEFT JOIN estimates e ON e.id = so.estimate_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN customer_contacts cc ON cc.id = so.contact_person_id
       LEFT JOIN sales_divisions sd ON sd.id = so.sales_division_id
       LEFT JOIN locations loc ON loc.id = so.office_location_id
       LEFT JOIN departments dept ON dept.id = so.department_id
       LEFT JOIN blanket_pos bp ON bp.id = so.blanket_po_id
       LEFT JOIN employees sr ON sr.id = so.sales_rep_id
       LEFT JOIN employees pb ON pb.id = so.prepared_by_id
       LEFT JOIN employees ap ON ap.id = so.approved_by_id
       WHERE so.id = ?`,
      [req.params.id]
    );
    if (!so) return res.status(404).json({ error: 'Not found' });
    // Defense in depth -- a scoped user can't view someone else's sales order just by
    // guessing/pasting its URL, even though the list already filters it out.
    const scope = await getSalesRepEmployeeScope(req.user.id);
    if (scope && !scope.includes(so.sales_rep_id)) return res.status(404).json({ error: 'Not found' });

    const [lines] = await pool.query(
      `SELECT sol.*, jt.display_name AS job_type_name, loc.location_name AS job_location_name, t.code AS tax_code, t.rate AS tax_rate,
              jo.job_order_no, jo.status AS job_order_status,
              jo.quantity_built, jo.quantity_inspected, jo.quantity_delivered, jo.quantity_invoiced
       FROM sales_order_lines sol
       LEFT JOIN job_types jt ON jt.id = sol.job_type_id
       LEFT JOIN locations loc ON loc.id = sol.job_location_id
       LEFT JOIN taxes t ON t.id = sol.tax_code_id
       LEFT JOIN job_orders jo ON jo.id = sol.job_order_id
       WHERE sol.sales_order_id = ? ORDER BY sol.line_no`,
      [req.params.id]
    );

    // Only an imported counter-sales order posts to the GL -- an estimate-derived order's
    // entry happens when it is invoiced, so computeSalesOrderGl returns nothing for those.
    const glImpact = await computeSalesOrderGl(so, lines);
    res.json({ ...so, lines, gl_impact: glImpact });
  } catch (err) {
    next(err);
  }
});

// Mirrors the real system's "Create JO" cell on a Sales Order line: turns that line
// into a Job Order (a deliberately minimal production-record stand-in, not the full
// production/QI/delivery/invoicing pipeline the real system has behind it).
// Creating a JO from a line is an "add" (a sales rep forwarding their order to production),
// not an edit of the sales order -- gate it on can_add, which sales accounts have.
router.post('/:id/lines/:lineId/create-jo', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[so]] = await conn.query('SELECT * FROM sales_orders WHERE id = ?', [req.params.id]);
    const [[line]] = await conn.query(
      'SELECT * FROM sales_order_lines WHERE id = ? AND sales_order_id = ?',
      [req.params.lineId, req.params.id]
    );
    if (!so || !line) {
      await conn.rollback();
      return res.status(404).json({ error: 'Not found' });
    }
    // An imported POS shift report records sales that already happened at the counter --
    // there is no production work to raise, so it never gets a Job Order. Enforced here as
    // well as hidden in the UI, since the button is not the only way to reach this.
    if (so.pos_import_key) {
      await conn.rollback();
      return res.status(409).json({ error: 'Imported counter sales do not have Job Orders.' });
    }
    if (line.job_order_id) {
      await conn.rollback();
      return res.status(409).json({ error: 'This line already has a Job Order' });
    }

    // Job Order number: JO-<soNumber>-<sequence>-<totalLines> -- sequence is this line's position,
    // total is how many lines the SO has (so JO-63615-2-3 reads "line 2 of 3").
    const soNumericPart = so.sales_order_no.replace(/\D/g, '');
    const [[lineCount]] = await conn.query('SELECT COUNT(*) AS n FROM sales_order_lines WHERE sales_order_id = ?', [so.id]);
    const jobOrderNo = `JO-${soNumericPart}-${line.line_no}-${lineCount.n}`;
    const [result] = await conn.query(
      `INSERT INTO job_orders
         (job_order_no, sales_order_line_id, sales_order_id, job_type_id, job_location_id, description, quantity, units,
          length, width, height, memo, contact_email, contact_title, contact_phone, shipping_address, sales_rep_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [jobOrderNo, line.id, req.params.id, line.job_type_id, line.job_location_id, line.description, line.quantity, line.units,
        line.length, line.width, line.height, line.memo,
        so.contact_email, so.contact_title, so.contact_phone, so.shipping_address, so.sales_rep_id]
    );
    const jobOrderId = result.insertId;
    await conn.query('UPDATE sales_order_lines SET job_order_id = ? WHERE id = ?', [jobOrderId, line.id]);

    // Copy the originating estimate process line's cost breakdown into the Job Order's
    // own Materials/Processes tabs -- this is where that data actually gets consumed
    // downstream, since Sales Order lines themselves stay flat (no nested process rows).
    if (line.estimate_job_order_id) {
      const [processes] = await conn.query(
        'SELECT * FROM estimate_job_order_processes WHERE estimate_job_order_id = ? ORDER BY line_no',
        [line.estimate_job_order_id]
      );
      for (const p of processes) {
        await conn.query(
          `INSERT INTO job_order_processes
             (job_order_id, line_no, process_id, process_qty, process_uom, category, parts, item_id, length, width, uom,
              qty, total, unit, remarks, memo, process_cost, material_cost, total_cost)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [jobOrderId, p.line_no, p.process_id, p.process_qty, p.process_uom, p.category, p.parts, p.item_id, p.length, p.width,
            p.uom, p.qty, p.total, p.unit, p.remarks, p.memo, p.process_cost, p.material_cost, p.total_cost]
        );
      }
    }

    // The first line getting a JO moves the whole order out of "Pending for JO".
    await conn.query(
      "UPDATE sales_orders SET status = 'jo_in_process', updated_at = NOW() WHERE id = ? AND status = 'pending_for_jo'",
      [req.params.id]
    );
    await conn.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES ('JobOrder', ?, 'Created', 'status', NULL, ?, ?)`,
      [jobOrderId, 'Planned - Pending for BOM', req.user.id]
    );
    await conn.commit();
    const [[jobOrder]] = await pool.query('SELECT * FROM job_orders WHERE id = ?', [jobOrderId]);
    res.status(201).json(jobOrder);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
