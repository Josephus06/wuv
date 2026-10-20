require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const lookupRoutes = require('./routes/lookups');
const employeeRoutes = require('./routes/employees');
const userRoutes = require('./routes/users');
const accountTypePermissionRoutes = require('./routes/accountTypePermissions');
const customerRoutes = require('./routes/customers');
const supplierRoutes = require('./routes/suppliers');
const inventoryRoutes = require('./routes/inventories');
const estimateRoutes = require('./routes/estimates');
const blanketPoRoutes = require('./routes/blanketPos');
const processCostingRoutes = require('./routes/processCosting');
const salesOrderRoutes = require('./routes/salesOrders');
const jobOrderRoutes = require('./routes/jobOrders');
const pmsJobTypeRoutes = require('./routes/pmsJobTypes');
const jobTypeRoutes = require('./routes/jobTypes');
const assignedJobOrderRoutes = require('./routes/assignedJobOrders');
const productionRoutes = require('./routes/production');
const stockLedgerRoutes = require('./routes/stockLedger');
const binCardRoutes = require('./routes/binCard');
const inventoryAdjustmentRoutes = require('./routes/inventoryAdjustments');
const chartOfAccountTypeRoutes = require('./routes/chartOfAccountTypes');
const chartOfAccountRoutes = require('./routes/chartOfAccounts');
const scheduledJobOrderRoutes = require('./routes/scheduledJobOrders');
const assemblyBuildRoutes = require('./routes/assemblyBuilds');
const dashboardRoutes = require('./routes/dashboard');
const newsfeedRoutes = require('./routes/newsfeed');
const transferOrderRoutes = require('./routes/transferOrders');
const officeSupplyRequisitionRoutes = require('./routes/officeSupplyRequisitions');
const qualityInspectionRoutes = require('./routes/qualityInspections');
const itemDeliveryRoutes = require('./routes/itemDeliveries');
const salesInvoiceRoutes = require('./routes/salesInvoices');
const deliveryTicketRoutes = require('./routes/deliveryTickets');
const customerPaymentRoutes = require('./routes/customerPayments');
const creditMemoRoutes = require('./routes/creditMemos');
const customerRefundRoutes = require('./routes/customerRefunds');
const journalRoutes = require('./routes/journals');
const depositRoutes = require('./routes/deposits');
const chequeRoutes = require('./routes/cheques');
const fundTransferRoutes = require('./routes/fundTransfers');
const accountingPeriodRoutes = require('./routes/accountingPeriods');
const transactionSettingsRoutes = require('./routes/transactionSettings');
const commissionPayableRoutes = require('./routes/commissionPayables');
const commissionVoucherRoutes = require('./routes/commissionVouchers');
const commissionSchemeRoutes = require('./routes/commissionSchemes');
const employeeQuotaRoutes = require('./routes/employeeQuotas');
const purchaseRequisitionRoutes = require('./routes/purchaseRequisitions');
const purchaseOrderRoutes = require('./routes/purchaseOrders');
const vendorBillRoutes = require('./routes/vendorBills');
const billPaymentRoutes = require('./routes/billPayments');
const billCreditRoutes = require('./routes/billCredits');
const reportsRoutes = require('./routes/reports');
const leadRoutes = require('./routes/leads');
const crmPipelineRoutes = require('./routes/crmPipeline');
const crmActivityRoutes = require('./routes/crmActivities');
const chatbotRoutes = require('./routes/chatbot');
const ticketRoutes = require('./routes/tickets');
const ticketReportRoutes = require('./routes/ticketReport');
const artistIncentiveReportRoutes = require('./routes/artistIncentiveReport');
const notificationRoutes = require('./routes/notifications');
const nonStandardJobOrderRoutes = require('./routes/nonStandardJobOrders');
const nonStandardSalesOrderRoutes = require('./routes/nonStandardSalesOrders');
const warrantyCertificateRoutes = require('./routes/warrantyCertificates');
const rwipJobOrderRoutes = require('./routes/rwipJobOrders');
const rfqcJobOrderRoutes = require('./routes/rfqcJobOrders');
const shiftRoutes = require('./routes/shifts');
const shiftAssignmentRoutes = require('./routes/shiftAssignments');
const attendanceRoutes = require('./routes/attendance');
const { ensureAssignedAtColumn } = require('./db/ensureSchema');
const { ensureDatabaseReady } = require('./db/autoBootstrap');
const { sendTicketReminders } = require('./scripts/ticket_reminder');

const app = express();

app.use(cors());
// 2mb covered the base64 profile-picture payload. A newsfeed post carries up to four photos,
// each resized client-side to 1600px JPEG (~400KB, ~550KB once base64'd), so the ceiling has to
// clear roughly 2.2MB of images plus the post text -- 12mb leaves room without inviting an
// unbounded upload (the feed route caps each decoded image at 4MB on its own).
app.use(express.json({ limit: '12mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/lookups', lookupRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/users', userRoutes);
app.use('/api/account-type-permissions', accountTypePermissionRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/estimates', estimateRoutes);
app.use('/api/blanket-pos', blanketPoRoutes);
app.use('/api/processes', processCostingRoutes);
app.use('/api/sales-orders', salesOrderRoutes);
app.use('/api/job-orders', jobOrderRoutes);
app.use('/api/pms-job-types', pmsJobTypeRoutes);
app.use('/api/job-types', jobTypeRoutes);
app.use('/api/assigned-jo', assignedJobOrderRoutes);
app.use('/api/production', productionRoutes);
app.use('/api/stock-ledger-reports', stockLedgerRoutes);
app.use('/api/bin-card-reports', binCardRoutes);
app.use('/api/inventory-adjustments', inventoryAdjustmentRoutes);
app.use('/api/chart-of-account-types', chartOfAccountTypeRoutes);
app.use('/api/chart-of-accounts', chartOfAccountRoutes);
app.use('/api/scheduled-jo', scheduledJobOrderRoutes);
app.use('/api/assembly-builds', assemblyBuildRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/newsfeed', newsfeedRoutes);
app.use('/api/transfer-orders', transferOrderRoutes);
app.use('/api/office-supply-requisitions', officeSupplyRequisitionRoutes);
app.use('/api/quality-inspections', qualityInspectionRoutes);
app.use('/api/item-deliveries', itemDeliveryRoutes);
app.use('/api/sales-invoices', salesInvoiceRoutes);
app.use('/api/delivery-tickets', deliveryTicketRoutes);
app.use('/api/customer-payments', customerPaymentRoutes);
app.use('/api/credit-memos', creditMemoRoutes);
app.use('/api/customer-refunds', customerRefundRoutes);
app.use('/api/journals', journalRoutes);
app.use('/api/deposits', depositRoutes);
app.use('/api/cheques', chequeRoutes);
app.use('/api/fund-transfers', fundTransferRoutes);
app.use('/api/manage-accounting-period', accountingPeriodRoutes);
app.use('/api/transaction-settings', transactionSettingsRoutes);
app.use('/api/commission-payables', commissionPayableRoutes);
app.use('/api/commission-vouchers', commissionVoucherRoutes);
app.use('/api/commission-schemes', commissionSchemeRoutes);
app.use('/api/employee-quotas', employeeQuotaRoutes);
app.use('/api/purchase-requisitions', purchaseRequisitionRoutes);
app.use('/api/purchase-orders', purchaseOrderRoutes);
app.use('/api/vendor-bills', vendorBillRoutes);
app.use('/api/bill-payments', billPaymentRoutes);
app.use('/api/bill-credits', billCreditRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/crm-pipeline', crmPipelineRoutes);
app.use('/api/crm-activities', crmActivityRoutes);
app.use('/api/chatbot', chatbotRoutes);
app.use('/api/reports/artist-incentive', artistIncentiveReportRoutes);
app.use('/api/reports/tickets', ticketReportRoutes);
app.use('/api/tickets/report', ticketReportRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/non-standard-job-orders', nonStandardJobOrderRoutes);
app.use('/api/non-standard-sales-orders', nonStandardSalesOrderRoutes);
app.use('/api/warranty-certificates', warrantyCertificateRoutes);
app.use('/api/rwip-job-orders', rwipJobOrderRoutes);
app.use('/api/rfqc-job-orders', rfqcJobOrderRoutes);
app.use('/api/shifts', shiftRoutes);
app.use('/api/shift-assignments', shiftAssignmentRoutes);
app.use('/api/attendance', attendanceRoutes);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

const REMINDER_HOUR = Number(process.env.TICKET_REMINDER_HOUR || 1);
const REMINDER_MINUTE = Number(process.env.TICKET_REMINDER_MINUTE || 0);

function scheduleDailyTicketReminders(hour = 1, minute = 0) {
  const scheduleNextRun = () => {
    const now = new Date();
    const nextRun = new Date(now);
    nextRun.setHours(hour, minute, 0, 0);
    if (nextRun <= now) nextRun.setDate(nextRun.getDate() + 1);

    const delayMs = nextRun - now;
    console.log(`Ticket reminder email job scheduled for ${nextRun.toLocaleString()}`);

    setTimeout(async () => {
      try {
        await sendTicketReminders();
      } catch (err) {
        console.error('Scheduled ticket reminder failed:', err);
      }
      scheduleNextRun();
    }, delayMs);
  };

  scheduleNextRun();
}

// Only schedule when SMTP is configured. Otherwise the reminder job is disabled.
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  scheduleDailyTicketReminders(REMINDER_HOUR, REMINDER_MINUTE);
} else {
  console.warn('Ticket reminder email job disabled because SMTP configuration is missing.');
}

// In production (Railway) the client is built into client/dist and this server
// serves it directly -- single deployable service, same origin as /api so the
// client's relative baseURL('/api') keeps working with no config.
const clientDist = path.join(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Errors may carry an intended HTTP status (e.g. a 409 period-lock from assertPeriodOpen);
  // fall back to 500 for anything unclassified. A 4xx is an expected/validation error, so don't
  // spam the console log with it.
  const status = Number(err.status) || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.sqlMessage || err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 4000;

async function startServer() {
  try {
    // A brand-new hosted database has no tables at all, which would make the very next call
    // throw ER_NO_SUCH_TABLE and crash-loop the service. Set it up first if it is empty.
    await ensureDatabaseReady();
    await ensureAssignedAtColumn();
    app.listen(PORT, () => console.log(`WVI ERP API listening on http://localhost:${PORT}`));
  } catch (error) {
    console.error('Failed to ensure database schema:', error);
    process.exit(1);
  }
}

startServer();
