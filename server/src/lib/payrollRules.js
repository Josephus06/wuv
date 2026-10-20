// The rule book for payroll: government contributions, withholding tax and Labor Code pay
// premiums. Pure functions over a `rules` object, so the same numbers come out of a test, a
// preview and a real run -- and a run stores the exact rules it used (payroll_runs.rules),
// so changing a rate later never rewrites a payroll already approved.
//
// DEFAULT_RULES are the rates in force for 2026 (SSS 15% of a P5,000-P35,000 MSC; PhilHealth 5%
// on P10,000-P100,000; Pag-IBIG 2% on up to P10,000; TRAIN withholding since 2023). They are
// only the starting point: HR edits them under Payroll Settings when an agency changes them,
// effective from a date, without a code change.

const DEFAULT_RULES = {
  // Pay basis
  hours_per_day: 8,
  // Working days in a year, for turning a monthly rate into a daily one (monthly x 12 / divisor).
  // 261 = 5-day week, 313 = 6-day week. An employee's own pay-rate entry can override it.
  working_days_per_year: 313,
  // Lateness and undertime are deducted by the minute; overtime is counted in whole blocks of
  // this many minutes, and only for employees whose profile says Compute Overtime Pay = Yes.
  overtime_block_minutes: 30,

  // Labor Code pay for the first 8 hours, as a multiple of the hourly rate, by kind of day.
  day_multipliers: {
    ordinary: 1.0,
    rest_day: 1.3,
    special_holiday: 1.3,
    special_holiday_rest_day: 1.5,
    regular_holiday: 2.0,
    regular_holiday_rest_day: 2.6,
  },
  // Overtime is the day's hourly rate times this: +25% on an ordinary day, +30% on any other.
  overtime_multiplier_ordinary: 1.25,
  overtime_multiplier_other: 1.3,
  // Night differential: this share of the day's hourly rate for each hour between the two times.
  night_differential_rate: 0.1,
  night_start: '22:00',
  night_end: '06:00',

  // Monthly contributions are computed on the month's basic salary and spread over the two
  // cutoffs: 'split' takes half in each, 'second_cutoff' takes all of it in the second.
  contribution_schedule: 'split',

  sss: {
    msc_min: 5000,
    msc_max: 35000,
    msc_step: 500,
    employee_rate: 0.05,
    employer_rate: 0.10,
    // Employees' Compensation, employer-paid: the low amount below the threshold MSC.
    ec_low: 10,
    ec_high: 30,
    ec_threshold: 15000,
  },
  philhealth: {
    rate: 0.05,
    floor: 10000,
    ceiling: 100000,
    employee_share: 0.5,
  },
  pagibig: {
    employee_rate: 0.02,
    employee_rate_low: 0.01,
    low_threshold: 1500,
    employer_rate: 0.02,
    max_fund_salary: 10000,
  },
  // Annual tax: on income over `over`, `base` plus `rate` of the excess. A semi-monthly
  // cutoff uses the same table scaled to the period (annual / 24), which is how BIR's
  // semi-monthly table is built.
  tax_brackets: [
    { over: 0, base: 0, rate: 0 },
    { over: 250000, base: 0, rate: 0.15 },
    { over: 400000, base: 22500, rate: 0.20 },
    { over: 800000, base: 102500, rate: 0.25 },
    { over: 2000000, base: 402500, rate: 0.30 },
    { over: 8000000, base: 2202500, rate: 0.35 },
  ],
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Fills any key a stored rule set is missing from the defaults, one level deep -- so a rule
// added in a later version has a value for rule sets saved before it existed.
function withDefaults(rules = {}) {
  const out = { ...DEFAULT_RULES, ...rules };
  for (const k of ['day_multipliers', 'sss', 'philhealth', 'pagibig']) {
    out[k] = { ...DEFAULT_RULES[k], ...(rules[k] || {}) };
  }
  if (!Array.isArray(out.tax_brackets) || !out.tax_brackets.length) out.tax_brackets = DEFAULT_RULES.tax_brackets;
  return out;
}

// SSS Monthly Salary Credit for a month's compensation: P500 steps centred on each credit
// (P5,250-P5,749.99 -> P5,500), floored and capped.
function sssMsc(monthly, sss) {
  const { msc_min: min, msc_max: max, msc_step: step } = sss;
  if (monthly < min + step / 2) return min;
  const msc = min + step * (Math.floor((monthly - (min + step / 2)) / step) + 1);
  return Math.min(msc, max);
}

function sssContribution(monthly, rules) {
  const { sss } = rules;
  const msc = sssMsc(monthly, sss);
  return {
    msc,
    employee: round2(msc * sss.employee_rate),
    employer: round2(msc * sss.employer_rate),
    ec: msc < sss.ec_threshold ? sss.ec_low : sss.ec_high,
  };
}

function philhealthContribution(monthly, rules) {
  const { philhealth: p } = rules;
  const base = Math.min(Math.max(monthly, p.floor), p.ceiling);
  const premium = round2(base * p.rate);
  const employee = round2(premium * p.employee_share);
  return { base, employee, employer: round2(premium - employee) };
}

function pagibigContribution(monthly, rules) {
  const { pagibig: p } = rules;
  const base = Math.min(monthly, p.max_fund_salary);
  const eeRate = monthly <= p.low_threshold ? p.employee_rate_low : p.employee_rate;
  return { base, employee: round2(base * eeRate), employer: round2(base * p.employer_rate) };
}

function annualTax(income, brackets) {
  const sorted = [...brackets].sort((a, b) => a.over - b.over);
  let tax = 0;
  for (const b of sorted) {
    if (income > b.over) tax = b.base + (income - b.over) * b.rate;
  }
  return Math.max(0, tax);
}

// The annual table turned into a per-period one the way BIR builds its published tables:
// each threshold divided and rounded to the peso (P250,000 / 24 -> P10,417), and each
// bracket's fixed amount chained from the rounded thresholds (P937.50, P4,270.70 ...). Scaling
// the annual tax directly would land a few centavos off BIR's own table.
function periodBrackets(brackets, periodsPerYear) {
  const sorted = [...brackets].sort((a, b) => a.over - b.over);
  const out = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const over = Math.round(sorted[i].over / periodsPerYear);
    const base = i === 0 ? sorted[0].base / periodsPerYear
      : out[i - 1].base + (over - out[i - 1].over) * out[i - 1].rate;
    out.push({ over, base: round2(base), rate: sorted[i].rate });
  }
  return out;
}

// Withholding on one period's taxable compensation, from the per-period table.
function withholdingTax(taxable, periodsPerYear, rules) {
  if (taxable <= 0) return 0;
  let tax = 0;
  for (const b of periodBrackets(rules.tax_brackets, periodsPerYear)) {
    if (taxable > b.over) tax = b.base + (taxable - b.over) * b.rate;
  }
  return round2(Math.max(0, tax));
}

// The kind of day, from whether the employee was scheduled and the holiday (if any).
// An unscheduled day is the employee's rest day.
function dayKind({ scheduled, holidayType }) {
  if (holidayType === 'regular') return scheduled ? 'regular_holiday' : 'regular_holiday_rest_day';
  if (holidayType === 'special') return scheduled ? 'special_holiday' : 'special_holiday_rest_day';
  return scheduled ? 'ordinary' : 'rest_day';
}

function overtimeMultiplier(kind, rules) {
  return kind === 'ordinary' ? rules.overtime_multiplier_ordinary : rules.overtime_multiplier_other;
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

// Minutes of [start, end) -- local minutes from the work date's midnight, end may pass 1440 --
// that fall in the night window (22:00-06:00 by default), across up to two nights.
function nightMinutes(startMin, endMin, rules) {
  const ns = toMinutes(rules.night_start);
  const ne = toMinutes(rules.night_end);
  const windows = ns > ne
    ? [[-1440 + ns, ne], [ns, 1440 + ne], [1440 + ns, 2880 + ne]]
    : [[ns, ne], [1440 + ns, 1440 + ne]];
  let total = 0;
  for (const [ws, we] of windows) total += Math.max(0, Math.min(endMin, we) - Math.max(startMin, ws));
  return total;
}

module.exports = {
  DEFAULT_RULES,
  withDefaults,
  round2,
  sssMsc,
  sssContribution,
  philhealthContribution,
  pagibigContribution,
  annualTax,
  periodBrackets,
  withholdingTax,
  dayKind,
  overtimeMultiplier,
  nightMinutes,
};
