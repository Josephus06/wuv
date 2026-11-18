// Company branding for what the SERVER prints or sends: emailed Estimate / Purchase Order PDFs,
// estimate emails, CRM email drafts. The server-side twin of client/src/config/company.js, read
// from the runtime environment (server/.env, or the host's variables) rather than at build time:
//
//   COMPANY_NAME="Acme Imaging Corp."     legal name -- "make cheques payable to", PDF author
//   COMPANY_SHORT="ACME"                  set as the logo on the PDFs
//   COMPANY_TAGLINE=""                    under the logo
//   COMPANY_ADDRESS1="" COMPANY_ADDRESS2="" COMPANY_PHONE="" COMPANY_WEBSITE=""
//   COMPANY_BANKS="BPI Savings # ...|BDO Savings # ..."   one bank account per |-separated entry
//   COMPANY_EMAIL_DOMAINS="acme.com"      the company's own email domains (CRM drafts skip them)
//
// Every field defaults to blank or a neutral placeholder, never to another company's details.
const env = process.env;

const COMPANY = {
  name: env.COMPANY_NAME || 'Your Company Inc.',
  short: env.COMPANY_SHORT || 'COMPANY',
  tagline: env.COMPANY_TAGLINE || '',
  addressLine1: env.COMPANY_ADDRESS1 || '',
  addressLine2: env.COMPANY_ADDRESS2 || '',
  phone: env.COMPANY_PHONE || '',
  website: env.COMPANY_WEBSITE || '',
  bankAccounts: (env.COMPANY_BANKS || '').split('|').map((s) => s.trim()).filter(Boolean),
  emailDomains: (env.COMPANY_EMAIL_DOMAINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
};

// The letterhead's contact lines, blanks dropped.
COMPANY.addressLines = [
  COMPANY.addressLine1,
  COMPANY.addressLine2,
  COMPANY.phone ? `Tel. ${COMPANY.phone}` : '',
  COMPANY.website,
].filter(Boolean);

module.exports = { COMPANY };
