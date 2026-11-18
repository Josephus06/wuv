// Customer names are stored upper-cased.
//
// Asked for on the Customers list, where mixed-case entries made the same company look like two
// different ones depending on who typed it in ("Acme Corp", "ACME CORP", "acme corp"), and made
// the list read as untidy next to the codes beside it. Normalising on the way IN rather than
// upper-casing on the way out means every screen, print-out, PDF and export agrees without each
// one having to remember -- and a search or a duplicate check compares like with like.
//
// This has to live in one place because five different paths create customers: the Customers
// form, Sync-from-Source (lib/liveEstimateSync.js), converting a lead, the public website's quote
// form, and the one-off import scripts. Normalising in the form alone would have let the list
// drift straight back the first time any of the other four ran.
//
// Not applied to contact names or addresses: those are people and street lines, not the customer
// identity the list is keyed on, and shouting them serves nobody.
// null and undefined pass straight through; everything else comes back trimmed and upper-cased,
// INCLUDING a string that trims to empty. That last part matters: customers.name is NOT NULL, so
// turning a whitespace-only name into null trades bad data for a 500. Whether a blank name should
// be accepted at all is a separate question this rule does not get to decide.
function upperCustomerName(value) {
  if (value === null || value === undefined) return value;
  // toUpperCase is Unicode-aware, so accented names (Passerelles Numeriques) upper-case to their
  // accented capitals rather than being stripped or mangled.
  return String(value).trim().toUpperCase();
}

// The two customer columns the list shows and the rest of the app identifies a customer by.
// Mutates nothing: returns the value to write.
const CUSTOMER_NAME_FIELDS = ['name', 'company_name'];

module.exports = { upperCustomerName, CUSTOMER_NAME_FIELDS };
