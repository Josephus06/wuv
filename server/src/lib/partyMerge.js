const pool = require('../db');

// Merge two customers, or two suppliers (asked 2026-10-08): RETAIN keeps its record; DELETE's
// transactions -- estimates, orders, invoices, payments, POs, bills, cheques, contacts, addresses...
// -- are moved onto RETAIN, then DELETE's record is removed. One transaction: all of it or none.
//
// WHAT POINTS AT A PARTY is found, not listed by hand, so a table added later is not silently left
// pointing at a record that no longer exists:
//   - every column named customer_id / supplier_id (plus leads.converted_customer_id)
//   - polymorphic links: cheques.payee_type/payee_id, journal_lines and bank_deposit_lines
//     party_type/party_id, where the type is CUSTOMER or VENDOR
// Tables that cannot hold the same party twice (a tag, a job-type link, a CRM snooze) keep
// RETAIN's row and drop DELETE's duplicate. crm_attention is a nightly-rebuilt cache, so DELETE's
// row is simply dropped.
//
// Text copies of the name on old documents (a delivery stop's customer_name, a cheque's
// payee_name) are what was printed at the time and are left as they are; the opening AR / AP
// balances, which reports group by name, take RETAIN's name.
const KINDS = {
  customer: {
    table: 'customers', label: 'customer', columns: ['customer_id', 'converted_customer_id'],
    partyTypes: ['CUSTOMER'], openingTable: 'opening_ar_items', openingName: 'customer_name',
  },
  supplier: {
    table: 'suppliers', label: 'supplier', columns: ['supplier_id'],
    partyTypes: ['VENDOR', 'SUPPLIER'], openingTable: 'opening_ap_items', openingName: 'supplier_name',
  },
};
// One row per party in these, so a move can collide with a row RETAIN already has.
const ONE_PER_PARTY = new Set(['customer_tags', 'job_type_customers', 'crm_attention_snoozes']);
const CACHE_ONLY = new Set(['crm_attention']);
const POLYMORPHIC = [
  { table: 'cheques', type: 'payee_type', id: 'payee_id' },
  { table: 'journal_lines', type: 'party_type', id: 'party_id' },
  { table: 'bank_deposit_lines', type: 'party_type', id: 'party_id' },
];

async function referencingColumns(conn, kind) {
  const [rows] = await conn.query(
    `SELECT table_name AS t, column_name AS c FROM information_schema.columns
      WHERE table_schema = DATABASE() AND column_name IN (?) AND table_name <> ?
      ORDER BY table_name`, [kind.columns, kind.table]);
  return rows.map((r) => ({ table: r.t || r.TABLE_NAME, column: r.c || r.COLUMN_NAME }));
}

// Returns { retain, remove, moves: [{ table, column, rows }] }. With dryRun nothing is written.
async function mergeParty(kindKey, retainId, deleteId, { dryRun = false, userId } = {}) {
  const kind = KINDS[kindKey];
  if (!kind) throw Object.assign(new Error('Unknown kind.'), { status: 400 });
  retainId = Number(retainId); deleteId = Number(deleteId);
  if (!retainId || !deleteId) throw Object.assign(new Error(`Choose the ${kind.label} to retain and the one to delete.`), { status: 400 });
  if (retainId === deleteId) throw Object.assign(new Error(`Retain and Delete are the same ${kind.label}.`), { status: 400 });

  const conn = await pool.getConnection();
  try {
    const [found] = await conn.query(`SELECT id, name FROM ${kind.table} WHERE id IN (?, ?)`, [retainId, deleteId]);
    const retain = found.find((r) => Number(r.id) === retainId);
    const remove = found.find((r) => Number(r.id) === deleteId);
    if (!retain || !remove) throw Object.assign(new Error(`One of the two ${kind.label}s no longer exists.`), { status: 404 });

    if (!dryRun) await conn.beginTransaction();
    const moves = [];
    for (const { table, column } of await referencingColumns(conn, kind)) {
      const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE \`${column}\` = ?`, [deleteId]);
      if (!Number(n)) continue;
      moves.push({ table, column, rows: Number(n) });
      if (dryRun) continue;
      if (CACHE_ONLY.has(table)) {
        await conn.query(`DELETE FROM \`${table}\` WHERE \`${column}\` = ?`, [deleteId]);
      } else if (ONE_PER_PARTY.has(table)) {
        // Rows RETAIN already has stay; DELETE's that would duplicate them go.
        await conn.query(`UPDATE IGNORE \`${table}\` SET \`${column}\` = ? WHERE \`${column}\` = ?`, [retainId, deleteId]);
        await conn.query(`DELETE FROM \`${table}\` WHERE \`${column}\` = ?`, [deleteId]);
      } else {
        await conn.query(`UPDATE \`${table}\` SET \`${column}\` = ? WHERE \`${column}\` = ?`, [retainId, deleteId]);
      }
    }
    for (const p of POLYMORPHIC) {
      const [[{ n }]] = await conn.query(
        `SELECT COUNT(*) AS n FROM \`${p.table}\` WHERE UPPER(\`${p.type}\`) IN (?) AND \`${p.id}\` = ?`, [kind.partyTypes, deleteId]);
      if (!Number(n)) continue;
      moves.push({ table: p.table, column: p.id, rows: Number(n) });
      if (!dryRun) {
        await conn.query(`UPDATE \`${p.table}\` SET \`${p.id}\` = ? WHERE UPPER(\`${p.type}\`) IN (?) AND \`${p.id}\` = ?`,
          [retainId, kind.partyTypes, deleteId]);
      }
    }

    if (dryRun) return { retain, remove, moves };

    // The opening balances group by name in the aging reports, so they follow the retained one.
    await conn.query(`UPDATE ${kind.openingTable} SET ${kind.openingName} = ? WHERE ${kind.columns[0]} = ?`, [retain.name, retainId]);
    await conn.query(`DELETE FROM ${kind.table} WHERE id = ?`, [deleteId]);
    const summary = moves.map((m) => `${m.table}.${m.column}: ${m.rows}`).join('; ').slice(0, 1900);
    await conn.query(
      `INSERT INTO audit_logs (auditable_type, auditable_id, event_type, field_name, old_value, new_value, set_by_user_id)
       VALUES (?, ?, 'Updated', 'merged', ?, ?, ?)`,
      [kind.label === 'customer' ? 'Customer' : 'Supplier', retainId, `#${deleteId} ${remove.name}`, summary || 'no transactions', userId]);
    await conn.commit();
    return { retain, remove, moves };
  } catch (err) {
    if (!dryRun) await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { mergeParty };
