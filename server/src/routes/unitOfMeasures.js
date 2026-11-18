const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

// Master Lists > Unit of Measures (2026-10-12): the source's two lists, as its own page has them.
//   Purchase Units  purchase_units -- a code, the unit bought in, the base unit it is counted in,
//                   and whether it is measured by length / width.
//   Unit Title      unit_titles -- a named set: purchase / stock / sale / base unit, length,
//                   width and the conversion from purchase unit to base unit.
// Brought across by db/import-unit-of-measures.js. Units are stored by code (units_of_measure.code).
const ROUTE = '/unit-of-measures';

const txt = (v, n) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim().slice(0, n));
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const flag = (v) => (v === true || v === 1 || v === '1' ? 1 : 0);

// The plain units the pickers offer.
router.get('/units', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT id, code, title FROM units_of_measure WHERE is_active = 1 OR is_active IS NULL ORDER BY code');
    res.json(rows);
  } catch (err) { next(err); }
});

// The Unit Title picker on the Inventory Item form (2026-10-12): anyone signed in, because whoever
// may edit an item may pick its units without holding this master list's own page.
router.get('/titles-lookup', requireAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, title, purchase_unit, stock_unit, sale_unit, base_unit, length, width, conversion, is_length, is_width
         FROM unit_titles WHERE is_active = 1 ORDER BY title, id`);
    res.json(rows);
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return res.json([]); // not imported yet (db/import-unit-of-measures.js)
    next(err);
  }
});

router.get('/purchase-units', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const like = req.query.search ? `%${req.query.search}%` : null;
    const [rows] = await pool.query(
      `SELECT * FROM purchase_units
        ${like ? 'WHERE code LIKE ? OR purchase_unit LIKE ? OR base_unit LIKE ?' : ''}
        ORDER BY code, id`, like ? [like, like, like] : []);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/unit-titles', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const like = req.query.search ? `%${req.query.search}%` : null;
    const [rows] = await pool.query(
      `SELECT * FROM unit_titles
        ${like ? 'WHERE title LIKE ? OR purchase_unit LIKE ? OR stock_unit LIKE ? OR sale_unit LIKE ? OR base_unit LIKE ?' : ''}
        ORDER BY title, id`, like ? [like, like, like, like, like] : []);
    res.json(rows);
  } catch (err) { next(err); }
});

// Sales Units arrive as a list (or the stored '|' text) and are kept as the source keeps them:
// 'MM|CM|MTR|IN|FT', blanks and repeats dropped.
function salesUnitsText(v) {
  const list = (Array.isArray(v) ? v : String(v || '').split('|')).map((x) => String(x || '').trim()).filter(Boolean);
  const uniq = [...new Set(list)];
  return uniq.length ? uniq.join('|').slice(0, 255) : null;
}

// As the source's Add New Purchase Unit (2026-10-12): Purchase Unit typed, Base Unit picked.
function puValues(b) {
  const code = txt(b.code, 60);
  if (!code) return { error: 'Enter a Unit Code.' };
  if (!txt(b.purchase_unit, 30)) return { error: 'Enter the Purchase Unit.' };
  if (!txt(b.base_unit, 30)) return { error: 'Choose the Base Unit.' };
  return { vals: [code, txt(b.purchase_unit, 30).toUpperCase(), txt(b.base_unit, 30), flag(b.is_length), flag(b.is_width), salesUnitsText(b.sales_units)] };
}

// A typed Purchase Unit that is not a unit yet becomes one, so items can be bought in it
// (units_of_measure.code is 20 characters).
async function ensureUnit(code) {
  const c = txt(code, 20);
  if (!c) return;
  const [[u]] = await pool.query('SELECT id FROM units_of_measure WHERE code = ?', [c]);
  if (!u) await pool.query('INSERT INTO units_of_measure (code, title, is_active) VALUES (?, ?, TRUE)', [c, c]);
}

router.post('/purchase-units', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const v = puValues(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    await ensureUnit(v.vals[1]);
    const [r] = await pool.query('INSERT INTO purchase_units (code, purchase_unit, base_unit, is_length, is_width, sales_units) VALUES (?, ?, ?, ?, ?, ?)', v.vals);
    const [[row]] = await pool.query('SELECT * FROM purchase_units WHERE id = ?', [r.insertId]);
    res.status(201).json(row);
  } catch (err) { next(err); }
});

router.put('/purchase-units/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const v = puValues(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    await ensureUnit(v.vals[1]);
    const [r] = await pool.query(
      'UPDATE purchase_units SET code = ?, purchase_unit = ?, base_unit = ?, is_length = ?, is_width = ?, sales_units = ?, updated_at = NOW() WHERE id = ?',
      [...v.vals, req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    const [[row]] = await pool.query('SELECT * FROM purchase_units WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) { next(err); }
});

// A Unit Title's conversion: purchase unit -> base unit. Entered, or -- for one measured by length
// or width -- that measurement (ROLL-LINCH-1968: a 1,968-inch roll converts at 1,968), as the
// source fills it.
// As the source's Add New Unit Of Measure (2026-10-12): built from a Purchase Unit -- its code is
// the title's Unit Code (unit_titles.name) and gives its Purchase / Stock / Base Unit and Sales Units.
function utValues(b) {
  const title = txt(b.title, 100);
  if (!title) return { error: 'Enter a Unit Title.' };
  if (!txt(b.name, 60)) return { error: 'Choose the Unit Code (a Purchase Unit).' };
  if (!txt(b.purchase_unit, 30)) return { error: 'Choose the Purchase Unit.' };
  if (!txt(b.base_unit, 30)) return { error: 'Choose the Base Unit.' };
  const length = num(b.length);
  const width = num(b.width);
  let conversion = num(b.conversion);
  if (conversion == null) conversion = (length && width) ? length * width : (length || width || 1);
  if (!(conversion > 0)) return { error: 'Conversion must be above 0.' };
  return {
    vals: [title, txt(b.name, 60), txt(b.purchase_unit, 30), txt(b.stock_unit, 30), txt(b.sale_unit, 30), txt(b.base_unit, 30),
      length, width, conversion, flag(b.is_length), flag(b.is_width), flag(b.is_pieces), num(b.pieces), salesUnitsText(b.sales_units)],
  };
}
const UT_COLS = 'title, name, purchase_unit, stock_unit, sale_unit, base_unit, length, width, conversion, is_length, is_width, is_pieces, pieces, sales_units';

router.post('/unit-titles', requireAuth, requirePermission(ROUTE, 'can_add'), async (req, res, next) => {
  try {
    const v = utValues(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const [r] = await pool.query(`INSERT INTO unit_titles (${UT_COLS}) VALUES (${UT_COLS.split(',').map(() => '?').join(', ')})`, v.vals);
    const [[row]] = await pool.query('SELECT * FROM unit_titles WHERE id = ?', [r.insertId]);
    res.status(201).json(row);
  } catch (err) { next(err); }
});

router.put('/unit-titles/:id', requireAuth, requirePermission(ROUTE, 'can_edit'), async (req, res, next) => {
  try {
    const v = utValues(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const [r] = await pool.query(
      `UPDATE unit_titles SET ${UT_COLS.split(', ').map((c) => `${c} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
      [...v.vals, req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    const [[row]] = await pool.query('SELECT * FROM unit_titles WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) { next(err); }
});

module.exports = router;
