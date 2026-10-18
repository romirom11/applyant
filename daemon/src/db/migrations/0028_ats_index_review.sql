ALTER TABLE `ats_discoveries` ADD `progress` text;--> statement-breakpoint
CREATE INDEX `ats_jobs_url` ON `ats_jobs` (`url`);