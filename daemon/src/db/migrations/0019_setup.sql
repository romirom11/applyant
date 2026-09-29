CREATE TABLE `setup_steps` (
	`step` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
-- An install that already has knowledge, preferences or strategies was set up before the
-- onboarding existed: every step counts as done, so the setup isn't shown and search goes on.
INSERT INTO `setup_steps` (`step`, `state`)
SELECT s.step, 'done' FROM (
  SELECT 'connections' AS step UNION ALL SELECT 'import' UNION ALL SELECT 'preferences' UNION ALL SELECT 'interview'
) s
WHERE EXISTS (SELECT 1 FROM `sources`) OR EXISTS (SELECT 1 FROM `preferences`) OR EXISTS (SELECT 1 FROM `search_strategies`);
