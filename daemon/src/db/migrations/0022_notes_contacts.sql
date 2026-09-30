CREATE TABLE `application_contacts` (
	`id` integer PRIMARY KEY NOT NULL,
	`application_id` integer NOT NULL,
	`name` text,
	`role` text,
	`email` text,
	`linkedin` text,
	`note` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `application_contacts_app` ON `application_contacts` (`application_id`);--> statement-breakpoint
ALTER TABLE `applications` ADD `notes` text;