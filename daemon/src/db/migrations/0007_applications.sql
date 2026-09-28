CREATE TABLE `answer_sentences` (
	`id` integer PRIMARY KEY NOT NULL,
	`answer_id` integer NOT NULL,
	`idx` integer NOT NULL,
	`text` text NOT NULL,
	`fact_ids_json` text NOT NULL,
	`flag` text DEFAULT 'unchecked' NOT NULL,
	`note` text,
	FOREIGN KEY (`answer_id`) REFERENCES `answers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `answer_sentences_answer_idx` ON `answer_sentences` (`answer_id`,`idx`);--> statement-breakpoint
CREATE TABLE `answers` (
	`id` integer PRIMARY KEY NOT NULL,
	`application_id` integer NOT NULL,
	`question_ref` text NOT NULL,
	`question` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`choice` text,
	`missing` text,
	`adapted_from` text,
	`edited` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `answers_app_question` ON `answers` (`application_id`,`question_ref`);--> statement-breakpoint
CREATE TABLE `applications` (
	`id` integer PRIMARY KEY NOT NULL,
	`posting_id` integer NOT NULL,
	`stage` text NOT NULL,
	`channel` text DEFAULT 'web_form' NOT NULL,
	`note` text,
	`fields_form_at` integer,
	`refresh_fields` integer DEFAULT true NOT NULL,
	`rewrite_answers` integer DEFAULT false NOT NULL,
	`prepared_at` integer,
	`approved_at` integer,
	`applied_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`posting_id`) REFERENCES `postings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `applications_posting_id_unique` ON `applications` (`posting_id`);--> statement-breakpoint
CREATE TABLE `field_values` (
	`id` integer PRIMARY KEY NOT NULL,
	`application_id` integer NOT NULL,
	`field_ref` text NOT NULL,
	`position` integer NOT NULL,
	`spec` text NOT NULL,
	`value` text,
	`source` text NOT NULL,
	`default_value` text,
	`default_source` text NOT NULL,
	`note` text,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `field_values_app_ref` ON `field_values` (`application_id`,`field_ref`);