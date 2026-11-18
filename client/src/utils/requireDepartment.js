// Mirrors server/src/lib/requireDepartment.js -- Department is required on every Sales,
// Purchasing, Accounting / Treasury and Inventory transaction. The server enforces it; forms call
// these first so the user is told before saving. Each returns an error message or null.
const blank = (v) => v === undefined || v === null || v === '' || v === 0 || v === '0';

export function headerDepartmentError(value, label = 'Department') {
  return blank(value) ? `Select a ${label} -- it is required.` : null;
}

export function lineDepartmentError(lines, { key = 'department_id', label = 'Department' } = {}) {
  const list = Array.isArray(lines) ? lines : [];
  const idx = list.findIndex((l) => blank(l?.[key]));
  if (idx === -1) return null;
  const missing = list.filter((l) => blank(l?.[key])).length;
  return missing === 1
    ? `Select a ${label} on line ${idx + 1} -- it is required.`
    : `Select a ${label} on every line -- ${missing} lines have none (the first is line ${idx + 1}).`;
}
