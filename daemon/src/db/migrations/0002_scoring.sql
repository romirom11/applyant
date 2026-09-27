CREATE TABLE `app_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fx_rates` (
	`currency` text PRIMARY KEY NOT NULL,
	`per_eur` real NOT NULL,
	`as_of` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `posting_feedback` (
	`id` integer PRIMARY KEY NOT NULL,
	`posting_id` integer NOT NULL,
	`kind` text NOT NULL,
	`reason` text,
	`component` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`posting_id`) REFERENCES `postings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `posting_feedback_posting` ON `posting_feedback` (`posting_id`);--> statement-breakpoint
CREATE TABLE `preferences` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `postings` ADD `text` text;--> statement-breakpoint
ALTER TABLE `postings` ADD `extraction` text;--> statement-breakpoint
ALTER TABLE `postings` ADD `extraction_key` text;--> statement-breakpoint
ALTER TABLE `postings` ADD `matches` text;--> statement-breakpoint
ALTER TABLE `postings` ADD `score` integer;--> statement-breakpoint
ALTER TABLE `postings` ADD `breakdown` text;--> statement-breakpoint
ALTER TABLE `postings` ADD `dealbreakers` text;--> statement-breakpoint
ALTER TABLE `postings` ADD `scored_at` integer;--> statement-breakpoint
ALTER TABLE `postings` ADD `score_note` text;--> statement-breakpoint
ALTER TABLE `postings` ADD `decision` text;--> statement-breakpoint
ALTER TABLE `postings` ADD `decision_reason` text;--> statement-breakpoint
ALTER TABLE `postings` ADD `decided_at` integer;