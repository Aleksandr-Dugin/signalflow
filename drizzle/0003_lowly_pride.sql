CREATE TABLE `channel_identities` (
	`id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`prospect_id` varchar(36) NOT NULL,
	`channel` enum('telegram','whatsapp') NOT NULL,
	`external_id` varchar(128) NOT NULL,
	`handle` varchar(320),
	`consent_source` varchar(64) NOT NULL,
	`consent_at` timestamp NOT NULL,
	`revoked_at` timestamp,
	`last_inbound_at` timestamp,
	`created_at` timestamp DEFAULT (now()),
	`updated_at` timestamp DEFAULT (now()),
	CONSTRAINT `channel_identities_id` PRIMARY KEY(`id`),
	CONSTRAINT `channel_identity_unique` UNIQUE(`workspace_id`,`channel`,`external_id`)
);
--> statement-breakpoint
ALTER TABLE `outreach_messages` MODIFY COLUMN `channel` enum('email','telegram','whatsapp') NOT NULL DEFAULT 'email';--> statement-breakpoint
ALTER TABLE `channel_identities` ADD CONSTRAINT `channel_identities_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `channel_identities` ADD CONSTRAINT `channel_identities_prospect_id_prospects_id_fk` FOREIGN KEY (`prospect_id`) REFERENCES `prospects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `channel_identity_prospect_idx` ON `channel_identities` (`prospect_id`);