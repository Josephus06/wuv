// A minimal .xlsx reader: the first worksheet's cells, as values. Enough for importing a
// spreadsheet someone typed up -- text, numbers, Excel dates and times -- without adding a
// spreadsheet library. An .xlsx is a zip of XML files; Node's zlib inflates the parts.
//
// Deliberately narrow: no formulas (their cached values are read), no styles, no ZIP64, and
// hard caps on sizes so a crafted file cannot exhaust memory.
const zlib = require('zlib');

const MAX_ENTRY_BYTES = 30 * 1024 * 1024;

function bad(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// name -> Buffer for the zip's entries we ask for.
function unzip(buf, wanted) {
  // End of central directory: the last 0x06054b50 within the final 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw bad('That file is not an Excel workbook (.xlsx).');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad('The workbook is damaged.');
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;
    if (size > MAX_ENTRY_BYTES || compressed === 0xffffffff) throw bad('The workbook is too large to import.');
    if (buf.readUInt32LE(local) !== 0x04034b50) throw bad('The workbook is damaged.');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compressed);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }));
    else throw bad('The workbook uses an unsupported compression.');
  }
  return out;
}

function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Text of an <si> / <is> element: plain <t>, or rich-text runs <r><t>..</t></r> joined.
const textOf = (xml) => decode([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));

// Rows of the first worksheet: [{ row: 2, cells: { A: 'Name', B: 46307, ... } }, ...].
// Numbers come back as numbers (dates and times stay Excel serials -- see excelDate/excelTime).
function readFirstSheet(buffer) {
  const parts = unzip(buffer, (n) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(n));
  const workbook = parts.get('xl/workbook.xml');
  if (!workbook) throw bad('That file is not an Excel workbook (.xlsx).');
  const wbXml = workbook.toString('utf8');
  const date1904 = /<workbookPr[^>]*date1904="(1|true)"/.test(wbXml);

  // The first <sheet> in workbook order, through its relationship to the part's path.
  let sheetPath = null;
  const firstSheet = wbXml.match(/<sheet\b[^>]*\br:id="([^"]+)"/);
  const rels = parts.get('xl/_rels/workbook.xml.rels');
  if (firstSheet && rels) {
    const rel = [...rels.toString('utf8').matchAll(/<Relationship\b[^>]*>/g)]
      .map((m) => m[0]).find((r) => r.includes(`Id="${firstSheet[1]}"`));
    const target = rel && (rel.match(/Target="([^"]+)"/) || [])[1];
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  }
  if (!sheetPath || !parts.has(sheetPath)) sheetPath = [...parts.keys()].filter((k) => k.startsWith('xl/worksheets/')).sort()[0];
  if (!sheetPath) throw bad('The workbook has no worksheet.');

  const ss = parts.get('xl/sharedStrings.xml');
  const strings = ss ? [...ss.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1])) : [];

  const rows = [];
  const sheet = parts.get(sheetPath).toString('utf8');
  for (const r of sheet.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const c of r[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const ref = (attrs.match(/\br="([A-Z]+)\d+"/) || [])[1];
      if (!ref) continue;
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1];
      const inner = c[2] || '';
      const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let value = null;
      if (type === 's' && v !== undefined) value = strings[Number(v)] ?? null;
      else if (type === 'inlineStr') value = textOf(inner);
      else if (type === 'str' && v !== undefined) value = decode(v);
      else if (type === 'b' && v !== undefined) value = v === '1';
      else if (v !== undefined) value = Number(v);
      if (typeof value === 'string') value = value.trim();
      if (value !== null && value !== '') cells[ref] = value;
    }
    if (Object.keys(cells).length) rows.push({ row: Number(r[1]), cells });
  }
  return { rows, date1904 };
}

// Excel serial date -> "YYYY-MM-DD" (1900 or 1904 date system).
function excelDate(serial, date1904 = false) {
  const days = Math.floor(Number(serial)) + (date1904 ? 1462 : 0);
  return new Date(Math.round((days - 25569) * 86400000)).toISOString().slice(0, 10);
}

// Excel time (the fraction of a day; a whole date-time keeps only its time) -> "HH:MM".
function excelTime(serial) {
  const mins = Math.round((Number(serial) % 1) * 1440) % 1440;
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

module.exports = { readFirstSheet, excelDate, excelTime };
