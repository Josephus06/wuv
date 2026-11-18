// Allocating the next document number for a table whose number column is UNIQUE.
//
// WHY THIS IS NOT JUST `PO-${insertId}`. Documents were imported from the live system carrying
// THEIR ORIGINAL NUMBERS while their ids were reassigned, so a number and the id of the row
// holding it have nothing to do with each other: PO-19571 belongs to row 438. Deriving the number
// from the auto-increment works right up until that counter climbs into the range the imported
// numbers occupy, and then every create is a coin toss -- "Duplicate entry 'PO-19571' for key
// 'purchase_orders.po_no'" is that coin landing badly. Measured on purchase_orders: 19,470 of
// 19,475 rows carry a number that is not their own id, and 498 of those sit at or above the next
// id, so they were 498 failures waiting to happen.
//
// Transfer orders, fulfilments and receipts hit this first and were fixed in place; this is that
// fix lifted out so the next table does not have to rediscover it.
const pool = require('../db');

// Read on the POOL, not on the caller's connection, and deliberately so.
//
// The caller is inside a transaction, and InnoDB's default REPEATABLE READ pins that transaction
// to the snapshot of its first read. So when two creates race, the loser's retry re-reads its own
// stale snapshot, cannot see the row the winner just committed, computes the same number again,
// and fails on every attempt. A separate autocommit connection sees the current committed state,
// which is what "the next free number" has to mean.
// ...AND ALSO ON THE CALLER'S CONNECTION, taking whichever is higher.
//
// The pool alone is not enough, and the case it misses is not exotic: one request that creates
// SEVERAL numbered documents in one transaction. A Purchase Order request splits its lines by
// supplier and inserts one PO per group, all before committing. The pool cannot see rows this
// transaction has not committed, so the second PO computed the SAME number as the first and
// collided with its own sibling -- immediately, not by blocking, because they share a
// transaction. Every retry recomputed the same number from the same pool, so all five failed and
// the whole request rolled back. Measured on the droplet: five attempts, all 'PO-20088', and no
// PO-20088 in the table afterwards because the rollback took the first one with it.
//
// So: the pool answers "what has everyone else committed", the caller's connection answers "what
// have I taken already", and the next number has to clear both.
//
// TWO BOXES, ONE NUMBER SPACE (2026-10-03). The droplet and the office box replicate both ways and
// both take new documents, so "highest + 1" on each could hand out the same number twice -- and a
// duplicate on a UNIQUE column stops replication dead (CPAY-37 and PO-20644 did, 2026-10-02/03).
// So the two boxes split the numbers: the droplet issues only ODD numbers, the office box only
// EVEN ones -- the same idea as their auto-increment offsets. Both count every number when finding
// the highest, so each box's next number still follows the latest document wherever it was made;
// the cost is that a box skips the other's numbers (CPAY-61, 63, 65 on the droplet).
//
// (For an hour on 2026-10-03 the office box suffixed -O instead; those numbers are still counted.)
//
// THREE BOXES (2026-10-07, the SM branch server). Odd/even only splits two ways, so the rule is now
// general: N boxes share the number space and each owns the numbers where number % N equals its
// auto-increment offset % N -- the droplet (offset 1), the office (2) and SM (3). With N = 2 that is
// exactly odd/even, so this changed nothing until N was raised.
//
// N is NOT per-box configuration. It lives in app_settings ('doc_no_slots', db/create-app-settings.js),
// which replicates, and is read on every number: raising it is one UPDATE on the droplet that reaches
// every box at once. Were each box told separately, a box still splitting two ways beside one splitting
// three ways would hand out the same number (4 is even AND 4 % 3 = 1), and a duplicate on a UNIQUE
// column stops replication.
async function nextDocNo(table, column, prefix, conn = null) {
  const parity = await docNoParity();
  const sql = 'SELECT COALESCE(MAX(CAST(SUBSTRING(??, ?) AS UNSIGNED)), 0) AS n FROM ?? WHERE ?? REGEXP ?';
  const params = [column, prefix.length + 1, table, column, docNoPattern(prefix)];

  const [[committed]] = await pool.query(sql, params);
  let highest = Number(committed.n);

  if (conn) {
    const [[mine]] = await conn.query(sql, params);
    highest = Math.max(highest, Number(mine.n));
  }
  return `${prefix}${nextOnThisBox(highest, parity)}`;
}

// This box's share of the numbers: { slots: N, slot } -- it issues n where n % N === slot -- or null
// on a standalone install (Railway, a laptop), which keeps plain highest + 1. The box is told apart
// by MySQL's own replication settings: auto_increment_increment > 1 only on replicated boxes, and
// auto_increment_offset 1 on the droplet, 2 on the office, 3 on SM (REPLICATION-RECOVERY.md), read
// once per process. N is read from app_settings every time (see above); 2 when the row or the
// table is not there yet, which is the odd/even split the pair has always used.
// DOC_NO_PARITY in .env ("odd" / "even" / "none") overrides, as a two-way split.
let offsetPromise = null;
async function docNoParity() {
  const env = process.env.DOC_NO_PARITY;
  if (env) return env === 'odd' ? { slots: 2, slot: 1 } : env === 'even' ? { slots: 2, slot: 0 } : null;
  if (!offsetPromise) {
    offsetPromise = pool.query('SELECT @@auto_increment_increment AS inc, @@auto_increment_offset AS o')
      .then(([[r]]) => (Number(r.inc) > 1 ? Number(r.o) : null))
      .catch((err) => { offsetPromise = null; throw err; });
  }
  const offset = await offsetPromise;
  if (offset == null) return null;
  let slots = 2;
  try {
    const [[row]] = await pool.query("SELECT value FROM app_settings WHERE name = 'doc_no_slots'");
    if (row && Number(row.value) >= 2) slots = Number(row.value);
  } catch (err) {
    if (err.code !== 'ER_NO_SUCH_TABLE') throw err; // before db/create-app-settings.js has run
  }
  return { slots, slot: offset % slots };
}

// The smallest number above `highest` that this box may issue.
function nextOnThisBox(highest, share) {
  let n = Number(highest) + 1;
  if (!share) return n;
  while (n % share.slots !== share.slot) n += 1;
  return n;
}

// The numbers counted when finding the highest: plain ones, plus the -O ones the office box issued
// briefly on 2026-10-03 (CAST('62-O' AS UNSIGNED) reads 62).
function docNoPattern(prefix) {
  return `^${prefix}[0-9]+(-O)?$`;
}

// Insert a row whose document number has to be unique, writing that number in the INSERT itself.
//
// A two-step insert -- put a placeholder in, UPDATE the real number after -- cannot work on a
// UNIQUE column: two people creating at the same moment collide on the placeholder before either
// has a number at all. Reading the maximum and inserting still is not atomic either, so a clash is
// RETRIED rather than prevented: the loser simply takes the next number. A duplicate-key error
// does not abort a MySQL transaction, so the retry is safe inside the caller's.
async function insertNumbered(conn, { table, column, prefix, run }) {
  for (let attempt = 0; ; attempt += 1) {
    // The caller's connection is passed in, so a second document created in the same transaction
    // sees the first one and takes the number after it rather than colliding with it.
    const no = await nextDocNo(table, column, prefix, conn);
    try {
      const [result] = await run(no);
      return { id: result.insertId, no };
    } catch (err) {
      // Anything but a number clash is a real failure, and so is losing the race five times.
      if (err.code !== 'ER_DUP_ENTRY' || attempt >= 4) throw err;
    }
  }
}

// Number a row that was ALREADY inserted (with a blank or placeholder number) -- the
// insert-then-number pattern most create routes use. They used to write `PREFIX-${insertId}`,
// which is exactly the id-vs-imported-number collision described at the top of this file: on the
// droplet on 2026-09-28 the next cheque id produced CHK-15613, a number an imported cheque
// already held, so every new cheque failed. This takes the next free number instead, and on a
// clash (two creates racing) simply takes the one after.
async function assignDocNo(conn, { table, column, prefix, id }) {
  for (let attempt = 0; ; attempt += 1) {
    const no = await nextDocNo(table, column, prefix, conn);
    try {
      await conn.query('UPDATE ?? SET ?? = ? WHERE id = ?', [table, column, no, id]);
      return no;
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY' || attempt >= 4) throw err;
    }
  }
}

// A child document numbered after its parent: `${base}-1`, `${base}-2`, ... (a Landed Cost PO under
// its mother PO: PO-20604-1, asked 2026-10-09). The suffix follows the same per-box split as
// nextDocNo, for the same reason -- two boxes each issuing PO-20604-1 while out of touch is a
// duplicate on a UNIQUE column, and that stops replication. So a box skips the other boxes' suffixes
// (on three boxes the droplet issues -1, -4, ..., the office -2, -5, ...), as top-level numbers do.
// Found on the pool AND the caller's connection, and retried on a clash, like insertNumbered.
async function insertSuffixed(conn, { table, column, base, run }) {
  const suffixRe = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-([0-9]+)$`);
  const highestOn = async (q) => {
    const [rows] = await q.query('SELECT ?? AS no FROM ?? WHERE ?? LIKE ?', [column, table, column, `${base}-%`]);
    return rows.reduce((max, r) => {
      const m = suffixRe.exec(r.no);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
  };
  const share = await docNoParity();
  for (let attempt = 0; ; attempt += 1) {
    const highest = Math.max(await highestOn(pool), await highestOn(conn));
    const no = `${base}-${nextOnThisBox(highest, share)}`;
    try {
      const [result] = await run(no);
      return { id: result.insertId, no };
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY' || attempt >= 4) throw err;
    }
  }
}

module.exports = { nextDocNo, insertNumbered, insertSuffixed, assignDocNo, docNoParity, nextOnThisBox, docNoPattern };
