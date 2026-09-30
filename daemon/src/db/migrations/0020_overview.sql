ALTER TABLE `applications` ADD `review_started_at` integer;--> statement-breakpoint
ALTER TABLE `applications` ADD `interview_at` integer;--> statement-breakpoint
ALTER TABLE `applications` ADD `offer_at` integer;--> statement-breakpoint
-- When applications first reached interview / offer, from the stage events kept so far (or the
-- last update when the event is gone).
UPDATE `applications` SET `interview_at` = COALESCE(
  (SELECT MIN(e.`at`) FROM `events` e WHERE e.`kind` = 'application.stage' AND e.`entity_id` = `applications`.`id` AND e.`stage` IN ('interview', 'offer')),
  CASE WHEN `stage` IN ('interview', 'offer') THEN `updated_at` END
);
--> statement-breakpoint
UPDATE `applications` SET `offer_at` = COALESCE(
  (SELECT MIN(e.`at`) FROM `events` e WHERE e.`kind` = 'application.stage' AND e.`entity_id` = `applications`.`id` AND e.`stage` = 'offer'),
  CASE WHEN `stage` = 'offer' THEN `updated_at` END
);
