CREATE TABLE `emails` (
	`id` integer PRIMARY KEY NOT NULL,
	`mailbox_id` integer NOT NULL,
	`message_key` text NOT NULL,
	`message_id` text,
	`in_reply_to` text,
	`from_address` text NOT NULL,
	`from_name` text,
	`subject` text NOT NULL,
	`text` text NOT NULL,
	`received_at` integer NOT NULL,
	`label` text NOT NULL,
	`confidence` real,
	`classified_by` text,
	`language` text,
	`application_id` integer,
	`status` text NOT NULL,
	`candidates` text NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `emails_mailbox_message_unique` ON `emails` (`mailbox_id`,`message_key`);--> statement-breakpoint
CREATE INDEX `emails_status_idx` ON `emails` (`status`);--> statement-breakpoint
CREATE INDEX `emails_application_idx` ON `emails` (`application_id`);--> statement-breakpoint
CREATE TABLE `mailboxes` (
	`id` integer PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`address` text NOT NULL,
	`settings` text NOT NULL,
	`status` text DEFAULT 'connected' NOT NULL,
	`cursor` text,
	`synced_at` integer,
	`note` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `receipts` ADD `message_id` text;