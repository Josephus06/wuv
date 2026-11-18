// One customer per name (asked 2026-10-03; since 2026-10-13 the form allows a same-named customer
// with its own TIN or address -- see findExactCustomer: "don't allow duplicate saving of customer"). Two
// customers are the same name when they agree after dropping case, spaces and punctuation --
// "ADR GLOBAL TRANSPORT INC." and "ADR GLOBAL TRANSPORT, INC." are one company, as are the two
// "ARLYN CHING" rows saved a minute apart on 2026-10-02. 153 such groups were already on file
// then; this stops new ones, it does not merge the old.
const nameKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// The existing customer a name would duplicate, or null. `excludeId` skips the record being
// edited, so re-saving a customer under its own name is not a clash.
async function findCustomerByName(conn, name, excludeId = null) {
  const key = nameKey(name);
  if (!key) return null;
  const [[row]] = await conn.query(
    `SELECT id, name, customer_code FROM customers
      WHERE LOWER(REGEXP_REPLACE(name, '[^A-Za-z0-9]', '')) = ? AND id <> ?
      ORDER BY id LIMIT 1`,
    [key, excludeId || 0]);
  return row || null;
}

// The customer form only refuses a save that matches an existing customer on ALL of name, TIN and
// address (asked 2026-10-13): one name can be two customers -- branches, or people who share a name
// -- told apart by TIN or address. Each is compared the way the name is, so "123-456-789-000" and
// "123456789000", or a changed comma in the address, are still the same. A blank matches a blank.
// The name-only finder above stays for the places that MATCH a name to a customer (estimate sync,
// public quotes, lead conversion) rather than guard a save.
async function findExactCustomer(conn, { name, tin, address }, excludeId = null) {
  const key = nameKey(name);
  if (!key) return null;
  const [[row]] = await conn.query(
    `SELECT id, name, customer_code, tin, address FROM customers
      WHERE LOWER(REGEXP_REPLACE(name, '[^A-Za-z0-9]', '')) = ?
        AND LOWER(REGEXP_REPLACE(COALESCE(tin, ''), '[^A-Za-z0-9]', '')) = ?
        AND LOWER(REGEXP_REPLACE(COALESCE(address, ''), '[^A-Za-z0-9]', '')) = ?
        AND id <> ?
      ORDER BY id LIMIT 1`,
    [key, nameKey(tin), nameKey(address), excludeId || 0]);
  return row || null;
}

function exactDuplicateMessage(existing) {
  return `"${existing.name}"${existing.customer_code ? ` (${existing.customer_code})` : ''} is already on file with the same TIN and address. Use that customer, or enter this one's own TIN or address.`;
}

function duplicateMessage(existing) {
  return `A customer named "${existing.name}"${existing.customer_code ? ` (${existing.customer_code})` : ''} already exists. Use that customer instead of saving another.`;
}

module.exports = { nameKey, findCustomerByName, duplicateMessage, findExactCustomer, exactDuplicateMessage };
