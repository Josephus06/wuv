const pool = require('../db');
const { resolveScope } = require('../routes/dashboard');
const { ticketVisibilityClause } = require('./ticketVisibility');

// Last-resort fallback for the chatbot when no hand-built intent matches: answer using
// an LLM instead of more regex.
//
// Tables fall into two kinds, handled differently:
// - "Owned" tables (estimates, sales_orders, job_orders, tickets) have a real per-user
//   visibility boundary (a rep only sees their own orders, etc). A regex/text check on
//   LLM-generated SQL can't reliably enforce that -- it can't catch an `IN (5, 12)` that
//   smuggles another rep's id in alongside the caller's own, and there's no SQL parser
//   here to verify it properly. So for non-admins these are never queried live: we
//   pre-fetch *only* the rows this user is already allowed to see (via the exact same
//   resolveScope()/ticketVisibilityClause() helpers the Dashboard and Tickets routes
//   use) and hand that fixed snapshot to the model as data. It structurally cannot
//   answer from anything outside that snapshot.
// - "Catalog" tables (customers, suppliers, inventories, service_items, departments,
//   chart_of_accounts) have no per-user ownership concept at all -- a price list or
//   customer directory isn't "owned" by anyone the way a sales order is. Text-to-SQL
//   against these is safe for every authenticated user, admin or not, so both paths can
//   use it.
// System Admin additionally gets the owned tables via validated SQL too, since an admin
// has no personal-scope boundary to begin with.
// gpt-4o-mini was too weak for what this prompt asks of it. The prompt below is a large
// one -- full schema, the employee directory, pre-fetched orders -- and on top of reading
// all that it has to translate a question into correct SQL, or answer in the user's own
// mix of English/Cebuano/Tagalog. Mini's failures were quiet rather than loud: plausible
// SQL against the wrong column, and confidently wrong arithmetic (see
// lib/unitConversion.js for the conversion case, which is now answered in code before it
// ever reaches the model).
//
// Env-overridable because the token cost here is dominated by the prompt, not the reply,
// so the model is the one lever that moves the bill -- it can be tuned per install
// without a redeploy.
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

const CATALOG_TABLES = [
  'customers', 'suppliers', 'departments', 'inventories', 'inventory_locations',
  'chart_of_accounts', 'service_items', 'employees', 'sales_divisions', 'locations',
];
const OWNED_TABLES = [
  'estimates', 'sales_orders', 'job_orders', 'tickets', 'purchase_orders',
  'purchase_requisitions', 'vendor_bills', 'sales_invoices',
];
// `users` (password_hash, JWT-relevant fields) and `audit_logs` (system internals) stay
// excluded entirely. `employees` has no sensitive columns (no salary/SSN/address, just
// name/department/position/contact info, the same fields anyone with Employees page
// view access already sees) so it's a catalog table like any other -- real SQL (a real
// COUNT(*), not the model hand-counting a JSON array) for aggregate/list questions.
// Single-named-person lookups still go through fetchEmployeeDirectory's pre-fetched
// snapshot instead (see findNameMatches) -- that's a different failure mode (the model
// picking the wrong row out of a long list), not one SQL fixes.
const ADMIN_ALLOWED_TABLES = [...CATALOG_TABLES, ...OWNED_TABLES];

const CATALOG_SCHEMA_DESCRIPTION = `
customers(id, customer_code, name, company_name, credit_limit, is_active)
suppliers(id, supplier_code, name, company_name, is_active)
departments(id, name, description, head_user_id, is_active)
inventories(id, item_code, display_name, item_type, selling_price, average_cost, reorder_point, is_active)
inventory_locations(id, inventory_id -> inventories.id, location_id -> locations.id, qty_on_hand, qty_committed)
locations(id, location_code, location_name, location_type [one of: Branch, Warehouse, Design, Damaged, Delivery Charge, Technical, Subcon, Other], is_active) -- warehouses and branches. People name these in shorthand ("DPOD", "WH04", "Central"), so match with LIKE against BOTH location_name and location_code; stock questions about a named place JOIN inventory_locations to this table rather than guessing at location_id.
chart_of_accounts(id, account_code, account_name, account_type, is_active)
service_items(id, item_code, display_name, unit_price, is_active)
employees(id, employee_code, first_name, last_name, department_id -> departments.id, position_title, is_active)
sales_divisions(id, name, is_active)
`.trim();

// Status/priority columns are stored as underscore_case machine values, not the
// human phrasing a question uses ("pending for customer approval" typed by a user is
// really the stored 'pending_customer_approval') -- spelling out the exact valid
// values here is what keeps a LIKE-based guess from confidently matching zero rows.
// The estimates/sales_orders lists are the real ENUM definitions (exhaustive); the
// rest are plain VARCHAR columns so the listed values are what's actually been
// observed in the data, not a guaranteed-exhaustive set.
const OWNED_SCHEMA_DESCRIPTION = `
estimates(id, estimate_no, date_created, customer_id -> customers.id, sales_division_id, contract_description, status [one of: pending_supervisor_approval, pending_customer_approval, approved, cancelled, disapproved], total_amount)
sales_orders(id, sales_order_no, estimate_id -> estimates.id, date_created, customer_id -> customers.id, sales_division_id, status [one of: pending_for_jo, jo_in_process, pending_delivery, partially_delivered, pending_billing, pending_billing_partially_delivered, partially_billed, billed, cancelled], total_amount)
job_orders(id, job_order_no, sales_order_id -> sales_orders.id, description, quantity, status [e.g. 'Planned - Pending for BOM', 'Released', 'Completed'], sub_status [e.g. 'For Artist', 'For Design Supervisor', 'Approved', 'For QI'], planned_start_at, planned_end_at, layout_started_at, layout_ended_at)
tickets(id, ticket_no, department_id -> departments.id, subject, description, status [one of: open, in_progress, resolved, closed], priority [one of: low, normal, high], created_at, resolved_at)
purchase_orders(id, po_no, date_created, supplier_id -> suppliers.id, status [e.g. 'pending_approval', 'pending_approval_gm', 'approved'], subtotal, net_of_tax, tax_amount)
purchase_requisitions(id, pr_no, date_created, department_id -> departments.id, status [e.g. 'pending_request', 'request_in_process'])
vendor_bills(id, bill_no, purchase_order_id -> purchase_orders.id, date_created, date_due, gross_amount)
sales_invoices(id, invoice_no, sales_order_id -> sales_orders.id, date_created, date_due, subtotal)
`.trim();

const FK_NOTE = 'Note: "X -> Y.id" means that column is a foreign key you can JOIN to table Y.';

const WRITE_KEYWORDS = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|replace|into\s+outfile|load_file|call|exec)\b/i;

function extractTableNames(sql) {
  const names = [];
  const re = /\b(?:from|join)\s+`?(\w+)`?/gi;
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(sql))) names.push(m[1].toLowerCase());
  return names;
}

// The actual security boundary -- not the LLM's good behavior. `allowedTables` is the
// only thing that differs between the admin call site and the catalog-only call site.
function validateSql(sql, allowedTables) {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  if (/;/.test(trimmed)) return { ok: false, reason: 'multiple statements' };
  if (!/^select\s/i.test(trimmed)) return { ok: false, reason: 'not a SELECT' };
  if (WRITE_KEYWORDS.test(trimmed)) return { ok: false, reason: 'write/DDL keyword' };
  if (/--|\/\*|#/.test(trimmed)) return { ok: false, reason: 'comment syntax' };

  const tables = extractTableNames(trimmed);
  if (tables.length === 0) return { ok: false, reason: 'no table referenced' };
  const disallowed = tables.filter((t) => !allowedTables.includes(t));
  if (disallowed.length) return { ok: false, reason: `disallowed table(s): ${disallowed.join(', ')}` };

  const withLimit = /\blimit\s+\d+/i.test(trimmed) ? trimmed : `${trimmed} LIMIT 20`;
  return { ok: true, sql: withLimit };
}

// Pull a SELECT statement out of an LLM reply that may have wrapped it in prose ("Let me
// look that up... SELECT ...") or a markdown code fence. Returns null when there's no real
// query (a greeting / conversational reply), so the caller returns that text as-is.
function extractSelect(text) {
  const cleaned = String(text).replace(/```sql|```/gi, '').trim();
  if (!/\bselect\b[\s\S]*\bfrom\b/i.test(cleaned)) return null;
  return cleaned.slice(cleaned.search(/\bselect\b/i)).trim();
}

// Sanitize the client-supplied conversation history into OpenAI chat messages, so a
// follow-up question ("what about his supervisor?", "and last month?") can be resolved
// against what was just said. Only prior user/assistant turns, capped for prompt size.
// Order/estimate/JO numbers referenced in the question (or recent history) that we should
// fetch on demand -- so "who created SO-65154?" works even when that order is older than the
// capped recent-records snapshot. Still scoped to what the user may see when fetched.
// NSTDJO is listed first so the alternation prefers it, though the leading \b already stops
// "NSTDJO-171" from also matching as "JO-171" (there is no word boundary between D and J).
function extractOrderRefs(text) {
  const found = new Set((String(text).toUpperCase().match(/\b(?:NSTDJO|SO|EST|JO)-\d+(?:-\d+)*\b/g) || []));
  return {
    so: [...found].filter((r) => r.startsWith('SO-')),
    est: [...found].filter((r) => r.startsWith('EST-')),
    jo: [...found].filter((r) => r.startsWith('JO-')),
    nstdjo: [...found].filter((r) => r.startsWith('NSTDJO-')),
  };
}

function historyMessages(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .slice(-8)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 600) }));
}

async function chatCompletion(messages) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: OPENAI_MODEL, temperature: 0, messages }),
  });
  if (!res.ok) throw new Error(`OpenAI request failed: ${res.status}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

function formatRows(rows) {
  if (!rows.length) return 'No matching records found.';
  return rows
    .slice(0, 20)
    .map((row) => Object.entries(row).map(([k, v]) => `${k}: ${v ?? '—'}`).join(', '))
    .join('\n');
}

// Deliberately data, not text-to-SQL -- see the module comment. Text-to-SQL turned out
// to be unreliable specifically for personnel/org-directory questions (the model would
// self-refuse "what department is X in" even with the FK relationship spelled out,
// seemingly out of an overcautious reflex around anything shaped like an employee
// lookup). Handing over the directory as plain data sidesteps that reflex entirely and
// is small/cheap either way.
async function fetchEmployeeDirectory() {
  const [rows] = await pool.query(
    `SELECT e.first_name, e.last_name, d.name AS department_name, e.position_title,
            e.is_active, u.is_supervisor
     FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN users u ON u.employee_id = e.id
     LIMIT 400`
  );
  return rows;
}

// A 271-row JSON array is enough for the model to reliably lose track of which row is
// which -- verified this directly: fed it a directory containing the single correct
// row for "Arjie Bayagna" (department: Sales - 1) and it still answered "Production -
// DPOD" 100% of the time across repeated identical calls, even at temperature 0. Not
// randomness -- a "lost in a long list" failure. Pulling out anyone actually named in
// the question into their own small, unambiguous block fixes it: the model doesn't
// have to find the needle in the haystack if the needle is handed over separately.
function findNameMatches(question, directory) {
  const q = question.toLowerCase();
  return directory.filter((row) => {
    const first = (row.first_name || '').toLowerCase();
    const last = (row.last_name || '').toLowerCase();
    return (first.length > 2 && q.includes(first)) || (last.length > 2 && q.includes(last));
  });
}

// Admin has no scope filter, so pull the exact referenced order(s) with the joins a human would
// need (sales rep, prepared-by/creator, customer, status, dates) and hand them to the model as
// authoritative data. This makes "who is the sales rep of SO-X" / "who created SO-X" deterministic
// instead of depending on whatever SQL the model improvises (which was flaky -- right one run, empty
// or a hard error the next).
async function fetchReferencedOrders(contextText) {
  const refs = extractOrderRefs(contextText);
  const out = {};
  if (refs.so.length) {
    const [rows] = await pool.query(
      `SELECT so.sales_order_no, so.date_created, so.status, so.total_amount, c.name AS customer_name,
              CONCAT(rep.first_name, ' ', rep.last_name) AS sales_rep_name,
              NULLIF(TRIM(CONCAT(COALESCE(prep.first_name, ''), ' ', COALESCE(prep.last_name, ''))), '') AS prepared_by_name,
              e.estimate_no
       FROM sales_orders so
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN employees rep ON rep.id = so.sales_rep_id
       LEFT JOIN employees prep ON prep.id = so.prepared_by_id
       LEFT JOIN estimates e ON e.id = so.estimate_id
       WHERE so.sales_order_no IN (?)`, [refs.so]);
    if (rows.length) out.sales_orders = rows;
  }
  if (refs.est.length) {
    const [rows] = await pool.query(
      `SELECT e.estimate_no, e.date_created, e.status, e.total_amount, c.name AS customer_name,
              CONCAT(rep.first_name, ' ', rep.last_name) AS sales_rep_name,
              NULLIF(TRIM(CONCAT(COALESCE(prep.first_name, ''), ' ', COALESCE(prep.last_name, ''))), '') AS prepared_by_name
       FROM estimates e
       LEFT JOIN customers c ON c.id = e.customer_id
       LEFT JOIN employees rep ON rep.id = e.sales_rep_id
       LEFT JOIN employees prep ON prep.id = e.prepared_by_id
       WHERE e.estimate_no IN (?)`, [refs.est]);
    if (rows.length) out.estimates = rows;
  }
  if (refs.jo.length) {
    const [rows] = await pool.query(
      `SELECT jo.job_order_no, jo.status, jo.sub_status, jo.production_stage, jo.description, jo.quantity,
              so.sales_order_no, c.name AS customer_name,
              CONCAT(rep.first_name, ' ', rep.last_name) AS sales_rep_name,
              CONCAT(ar.first_name, ' ', ar.last_name) AS artist_name
       FROM job_orders jo
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN employees rep ON rep.id = so.sales_rep_id
       LEFT JOIN employees ar ON ar.id = jo.artist_id
       WHERE jo.job_order_no IN (?)`, [refs.jo]);
    if (rows.length) out.job_orders = rows;
  }
  if (refs.nstdjo.length) {
    // Guarded like the dashboard's NSTDJO figures -- these tables are not in every build.
    const [tbl] = await pool.query("SHOW TABLES LIKE 'non_standard_job_orders'");
    if (tbl.length) {
      const [rows] = await pool.query(
        `SELECT n.nstdjo_no, n.status, n.sub_status, n.description, n.quantity, n.delivery_date,
                c.name AS customer_name,
                CONCAT(rep.first_name, ' ', rep.last_name) AS sales_rep_name,
                CONCAT(ar.first_name, ' ', ar.last_name) AS artist_name
         FROM non_standard_job_orders n
         LEFT JOIN customers c ON c.id = n.customer_id
         LEFT JOIN employees rep ON rep.id = n.sales_rep_id
         LEFT JOIN employees ar ON ar.id = n.artist_employee_id
         WHERE n.nstdjo_no IN (?)`, [refs.nstdjo]);
      if (rows.length) out.non_standard_job_orders = rows;
    }
  }
  return out;
}

async function answerAsAdmin(question, history = []) {
  const directory = await fetchEmployeeDirectory();
  const namedMatches = findNameMatches(question, directory);
  const contextText = [question, ...historyMessages(history).map((m) => m.content)].join(' ');
  const referencedOrders = await fetchReferencedOrders(contextText);
  const hasRefs = Object.keys(referencedOrders).length > 0;

  const rawSql = await chatCompletion([
    {
      role: 'system',
      content: `You translate questions about an ERP's data into a single read-only MySQL SELECT statement, OR answer directly from pre-fetched employee directory data when that's sufficient.
Schema (only these tables/columns exist and may be used for SQL):
${CATALOG_SCHEMA_DESCRIPTION}
${OWNED_SCHEMA_DESCRIPTION}
${FK_NOTE}
${namedMatches.length ? `DIRECTLY_NAMED_EMPLOYEE(S) (extracted from the question -- this is the authoritative, exact data for them, use this over anything else for facts about them):
${JSON.stringify(namedMatches)}
` : ''}${hasRefs ? `REFERENCED_ORDERS (the exact SO/EST/JO number(s) named in the question, already fetched with their sales rep, prepared-by/creator, customer, status and dates -- this is authoritative. For any question about these specific orders, e.g. "who is the sales rep of SO-X", "who created SO-X" (that's prepared_by_name), "what's the status of JO-Y", answer straight from this data with "ANSWER: " and do NOT write SQL):
${JSON.stringify(referencedOrders)}
` : ''}EMPLOYEE_DIRECTORY_DATA (already fetched -- use ONLY for a question about one specific named person, e.g. "what department is X in". Do NOT use this for counts, totals, or lists spanning multiple employees -- you're prone to mis-counting a long JSON array by hand. For those, write a real SQL query against employees/departments instead, e.g. SELECT COUNT(*) FROM employees WHERE is_active = TRUE):
${JSON.stringify(directory)}
Rules:
- If the question is about ONE specific named person and EMPLOYEE_DIRECTORY_DATA/DIRECTLY_NAMED_EMPLOYEE(S) answers it, output the answer as plain text prefixed with "ANSWER: " (one or two sentences, no markdown).
- If the request isn't about this database at all, just answer it directly, prefixed with "ANSWER: ". This covers ANYTHING you can answer yourself -- general knowledge, unit conversion, arithmetic (e.g. "how many sqft is 2x2 ft"), checking grammar or spelling, rewriting or shortening a message, translating, drafting wording for a customer, explaining a term. The list is illustrative, not exhaustive: if you can answer it, do. Don't refuse and don't force it into a SQL query it was never asking for.
- NEVER reply that you only assist with ERP data and SQL queries, or anything to that effect. You are the assistant inside this ERP and you help with whatever the person asks; refusing an ordinary request because it isn't a database question is always wrong.
- Otherwise output ONLY a SQL statement. No markdown fences, no explanation, no trailing semicolon.
- SELECT only -- never write/modify data.
- Only reference the tables listed in the schema. Do not invent columns.
- Always include a LIMIT clause (20 or fewer rows) unless the question asks for a single aggregate.
- For name/code lookups, use LIKE '%...%' rather than an exact match unless the user gave a full, exact code -- a real item/customer/etc. is often referenced by a partial or approximate name. For status/priority columns, use an EXACT match (=) against one of the listed values -- never LIKE a human phrasing like "pending for customer approval" against the real stored value 'pending_customer_approval', map it to the exact value first.
- Zero rows back is a perfectly good, honest answer ("no matching record"). Prefer writing a best-effort query over refusing -- only output NO_QUERY if the question is about something genuinely outside this schema entirely (e.g. asks to modify data, or about a topic no table here covers).
- NEVER drop a condition the question asked for. If some part of it cannot be expressed against this schema -- a place, code or field you cannot resolve -- say so in plain text prefixed with "ANSWER: " instead of running a query without it. Quietly widening "negative stock in DPOD" into "negative stock anywhere" hands back the wrong set of rows as though it were the right one, and the person reading it has no way to tell.
- This is a running conversation. Use the earlier messages to resolve follow-up questions -- "his", "that order", "and last month?", "what about the second one" refer back to what was just discussed. The warm, conversational tone applies ONLY to ANSWER:/greeting replies.
- When you write SQL, output ONLY the SQL statement -- no sentence before or after it, no "let me look that up", no markdown. (The conversational phrasing of query results is added afterward.)
- For a greeting or small talk ("hi", "hello", "thanks", "how are you"), just reply warmly in plain text (e.g. "Hi! How can I help?") -- do NOT write SQL or output NO_QUERY.
- LANGUAGE. This company is in Cebu. People here write in English, Cebuano/Bisaya, Tagalog, or a mix of them in one sentence, and they will not switch to English for your benefit. Understand all of it and REPLY IN THE LANGUAGE THEY USED. "Pila ka estimates karon?" is "how many estimates today". "Kinsa ang artist sa JO-123?" is "who is the artist of JO-123". "Asa" = where, "unsa" = what, "pila" = how much/how many, "kanus-a" = when, "salamat" = thanks, "uy" is just a friendly particle carrying no meaning of its own.
- Casual remarks, jokes and complaints in any of those languages are conversation, not failed queries. Answer them like a colleague would -- briefly, in kind. NEVER reply that you do not understand simply because a message is not in English or is not about data; "laaya uy" ("feeling drained, huh") deserves a human reply, not an apology.`,
    },
    ...historyMessages(history),
    { role: 'user', content: question },
  ]);
  if (!rawSql || rawSql === 'NO_QUERY') return null;
  if (rawSql.startsWith('ANSWER:')) return rawSql.slice('ANSWER:'.length).trim();
  // The model should emit bare SQL, but may prepend a sentence. If the reply contains a
  // SELECT ... FROM, treat it as SQL (dropping any preamble); otherwise it's a plain
  // conversational reply (greeting / small talk) -- return it as-is.
  const extracted = extractSelect(rawSql);
  if (!extracted) return rawSql;

  const { ok, sql, reason } = validateSql(extracted, ADMIN_ALLOWED_TABLES);
  if (!ok) return `I couldn't safely answer that (${reason}). Try rephrasing.`;

  const [rows] = await pool.query(sql);
  return formatRows(rows);
}

// Real GROUP BY counts, uncapped -- the detail rows below are capped at 150 for
// prompt size, so asking the model to count "how many of my estimates are X" by
// scanning that array is exactly the same "lost in a long list" failure as the
// employee-count bug (verified: a rep with 50 estimates got a wrong count back that
// didn't match the data or even the fetched subset). Handing over the exact
// pre-computed breakdown removes the need for the model to count anything itself.
async function countByStatus(fromSql, alias, whereSql, params, statusCol = 'status') {
  const [rows] = await pool.query(
    `SELECT ${alias}.${statusCol} AS status, COUNT(*) AS count FROM ${fromSql} WHERE ${whereSql} GROUP BY ${alias}.${statusCol}`,
    params
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}

// Pulls exactly what resolveScope()/ticketVisibilityClause() already say this user may
// see -- the same helpers backing the Dashboard and Tickets routes -- capped per table
// so the prompt stays small. Nothing here is LLM-controlled.
// Weighted sales totalled per sales division, with a deliberate access rule:
//
//   System Admin / is_sales_manager -> every division
//   everyone else                   -> only divisions they are actually in
//   nobody who qualifies for neither -> nothing at all
//
// "Divisions they are in" is the union of two things, because neither alone is reliable:
// the SBU divisions explicitly assigned to them (user_sales_divisions, which is only ever
// populated for business-unit owners), and the divisions their own sales orders actually
// sit in -- which is what makes this work for an ordinary account officer who has no SBU
// row at all.
//
// Divisions outside that set are never queried, so the model cannot leak a figure it was
// merely instructed not to mention. It is told the difference between "no such division"
// and "not yours to see", so a rep asking about another division gets an honest refusal
// rather than being told the division does not exist.
// Only assembled when the question is actually about divisions. The full breakdown is ~500
// rows (11 divisions x ~45 months) and would otherwise be pasted into the prompt on every
// unrelated question, crowding out OWN_DATA and costing tokens for nothing.
//
// Division names in the data are inconsistently spaced -- "Sales-1" sits beside "Sales - 2"
// -- so both the mention test here and the matching instruction given to the model strip
// everything but letters and digits before comparing.
const normalizeDivision = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const BY_MONTH_CAP = 36;

async function fetchDivisionWeightedSales(user, employeeIds, contextText) {
  const [divisionRows] = await pool.query('SELECT id, name FROM sales_divisions');
  const ctx = normalizeDivision(contextText);
  const mentionsDivision = /division|sbu|weighted/i.test(contextText)
    || divisionRows.some((d) => d.name && ctx.includes(normalizeDivision(d.name)));
  if (!mentionsDivision) return null;

  const [[me]] = await pool.query(
    'SELECT account_type, is_sales_manager FROM users WHERE id = ?', [user.id]
  );
  const seesAll = me?.account_type === 'System Admin' || !!me?.is_sales_manager;

  let allowedIds = null; // null means unrestricted
  if (!seesAll) {
    const [owned] = await pool.query(
      'SELECT sales_division_id AS id FROM user_sales_divisions WHERE user_id = ?', [user.id]
    );
    const ids = new Set(owned.map((r) => Number(r.id)).filter(Boolean));
    if (employeeIds.length) {
      const placeholders = employeeIds.map(() => '?').join(', ');
      const [fromOwnOrders] = await pool.query(
        `SELECT DISTINCT so.sales_division_id AS id FROM sales_orders so
          WHERE so.sales_rep_id IN (${placeholders}) AND so.sales_division_id IS NOT NULL`,
        employeeIds
      );
      for (const r of fromOwnOrders) ids.add(Number(r.id));
    }
    allowedIds = [...ids];
    if (!allowedIds.length) return { access: 'none', divisions: [] };
  }

  const where = allowedIds
    ? `WHERE so.date_created IS NOT NULL AND so.sales_division_id IN (${allowedIds.map(() => '?').join(', ')})`
    : 'WHERE so.date_created IS NOT NULL';
  const [rows] = await pool.query(
    `SELECT sd.name AS division, DATE_FORMAT(so.date_created, '%Y-%m') AS month,
            COUNT(*) AS orders, COALESCE(SUM(so.total_amount), 0) AS amount
       FROM sales_orders so
       JOIN sales_divisions sd ON sd.id = so.sales_division_id
       ${where}
      GROUP BY sd.name, month
      ORDER BY sd.name, month DESC`,
    allowedIds || []
  );

  const byDivision = new Map();
  for (const r of rows) {
    if (!byDivision.has(r.division)) {
      byDivision.set(r.division, { division: r.division, orders: 0, amount: 0, by_month: [] });
    }
    const bucket = byDivision.get(r.division);
    bucket.orders += Number(r.orders);
    bucket.amount += Number(r.amount);
    bucket.by_month.push({ month: r.month, orders: Number(r.orders), amount: Number(r.amount) });
  }
  return {
    access: seesAll ? 'all' : 'own',
    // `amount`/`orders` are all-time and exact; by_month is trimmed to the most recent
    // months so an 11-division breakdown stays a sane size in the prompt. Trimming the list
    // rather than the query is what keeps the all-time total honest.
    note: `amount and orders are all-time totals; by_month covers the most recent ${BY_MONTH_CAP} months only`,
    divisions: [...byDivision.values()].map((d) => ({
      ...d,
      amount: Number(d.amount.toFixed(2)),
      by_month: d.by_month.slice(0, BY_MONTH_CAP),
    })),
  };
}

async function fetchOwnScopeSnapshot(user, contextText = '') {
  const scope = await resolveScope(user.id);
  const employeeIds = scope.employeeIds || [];
  const snapshot = {};
  const refs = extractOrderRefs(contextText);

  if (employeeIds.length) {
    const placeholders = employeeIds.map(() => '?').join(', ');
    const [estimates] = await pool.query(
      `SELECT e.estimate_no, e.date_created, e.status, e.total_amount, c.name AS customer_name,
              CONCAT(rep.first_name, ' ', rep.last_name) AS sales_rep_name
       FROM estimates e
       LEFT JOIN customers c ON c.id = e.customer_id
       LEFT JOIN employees rep ON rep.id = e.sales_rep_id
       WHERE e.sales_rep_id IN (${placeholders}) ORDER BY e.date_created DESC LIMIT 150`,
      employeeIds
    );
    const [salesOrders] = await pool.query(
      `SELECT so.sales_order_no, so.date_created, so.status, so.total_amount, c.name AS customer_name,
              CONCAT(rep.first_name, ' ', rep.last_name) AS sales_rep_name,
              COALESCE(NULLIF(CONCAT(prep.first_name, ' ', prep.last_name), ' '), CONCAT(rep.first_name, ' ', rep.last_name)) AS prepared_by_name
       FROM sales_orders so
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN employees rep ON rep.id = so.sales_rep_id
       LEFT JOIN employees prep ON prep.id = so.prepared_by_id
       WHERE so.sales_rep_id IN (${placeholders}) ORDER BY so.date_created DESC LIMIT 150`,
      employeeIds
    );
    const [jobOrders] = await pool.query(
      `SELECT jo.job_order_no, jo.status, jo.sub_status, jo.description, jo.quantity, c.name AS customer_name,
              CONCAT(ar.first_name, ' ', ar.last_name) AS artist_name
       FROM job_orders jo
       JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN employees ar ON ar.id = jo.artist_id
       WHERE so.sales_rep_id IN (${placeholders}) ORDER BY jo.id DESC LIMIT 150`,
      employeeIds
    );
    // Pull any specifically-referenced order that fell outside the recent-records cap above,
    // still scoped to this user's own reps, and merge it in (dedup by number).
    const mergeByNo = (list, extra, key) => {
      const seen = new Set(list.map((r) => r[key]));
      for (const r of extra) if (!seen.has(r[key])) list.push(r);
    };
    if (refs.so.length) {
      const [rows] = await pool.query(
        `SELECT so.sales_order_no, so.date_created, so.status, so.total_amount, c.name AS customer_name,
                CONCAT(rep.first_name, ' ', rep.last_name) AS sales_rep_name,
                COALESCE(NULLIF(CONCAT(prep.first_name, ' ', prep.last_name), ' '), CONCAT(rep.first_name, ' ', rep.last_name)) AS prepared_by_name
         FROM sales_orders so
         LEFT JOIN customers c ON c.id = so.customer_id
         LEFT JOIN employees rep ON rep.id = so.sales_rep_id
         LEFT JOIN employees prep ON prep.id = so.prepared_by_id
         WHERE so.sales_order_no IN (?) AND so.sales_rep_id IN (${placeholders})`,
        [refs.so, ...employeeIds]);
      mergeByNo(salesOrders, rows, 'sales_order_no');
    }
    if (refs.est.length) {
      const [rows] = await pool.query(
        `SELECT e.estimate_no, e.date_created, e.status, e.total_amount, c.name AS customer_name,
                CONCAT(rep.first_name, ' ', rep.last_name) AS sales_rep_name
         FROM estimates e
         LEFT JOIN customers c ON c.id = e.customer_id
         LEFT JOIN employees rep ON rep.id = e.sales_rep_id
         WHERE e.estimate_no IN (?) AND e.sales_rep_id IN (${placeholders})`,
        [refs.est, ...employeeIds]);
      mergeByNo(estimates, rows, 'estimate_no');
    }
    if (refs.jo.length) {
      const [rows] = await pool.query(
        `SELECT jo.job_order_no, jo.status, jo.sub_status, jo.description, jo.quantity, c.name AS customer_name,
                CONCAT(ar.first_name, ' ', ar.last_name) AS artist_name
         FROM job_orders jo
         JOIN sales_orders so ON so.id = jo.sales_order_id
         LEFT JOIN customers c ON c.id = so.customer_id
         LEFT JOIN employees ar ON ar.id = jo.artist_id
         WHERE jo.job_order_no IN (?) AND so.sales_rep_id IN (${placeholders})`,
        [refs.jo, ...employeeIds]);
      mergeByNo(jobOrders, rows, 'job_order_no');
    }
    snapshot.estimates = estimates;
    snapshot.sales_orders = salesOrders;
    snapshot.job_orders = jobOrders;
    snapshot.estimates_count_by_status = await countByStatus('estimates e', 'e', `e.sales_rep_id IN (${placeholders})`, employeeIds);
    snapshot.sales_orders_count_by_status = await countByStatus('sales_orders so', 'so', `so.sales_rep_id IN (${placeholders})`, employeeIds);
    snapshot.job_orders_count_by_status = await countByStatus(
      'job_orders jo JOIN sales_orders so ON so.id = jo.sales_order_id', 'jo',
      `so.sales_rep_id IN (${placeholders})`, employeeIds
    );

    // Weighted sales = SUM(sales_orders.total_amount) by the month the order was created,
    // the same definition the Dashboard's own figure uses (repMetrics in routes/dashboard.js),
    // so the assistant and the dashboard can never quote different numbers.
    //
    // Pre-computed per month rather than left to the model to add up the array above: that
    // array is capped at the 150 most recent orders, so a question about an older month would
    // silently under-report, and hand-summing a long list is exactly the failure the
    // *_count_by_status objects already exist to avoid.
    const [weightedByMonth] = await pool.query(
      `SELECT DATE_FORMAT(so.date_created, '%Y-%m') AS month, COUNT(*) AS orders,
              COALESCE(SUM(so.total_amount), 0) AS amount
         FROM sales_orders so
        WHERE so.sales_rep_id IN (${placeholders}) AND so.date_created IS NOT NULL
        GROUP BY month ORDER BY month DESC LIMIT 36`,
      employeeIds
    );
    snapshot.my_weighted_sales_by_month = weightedByMonth.map((r) => ({
      month: r.month, orders: Number(r.orders), amount: Number(r.amount),
    }));
  }

  // Sales-rep scope (above) doesn't cover an artist's own assigned work -- job_orders
  // links to an artist via artist_id directly, not through the sales order's rep.
  // Mirrors assignedJobOrders.js's own GET / scoping (WHERE artist_id = own employee_id).
  const [[me]] = await pool.query('SELECT employee_id FROM users WHERE id = ?', [user.id]);
  if (me?.employee_id) {
    const [assignedAsArtist] = await pool.query(
      `SELECT jo.job_order_no, jo.status, jo.sub_status, jo.description, jo.quantity, c.name AS customer_name
       FROM job_orders jo
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       WHERE jo.artist_id = ? ORDER BY jo.id DESC LIMIT 150`,
      [me.employee_id]
    );
    if (assignedAsArtist.length) {
      const existing = snapshot.job_orders || [];
      const seen = new Set(existing.map((r) => r.job_order_no));
      snapshot.job_orders = [...existing, ...assignedAsArtist.filter((r) => !seen.has(r.job_order_no))];
    }
    const artistCounts = await countByStatus('job_orders jo', 'jo', 'jo.artist_id = ?', [me.employee_id]);
    const merged = { ...(snapshot.job_orders_count_by_status || {}) };
    for (const [status, count] of Object.entries(artistCounts)) merged[status] = (merged[status] || 0) + count;
    if (Object.keys(merged).length) snapshot.job_orders_count_by_status = merged;
  }

  const { sql: ticketSql, params: ticketParams } = await ticketVisibilityClause(user.id);
  const [tickets] = await pool.query(
    `SELECT t.ticket_no, d.name AS department_name, t.subject, t.status, t.priority, t.created_at
     FROM tickets t JOIN departments d ON d.id = t.department_id
     WHERE ${ticketSql} ORDER BY t.id DESC LIMIT 100`,
    ticketParams
  );
  snapshot.tickets = tickets;
  snapshot.tickets_count_by_status = await countByStatus('tickets t', 't', ticketSql, ticketParams);

  // Basic org-directory info (not personal-scope data) -- available to everyone
  // regardless of sales/artist/ticket scope, same as walking up to a coworker and
  // asking "what department is X in" or "is X still active". No email/phone here
  // since this path, unlike the Employees page itself, has no page-permission gate.
  snapshot.employee_directory = await fetchEmployeeDirectory();
  const divisionSales = await fetchDivisionWeightedSales(user, employeeIds, contextText);
  if (divisionSales) snapshot.weighted_sales_by_division = divisionSales;

  return snapshot;
}

async function answerFromOwnScope(user, question, history = []) {
  // Include the recent history text so a follow-up ("who created that?") still surfaces the
  // order number mentioned a turn earlier, and it gets fetched on demand.
  const contextText = `${question}\n${historyMessages(history).map((m) => m.content).join('\n')}`;
  const snapshot = await fetchOwnScopeSnapshot(user, contextText);
  const namedMatches = findNameMatches(question, snapshot.employee_directory);
  // Looking up a document the user names by number is deliberately NOT scoped to what they
  // own. "What is the status of JO-61829-1" is the same question whoever asks it, and the
  // answer is already on the Job Orders / NSTDJO pages every one of these users can open --
  // a Design Supervisor could see the order on screen and not through the assistant, which
  // read as the assistant being broken. Ownership still governs OWN_DATA below, so "my"
  // questions and every total stay personal; this only covers documents asked for by name.
  const referencedOrders = await fetchReferencedOrders(contextText);
  const hasRefs = Object.keys(referencedOrders).length > 0;

  const rawReply = await chatCompletion([
    {
      role: 'system',
      content: `You answer questions about an ERP user's own data. Two sources are available:

1. OWN_DATA below -- this user's own estimates/sales_orders/job_orders/tickets (or their team's, if they're a supervisor), plus a general employee_directory (name/department/position/active-status for any employee, not personal) for looking up ONE specific named person. This is fixed, already-fetched data -- use it directly, don't write SQL for it, and never claim to know anything about these topics beyond what's here. For "how many of my X are status Y" questions, use the matching *_count_by_status object (e.g. estimates_count_by_status) -- it's an exact, pre-computed breakdown, so use it instead of counting the estimates/sales_orders/job_orders/tickets arrays by hand, which you're prone to getting wrong on a long list. Status values there are the real stored values (e.g. 'pending_customer_approval'), not English phrasing -- match the closest one. For "my weighted sales" in a given month or year, use my_weighted_sales_by_month (months are 'YYYY-MM', amount is the peso total) -- it is exact and complete, whereas the sales_orders array is capped at the 150 most recent and would under-report an older month. Sum the relevant months for a year or a range.
${namedMatches.length ? `DIRECTLY_NAMED_EMPLOYEE(S) (extracted from the question -- this is the authoritative, exact data for them within employee_directory, use this over anything else for facts about them):
${JSON.stringify(namedMatches)}
` : ''}${hasRefs ? `REFERENCED_DOCUMENTS (the exact order(s) named in the question, looked up directly -- authoritative, and NOT limited to what this user owns. Use this over OWN_DATA for facts about these documents, and answer from it even when the document is not in OWN_DATA):
${JSON.stringify(referencedOrders)}
` : ''}OWN_DATA:
${JSON.stringify(snapshot)}

2. A separate read-only SQL option for catalog/reference data (item pricing, customer/supplier directory, chart of accounts, employees/departments) -- this data isn't personal to any one user, so it's fine to query live. For counts, totals, or lists spanning multiple employees specifically (not OWN_DATA's single-named-person case above), use this instead of counting employee_directory by hand -- e.g. SELECT COUNT(*) FROM employees WHERE is_active = TRUE:
${CATALOG_SCHEMA_DESCRIPTION}
${FK_NOTE}

Rules:
- If REFERENCED_DOCUMENTS, OWN_DATA, or DIRECTLY_NAMED_EMPLOYEE(S) answers the question, reply with plain text (one or two sentences, no markdown, no prefix).
- A question naming a specific document (e.g. "what is the status of JO-1234-1", "who is the artist of NSTDJO-171") is answered from REFERENCED_DOCUMENTS. Do not refuse it or call it unavailable because it is absent from OWN_DATA -- OWN_DATA only lists this user's own recent records, and REFERENCED_DOCUMENTS is the authoritative lookup. If a named document is missing from REFERENCED_DOCUMENTS too, then it genuinely does not exist -- say the number was not found.
- "My"/"our"/"mine" questions, and every personal count or total, come from OWN_DATA only. Never total up REFERENCED_DOCUMENTS as though it were the user's own book of work.
- For weighted sales of a named sales division (e.g. "total weighted sales of SALES-1"), use OWN_DATA.weighted_sales_by_division. Match the division name case-insensitively and ignore spacing/hyphens ("SALES-1", "Sales 1" and "sales-1" are the same division). Use its \`amount\` for an all-time total, or its \`by_month\` entries ('YYYY-MM') for a specific month or year. This is a whole-division figure covering every rep in it -- do not confuse it with the user's own my_weighted_sales_by_month.
- weighted_sales_by_division.access says what this user may see: 'all' = every division; 'own' = only the divisions listed, which are the ones they belong to; 'none' = they are in no division. If they ask about a division that is NOT in the list, say plainly that they do not have access to that division's figures -- do NOT say it doesn't exist, do NOT guess, and do NOT answer with a different division's number. If weighted_sales_by_division is absent entirely, you have no division figures at all -- say so rather than improvising one from the sales_orders array.
- If the request isn't about this database at all, just answer it directly as plain text. This covers ANYTHING you can answer yourself -- general knowledge, unit conversion, arithmetic (e.g. "how many sqft is 2x2 ft"), checking grammar or spelling, rewriting or shortening a message, translating, drafting wording for a customer, explaining a term. The list is illustrative, not exhaustive: if you can answer it, do. Don't refuse and don't force it into a SQL query it was never asking for.
- NEVER reply that you only assist with ERP data and SQL queries, or anything to that effect. You are the assistant inside this ERP and you help with whatever the person asks; refusing an ordinary request because it isn't a database question is always wrong.
- If it needs the catalog schema instead, output ONLY a SQL SELECT statement (no markdown fences, no explanation, no trailing semicolon, no write/DDL keywords, only the tables listed above, include a LIMIT of 20 or fewer unless it's a single aggregate). For name/code lookups use LIKE '%...%' rather than an exact match unless given a full, exact code. For status/priority columns use an EXACT match against a real stored value, not a LIKE against human phrasing. Zero rows back is a fine, honest answer -- prefer writing a best-effort query over refusing.
- NEVER drop a condition the question asked for. If some part of it cannot be expressed against this schema -- a place, code or field you cannot resolve -- say so in plain text instead of running a query without it. Quietly widening "negative stock in DPOD" into "negative stock anywhere" hands back the wrong rows as though they were the right ones.
- Never write SQL referencing estimates, sales_orders, job_orders, non_standard_job_orders, tickets, or users -- those come only from OWN_DATA and REFERENCED_DOCUMENTS (users isn't available anywhere).
- If neither source can answer it, reply in plain text saying so.
- This is a running conversation -- use the earlier messages to resolve follow-up questions ("his", "that order", "and last month?"). Keep plain-text answers warm and conversational, like a helpful colleague.
- LANGUAGE. This company is in Cebu. People here write in English, Cebuano/Bisaya, Tagalog, or a mix of them in one sentence, and they will not switch to English for your benefit. Understand all of it and REPLY IN THE LANGUAGE THEY USED. "Pila ka estimates nako karon?" is "how many estimates do I have today". "Asa" = where, "unsa" = what, "pila" = how much/how many, "kinsa" = who, "kanus-a" = when, "salamat" = thanks, "uy" is a friendly particle carrying no meaning of its own.
- Casual remarks, jokes and complaints in any of those languages are conversation, not failed queries. Answer them like a colleague would -- briefly, in kind. NEVER reply that you do not understand simply because a message is not in English or is not about data; "laaya uy" ("feeling drained, huh") deserves a human reply, not an apology.`,
    },
    ...historyMessages(history),
    { role: 'user', content: question },
  ]);

  const trimmed = rawReply.trim();
  const extracted = extractSelect(trimmed);
  if (extracted) {
    const { ok, sql, reason } = validateSql(extracted, CATALOG_TABLES);
    if (!ok) return `I couldn't safely answer that (${reason}). Try rephrasing.`;
    const [rows] = await pool.query(sql);
    return formatRows(rows);
  }
  return trimmed;
}

async function runSqlFallback(user, question, history = []) {
  if (!process.env.OPENAI_API_KEY) return null;

  const [[row]] = await pool.query('SELECT account_type FROM users WHERE id = ?', [user.id]);
  const isAdmin = row?.account_type === 'System Admin';

  return isAdmin ? answerAsAdmin(question, history) : answerFromOwnScope(user, question, history);
}

module.exports = { runSqlFallback, validateSql, ADMIN_ALLOWED_TABLES, CATALOG_TABLES };
