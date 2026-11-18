// Database side of the GSUITE sync of the existing modules (2026-11-18).
//
// GENERATED from a schema diff of GSUITE's database against this one -- re-running the generator
// rather than hand-editing is the intended way to change it. Every step is idempotent: tables are
// CREATE IF NOT EXISTS, columns / indexes are added only when absent, and the permission seeds run
// only in the run that adds their column, so a later admin change is never overwritten.
//
//   1. 44 tables the merged code reads (bank deposit lines, CRM, document attachments,
//      opening balances, unit titles ...). Tables of modules not yet ported are created EMPTY so the
//      shared ledger / report code that looks for them finds nothing rather than erroring.
//   2. 216 columns GSUITE added to tables both systems share. A column GSUITE declares
//      NOT NULL with no default is added NULL here, so this system's own insert paths keep working.
//   3. 25 column changes -- widenings and NOT NULL -> NULL relaxations only. wu's own HR,
//      payroll and feed tables are not touched at all.
//   4. 50 indexes.
//   5. Permission columns can_update / can_view_all / can_print / can_void, seeded so nobody loses
//      what they can do today (see seedPermissions below), and user_supervisors backfilled from
//      users.supervisor_id.
//   6. Pages for /receiving-reports, /unit-of-measures and /reports/parked-bank-items.
//
//   node src/db/sync-gsuite-existing-modules.js --dry-run    list what would change
//   node src/db/sync-gsuite-existing-modules.js              apply it
require('dotenv').config();
const pool = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');

const TABLES = [
  [
    "app_settings",
    "CREATE TABLE IF NOT EXISTS `app_settings` (\n  `name` varchar(64) NOT NULL,\n  `value` varchar(255) NOT NULL,\n  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n  PRIMARY KEY (`name`)\n) ENGINE=InnoDB"
  ],
  [
    "asset_assigned_locations",
    "CREATE TABLE IF NOT EXISTS `asset_assigned_locations` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `name` varchar(150) NOT NULL,\n  `description` varchar(500) DEFAULT NULL,\n  `is_active` tinyint(1) NOT NULL DEFAULT '1',\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  `updated_at` datetime DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq_asset_assigned_locations_name` (`name`)\n) ENGINE=InnoDB"
  ],
  [
    "asset_depreciation_lines",
    "CREATE TABLE IF NOT EXISTS `asset_depreciation_lines` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `run_id` bigint NOT NULL,\n  `line_no` int NOT NULL,\n  `asset_id` bigint NOT NULL,\n  `asset_class_id` bigint DEFAULT NULL,\n  `depreciable_base` decimal(18,2) NOT NULL DEFAULT '0.00',\n  `opening_accumulated` decimal(18,2) NOT NULL DEFAULT '0.00',\n  `amount` decimal(18,2) NOT NULL DEFAULT '0.00',\n  `closing_accumulated` decimal(18,2) NOT NULL DEFAULT '0.00',\n  `remaining_life_months` int DEFAULT NULL,\n  `expense_account_id` bigint DEFAULT NULL,\n  `expense_account_code` varchar(20) DEFAULT NULL,\n  `accumulated_account_id` bigint DEFAULT NULL,\n  `accumulated_account_code` varchar(20) DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq_adl_run_asset` (`run_id`,`asset_id`),\n  KEY `idx_adl_run` (`run_id`),\n  KEY `idx_adl_asset` (`asset_id`)\n) ENGINE=InnoDB"
  ],
  [
    "asset_depreciation_runs",
    "CREATE TABLE IF NOT EXISTS `asset_depreciation_runs` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `run_no` varchar(40) NOT NULL,\n  `period_month` date NOT NULL,\n  `status` varchar(30) NOT NULL DEFAULT 'draft',\n  `total_amount` decimal(18,2) NOT NULL DEFAULT '0.00',\n  `asset_count` int NOT NULL DEFAULT '0',\n  `memo` varchar(1000) DEFAULT NULL,\n  `created_by_user_id` bigint DEFAULT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  `posted_by_user_id` bigint DEFAULT NULL,\n  `posted_at` datetime DEFAULT NULL,\n  `voided_by_user_id` bigint DEFAULT NULL,\n  `voided_at` datetime DEFAULT NULL,\n  `void_reason` varchar(500) DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `run_no` (`run_no`),\n  KEY `idx_adr_period` (`period_month`),\n  KEY `idx_adr_status` (`status`)\n) ENGINE=InnoDB"
  ],
  [
    "asset_disposals",
    "CREATE TABLE IF NOT EXISTS `asset_disposals` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `disposal_no` varchar(40) NOT NULL,\n  `asset_id` bigint NOT NULL,\n  `disposal_date` date NOT NULL,\n  `disposal_type` varchar(30) NOT NULL DEFAULT 'sale',\n  `proceeds` decimal(18,2) NOT NULL DEFAULT '0.00',\n  `proceeds_account_id` bigint DEFAULT NULL,\n  `cost_at_disposal` decimal(18,2) NOT NULL DEFAULT '0.00',\n  `accumulated_at_disposal` decimal(18,2) NOT NULL DEFAULT '0.00',\n  `net_book_value` decimal(18,2) NOT NULL DEFAULT '0.00',\n  `gain_loss` decimal(18,2) NOT NULL DEFAULT '0.00',\n  `gain_loss_account_id` bigint DEFAULT NULL,\n  `cost_account_id` bigint DEFAULT NULL,\n  `accumulated_account_id` bigint DEFAULT NULL,\n  `buyer_name` varchar(255) DEFAULT NULL,\n  `reason` varchar(500) DEFAULT NULL,\n  `memo` varchar(1000) DEFAULT NULL,\n  `status` varchar(30) NOT NULL DEFAULT 'draft',\n  `created_by_user_id` bigint DEFAULT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  `posted_by_user_id` bigint DEFAULT NULL,\n  `posted_at` datetime DEFAULT NULL,\n  `voided_by_user_id` bigint DEFAULT NULL,\n  `voided_at` datetime DEFAULT NULL,\n  `void_reason` varchar(500) DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `disposal_no` (`disposal_no`),\n  KEY `idx_adisp_asset` (`asset_id`),\n  KEY `idx_adisp_date` (`disposal_date`),\n  KEY `idx_adisp_status` (`status`)\n) ENGINE=InnoDB"
  ],
  [
    "assets",
    "CREATE TABLE IF NOT EXISTS `assets` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `reference_no` varchar(60) NOT NULL,\n  `asset_item_id` bigint NOT NULL,\n  `asset_class_id` bigint DEFAULT NULL,\n  `owning_department_id` bigint DEFAULT NULL,\n  `is_capitalized` tinyint(1) NOT NULL DEFAULT '0',\n  `parent_asset_id` bigint DEFAULT NULL,\n  `serial_no` varchar(120) DEFAULT NULL,\n  `brand` varchar(120) DEFAULT NULL,\n  `model` varchar(120) DEFAULT NULL,\n  `specification` varchar(500) DEFAULT NULL,\n  `tag_no` varchar(60) DEFAULT NULL,\n  `location_id` bigint DEFAULT NULL,\n  `assigned_location_id` bigint DEFAULT NULL,\n  `custodian_employee_id` bigint DEFAULT NULL,\n  `department_id` bigint DEFAULT NULL,\n  `status` varchar(30) NOT NULL DEFAULT 'active',\n  `asset_condition` varchar(30) NOT NULL DEFAULT 'good',\n  `acquired_date` date DEFAULT NULL,\n  `acquisition_cost` decimal(16,2) DEFAULT NULL,\n  `salvage_value` decimal(18,2) NOT NULL DEFAULT '0.00',\n  `useful_life_months` int DEFAULT NULL,\n  `in_service_date` date DEFAULT NULL,\n  `depreciation_method` varchar(30) NOT NULL DEFAULT 'straight_line',\n  `remarks` varchar(1000) DEFAULT NULL,\n  `created_by_user_id` bigint DEFAULT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  `updated_at` datetime DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `reference_no` (`reference_no`),\n  KEY `idx_assets_item` (`asset_item_id`),\n  KEY `idx_assets_parent` (`parent_asset_id`),\n  KEY `idx_assets_location` (`location_id`),\n  KEY `idx_assets_custodian` (`custodian_employee_id`),\n  KEY `idx_assets_status` (`status`),\n  KEY `idx_assets_class` (`asset_class_id`),\n  KEY `idx_assets_capitalized` (`is_capitalized`,`in_service_date`),\n  KEY `idx_assets_owning_dept` (`owning_department_id`),\n  KEY `idx_assets_assigned_location` (`assigned_location_id`)\n) ENGINE=InnoDB"
  ],
  [
    "bank_deposit_lines",
    "CREATE TABLE IF NOT EXISTS `bank_deposit_lines` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `deposit_id` bigint NOT NULL,\n  `line_type` varchar(20) NOT NULL,\n  `line_no` int NOT NULL,\n  `party_type` varchar(20) DEFAULT NULL,\n  `party_id` bigint DEFAULT NULL,\n  `party_name` varchar(255) DEFAULT NULL,\n  `amount` decimal(18,2) NOT NULL DEFAULT '0.00',\n  `account_id` bigint NOT NULL,\n  `payment_method_id` bigint DEFAULT NULL,\n  `department_id` bigint DEFAULT NULL,\n  `location_id` bigint DEFAULT NULL,\n  `memo` varchar(1000) DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `idx_bdl_deposit` (`deposit_id`)\n) ENGINE=InnoDB"
  ],
  [
    "bank_reconciliation_matches",
    "CREATE TABLE IF NOT EXISTS `bank_reconciliation_matches` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `reconciliation_id` bigint NOT NULL,\n  `statement_line_id` bigint DEFAULT NULL,\n  `source_kind` varchar(20) NOT NULL,\n  `source_id` bigint NOT NULL,\n  `amount` decimal(15,2) NOT NULL,\n  `confidence` varchar(12) NOT NULL DEFAULT 'manual',\n  `confirmed_at` datetime DEFAULT NULL,\n  `confirmed_by_user_id` bigint DEFAULT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq_bank_match_source` (`source_kind`,`source_id`),\n  KEY `idx_bank_match_recon` (`reconciliation_id`),\n  KEY `idx_bank_match_line` (`statement_line_id`)\n) ENGINE=InnoDB"
  ],
  [
    "bank_reconciliations",
    "CREATE TABLE IF NOT EXISTS `bank_reconciliations` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `recon_no` varchar(30) NOT NULL,\n  `account_id` bigint NOT NULL,\n  `statement_date` date NOT NULL,\n  `opening_balance` decimal(15,2) NOT NULL DEFAULT '0.00',\n  `statement_balance` decimal(15,2) NOT NULL DEFAULT '0.00',\n  `status` varchar(20) NOT NULL DEFAULT 'open',\n  `statement_file_name` varchar(255) DEFAULT NULL,\n  `imported_at` datetime DEFAULT NULL,\n  `reconciled_at` datetime DEFAULT NULL,\n  `reconciled_by_user_id` bigint DEFAULT NULL,\n  `reopened_at` datetime DEFAULT NULL,\n  `reopened_by_user_id` bigint DEFAULT NULL,\n  `created_by_user_id` bigint DEFAULT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  `updated_at` datetime DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq_bank_recon_no` (`recon_no`),\n  KEY `idx_bank_recon_account` (`account_id`,`statement_date`),\n  KEY `idx_bank_recon_status` (`status`)\n) ENGINE=InnoDB"
  ],
  [
    "bank_statement_lines",
    "CREATE TABLE IF NOT EXISTS `bank_statement_lines` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `reconciliation_id` bigint NOT NULL,\n  `line_no` int NOT NULL,\n  `txn_date` date DEFAULT NULL,\n  `description` varchar(500) DEFAULT NULL,\n  `reference` varchar(120) DEFAULT NULL,\n  `amount` decimal(15,2) NOT NULL,\n  `raw_row` text,\n  `status` varchar(20) NOT NULL DEFAULT 'unmatched',\n  `bank_only_account_id` bigint DEFAULT NULL,\n  `posted_journal_id` bigint DEFAULT NULL,\n  `note` varchar(255) DEFAULT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (`id`),\n  KEY `idx_bank_stmt_recon` (`reconciliation_id`,`status`),\n  KEY `idx_bank_statement_lines_journal` (`posted_journal_id`)\n) ENGINE=InnoDB"
  ],
  [
    "budgets",
    "CREATE TABLE IF NOT EXISTS `budgets` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `name` varchar(150) NOT NULL,\n  `fiscal_year` smallint NOT NULL,\n  `dimension` enum('company','department','location') NOT NULL DEFAULT 'company',\n  `department_id` bigint DEFAULT NULL,\n  `location_id` bigint DEFAULT NULL,\n  `scope` enum('pl','pl_capex') NOT NULL DEFAULT 'pl',\n  `status` enum('draft','approved','superseded') NOT NULL DEFAULT 'draft',\n  `version` int NOT NULL DEFAULT '1',\n  `notes` varchar(1000) DEFAULT NULL,\n  `created_by_user_id` bigint DEFAULT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  `updated_at` datetime DEFAULT NULL,\n  `approved_by_user_id` bigint DEFAULT NULL,\n  `approved_at` datetime DEFAULT NULL,\n  `kind` enum('account','department') NOT NULL DEFAULT 'account',\n  `sales_target` decimal(16,2) DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `idx_budgets_year` (`fiscal_year`,`dimension`,`department_id`,`location_id`,`status`)\n) ENGINE=InnoDB"
  ],
  [
    "cheque_bill_credits",
    "CREATE TABLE IF NOT EXISTS `cheque_bill_credits` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `cheque_id` bigint NOT NULL,\n  `bill_credit_id` bigint NOT NULL,\n  `applied_amount` decimal(16,2) NOT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (`id`),\n  KEY `idx_cbc_cheque` (`cheque_id`),\n  KEY `idx_cbc_credit` (`bill_credit_id`)\n) ENGINE=InnoDB"
  ],
  [
    "crm_attention",
    "CREATE TABLE IF NOT EXISTS `crm_attention` (\n  `customer_id` bigint NOT NULL,\n  `owner_employee_id` bigint DEFAULT NULL,\n  `score` decimal(8,2) NOT NULL,\n  `reasons` json NOT NULL,\n  `last_order_date` date DEFAULT NULL,\n  `last_visit_at` datetime DEFAULT NULL,\n  `next_scheduled_at` datetime DEFAULT NULL,\n  `revenue_12m` decimal(16,2) NOT NULL DEFAULT '0.00',\n  `overdue_amount` decimal(16,2) NOT NULL DEFAULT '0.00',\n  `computed_at` datetime NOT NULL,\n  PRIMARY KEY (`customer_id`),\n  KEY `idx_crm_attention_owner_score` (`owner_employee_id`,`score`),\n  KEY `idx_crm_attention_score` (`score`)\n) ENGINE=InnoDB"
  ],
  [
    "crm_attention_snoozes",
    "CREATE TABLE IF NOT EXISTS `crm_attention_snoozes` (\n  `customer_id` bigint NOT NULL,\n  `snoozed_until` date NOT NULL,\n  `snoozed_by_user_id` bigint DEFAULT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (`customer_id`)\n) ENGINE=InnoDB"
  ],
  [
    "crm_email_drafts",
    "CREATE TABLE IF NOT EXISTS `crm_email_drafts` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `customer_id` bigint NOT NULL,\n  `contact_id` bigint DEFAULT NULL,\n  `owner_employee_id` bigint DEFAULT NULL,\n  `to_email` varchar(150) NOT NULL,\n  `kind` varchar(20) NOT NULL,\n  `reason` varchar(500) DEFAULT NULL,\n  `subject` varchar(255) NOT NULL,\n  `body` text NOT NULL,\n  `generated_by` varchar(20) NOT NULL,\n  `status` varchar(20) NOT NULL DEFAULT 'draft',\n  `error` varchar(500) DEFAULT NULL,\n  `activity_id` bigint DEFAULT NULL,\n  `created_by_user_id` bigint DEFAULT NULL,\n  `sent_by_user_id` bigint DEFAULT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  `updated_at` datetime DEFAULT NULL,\n  `sent_at` datetime DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `idx_crm_email_drafts_status_owner` (`status`,`owner_employee_id`),\n  KEY `idx_crm_email_drafts_customer` (`customer_id`,`created_at`)\n) ENGINE=InnoDB"
  ],
  [
    "crm_email_optouts",
    "CREATE TABLE IF NOT EXISTS `crm_email_optouts` (\n  `email` varchar(150) NOT NULL,\n  `opted_out_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  `source` varchar(30) NOT NULL DEFAULT 'unsubscribe_link',\n  PRIMARY KEY (`email`)\n) ENGINE=InnoDB"
  ],
  [
    "crm_tags",
    "CREATE TABLE IF NOT EXISTS `crm_tags` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `name` varchar(60) NOT NULL,\n  `color` varchar(20) DEFAULT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq_crm_tags_name` (`name`)\n) ENGINE=InnoDB"
  ],
  [
    "customer_billing_contacts",
    "CREATE TABLE IF NOT EXISTS `customer_billing_contacts` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `customer_id` bigint NOT NULL,\n  `contact_person` varchar(255) DEFAULT NULL,\n  `contact_number` varchar(255) DEFAULT NULL,\n  `email` varchar(255) DEFAULT NULL,\n  `address` varchar(500) DEFAULT NULL,\n  `billing_collection` varchar(30) DEFAULT NULL,\n  `billing_requirements` varchar(1000) DEFAULT NULL,\n  `releasing_schedule` varchar(255) DEFAULT NULL,\n  `releasing_location` varchar(255) DEFAULT NULL,\n  `payment_method` varchar(255) DEFAULT NULL,\n  `other_info` varchar(1000) DEFAULT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n  PRIMARY KEY (`id`),\n  KEY `idx_cbc_customer` (`customer_id`),\n  CONSTRAINT `fk_cbc_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE\n) ENGINE=InnoDB"
  ],
  [
    "customer_relationships",
    "CREATE TABLE IF NOT EXISTS `customer_relationships` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `customer_id` bigint NOT NULL,\n  `related_customer_id` bigint DEFAULT NULL,\n  `name` varchar(200) NOT NULL,\n  `address` text,\n  `contact_no` varchar(100) DEFAULT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  `updated_at` datetime DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `idx_customer_relationships_customer` (`customer_id`),\n  KEY `idx_cr_related` (`related_customer_id`)\n) ENGINE=InnoDB"
  ],
  [
    "customer_tags",
    "CREATE TABLE IF NOT EXISTS `customer_tags` (\n  `customer_id` bigint NOT NULL,\n  `tag_id` bigint NOT NULL,\n  PRIMARY KEY (`customer_id`,`tag_id`),\n  KEY `idx_customer_tags_tag` (`tag_id`)\n) ENGINE=InnoDB"
  ],
  [
    "document_attachments",
    "CREATE TABLE IF NOT EXISTS `document_attachments` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `doc_type` varchar(30) NOT NULL,\n  `doc_id` bigint NOT NULL,\n  `kind` varchar(40) NOT NULL DEFAULT 'BIR 2307',\n  `file_name` varchar(255) NOT NULL,\n  `mime_type` varchar(100) NOT NULL,\n  `size_bytes` int NOT NULL,\n  `file_data` longblob NOT NULL,\n  `uploaded_by_user_id` bigint DEFAULT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (`id`),\n  KEY `idx_document_attachments_doc` (`doc_type`,`doc_id`)\n) ENGINE=InnoDB"
  ],
  [
    "estimate_attachments",
    "CREATE TABLE IF NOT EXISTS `estimate_attachments` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `estimate_id` bigint NOT NULL,\n  `file_name` varchar(255) NOT NULL,\n  `mime_type` varchar(100) NOT NULL,\n  `size_bytes` int NOT NULL,\n  `file_data` longblob NOT NULL,\n  `uploaded_by_user_id` bigint DEFAULT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  `archive_path` varchar(500) DEFAULT NULL,\n  `archive_sha256` char(64) DEFAULT NULL,\n  `archived_at` datetime DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `idx_estimate_attachments` (`estimate_id`)\n) ENGINE=InnoDB"
  ],
  [
    "form_overtime_details",
    "CREATE TABLE IF NOT EXISTS `form_overtime_details` (\n  `form_request_id` bigint NOT NULL,\n  `for_self` tinyint(1) NOT NULL DEFAULT '0',\n  `target_user_id` bigint NOT NULL,\n  `target_department_id` bigint DEFAULT NULL,\n  `ot_date` date NOT NULL,\n  `time_from` time NOT NULL,\n  `time_to` time NOT NULL,\n  `hours` decimal(5,2) NOT NULL DEFAULT '0.00',\n  `purpose` text,\n  `reference_no` varchar(100) DEFAULT NULL,\n  `responded_at` datetime DEFAULT NULL,\n  `response_remark` varchar(1000) DEFAULT NULL,\n  `decline_violation_id` bigint DEFAULT NULL,\n  `actual_time_from` time DEFAULT NULL,\n  `actual_time_to` time DEFAULT NULL,\n  `actual_hours` decimal(5,2) DEFAULT NULL,\n  `ot_confirmed_at` datetime DEFAULT NULL,\n  `ot_confirmed_by_user_id` bigint DEFAULT NULL,\n  PRIMARY KEY (`form_request_id`),\n  KEY `idx_ot_target_user` (`target_user_id`),\n  KEY `idx_ot_target_dept` (`target_department_id`)\n) ENGINE=InnoDB"
  ],
  [
    "form_payment_details",
    "CREATE TABLE IF NOT EXISTS `form_payment_details` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `form_request_id` bigint NOT NULL,\n  `payable_to` varchar(255) NOT NULL,\n  `address` varchar(255) DEFAULT NULL,\n  `doc_date` date DEFAULT NULL,\n  `total_amount` decimal(12,2) DEFAULT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  `from_account_id` bigint DEFAULT NULL,\n  `to_account_id` bigint DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq_form_payment_doc` (`form_request_id`)\n) ENGINE=InnoDB"
  ],
  [
    "form_request_items",
    "CREATE TABLE IF NOT EXISTS `form_request_items` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `form_request_id` bigint NOT NULL,\n  `item_date` date DEFAULT NULL,\n  `particulars` varchar(255) NOT NULL,\n  `amount` decimal(12,2) NOT NULL DEFAULT '0.00',\n  `cogs_account_id` bigint DEFAULT NULL,\n  `rejection_remark` text,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  `from_account_id` bigint DEFAULT NULL,\n  `to_account_id` bigint DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `idx_form_request_items_doc` (`form_request_id`)\n) ENGINE=InnoDB"
  ],
  [
    "form_requests",
    "CREATE TABLE IF NOT EXISTS `form_requests` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `request_no` varchar(30) NOT NULL,\n  `type` varchar(50) NOT NULL,\n  `user_id` bigint NOT NULL,\n  `department` varchar(255) DEFAULT NULL,\n  `department_id` bigint DEFAULT NULL,\n  `name` varchar(255) DEFAULT NULL,\n  `remarks` varchar(2000) DEFAULT NULL,\n  `status` varchar(20) NOT NULL DEFAULT 'draft',\n  `submitted_at` datetime DEFAULT NULL,\n  `noted_at` datetime DEFAULT NULL,\n  `approved_at` datetime DEFAULT NULL,\n  `rejected_at` datetime DEFAULT NULL,\n  `noted_by` bigint DEFAULT NULL,\n  `approved_by` bigint DEFAULT NULL,\n  `rejected_by` bigint DEFAULT NULL,\n  `rejection_reason` text,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  `updated_at` datetime DEFAULT NULL,\n  `credit_account_id` bigint DEFAULT NULL,\n  `approver_user_id` bigint DEFAULT NULL,\n  `noter_user_id` bigint DEFAULT NULL,\n  `pre_approver_user_id` bigint DEFAULT NULL,\n  `pre_approved_at` datetime DEFAULT NULL,\n  `pre_approved_by` bigint DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq_form_requests_no` (`request_no`),\n  KEY `idx_form_requests_type_status` (`type`,`status`),\n  KEY `idx_form_requests_user_status` (`user_id`,`status`),\n  KEY `idx_form_requests_department` (`department_id`),\n  KEY `idx_form_approver` (`approver_user_id`),\n  KEY `idx_form_noter` (`noter_user_id`)\n) ENGINE=InnoDB"
  ],
  [
    "job_type_process_materials",
    "CREATE TABLE IF NOT EXISTS `job_type_process_materials` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `job_type_process_id` bigint NOT NULL,\n  `inventory_id` bigint NOT NULL,\n  `is_default` tinyint(1) DEFAULT '0',\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq_jtpm` (`job_type_process_id`,`inventory_id`),\n  KEY `idx_jtpm_inventory` (`inventory_id`)\n) ENGINE=InnoDB"
  ],
  [
    "live_gl_entries",
    "CREATE TABLE IF NOT EXISTS `live_gl_entries` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `live_pk` varchar(64) NOT NULL,\n  `live_trans_pk` varchar(64) NOT NULL,\n  `source_type` varchar(40) NOT NULL,\n  `source_no` varchar(64) DEFAULT NULL,\n  `source_id` bigint DEFAULT NULL,\n  `entry_module` varchar(40) DEFAULT NULL,\n  `account_id` bigint DEFAULT NULL,\n  `account_code` varchar(40) DEFAULT NULL,\n  `account_name` varchar(255) DEFAULT NULL,\n  `debit` decimal(18,4) NOT NULL DEFAULT '0.0000',\n  `credit` decimal(18,4) NOT NULL DEFAULT '0.0000',\n  `entry_date` date DEFAULT NULL,\n  `location_id` bigint DEFAULT NULL,\n  `department_id` bigint DEFAULT NULL,\n  `memo` varchar(500) DEFAULT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uk_live_pk` (`live_pk`),\n  KEY `idx_source` (`source_type`,`source_id`),\n  KEY `idx_trans` (`live_trans_pk`),\n  KEY `idx_date` (`entry_date`)\n) ENGINE=InnoDB"
  ],
  [
    "manual_step_images",
    "CREATE TABLE IF NOT EXISTS `manual_step_images` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `flow_key` varchar(40) NOT NULL,\n  `node_id` varchar(60) NOT NULL,\n  `step_index` int NOT NULL,\n  `mime_type` varchar(50) NOT NULL,\n  `image_data` mediumblob NOT NULL,\n  `uploaded_by_user_id` bigint DEFAULT NULL,\n  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq_manual_step` (`flow_key`,`node_id`,`step_index`)\n) ENGINE=InnoDB"
  ],
  [
    "opening_ap_items",
    "CREATE TABLE IF NOT EXISTS `opening_ap_items` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `as_of` date NOT NULL,\n  `supplier_id` bigint DEFAULT NULL,\n  `source_supplier_pk` varchar(64) DEFAULT NULL,\n  `supplier_name` varchar(255) NOT NULL,\n  `location_id` bigint DEFAULT NULL,\n  `doc_type` varchar(30) NOT NULL,\n  `doc_no` varchar(60) NOT NULL,\n  `source_doc_pk` varchar(64) DEFAULT NULL,\n  `doc_date` date DEFAULT NULL,\n  `due_date` date DEFAULT NULL,\n  `original_amount` decimal(18,2) NOT NULL DEFAULT '0.00',\n  `balance` decimal(18,2) NOT NULL,\n  `vendor_bill_id` bigint DEFAULT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq_opening_ap` (`as_of`,`doc_type`,`doc_no`,`source_supplier_pk`),\n  KEY `idx_opening_ap_supplier` (`supplier_id`),\n  KEY `idx_opening_ap_bill` (`vendor_bill_id`)\n) ENGINE=InnoDB"
  ],
  [
    "opening_ar_items",
    "CREATE TABLE IF NOT EXISTS `opening_ar_items` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `as_of` date NOT NULL,\n  `customer_id` bigint DEFAULT NULL,\n  `source_customer_pk` varchar(64) DEFAULT NULL,\n  `customer_name` varchar(255) NOT NULL,\n  `location_id` bigint DEFAULT NULL,\n  `doc_type` varchar(30) NOT NULL,\n  `doc_no` varchar(60) NOT NULL,\n  `source_doc_pk` varchar(64) DEFAULT NULL,\n  `doc_date` date DEFAULT NULL,\n  `due_date` date DEFAULT NULL,\n  `original_amount` decimal(18,2) NOT NULL DEFAULT '0.00',\n  `balance` decimal(18,2) NOT NULL,\n  `sales_invoice_id` bigint DEFAULT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  `memo` varchar(1000) DEFAULT NULL,\n  `po_no` varchar(150) DEFAULT NULL,\n  `bs_no` varchar(100) DEFAULT NULL,\n  `src_location` varchar(150) DEFAULT NULL,\n  `sales_rep` varchar(150) DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq_opening_ar` (`as_of`,`doc_type`,`doc_no`,`source_customer_pk`),\n  KEY `idx_opening_ar_customer` (`customer_id`),\n  KEY `idx_opening_ar_invoice` (`sales_invoice_id`)\n) ENGINE=InnoDB"
  ],
  [
    "opening_gl_balances",
    "CREATE TABLE IF NOT EXISTS `opening_gl_balances` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `as_of` date NOT NULL,\n  `account_id` bigint NOT NULL,\n  `account_code` varchar(50) NOT NULL,\n  `debit` decimal(18,2) NOT NULL DEFAULT '0.00',\n  `credit` decimal(18,2) NOT NULL DEFAULT '0.00',\n  `note` varchar(300) DEFAULT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq_opening_gl` (`as_of`,`account_id`)\n) ENGINE=InnoDB"
  ],
  [
    "perf_templates",
    "CREATE TABLE IF NOT EXISTS `perf_templates` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `position_title` varchar(150) NOT NULL,\n  `department_id` bigint DEFAULT NULL,\n  `is_active` tinyint(1) NOT NULL DEFAULT '1',\n  `created_by_user_id` bigint DEFAULT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  `updated_at` datetime DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB"
  ],
  [
    "purchase_units",
    "CREATE TABLE IF NOT EXISTS `purchase_units` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `code` varchar(60) NOT NULL,\n  `purchase_unit` varchar(30) DEFAULT NULL,\n  `base_unit` varchar(30) DEFAULT NULL,\n  `is_length` tinyint(1) NOT NULL DEFAULT '0',\n  `is_width` tinyint(1) NOT NULL DEFAULT '0',\n  `is_active` tinyint(1) NOT NULL DEFAULT '1',\n  `live_pk` varchar(64) DEFAULT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  `updated_at` datetime DEFAULT NULL,\n  `sales_units` varchar(255) DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq_purchase_units_live_pk` (`live_pk`),\n  KEY `idx_purchase_units_code` (`code`)\n) ENGINE=InnoDB"
  ],
  [
    "rmi_receipt_lines",
    "CREATE TABLE IF NOT EXISTS `rmi_receipt_lines` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `rmi_id` bigint NOT NULL,\n  `rmi_line_id` bigint NOT NULL,\n  `item_id` bigint NOT NULL,\n  `qty` decimal(14,4) NOT NULL,\n  `uom` varchar(30) DEFAULT NULL,\n  `date_received` date NOT NULL,\n  `received_by_user_id` bigint DEFAULT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (`id`),\n  KEY `received_by_user_id` (`received_by_user_id`),\n  KEY `idx_rmi_receipt_lines_rmi` (`rmi_id`),\n  KEY `idx_rmi_receipt_lines_item` (`item_id`,`date_received`),\n  KEY `fk_rmi_receipt_lines_line` (`rmi_line_id`)\n) ENGINE=InnoDB"
  ],
  [
    "rmis",
    "CREATE TABLE IF NOT EXISTS `rmis` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `rmi_no` varchar(30) NOT NULL,\n  `date_created` date NOT NULL,\n  `return_from_location_id` bigint NOT NULL,\n  `return_to_location_id` bigint NOT NULL,\n  `returned_by_employee_id` bigint DEFAULT NULL,\n  `memo` varchar(500) DEFAULT NULL,\n  `status` varchar(30) NOT NULL DEFAULT 'pending_receipt',\n  `created_by_user_id` bigint DEFAULT NULL,\n  `received_at` datetime DEFAULT NULL,\n  `cancelled_at` datetime DEFAULT NULL,\n  `live_pk` varchar(64) DEFAULT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  `updated_at` datetime DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `rmi_no` (`rmi_no`),\n  UNIQUE KEY `uq_rmis_live_pk` (`live_pk`),\n  KEY `returned_by_employee_id` (`returned_by_employee_id`),\n  KEY `created_by_user_id` (`created_by_user_id`),\n  KEY `idx_rmis_status` (`status`,`date_created`),\n  KEY `idx_rmis_from` (`return_from_location_id`),\n  KEY `idx_rmis_to` (`return_to_location_id`)\n) ENGINE=InnoDB"
  ],
  [
    "source_coa_keys",
    "CREATE TABLE IF NOT EXISTS `source_coa_keys` (\n  `account_code` varchar(30) NOT NULL,\n  `coa_pk` varchar(64) NOT NULL,\n  `title` varchar(200) DEFAULT NULL,\n  `side` varchar(10) DEFAULT NULL,\n  PRIMARY KEY (`account_code`)\n) ENGINE=InnoDB"
  ],
  [
    "source_dept_account_actuals",
    "CREATE TABLE IF NOT EXISTS `source_dept_account_actuals` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `year` smallint NOT NULL,\n  `month` tinyint NOT NULL,\n  `source_department` varchar(100) NOT NULL,\n  `section` enum('opex','other_expense','cogs','revenue','other_income') NOT NULL,\n  `account_code` varchar(30) NOT NULL,\n  `amount` decimal(16,2) NOT NULL,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq_source_dept_account_actual` (`year`,`month`,`source_department`,`section`,`account_code`)\n) ENGINE=InnoDB"
  ],
  [
    "source_dept_keys",
    "CREATE TABLE IF NOT EXISTS `source_dept_keys` (\n  `source_department` varchar(100) NOT NULL,\n  `dept_pk` varchar(64) DEFAULT NULL,\n  PRIMARY KEY (`source_department`)\n) ENGINE=InnoDB"
  ],
  [
    "source_loc_account_actuals",
    "CREATE TABLE IF NOT EXISTS `source_loc_account_actuals` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `year` smallint NOT NULL,\n  `month` tinyint NOT NULL,\n  `source_location` varchar(100) NOT NULL,\n  `section` enum('opex','other_expense','cogs','revenue','other_income') NOT NULL,\n  `account_code` varchar(30) NOT NULL,\n  `amount` decimal(16,2) NOT NULL,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq_source_loc_account_actual` (`year`,`month`,`source_location`,`section`,`account_code`)\n) ENGINE=InnoDB"
  ],
  [
    "ticket_attachments",
    "CREATE TABLE IF NOT EXISTS `ticket_attachments` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `ticket_id` bigint NOT NULL,\n  `file_name` varchar(255) NOT NULL,\n  `mime_type` varchar(100) NOT NULL,\n  `size_bytes` int NOT NULL,\n  `file_data` longblob NOT NULL,\n  `uploaded_by_user_id` bigint DEFAULT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  `archive_path` varchar(500) DEFAULT NULL,\n  `archive_sha256` char(64) DEFAULT NULL,\n  `archived_at` datetime DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `idx_ticket_attachments_ticket` (`ticket_id`),\n  KEY `fk_ticket_attachments_user` (`uploaded_by_user_id`)\n) ENGINE=InnoDB"
  ],
  [
    "unit_titles",
    "CREATE TABLE IF NOT EXISTS `unit_titles` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `title` varchar(100) NOT NULL,\n  `name` varchar(60) DEFAULT NULL,\n  `purchase_unit` varchar(30) DEFAULT NULL,\n  `stock_unit` varchar(30) DEFAULT NULL,\n  `sale_unit` varchar(30) DEFAULT NULL,\n  `base_unit` varchar(30) DEFAULT NULL,\n  `length` decimal(18,6) DEFAULT NULL,\n  `width` decimal(18,6) DEFAULT NULL,\n  `conversion` decimal(20,8) DEFAULT NULL,\n  `is_length` tinyint(1) NOT NULL DEFAULT '0',\n  `is_width` tinyint(1) NOT NULL DEFAULT '0',\n  `is_pieces` tinyint(1) NOT NULL DEFAULT '0',\n  `pieces` decimal(18,4) DEFAULT NULL,\n  `is_active` tinyint(1) NOT NULL DEFAULT '1',\n  `live_pk` varchar(64) DEFAULT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  `updated_at` datetime DEFAULT NULL,\n  `sales_units` varchar(255) DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq_unit_titles_live_pk` (`live_pk`),\n  KEY `idx_unit_titles_title` (`title`)\n) ENGINE=InnoDB"
  ],
  [
    "user_supervisors",
    "CREATE TABLE IF NOT EXISTS `user_supervisors` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `user_id` bigint NOT NULL,\n  `supervisor_id` bigint NOT NULL,\n  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq_user_supervisor` (`user_id`,`supervisor_id`),\n  KEY `idx_user_supervisors_supervisor` (`supervisor_id`)\n) ENGINE=InnoDB"
  ],
  [
    "vendor_bill_form_items",
    "CREATE TABLE IF NOT EXISTS `vendor_bill_form_items` (\n  `vendor_bill_id` bigint NOT NULL,\n  `form_request_item_id` bigint NOT NULL,\n  PRIMARY KEY (`vendor_bill_id`,`form_request_item_id`),\n  KEY `idx_vbfi_item` (`form_request_item_id`)\n) ENGINE=InnoDB"
  ]
];

const ADD_COLUMNS = [
  [
    "account_type_permissions",
    "can_update",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "account_type_permissions",
    "can_view_all",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "account_type_permissions",
    "can_print",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "account_type_permissions",
    "can_void",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "bill_credits",
    "supplier_id",
    "bigint NULL"
  ],
  [
    "bill_credits",
    "cheque_id",
    "bigint NULL"
  ],
  [
    "bill_payments",
    "date_released",
    "date NULL"
  ],
  [
    "chart_of_accounts",
    "exclude_from_reports",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "cheques",
    "form_request_id",
    "bigint NULL"
  ],
  [
    "commission_voucher_expenses",
    "applies_to_payable_id",
    "bigint NULL"
  ],
  [
    "credit_memo_applications",
    "invoice_no",
    "varchar(40) NULL"
  ],
  [
    "credit_memo_applications",
    "original_amount_due",
    "decimal(18,2) NOT NULL DEFAULT '0.00'"
  ],
  [
    "credit_memos",
    "sales_rep_id",
    "bigint NULL"
  ],
  [
    "credit_memos",
    "source_account_id",
    "bigint NULL"
  ],
  [
    "crm_activities",
    "starts_at",
    "datetime NULL"
  ],
  [
    "crm_activities",
    "ends_at",
    "datetime NULL"
  ],
  [
    "crm_activities",
    "location",
    "varchar(300) NULL"
  ],
  [
    "crm_activities",
    "contact_id",
    "bigint NULL"
  ],
  [
    "crm_activities",
    "outcome",
    "varchar(1000) NULL"
  ],
  [
    "crm_activities",
    "invite_sent_at",
    "datetime NULL"
  ],
  [
    "customer_contacts",
    "birthday",
    "date NULL"
  ],
  [
    "customer_contacts",
    "personal_notes",
    "varchar(1000) NULL"
  ],
  [
    "customer_contacts",
    "address",
    "text NULL"
  ],
  [
    "customer_contacts",
    "is_default_bill_to",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "customer_contacts",
    "is_approver",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "customer_contacts",
    "is_certifier",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "customer_payment_lines",
    "customer_refund_id",
    "bigint NULL"
  ],
  [
    "customer_payments",
    "si_bs_no",
    "varchar(100) NULL"
  ],
  [
    "customer_payments",
    "issued_by_name",
    "varchar(150) NULL"
  ],
  [
    "customer_payments",
    "prepared_by_name",
    "varchar(150) NULL"
  ],
  [
    "customer_payments",
    "reference_no",
    "varchar(100) NULL"
  ],
  [
    "customer_payments",
    "bank_name",
    "varchar(150) NULL"
  ],
  [
    "customer_payments",
    "cheque_no",
    "varchar(60) NULL"
  ],
  [
    "customer_payments",
    "cheque_date",
    "date NULL"
  ],
  [
    "customer_refund_lines",
    "payment_no",
    "varchar(60) NULL"
  ],
  [
    "customers",
    "source",
    "varchar(20) NULL"
  ],
  [
    "customers",
    "address",
    "text NULL"
  ],
  [
    "customers",
    "tax_id",
    "bigint NULL"
  ],
  [
    "customers",
    "crm_priority",
    "varchar(10) NOT NULL DEFAULT 'normal'"
  ],
  [
    "customers",
    "visit_every_days",
    "int NULL"
  ],
  [
    "customers",
    "birthdate",
    "date NULL"
  ],
  [
    "customers",
    "gender",
    "varchar(10) NULL"
  ],
  [
    "customers",
    "contact_no",
    "varchar(100) NULL"
  ],
  [
    "customers",
    "customer_type",
    "varchar(20) NULL"
  ],
  [
    "customers",
    "is_charge_to_location",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "customers",
    "is_ewt",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "customers",
    "is_final_tax",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "customers",
    "is_charge_to",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "customers",
    "include_90_commission",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "customers",
    "bill_to_name",
    "varchar(200) NULL"
  ],
  [
    "customers",
    "bill_to_address",
    "text NULL"
  ],
  [
    "customers",
    "bill_to_contact_no",
    "varchar(100) NULL"
  ],
  [
    "department_ticket_approvers",
    "can_approve_ticket",
    "tinyint(1) NOT NULL DEFAULT '1'"
  ],
  [
    "department_ticket_approvers",
    "can_note_form",
    "tinyint(1) NOT NULL DEFAULT '1'"
  ],
  [
    "department_ticket_approvers",
    "can_approve_leave",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "department_ticket_approvers",
    "note_form_types",
    "varchar(255) NULL"
  ],
  [
    "departments",
    "job_location_id",
    "bigint NULL"
  ],
  [
    "employees",
    "pay_method",
    "varchar(20) NULL"
  ],
  [
    "employees",
    "middle_name",
    "varchar(100) NULL"
  ],
  [
    "employees",
    "height_cm",
    "decimal(5,2) NULL"
  ],
  [
    "employees",
    "weight_kg",
    "decimal(5,2) NULL"
  ],
  [
    "employees",
    "no_lunch_punch",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "employees",
    "compute_overtime",
    "tinyint(1) NOT NULL DEFAULT '1'"
  ],
  [
    "employees",
    "document_ok_probationary",
    "varchar(10) NULL"
  ],
  [
    "employees",
    "document_ok_regular",
    "varchar(10) NULL"
  ],
  [
    "employees",
    "date_eoc",
    "date NULL"
  ],
  [
    "employees",
    "emergency_contact_relation",
    "varchar(60) NULL"
  ],
  [
    "employees",
    "rest_day_group",
    "varchar(60) NULL"
  ],
  [
    "employees",
    "shift_group",
    "varchar(60) NULL"
  ],
  [
    "estimate_job_order_processes",
    "location_id",
    "bigint NULL"
  ],
  [
    "estimate_job_order_processes",
    "print_selected",
    "tinyint(1) NULL"
  ],
  [
    "estimate_job_orders",
    "nstdjo_id",
    "bigint NULL"
  ],
  [
    "estimate_job_orders",
    "contingency_percent",
    "decimal(14,6) NULL"
  ],
  [
    "estimate_job_orders",
    "contingency_amount",
    "decimal(14,2) NULL"
  ],
  [
    "estimates",
    "csa_assigned_by_user_id",
    "bigint NULL"
  ],
  [
    "estimates",
    "csa_assigned_at",
    "datetime NULL"
  ],
  [
    "estimates",
    "web_source",
    "varchar(20) NULL"
  ],
  [
    "estimates",
    "order_confirmation_ref",
    "varchar(100) NULL"
  ],
  [
    "estimates",
    "sent_to_customer_at",
    "datetime NULL"
  ],
  [
    "estimates",
    "sent_to_customer_email",
    "varchar(255) NULL"
  ],
  [
    "estimates",
    "sent_to_customer_by_user_id",
    "bigint NULL"
  ],
  [
    "fund_transfers",
    "form_request_id",
    "bigint NULL"
  ],
  [
    "inventories",
    "length",
    "decimal(14,4) NULL"
  ],
  [
    "inventories",
    "width",
    "decimal(14,4) NULL"
  ],
  [
    "inventories",
    "conversion_type",
    "varchar(20) NULL"
  ],
  [
    "inventories",
    "can_be_received",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "inventories",
    "unit_title_id",
    "bigint NULL"
  ],
  [
    "item_deliveries",
    "nsso_id",
    "bigint NULL"
  ],
  [
    "item_deliveries",
    "delivery_method_id",
    "bigint NULL"
  ],
  [
    "item_deliveries",
    "delivery_cost",
    "decimal(12,2) NULL"
  ],
  [
    "item_deliveries",
    "delivery_reference",
    "varchar(80) NULL"
  ],
  [
    "item_fulfillment_lines",
    "live_pk",
    "varchar(64) NULL"
  ],
  [
    "item_receipt_lines",
    "live_pk",
    "varchar(64) NULL"
  ],
  [
    "job_order_processes",
    "avg_cost",
    "decimal(18,4) NULL"
  ],
  [
    "job_order_processes",
    "planned_start_date",
    "date NULL"
  ],
  [
    "job_order_processes",
    "planned_end_date",
    "date NULL"
  ],
  [
    "job_orders",
    "reason_code_id",
    "bigint NULL"
  ],
  [
    "job_orders",
    "reason",
    "varchar(500) NULL"
  ],
  [
    "job_orders",
    "action_to_be_taken",
    "varchar(500) NULL"
  ],
  [
    "job_orders",
    "revision_reason",
    "varchar(32) NULL"
  ],
  [
    "job_orders",
    "revision_note",
    "varchar(500) NULL"
  ],
  [
    "job_orders",
    "revision_suggested_delivery_date",
    "date NULL"
  ],
  [
    "job_orders",
    "revision_requested_by_id",
    "bigint NULL"
  ],
  [
    "job_orders",
    "revision_requested_at",
    "datetime NULL"
  ],
  [
    "job_orders",
    "revision_date_decision",
    "varchar(16) NULL"
  ],
  [
    "job_orders",
    "revision_date_reason",
    "varchar(64) NULL"
  ],
  [
    "job_orders",
    "advance_copy_at",
    "datetime NULL"
  ],
  [
    "job_orders",
    "advance_copy_by_id",
    "bigint NULL"
  ],
  [
    "job_type_processes",
    "minutes_per_unit",
    "decimal(10,4) NULL"
  ],
  [
    "journals",
    "form_request_id",
    "bigint NULL"
  ],
  [
    "journals",
    "adds_to_source_figures",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "landed_costs",
    "item_id",
    "bigint NULL"
  ],
  [
    "live_stock_ledger",
    "beg_qty",
    "decimal(24,6) NULL"
  ],
  [
    "live_stock_ledger",
    "beg_cost",
    "decimal(24,6) NULL"
  ],
  [
    "live_stock_ledger",
    "beg_value",
    "decimal(24,4) NULL"
  ],
  [
    "live_stock_ledger",
    "input",
    "decimal(24,6) NULL"
  ],
  [
    "live_stock_ledger",
    "input_value",
    "decimal(24,4) NULL"
  ],
  [
    "live_stock_ledger",
    "output",
    "decimal(24,6) NULL"
  ],
  [
    "live_stock_ledger",
    "output_value",
    "decimal(24,4) NULL"
  ],
  [
    "live_stock_ledger",
    "ending_qty",
    "decimal(24,6) NULL"
  ],
  [
    "live_stock_ledger",
    "ending_cost",
    "decimal(24,6) NULL"
  ],
  [
    "live_stock_ledger",
    "ending_value",
    "decimal(24,4) NULL"
  ],
  [
    "live_stock_ledger",
    "window_from",
    "date NULL"
  ],
  [
    "live_stock_ledger",
    "window_to",
    "date NULL"
  ],
  [
    "live_stock_ledger",
    "updated_at",
    "datetime NOT NULL DEFAULT CURRENT_TIMESTAMP"
  ],
  [
    "non_standard_job_orders",
    "sales_revision_count",
    "int NOT NULL DEFAULT '0'"
  ],
  [
    "non_standard_job_orders",
    "last_revision_at",
    "datetime NULL"
  ],
  [
    "non_standard_job_orders",
    "last_revision_note",
    "varchar(500) NULL"
  ],
  [
    "office_supply_requisition_lines",
    "unit",
    "varchar(50) NULL"
  ],
  [
    "office_supply_requisitions",
    "transfer_to_location_id",
    "bigint NULL"
  ],
  [
    "process_cost_brackets",
    "new_ink_cost",
    "decimal(14,4) NULL DEFAULT '0.0000'"
  ],
  [
    "process_cost_brackets",
    "markup_sub_con_pct",
    "decimal(6,2) NULL DEFAULT '0.00'"
  ],
  [
    "process_cost_brackets",
    "markup_opex_admin_pct",
    "decimal(6,2) NULL DEFAULT '0.00'"
  ],
  [
    "process_cost_brackets",
    "markup_opex_selling_pct",
    "decimal(6,2) NULL DEFAULT '0.00'"
  ],
  [
    "process_cost_brackets",
    "costing_reference",
    "varchar(100) NULL"
  ],
  [
    "processes",
    "default_location_id",
    "bigint NULL"
  ],
  [
    "processes",
    "ink_media_usage",
    "decimal(16,4) NULL"
  ],
  [
    "processes",
    "ink_media_weight_wo_print",
    "decimal(16,4) NULL"
  ],
  [
    "processes",
    "ink_media_weight_w_print",
    "decimal(16,4) NULL"
  ],
  [
    "processes",
    "ink_weight_full",
    "decimal(16,4) NULL"
  ],
  [
    "processes",
    "ink_weight_empty",
    "decimal(16,4) NULL"
  ],
  [
    "processes",
    "ink_volume",
    "decimal(16,4) NULL"
  ],
  [
    "processes",
    "ink_cost_per_sqft",
    "decimal(16,4) NULL"
  ],
  [
    "processes",
    "ink_cost_per_sqft_costing",
    "decimal(16,4) NULL"
  ],
  [
    "processes",
    "ink_usage_costing",
    "decimal(16,4) NULL"
  ],
  [
    "processes",
    "ink_price_per_ml_costing",
    "decimal(16,4) NULL"
  ],
  [
    "purchase_order_lines",
    "disc_formula",
    "varchar(60) NULL"
  ],
  [
    "purchase_order_lines",
    "live_line_pk",
    "varchar(64) NULL"
  ],
  [
    "purchase_orders",
    "live_pk",
    "varchar(64) NULL"
  ],
  [
    "purchase_orders",
    "prepared_by_name",
    "varchar(150) NULL"
  ],
  [
    "quality_inspection_lines",
    "reason_id",
    "bigint NULL"
  ],
  [
    "sales_invoice_lines",
    "nsso_line_id",
    "bigint NULL"
  ],
  [
    "sales_invoice_lines",
    "item_id",
    "bigint NULL"
  ],
  [
    "sales_invoice_lines",
    "estimate_job_order_id",
    "bigint NULL"
  ],
  [
    "sales_invoice_lines",
    "job_type_id",
    "bigint NULL"
  ],
  [
    "sales_invoices",
    "estimate_id",
    "bigint NULL"
  ],
  [
    "sales_invoices",
    "nsso_id",
    "bigint NULL"
  ],
  [
    "sales_invoices",
    "customer_id",
    "bigint NULL"
  ],
  [
    "sales_invoices",
    "collection_forecast_date",
    "date NULL"
  ],
  [
    "sales_invoices",
    "collection_forecast_set_by_user_id",
    "bigint NULL"
  ],
  [
    "sales_invoices",
    "collection_forecast_set_at",
    "datetime NULL"
  ],
  [
    "sales_invoices",
    "invoice_type",
    "varchar(2) NOT NULL DEFAULT 'SI'"
  ],
  [
    "sales_invoices",
    "logistics_received_date",
    "date NULL"
  ],
  [
    "sales_invoices",
    "logistics_received_by_user_id",
    "bigint NULL"
  ],
  [
    "sales_orders",
    "order_confirmation_ref",
    "varchar(100) NULL"
  ],
  [
    "sales_orders",
    "actual_gp_rate",
    "decimal(10,4) NULL"
  ],
  [
    "sales_orders",
    "cancel_reason_id",
    "int NULL"
  ],
  [
    "sales_orders",
    "cancel_remarks",
    "varchar(500) NULL"
  ],
  [
    "sales_orders",
    "cancelled_at",
    "datetime NULL"
  ],
  [
    "sales_orders",
    "cancelled_by_user_id",
    "int NULL"
  ],
  [
    "suppliers",
    "live_pk",
    "varchar(64) NULL"
  ],
  [
    "suppliers",
    "live_id",
    "int NULL"
  ],
  [
    "suppliers",
    "address",
    "varchar(500) NULL"
  ],
  [
    "suppliers",
    "contact_no",
    "varchar(120) NULL"
  ],
  [
    "suppliers",
    "mobile_no",
    "varchar(120) NULL"
  ],
  [
    "suppliers",
    "office_no",
    "varchar(120) NULL"
  ],
  [
    "suppliers",
    "fax_no",
    "varchar(120) NULL"
  ],
  [
    "suppliers",
    "email",
    "varchar(200) NULL"
  ],
  [
    "suppliers",
    "credit_term",
    "varchar(120) NULL"
  ],
  [
    "suppliers",
    "term_days",
    "int NULL"
  ],
  [
    "suppliers",
    "payee_name",
    "varchar(200) NULL"
  ],
  [
    "suppliers",
    "bank_name",
    "varchar(200) NULL"
  ],
  [
    "suppliers",
    "bank_account_name",
    "varchar(200) NULL"
  ],
  [
    "suppliers",
    "bank_account_no",
    "varchar(120) NULL"
  ],
  [
    "suppliers",
    "credit_limit",
    "decimal(14,2) NULL DEFAULT '0.00'"
  ],
  [
    "tickets",
    "declined_at",
    "datetime NULL"
  ],
  [
    "tickets",
    "declined_by_user_id",
    "bigint NULL"
  ],
  [
    "tickets",
    "decline_reason",
    "varchar(500) NULL"
  ],
  [
    "transaction_settings",
    "transaction_name",
    "varchar(120) NULL"
  ],
  [
    "transaction_settings",
    "is_posting",
    "tinyint NOT NULL DEFAULT '0'"
  ],
  [
    "transaction_settings",
    "seq",
    "int NOT NULL DEFAULT '0'"
  ],
  [
    "transaction_settings",
    "updated_by_user_id",
    "bigint NULL"
  ],
  [
    "transfer_order_lines",
    "live_pk",
    "varchar(64) NULL"
  ],
  [
    "transfer_order_lines",
    "unit_used",
    "varchar(20) NULL"
  ],
  [
    "user_page_permissions",
    "can_update",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "user_page_permissions",
    "can_view_all",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "user_page_permissions",
    "can_print",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "user_page_permissions",
    "can_void",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "users",
    "bio",
    "varchar(500) NULL"
  ],
  [
    "users",
    "last_seen_at",
    "datetime NULL"
  ],
  [
    "users",
    "cover_data",
    "mediumtext NULL"
  ],
  [
    "users",
    "bg_data",
    "mediumtext NULL"
  ],
  [
    "users",
    "is_signage_planner",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "users",
    "is_production_supervisor",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "users",
    "is_DPOD_planner",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "users",
    "is_CNC_planner",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "users",
    "is_LFP_planner",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "users",
    "signature_data",
    "mediumtext NULL"
  ],
  [
    "users",
    "signature_set_at",
    "datetime NULL"
  ],
  [
    "users",
    "can_edit_approved_po",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "users",
    "is_accounts_payable",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "users",
    "has_fuel_limit",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "users",
    "fuel_limit_liters",
    "decimal(10,2) NULL"
  ],
  [
    "users",
    "is_fuel_approver",
    "tinyint(1) NOT NULL DEFAULT '0'"
  ],
  [
    "vendor_bills",
    "form_request_id",
    "bigint NULL"
  ],
  [
    "withholding_taxes",
    "account_id",
    "bigint NULL"
  ]
];

const MODIFY_COLUMNS = [
  [
    "bill_credits",
    "vendor_bill_id",
    "bigint NULL"
  ],
  [
    "credit_memo_applications",
    "sales_invoice_id",
    "bigint NULL"
  ],
  [
    "credit_memos",
    "sales_invoice_id",
    "bigint NULL"
  ],
  [
    "customer_contacts",
    "phone",
    "varchar(100) NULL"
  ],
  [
    "estimates",
    "status",
    "enum('for_csa_assignment','pending_supervisor_approval','pending_customer_approval','approved','cancelled','disapproved') NOT NULL"
  ],
  [
    "estimates",
    "est_gp_rate",
    "decimal(12,4) NULL"
  ],
  [
    "inventories",
    "sales_description",
    "text NULL"
  ],
  [
    "inventories",
    "purchase_description",
    "text NULL"
  ],
  [
    "item_deliveries",
    "sales_order_id",
    "bigint NULL"
  ],
  [
    "purchase_order_lines",
    "rate",
    "decimal(18,6) NULL DEFAULT '0.000000'"
  ],
  [
    "purchase_order_lines",
    "disc_percent",
    "decimal(9,6) NULL DEFAULT '0.000000'"
  ],
  [
    "purchase_order_receipt_lines",
    "rate",
    "decimal(18,6) NULL DEFAULT '0.000000'"
  ],
  [
    "purchase_order_receipt_lines",
    "disc_percent",
    "decimal(9,6) NULL DEFAULT '0.000000'"
  ],
  [
    "purchase_return_lines",
    "rate",
    "decimal(18,6) NULL DEFAULT '0.000000'"
  ],
  [
    "purchase_return_lines",
    "disc_percent",
    "decimal(9,6) NULL DEFAULT '0.000000'"
  ],
  [
    "reasons",
    "reason_type",
    "enum('Cancellation','Disapproval','Return','Adjustment','Other','RFQC','RMA','Reschedule') NOT NULL"
  ],
  [
    "sales_invoices",
    "sales_order_id",
    "bigint NULL"
  ],
  [
    "sales_order_lines",
    "gp_rate",
    "decimal(12,4) NULL"
  ],
  [
    "sales_orders",
    "est_gp_rate",
    "decimal(12,4) NULL"
  ],
  [
    "suppliers",
    "tin",
    "varchar(160) NULL"
  ],
  [
    "vendor_bill_lines",
    "description",
    "varchar(500) NULL"
  ],
  [
    "vendor_bill_lines",
    "rate",
    "decimal(18,6) NULL DEFAULT '0.000000'"
  ],
  [
    "vendor_bill_lines",
    "unit_price",
    "decimal(18,6) NULL DEFAULT '0.000000'"
  ],
  [
    "vendor_bill_lines",
    "disc_percent",
    "decimal(9,6) NULL DEFAULT '0.000000'"
  ],
  [
    "sales_orders",
    "status",
    "enum('pending_for_jo','jo_in_process','pending_delivery','partially_delivered','pending_billing','pending_billing_partially_delivered','partially_billed','billed','cancelled','recorded','undeposited','deposited') NULL"
  ]
];

const INDEXES = [
  [
    "assembly_builds",
    "idx_assembly_builds_date_created",
    "INDEX",
    "`date_created`"
  ],
  [
    "bill_credits",
    "idx_bc_cheque",
    "INDEX",
    "`cheque_id`"
  ],
  [
    "bill_credits",
    "idx_bc_supplier",
    "INDEX",
    "`supplier_id`"
  ],
  [
    "bill_credits",
    "idx_bill_credits_date_created",
    "INDEX",
    "`date_created`"
  ],
  [
    "cheques",
    "idx_cheques_form_request",
    "INDEX",
    "`form_request_id`"
  ],
  [
    "credit_memos",
    "idx_credit_memos_date_created",
    "INDEX",
    "`date_created`"
  ],
  [
    "crm_activities",
    "idx_crm_activities_type_related",
    "INDEX",
    "`activity_type`,`related_type`,`related_id`,`is_done`"
  ],
  [
    "customer_payment_lines",
    "idx_cpl_customer_refund",
    "INDEX",
    "`customer_refund_id`"
  ],
  [
    "customer_payments",
    "idx_cp_department",
    "INDEX",
    "`department_id`,`date_created`"
  ],
  [
    "customer_payments",
    "idx_customer_payments_date_created",
    "INDEX",
    "`date_created`"
  ],
  [
    "customer_refunds",
    "idx_customer_refunds_date_created",
    "INDEX",
    "`date_created`"
  ],
  [
    "customers",
    "customers_tax_fk",
    "INDEX",
    "`tax_id`"
  ],
  [
    "delivery_tickets",
    "idx_delivery_tickets_date_created",
    "INDEX",
    "`date_created`"
  ],
  [
    "departments",
    "departments_job_location_fk",
    "INDEX",
    "`job_location_id`"
  ],
  [
    "estimate_job_order_processes",
    "fk_ejop_location",
    "INDEX",
    "`location_id`"
  ],
  [
    "estimate_job_orders",
    "idx_estimate_job_orders_nstdjo",
    "INDEX",
    "`nstdjo_id`"
  ],
  [
    "fund_transfers",
    "idx_fund_transfers_form_request",
    "INDEX",
    "`form_request_id`"
  ],
  [
    "inventory_adjustments",
    "idx_inventory_adjustments_date_created",
    "INDEX",
    "`date_created`"
  ],
  [
    "item_deliveries",
    "idx_item_deliveries_date_created",
    "INDEX",
    "`date_created`"
  ],
  [
    "item_deliveries",
    "idx_item_deliveries_date_method",
    "INDEX",
    "`date_created`,`delivery_method_id`"
  ],
  [
    "item_deliveries",
    "idx_item_deliveries_nsso",
    "INDEX",
    "`nsso_id`"
  ],
  [
    "item_fulfillment_lines",
    "idx_item_fulfillment_lines_live_pk",
    "INDEX",
    "`live_pk`"
  ],
  [
    "item_fulfillments",
    "idx_item_fulfillments_date_created",
    "INDEX",
    "`date_created`"
  ],
  [
    "item_receipt_lines",
    "idx_item_receipt_lines_live_pk",
    "INDEX",
    "`live_pk`"
  ],
  [
    "item_receipts",
    "idx_item_receipts_date_created",
    "INDEX",
    "`date_created`"
  ],
  [
    "job_order_processes",
    "idx_jop_location_job",
    "INDEX",
    "`location_id`,`job_order_id`"
  ],
  [
    "job_order_processes",
    "location_id",
    "INDEX",
    "`location_id`"
  ],
  [
    "job_orders",
    "idx_jo_production_stage",
    "INDEX",
    "`production_stage`"
  ],
  [
    "job_orders",
    "idx_job_orders_delivery_date",
    "INDEX",
    "`delivery_date`"
  ],
  [
    "job_orders",
    "idx_job_orders_planned_end_date",
    "INDEX",
    "`planned_end_date`"
  ],
  [
    "journals",
    "idx_journals_form_request",
    "INDEX",
    "`form_request_id`"
  ],
  [
    "live_stock_ledger",
    "uq_item_loc",
    "UNIQUE INDEX",
    "`item_pk`,`location_pk`"
  ],
  [
    "processes",
    "fk_processes_default_location",
    "INDEX",
    "`default_location_id`"
  ],
  [
    "purchase_order_receipts",
    "idx_po_receipts_date",
    "INDEX",
    "`date_created`,`id`"
  ],
  [
    "quality_inspections",
    "idx_qi_date_created",
    "INDEX",
    "`date_created`"
  ],
  [
    "sales_invoices",
    "idx_sales_invoices_collection_forecast",
    "INDEX",
    "`collection_forecast_date`"
  ],
  [
    "sales_invoices",
    "idx_sales_invoices_customer",
    "INDEX",
    "`customer_id`"
  ],
  [
    "sales_invoices",
    "idx_sales_invoices_date_created",
    "INDEX",
    "`date_created`"
  ],
  [
    "sales_invoices",
    "idx_sales_invoices_estimate",
    "INDEX",
    "`estimate_id`"
  ],
  [
    "sales_invoices",
    "idx_sales_invoices_invoice_type",
    "INDEX",
    "`invoice_type`"
  ],
  [
    "sales_invoices",
    "idx_sales_invoices_nsso",
    "INDEX",
    "`nsso_id`"
  ],
  [
    "sales_order_lines",
    "idx_sol_description",
    "INDEX",
    "`description`(100)"
  ],
  [
    "sales_order_lines",
    "idx_sol_description_units",
    "INDEX",
    "`description`(100),`units`"
  ],
  [
    "suppliers",
    "uq_suppliers_live_pk",
    "UNIQUE INDEX",
    "`live_pk`"
  ],
  [
    "transfer_order_lines",
    "idx_transfer_order_lines_live_pk",
    "INDEX",
    "`live_pk`"
  ],
  [
    "user_sales_divisions",
    "idx_usd_user",
    "INDEX",
    "`user_id`"
  ],
  [
    "users",
    "idx_users_last_seen",
    "INDEX",
    "`last_seen_at`"
  ],
  [
    "vendor_bills",
    "idx_vendor_bills_date_created",
    "INDEX",
    "`date_created`"
  ],
  [
    "vendor_bills",
    "idx_vendor_bills_form_request",
    "INDEX",
    "`form_request_id`"
  ],
  [
    "vendor_bills",
    "idx_vendor_bills_supplier",
    "INDEX",
    "`supplier_id`"
  ]
];

// The pages whose Void rights used to ride on another flag (GSUITE's add-can-void-permission.js).
const VOIDED_BY = {
  '/sales-invoices': 'can_edit', '/delivery-tickets': 'can_edit', '/customer-payments': 'can_edit',
  '/credit-memos': 'can_edit', '/customer-refunds': 'can_edit', '/cheques': 'can_edit', '/deposits': 'can_edit',
  '/fund-transfers': 'can_edit', '/journals': 'can_edit', '/vendor-bills': 'can_edit', '/bill-payments': 'can_edit',
  '/bill-credits': 'can_edit', '/commission-vouchers': 'can_edit', '/commission-payables': 'can_edit',
  '/inventory-adjustments': 'can_edit', '/assembly-builds': 'can_edit', '/warranty-certificates': 'can_edit',
  '/item-deliveries': 'can_delete',
};

const PAGES = [
  // [route, name, existing page whose users get it, copy all of their rights (else View only)]
  ['/receiving-reports', 'Receiving Reports', '/purchase-orders', false],
  ['/unit-of-measures', 'Unit of Measures', '/inventory', false],
  ['/reports/parked-bank-items', 'Unidentified Bank Items', '/reports/general-ledger', false],
  // Non-Inventory items are Inventory Items of another type: the same people manage them.
  ['/non-inventories', 'Non-Inventories', '/inventory', true],
];

let changes = 0;
async function run(label, sql, params) {
  changes += 1;
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}${label}`);
  if (!DRY_RUN) await pool.query(sql, params);
}
async function tableExists(t) {
  const [[r]] = await pool.query('SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [t]);
  return r.n > 0;
}
async function colInfo(t, col) {
  const [[r]] = await pool.query(
    'SELECT COLUMN_TYPE ty, IS_NULLABLE n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [t, col]);
  return r || null;
}
async function indexExists(t, name) {
  const [[r]] = await pool.query('SELECT COUNT(*) n FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?', [t, name]);
  return r.n > 0;
}

async function seedPermissions(added) {
  const tablesFor = (col) => ['user_page_permissions', 'account_type_permissions'].filter((t) => added.has(`${t}.${col}`));
  const adminJoin = (t) => (t === 'user_page_permissions' ? 'JOIN users u ON u.id = t.user_id' : '');
  const adminWhere = (t) => (t === 'user_page_permissions' ? "u.account_type = 'System Admin'" : "t.account_type = 'System Admin'");
  // can_update: split out of can_edit -- everyone who can edit today can still update.
  for (const t of tablesFor('can_update')) {
    await run(`seed ${t}.can_update from can_edit`, `UPDATE ${t} SET can_update = TRUE WHERE can_edit = TRUE`);
  }
  // can_print: GSUITE grants it to System Admin only. Here every page anyone can VIEW stays printable
  // for them, because this system printed for every viewer until now.
  for (const t of tablesFor('can_print')) {
    await run(`seed ${t}.can_print from can_view`, `UPDATE ${t} SET can_print = TRUE WHERE can_view = TRUE`);
  }
  // can_void: carried over from the flag that used to allow it, page by page.
  for (const t of tablesFor('can_void')) {
    for (const [route, from] of Object.entries(VOIDED_BY)) {
      await run(`seed ${t}.can_void on ${route} from ${from}`,
        `UPDATE ${t} t JOIN pages p ON p.id = t.page_id SET t.can_void = TRUE WHERE p.route = ? AND t.${from} = TRUE`, [route]);
    }
  }
  // can_view_all: System Admin everywhere; and on Commission Payables, which now lists only a
  // person's own payables without it, whoever already edits or approves them keeps seeing all.
  for (const t of tablesFor('can_view_all')) {
    await run(`seed ${t}.can_view_all for System Admin`, `UPDATE ${t} t ${adminJoin(t)} SET t.can_view_all = TRUE WHERE ${adminWhere(t)}`);
    await run(`seed ${t}.can_view_all on /commission-payables for editors / approvers`,
      `UPDATE ${t} t JOIN pages p ON p.id = t.page_id SET t.can_view_all = TRUE
        WHERE p.route = '/commission-payables' AND (t.can_edit = TRUE OR t.can_approve = TRUE)`);
  }
  // System Admin holds every new flag.
  for (const col of ['can_update', 'can_print', 'can_void']) {
    for (const t of tablesFor(col)) {
      await run(`grant ${t}.${col} to System Admin`, `UPDATE ${t} t ${adminJoin(t)} SET t.${col} = TRUE WHERE ${adminWhere(t)}`);
    }
  }
}

const FLAGS = ['can_view', 'can_add', 'can_edit', 'can_update', 'can_view_all', 'can_delete', 'can_approve', 'can_print', 'can_void'];
async function registerPages() {
  for (const [route, name, source, copyAll] of PAGES) {
    let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [route]);
    if (!page) {
      const [[near]] = await pool.query('SELECT sort_order FROM pages WHERE route = ?', [source]);
      if (DRY_RUN) { console.log(`[dry-run] register page ${route}`); changes += 1; continue; }
      const [r] = await pool.query('INSERT INTO pages (name, route, sort_order, is_active) VALUES (?, ?, ?, TRUE)', [name, route, near?.sort_order ?? 0]);
      page = { id: r.insertId };
      changes += 1;
      console.log(`register page ${route} (id ${page.id})`);
    }
    if (DRY_RUN) continue;
    const [admins] = await pool.query(
      `INSERT INTO user_page_permissions (user_id, page_id, ${FLAGS.join(', ')})
       SELECT u.id, ?, ${FLAGS.map(() => 'TRUE').join(', ')} FROM users u
        WHERE u.account_type = 'System Admin'
          AND NOT EXISTS (SELECT 1 FROM user_page_permissions x WHERE x.user_id = u.id AND x.page_id = ?)`, [page.id, page.id]);
    const cols = copyAll ? FLAGS : ['can_view'];
    const [viewers] = await pool.query(
      `INSERT INTO user_page_permissions (user_id, page_id, ${cols.join(', ')})
       SELECT upp.user_id, ?, ${cols.map((c) => `upp.${c}`).join(', ')} FROM user_page_permissions upp JOIN pages p ON p.id = upp.page_id
        WHERE p.route = ? AND upp.can_view = TRUE
          AND NOT EXISTS (SELECT 1 FROM user_page_permissions x WHERE x.user_id = upp.user_id AND x.page_id = ?)`,
      [page.id, source, page.id]);
    if (admins.affectedRows || viewers.affectedRows) {
      console.log(`  ${route}: ${admins.affectedRows} admin + ${viewers.affectedRows} viewer grant(s) (from ${source})`);
    }
  }
}

(async () => {
  try {
    console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}${DRY_RUN ? ' -- DRY RUN, nothing is written' : ''}`);
    // The DDL below names its own foreign keys in dependency order, but an empty CREATE can still
    // reference a table created later in the same list; checks are off only around the CREATEs.
    // One connection for all of it: SET FOREIGN_KEY_CHECKS is per connection, and a pool would run
    // the CREATE on whichever connection is free.
    const conn = await pool.getConnection();
    try {
      if (!DRY_RUN) await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const [t, ddl] of TABLES) {
        if (await tableExists(t)) continue;
        changes += 1;
        console.log(`${DRY_RUN ? '[dry-run] ' : ''}create table ${t}`);
        if (!DRY_RUN) await conn.query(ddl);
      }
    } finally {
      if (!DRY_RUN) await conn.query('SET FOREIGN_KEY_CHECKS = 1');
      conn.release();
    }

    // The tables above take the database's own default collation. One created with another (an
    // earlier run of this script copied GSUITE's utf8mb4_unicode_ci) cannot be joined on a string
    // column to this database's tables -- "Illegal mix of collations" -- so it is converted.
    const [[dbc]] = await pool.query('SELECT DEFAULT_COLLATION_NAME c FROM information_schema.schemata WHERE schema_name = DATABASE()');
    for (const [t] of TABLES) {
      const [[tc]] = await pool.query('SELECT TABLE_COLLATION c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [t]);
      if (!tc || tc.c === dbc.c) continue;
      await run(`convert ${t} from ${tc.c} to ${dbc.c}`, `ALTER TABLE \`${t}\` CONVERT TO CHARACTER SET utf8mb4 COLLATE ${dbc.c}`);
    }

    const added = new Set();
    for (const [t, col, def] of ADD_COLUMNS) {
      if (!(await tableExists(t))) continue;
      if (await colInfo(t, col)) continue;
      await run(`add column ${t}.${col}`, `ALTER TABLE \`${t}\` ADD COLUMN \`${col}\` ${def}`);
      added.add(`${t}.${col}`);
    }

    for (const [t, col, def] of MODIFY_COLUMNS) {
      const cur = await colInfo(t, col);
      if (!cur) continue;
      const wantType = def.split(/ (?:NOT )?NULL/)[0];
      const wantNull = !/ NOT NULL/.test(def);
      if (cur.ty === wantType && (cur.n === 'YES') === wantNull) continue;
      await run(`modify ${t}.${col}: ${cur.ty} ${cur.n === 'YES' ? 'NULL' : 'NOT NULL'} -> ${def}`, `ALTER TABLE \`${t}\` MODIFY \`${col}\` ${def}`);
    }

    for (const [t, name, kind, cols] of INDEXES) {
      if (!(await tableExists(t))) continue;
      if (await indexExists(t, name)) continue;
      await run(`add ${kind.toLowerCase()} ${t}.${name}`, `ALTER TABLE \`${t}\` ADD ${kind} \`${name}\` (${cols})`);
    }

    await seedPermissions(added);

    if (await tableExists('user_supervisors') || DRY_RUN) {
      if (DRY_RUN) console.log('[dry-run] backfill user_supervisors from users.supervisor_id');
      else {
        const [r] = await pool.query(
          `INSERT IGNORE INTO user_supervisors (user_id, supervisor_id)
           SELECT u.id, u.supervisor_id FROM users u JOIN users s ON s.id = u.supervisor_id
            WHERE u.supervisor_id IS NOT NULL AND u.supervisor_id <> u.id`);
        if (r.affectedRows) { changes += 1; console.log(`backfill user_supervisors: ${r.affectedRows} relationship(s)`); }
      }
    }

    await registerPages();

    console.log(`\n${changes} change(s)${DRY_RUN ? ' would be made' : ' made'}.`);
    await pool.end();
  } catch (err) {
    console.error(err);
    await pool.end();
    process.exit(1);
  }
})();
