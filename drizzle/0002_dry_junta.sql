ALTER TABLE `contacts` ADD `phone` varchar(40);--> statement-breakpoint
ALTER TABLE `contacts` ADD `social_url` varchar(1024);--> statement-breakpoint
ALTER TABLE `contacts` ADD `origin` varchar(32) DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `outreach_messages` ADD `channel` enum('email') DEFAULT 'email' NOT NULL;