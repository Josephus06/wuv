// Single source of truth for company branding.
//
// Everything here is overridable from the environment at build time, so standing up the
// system for another company is a .env change plus swapping the images in client/public --
// no hunting through JSX for hardcoded names. Set these in client/.env (see .env.example):
//
//   VITE_COMPANY_NAME="Acme Imaging Corp."
//   VITE_COMPANY_SHORT="ACME"
//   ...
//
// Vite inlines import.meta.env.* at build time, so these must be set before `npm run build`,
// not at runtime on the server.
const env = import.meta.env;

export const COMPANY = {
  // Full legal name -- topbar, login screen, "make cheques payable to".
  name: env.VITE_COMPANY_NAME || 'Your Company Inc.',
  // Short form for tight spaces (print letterheads, mobile topbar).
  short: env.VITE_COMPANY_SHORT || 'COMPANY',
  // Greeting on the dashboard, e.g. "Good Day Acmer".
  demonym: env.VITE_COMPANY_DEMONYM || 'Team',
  // Strapline under the company name on the login screen.
  tagline: env.VITE_COMPANY_TAGLINE || '',

  addressLine1: env.VITE_COMPANY_ADDRESS1 || '',
  addressLine2: env.VITE_COMPANY_ADDRESS2 || '',
  phone: env.VITE_COMPANY_PHONE || '',
  website: env.VITE_COMPANY_WEBSITE || '',

  // The courts named in the Delivery Ticket's terms, e.g. "the City of Cebu". Blank leaves that
  // sentence off the print-out.
  jurisdiction: env.VITE_COMPANY_JURISDICTION || '',

  // Shown on the Estimate print-out's payment instructions. One bank account per line.
  bankAccounts: (env.VITE_COMPANY_BANKS || '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean),
};

// Used by the packaged mobile app, which can't rely on the dev server's /api proxy.
export const NATIVE_API_BASE = env.VITE_NATIVE_API_BASE || '';
