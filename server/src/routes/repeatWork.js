const express = require('express');
const pool = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { getSalesRepEmployeeScope } = require('../lib/salesVisibility');

const router = express.Router();
// Gated on Estimates, because this exists to be read while quoting. Anyone entitled to raise
// an estimate is entitled to know what the company has charged for the same work.
const ROUTE = '/estimates';

// "We have made this before."
// ---------------------------------------------------------------------------------------
// A third of everything this company prints it has printed before -- 6,981 descriptions
// repeat, across 40,845 job orders -- and until now the only way to find the last one was to
// remember it. This answers the question the rep actually has at the moment of quoting: what
// did we charge for this, and what did we make on it.
//
// TWO THINGS THE DATA FORCED, both found by running the numbers before writing the query:
//
// 1. THE MEAN IS A LIE HERE. For POSTER at qty 1 PC/S -- 3,845 lines -- the mean price is
//    208.68 and the MEDIAN is 100.00, because one line at 18,342.86 drags it. A rep shown the
//    mean would quote at double. So every figure below is a median with a p25-p75 band around
//    it, and the band is the point: it says "this normally goes for between X and Y", which is
//    an honest answer, where a single number pretending to be The Price is not.
//
// 2. GP IS MOSTLY ABSENT. Only 16,620 of 126,539 priced lines (13%) carry a non-zero gp_rate;
//    the rest were migrated without it. Averaging over the zeros produced "1.3% GP on POSTER",
//    which is nonsense that would have looked authoritative on screen. GP is therefore computed
//    ONLY over rows that have one, and the response says how many rows that was so the caller
//    can show "based on 136 jobs" or suppress it entirely.
//
// SCOPING: the matched ROWS follow the sales-rep visibility rule like every other list in this
// app -- a rep sees their own history in detail. The SUMMARY is computed across the whole
// company, because a median price leaks nothing about whose customer it was and the whole value
// of the feature is knowing what the COMPANY charges, not what you personally last charged.

const MATCH_SQL = `
  SELECT sol.id, sol.description, sol.quantity, sol.units, sol.length, sol.width,
         sol.price_per_unit, sol.gp_rate, sol.job_type_id,
         so.id AS sales_order_id, so.sales_order_no, so.date_created,
         c.name AS customer_name, jt.display_name AS job_type_name,
         (
           /* Same job type is the strongest signal after the description itself: FLYERS on
              DPOD and FLYERS on LFP are different machines and different money. */
           (CASE WHEN ? > 0 AND sol.job_type_id = ? THEN 40 ELSE 0 END)
           /* Quantity matters on a log scale -- 100 vs 120 is the same job, 1 vs 1,000 is not.
              Full marks at the same order of magnitude, nothing a decade away. */
         + (CASE WHEN ? > 0 AND sol.quantity > 0
                 THEN GREATEST(0, 30 - ABS(LOG10(sol.quantity / ?)) * 30) ELSE 0 END)
         + (CASE WHEN ? <> '' AND sol.units = ? THEN 10 ELSE 0 END)
           /* Recency, gently: a price from last month beats one from 2021, but an old job of
              exactly the right shape still deserves to be seen. */
         + GREATEST(0, 20 - DATEDIFF(NOW(), so.date_created) / 180)
         ) AS score
    FROM sales_order_lines sol
    JOIN sales_orders so ON so.id = sol.sales_order_id
    LEFT JOIN customers c ON c.id = so.customer_id
    LEFT JOIN job_types jt ON jt.id = sol.job_type_id
   WHERE sol.description = ?
     AND sol.price_per_unit > 0`;

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))];
}

router.get('/', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const description = String(req.query.description || '').trim();
    // Two characters would match half the table and tell the rep nothing.
    if (description.length < 3) return res.json({ description, matches: [], summary: null });

    const jobTypeId = Number(req.query.job_type_id) || 0;
    const quantity = Number(req.query.quantity) || 0;
    const units = String(req.query.units || '').trim();
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 8));

    const scoreParams = [jobTypeId, jobTypeId, quantity, quantity || 1, units, units];

    // --- the rows this user may see ------------------------------------------------------
    const scope = await getSalesRepEmployeeScope(req.user.id, ROUTE);
    const where = [];
    const params = [...scoreParams, description];
    if (scope) {
      where.push(`so.sales_rep_id IN (${scope.map(() => '?').join(', ')})`);
      params.push(...scope);
    }
    const [matches] = await pool.query(
      `${MATCH_SQL}${where.length ? ` AND ${where.join(' AND ')}` : ''}
       ORDER BY score DESC, so.date_created DESC
       LIMIT ?`,
      [...params, limit]
    );

    // --- the company-wide picture, narrowed to comparable work ---------------------------
    // Narrowed on unit and order of magnitude, because "POSTER" spans 0.89 to 18,342 across
    // all sizes and that range is worthless. Conditioned, it becomes a usable band.
    const bandWhere = ['description = ?', 'price_per_unit > 0'];
    const bandParams = [description];
    if (units) { bandWhere.push('units = ?'); bandParams.push(units); }
    if (quantity > 0) {
      bandWhere.push('quantity BETWEEN ? AND ?');
      bandParams.push(quantity / 10, quantity * 10);
    }
    const [band] = await pool.query(
      `SELECT price_per_unit, gp_rate FROM sales_order_lines WHERE ${bandWhere.join(' AND ')}`,
      bandParams
    );

    const prices = band.map((r) => Number(r.price_per_unit)).filter(Number.isFinite).sort((a, b) => a - b);
    const gps = band.map((r) => Number(r.gp_rate)).filter((g) => Number.isFinite(g) && g > 0).sort((a, b) => a - b);

    res.json({
      description,
      matches,
      // Null rather than an empty shell when there is nothing comparable: the caller shows
      // the panel only when there is something worth showing.
      summary: prices.length ? {
        sample: prices.length,
        price_p25: percentile(prices, 0.25),
        price_median: median(prices),
        price_p75: percentile(prices, 0.75),
        price_min: prices[0],
        price_max: prices[prices.length - 1],
        // Reported with its own count, never merged into the price sample: they are different
        // populations, and 13% coverage has to be visible rather than implied.
        gp_sample: gps.length,
        gp_median: median(gps),
        narrowed_by: { units: units || null, quantity_within: quantity > 0 ? '10x either way' : null },
        // What the rep is entitled to see is fewer rows than what the median is built from;
        // saying so stops "8 matches" being read as "8 jobs in total".
        scoped: !!scope,
      } : null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
