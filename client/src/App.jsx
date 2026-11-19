import { Navigate, Route, Routes } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Feed from './pages/Feed';
import Employees from './pages/Employees';
import Users from './pages/Users';
import UserWizard from './pages/UserWizard';
import Customers from './pages/Customers';
import CustomerView from './pages/CustomerView';
import Leads from './pages/Leads';
import Pipeline from './pages/Pipeline';
import CrmDashboard from './pages/CrmDashboard';
import Suppliers from './pages/Suppliers';
import Inventory from './pages/Inventory';
import InventoryView from './pages/InventoryView';
import InventoryEdit from './pages/InventoryEdit';
import ServiceItems from './pages/ServiceItems';
import Estimates from './pages/Estimates';
import EstimateView from './pages/EstimateView';
import EstimateWizard from './pages/EstimateWizard';
import EstimatePrint from './pages/EstimatePrint';
import SalesOrders from './pages/SalesOrders';
import SalesOrderImport from './pages/SalesOrderImport';
import SalesOrderView from './pages/SalesOrderView';
import SalesOrderPrint from './pages/SalesOrderPrint';
import JobOrders from './pages/JobOrders';
import JobOrderView from './pages/JobOrderView';
import JobOrderEdit from './pages/JobOrderEdit';
import PmsJobTypes from './pages/PmsJobTypes';
import JobTypes from './pages/JobTypes';
import JobTypeEdit from './pages/JobTypeEdit';
import AssignedJobOrders from './pages/AssignedJobOrders';
import ArtistIncentiveReport from './pages/reports/ArtistIncentiveReport';
import AssignedJobOrderRun from './pages/AssignedJobOrderRun';
import Production from './pages/Production';
import ProductionJobOrderView from './pages/ProductionJobOrderView';
import RwipJobOrders from './pages/RwipJobOrders';
import RfqcJobOrders from './pages/RfqcJobOrders';
import StockLedgerReport from './pages/StockLedgerReport';
import BinCardReport from './pages/BinCardReport';
import InventoryAdjustments from './pages/InventoryAdjustments';
import InventoryAdjustmentEdit from './pages/InventoryAdjustmentEdit';
import InventoryAdjustmentView from './pages/InventoryAdjustmentView';
import TransferOrders from './pages/TransferOrders';
import TransferOrderEdit from './pages/TransferOrderEdit';
import TransferOrderView from './pages/TransferOrderView';
import OfficeSupplyRequisitions from './pages/OfficeSupplyRequisitions';
import OfficeSupplyRequisitionForm from './pages/OfficeSupplyRequisitionForm';
import OfficeSupplyRequisitionView from './pages/OfficeSupplyRequisitionView';
import OsrFulfillmentView from './pages/OsrFulfillmentView';
import ReallocateItems from './pages/ReallocateItems';
import ItemFulfillments from './pages/ItemFulfillments';
import ItemFulfillmentView from './pages/ItemFulfillmentView';
import ItemReceipts from './pages/ItemReceipts';
import ItemReceiptView from './pages/ItemReceiptView';
import QualityInspectionView from './pages/QualityInspectionView';
import ItemDelivery from './pages/ItemDelivery';
import ItemDeliveryView from './pages/ItemDeliveryView';
import ItemDeliveries from './pages/ItemDeliveries';
import QualityInspections from './pages/QualityInspections';
import SalesInvoiceView from './pages/SalesInvoiceView';
import DeliveryTicketView from './pages/DeliveryTicketView';
import DeliveryTickets from './pages/DeliveryTickets';
import CustomerPayments from './pages/CustomerPayments';
import CreditMemos from './pages/CreditMemos';
import CustomerPaymentView from './pages/CustomerPaymentView';
import CreditMemoView from './pages/CreditMemoView';
import CustomerRefunds from './pages/CustomerRefunds';
import CustomerRefundEdit from './pages/CustomerRefundEdit';
import CustomerRefundView from './pages/CustomerRefundView';
import Journals from './pages/Journals';
import JournalForm from './pages/JournalForm';
import JournalView from './pages/JournalView';
import Deposits from './pages/Deposits';
import DepositForm from './pages/DepositForm';
import DepositView from './pages/DepositView';
import Cheques from './pages/Cheques';
import ChequeForm from './pages/ChequeForm';
import ChequeView from './pages/ChequeView';
import FundTransfers from './pages/FundTransfers';
import FundTransferForm from './pages/FundTransferForm';
import FundTransferView from './pages/FundTransferView';
import ManageAccountingPeriod from './pages/ManageAccountingPeriod';
import CommissionPayables from './pages/CommissionPayables';
import CommissionPayableEdit from './pages/CommissionPayableEdit';
import CommissionPayableView from './pages/CommissionPayableView';
import CommissionVouchers from './pages/CommissionVouchers';
import CommissionVoucherEdit from './pages/CommissionVoucherEdit';
import CommissionVoucherView from './pages/CommissionVoucherView';
import SalesInvoices from './pages/SalesInvoices';
import PurchaseRequisitions from './pages/PurchaseRequisitions';
import PurchaseRequisitionEdit from './pages/PurchaseRequisitionEdit';
import PurchaseRequisitionView from './pages/PurchaseRequisitionView';
import PlaceOrderForm from './pages/PlaceOrderForm';
import PurchaseOrders from './pages/PurchaseOrders';
import PurchaseOrderView from './pages/PurchaseOrderView';
import PurchaseOrderCreate from './pages/PurchaseOrderCreate';
import PurchaseOrderEdit from './pages/PurchaseOrderEdit';
import LandedCostEdit from './pages/LandedCostEdit';
import ReceivingReportEdit from './pages/ReceivingReportEdit';
import ReceivingReportView from './pages/ReceivingReportView';
import PurchaseReturnEdit from './pages/PurchaseReturnEdit';
import PurchaseReturnView from './pages/PurchaseReturnView';
import VendorBills from './pages/VendorBills';
import VendorBillCreate from './pages/VendorBillCreate';
import VendorBillPrint from './pages/VendorBillPrint';
import VendorBillView from './pages/VendorBillView';
import BillPayments from './pages/BillPayments';
import BillPaymentPrint from './pages/BillPaymentPrint';
import BillPaymentCheque from './pages/BillPaymentCheque';
import BillPaymentView from './pages/BillPaymentView';
import BillCredits from './pages/BillCredits';
import BillCreditView from './pages/BillCreditView';
import ChartOfAccountTypes from './pages/ChartOfAccountTypes';
import ChartOfAccounts from './pages/ChartOfAccounts';
import ChartOfAccountEdit from './pages/ChartOfAccountEdit';
import ChartOfAccountView from './pages/ChartOfAccountView';
import TrialBalance from './pages/reports/TrialBalance';
import FinancialReport from './pages/reports/FinancialReport';
import IncomeStatement from './pages/reports/IncomeStatement';
import BalanceSheet from './pages/reports/BalanceSheet';
import GeneralLedger from './pages/reports/GeneralLedger';
import ArAging from './pages/reports/ArAging';
import CommissionSchemes from './pages/CommissionSchemes';
import CommissionSchemeView from './pages/CommissionSchemeView';
import EmployeeQuotas from './pages/EmployeeQuotas';
import EmployeeQuotaView from './pages/EmployeeQuotaView';
import MyAttendance from './pages/MyAttendance';
import Attendance from './pages/Attendance';
import ShiftAssignments from './pages/ShiftAssignments';
import Shifts from './pages/Shifts';
import Schedule from './pages/Schedule';
import DtrPrint from './pages/DtrPrint';
import PayslipPrint from './pages/PayslipPrint';
import PayrollRegisterPrint from './pages/PayrollRegisterPrint';
import QrBadgesPrint from './pages/QrBadgesPrint';
import Kiosk from './pages/Kiosk';
import KioskDevices from './pages/KioskDevices';
import AttendanceImport from './pages/AttendanceImport';
import Payroll from './pages/Payroll';
import PayrollRunView from './pages/PayrollRunView';
import PayrollPayItems from './pages/PayrollPayItems';
import PayrollLoans from './pages/PayrollLoans';
import PayrollHolidays from './pages/PayrollHolidays';
import PayrollSettings from './pages/PayrollSettings';
import CommissionReport from './pages/reports/CommissionReport';
import CommissionJoDetail from './pages/reports/CommissionJoDetail';
import TicketSummary from './pages/reports/TicketSummary';
import Lookups from './pages/Lookups';
import TransactionSettings from './pages/TransactionSettings';
import ProcessCosting from './pages/ProcessCosting';
import MaterialCosting from './pages/MaterialCosting';
import ScheduledJobOrders from './pages/ScheduledJobOrders';
import ScheduledJobOrderTasks from './pages/ScheduledJobOrderTasks';
import ScheduledJobOrderRun from './pages/ScheduledJobOrderRun';
import AssemblyBuilds from './pages/AssemblyBuilds';
import AssemblyBuildView from './pages/AssemblyBuildView';
import Tickets from './pages/Tickets';
import TicketView from './pages/TicketView';
import ProcessFlow from './pages/ProcessFlow';
import NonStandardJobOrders from './pages/NonStandardJobOrders';
import NonStandardJobOrderView from './pages/NonStandardJobOrderView';
import NonStandardSalesOrders from './pages/NonStandardSalesOrders';
import WarrantyCertificates from './pages/WarrantyCertificates';
import WarrantyCertificateForm from './pages/WarrantyCertificateForm';
import WarrantyCertificateView from './pages/WarrantyCertificateView';
import WarrantyCertificatePrint from './pages/WarrantyCertificatePrint';
import NonStandardSalesOrderWizard from './pages/NonStandardSalesOrderWizard';
import NonStandardSalesOrderView from './pages/NonStandardSalesOrderView';
// Pages the GSUITE sync (2026-11-18) brought in because the existing modules link to them.
import SalesInvoicePrint from './pages/SalesInvoicePrint';
import DeliveryTicketPrint from './pages/DeliveryTicketPrint';
import PurchaseOrderPrint from './pages/PurchaseOrderPrint';
import FundTransferPrint from './pages/FundTransferPrint';
import CommissionVoucherPrint from './pages/CommissionVoucherPrint';
import TransferOrderPrint from './pages/TransferOrderPrint';
import SupplierView from './pages/SupplierView';
import CustomerForm from './pages/CustomerForm';
import ServiceItemEdit from './pages/ServiceItemEdit';
import NonInventories from './pages/NonInventories';
import NonInventoryEdit from './pages/NonInventoryEdit';
import CreditMemoForm from './pages/CreditMemoForm';
import VendorBillEdit from './pages/VendorBillEdit';
import ProcessCostingEdit from './pages/ProcessCostingEdit';
import ProcessCostingView from './pages/ProcessCostingView';
import MaterialCostEdit from './pages/MaterialCostEdit';
import ReceivingReports from './pages/ReceivingReports';
import PosSalesImport from './pages/PosSalesImport';
// Accounting reports, BIR Reports and Treasury from GSUITE (2026-11-18).
import BankReconciliations from './pages/accounting/BankReconciliations';
import BankReconciliationView from './pages/accounting/BankReconciliationView';
import Budgets from './pages/accounting/Budgets';
import BudgetEdit from './pages/accounting/BudgetEdit';
import BudgetVsActual from './pages/reports/BudgetVsActual';
import Profitability from './pages/reports/Profitability';
import ArAgingDetails from './pages/reports/ArAgingDetails';
import ApAgingDetails from './pages/reports/ApAgingDetails';
import ApAging from './pages/reports/ApAging';
import StatementOfAccount from './pages/StatementOfAccount';
import DeliverySummary from './pages/reports/DeliverySummary';
import CommissionSalesOrders from './pages/reports/CommissionSalesOrders';
import CommissionInvoices from './pages/reports/CommissionInvoices';
import InvoicedJobOrders from './pages/reports/InvoicedJobOrders';
import DisbursementReport from './pages/reports/DisbursementReport';
import ParkedBankItems from './pages/reports/ParkedBankItems';
import BirSalesReport from './pages/reports/BirSalesReport';
import BirPurchaseReport from './pages/reports/BirPurchaseReport';
import BirEwtReport from './pages/reports/BirEwtReport';
import BirCwtReport from './pages/reports/BirCwtReport';
import BirSupplier2307 from './pages/reports/BirSupplier2307';
import Bir2307Print from './pages/reports/Bir2307Print';
import BirVatReport from './pages/reports/BirVatReport';
import BirItrReport from './pages/reports/BirItrReport';
import BirTaxReturn from './pages/reports/BirTaxReturn';
import CollectionForecast from './pages/treasury/CollectionForecast';
import CollectionAgingReport from './pages/treasury/CollectionAgingReport';
import CollectionIncentive from './pages/treasury/CollectionIncentive';

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* The branch time clock: deliberately NOT behind ProtectedRoute -- no login. The secret
          device link in the URL and each employee's PIN are checked by the API instead. */}
      <Route path="/clock/:token" element={<Kiosk />} />
      {/* Standalone printable certificate -- protected but rendered without the app chrome. */}
      <Route path="/warranty-certificates/:id/print" element={<ProtectedRoute><WarrantyCertificatePrint /></ProtectedRoute>} />
      {/* Daily Time Records, one sheet per employee per page -- also without the app chrome. */}
      <Route path="/attendance/dtr/print" element={<ProtectedRoute><DtrPrint /></ProtectedRoute>} />
      <Route path="/payroll/:id/payslips/print" element={<ProtectedRoute><PayslipPrint /></ProtectedRoute>} />
      <Route path="/payroll/:id/print" element={<ProtectedRoute><PayrollRegisterPrint /></ProtectedRoute>} />
      <Route path="/kiosk-devices/badges/print" element={<ProtectedRoute><QrBadgesPrint /></ProtectedRoute>} />
      {/* The BIR 2307 certificate, printed without the app chrome. */}
      <Route path="/reports/bir-2307/form" element={<ProtectedRoute><Bir2307Print /></ProtectedRoute>} />
      <Route path="/sales-invoices/:id/print" element={<ProtectedRoute><SalesInvoicePrint /></ProtectedRoute>} />
      <Route path="/delivery-tickets/:id/print" element={<ProtectedRoute><DeliveryTicketPrint /></ProtectedRoute>} />
      <Route path="/purchase-orders/:id/print" element={<ProtectedRoute><PurchaseOrderPrint /></ProtectedRoute>} />
      <Route path="/fund-transfers/:id/print" element={<ProtectedRoute><FundTransferPrint /></ProtectedRoute>} />
      <Route path="/commission-vouchers/:id/print" element={<ProtectedRoute><CommissionVoucherPrint /></ProtectedRoute>} />
      <Route path="/transfer-orders/:id/print" element={<ProtectedRoute><TransferOrderPrint /></ProtectedRoute>} />
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        {/* The Dashboard is now the company newsfeed. The role-based analytics dashboard it
            replaced still lives at /dashboard/analytics -- linked from the feed's left rail --
            because the two answer different questions and both are worth keeping. */}
        <Route path="/dashboard" element={<Feed />} />
        <Route path="/dashboard/analytics" element={<Dashboard />} />
        <Route path="/tickets" element={<Tickets />} />
        <Route path="/tickets/:id" element={<TicketView />} />
        <Route path="/process-flow" element={<ProcessFlow />} />
        <Route path="/employees" element={<Employees />} />
        <Route path="/users" element={<Users />} />
        <Route path="/users/new" element={<UserWizard />} />
        <Route path="/users/:id/edit" element={<UserWizard />} />
        <Route path="/customers" element={<Customers />} />
        <Route path="/customers/:id" element={<CustomerView />} />
        <Route path="/crm-dashboard" element={<CrmDashboard />} />
        <Route path="/leads" element={<Leads />} />
        <Route path="/pipeline" element={<Pipeline />} />
        <Route path="/suppliers" element={<Suppliers />} />
        <Route path="/suppliers/:id" element={<SupplierView />} />
        <Route path="/customers/new" element={<CustomerForm />} />
        <Route path="/customers/:id/edit" element={<CustomerForm />} />
        <Route path="/service-items/new" element={<ServiceItemEdit />} />
        <Route path="/service-items/:id/edit" element={<ServiceItemEdit />} />
        <Route path="/non-inventories" element={<NonInventories />} />
        <Route path="/non-inventories/new" element={<NonInventoryEdit />} />
        <Route path="/non-inventories/:id/edit" element={<NonInventoryEdit />} />
        <Route path="/receiving-reports" element={<ReceivingReports />} />
        <Route path="/receiving-reports/:receiptId" element={<ReceivingReportView />} />
        <Route path="/receiving-reports/:receiptId/edit" element={<ReceivingReportEdit />} />
        <Route path="/credit-memos/new" element={<CreditMemoForm />} />
        <Route path="/credit-memos/:id/edit" element={<CreditMemoForm />} />
        <Route path="/vendor-bills/:id/edit" element={<VendorBillEdit />} />
        <Route path="/journals/:id/edit" element={<JournalForm />} />
        <Route path="/deposits/:id/edit" element={<DepositForm />} />
        <Route path="/cheques/:id/edit" element={<ChequeForm />} />
        <Route path="/fund-transfers/:id/edit" element={<FundTransferForm />} />
        <Route path="/commission-payables/:id/edit" element={<CommissionPayableEdit />} />
        <Route path="/process-costing/new" element={<ProcessCostingEdit />} />
        <Route path="/process-costing/:id" element={<ProcessCostingView />} />
        <Route path="/process-costing/:id/edit" element={<ProcessCostingEdit />} />
        <Route path="/material-costing/:id" element={<MaterialCostEdit />} />
        <Route path="/inventory" element={<Inventory />} />
        <Route path="/inventory/new" element={<InventoryEdit />} />
        <Route path="/inventory/:id/edit" element={<InventoryEdit />} />
        <Route path="/inventory/:id" element={<InventoryView />} />
        <Route path="/service-items" element={<ServiceItems />} />
        <Route path="/estimates" element={<Estimates />} />
        <Route path="/estimates/new" element={<EstimateWizard />} />
        <Route path="/estimates/:id/edit" element={<EstimateWizard />} />
        <Route path="/estimates/:id" element={<EstimateView />} />
        <Route path="/estimates/:id/print" element={<EstimatePrint />} />
        <Route path="/sales-orders" element={<SalesOrders />} />
        <Route path="/sales-orders/import" element={<SalesOrderImport />} />
        <Route path="/sales-orders/:id" element={<SalesOrderView />} />
        <Route path="/sales-orders/:id/print" element={<SalesOrderPrint />} />
        <Route path="/non-standard-job-orders" element={<NonStandardJobOrders />} />
        <Route path="/non-standard-job-orders/:id" element={<NonStandardJobOrderView />} />
        <Route path="/non-standard-sales-orders" element={<NonStandardSalesOrders />} />
        <Route path="/non-standard-sales-orders/new" element={<NonStandardSalesOrderWizard />} />
        <Route path="/non-standard-sales-orders/:id/edit" element={<NonStandardSalesOrderWizard />} />
        <Route path="/non-standard-sales-orders/:id" element={<NonStandardSalesOrderView />} />
        <Route path="/warranty-certificates" element={<WarrantyCertificates />} />
        <Route path="/warranty-certificates/new" element={<WarrantyCertificateForm />} />
        <Route path="/warranty-certificates/:id/edit" element={<WarrantyCertificateForm />} />
        <Route path="/warranty-certificates/:id" element={<WarrantyCertificateView />} />
        <Route path="/job-orders" element={<JobOrders />} />
        <Route path="/job-orders/:id" element={<JobOrderView />} />
        <Route path="/job-orders/:id/edit" element={<JobOrderEdit />} />
        <Route path="/pms-job-types" element={<PmsJobTypes />} />
        <Route path="/job-types" element={<JobTypes />} />
        <Route path="/job-types/new" element={<JobTypeEdit />} />
        <Route path="/job-types/:id/edit" element={<JobTypeEdit />} />
        <Route path="/assigned-jo" element={<AssignedJobOrders />} />
        <Route path="/reports/artist-incentive" element={<ArtistIncentiveReport />} />
        {/* Same run screen for both; the route supplies which timer endpoints to use.
            Declared before the :id route so "nstdjo" isn't matched as an id. */}
        <Route path="/assigned-jo/nstdjo/:id" element={<AssignedJobOrderRun kind="NSTDJO" />} />
        <Route path="/assigned-jo/:id" element={<AssignedJobOrderRun />} />
        <Route path="/production" element={<Production />} />
        <Route path="/production/:id" element={<ProductionJobOrderView />} />
        <Route path="/rwip-job-orders" element={<RwipJobOrders />} />
        <Route path="/rfqc-job-orders" element={<RfqcJobOrders />} />
        <Route path="/scheduled-jo" element={<ScheduledJobOrders />} />
        <Route path="/scheduled-jo/process/:id" element={<ScheduledJobOrderRun />} />
        <Route path="/scheduled-jo/:id" element={<ScheduledJobOrderTasks />} />
        <Route path="/assembly-builds" element={<AssemblyBuilds />} />
        <Route path="/assembly-builds/:id" element={<AssemblyBuildView />} />
        <Route path="/stock-ledger-reports" element={<StockLedgerReport />} />
        <Route path="/bin-card-reports" element={<BinCardReport />} />
        <Route path="/inventory-adjustments" element={<InventoryAdjustments />} />
        <Route path="/inventory-adjustments/new" element={<InventoryAdjustmentEdit />} />
        <Route path="/inventory-adjustments/:id/edit" element={<InventoryAdjustmentEdit />} />
        <Route path="/inventory-adjustments/:id" element={<InventoryAdjustmentView />} />
        <Route path="/transfer-orders" element={<TransferOrders />} />
        <Route path="/transfer-orders/new" element={<TransferOrderEdit />} />
        <Route path="/transfer-orders/:id/edit" element={<TransferOrderEdit />} />
        <Route path="/transfer-orders/:id" element={<TransferOrderView />} />
        <Route path="/transfer-orders/:id/lines/:lineId/reallocate" element={<ReallocateItems />} />
        <Route path="/transfer-orders/item-fulfillments/:fulfillmentId" element={<ItemFulfillmentView />} />
        <Route path="/transfer-orders/item-receipts/:receiptId" element={<ItemReceiptView />} />
        <Route path="/office-supply-requisitions" element={<OfficeSupplyRequisitions />} />
        <Route path="/office-supply-requisitions/new" element={<OfficeSupplyRequisitionForm />} />
        <Route path="/office-supply-requisitions/fulfillments/:id" element={<OsrFulfillmentView />} />
        <Route path="/office-supply-requisitions/:id/edit" element={<OfficeSupplyRequisitionForm />} />
        <Route path="/office-supply-requisitions/:id" element={<OfficeSupplyRequisitionView />} />
        <Route path="/item-fulfillments" element={<ItemFulfillments />} />
        <Route path="/item-receipts" element={<ItemReceipts />} />
        <Route path="/quality-inspections" element={<QualityInspections />} />
        <Route path="/quality-inspections/:id" element={<QualityInspectionView />} />
        <Route path="/sales-orders/:id/item-delivery/new" element={<ItemDelivery />} />
        <Route path="/item-deliveries" element={<ItemDeliveries />} />
        <Route path="/item-deliveries/:id" element={<ItemDeliveryView />} />
        <Route path="/sales-invoices" element={<SalesInvoices />} />
        <Route path="/sales-invoices/import-pos" element={<PosSalesImport />} />
        <Route path="/sales-invoices/:id" element={<SalesInvoiceView />} />
        <Route path="/delivery-tickets" element={<DeliveryTickets />} />
        <Route path="/delivery-tickets/:id" element={<DeliveryTicketView />} />
        <Route path="/customer-payments" element={<CustomerPayments />} />
        <Route path="/customer-payments/:id" element={<CustomerPaymentView />} />
        <Route path="/credit-memos" element={<CreditMemos />} />
        <Route path="/credit-memos/:id" element={<CreditMemoView />} />
        <Route path="/customer-refunds" element={<CustomerRefunds />} />
        <Route path="/customer-refunds/new" element={<CustomerRefundEdit />} />
        <Route path="/customer-refunds/:id" element={<CustomerRefundView />} />
        <Route path="/journals" element={<Journals />} />
        <Route path="/journals/new" element={<JournalForm />} />
        <Route path="/journals/:id" element={<JournalView />} />
        <Route path="/deposits" element={<Deposits />} />
        <Route path="/deposits/new" element={<DepositForm />} />
        <Route path="/deposits/:id" element={<DepositView />} />
        <Route path="/cheques" element={<Cheques />} />
        <Route path="/cheques/new" element={<ChequeForm />} />
        <Route path="/cheques/:id" element={<ChequeView />} />
        <Route path="/fund-transfers" element={<FundTransfers />} />
        <Route path="/fund-transfers/new" element={<FundTransferForm />} />
        <Route path="/fund-transfers/:id" element={<FundTransferView />} />
        <Route path="/manage-accounting-period" element={<ManageAccountingPeriod />} />
        <Route path="/accounting/bank-reconciliation" element={<BankReconciliations />} />
        <Route path="/accounting/bank-reconciliation/:id" element={<BankReconciliationView />} />
        <Route path="/budgets" element={<Budgets />} />
        <Route path="/budgets/:id" element={<BudgetEdit />} />
        <Route path="/reports/budget-vs-actual" element={<BudgetVsActual />} />
        <Route path="/reports/profitability" element={<Profitability />} />
        <Route path="/reports/ar-aging-details" element={<ArAgingDetails />} />
        <Route path="/reports/ap-aging" element={<ApAging />} />
        <Route path="/reports/ap-aging-details" element={<ApAgingDetails />} />
        <Route path="/statement-of-accounts" element={<StatementOfAccount />} />
        <Route path="/reports/delivery-summary" element={<DeliverySummary />} />
        <Route path="/reports/commission-sales-orders" element={<CommissionSalesOrders />} />
        <Route path="/reports/commission-invoices" element={<CommissionInvoices />} />
        <Route path="/reports/invoiced-job-orders" element={<InvoicedJobOrders />} />
        <Route path="/reports/disbursement" element={<DisbursementReport />} />
        <Route path="/reports/parked-bank-items" element={<ParkedBankItems />} />
        <Route path="/reports/bir-sales" element={<BirSalesReport />} />
        <Route path="/reports/bir-purchase" element={<BirPurchaseReport />} />
        <Route path="/reports/bir-ewt" element={<BirEwtReport />} />
        <Route path="/reports/bir-cwt" element={<BirCwtReport />} />
        <Route path="/reports/bir-2307" element={<BirSupplier2307 />} />
        <Route path="/reports/bir-vat" element={<BirVatReport />} />
        <Route path="/reports/bir-itr" element={<BirItrReport />} />
        <Route path="/reports/bir-tax-return" element={<BirTaxReturn />} />
        <Route path="/treasury/collection-forecast" element={<CollectionForecast />} />
        <Route path="/treasury/collection-aging" element={<CollectionAgingReport />} />
        <Route path="/treasury/collection-incentive" element={<CollectionIncentive />} />
        <Route path="/commission-payables" element={<CommissionPayables />} />
        <Route path="/commission-payables/new" element={<CommissionPayableEdit />} />
        <Route path="/commission-payables/:id" element={<CommissionPayableView />} />
        <Route path="/commission-vouchers" element={<CommissionVouchers />} />
        <Route path="/commission-vouchers/new" element={<CommissionVoucherEdit />} />
        <Route path="/commission-vouchers/:id/edit" element={<CommissionVoucherEdit />} />
        <Route path="/commission-vouchers/:id" element={<CommissionVoucherView />} />
        <Route path="/purchase-requisitions" element={<PurchaseRequisitions />} />
        <Route path="/purchase-requisitions/new" element={<PurchaseRequisitionEdit />} />
        <Route path="/purchase-requisitions/:id/edit" element={<PurchaseRequisitionEdit />} />
        <Route path="/purchase-requisitions/:id" element={<PurchaseRequisitionView />} />
        <Route path="/place-order-form" element={<PlaceOrderForm />} />
        <Route path="/purchase-orders" element={<PurchaseOrders />} />
        <Route path="/purchase-orders/new" element={<PurchaseOrderCreate />} />
        <Route path="/purchase-orders/:id/edit" element={<PurchaseOrderEdit />} />
        <Route path="/purchase-orders/:id/landed-cost/new" element={<LandedCostEdit />} />
        <Route path="/purchase-orders/:id/receive" element={<ReceivingReportEdit />} />
        <Route path="/purchase-orders/receipts/:receiptId" element={<ReceivingReportView />} />
        <Route path="/purchase-orders/:id/return" element={<PurchaseReturnEdit />} />
        <Route path="/purchase-orders/returns/:returnId" element={<PurchaseReturnView />} />
        <Route path="/purchase-orders/:id" element={<PurchaseOrderView />} />
        <Route path="/vendor-bills" element={<VendorBills />} />
        <Route path="/vendor-bills/new" element={<VendorBillCreate />} />
        <Route path="/vendor-bills/:id/print" element={<VendorBillPrint />} />
        <Route path="/vendor-bills/:id" element={<VendorBillView />} />
        <Route path="/bill-payments" element={<BillPayments />} />
        <Route path="/bill-payments/:id/print" element={<BillPaymentPrint />} />
        <Route path="/bill-payments/:id/cheque" element={<BillPaymentCheque />} />
        <Route path="/bill-payments/:id" element={<BillPaymentView />} />
        <Route path="/bill-credits" element={<BillCredits />} />
        <Route path="/bill-credits/:id" element={<BillCreditView />} />
        <Route path="/chart-of-account-types" element={<ChartOfAccountTypes />} />
        <Route path="/chart-of-accounts" element={<ChartOfAccounts />} />
        <Route path="/chart-of-accounts/new" element={<ChartOfAccountEdit />} />
        <Route path="/chart-of-accounts/:id/edit" element={<ChartOfAccountEdit />} />
        <Route path="/chart-of-accounts/:id" element={<ChartOfAccountView />} />
        <Route path="/reports/trial-balance" element={<TrialBalance />} />
        <Route path="/accounting-reports/:slug" element={<FinancialReport />} />
        <Route path="/reports/income-statement" element={<IncomeStatement />} />
        <Route path="/reports/balance-sheet" element={<BalanceSheet />} />
        <Route path="/reports/general-ledger" element={<GeneralLedger />} />
        <Route path="/reports/ar-aging" element={<ArAging />} />
        <Route path="/commission-schemes" element={<CommissionSchemes />} />
        <Route path="/commission-schemes/:id" element={<CommissionSchemeView />} />
        <Route path="/my-attendance" element={<MyAttendance />} />
        <Route path="/attendance" element={<Attendance />} />
        <Route path="/attendance/import" element={<AttendanceImport />} />
        <Route path="/shift-assignments" element={<ShiftAssignments />} />
        <Route path="/shifts" element={<Shifts />} />
        <Route path="/schedule" element={<Schedule />} />
        <Route path="/kiosk-devices" element={<KioskDevices />} />
        <Route path="/payroll" element={<Payroll />} />
        <Route path="/payroll/:id" element={<PayrollRunView />} />
        <Route path="/payroll-pay-items" element={<PayrollPayItems />} />
        <Route path="/payroll-loans" element={<PayrollLoans />} />
        <Route path="/payroll-holidays" element={<PayrollHolidays />} />
        <Route path="/payroll-settings" element={<PayrollSettings />} />
        <Route path="/employee-quotas" element={<EmployeeQuotas />} />
        <Route path="/employee-quotas/:id" element={<EmployeeQuotaView />} />
        <Route path="/commission-report" element={<CommissionReport />} />
        <Route path="/commission-jo-detail" element={<CommissionJoDetail />} />
        <Route path="/reports/ticket-summary" element={<TicketSummary />} />
        <Route path="/lookups" element={<Lookups />} />
        <Route path="/transaction-settings" element={<TransactionSettings />} />
        <Route path="/process-costing" element={<ProcessCosting />} />
        <Route path="/material-costing" element={<MaterialCosting />} />
      </Route>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default App;
