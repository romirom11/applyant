// Search through the real queue, with recorded list responses instead of the network.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asc, eq } from 'drizzle-orm';
import { postingSources, postings, searchRuns, searchSources, tasks } from '../../src/db/schema.ts';
import type { Deps } from '../../src/deps.ts';
import { searchHandler } from '../../src/domain/search/handlers.ts';
import type { Fetch } from '../../src/domain/search/readers/types.ts';
import { ensureBuiltinSources } from '../../src/domain/search/sources.ts';
import {
  addStrategy,
  requireStrategy,
  type StrategyInput,
  startSearchRun,
} from '../../src/domain/search/strategies.ts';
import type { Embedder } from '../../src/models/embeddings.ts';
import { EventBus } from '../../src/queue/events.ts';
import { runInTx } from '../../src/queue/tx.ts';
import type { Handler } from '../../src/queue/types.ts';
import { Worker } from '../../src/queue/worker.ts';
import type { TempDb } from './db.ts';
import { handlers, quietLog, testDeps } from './deps.ts';

const FIXTURES = fileURLToPath(new URL('../fixtures/search', import.meta.url));

export interface Reply {
  status?: number;
  body: string;
  contentType?: string;
}

export type RecordedFetch = Fetch & { calls: string[]; replies: Map<string, Reply> };

/** Serves test/fixtures/search/responses.json, plus `extra` (which wins); anything else is 404. */
export function recordedFetch(extra: Record<string, Reply | string | object> = {}): RecordedFetch {
  const replies = new Map<string, Reply>();
  const recorded = JSON.parse(readFileSync(join(FIXTURES, 'responses.json'), 'utf8')) as Array<{
    url: string;
    status: number;
    contentType: string;
    file: string;
  }>;
  for (const r of recorded) {
    replies.set(r.url, {
      status: r.status,
      contentType: r.contentType,
      body: readFileSync(join(FIXTURES, r.file), 'utf8'),
    });
  }
  const calls: string[] = [];
  const fetch = (async (url: string) => {
    calls.push(url);
    const reply = replies.get(url);
    if (!reply) return new Response('not found', { status: 404 });
    return new Response(reply.body, {
      status: reply.status ?? 200,
      headers: { 'content-type': reply.contentType ?? 'application/json' },
    });
  }) as RecordedFetch;
  fetch.calls = calls;
  fetch.replies = replies;
  const set = (url: string, value: Reply | string | object) => {
    if (typeof value === 'string') replies.set(url, { body: value, contentType: 'text/html' });
    else if ('body' in value && typeof (value as Reply).body === 'string')
      replies.set(url, value as Reply);
    else replies.set(url, { body: JSON.stringify(value), contentType: 'application/json' });
  };
  for (const [url, value] of Object.entries(extra)) set(url, value);
  return fetch;
}

export function fixture(file: string): string {
  return readFileSync(join(FIXTURES, file), 'utf8');
}

export function fixtureJson<T = Record<string, unknown>>(file: string): T {
  return JSON.parse(fixture(file)) as T;
}

const done: Handler<never> = async () => ({ kind: 'done', commit: () => {} });

export interface SearchHarness {
  bus: EventBus;
  worker: Worker;
  fetch: RecordedFetch;
  /** Adds a strategy (it runs right away) and waits for the run. Returns the run id. */
  run(input: StrategyInput): Promise<number>;
  /** Runs an existing strategy again and waits. */
  again(strategyId: number): Promise<number>;
  tasksOf(kind: string): Array<typeof tasks.$inferSelect>;
  posting(id: number): typeof postings.$inferSelect | undefined;
  links(postingId: number): Array<typeof postingSources.$inferSelect>;
  runRow(id: number): typeof searchRuns.$inferSelect | undefined;
  sourceId(key: string): number;
  stop(): Promise<void>;
}

/**
 * A worker with the real search handler; verify_posting (and anything downstream) only
 * records that it was asked for.
 */
export function searchHarness(
  t: TempDb,
  o: {
    fetch?: RecordedFetch;
    embedder?: Embedder;
    now?: () => Date;
    /** Extra deps (LinkedIn/Xing tests: the guardrails and a fake signed-in browser). */
    deps?: Partial<Deps>;
  } = {},
): SearchHarness {
  const bus = new EventBus();
  const fetch = o.fetch ?? recordedFetch();
  const now = o.now ?? (() => new Date());
  ensureBuiltinSources(t.db, now());
  const worker = new Worker({
    db: t.db,
    read: t.read,
    bus,
    handlers: handlers({
      search: searchHandler,
      verify_posting: done as Handler<'verify_posting'>,
    }),
    deps: {
      ...testDeps({ dir: t.dir, fetch, ...(o.embedder ? { embedder: o.embedder } : {}) }),
      ...o.deps,
    },
    log: quietLog,
    concurrency: 2,
    leaseMs: 60_000,
    pollMs: 10,
    maxAttempts: 3,
    now,
  });
  worker.start();
  const h: SearchHarness = {
    bus,
    worker,
    fetch,
    async run(input) {
      const res = runInTx(t.db, bus, { now: now() }, (tx) => addStrategy(tx, input));
      if (res.runId === null) throw new Error('no run started');
      await worker.idle();
      return res.runId;
    },
    async again(strategyId) {
      const runId = runInTx(t.db, bus, { now: now() }, (tx) =>
        startSearchRun(tx, requireStrategy(tx.db, strategyId), 'manual'),
      );
      if (runId === null) throw new Error('no run started');
      await worker.idle();
      return runId;
    },
    tasksOf: (kind) =>
      t.db.select().from(tasks).where(eq(tasks.kind, kind)).orderBy(asc(tasks.id)).all(),
    posting: (id) => t.db.select().from(postings).where(eq(postings.id, id)).get(),
    links: (id) => t.db.select().from(postingSources).where(eq(postingSources.postingId, id)).all(),
    runRow: (id) => t.db.select().from(searchRuns).where(eq(searchRuns.id, id)).get(),
    sourceId(key) {
      const row = t.db.select().from(searchSources).where(eq(searchSources.key, key)).get();
      if (!row) throw new Error(`no source ${key}`);
      return row.id;
    },
    stop: () => worker.stop(),
  };
  return h;
}
