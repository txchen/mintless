CREATE TABLE `account_access` (
	`user_id` text NOT NULL,
	`canonical_account_id` text NOT NULL,
	`granted_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `canonical_account_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`canonical_account_id`) REFERENCES `canonical_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`granted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `annotation_history` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_transaction_id` text NOT NULL,
	`revision` integer NOT NULL,
	`actor` text,
	`cause` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`canonical_transaction_id`) REFERENCES `canonical_transactions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `annotation_history_revision_unique` ON `annotation_history` (`canonical_transaction_id`,`revision`);--> statement-breakpoint
CREATE TABLE `transaction_annotations` (
	`canonical_transaction_id` text PRIMARY KEY NOT NULL,
	`category` text,
	`note` text DEFAULT '' NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`owner` text,
	`is_reconciled` integer DEFAULT false NOT NULL,
	`reconciled_at` integer,
	`reconciled_by` text,
	`reconciled_snapshot_json` text,
	`needs_reconciliation_review` integer DEFAULT false NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`canonical_transaction_id`) REFERENCES `canonical_transactions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reconciled_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `canonical_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`kind` text NOT NULL,
	`currency` text NOT NULL,
	`primary_source_account_id` text,
	`archived_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`primary_source_account_id`) REFERENCES `source_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `canonical_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_account_id` text NOT NULL,
	`preferred_source_id` text NOT NULL,
	`status` text NOT NULL,
	`date` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`name` text NOT NULL,
	`merchant_name` text,
	`provider_category` text,
	`lifecycle_review` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`canonical_account_id`) REFERENCES `canonical_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "canonical_transactions_status" CHECK("canonical_transactions"."status" in ('pending', 'posted', 'removed'))
);
--> statement-breakpoint
CREATE INDEX `canonical_transactions_account_date` ON `canonical_transactions` (`canonical_account_id`,`date`,`id`);--> statement-breakpoint
CREATE INDEX `canonical_transactions_date` ON `canonical_transactions` (`date`,`id`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`provider_item_id` text NOT NULL,
	`access_token_enc` text NOT NULL,
	`institution_name` text,
	`cursor` text,
	`status` text DEFAULT 'active' NOT NULL,
	`transactions_update_status` text,
	`last_sync_at` integer,
	`last_balance_at` integer,
	`last_error_code` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `provider_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_profile_provider_unique` ON `items` (`profile_id`,`provider_item_id`);--> statement-breakpoint
CREATE TABLE `provider_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`environment` text NOT NULL,
	`client_id` text,
	`secret_ref` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	CONSTRAINT "provider_profiles_environment" CHECK("provider_profiles"."environment" in ('fixture', 'sandbox', 'production'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_profiles_name_unique` ON `provider_profiles` (`name`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`csrf_token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `source_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`provider_account_id` text NOT NULL,
	`canonical_account_id` text,
	`name` text NOT NULL,
	`official_name` text,
	`mask` text,
	`type` text NOT NULL,
	`subtype` text,
	`persistent_account_id` text,
	`currency` text NOT NULL,
	`balance_current_minor` integer,
	`balance_available_minor` integer,
	`balance_limit_minor` integer,
	`balance_fetched_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`canonical_account_id`) REFERENCES `canonical_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_accounts_item_provider_unique` ON `source_accounts` (`item_id`,`provider_account_id`);--> statement-breakpoint
CREATE TABLE `source_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`provider_transaction_id` text NOT NULL,
	`source_account_id` text NOT NULL,
	`canonical_transaction_id` text,
	`pending` integer NOT NULL,
	`pending_transaction_id` text,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`date` text NOT NULL,
	`authorized_date` text,
	`name` text NOT NULL,
	`merchant_name` text,
	`provider_category` text,
	`raw_json` text NOT NULL,
	`removed_at` integer,
	`superseded_by_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_account_id`) REFERENCES `source_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`canonical_transaction_id`) REFERENCES `canonical_transactions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`superseded_by_id`) REFERENCES `source_transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_transactions_item_provider_unique` ON `source_transactions` (`item_id`,`provider_transaction_id`);--> statement-breakpoint
CREATE INDEX `source_transactions_canonical` ON `source_transactions` (`canonical_transaction_id`);--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`counts_json` text,
	`error_code` text,
	`balance_error_code` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sync_runs_item_started` ON `sync_runs` (`item_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `transaction_events` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_transaction_id` text NOT NULL,
	`source_transaction_id` text NOT NULL,
	`sync_run_id` text,
	`kind` text NOT NULL,
	`detail_json` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`canonical_transaction_id`) REFERENCES `canonical_transactions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_transaction_id`) REFERENCES `source_transactions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sync_run_id`) REFERENCES `sync_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `transaction_events_canonical` ON `transaction_events` (`canonical_transaction_id`,`at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`disabled_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	CONSTRAINT "users_role" CHECK("users"."role" in ('admin', 'member'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);