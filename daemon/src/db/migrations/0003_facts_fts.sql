-- Custom migration: keyword search over facts. External-content FTS5 table kept in step with
-- `facts` by triggers, so every write path (sync, confirm, edit, interview) is indexed.
-- Not in the Drizzle schema: `drizzle-kit generate` diffs snapshots and never sees it.
CREATE VIRTUAL TABLE `facts_fts` USING fts5(
	`text`,
	content='facts',
	content_rowid='id',
	tokenize='porter unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER `facts_fts_ai` AFTER INSERT ON `facts` BEGIN
	INSERT INTO `facts_fts`(rowid, `text`) VALUES (new.`id`, new.`text`);
END;
--> statement-breakpoint
CREATE TRIGGER `facts_fts_ad` AFTER DELETE ON `facts` BEGIN
	INSERT INTO `facts_fts`(`facts_fts`, rowid, `text`) VALUES ('delete', old.`id`, old.`text`);
END;
--> statement-breakpoint
CREATE TRIGGER `facts_fts_au` AFTER UPDATE OF `text` ON `facts` BEGIN
	INSERT INTO `facts_fts`(`facts_fts`, rowid, `text`) VALUES ('delete', old.`id`, old.`text`);
	INSERT INTO `facts_fts`(rowid, `text`) VALUES (new.`id`, new.`text`);
END;
--> statement-breakpoint
INSERT INTO `facts_fts`(`facts_fts`) VALUES ('rebuild');
