// embed_facts: keeps facts_vec in step with facts. Triggers drop a fact's vector when its
// text changes or it is deleted; this task embeds whatever has no vector, a batch at a time.
//
//   slow phase:  facts without a vector → embedder (in-process ONNX)
//   commit:      vectors for facts whose text is still what was embedded · next batch
import { and, eq, sql } from 'drizzle-orm';
import type { Conn, Db } from '../../db/client.ts';
import { appState, facts, tasks } from '../../db/schema.ts';
import { vectorBlob } from '../../models/embeddings.ts';
import type { EventBus } from '../../queue/events.ts';
import { runInTx } from '../../queue/tx.ts';
import type { Handler, Tx } from '../../queue/types.ts';

export const EMBED_BATCH = 128;
/** A failing embedder (no network for the first model download) is retried this often. */
export const EMBED_ATTEMPTS = 4;

export function factsWithoutVectors(
  conn: Conn,
  limit: number,
): Array<{ id: number; text: string }> {
  return conn.all<{ id: number; text: string }>(sql`
    SELECT f.id AS id, f.text AS text FROM facts f
    WHERE f.status <> 'rejected'
      AND NOT EXISTS (SELECT 1 FROM facts_vec v WHERE v.fact_id = f.id)
    ORDER BY f.id
    LIMIT ${limit}
  `);
}

/** Enqueues embed_facts unless one is already waiting. */
export function enqueueEmbedFacts(tx: Tx): void {
  const waiting = tx.db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.kind, 'embed_facts'), eq(tasks.status, 'queued')))
    .get();
  if (!waiting) tx.enqueue('embed_facts', 0, { runId: null });
}

export const embedFacts: Handler<'embed_facts'> = async (task, ctx) => {
  const batch = factsWithoutVectors(ctx.read, EMBED_BATCH + 1);
  const more = batch.length > EMBED_BATCH;
  const todo = batch.slice(0, EMBED_BATCH);
  if (todo.length === 0) return { kind: 'done', commit: () => {} };

  ctx.progress({ message: `embedding ${todo.length} facts` });
  let vectors: Float32Array[];
  try {
    vectors = await ctx.deps.embedder.embed(
      todo.map((f) => f.text),
      'document',
      ctx.signal,
    );
  } catch (err) {
    ctx.signal.throwIfAborted();
    const reason = `embedding failed: ${(err as Error).message}`;
    if (task.attempts + 1 < EMBED_ATTEMPTS) {
      return {
        kind: 'retry',
        after: new Date(ctx.now().getTime() + 60_000 * 2 ** task.attempts),
        reason,
      };
    }
    // Retrieval still works on keywords alone; the next fact change tries again.
    ctx.deps.log.warn('fact embeddings unavailable', { reason });
    return { kind: 'done', commit: () => {} };
  }

  return {
    kind: 'done',
    commit: (tx) => {
      let stored = 0;
      todo.forEach((f, i) => {
        const vector = vectors[i];
        if (!vector) return;
        // The text may have changed since it was read; then the trigger already dropped the
        // vector and the fact is picked up again below.
        const current = tx.db
          .select({ text: facts.text })
          .from(facts)
          .where(eq(facts.id, f.id))
          .get();
        if (current?.text !== f.text) return;
        tx.db.run(sql`DELETE FROM facts_vec WHERE fact_id = ${f.id}`);
        tx.db.run(
          sql`INSERT INTO facts_vec(fact_id, embedding) VALUES (CAST(${f.id} AS INTEGER), ${vectorBlob(vector)})`,
        );
        stored++;
      });
      if (more || stored < todo.length) enqueueEmbedFacts(tx);
    },
  };
};

const EMBEDDER_KEY = 'fact_vectors_embedder';

/**
 * At start: vectors made by a different embedder are not comparable, so they are dropped;
 * then anything without a vector is queued for embedding.
 */
export function ensureFactIndex(db: Db, bus: EventBus, embedderId: string, now: Date): void {
  runInTx(db, bus, { now }, (tx) => {
    const row = tx.db.select().from(appState).where(eq(appState.key, EMBEDDER_KEY)).get();
    if (row?.value !== embedderId) {
      tx.db.run(sql`DELETE FROM facts_vec`);
      tx.db
        .insert(appState)
        .values({ key: EMBEDDER_KEY, value: embedderId })
        .onConflictDoUpdate({ target: appState.key, set: { value: embedderId } })
        .run();
    }
    if (factsWithoutVectors(tx.db, 1).length) enqueueEmbedFacts(tx);
  });
}
