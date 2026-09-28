CREATE TABLE `cvs` (
	`id` integer PRIMARY KEY NOT NULL,
	`application_id` integer NOT NULL,
	`mode` text DEFAULT 'tailored' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`plan` text,
	`pdf_path` text,
	`pdf_hash` text,
	`note` text,
	`rendered_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cvs_application_id_unique` ON `cvs` (`application_id`);