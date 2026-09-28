CREATE TABLE `events` (
	`id` integer PRIMARY KEY NOT NULL,
	`at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`kind` text NOT NULL,
	`run_id` integer,
	`task_id` integer,
	`task_kind` text,
	`attempts` integer,
	`posting_id` integer,
	`stage` text,
	`entity_id` integer,
	`message` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_run` ON `events` (`run_id`);--> statement-breakpoint
CREATE INDEX `events_posting` ON `events` (`posting_id`);--> statement-breakpoint
CREATE INDEX `events_task` ON `events` (`task_id`);--> statement-breakpoint
CREATE TABLE `posting_sources` (
	`id` integer PRIMARY KEY NOT NULL,
	`posting_id` integer NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`first_seen_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`posting_id`) REFERENCES `postings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `posting_sources_posting_kind_url` ON `posting_sources` (`posting_id`,`kind`,`url`);--> statement-breakpoint
CREATE TABLE `postings` (
	`id` integer PRIMARY KEY NOT NULL,
	`stage` text NOT NULL,
	`canonical_url` text NOT NULL,
	`title` text,
	`company` text,
	`first_seen_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`verified_at` integer,
	`verify_note` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `postings_canonical_url_unique` ON `postings` (`canonical_url`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`entity_id` integer NOT NULL,
	`run_id` integer,
	`provider` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`run_after` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`note` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tasks_runnable` ON `tasks` (`status`,`run_after`);--> statement-breakpoint
CREATE INDEX `tasks_entity` ON `tasks` (`kind`,`entity_id`);--> statement-breakpoint
CREATE INDEX `tasks_run` ON `tasks` (`run_id`);