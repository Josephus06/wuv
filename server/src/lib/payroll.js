// Computes a payroll run: every employee of the run's company, day by day through the cutoff,
// from their shift assignments, the holiday calendar and their attendance records, at the pay
// rate in employee_compensation and the rules in payroll_rule_sets.
//
// HOW A DAY IS PAID
//   Who works when comes from the supervisor's plotted schedule where a day is plotted, and
//   from the employee's Shift Assignments otherwise (lib/attendance dayShift).
//   Each day is a kind (lib/payrollRules dayKind): ordinary, rest day (not scheduled), special
//   or regular holiday, or a holiday on a rest day; each kind has a Labor Code multiplier.
//
//   Monthly-paid: the half-month basic already pays every scheduled day once, holidays
//     included. On top of it: a worked holiday earns the premium (multiplier - 1); work on a
//     rest day earns the full multiplier (the basic never covered it). Absences, lateness and
//     undertime come off at the daily / per-minute rate -- unless the profile says Compute
//     Absences = No.
//   Daily-paid: paid for the hours actually worked, at the day's multiplier. An unworked
//     regular holiday is still paid one day, if the employee was not absent on the last
//     scheduled day before it (the Labor Code's condition).
//
//   Overtime and night differential are paid unless the profile says Compute Overtime Pay =
//   No (managerial staff). Overtime is the record's approved overtime when one is set, else
//   the time after the scheduled end -- on an unscheduled day, whatever is past 8 hours --
//   counted in whole blocks (30 minutes by default).
//
// WHAT IS NOT DONE HERE: a pay-rate change mid-cutoff (the rate in force on the last day is
// used for the whole cutoff), leave (an absence is an absence until leave exists), and 13th
// month pay. Each is a warning or a later module, never a silent guess.
const pool = require('../db');
const {
  scheduleSources, dayShift, addDays, todayLocal, toLocalDisplay, fromDbUtc,
} = require('./attendance');
const {
  withDefaults, round2, sssContribution, philhealthContribution, pagibigContribution,
  withholdingTax, dayKind, overtimeMultiplier, nightMinutes,
} = require('./payrollRules');

const PERIODS_PER_YEAR = 24; // semi-monthly

const KIND_LABEL = {
  ordinary: 'ordinary day',
  rest_day: 'rest day',
  special_holiday: 'special holiday',
  special_holiday_rest_day: 'special holiday on rest day',
  regular_holiday: 'regular holiday',
  regular_holiday_rest_day: 'regular holiday on rest day',
};

// The two semi-monthly cutoffs of a month: 1st-15th and 16th-month end.
function periodFor(year, month, cutoff) {
  const mm = String(month).padStart(2, '0');
  if (Number(cutoff) === 1) return { start: `${year}-${mm}-01`, end: `${year}-${mm}-15` };
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${year}-${mm}-16`, end: `${year}-${mm}-${last}` };
}

function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// "2026-10-20 22:15" -> minutes from the start of `workDate` (can pass 1440 for an overnight shift).
function minutesFrom(workDate, localDisplay) {
  const [date, time] = localDisplay.split(' ');
  const [h, m] = time.split(':').map(Number);
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${workDate}T00:00:00Z`)) / 86400000);
  return days * 1440 + h * 60 + m;
}

const minutesBetween = (a, b) => Math.round((fromDbUtc(b) - fromDbUtc(a)) / 60000);

async function loadRules(periodEnd, conn) {
  const [[set]] = await conn.query(
    `SELECT id, DATE_FORMAT(effective_from, '%Y-%m-%d') AS effective_from, rules FROM payroll_rule_sets
     WHERE effective_from <= ? ORDER BY effective_from DESC LIMIT 1`,
    [periodEnd]
  );
  if (!set) {
    const err = new Error(`No payroll rates are effective on ${periodEnd}. Add them under Payroll Settings.`);
    err.status = 400;
    throw err;
  }
  return { ruleSetId: set.id, effectiveFrom: set.effective_from, rules: withDefaults(JSON.parse(set.rules)) };
}

// Everything the computation reads, for one company and cutoff, in a handful of queries.
async function loadInputs(run, conn) {
  const { company_id: companyId, period_start: start, period_end: end } = run;
  const lookback = addDays(start, -7); // to find the workday before a holiday at the start

  const [employees] = await conn.query(
    `SELECT id, employee_code, first_name, last_name, is_active, compute_ot_pay, compute_absences,
            sss_ee_monthly, philhealth_ee_monthly, pagibig_ee_monthly,
            DATE_FORMAT(date_hired, '%Y-%m-%d') AS date_hired,
            DATE_FORMAT(date_separated, '%Y-%m-%d') AS date_separated
     FROM employees
     WHERE company_id = ?
       AND (date_hired IS NULL OR date_hired <= ?)
       AND (date_separated IS NULL OR date_separated >= ?)
       AND (is_active = TRUE OR date_separated IS NOT NULL)
     ORDER BY last_name, first_name`,
    [companyId, end, start]
  );
  const ids = employees.map((e) => e.id);
  if (!ids.length) return { employees, comps: new Map(), sources: { assignments: new Map(), plotted: new Map() }, logs: [], holidays: new Map(), payItems: [], loans: [], loanPaid: new Map(), adjustments: [], contributionOverrides: [] };

  const [compRows] = await conn.query(
    `SELECT employee_id, DATE_FORMAT(effective_date, '%Y-%m-%d') AS effective_date, pay_type, base_rate,
            working_day_divisor, is_minimum_wage, sss_covered, philhealth_covered, hdmf_covered
     FROM employee_compensation WHERE employee_id IN (?) AND effective_date <= ?
     ORDER BY employee_id, effective_date DESC`,
    [ids, end]
  );
  const comps = new Map();
  for (const c of compRows) if (!comps.has(c.employee_id)) comps.set(c.employee_id, c);

  const [logs] = await conn.query(
    `SELECT id, employee_id, DATE_FORMAT(work_date, '%Y-%m-%d') AS work_date, scheduled_start, scheduled_end,
            break_minutes, paid_break_minutes, time_in, time_out, late_minutes, undertime_minutes, overtime_minutes,
            approved_ot_minutes, worked_minutes
     FROM attendance_logs WHERE employee_id IN (?) AND work_date BETWEEN ? AND ?`,
    [ids, lookback, end]
  );

  const [holidayRows] = await conn.query(
    `SELECT DATE_FORMAT(holiday_date, '%Y-%m-%d') AS holiday_date, name, holiday_type FROM holidays
     WHERE holiday_date BETWEEN ? AND ? AND (company_id IS NULL OR company_id = ?)`,
    [lookback, end, companyId]
  );
  // A regular holiday outranks a special one on the same date.
  const holidays = new Map();
  for (const h of holidayRows) {
    const prev = holidays.get(h.holiday_date);
    if (!prev || (prev.holiday_type === 'special' && h.holiday_type === 'regular')) holidays.set(h.holiday_date, h);
  }

  const [payItems] = await conn.query(
    `SELECT id, employee_id, item_type, name, amount, is_taxable FROM employee_pay_items
     WHERE employee_id IN (?) AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
     ORDER BY item_type, name`,
    [ids, end, start]
  );

  const [loans] = await conn.query(
    `SELECT id, employee_id, loan_type, reference_no, loan_amount, amortization FROM employee_loans
     WHERE employee_id IN (?) AND status = 'active' AND start_date <= ? ORDER BY start_date, id`,
    [ids, end]
  );
  const loanPaid = new Map();
  if (loans.length) {
    const [paid] = await conn.query(
      `SELECT l.loan_id, SUM(l.amount) AS paid FROM payroll_run_lines l
       JOIN payroll_runs r ON r.id = l.run_id
       WHERE l.loan_id IN (?) AND r.status = 'approved' AND r.id <> ? GROUP BY l.loan_id`,
      [loans.map((l) => l.id), run.id]
    );
    for (const p of paid) loanPaid.set(p.loan_id, Number(p.paid));
  }

  const [adjustments] = await conn.query(
    'SELECT id, employee_id, adj_type, label, amount, is_taxable FROM payroll_adjustments WHERE run_id = ? ORDER BY id',
    [run.id]
  );

  const [contributionOverrides] = await conn.query(
    'SELECT employee_id, code, amount FROM payroll_contribution_overrides WHERE run_id = ?',
    [run.id]
  );

  return {
    employees, comps, sources: await scheduleSources(ids, lookback, end, conn), logs, holidays,
    payItems, loans, loanPaid, adjustments, contributionOverrides,
  };
}

// One employee's payslip: { summary, lines, warnings }.
function computeEmployee(emp, comp, ctx) {
  const { run, rules, holidays, today } = ctx;
  const warnings = [];
  const lines = [];
  const add = (line) => { if (round2(line.amount) !== 0) lines.push({ is_taxable: true, ...line, amount: round2(line.amount) }); };

  const monthly = comp.pay_type === 'monthly';
  const base = Number(comp.base_rate);
  const divisor = Number(comp.working_day_divisor) || rules.working_days_per_year;
  const daily = monthly ? (base * 12) / divisor : base;
  const hourly = daily / rules.hours_per_day;
  const perMinute = hourly / 60;
  const fullDayMin = rules.hours_per_day * 60;
  const computeOt = emp.compute_ot_pay !== 0; // blank = yes; only an explicit No exempts
  const computeAbsences = emp.compute_absences !== 0;

  const shiftOn = (d) => dayShift(ctx.sources, emp.id, d);
  const myLogs = new Map(ctx.logs.filter((l) => l.employee_id === emp.id).map((l) => [l.work_date, l]));
  if (!dateRange(run.period_start, run.period_end).some((d) => shiftOn(d))) {
    warnings.push('No schedule for this cutoff, so absences cannot be counted. Plot it under HR → Schedule, or assign a shift under HR → Shift Assignments.');
  }

  const employedOn = (d) => (!emp.date_hired || d >= emp.date_hired) && (!emp.date_separated || d <= emp.date_separated);

  // Was the employee at work (or on a holiday) on the last scheduled day before `date`?
  function presentBefore(date) {
    for (let i = 1; i <= 7; i += 1) {
      const d = addDays(date, -i);
      if (!shiftOn(d)) continue;
      return myLogs.has(d) || holidays.has(d);
    }
    return true; // no scheduled day in the week before: nothing to forfeit it on
  }

  let daysScheduled = 0;
  let daysWorked = 0;
  let daysAbsent = 0;
  let daysNotEmployed = 0;
  let lateMin = 0;
  let undertimeMin = 0;
  let otMinTotal = 0;
  let nightMinTotal = 0;
  let dailyBasicMin = 0; // daily-paid: regular minutes on ordinary days
  let unworkedHolidays = 0;
  const premium = {}; // kind -> { minutes, amount }
  const overtime = {};
  let nightPay = 0;
  const bump = (bucket, kind, minutes, amount) => {
    bucket[kind] = bucket[kind] || { minutes: 0, amount: 0 };
    bucket[kind].minutes += minutes;
    bucket[kind].amount += amount;
  };

  for (const date of dateRange(run.period_start, run.period_end)) {
    const scheduled = !!shiftOn(date);
    const holiday = holidays.get(date);
    const kind = dayKind({ scheduled, holidayType: holiday?.holiday_type });
    const mult = rules.day_multipliers[kind];
    const log = myLogs.get(date);

    if (!employedOn(date)) {
      if (scheduled) daysNotEmployed += 1;
      continue;
    }
    if (scheduled) daysScheduled += 1;

    if (log) {
      if (!log.time_out) {
        warnings.push(`${date}: timed in with no time out -- not paid for that day. Correct it in HR → Attendance, then recompute.`);
        continue;
      }
      daysWorked += 1;
      let regMin;
      let otRaw;
      if (log.scheduled_start && log.scheduled_end) {
        // Paid breaks (outside Shift In / Out) are part of the day's paid time.
        const schedMin = Math.max(0, minutesBetween(log.scheduled_start, log.scheduled_end) - (log.break_minutes || 0) + (log.paid_break_minutes || 0));
        regMin = Math.max(0, Math.min(schedMin, fullDayMin) - log.late_minutes - log.undertime_minutes);
        otRaw = log.overtime_minutes;
        lateMin += log.late_minutes;
        undertimeMin += log.undertime_minutes;
      } else {
        regMin = Math.min(log.worked_minutes, fullDayMin);
        otRaw = Math.max(0, log.worked_minutes - fullDayMin);
      }
      // Overtime a supervisor approved for the day replaces the measured figure: it pays an
      // approved early start, and not staying late that nobody approved.
      if (log.approved_ot_minutes !== null && log.approved_ot_minutes !== undefined) otRaw = log.approved_ot_minutes;

      if (monthly) {
        // The basic pays a scheduled day once; only the part above that is added.
        if (!scheduled) bump(premium, kind, regMin, (regMin / 60) * hourly * mult);
        else if (mult > 1) bump(premium, kind, regMin, (regMin / 60) * hourly * (mult - 1));
      } else if (kind === 'ordinary') {
        dailyBasicMin += regMin;
      } else {
        bump(premium, kind, regMin, (regMin / 60) * hourly * mult);
      }

      if (computeOt) {
        const otMin = Math.floor(otRaw / rules.overtime_block_minutes) * rules.overtime_block_minutes;
        if (otMin > 0) {
          otMinTotal += otMin;
          bump(overtime, kind, otMin, (otMin / 60) * hourly * mult * overtimeMultiplier(kind, rules));
        }
        const nd = nightMinutes(minutesFrom(date, toLocalDisplay(log.time_in)), minutesFrom(date, toLocalDisplay(log.time_out)), rules);
        if (nd > 0) {
          nightMinTotal += nd;
          nightPay += (nd / 60) * hourly * mult * rules.night_differential_rate;
        }
      }
      continue;
    }

    // No record for the day.
    if (holiday?.holiday_type === 'regular' && !monthly) {
      if (presentBefore(date)) unworkedHolidays += 1;
      else warnings.push(`${date} (${holiday.name}): regular holiday not paid -- absent on the workday before it.`);
    } else if (scheduled && !holiday && date < today) {
      daysAbsent += 1;
    }
  }

  // Earnings
  if (monthly) {
    add({ line_type: 'earning', code: 'BASIC', label: 'Basic pay (half month)', amount: base / 2 });
    if (computeAbsences) {
      add({ line_type: 'earning', code: 'ABSENT', label: 'Absences', quantity: daysAbsent, unit: 'day', rate: daily, amount: -daysAbsent * daily });
      add({ line_type: 'earning', code: 'LATE', label: 'Late', quantity: lateMin, unit: 'min', rate: perMinute, amount: -lateMin * perMinute });
      add({ line_type: 'earning', code: 'UNDERTIME', label: 'Undertime', quantity: undertimeMin, unit: 'min', rate: perMinute, amount: -undertimeMin * perMinute });
    }
    add({ line_type: 'earning', code: 'NOT_EMPLOYED', label: 'Days before hire / after separation', quantity: daysNotEmployed, unit: 'day', rate: daily, amount: -daysNotEmployed * daily });
  } else {
    const days = dailyBasicMin / fullDayMin;
    add({ line_type: 'earning', code: 'BASIC', label: 'Basic pay', quantity: round2(days), unit: 'day', rate: daily, amount: days * daily });
    add({ line_type: 'earning', code: 'HOLIDAY_PAY', label: 'Regular holiday pay (unworked)', quantity: unworkedHolidays, unit: 'day', rate: daily, amount: unworkedHolidays * daily });
  }
  for (const [kind, v] of Object.entries(premium)) {
    add({ line_type: 'earning', code: 'PREMIUM', label: `Work on ${KIND_LABEL[kind]}`, quantity: round2(v.minutes / 60), unit: 'hr', amount: v.amount });
  }
  for (const [kind, v] of Object.entries(overtime)) {
    add({ line_type: 'earning', code: 'OVERTIME', label: `Overtime, ${KIND_LABEL[kind]}`, quantity: round2(v.minutes / 60), unit: 'hr', amount: v.amount });
  }
  add({ line_type: 'earning', code: 'NIGHT_DIFF', label: 'Night differential', quantity: round2(nightMinTotal / 60), unit: 'hr', amount: nightPay });

  for (const item of ctx.payItems.filter((i) => i.employee_id === emp.id && i.item_type === 'allowance')) {
    add({ line_type: 'earning', code: 'ALLOWANCE', label: item.name, amount: Number(item.amount), is_taxable: !!item.is_taxable });
  }
  for (const adj of ctx.adjustments.filter((a) => a.employee_id === emp.id && a.adj_type === 'earning')) {
    add({ line_type: 'earning', code: 'ADJUSTMENT', label: adj.label, amount: Number(adj.amount), is_taxable: !!adj.is_taxable });
  }

  const earnings = lines.filter((l) => l.line_type === 'earning');
  const gross = round2(earnings.reduce((s, l) => s + l.amount, 0));
  const nonTaxable = round2(earnings.filter((l) => !l.is_taxable).reduce((s, l) => s + l.amount, 0));

  // Government contributions: computed on the month's basic, then spread over the cutoffs.
  const monthlyBasis = monthly ? base : daily * (divisor / 12);
  const share = (agency) => (amount) => {
    const when = rules.contribution_cutoffs[agency];
    if (when === 'first') return Number(run.cutoff) === 1 ? amount : 0;
    if (when === 'second') return Number(run.cutoff) === 2 ? amount : 0;
    const first = round2(amount / 2);
    return Number(run.cutoff) === 1 ? first : round2(amount - first);
  };
  const sssShare = share('sss');
  const phShare = share('philhealth');
  const hdmfShare = share('pagibig');
  const covered = (flag) => flag === null || flag === undefined || !!flag;
  const sss = covered(comp.sss_covered) ? sssContribution(monthlyBasis, rules) : null;
  const ph = covered(comp.philhealth_covered) ? philhealthContribution(monthlyBasis, rules) : null;
  const hdmf = covered(comp.hdmf_covered) ? pagibigContribution(monthlyBasis, rules) : null;
  const sssComputed = sss ? sssShare(sss.employee) : 0;
  const phComputed = ph ? phShare(ph.employee) : 0;
  const hdmfComputed = hdmf ? hdmfShare(hdmf.employee) : 0;

  // An amount set by hand replaces the computed employee share: this run's override for the
  // cutoff first, else the employee's fixed monthly amount (split like the computed one).
  const runOverride = (code) => ctx.contributionOverrides.find((o) => o.employee_id === emp.id && o.code === code);
  const employeeShare = (code, computed, monthlyFixed, shareOf) => {
    const o = runOverride(code);
    if (o) return { amount: round2(Number(o.amount)), note: 'set for this cutoff' };
    if (monthlyFixed !== null && monthlyFixed !== undefined) return { amount: shareOf(Number(monthlyFixed)), note: 'fixed amount' };
    return { amount: computed, note: null };
  };
  const sssEeX = employeeShare('SSS', sssComputed, emp.sss_ee_monthly, sssShare);
  const phEeX = employeeShare('PHILHEALTH', phComputed, emp.philhealth_ee_monthly, phShare);
  const hdmfEeX = employeeShare('PAGIBIG', hdmfComputed, emp.pagibig_ee_monthly, hdmfShare);
  const sssEe = sssEeX.amount;
  const phEe = phEeX.amount;
  const hdmfEe = hdmfEeX.amount;
  const noted = (label, x) => (x.note ? `${label} (${x.note})` : label);

  add({ line_type: 'deduction', code: 'SSS', label: noted(sss ? `SSS (MSC ${sss.msc.toLocaleString('en-US')})` : 'SSS', sssEeX), amount: sssEe });
  add({ line_type: 'deduction', code: 'PHILHEALTH', label: noted('PhilHealth', phEeX), amount: phEe });
  add({ line_type: 'deduction', code: 'PAGIBIG', label: noted('Pag-IBIG', hdmfEeX), amount: hdmfEe });
  if (sss) {
    add({ line_type: 'employer', code: 'SSS_ER', label: 'SSS (employer)', amount: sssShare(sss.employer) });
    add({ line_type: 'employer', code: 'SSS_EC', label: 'SSS EC (employer)', amount: sssShare(sss.ec) });
  }
  if (ph) add({ line_type: 'employer', code: 'PHILHEALTH_ER', label: 'PhilHealth (employer)', amount: phShare(ph.employer) });
  if (hdmf) add({ line_type: 'employer', code: 'PAGIBIG_ER', label: 'Pag-IBIG (employer)', amount: hdmfShare(hdmf.employer) });

  // Only the mandatory share is tax-exempt: anything deducted above the computed amount (a
  // voluntary higher contribution) stays taxable.
  const exempt = Math.min(sssEe, sssComputed) + Math.min(phEe, phComputed) + Math.min(hdmfEe, hdmfComputed);
  const taxable = round2(Math.max(0, gross - nonTaxable - exempt));
  const tax = comp.is_minimum_wage ? 0 : withholdingTax(taxable, PERIODS_PER_YEAR, rules);
  add({ line_type: 'deduction', code: 'TAX', label: 'Withholding tax', amount: tax });

  for (const loan of ctx.loans.filter((l) => l.employee_id === emp.id)) {
    const balance = round2(Number(loan.loan_amount) - (ctx.loanPaid.get(loan.id) || 0));
    if (balance <= 0) continue;
    const amount = Math.min(Number(loan.amortization), balance);
    add({
      line_type: 'deduction', code: 'LOAN', label: `${loan.loan_type}${loan.reference_no ? ` #${loan.reference_no}` : ''}`,
      amount, loan_id: loan.id, quantity: round2(balance - amount), unit: 'bal',
    });
  }
  for (const item of ctx.payItems.filter((i) => i.employee_id === emp.id && i.item_type === 'deduction')) {
    add({ line_type: 'deduction', code: 'DEDUCTION', label: item.name, amount: Number(item.amount) });
  }
  for (const adj of ctx.adjustments.filter((a) => a.employee_id === emp.id && a.adj_type === 'deduction')) {
    add({ line_type: 'deduction', code: 'ADJUSTMENT', label: adj.label, amount: Number(adj.amount) });
  }

  const totalDeductions = round2(lines.filter((l) => l.line_type === 'deduction').reduce((s, l) => s + l.amount, 0));
  const employerCost = round2(lines.filter((l) => l.line_type === 'employer').reduce((s, l) => s + l.amount, 0));
  const net = round2(gross - totalDeductions);
  if (net < 0) warnings.push('Net pay is negative: deductions are larger than this cutoff\'s pay. Lower a loan or deduction for this cutoff.');

  return {
    summary: {
      pay_type: comp.pay_type,
      base_rate: base,
      daily_rate: round2(daily),
      hourly_rate: round2(hourly),
      days_scheduled: daysScheduled,
      days_worked: daysWorked + unworkedHolidays,
      days_absent: daysAbsent,
      late_minutes: lateMin,
      undertime_minutes: undertimeMin,
      overtime_minutes: otMinTotal,
      night_minutes: nightMinTotal,
      gross_pay: gross,
      taxable_income: taxable,
      sss_ee: sssEe,
      philhealth_ee: phEe,
      pagibig_ee: hdmfEe,
      withholding_tax: tax,
      total_deductions: totalDeductions,
      net_pay: net,
      employer_cost: employerCost,
    },
    lines,
    warnings,
  };
}

// (Re)computes a draft run in a transaction: replaces its payslips and totals.
async function computeRun(runId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[run]] = await conn.query(
      `SELECT id, company_id, cutoff, status,
              DATE_FORMAT(period_start, '%Y-%m-%d') AS period_start, DATE_FORMAT(period_end, '%Y-%m-%d') AS period_end
       FROM payroll_runs WHERE id = ? FOR UPDATE`,
      [runId]
    );
    if (!run) { const e = new Error('Payroll not found'); e.status = 404; throw e; }
    if (run.status !== 'draft') { const e = new Error('This payroll is approved. Reopen it before recomputing.'); e.status = 409; throw e; }

    const { ruleSetId, effectiveFrom, rules } = await loadRules(run.period_end, conn);
    const inputs = await loadInputs(run, conn);
    const today = todayLocal();
    const runWarnings = [];
    if (run.period_end >= today) {
      runWarnings.push(`The cutoff ends ${run.period_end}: days from today on are not counted as absences yet. Recompute after the cutoff closes.`);
    }
    const noRate = inputs.employees.filter((e) => !inputs.comps.has(e.id));
    if (noRate.length) {
      runWarnings.push(`Not included -- no pay rate set: ${noRate.map((e) => `${e.first_name} ${e.last_name}`).join(', ')}. Add one in the employee's profile (Employment Info → Pay Rate).`);
    }

    await conn.query('DELETE FROM payroll_run_employees WHERE run_id = ?', [run.id]);
    const totals = { count: 0, gross: 0, deductions: 0, net: 0, employer: 0 };
    const ctx = { run, rules, today, ...inputs };

    for (const emp of inputs.employees) {
      const comp = inputs.comps.get(emp.id);
      if (!comp) continue;
      const { summary, lines, warnings } = computeEmployee(emp, comp, ctx);
      const [res] = await conn.query('INSERT INTO payroll_run_employees SET ?', [{
        run_id: run.id, employee_id: emp.id, ...summary, warnings: warnings.length ? JSON.stringify(warnings) : null,
      }]);
      if (lines.length) {
        await conn.query(
          `INSERT INTO payroll_run_lines
             (run_id, run_employee_id, line_type, code, label, quantity, unit, rate, amount, is_taxable, loan_id, sort_order)
           VALUES ?`,
          [lines.map((l, i) => [
            run.id, res.insertId, l.line_type, l.code, l.label, l.quantity ?? null, l.unit ?? null,
            l.rate ?? null, l.amount, l.is_taxable ? 1 : 0, l.loan_id ?? null, i,
          ])]
        );
      }
      totals.count += 1;
      totals.gross += summary.gross_pay;
      totals.deductions += summary.total_deductions;
      totals.net += summary.net_pay;
      totals.employer += summary.employer_cost;
    }

    await conn.query(
      `UPDATE payroll_runs SET rules = ?, rule_set_id = ?, warnings = ?, employee_count = ?, total_gross = ?,
              total_deductions = ?, total_net = ?, total_employer = ?, computed_at = NOW(), updated_at = NOW()
       WHERE id = ?`,
      [
        JSON.stringify({ effective_from: effectiveFrom, ...rules }), ruleSetId,
        runWarnings.length ? JSON.stringify(runWarnings) : null, totals.count,
        round2(totals.gross), round2(totals.deductions), round2(totals.net), round2(totals.employer), run.id,
      ]
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { periodFor, computeRun, computeEmployee, PERIODS_PER_YEAR };
