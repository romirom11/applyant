CREATE TABLE `interview_questions` (
	`id` integer PRIMARY KEY NOT NULL,
	`project_id` integer,
	`application_id` integer,
	`field_ref` text,
	`text` text NOT NULL,
	`context` text,
	`status` text DEFAULT 'open' NOT NULL,
	`origin` text NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`answered_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `interview_questions_status` ON `interview_questions` (`status`);--> statement-breakpoint
CREATE INDEX `interview_questions_project` ON `interview_questions` (`project_id`);--> statement-breakpoint
CREATE INDEX `interview_questions_application` ON `interview_questions` (`application_id`);--> statement-breakpoint
CREATE TABLE `interview_turns` (
	`id` integer PRIMARY KEY NOT NULL,
	`question_id` integer NOT NULL,
	`project_id` integer,
	`application_id` integer,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `interview_questions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `interview_turns_question` ON `interview_turns` (`question_id`);--> statement-breakpoint
CREATE INDEX `interview_turns_project` ON `interview_turns` (`project_id`);