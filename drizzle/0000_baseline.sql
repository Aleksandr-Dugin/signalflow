CREATE TABLE `ai_cache` (
	`key` varchar(64) NOT NULL,
	`value` json NOT NULL,
	`task` varchar(60) NOT NULL,
	`workspace_id` varchar(36),
	`expires_at` timestamp NOT NULL,
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `ai_cache_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `ai_runs` (
	`id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`campaign_id` varchar(36),
	`prospect_id` varchar(36),
	`task` varchar(60) NOT NULL,
	`provider` varchar(40) NOT NULL,
	`model` varchar(80),
	`status` enum('ok','error','cached') NOT NULL,
	`latency_ms` int,
	`prompt_tokens` int,
	`completion_tokens` int,
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `ai_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `billing_events` (
	`id` varchar(36) NOT NULL,
	`provider` varchar(40) NOT NULL,
	`event_type` varchar(80) NOT NULL,
	`provider_event_id` varchar(191) NOT NULL,
	`payload_hash` varchar(64),
	`processed_at` timestamp DEFAULT (now()),
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `billing_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `billing_events_unique` UNIQUE(`provider`,`event_type`,`provider_event_id`)
);
--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`icp_id` varchar(36),
	`name` varchar(200) NOT NULL,
	`offer_description` text NOT NULL DEFAULT (''),
	`target_description` text NOT NULL DEFAULT (''),
	`geography` text NOT NULL DEFAULT (''),
	`industry` varchar(200) NOT NULL DEFAULT '',
	`company_size` varchar(120) NOT NULL DEFAULT '',
	`signal_preferences` json,
	`prospect_target` int NOT NULL DEFAULT 10,
	`status` enum('draft','discovering','active','completed','partial','failed','archived') NOT NULL DEFAULT 'draft',
	`created_at` timestamp DEFAULT (now()),
	`updated_at` timestamp DEFAULT (now()),
	CONSTRAINT `campaigns_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `companies` (
	`id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`name` varchar(200) NOT NULL,
	`domain` varchar(255),
	`description` text,
	`website_url` varchar(1024),
	`industry` varchar(200),
	`size` varchar(120),
	`geography` varchar(200),
	`origin` enum('live','demo') NOT NULL DEFAULT 'live',
	`last_researched_at` timestamp,
	`created_at` timestamp DEFAULT (now()),
	`updated_at` timestamp DEFAULT (now()),
	CONSTRAINT `companies_id` PRIMARY KEY(`id`),
	CONSTRAINT `companies_workspace_domain_unique` UNIQUE(`workspace_id`,`domain`)
);
--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` varchar(36) NOT NULL,
	`company_id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`name` varchar(200) NOT NULL DEFAULT '',
	`title` varchar(200),
	`email` varchar(320),
	`verified` boolean NOT NULL DEFAULT false,
	`source_url` varchar(1024),
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `contacts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `email_events` (
	`id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`outreach_id` varchar(36),
	`prospect_id` varchar(36),
	`eventType` enum('sent','delivered','bounced','opened','clicked','replied','converted','unsubscribed','failed') NOT NULL,
	`direction` enum('outbound','inbound') NOT NULL DEFAULT 'outbound',
	`from_address` varchar(320),
	`to_address` varchar(320),
	`subject` varchar(500),
	`body_text` text,
	`classification` varchar(40),
	`dedupe_key` varchar(128),
	`metadata` json,
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `email_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `email_events_dedupe_unique` UNIQUE(`workspace_id`,`dedupe_key`)
);
--> statement-breakpoint
CREATE TABLE `icps` (
	`id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`source` enum('ai','manual','demo') NOT NULL DEFAULT 'manual',
	`criteria` json NOT NULL,
	`created_at` timestamp DEFAULT (now()),
	`updated_at` timestamp DEFAULT (now()),
	CONSTRAINT `icps_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`type` varchar(60) NOT NULL,
	`status` enum('queued','running','completed','failed') NOT NULL DEFAULT 'queued',
	`payload` json,
	`result` json,
	`error` text,
	`attempts` int NOT NULL DEFAULT 0,
	`run_after` timestamp DEFAULT (now()),
	`claimed_at` timestamp,
	`created_at` timestamp DEFAULT (now()),
	`updated_at` timestamp DEFAULT (now()),
	CONSTRAINT `job_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `oauth_accounts` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`provider` enum('google','github','email') NOT NULL,
	`provider_account_id` varchar(191) NOT NULL,
	`email` varchar(320),
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `oauth_accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `oauth_provider_unique` UNIQUE(`provider`,`provider_account_id`)
);
--> statement-breakpoint
CREATE TABLE `opportunities` (
	`id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`prospect_id` varchar(36) NOT NULL,
	`stage` enum('open','responded','meeting_booked','negotiating','won','lost') NOT NULL DEFAULT 'open',
	`value_cents` int NOT NULL DEFAULT 0,
	`notes` text,
	`source_reply_id` varchar(36),
	`created_at` timestamp DEFAULT (now()),
	`updated_at` timestamp DEFAULT (now()),
	CONSTRAINT `opportunities_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `outreach_messages` (
	`id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`prospect_id` varchar(36) NOT NULL,
	`recipient_email` varchar(320) NOT NULL,
	`recipient_name` varchar(200),
	`subject` varchar(500) NOT NULL DEFAULT '',
	`body` text NOT NULL DEFAULT (''),
	`status` enum('draft','approved','queued','sending','sent','delivered','bounced','replied','suppressed','failed','cancelled') NOT NULL DEFAULT 'draft',
	`personalization_id` varchar(36),
	`idempotency_key` varchar(64),
	`provider_message_id` varchar(255),
	`error` text,
	`reference_id` varchar(64),
	`approved_at` timestamp,
	`sent_at` timestamp,
	`created_at` timestamp DEFAULT (now()),
	`updated_at` timestamp DEFAULT (now()),
	CONSTRAINT `outreach_messages_id` PRIMARY KEY(`id`),
	CONSTRAINT `outreach_idempotency_unique` UNIQUE(`workspace_id`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`subscription_id` varchar(36),
	`provider` enum('platega','mock') NOT NULL DEFAULT 'mock',
	`provider_transaction_id` varchar(191),
	`amount_cents` int NOT NULL DEFAULT 0,
	`currency` varchar(8) NOT NULL DEFAULT 'USD',
	`status` enum('pending','succeeded','failed','refunded','chargeback') NOT NULL DEFAULT 'pending',
	`kind` enum('initial','recurring') NOT NULL DEFAULT 'initial',
	`raw_provider_reference` json,
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `payments_id` PRIMARY KEY(`id`),
	CONSTRAINT `payments_provider_tx_unique` UNIQUE(`provider`,`provider_transaction_id`)
);
--> statement-breakpoint
CREATE TABLE `personalizations` (
	`id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`prospect_id` varchar(36) NOT NULL,
	`subject` varchar(500) NOT NULL DEFAULT '',
	`opening_line` text NOT NULL DEFAULT (''),
	`body` text NOT NULL DEFAULT (''),
	`cta` text NOT NULL DEFAULT (''),
	`evidence` json,
	`provider` enum('groq','mock') NOT NULL DEFAULT 'groq',
	`cache_key` varchar(64),
	`approved_at` timestamp,
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `personalizations_id` PRIMARY KEY(`id`),
	CONSTRAINT `personalization_cache_unique` UNIQUE(`cache_key`)
);
--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`service_description` text NOT NULL DEFAULT (''),
	`target_market` text NOT NULL DEFAULT (''),
	`geography` text NOT NULL DEFAULT (''),
	`goals` text NOT NULL DEFAULT (''),
	`website_url` varchar(1024),
	`created_at` timestamp DEFAULT (now()),
	`updated_at` timestamp DEFAULT (now()),
	CONSTRAINT `profiles_id` PRIMARY KEY(`id`),
	CONSTRAINT `profiles_workspace_unique` UNIQUE(`workspace_id`)
);
--> statement-breakpoint
CREATE TABLE `prospects` (
	`id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`campaign_id` varchar(36) NOT NULL,
	`company_id` varchar(36) NOT NULL,
	`contact_id` varchar(36),
	`status` enum('new','qualified','disqualified','contacted','interested','not_interested','opportunity','suppressed','won','lost') NOT NULL DEFAULT 'new',
	`fit_score` int NOT NULL DEFAULT 0,
	`intent_score` int NOT NULL DEFAULT 0,
	`confidence` int NOT NULL DEFAULT 0,
	`overall_score` int NOT NULL DEFAULT 0,
	`reasons` json,
	`disqualifiers` json,
	`origin` enum('live','demo') NOT NULL DEFAULT 'live',
	`created_at` timestamp DEFAULT (now()),
	`updated_at` timestamp DEFAULT (now()),
	CONSTRAINT `prospects_id` PRIMARY KEY(`id`),
	CONSTRAINT `prospects_campaign_company_unique` UNIQUE(`campaign_id`,`company_id`)
);
--> statement-breakpoint
CREATE TABLE `research_results` (
	`id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`company_id` varchar(36) NOT NULL,
	`summary` text NOT NULL,
	`evidence` json NOT NULL,
	`confidence` int NOT NULL DEFAULT 0,
	`stale_after` timestamp,
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `research_results_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`user_agent` varchar(512),
	`ip` varchar(64),
	`expires_at` timestamp NOT NULL,
	`revoked_at` timestamp,
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `sessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `signals` (
	`id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`company_id` varchar(36) NOT NULL,
	`type` varchar(120) NOT NULL,
	`importance` int NOT NULL DEFAULT 50,
	`evidence` json NOT NULL,
	`source_url` varchar(1024) NOT NULL,
	`detected_at` timestamp NOT NULL DEFAULT (now()),
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `signals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`provider` enum('platega','mock') NOT NULL DEFAULT 'mock',
	`plan_id` enum('free','starter','pro','agency') NOT NULL DEFAULT 'free',
	`status` enum('incomplete','active','past_due','canceled','expired') NOT NULL DEFAULT 'incomplete',
	`provider_subscription_id` varchar(191),
	`currency` varchar(8) NOT NULL DEFAULT 'USD',
	`amount_cents` int NOT NULL DEFAULT 0,
	`interval` varchar(16) NOT NULL DEFAULT 'month',
	`current_period_start` timestamp,
	`current_period_end` timestamp,
	`cancel_at_period_end` boolean NOT NULL DEFAULT false,
	`canceled_at` timestamp,
	`created_at` timestamp DEFAULT (now()),
	`updated_at` timestamp DEFAULT (now()),
	CONSTRAINT `subscriptions_id` PRIMARY KEY(`id`),
	CONSTRAINT `subscriptions_workspace_unique` UNIQUE(`workspace_id`)
);
--> statement-breakpoint
CREATE TABLE `suppressions` (
	`id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`email` varchar(320),
	`domain` varchar(255),
	`reason` varchar(120) NOT NULL DEFAULT 'unsubscribe',
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `suppressions_id` PRIMARY KEY(`id`),
	CONSTRAINT `suppressions_email_unique` UNIQUE(`workspace_id`,`email`)
);
--> statement-breakpoint
CREATE TABLE `usage_events` (
	`id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`kind` varchar(60) NOT NULL,
	`quantity` int NOT NULL DEFAULT 1,
	`period` varchar(7) NOT NULL,
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `usage_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` varchar(36) NOT NULL,
	`email` varchar(320),
	`name` varchar(200) NOT NULL DEFAULT '',
	`password_hash` varchar(255),
	`avatar_url` varchar(1024),
	`role` enum('user','admin') NOT NULL DEFAULT 'user',
	`created_at` timestamp DEFAULT (now()),
	`updated_at` timestamp DEFAULT (now()),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `verifications` (
	`identifier` varchar(191) NOT NULL,
	`value` text NOT NULL,
	`expires_at` timestamp NOT NULL,
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `verifications_identifier_pk` PRIMARY KEY(`identifier`)
);
--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`role` enum('owner','member') NOT NULL DEFAULT 'member',
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `workspace_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `workspace_members_unique` UNIQUE(`workspace_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` varchar(36) NOT NULL,
	`name` varchar(200) NOT NULL,
	`slug` varchar(200) NOT NULL,
	`owner_id` varchar(36) NOT NULL,
	`plan_id` enum('free','starter','pro','agency') NOT NULL DEFAULT 'free',
	`autopilot` boolean NOT NULL DEFAULT false,
	`created_at` timestamp DEFAULT (now()),
	`updated_at` timestamp DEFAULT (now()),
	CONSTRAINT `workspaces_id` PRIMARY KEY(`id`),
	CONSTRAINT `workspaces_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
ALTER TABLE `ai_runs` ADD CONSTRAINT `ai_runs_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `campaigns` ADD CONSTRAINT `campaigns_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `campaigns` ADD CONSTRAINT `campaigns_icp_id_icps_id_fk` FOREIGN KEY (`icp_id`) REFERENCES `icps`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `companies` ADD CONSTRAINT `companies_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contacts` ADD CONSTRAINT `contacts_company_id_companies_id_fk` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contacts` ADD CONSTRAINT `contacts_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `email_events` ADD CONSTRAINT `email_events_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `email_events` ADD CONSTRAINT `email_events_outreach_id_outreach_messages_id_fk` FOREIGN KEY (`outreach_id`) REFERENCES `outreach_messages`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `email_events` ADD CONSTRAINT `email_events_prospect_id_prospects_id_fk` FOREIGN KEY (`prospect_id`) REFERENCES `prospects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `icps` ADD CONSTRAINT `icps_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `job_runs` ADD CONSTRAINT `job_runs_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `oauth_accounts` ADD CONSTRAINT `oauth_accounts_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `opportunities` ADD CONSTRAINT `opportunities_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `opportunities` ADD CONSTRAINT `opportunities_prospect_id_prospects_id_fk` FOREIGN KEY (`prospect_id`) REFERENCES `prospects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `outreach_messages` ADD CONSTRAINT `outreach_messages_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `outreach_messages` ADD CONSTRAINT `outreach_messages_prospect_id_prospects_id_fk` FOREIGN KEY (`prospect_id`) REFERENCES `prospects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `outreach_messages` ADD CONSTRAINT `outreach_messages_personalization_id_personalizations_id_fk` FOREIGN KEY (`personalization_id`) REFERENCES `personalizations`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_subscription_id_subscriptions_id_fk` FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `personalizations` ADD CONSTRAINT `personalizations_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `personalizations` ADD CONSTRAINT `personalizations_prospect_id_prospects_id_fk` FOREIGN KEY (`prospect_id`) REFERENCES `prospects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `profiles` ADD CONSTRAINT `profiles_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prospects` ADD CONSTRAINT `prospects_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prospects` ADD CONSTRAINT `prospects_campaign_id_campaigns_id_fk` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prospects` ADD CONSTRAINT `prospects_company_id_companies_id_fk` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prospects` ADD CONSTRAINT `prospects_contact_id_contacts_id_fk` FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `research_results` ADD CONSTRAINT `research_results_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `research_results` ADD CONSTRAINT `research_results_company_id_companies_id_fk` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `signals` ADD CONSTRAINT `signals_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `signals` ADD CONSTRAINT `signals_company_id_companies_id_fk` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `suppressions` ADD CONSTRAINT `suppressions_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `usage_events` ADD CONSTRAINT `usage_events_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_members` ADD CONSTRAINT `workspace_members_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_members` ADD CONSTRAINT `workspace_members_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaces` ADD CONSTRAINT `workspaces_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ai_cache_expires_idx` ON `ai_cache` (`expires_at`);--> statement-breakpoint
CREATE INDEX `ai_runs_workspace_idx` ON `ai_runs` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `ai_runs_created_idx` ON `ai_runs` (`created_at`);--> statement-breakpoint
CREATE INDEX `campaigns_workspace_idx` ON `campaigns` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `campaigns_icp_idx` ON `campaigns` (`icp_id`);--> statement-breakpoint
CREATE INDEX `companies_workspace_name_idx` ON `companies` (`workspace_id`,`name`);--> statement-breakpoint
CREATE INDEX `contacts_company_idx` ON `contacts` (`company_id`);--> statement-breakpoint
CREATE INDEX `contacts_email_idx` ON `contacts` (`email`);--> statement-breakpoint
CREATE INDEX `email_events_prospect_idx` ON `email_events` (`prospect_id`);--> statement-breakpoint
CREATE INDEX `icps_workspace_idx` ON `icps` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `job_runs_status_idx` ON `job_runs` (`status`,`run_after`);--> statement-breakpoint
CREATE INDEX `oauth_user_idx` ON `oauth_accounts` (`user_id`);--> statement-breakpoint
CREATE INDEX `opportunities_prospect_idx` ON `opportunities` (`prospect_id`);--> statement-breakpoint
CREATE INDEX `opportunities_workspace_idx` ON `opportunities` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `outreach_prospect_idx` ON `outreach_messages` (`prospect_id`);--> statement-breakpoint
CREATE INDEX `outreach_reference_idx` ON `outreach_messages` (`reference_id`);--> statement-breakpoint
CREATE INDEX `payments_workspace_idx` ON `payments` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `personalization_prospect_idx` ON `personalizations` (`prospect_id`);--> statement-breakpoint
CREATE INDEX `prospects_workspace_idx` ON `prospects` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `prospects_score_idx` ON `prospects` (`overall_score`);--> statement-breakpoint
CREATE INDEX `research_company_idx` ON `research_results` (`company_id`);--> statement-breakpoint
CREATE INDEX `research_workspace_idx` ON `research_results` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `session_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `session_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `signals_company_idx` ON `signals` (`company_id`);--> statement-breakpoint
CREATE INDEX `signals_workspace_idx` ON `signals` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_provider_idx` ON `subscriptions` (`provider_subscription_id`);--> statement-breakpoint
CREATE INDEX `usage_workspace_period_idx` ON `usage_events` (`workspace_id`,`kind`,`period`);