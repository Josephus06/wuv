// Undertime counted in blocks, set per shift (e.g. 60: leaving 1 to 60 minutes early is 1
// hour of undertime, 61 to 120 is 2 hours).
//
//   shifts.undertime_block_minutes            NULL = the actual minutes.
//   attendance_logs.undertime_block_minutes   The same, copied onto each record.
//
// Idempotent:
//   node src/db/add-undertime-blocks.js --dry-run
//   node src/db/add-undertime-blocks.js
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

async function columnExists(table, column) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return row.n > 0;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(DRY_RUN ? 'DRY RUN -- reporting only, nothing will be written.\n' : 'APPLYING changes.\n');

  for (const table of ['shifts', 'attendance_logs']) {
    const label = `${table}.undertime_block_minutes`;
    if (await columnExists(table, 'undertime_block_minutes')) console.log(`${label} -- already present, skipped`);
    else if (DRY_RUN) console.log(`Would apply: ${label}`);
    else {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN undertime_block_minutes INT NULL`);
      console.log(`${label} -- done`);
    }
  }

  await pool.end();
  console.log('Done.');
}

main().catch((err) => { console.error('Undertime blocks migration failed:', err.message); process.exit(1); });
