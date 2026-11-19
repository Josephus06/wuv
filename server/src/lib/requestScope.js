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

// The company picked in the topbar's company switcher rides on every API call as an
// X-Company-Id header (client/src/api/client.js). Mounted once in index.js ahead of the routers, it
// makes that company the request's scope, so every list, report and dashboard figure that reads
// currentScope() / companyWhere() shows only that company's branches. No header (Wu Venture) = all.
// Company -> branches is cached briefly: it is read on every request and changes rarely.
const cache = new Map();
const CACHE_MS = 60 * 1000;
async function scopeForCompany(companyId) {
  const id = Number(companyId) > 0 ? Number(companyId) : null;
  if (!id) return null;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.scope;
  const scope = await resolveScope({ companyId: id });
  cache.set(id, { at: Date.now(), scope });
  return scope;
}

function headerScopeMiddleware() {
  return async (req, res, next) => {
    try {
      const scope = await scopeForCompany(req.get('x-company-id'));
      store.run(scope, next);
    } catch (err) { next(err); }
  };
}

// A router-level scope from ?companyId= / ?locationId=; with neither, the header's company stands.
function companyScopeMiddleware() {
  return async (req, res, next) => {
    try {
      const q = scopeFromQuery(req.query);
      const resolved = (q.companyId || q.locationId) ? await resolveScope(q) : currentScope();
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

// `column IN (<the scope's branch ids>)` for a list's WHERE, or null when every company is shown.
// Rows with no branch belong to no company, so a company view leaves them out.
function companyWhere(column) {
  const scope = currentScope();
  if (!scope) return null;
  const ids = [...scope.locationIds].map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return `${column} IN (${ids.length ? ids.join(', ') : 'NULL'})`;
}

module.exports = { headerScopeMiddleware, companyScopeMiddleware, currentScope, scopedTable, companyWhere };
