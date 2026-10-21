import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/useAuth';
import Avatar from './Avatar';
import ChatWidget from './ChatWidget';
import NotificationBell from './NotificationBell';
import TimeClockChip from './TimeClockChip';
import { resolveTheme, setTheme, watchSystemTheme } from '../utils/theme';
import { COMPANY } from '../config/company';

// Mirrors the real GraphicStar system's topbar arrangement: a row of category
// dropdowns (Master Lists, Inventory, Sales, Costing, ...) instead of a left
// sidebar. Each category groups the pages we've actually built under the same
// names the real system uses for them.
const NAV_STRUCTURE = [
  { route: '/dashboard', label: 'Dashboard' },
  { route: '/tickets', label: 'Tickets' },
  // The clickable order-to-cash chart -- a guide to the other modules rather than a
  // module of its own, so it sits at top level next to Dashboard.
  { route: '/process-flow', label: 'Manual' },
  {
    label: 'CRM',
    children: [
      { route: '/crm-dashboard', label: 'CRM Dashboard' },
      { route: '/leads', label: 'Leads' },
      { route: '/pipeline', label: 'Pipeline' },
    ],
  },
  {
    label: 'Commission',
    children: [
      { route: '/commission-schemes', label: 'Commission Table' },
      { route: '/employee-quotas', label: 'Employee Quota' },
      { route: '/commission-report', label: 'Commission' },
      // Shares the Commission Report's permission (its backend route does too) rather than
      // having its own pages row.
      { route: '/commission-jo-detail', permRoute: '/commission-report', label: 'Commission JO Detail' },
    ],
  },
  {
    label: 'HR',
    sections: [
      {
        title: 'Time & Attendance',
        items: [
          // Everyone's own time clock: shown to any account linked to an employee, with no
          // pages row -- the API only ever stamps the caller's own employee.
          { route: '/my-attendance', label: 'My Attendance', forEmployees: true },
          { route: '/attendance', label: 'Attendance' },
          { route: '/schedule', label: 'Schedule' },
          { route: '/shift-assignments', label: 'Shift Assignments' },
          { route: '/shifts', label: 'Shifts' },
          { route: '/kiosk-devices', label: 'Time Clock Devices' },
        ],
      },
      {
        title: 'Payroll',
        items: [
          { route: '/payroll', label: 'Payroll' },
          { route: '/payroll-pay-items', label: 'Allowances & Deductions' },
          { route: '/payroll-loans', label: 'Loans' },
          { route: '/payroll-holidays', label: 'Holidays' },
          { route: '/payroll-settings', label: 'Payroll Settings' },
        ],
      },
    ],
  },
  {
    label: 'Master Lists',
    children: [
      { route: '/employees', label: 'Employees' },
      { route: '/users', label: 'Users & Permissions' },
      { route: '/customers', label: 'Customers' },
      { route: '/suppliers', label: 'Suppliers' },
      { route: '/job-types', label: 'Job Types' },
      { route: '/pms-job-types', label: 'PMS Job Types' },
      { route: '/inventory', label: 'Inventory Items' },
      { route: '/service-items', label: 'Service Items' },
      { route: '/lookups', label: 'Lookups' },
      { route: '/transaction-settings', label: 'Transaction Settings' },
    ],
  },
  {
    label: 'Inventory',
    // Two-column mega-menu mirroring the live Inventory dropdown: documents you post on the
    // left, things you read on the right. Inventory Items moved to Master Lists, next to
    // Service Items -- it's a master record, not an inventory transaction or report.
    //
    // The live menu also lists Reallocate Items, RMI, Office Supply Requisition Fulfillment,
    // Inventory Reports, Approved Inventory Adjustments, Fulfilled/Received Transfer Orders,
    // Fulfilled Office Supply Requisitions, Received RMIs and Monthly Output. Those aren't
    // pages in this build (Reallocate and OSR Fulfillment exist only as sub-routes reached
    // from their parent document), so they're left out rather than added as dead links.
    sections: [
      {
        title: 'Transactions',
        items: [
          { route: '/inventory-adjustments', label: 'Inventory Adjustments' },
          { route: '/transfer-orders', label: 'Transfer Orders' },
          { route: '/item-fulfillments', permRoute: '/transfer-orders', label: 'Item Fulfillments' },
          { route: '/item-receipts', permRoute: '/transfer-orders', label: 'Item Receipts' },
          { route: '/office-supply-requisitions', label: 'Office Supply Requisition' },
        ],
      },
      {
        title: 'Reports',
        items: [
          { route: '/stock-ledger-reports', label: 'Stock Ledger' },
          { route: '/bin-card-reports', label: 'Bin Card' },
        ],
      },
    ],
  },
  {
    label: 'Sales',
    children: [
      { route: '/estimates', label: 'Estimates' },
      { route: '/sales-orders', label: 'Sales Orders' },
      { route: '/non-standard-job-orders', label: 'NSTDJO' },
      { route: '/non-standard-sales-orders', label: 'NSSO' },
      { route: '/warranty-certificates', label: 'Warranty Certificate' },
      { route: '/job-orders', label: 'Job Orders' },
    ],
  },
  {
    label: 'Costing',
    children: [
      { route: '/process-costing', label: 'Process Costing' },
      { route: '/material-costing', label: 'Material Costing' },
    ],
  },
  {
    label: 'Design',
    children: [
      { route: '/assigned-jo', label: 'Assigned JO' },
      { route: '/reports/artist-incentive', label: 'Artist Incentive Report' },
    ],
  },
  {
    label: 'Purchasing',
    children: [
      { route: '/purchase-requisitions', label: 'Purchase Requisitions' },
      { route: '/place-order-form', label: 'Place Order Form' },
      { route: '/purchase-orders', label: 'Purchase Orders' },
    ],
  },
  {
    label: 'Production',
    children: [
      { route: '/production', label: 'Production' },
      { route: '/rwip-job-orders', label: 'RWIP' },
      { route: '/rfqc-job-orders', label: 'RFQC' },
      { route: '/scheduled-jo', label: 'Scheduled JO' },
      { route: '/assembly-builds', label: 'Assembly Build' },
      // Quality Inspection / Item Delivery don't have their own `pages` row -- their
      // backend routes intentionally reuse Production's / Sales Orders' permission
      // scope (see qualityInspections.js / itemDeliveries.js), so the nav visibility
      // check below needs to look at permRoute instead of the link's own route.
      { route: '/quality-inspections', permRoute: '/production', label: 'Quality Inspection' },
      { route: '/item-deliveries', permRoute: '/sales-orders', label: 'Item Delivery' },
    ],
  },
  {
    label: 'Accounting',
    // Last group on the bar, so its (wide) menu is right-anchored to stay on screen.
    alignRight: true,
    // Grouped mega-menu mirroring the live Accounting dropdown: Transactions / Setups / Reports
    // columns. Only the pages this build actually has are listed under each heading.
    sections: [
      {
        title: 'Transactions',
        items: [
          { route: '/sales-invoices', label: 'Invoice' },
          { route: '/delivery-tickets', label: 'Delivery Ticket' },
          { route: '/customer-payments', label: 'Customer Payments' },
          { route: '/customer-refunds', label: 'Customer Refunds' },
          { route: '/credit-memos', label: 'Credit Memo' },
          { route: '/vendor-bills', label: 'Vendor Bill' },
          { route: '/bill-payments', label: 'Bill Payment' },
          { route: '/bill-credits', label: 'Bill Credit' },
          { route: '/cheques', label: 'Cheque' },
          { route: '/journals', label: 'Journal' },
          { route: '/deposits', label: 'Deposit' },
          { route: '/fund-transfers', label: 'Fund Transfer' },
          { route: '/commission-payables', label: 'Commission Payable' },
          { route: '/commission-vouchers', label: 'Commission Voucher' },
        ],
      },
      {
        title: 'Setups',
        items: [
          { route: '/chart-of-account-types', label: 'Chart Of Account Types' },
          { route: '/chart-of-accounts', label: 'Chart Of Accounts' },
        ],
      },
      {
        title: 'Manage Accounting',
        items: [
          { route: '/manage-accounting-period', label: 'Manage Accounting Period' },
        ],
      },
      {
        title: 'Reports',
        items: [
          { route: '/reports/trial-balance', label: 'Trial Balance' },
          { route: '/reports/income-statement', label: 'Income Statement' },
          { route: '/reports/balance-sheet', label: 'Balance Sheet' },
          { route: '/reports/ar-aging', label: 'AR Aging' },
          { route: '/reports/general-ledger', label: 'General Ledger' },
        ],
      },
    ],
  },
];

// A nav group's leaf links, whether it uses a flat `children` list or grouped `sections`.
function childrenOf(item) {
  if (item.sections) return item.sections.flatMap((s) => s.items);
  return item.children || [];
}

// Flattened route -> label lookup for the browser tab title, reusing the exact same
// labels the nav menu shows -- one source of truth instead of a second hardcoded list.
// Sorted longest-route-first so a detail/edit sub-route (e.g. /chart-of-accounts/123)
// prefix-matches its own section (/chart-of-accounts) rather than a shorter unrelated
// route that happens to also be a prefix.
const FLAT_ROUTES = NAV_STRUCTURE
  .flatMap((item) => (item.children || item.sections ? childrenOf(item) : [item]))
  .map((c) => ({ route: c.route, label: c.label }))
  .sort((a, b) => b.route.length - a.route.length);

const TITLE_SUFFIX_WORDS = { new: 'New', edit: 'Edit', print: 'Print' };

// Derives "{Section} | {Mode}" generically for every page in the app, not just one
// section -- every route here follows the same nesting convention (base = the section's
// own page/list, /new = Create, /:id = View, /:id/edit = Edit, /:id/<action> = that
// action), so the mode can be inferred from the URL shape itself instead of every
// individual page component having to set its own document.title. The base route stays
// unsuffixed (works equally well whether that section is a real list, like Purchase
// Orders, or a single-page utility, like Dashboard/Lookups). Numeric segments (record
// IDs) are stripped out before picking the mode word, so e.g. /purchase-orders/29/return
// reads as "Purchase Orders | Return", not "Purchase Orders | 29".
function deriveTitle(pathname) {
  const match = FLAT_ROUTES.find((r) => pathname === r.route || pathname.startsWith(`${r.route}/`));
  if (!match) return null;

  const remainder = pathname.slice(match.route.length).split('/').filter(Boolean);
  if (remainder.length === 0) return match.label;

  const words = remainder.filter((seg) => !/^\d+$/.test(seg));
  if (words.length === 0) return `${match.label} | View`;

  const last = words[words.length - 1];
  const suffix = TITLE_SUFFIX_WORDS[last] || last.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return `${match.label} | ${suffix}`;
}

export default function Layout() {
  const { user, logout, can } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState(null);
  // Seeded from whatever index.html already resolved before paint, so this never disagrees
  // with what's on screen.
  const [theme, setThemeState] = useState(resolveTheme);

  // Only fires while the user hasn't picked a side -- see watchSystemTheme.
  useEffect(() => watchSystemTheme(setThemeState), []);

  function toggleTheme() {
    setThemeState(setTheme(theme === 'dark' ? 'light' : 'dark'));
  }

  // Closing on every route change covers both a leaf-link tap (goes straight to the new
  // page) and the browser back/forward buttons -- either way the mobile panel shouldn't
  // still be covering the screen afterward.
  useEffect(() => {
    setMobileOpen(false);
    setExpandedGroup(null);
  }, [location.pathname]);

  useEffect(() => {
    const title = deriveTitle(location.pathname);
    document.title = title ? `${title} - WVI` : 'WVI';
  }, [location.pathname]);

  function handleLogout() {
    logout();
    navigate('/login');
  }

  const canSee = (c) => (c.forEmployees ? !!user?.employee_id : can(c.permRoute || c.route, 'can_view'));
  const visibleStructure = NAV_STRUCTURE
    .map((item) => {
      if (item.sections) {
        const sections = item.sections
          .map((s) => ({ ...s, items: s.items.filter(canSee) }))
          .filter((s) => s.items.length > 0);
        return { ...item, sections };
      }
      if (item.children) return { ...item, children: item.children.filter(canSee) };
      return item;
    })
    .filter((item) => {
      if (item.sections) return item.sections.length > 0;
      if (item.children) return item.children.length > 0;
      return can(item.route, 'can_view');
    });

  return (
    <div className="app-shell">
      <header className="topnav">
        <button
          type="button"
          className="topnav-hamburger"
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          onClick={() => setMobileOpen((o) => !o)}
        >
          {mobileOpen ? '✕' : '☰'}
        </button>
        <div className="topnav-brand">
          <span className="topnav-brand-full">{COMPANY.name}</span>
          <span className="topnav-brand-short">{COMPANY.short}</span>
        </div>
        <nav className="topnav-menu">
          {visibleStructure.map((item) => (item.children || item.sections ? (
            <div key={item.label} className="topnav-dropdown">
              <button
                type="button"
                className={childrenOf(item).some((c) => location.pathname.startsWith(c.route)) ? 'active' : ''}
              >
                {item.label} <span className="caret">▾</span>
              </button>
              {item.sections ? (
                <div className={`topnav-dropdown-menu topnav-mega ${item.alignRight ? 'topnav-mega-right' : ''}`}>
                  {item.sections.map((s) => (
                    <div key={s.title} className="topnav-mega-col">
                      <div className="topnav-mega-title">{s.title}</div>
                      {s.items.map((c) => (
                        <NavLink key={c.route} to={c.route} className={({ isActive }) => (isActive ? 'active' : '')}>
                          {c.label}
                        </NavLink>
                      ))}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="topnav-dropdown-menu">
                  {item.children.map((c) => (
                    <NavLink key={c.route} to={c.route} className={({ isActive }) => (isActive ? 'active' : '')}>
                      {c.label}
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <NavLink key={item.route} to={item.route} className={({ isActive }) => (isActive ? 'active' : '')}>
              {item.label}
            </NavLink>
          )))}
        </nav>
        <div className="topnav-user">
          <button
            type="button"
            className={`theme-toggle ${theme === 'dark' ? 'is-night' : 'is-day'}`}
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to day mode' : 'Switch to night mode'}
            aria-label={theme === 'dark' ? 'Switch to day mode' : 'Switch to night mode'}
            aria-pressed={theme === 'dark'}
          >
            <span className="theme-toggle-label">{theme === 'dark' ? 'NIGHT MODE' : 'DAY MODE'}</span>
            <span className="theme-toggle-knob" aria-hidden="true">
              {theme === 'dark' ? (
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5Z" />
                  <path d="M16.5 4.2v2.2M15.4 5.3h2.2M19.4 7.6v1.5M18.6 8.4h1.5" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                  <circle cx="12" cy="12" r="4.2" />
                  <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4 17 7M7 17l-1.6 1.6" />
                </svg>
              )}
            </span>
          </button>
          {user?.employee_id && <TimeClockChip />}
          <NotificationBell />
          <Avatar user={user} size={28} />
          <span className="muted topnav-user-name">{user?.display_name}</span>
          <button className="btn btn-sm" onClick={handleLogout}>Log out</button>
        </div>
      </header>

      {mobileOpen && (
        <>
          <div className="topnav-mobile-backdrop" onClick={() => setMobileOpen(false)} />
          {/* Click-to-expand accordion instead of the desktop menu's hover flyouts --
              hover has no equivalent on touch, so each group toggles open in place. */}
          <nav className="topnav-mobile-panel">
            {visibleStructure.map((item) => (item.children || item.sections ? (
              <div key={item.label} className="topnav-mobile-group">
                <button
                  type="button"
                  className={`topnav-mobile-group-toggle ${childrenOf(item).some((c) => location.pathname.startsWith(c.route)) ? 'active' : ''}`}
                  onClick={() => setExpandedGroup((g) => (g === item.label ? null : item.label))}
                >
                  {item.label}
                  <span className={`caret ${expandedGroup === item.label ? 'open' : ''}`}>▾</span>
                </button>
                {expandedGroup === item.label && (
                  <div className="topnav-mobile-group-items">
                    {item.sections ? item.sections.map((s) => (
                      <div key={s.title}>
                        <div className="topnav-mega-title" style={{ padding: '8px 0 2px' }}>{s.title}</div>
                        {s.items.map((c) => (
                          <NavLink key={c.route} to={c.route} className={({ isActive }) => (isActive ? 'active' : '')}>
                            {c.label}
                          </NavLink>
                        ))}
                      </div>
                    )) : item.children.map((c) => (
                      <NavLink key={c.route} to={c.route} className={({ isActive }) => (isActive ? 'active' : '')}>
                        {c.label}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <NavLink key={item.route} to={item.route} className={({ isActive }) => `topnav-mobile-link ${isActive ? 'active' : ''}`}>
                {item.label}
              </NavLink>
            )))}
          </nav>
        </>
      )}

      <div className="main">
        <div className="content">
          <Outlet />
        </div>
      </div>

      <ChatWidget />
    </div>
  );
}
