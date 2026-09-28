-- Custom migration: fact embeddings (EmbeddingGemma-300M, Matryoshka-truncated to 256 dims).
-- Rows are written by the embed_facts task, because embeddings are computed in JS. A fact
-- whose text changes, or that is deleted, loses its vector here, so a stale vector never
-- survives; embed_facts fills in whatever is missing. Every connection loads sqlite-vec.
-- (vec0 column definitions can't be quoted.)
CREATE VIRTUAL TABLE `facts_vec` USING vec0(
	fact_id integer primary key,
	embedding float[256] distance_metric=cosine
);
--> statement-breakpoint
CREATE TRIGGER `facts_vec_ad` AFTER DELETE ON `facts` BEGIN
	DELETE FROM `facts_vec` WHERE `fact_id` = old.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `facts_vec_au` AFTER UPDATE OF `text` ON `facts` WHEN old.`text` IS NOT new.`text` BEGIN
	DELETE FROM `facts_vec` WHERE `fact_id` = old.`id`;
END;
