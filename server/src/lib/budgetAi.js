// AI for Budgets / Budget vs Actual: explain the report, answer questions about it, and suggest a
// budget. Plus FLAGS, which are deliberately not AI.
//
// What the model is and is not trusted with:
//  - Flags are plain rules computed here (a month far above the account's norm, an expense with a
//    credit balance, spending with no budget, a total made mostly of inventory adjustments or
//    hand journals). Free, instant, repeatable, and never hallucinated. The AI is told about them.
//  - Explain / Ask see ONLY what this report computed plus the largest transactions behind the
//    biggest variances, and are told to answer from that and say so when it isn't enough.
//  - Suggest never lets the model write monthly figures. the system builds the baseline itself (last
//    year's total spread by the account's own seasonality over up to three years); the model may
//    only choose a growth % per account, clamped to -50%..+50%, with a one-line reason.
//
// Uses the same OpenAI setup as the CRM drafts and the chatbot (OPENAI_API_KEY, OPENAI_MODEL).
const { COMPANY } = require('../config/company');
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const aiConfigured = () => !!process.env.OPENAI_API_KEY;

async function chat(messages, { json = false, temperature = 0.2, timeoutMs = 60000 } = {}) {
  if (!aiConfigured()) {
    throw Object.assign(new Error('AI is not set up on this server (no OPENAI_API_KEY).'), { status: 503 });
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL, temperature, messages,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    // Say which failure it is: an empty OpenAI balance (seen 2026-09-30) is the owner's to fix by
    // adding credit, not something to retry.
    const body = await res.json().catch(() => ({}));
    const code = body?.error?.code || body?.error?.type || '';
    const msg = code === 'insufficient_quota' || code === 'credit_balance_exhausted'
      ? 'The OpenAI account has no credit left. Add credit at platform.openai.com (Billing), then try again.'
      : `The AI service did not answer (${res.status}${code ? `: ${code}` : ''}).`;
    throw Object.assign(new Error(msg), { status: 502 });
  }
  const data = await res.json();
  return String(data.choices?.[0]?.message?.content || '').trim();
}

// ---------------------------------------------------------------- flags (rules, not AI)

const MANUAL_SOURCES = { inventory_adjustment: 'inventory adjustments', journal: 'hand-entered journals' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };

// row: a report row; months: signed actual per month (1..toMonth); sources: { source_type: signed amount }
function flagsFor(row, { income, months, sources }) {
  const flags = [];
  const ytd = row.ytd_actual;
  // 1. One month far out of line with the account's own other months.
  const nonzero = months.filter((v) => Math.abs(v) > 0.005).map(Math.abs);
  if (nonzero.length >= 3) {
    months.forEach((v, i) => {
      const others = nonzero.filter((x) => x !== Math.abs(v));
      const med = median(others);
      if (med > 0 && Math.abs(v) > 3 * med && Math.abs(v) > 50000) {
        flags.push({ kind: 'spike', text: `${MONTHS[i]} actual ${round2(v).toLocaleString('en-US')} is ${(Math.abs(v) / med).toFixed(1)}x this account's usual month` });
      }
    });
  }
  // 2. A cost with a credit balance (money coming back out of an expense) is almost always a
  //    posting error or a reversal worth a look. Income accounts are skipped: contra-revenue
  //    (Sales Discount) sits there with a debit balance by design.
  if (!income && ytd < -1000) flags.push({ kind: 'sign', text: `year-to-date actual is negative (${round2(ytd).toLocaleString('en-US')}) for a cost account` });
  // 3. Spending nobody budgeted for.
  if (!row.annual_budget && Math.abs(ytd) > 10000) flags.push({ kind: 'unbudgeted', text: `${round2(ytd).toLocaleString('en-US')} booked with no budget` });
  // 4. Mostly manual adjustments rather than trading documents.
  const total = Object.values(sources).reduce((s, v) => s + Math.abs(v), 0);
  for (const [src, label] of Object.entries(MANUAL_SOURCES)) {
    const part = Math.abs(sources[src] || 0);
    if (total > 0 && part / total > 0.5 && part > 100000) {
      flags.push({ kind: 'manual', text: `${Math.round((part / total) * 100)}% of this actual comes from ${label}` });
    }
  }
  return flags;
}

// ---------------------------------------------------------------- explain / ask

const SYSTEM_REPORT = [
  `You are a management accountant writing for the General Manager of ${COMPANY.name}, a company in the Philippines. Amounts are Philippine pesos.`,
  'You are given a Budget vs Actual report as JSON: section totals, Gross Profit and Net Income, account rows, rule-based flags, and the largest transactions behind the biggest variances.',
  'Variance is signed so POSITIVE IS GOOD: income above budget, costs below budget.',
  'Use ONLY the data given. Do not invent causes, vendors, or figures. When the data cannot explain something, say what to check instead.',
  'Flags mark numbers that may be wrong (spikes, manual adjustments, negative costs, unbudgeted spending). Treat a flagged actual with caution and say so.',
  'Write plainly, no jargon, no preamble. Use peso amounts with thousands separators.',
].join('\n');

function reportContext(report, drivers) {
  const rows = [];
  for (const s of report.sections) {
    for (const r of s.rows) {
      rows.push({
        section: s.label, account: `${r.account_code} ${r.account_name}`,
        budget: r.budget, actual: r.actual, ytd_budget: r.ytd_budget, ytd_actual: r.ytd_actual,
        annual_budget: r.annual_budget, flags: (r.flags || []).map((f) => f.text),
      });
    }
  }
  return {
    budget: `${report.budget.name} (v${report.budget.version}, ${report.budget.status})`,
    budgeted_by: report.budget.dimension_label, period: report.period_label,
    sections: report.sections.map((s) => ({ section: s.label, ...s.totals })),
    gross_profit_and_net_income: report.summary,
    accounts: rows,
    biggest_variance_transactions: drivers,
  };
}

async function explainReport(report, drivers) {
  const text = await chat([
    { role: 'system', content: SYSTEM_REPORT },
    {
      role: 'user',
      content: `Write a short briefing (under 220 words):\n1. One or two sentences on the overall result for the period (Net Income vs budget).\n2. The 3-5 biggest variances that matter, each with what drove it according to the transactions given.\n3. Any flagged numbers that should be checked before trusting the report.\nUse short paragraphs or bullets.\n\nDATA:\n${JSON.stringify(reportContext(report, drivers))}`,
    },
  ], { temperature: 0.2 });
  return text;
}

async function askReport(report, drivers, question, history = []) {
  const past = (Array.isArray(history) ? history : []).slice(-6).flatMap((h) => [
    { role: 'user', content: String(h.q || '').slice(0, 500) },
    { role: 'assistant', content: String(h.a || '').slice(0, 2000) },
  ]);
  return chat([
    { role: 'system', content: `${SYSTEM_REPORT}\nAnswer the user's question in under 150 words. If the question is about something not in the data (another period, another budget, a document not listed), say so and suggest where in the system to look.\n\nDATA:\n${JSON.stringify(reportContext(report, drivers))}` },
    ...past,
    { role: 'user', content: String(question).slice(0, 500) },
  ], { temperature: 0.1 });
}

// ---------------------------------------------------------------- suggest

// accounts: [{ account_code, account_name, section, income, years: { [year]: number[12] } }]
// Returns { [account_code]: { growth_pct, reason } }. Throws when AI is unavailable.
async function suggestGrowth(budget, accounts) {
  const facts = accounts.map((a) => ({
    account: `${a.account_code} ${a.account_name}`, section: a.section,
    yearly_totals: Object.fromEntries(Object.entries(a.years).map(([y, m]) => [y, round2(m.reduce((s, v) => s + v, 0))])),
  }));
  const raw = await chat([
    {
      role: 'system',
      content: [
        `You help set a company budget for ${COMPANY.name} (Philippines, pesos).`,
        `The budget is FY ${budget.fiscal_year}, ${budget.dimension_label}.`,
        "For each account you get its actual yearly totals for past years. the system will take the LAST year's total, spread by the account's own seasonality, and apply your growth %.",
        'Choose a realistic growth_pct per account between -50 and 50. Base it on the trend in the totals; be conservative where history is short, erratic, or near zero.',
        'Give a reason of at most 15 words that refers to the numbers (e.g. "grew ~12% a year for two years").',
        'Reply with JSON only: {"accounts": {"<account code>": {"growth_pct": number, "reason": "..."}}}.',
      ].join('\n'),
    },
    { role: 'user', content: JSON.stringify(facts) },
  ], { json: true, temperature: 0.2, timeoutMs: 90000 });
  let parsed = {};
  try { parsed = JSON.parse(raw).accounts || {}; } catch { parsed = {}; }
  const out = {};
  for (const [code, v] of Object.entries(parsed)) {
    const g = Number(v?.growth_pct);
    if (!Number.isFinite(g)) continue;
    out[String(code).split(' ')[0]] = { growth_pct: Math.max(-50, Math.min(50, g)), reason: String(v.reason || '').slice(0, 160) };
  }
  return out;
}

// ---------------------------------------------------------------- department report
//
// The accounting manager's workbook report (Admin / Selling / COGS, one row per department, a
// month per column) is a different shape from the per-account grid above, so it gets its own
// context and its own flags rather than being forced through reportContext.
//
// SAME DIVISION OF LABOUR as the account side: flags are plain rules computed here -- free,
// instant, repeatable, and correct whether or not OpenAI has any credit -- and the model only
// ever reads what this report already computed.
//
// Variance here is Budget - Actual, so POSITIVE IS GOOD on every row: these sheets are costs.

// Months with an actual, i.e. the ones a comparison is entitled to use. `month_source` marks a
// month 'missing' when neither the source system nor the the system ledger has it yet, and a missing
// month is not an underspend.
function monthsWithActuals(report) {
  return (report.month_source || []).map((s, i) => (s && s !== 'missing' ? i : -1)).filter((i) => i >= 0);
}

function deptFlagsFor(row, report) {
  const flags = [];
  const live = monthsWithActuals(report);
  const actuals = live.map((i) => row.actual[i]).filter((v) => v != null);
  const budgets = live.map((i) => row.budget[i] || 0);
  const ytdActual = round2(actuals.reduce((s, v) => s + v, 0));
  const ytdBudget = round2(budgets.reduce((s, v) => s + v, 0));

  // 1. Over its own budget for the months that have closed. 10% AND 50k, so a small row does not
  //    flag on a rounding difference and a large one does not hide behind a small percentage.
  if (ytdBudget > 0 && ytdActual > ytdBudget * 1.1 && ytdActual - ytdBudget > 50000) {
    flags.push({
      kind: 'over',
      text: `over budget by ${round2(ytdActual - ytdBudget).toLocaleString('en-US')} so far (${Math.round(((ytdActual / ytdBudget) - 1) * 100)}% above)`,
    });
  }
  // 2. One month far out of line with this row's own other months.
  const nonzero = actuals.filter((v) => Math.abs(v) > 0.005).map(Math.abs);
  if (nonzero.length >= 3) {
    for (const i of live) {
      const v = row.actual[i];
      if (v == null) continue;
      const med = median(nonzero.filter((x) => x !== Math.abs(v)));
      if (med > 0 && Math.abs(v) > 3 * med && Math.abs(v) > 50000) {
        flags.push({ kind: 'spike', text: `${MONTHS[i]} actual ${round2(v).toLocaleString('en-US')} is ${(Math.abs(v) / med).toFixed(1)}x this department's usual month` });
      }
    }
  }
  // 3. Spending with nothing budgeted against it, and its opposite -- a budget nothing has been
  //    spent against, which usually means the department is not mapped rather than thrifty.
  if (!row.annual_budget && Math.abs(ytdActual) > 10000) {
    flags.push({ kind: 'unbudgeted', text: `${round2(ytdActual).toLocaleString('en-US')} spent with no budget set` });
  }
  if (row.annual_budget > 0 && live.length >= 3 && Math.abs(ytdActual) < 0.005) {
    flags.push({ kind: 'no-actual', text: `budgeted ${round2(row.annual_budget).toLocaleString('en-US')} with no actual in ${live.length} closed month(s)` });
  }
  // 4. A cost row with a credit balance is a posting error or a reversal, not an underspend.
  if (ytdActual < -1000) {
    flags.push({ kind: 'sign', text: `actual is negative (${ytdActual.toLocaleString('en-US')}) for a cost row` });
  }
  // 5. The report already knows this one; surfacing it as a flag puts it where the others are.
  if (row.no_t1s_department) {
    flags.push({ kind: 'unmapped', text: 'no the system department is mapped to this row, so its actual can only come from the source system' });
  }
  return flags;
}

// Every row's flags, keyed by row id, plus the report-wide ones.
function deptFlags(report) {
  const byRow = {};
  for (const g of report.groups || []) {
    for (const r of g.rows) {
      const f = deptFlagsFor(r, report);
      if (f.length) byRow[r.id] = f;
    }
  }
  const missing = (report.month_source || [])
    .map((s, i) => (!s || s === 'missing' ? MONTHS[i] : null)).filter(Boolean);
  return {
    rows: byRow,
    report: missing.length
      ? [{ kind: 'no-data', text: `No actuals yet for ${missing.join(', ')} — those months are blank, not under budget.` }]
      : [],
  };
}

function deptReportContext(report) {
  const live = monthsWithActuals(report);
  const closed = live.map((i) => MONTHS[i]);
  const flags = deptFlags(report);
  const groups = (report.groups || []).map((g) => ({
    sheet: g.label,
    total_annual_budget: g.totals.annual_budget,
    total_actual_to_date: round2(live.reduce((s, i) => s + (g.totals.actual[i] || 0), 0)),
    rows: g.rows.map((r) => ({
      department: r.label,
      annual_budget: r.annual_budget,
      budget_to_date: round2(live.reduce((s, i) => s + (r.budget[i] || 0), 0)),
      actual_to_date: round2(live.reduce((s, i) => s + (r.actual[i] || 0), 0)),
      // The month columns, named, so the model can talk about a specific month without counting.
      by_month: Object.fromEntries(live.map((i) => [MONTHS[i], { budget: r.budget[i] || 0, actual: r.actual[i] }])),
      flags: (flags.rows[r.id] || []).map((f) => f.text),
    })),
  }));
  return {
    budget: `${report.budget.name} (FY ${report.budget.fiscal_year}, v${report.budget.version}, ${report.budget.status})`,
    sales_target: report.budget.sales_target,
    months_with_actuals: closed,
    books_actuals_switch_to_t1s_after: report.books_as_of || null,
    report_flags: flags.report.map((f) => f.text),
    sheets: groups,
    cogs_actual_breakdown_by_line: (report.cogs_breakdown || []).map((c) => ({
      line: c.parent ? `${c.parent} > ${c.label}` : c.label,
      actual_to_date: round2(live.reduce((s, i) => s + (c.actual[i] || 0), 0)),
    })),
  };
}

const SYSTEM_DEPT = [
  `You are a management accountant writing for the General Manager of ${COMPANY.name}, a company in the Philippines. Amounts are Philippine pesos.`,
  'You are given the department budget report as JSON: three sheets (Admin Expenses, Selling Expenses, COGS), one row per department, budget and actual per month, plus rule-based flags.',
  'These sheets are COSTS. Variance is Budget - Actual, so POSITIVE IS GOOD: under budget is good, over budget is bad.',
  'Only the months listed in months_with_actuals have actuals. A month that is not listed is MISSING DATA, never an underspend, and must not be described as one.',
  'Use ONLY the data given. Do not invent causes, vendors, or figures. When the data cannot explain something, say what to check instead.',
  'Flags mark numbers that may be wrong (spikes, unbudgeted spending, negative costs, unmapped departments). Treat a flagged actual with caution and say so.',
  'Write plainly, no jargon, no preamble. Use peso amounts with thousands separators.',
].join('\n');

async function explainDeptReport(report) {
  return chat([
    { role: 'system', content: SYSTEM_DEPT },
    {
      role: 'user',
      content: `Write a short briefing (under 220 words):\n1. One or two sentences on total spending against budget for the months that have actuals.\n2. The 3-5 departments that matter most -- biggest overspend first, and any large underspend worth questioning.\n3. Any flagged numbers that should be checked before trusting the report.\nUse short paragraphs or bullets.\n\nDATA:\n${JSON.stringify(deptReportContext(report))}`,
    },
  ], { temperature: 0.2 });
}

async function askDeptReport(report, question, history = []) {
  const past = (Array.isArray(history) ? history : []).slice(-6).flatMap((h) => [
    { role: 'user', content: String(h.q || '').slice(0, 500) },
    { role: 'assistant', content: String(h.a || '').slice(0, 2000) },
  ]);
  return chat([
    { role: 'system', content: `${SYSTEM_DEPT}\nAnswer the user's question in under 150 words. If the question is about something not in the data (another year, an account-level detail, a document not listed), say so and suggest where in the system to look.\n\nDATA:\n${JSON.stringify(deptReportContext(report))}` },
    ...past,
    { role: 'user', content: String(question).slice(0, 500) },
  ], { temperature: 0.1 });
}

module.exports = {
  aiConfigured, flagsFor, explainReport, askReport, suggestGrowth,
  deptFlags, explainDeptReport, askDeptReport,
};
