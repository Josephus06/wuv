// The company a request is about, for routers whose many queries all need the same filter (the BIR
// Reports): one middleware resolves ?companyId= / ?locationId= once, and every query on that request
// reads its documents through scopedTable() instead of naming the table.
//
//   router.use(companyScopeMiddleware());
//   `... FROM ${scopedTable('sales_invoices')} si ...`
//
// scopedTable returns the bare table name when the request has no scope (the consolidated Wu Ventures
// view) and otherwise a derived table of that company's branches' rows -- so the SQL around it,
// joins and WHERE clauses alike, is unchanged. The branch ids are integers read from `locations`,
// never from the request, so they are safe to inline.
const { AsyncLocalStorage } = require('async_hooks');
const { scopeFromQuery, resolveScope } = require('./companyScope');

const store = new AsyncLocalStorage();

function companyScopeMiddleware() {
  return async (req, res, next) => {
    try {
      const resolved = await resolveScope(scopeFromQuery(req.query));
      store.run(resolved, next);
    } catch (err) { next(err); }
  };
}

// The resolved scope of the current request (lib/companyScope.js resolveScope), or null.
function currentScope() {
  return store.getStore() || null;
}

// `table`, or `(SELECT * FROM table WHERE office_location_id IN (...))` under a company / branch scope.
function scopedTable(table) {
  const scope = currentScope();
  if (!scope) return table;
  const ids = [...scope.locationIds].map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return `(SELECT * FROM ${table} WHERE office_location_id IN (${ids.length ? ids.join(', ') : 'NULL'}))`;
}

module.exports = { companyScopeMiddleware, currentScope, scopedTable };
