// A day's tenders are not obliged to add up to its sales, and the import used to refuse the
// ones that did not.
//
// Two ordinary things break that identity. A day with sales taken on account -- PAY LATER or
// INVOICE on the BIR reading, receivables on the other POS -- rings up more than it collects,
// and the shortfall is the point rather than a fault; glImpact.js has always known this and
// debits the unpaid remainder to Accounts Receivable. And a POS can simply be a few pesos out
// against itself: branch 786's 08/02 reading tenders 6,603.00 against a stated 6,597.00.
// Refusing both meant a day's takings could never be recorded at all, which is a worse answer
// than recording them and saying plainly that they do not balance.
//
// tender_variance is (cash + e-wallet) - total daily sales, stored on the line the day belongs
// to. The amount rather than a flag: "this day is 6.00 short" is actionable where "this day is
// marked" is not, and zero versus NULL distinguishes a day that balanced from one imported
// before this column existed. Every screen that shows the grid reads it and marks the row.
const pool = require('../db');

async function hasColumn(table, column) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return row.n > 0;
}

(async () => {
  try {
    if (await hasColumn('sales_order_lines', 'tender_variance')) {
      console.log('sales_order_lines.tender_variance already present -- skipped');
    } else {
      await pool.query(
        'ALTER TABLE sales_order_lines ADD COLUMN tender_variance DECIMAL(14,2) NULL AFTER uncollected_sales'
      );
      console.log('sales_order_lines.tender_variance added');
    }

    // Days already imported balanced, because the old code refused anything else. Recording
    // that as 0.00 rather than leaving it NULL keeps "imported before the column existed"
    // from being confused with "never checked".
    const [res] = await pool.query(
      `UPDATE sales_order_lines
          SET tender_variance = 0
        WHERE tender_variance IS NULL AND pos_import_key IS NOT NULL`
    );
    console.log(`existing imported days marked balanced: ${res.affectedRows}`);

    console.log('Done.');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
