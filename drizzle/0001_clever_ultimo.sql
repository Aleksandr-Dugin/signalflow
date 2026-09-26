CREATE TABLE `system_state` (
	`id` varchar(36) NOT NULL,
	`autopilot_paused` boolean NOT NULL DEFAULT false,
	`paused_reason` varchar(300) NOT NULL DEFAULT '',
	`paused_by` varchar(36),
	`paused_at` timestamp,
	`created_at` timestamp DEFAULT (now()),
	`updated_at` timestamp DEFAULT (now()),
	CONSTRAINT `system_state_id` PRIMARY KEY(`id`)
);
