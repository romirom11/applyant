CREATE TABLE `platform_actions` (
	`id` integer PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`action` text NOT NULL,
	`task_id` integer,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `platform_actions_at` ON `platform_actions` (`platform`,`action`,`at`);--> statement-breakpoint
CREATE TABLE `platforms` (
	`platform` text PRIMARY KEY NOT NULL,
	`searches_per_day` integer,
	`applications_per_day` integer,
	`paused_at` integer,
	`pause_reason` text,
	`signed_in_at` integer,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
