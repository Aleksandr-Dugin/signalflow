CREATE TABLE `workspace_mailboxes` (
	`id` varchar(36) NOT NULL,
	`workspace_id` varchar(36) NOT NULL,
	`provider` enum('gmail','microsoft') NOT NULL,
	`email` varchar(320) NOT NULL,
	`status` enum('connected','gated','error') NOT NULL DEFAULT 'gated',
	`access_token_cipher` text,
	`refresh_token_cipher` text,
	`access_expires_at` timestamp,
	`scope` text,
	`from_name` varchar(200),
	`reply_to` varchar(320),
	`last_error` text,
	`last_inbound_cursor` varchar(191),
	`created_at` timestamp DEFAULT (now()),
	`updated_at` timestamp DEFAULT (now()),
	CONSTRAINT `workspace_mailboxes_id` PRIMARY KEY(`id`),
	CONSTRAINT `workspace_mailboxes_unique` UNIQUE(`workspace_id`,`email`)
);
--> statement-breakpoint
ALTER TABLE `workspace_mailboxes` ADD CONSTRAINT `workspace_mailboxes_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `mailbox_workspace_idx` ON `workspace_mailboxes` (`workspace_id`);