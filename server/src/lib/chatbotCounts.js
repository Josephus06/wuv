const pool = require('../db');

// "How many estimates were created today?" -- answered in a sentence, with the split by sales
// division, without asking the model anything.
//
// WHY NOT LEAVE IT TO THE LLM. It already answers this, but by writing SQL and handing back the
// raw result set: "COUNT(*): 14". That is serviceable on screen and useless out loud, which is the
// whole point now that the assistant can be asked by voice. It is also the single most-asked
// question in the place, so it is worth being exact, instant and free rather than a model call
// that might phrase it differently every time.
//
// Anything this cannot parse with certainty returns null and the model path runs as before -- the
// same contract as lib/unitConversion.js.

const ENTITIES = [
  // Longest names first: "non standard job order" must win before "job order" matches inside it.
  {
    key: 'nstdjo',
    match: /\b(nstdjo|non[- ]?standard job orders?)\b/i,
    table: 'non_standard_job_orders',
    singular: 'non-standard job order',
    plural: 'non-standard job orders',
  },
  {
    key: 'sales_order',
    match: /\b(sales orders?|s\.?o\.?s?)\b/i,
    table: 'sales_orders',
    singular: 'sales order',
    plural: 'sales orders',
  },
  {
    key: 'estimate',
    match: /\b(estimates?|quotations?|quotes?)\b/i,
    table: 'estimates',
    singular: 'estimate',
    plural: 'estimates',
  },
];

// Only asks about a COUNT. "Show me today's estimates" is a list, which is a different answer and
// belongs to the model.
const COUNTING = /\b(how many|how much|count|total number|pila(\s+ka)?|ilan)\b/i;

// The periods people actually ask for. Each gives a SQL predicate on date_created and the words to
// open the sentence with.
const PERIODS = [
  { match: /\b(today|karon nga adlaw|karon|ngayon)\b/i, sql: 'e.date_created = CURDATE()', lead: 'Today' },
  { match: /\byesterday\b/i, sql: 'e.date_created = CURDATE() - INTERVAL 1 DAY', lead: 'Yesterday', past: true },
  {
    match: /\b(this week|week)\b/i,
    sql: 'YEARWEEK(e.date_created, 1) = YEARWEEK(CURDATE(), 1)',
    lead: 'This week',
  },
  {
    match: /\blast month\b/i,
    sql: "DATE_FORMAT(e.date_created, '%Y-%m') = DATE_FORMAT(CURDATE() - INTERVAL 1 MONTH, '%Y-%m')",
    lead: 'Last month',
    past: true,
  },
  {
    match: /\b(this month|month|karong buwana)\b/i,
    sql: "DATE_FORMAT(e.date_created, '%Y-%m') = DATE_FORMAT(CURDATE(), '%Y-%m')",
    lead: 'This month',
  },
  { match: /\b(this year|year)\b/i, sql: 'YEAR(e.date_created) = YEAR(CURDATE())', lead: 'This year' },
];

// "Sales - 2" and "Sales-1" are the same kind of name typed two ways. Spoken aloud the punctuation
// is noise, and on screen it is just untidy.
function tidyDivision(name) {
  return String(name || '').replace(/\s*-\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

// "a, b and c" -- the way a person reads a list out.
function joinList(parts) {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function parseCountQuestion(message) {
  const text = String(message || '');
  if (!COUNTING.test(text)) return null;
  const entity = ENTITIES.find((e) => e.match.test(text));
  if (!entity) return null;
  const period = PERIODS.find((p) => p.match.test(text));
  if (!period) return null;
  return { entity, period };
}

// Mirrors the division scoping already used for weighted sales in lib/sqlFallback.js: a System
// Admin or a sales manager sees every division, everyone else sees only the divisions they are
// assigned to. Somebody in no division at all gets null -- the model path can answer from their
// own records rather than this returning a company-wide figure they should not see.
async function divisionScope(userId) {
  const [[me]] = await pool.query(
    'SELECT account_type, is_sales_manager FROM users WHERE id = ?', [userId]);
  if (me?.account_type === 'System Admin' || me?.is_sales_manager) return { all: true, ids: null };
  const [own] = await pool.query(
    'SELECT sales_division_id AS id FROM user_sales_divisions WHERE user_id = ?', [userId]);
  const ids = own.map((r) => Number(r.id)).filter(Boolean);
  return ids.length ? { all: false, ids } : null;
}

async function answerCountQuestion(user, message) {
  const parsed = parseCountQuestion(message);
  if (!parsed) return null;
  const { entity, period } = parsed;

  const scope = await divisionScope(user.id);
  if (!scope) return null;

  const params = [];
  let where = period.sql;
  if (!scope.all) {
    where += ` AND e.sales_division_id IN (${scope.ids.map(() => '?').join(', ')})`;
    params.push(...scope.ids);
  }

  const [rows] = await pool.query(
    `SELECT sd.name AS division, COUNT(*) AS n
       FROM ${entity.table} e
       LEFT JOIN sales_divisions sd ON sd.id = e.sales_division_id
      WHERE ${where}
      GROUP BY sd.name
      ORDER BY n DESC, sd.name`,
    params);

  const total = rows.reduce((s, r) => s + Number(r.n), 0);
  const mine = scope.all ? '' : ' in your divisions';
  const noun = total === 1 ? entity.singular : entity.plural;

  if (!total) {
    return period.past
      ? `${period.lead}${mine} there were no ${entity.plural}.`
      : `${period.lead}${mine} there are no ${entity.plural} yet.`;
  }

  const named = rows.filter((r) => r.division);
  const unassigned = rows.filter((r) => !r.division).reduce((s, r) => s + Number(r.n), 0);

  // A year's worth of work spreads across nine or ten divisions, and hearing ten figures read out
  // is not an answer -- it is a recital. The largest few are named and the tail is given as one
  // honest lump, so the numbers still add up to the total.
  // Lumping a single leftover division reads worse than naming it ("8 across 1 other division"),
  // so the tail only becomes a lump once there are at least two of them.
  const NAMED_LIMIT = 6;
  const cut = named.length <= NAMED_LIMIT + 1 ? named.length : NAMED_LIMIT;
  const shown = named.slice(0, cut);
  const rest = named.slice(cut);
  const parts = shown.map((r) => `${r.n} from ${tidyDivision(r.division)}`);
  if (rest.length) {
    const restTotal = rest.reduce((s, r) => s + Number(r.n), 0);
    parts.push(`${restTotal} across ${rest.length} other division${rest.length === 1 ? '' : 's'}`);
  }
  // Worth saying rather than hiding: a document with no division is one nobody's figures include,
  // and the totals will not add up for whoever is checking.
  if (unassigned) parts.push(`${unassigned} with no sales division set`);

  const head = `${period.lead}${mine} we ${period.past ? 'had' : 'have'} ${total} ${noun} created`;
  return parts.length ? `${head}: ${joinList(parts)}.` : `${head}.`;
}

module.exports = { answerCountQuestion, parseCountQuestion, tidyDivision, joinList };
