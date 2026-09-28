// Hybrid retrieval: BM25 over facts_fts and KNN over facts_vec, fused by rank. The FTS index
// and the vectors follow fact inserts, edits and deletes; the same query runs on the
// worker-thread pool.
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { directExec, ReadPool } from '../src/db/read-pool.ts';
import { type FactKind, type FactStatus, facts } from '../src/db/schema.ts';
import {
  embedFacts,
  enqueueEmbedFacts,
  ensureFactIndex,
  factsWithoutVectors,
} from '../src/domain/knowledge/embed-index.ts';
import { createProject } from '../src/domain/knowledge/projects.ts';
import { ftsQuery, retrieveFacts } from '../src/domain/knowledge/retrieve.ts';
import { EMBEDDING_DIMS, type Embedder } from '../src/models/embeddings.ts';
import { EventBus } from '../src/queue/events.ts';
import { runInTx } from '../src/queue/tx.ts';
import { Worker } from '../src/queue/worker.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { handlers, quietLog, testDeps } from './helpers/deps.ts';

/**
 * A stand-in for a semantic model: one dimension per concept, so "GKE with Helm" is close to
 * "Kubernetes" without sharing a word. Anything else lands on a noise dimension.
 */
const CONCEPTS: Array<[RegExp, number]> = [
  [/kubernetes|gke|helm|k8s|container orchestration/i, 0],
  [/python|django|fastapi/i, 1],
  [/greek|english|german/i, 2],
];

class ConceptEmbedder implements Embedder {
  readonly id = 'concepts-test';
  calls = 0;
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls++;
    return texts.map((t) => {
      const v = new Float32Array(EMBEDDING_DIMS);
      let hit = false;
      for (const [re, dim] of CONCEPTS) {
        if (re.test(t)) {
          v[dim] = 1;
          hit = true;
        }
      }
      // Deploy-heavy text drifts a little from the pure concept.
      if (/deployed|clusters/i.test(t)) v[3] = 0.4;
      if (!hit) v[4 + (t.length % 50)] = 1;
      const n = Math.hypot(...v);
      return v.map((x) => x / n);
    });
  }
}

describe('hybrid retrieval', () => {
  let t: TempDb;
  let bus: EventBus;
  let embedder: ConceptEmbedder;
  let worker: Worker;
  const now = new Date('2026-09-27T10:00:00Z');

  const addFact = (
    text: string,
    status: FactStatus = 'unconfirmed',
    kind: FactKind = 'skill',
    projectId: number | null = null,
  ) =>
    t.db
      .insert(facts)
      .values({
        text,
        kind,
        status,
        origin: 'extracted',
        projectId,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: facts.id })
      .get().id;

  beforeEach(() => {
    t = tempDb();
    bus = new EventBus();
    embedder = new ConceptEmbedder();
    worker = new Worker({
      db: t.db,
      read: t.read,
      bus,
      deps: testDeps({ dir: t.dir, db: t.db, embedder, read: t.read }),
      handlers: handlers({ embed_facts: embedFacts }),
      log: quietLog,
      concurrency: 1,
      leaseMs: 60_000,
      pollMs: 10,
      maxAttempts: 3,
    });
    worker.start();
  });

  afterEach(async () => {
    await worker.stop();
    t.cleanup();
  });

  const embedAll = async () => {
    runInTx(t.db, bus, { now }, (tx) => enqueueEmbedFacts(tx));
    await worker.idle();
  };

  const query = async (text: string, exec = directExec(t.read)) => {
    const [vector] = await embedder.embed([text]);
    return retrieveFacts(exec, { text, vector: vector ?? null }, 8);
  };

  it('ranks facts found by both keywords and meaning first, then either one', async () => {
    const project = createProject(t.db, { name: 'Solovei', period: '2021–2024' }, now);
    const both = addFact(
      'Deployed Kubernetes clusters in production for 3 years',
      'confirmed',
      'personal_contribution',
      project.id,
    );
    const meaning = addFact('Ran the services on GKE with Helm charts');
    const keyword = addFact('Wrote the postmortem for a production outage');
    const unrelated = addFact('Speaks Greek natively');
    const rejected = addFact('Kubernetes operator in production at Acme', 'rejected');
    await embedAll();
    expect(factsWithoutVectors(t.db, 10)).toEqual([]);

    const hits = await query('Kubernetes in production');
    const ids = hits.map((h) => h.id);
    // Found by both lists first; the fact that shares no word (GKE, Helm) is still found by
    // meaning; the unrelated fact comes last; rejected facts never.
    expect(ids[0]).toBe(both);
    expect(ids.slice(1, 3).sort()).toEqual([meaning, keyword].sort());
    expect(ids.at(-1)).toBe(unrelated);
    expect(ids).not.toContain(rejected);
    expect(hits[0]).toMatchObject({
      text: 'Deployed Kubernetes clusters in production for 3 years',
      status: 'confirmed',
      kind: 'personal_contribution',
      project: 'Solovei',
      period: '2021–2024',
    });

    // Keywords alone still work when there is no query vector.
    const keywordsOnly = await retrieveFacts(
      directExec(t.read),
      { text: 'production', vector: null },
      8,
    );
    expect(keywordsOnly.map((h) => h.id).sort()).toEqual([both, keyword].sort());
  });

  it('runs the same query on the worker-thread pool', async () => {
    addFact('Built the call-analysis pipeline in Python and FastAPI');
    addFact('Ran the services on GKE with Helm charts');
    addFact('Speaks Greek natively');
    await embedAll();
    const pool = new ReadPool({ path: `${t.dir}/applyant.db`, size: 2, log: quietLog });
    try {
      const [a, b] = await Promise.all([
        query('Python services', pool),
        query('Python services', pool),
      ]);
      expect(a).toEqual(await query('Python services'));
      expect(b).toEqual(a);
      await expect(pool.all(sql`select nope from nowhere`)).rejects.toThrow(/no such/);
    } finally {
      await pool.close();
    }
  });

  it('keeps the keyword index and vectors in step with fact edits and deletes', async () => {
    const id = addFact('Maintained the Kafka event bus');
    const other = addFact('Wrote Terraform modules');
    await embedAll();
    expect((await query('Kafka')).map((h) => h.id)).toContain(id);

    t.db
      .update(facts)
      .set({ text: 'Maintained the RabbitMQ message broker' })
      .where(eq(facts.id, id))
      .run();
    // The edit dropped the stale vector; the keyword index already has the new text.
    expect(factsWithoutVectors(t.db, 10).map((f) => f.id)).toEqual([id]);
    const kafka = await retrieveFacts(directExec(t.read), { text: 'Kafka', vector: null }, 8);
    expect(kafka).toEqual([]);
    const rabbit = await retrieveFacts(
      directExec(t.read),
      { text: 'rabbitmq broker', vector: null },
      8,
    );
    expect(rabbit.map((h) => h.id)).toEqual([id]);
    await embedAll();
    expect(factsWithoutVectors(t.db, 10)).toEqual([]);

    t.db.delete(facts).where(eq(facts.id, other)).run();
    const rows = t.db.all<{ n: number }>(sql`select count(*) as n from facts_vec`);
    expect(rows[0]?.n).toBe(1);
    expect(await retrieveFacts(directExec(t.read), { text: 'terraform', vector: null }, 8)).toEqual(
      [],
    );
  });

  it('drops vectors made by another embedder and re-embeds at start', async () => {
    addFact('Built the call-analysis pipeline in Python');
    ensureFactIndex(t.db, bus, 'concepts-test', now);
    await worker.idle();
    expect(factsWithoutVectors(t.db, 10)).toHaveLength(0);
    const calls = embedder.calls;
    // Same embedder: nothing to do.
    ensureFactIndex(t.db, bus, 'concepts-test', now);
    await worker.idle();
    expect(embedder.calls).toBe(calls);
    // Another embedder's vectors aren't comparable: dropped and made again.
    ensureFactIndex(t.db, bus, 'another-model', now);
    expect(factsWithoutVectors(t.db, 10)).toHaveLength(1);
    await worker.idle();
    expect(factsWithoutVectors(t.db, 10)).toHaveLength(0);
    expect(embedder.calls).toBe(calls + 1);
  });

  it('builds safe FTS queries from free text', () => {
    expect(ftsQuery('5+ years of Python in production')).toBe('"5+" OR "python" OR "production"');
    expect(ftsQuery('C++, C#, Node.js and "quotes"')).toBe(
      '"c++" OR "c#" OR "node.js" OR "quotes"',
    );
    expect(ftsQuery('Досвід з Kubernetes')).toBe('"досвід" OR "kubernetes"');
    expect(ftsQuery('experience with the')).toBeNull();
  });
});
