// Reads a branch's manual attendance sheet (the "C4T Attendance" layout) into rows HR can
// review before importing:
//
//   Name | Date | Shift | Time In | Time Out | OT Time In | OT Time Out | Overtime | Late | Undertime | Worked | Status
//
// Columns are found by their headings, not position. The name is written on an employee's
// first row only and carries down; total rows (no date) are skipped; two rows for the same
// person and date (a second overtime block) are merged.
//
// Late / Undertime / Worked are NOT taken from the sheet: they are worked out again from the
// shift, the same way as every other record, because hand-typed totals drift (an End shift
// worked 1:18-8:04 PM marked as 8 hours). Overtime IS taken -- the sheet's Overtime column is
// what the supervisor approved, including early starts, so it becomes the record's approved
// overtime.
const { excelDate, excelTime } = require('./xlsx');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const HEADERS = {
  name: ['name', 'employee', 'employee name'],
  date: ['date'],
  shift: ['shift', 'schedule'],
  time_in: ['time in', 'in'],
  time_out: ['time out', 'out'],
  ot_in: ['ot time in', 'ot in', 'overtime in'],
  ot_out: ['ot time out', 'ot out', 'overtime out'],
  overtime: ['overtime', 'ot', 'ot hours', 'overtime hours'],
};

function findHeader(rows) {
  for (const r of rows.slice(0, 15)) {
    const cols = {};
    for (const [col, v] of Object.entries(r.cells)) {
      const h = norm(v);
      for (const [key, names] of Object.entries(HEADERS)) if (!cols[key] && names.includes(h)) cols[key] = col;
    }
    if (cols.name && cols.date && (cols.time_in || cols.shift)) return { headerRow: r.row, cols };
  }
  return null;
}

function toDate(v, date1904) {
  if (typeof v === 'number') return excelDate(v, date1904);
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

// "HH:MM" from an Excel time or text like "9:33 AM", "21:00", "13:00 PM", "12:00 NN".
function toTime(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return excelTime(v);
  const m = String(v).trim().match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*(am|pm|nn|a\.m\.|p\.m\.)?$/i);
  if (!m) return undefined; // present but unreadable
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = (m[3] || '').toLowerCase().replace(/\./g, '');
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return undefined;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
// Minutes from a to b, past midnight when b is earlier.
const span = (a, b) => { const d = toMin(b) - toMin(a); return d < 0 ? d + 1440 : d; };

// Sheet rows -> merged day rows with flags. Matching to employees and shifts happens after.
function parseAttendanceSheet({ rows, date1904 }) {
  const header = findHeader(rows);
  if (!header) {
    const e = new Error('Could not find the column headings (Name, Date, Shift, Time In, Time Out ...) in the first rows of the sheet.');
    e.status = 400;
    throw e;
  }
  const { cols } = header;
  const days = new Map();
  let name = null;
  for (const r of rows) {
    if (r.row <= header.headerRow) continue;
    const c = (key) => (cols[key] ? r.cells[cols[key]] : undefined);
    if (c('name')) name = String(c('name')).trim();
    if (!c('date')) continue; // a total row, or blank
    const date = toDate(c('date'), date1904);
    if (!name || !date) continue;
    const key = `${norm(name)}|${date}`;
    if (!days.has(key)) {
      days.set(key, { key, sheet_name: name, date, sheet_shift: null, time_in: null, time_out: null, ot: [], overtime_hours: null, sheet_rows: [], unreadable: [] });
    }
    const d = days.get(key);
    d.sheet_rows.push(r.row);
    if (c('shift') && !d.sheet_shift) d.sheet_shift = String(c('shift')).trim();
    for (const [field, col] of [['time_in', 'time_in'], ['time_out', 'time_out']]) {
      const t = toTime(c(col));
      if (t === undefined) d.unreadable.push(`${col.replace('_', ' ')} "${c(col)}"`);
      else if (t && !d[field]) d[field] = t;
    }
    const otIn = toTime(c('ot_in'));
    const otOut = toTime(c('ot_out'));
    if (otIn && otOut) d.ot.push({ start: otIn, end: otOut });
    const otH = Number(c('overtime'));
    if (c('overtime') !== undefined && Number.isFinite(otH)) d.overtime_hours = (d.overtime_hours || 0) + otH;
  }

  return [...days.values()].map((d) => {
    const flags = [];
    const rest = /\brest\b|\boff\b/.test(norm(d.sheet_shift));
    const otFromTimes = d.ot.reduce((s, o) => s + span(o.start, o.end), 0);
    // The Overtime column is the approved figure; OT times only back it up.
    const approvedOt = d.overtime_hours !== null ? Math.round(d.overtime_hours * 60) : otFromTimes;

    if (d.unreadable.length) flags.push({ level: 'error', text: `Can't read ${d.unreadable.join(', ')}` });
    if (d.time_in && !d.time_out) flags.push({ level: 'warn', text: 'Time in but no time out' });
    if (!d.time_in && d.time_out) flags.push({ level: 'error', text: 'Time out but no time in' });
    if (d.time_in && d.time_out) {
      const worked = span(d.time_in, d.time_out);
      if (toMin(d.time_out) < toMin(d.time_in)) flags.push({ level: 'info', text: `Time out ${d.time_out} is after midnight (next day)` });
      if (worked > 16 * 60) flags.push({ level: 'error', text: `${Math.round(worked / 6) / 10} hours between time in and out` });
      else if (worked < 3 * 60) flags.push({ level: 'warn', text: `Only ${Math.round(worked / 6) / 10} hours between time in and out` });
    }
    if (rest && (d.time_in || d.time_out)) flags.push({ level: 'info', text: 'Worked on a rest day' });
    if (!rest && d.sheet_shift && !d.time_in && !d.time_out) flags.push({ level: 'info', text: 'Scheduled, no time in -- absent' });
    if (d.ot.some((o) => span(o.start, o.end) > 12 * 60)) {
      flags.push({ level: 'warn', text: `OT times ${d.ot.map((o) => `${o.start}-${o.end}`).join(', ')} look wrong` });
    } else if (d.overtime_hours !== null && d.ot.length && Math.abs(otFromTimes - approvedOt) > 15) {
      flags.push({ level: 'warn', text: `Overtime ${d.overtime_hours}h but OT times add up to ${Math.round(otFromTimes / 6) / 10}h` });
    }
    if (d.sheet_rows.length > 1) flags.push({ level: 'info', text: `Merged from ${d.sheet_rows.length} sheet rows` });

    return {
      key: d.key,
      sheet_name: d.sheet_name,
      date: d.date,
      sheet_shift: d.sheet_shift,
      rest,
      time_in: d.time_in,
      time_out: d.time_out,
      ot: d.ot,
      approved_ot_minutes: approvedOt,
      sheet_rows: d.sheet_rows,
      flags,
      // Rows the import cannot make sense of start out skipped; everything else included.
      skip: flags.some((f) => f.level === 'error'),
    };
  }).sort((a, b) => (a.sheet_name === b.sheet_name ? a.date.localeCompare(b.date) : 0));
}

// Sheet name -> employee: exact "first last", else the last name plus the first given name
// both appearing in the sheet name -- when exactly one employee fits.
function matchEmployee(sheetName, employees) {
  const target = norm(sheetName);
  const exact = employees.filter((e) => norm(`${e.first_name} ${e.last_name}`) === target);
  if (exact.length === 1) return { employee_id: exact[0].id, match: 'exact' };
  const tokens = new Set(target.split(' '));
  const loose = employees.filter((e) => {
    const last = norm(e.last_name).split(' ');
    const first = norm(e.first_name).split(' ')[0];
    return first && tokens.has(first) && last.every((t) => tokens.has(t));
  });
  if (loose.length === 1) return { employee_id: loose[0].id, match: 'close' };
  return { employee_id: null, match: null };
}

// Sheet shift text -> shift: same words in any order ("OPENING - SEASIDE" = "Seaside - Opening",
// "END" = "End Shift"), else the one shift whose name contains all the sheet's words.
function matchShift(sheetShift, shifts) {
  const words = (s) => norm(s).split(' ').filter((w) => w && w !== 'shift');
  const want = words(sheetShift);
  if (!want.length) return null;
  const key = [...want].sort().join(' ');
  const same = shifts.filter((s) => [...words(s.name)].sort().join(' ') === key);
  if (same.length === 1) return same[0].id;
  const contains = shifts.filter((s) => want.every((w) => words(s.name).includes(w)));
  return contains.length === 1 ? contains[0].id : null;
}

module.exports = { parseAttendanceSheet, matchEmployee, matchShift, toTime, span };
