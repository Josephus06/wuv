// Server-side access to the shared pricing formulas in shared/costing.js.
//
// That module is ESM (the ERP client imports it directly) while this server is CommonJS, so it
// is pulled in with a dynamic import() rather than require(). require(esm) would also work on
// Node 22.12+, but nothing pins the runtime -- there is no `engines` field and no nixpacks or
// railway config in this repo -- so the deployed Node version is whatever the platform defaults
// to. import() works on every Node that runs this app; require(esm) would fail on an older one,
// at runtime, in production.
//
// The module is loaded once and the promise cached, so concurrent callers share a single load.
//
//   const { computeAutoPricing } = await costing();
let cached = null;

function costing() {
  if (!cached) cached = import('../../../shared/costing.js');
  return cached;
}

module.exports = { costing };
