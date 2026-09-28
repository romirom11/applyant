CREATE TABLE `search_runs` (
	`id` integer PRIMARY KEY NOT NULL,
	`strategy_id` integer NOT NULL,
	`trigger` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`started_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`finished_at` integer,
	`listed` integer DEFAULT 0 NOT NULL,
	`added` integer DEFAULT 0 NOT NULL,
	`results` text DEFAULT '[]' NOT NULL,
	`note` text,
	FOREIGN KEY (`strategy_id`) REFERENCES `search_strategies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `search_runs_strategy` ON `search_runs` (`strategy_id`);--> statement-breakpoint
CREATE TABLE `search_source_kinds` (
	`kind` text PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `search_sources` (
	`id` integer PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`locator` text NOT NULL,
	`label` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`origin` text DEFAULT 'candidate' NOT NULL,
	`resolved` text,
	`last_run_at` integer,
	`last_count` integer,
	`last_complete` integer,
	`last_note` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_sources_key_unique` ON `search_sources` (`key`);--> statement-breakpoint
CREATE TABLE `search_strategies` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`queries` text DEFAULT '[]' NOT NULL,
	`locations` text DEFAULT '[]' NOT NULL,
	`sources` text NOT NULL,
	`every_minutes` integer DEFAULT 360 NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`origin` text DEFAULT 'candidate' NOT NULL,
	`last_run_at` integer,
	`next_run_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_strategies_name_unique` ON `search_strategies` (`name`);--> statement-breakpoint
CREATE TABLE `strategy_postings` (
	`id` integer PRIMARY KEY NOT NULL,
	`strategy_id` integer NOT NULL,
	`posting_id` integer NOT NULL,
	`run_id` integer,
	`first_seen_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`strategy_id`) REFERENCES `search_strategies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`posting_id`) REFERENCES `postings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `strategy_postings_strategy_posting` ON `strategy_postings` (`strategy_id`,`posting_id`);--> statement-breakpoint
CREATE INDEX `strategy_postings_posting` ON `strategy_postings` (`posting_id`);--> statement-breakpoint
ALTER TABLE `posting_sources` ADD `search_source_id` integer REFERENCES search_sources(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `posting_sources` ADD `external_id` text;--> statement-breakpoint
ALTER TABLE `posting_sources` ADD `last_seen_at` integer;--> statement-breakpoint
ALTER TABLE `posting_sources` ADD `closed_at` integer;--> statement-breakpoint
CREATE INDEX `posting_sources_search_source` ON `posting_sources` (`search_source_id`);--> statement-breakpoint
ALTER TABLE `postings` ADD `ats_key` text;--> statement-breakpoint
ALTER TABLE `postings` ADD `minhash` text;--> statement-breakpoint
ALTER TABLE `postings` ADD `listing_text` text;--> statement-breakpoint
CREATE INDEX `postings_ats_key` ON `postings` (`ats_key`);