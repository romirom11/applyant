CREATE TABLE `agent_runs` (
	`id` integer PRIMARY KEY NOT NULL,
	`task_id` integer,
	`role` text NOT NULL,
	`provider` text NOT NULL,
	`model` text,
	`started_at` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`cost_usd` real,
	`outcome` text NOT NULL,
	`error` text,
	`log_path` text
);
--> statement-breakpoint
CREATE INDEX `agent_runs_task` ON `agent_runs` (`task_id`);--> statement-breakpoint
CREATE TABLE `evidence` (
	`id` integer PRIMARY KEY NOT NULL,
	`fact_id` integer NOT NULL,
	`source_id` integer,
	`locator` text,
	`excerpt` text,
	FOREIGN KEY (`fact_id`) REFERENCES `facts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `evidence_fact` ON `evidence` (`fact_id`);--> statement-breakpoint
CREATE INDEX `evidence_source` ON `evidence` (`source_id`);--> statement-breakpoint
CREATE TABLE `facts` (
	`id` integer PRIMARY KEY NOT NULL,
	`project_id` integer,
	`text` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`origin` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`edited_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `facts_project` ON `facts` (`project_id`);--> statement-breakpoint
CREATE INDEX `facts_status` ON `facts` (`status`);--> statement-breakpoint
CREATE TABLE `profile` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`summary` text,
	`role` text,
	`period` text,
	`stack` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_unique` ON `projects` (`slug`);--> statement-breakpoint
CREATE TABLE `provider_pauses` (
	`provider` text PRIMARY KEY NOT NULL,
	`until` integer NOT NULL,
	`reason` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` integer PRIMARY KEY NOT NULL,
	`project_id` integer,
	`kind` text NOT NULL,
	`locator` text NOT NULL,
	`last_synced_at` integer,
	`content_hash` text,
	`sync_note` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sources_project` ON `sources` (`project_id`);