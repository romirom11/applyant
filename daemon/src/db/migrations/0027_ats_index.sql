CREATE TABLE `ats_companies` (
	`id` integer PRIMARY KEY NOT NULL,
	`ats` text NOT NULL,
	`token` text NOT NULL,
	`name` text,
	`enabled` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`found_via` text NOT NULL,
	`found_note` text,
	`jobs` integer DEFAULT 0 NOT NULL,
	`matching` integer DEFAULT 0 NOT NULL,
	`fails` integer DEFAULT 0 NOT NULL,
	`last_read_at` integer,
	`next_read_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`last_note` text,
	`resolved` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ats_companies_board` ON `ats_companies` (`ats`,lower("token"));--> statement-breakpoint
CREATE INDEX `ats_companies_due` ON `ats_companies` (`ats`,`next_read_at`);--> statement-breakpoint
CREATE TABLE `ats_discoveries` (
	`id` integer PRIMARY KEY NOT NULL,
	`trigger` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`started_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`finished_at` integer,
	`found` integer DEFAULT 0 NOT NULL,
	`added` integer DEFAULT 0 NOT NULL,
	`note` text
);
--> statement-breakpoint
CREATE TABLE `ats_jobs` (
	`id` integer PRIMARY KEY NOT NULL,
	`company_id` integer NOT NULL,
	`key` text NOT NULL,
	`external_id` text,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`location` text,
	`remote` integer,
	`team` text,
	`posted_at` integer,
	`description` text,
	`matching` integer DEFAULT false NOT NULL,
	`first_seen_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`last_seen_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`company_id`) REFERENCES `ats_companies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ats_jobs_company_key` ON `ats_jobs` (`company_id`,`key`);--> statement-breakpoint
CREATE INDEX `ats_jobs_open` ON `ats_jobs` (`matching`,`company_id`) WHERE closed_at is null;
