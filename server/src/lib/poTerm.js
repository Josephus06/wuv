// A Purchase Order's Term, and how many days it gives, for the PO screen and for the Vendor Bill
// raised from it (asked 2026-10-02: "what's the term in the PO will also be in the vendor bill").
//
// Only 29 of 2026's 3,353 POs carry a term of their own (purchase_orders.term_id); the rest -- all
// migrated ones and most made since -- leave it to the supplier, which is what the PO print has
// always shown (term_name || supplier credit_term). So a bill from those POs came out with no Term
// and a due date of the bill date (VB-24634..24638). The order of preference:
//   the PO's own term  ->  the supplier's Payment Term  ->  the supplier's Credit Term text
// and for the days: that term's no_of_days -> the supplier's term_days -> the number in the text
// ("30 DAYS PDC" -> 30; "COD" -> 0).
//
// Use with these joins in the query:
//   LEFT JOIN suppliers s ON s.id = po.supplier_id
//   LEFT JOIN payment_terms pt ON pt.id = po.term_id
//   LEFT JOIN payment_terms spt ON spt.id = s.payment_term_id
const PO_TERM_SELECT = `
  COALESCE(pt.term_name, spt.term_name, NULLIF(TRIM(s.credit_term), '')) AS term_name,
  CASE WHEN pt.id IS NOT NULL THEN pt.no_of_days
       WHEN spt.id IS NOT NULL THEN spt.no_of_days
       ELSE s.term_days END AS term_days_known`;

const PO_TERM_JOINS = `
  LEFT JOIN payment_terms pt ON pt.id = po.term_id
  LEFT JOIN payment_terms spt ON spt.id = s.payment_term_id`;

// Days for a term row selected with PO_TERM_SELECT.
function termDays(row) {
  if (row.term_days_known != null && row.term_days_known !== '') return Number(row.term_days_known) || 0;
  const text = String(row.term_name || '');
  if (/^\s*(cod|cash)\b/i.test(text)) return 0;
  const m = text.match(/(\d+)\s*(day|d\b)/i) || text.match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

module.exports = { PO_TERM_SELECT, PO_TERM_JOINS, termDays };
