CREATE TABLE `receipts` (
	`id` integer PRIMARY KEY NOT NULL,
	`application_id` integer NOT NULL,
	`final_url` text NOT NULL,
	`confirmation_text` text,
	`confirmation_snapshot_path` text,
	`cv_path` text,
	`cv_hash` text,
	`salary_value` text,
	`field_values` text NOT NULL,
	`submitted_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_application_id_unique` ON `receipts` (`application_id`);