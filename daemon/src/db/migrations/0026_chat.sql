CREATE TABLE `chat_messages` (
	`id` integer PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`fact_ids` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
