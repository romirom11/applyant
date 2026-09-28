CREATE TABLE `listing_recipes` (
	`id` integer PRIMARY KEY NOT NULL,
	`source_id` integer NOT NULL,
	`recipe` text,
	`status` text NOT NULL,
	`fixture_url` text,
	`fixture_html` text,
	`expected` text,
	`last_count` integer,
	`built_at` integer,
	`last_sampled_at` integer,
	`last_build_at` integer,
	`builds` integer DEFAULT 0 NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `search_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `listing_recipes_source_id_unique` ON `listing_recipes` (`source_id`);--> statement-breakpoint
CREATE TABLE `role_routes` (
	`role` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `search_plans` (
	`id` integer PRIMARY KEY NOT NULL,
	`trigger` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`started_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`finished_at` integer,
	`strategies` text DEFAULT '[]' NOT NULL,
	`boards` text DEFAULT '[]' NOT NULL,
	`searches` text DEFAULT '[]' NOT NULL,
	`note` text
);
--> statement-breakpoint
ALTER TABLE `search_sources` ADD `note` text;