import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type EventRow, postings, tasks } from '../src/db/schema.ts';
import { EventBus } from '../src/queue/events.ts';
import { runInTx } from '../src/queue/tx.ts';
import type { Handler, HandlerContext, Outcome, Task, Tx } from '../src/queue/types.ts';
import { Worker, type WorkerOptions } from '../src/queue/worker.ts';
import { createLogger } from '../src/util/log.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { handlers, testDeps } from './helpers/deps.ts';

const log = createLogger({ test: 'queue' });
const noLog = { ...log, info() {}, warn() {}, error() {}, child: () => noLog };

class Clock {
  t = new Date('2026-09-27T10:00:00Z').getTime();
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe('queue worker', () => {
  let t: TempDb;
  let bus: EventBus;
  let clock: Clock;
  let published: EventRow[];
  const workers: Worker[] = [];

  beforeEach(() => {
    t = tempDb();
    bus = new EventBus();
    clock = new Clock();
    published = [];
    bus.subscribe((e) => published.push(e));
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop()));
    t.cleanup();
  });

  function worker(handler: Handler<'verify_posting'>, opts: Partial<WorkerOptions> = {}) {
    const w = new Worker({
      db: t.db,
      read: t.read,
      bus,
      deps: testDeps({ dir: t.dir }),
      handlers: handlers({ verify_posting: handler }),
      log: noLog,
      concurrency: 2,
      leaseMs: 60_000,
      pollMs: 10,
      maxAttempts: 3,
      backoffMs: (attempts) => attempts * 1_000,
      now: clock.now,
      ...opts,
    });
    workers.push(w);
    return w;
  }

  function addPosting(): { postingId: number; taskId: number } {
    return runInTx(t.db, bus, { now: clock.now() }, (tx) => {
      const p = tx.db
        .insert(postings)
        .values({ stage: 'found', canonicalUrl: `https://acme.test/jobs/${Math.random()}` })
        .returning()
        .get();
      return { postingId: p.id, taskId: tx.enqueue('verify_posting', p.id) };
    });
  }

  const taskRow = (id: number) => t.db.select().from(tasks).where(eq(tasks.id, id)).get();
  const postingRow = (id: number) => t.db.select().from(postings).where(eq(postings.id, id)).get();
  const kinds = (taskId: number) => published.filter((e) => e.taskId === taskId).map((e) => e.kind);

  const markVerified =
    (note: string): Handler<'verify_posting'> =>
    async (task) => ({
      kind: 'done',
      commit: (tx) => {
        tx.db
          .update(postings)
          .set({ stage: 'verified', verifyNote: note })
          .where(eq(postings.id, task.entityId))
          .run();
      },
    });

  it('applies the commit and marks the task done', async () => {
    const { postingId, taskId } = addPosting();
    const w = worker(markVerified('ok'));
    w.start();
    await w.idle();
    expect(postingRow(postingId)?.stage).toBe('verified');
    expect(taskRow(taskId)).toMatchObject({ status: 'done', leaseOwner: null, attempts: 0 });
    expect(kinds(taskId)).toEqual(['task.queued', 'task.started', 'task.done']);
  });

  it('hands the handler a read-only connection', async () => {
    const { taskId } = addPosting();
    let writeError: unknown = null;
    const w = worker(async (task, ctx: HandlerContext) => {
      try {
        ctx.read
          .update(postings)
          .set({ stage: 'verified' })
          .where(eq(postings.id, task.entityId))
          .run();
      } catch (err) {
        writeError = err;
      }
      return { kind: 'done', commit: () => {} };
    });
    w.start();
    await w.idle();
    expect(String(writeError)).toMatch(/readonly/);
    expect(taskRow(taskId)?.status).toBe('done');
  });

  it('discards the results when the lease was lost during the handler', async () => {
    const { postingId, taskId } = addPosting();
    const started = gate();
    const release = gate();
    const w = worker(async (task) => {
      started.open();
      await release.promise;
      return markVerified('should not land')(task, {} as HandlerContext);
    });
    w.start();
    await started.promise;
    // Another worker takes the task over (e.g. after our lease expired while we hung).
    t.db.update(tasks).set({ leaseOwner: 'other-worker' }).where(eq(tasks.id, taskId)).run();
    release.open();
    await w.idle();
    expect(postingRow(postingId)?.stage).toBe('found');
    expect(taskRow(taskId)).toMatchObject({ status: 'running', leaseOwner: 'other-worker' });
    expect(kinds(taskId)).toContain('task.lease_lost');
  });

  it('retries a failing handler with backoff and gives up after maxAttempts', async () => {
    const { postingId, taskId } = addPosting();
    let calls = 0;
    const w = worker(async () => {
      calls++;
      throw new Error(`boom ${calls}`);
    });
    w.start();
    await w.idle();
    expect(calls).toBe(1);
    let row = taskRow(taskId);
    expect(row).toMatchObject({ status: 'queued', attempts: 1, note: 'boom 1' });
    expect(row?.runAfter.getTime()).toBe(clock.t + 1_000);

    // Not runnable before the backoff has passed.
    clock.advance(999);
    await w.idle();
    expect(calls).toBe(1);

    clock.advance(1);
    await w.idle();
    expect(calls).toBe(2);
    row = taskRow(taskId);
    expect(row).toMatchObject({ status: 'queued', attempts: 2 });
    expect(row?.runAfter.getTime()).toBe(clock.t + 2_000);

    clock.advance(2_000);
    await w.idle();
    expect(calls).toBe(3);
    expect(taskRow(taskId)).toMatchObject({ status: 'failed', attempts: 3, note: 'boom 3' });
    expect(kinds(taskId)).toEqual([
      'task.queued',
      'task.started',
      'task.retry',
      'task.started',
      'task.retry',
      'task.started',
      'task.failed',
    ]);
    expect(postingRow(postingId)?.stage).toBe('found');
  });

  it('uses the retry time a handler asks for', async () => {
    const { taskId } = addPosting();
    const after = new Date(clock.t + 90_000);
    const w = worker(async () => ({ kind: 'retry', after, reason: 'HTTP 503' }));
    w.start();
    await w.idle();
    expect(taskRow(taskId)).toMatchObject({ status: 'queued', attempts: 1, runAfter: after });
  });

  it('requeues a provider pause at the reset time without spending an attempt', async () => {
    const { taskId } = addPosting();
    const until = new Date(clock.t + 3_600_000);
    const w = worker(async () => ({ kind: 'pause_provider', provider: 'claude', until }));
    w.start();
    await w.idle();
    expect(taskRow(taskId)).toMatchObject({ status: 'queued', attempts: 0, runAfter: until });
    expect(kinds(taskId)).toContain('task.provider_paused');
  });

  it('records needs_candidate with its hand-off and still applies the commit', async () => {
    const { postingId, taskId } = addPosting();
    const w = worker(async (task) => ({
      kind: 'needs_candidate',
      handOff: { reason: 'unknown required question', detail: null },
      commit: (tx) => {
        tx.db
          .update(postings)
          .set({ verifyNote: 'waiting for candidate' })
          .where(eq(postings.id, task.entityId))
          .run();
      },
    }));
    w.start();
    await w.idle();
    expect(taskRow(taskId)?.status).toBe('needs_candidate');
    expect(JSON.parse(taskRow(taskId)?.note ?? '{}')).toEqual({
      reason: 'unknown required question',
      detail: null,
    });
    expect(postingRow(postingId)?.verifyNote).toBe('waiting for candidate');
  });

  it('rejects an async commit and counts it as a failed attempt', async () => {
    const { postingId, taskId } = addPosting();
    const w = worker(
      async (task): Promise<Outcome> => ({
        kind: 'done',
        commit: (async (tx: Parameters<Extract<Outcome, { kind: 'done' }>['commit']>[0]) => {
          tx.db
            .update(postings)
            .set({ stage: 'verified' })
            .where(eq(postings.id, task.entityId))
            .run();
        }) as never,
      }),
    );
    w.start();
    await w.idle();
    expect(postingRow(postingId)?.stage).toBe('found');
    expect(taskRow(taskId)).toMatchObject({ status: 'queued', attempts: 1 });
    expect(taskRow(taskId)?.note).toMatch(/commit failed: commit must be synchronous/);
  });

  it('requeues a task whose owner crashed (expired lease) and runs it', async () => {
    const { postingId, taskId } = addPosting();
    t.db
      .update(tasks)
      .set({
        status: 'running',
        leaseOwner: 'crashed-worker',
        leaseExpiresAt: new Date(clock.t - 1),
      })
      .where(eq(tasks.id, taskId))
      .run();
    const seen: Task[] = [];
    const w = worker(async (task, ctx) => {
      seen.push(task);
      return markVerified('recovered')(task, ctx);
    });
    w.start();
    await w.idle();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.attempts).toBe(1);
    expect(postingRow(postingId)?.stage).toBe('verified');
    expect(taskRow(taskId)).toMatchObject({ status: 'done', attempts: 1 });
    expect(kinds(taskId)).toContain('task.requeued');
  });

  it('does not touch a running task whose lease is still valid', async () => {
    const { taskId } = addPosting();
    t.db
      .update(tasks)
      .set({ status: 'running', leaseOwner: 'alive', leaseExpiresAt: new Date(clock.t + 10_000) })
      .where(eq(tasks.id, taskId))
      .run();
    let calls = 0;
    const w = worker(async () => {
      calls++;
      return { kind: 'done', commit: () => {} };
    });
    w.start();
    await w.idle();
    expect(calls).toBe(0);
    expect(taskRow(taskId)).toMatchObject({ status: 'running', leaseOwner: 'alive' });
  });

  it('renews the lease while a slow handler runs, so no other worker takes it', async () => {
    const { taskId } = addPosting();
    let calls = 0;
    const slow: Handler<'verify_posting'> = async () => {
      calls++;
      // Real time passes; the lease clock follows it.
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 30));
        clock.advance(30);
      }
      return { kind: 'done', commit: () => {} };
    };
    const a = worker(slow, { leaseMs: 120 });
    const b = worker(slow, { leaseMs: 120 });
    a.start();
    b.start();
    await new Promise((r) => setTimeout(r, 50));
    await Promise.all([a.idle(), b.idle()]);
    expect(calls).toBe(1);
    expect(taskRow(taskId)).toMatchObject({ status: 'done', attempts: 0 });
  });

  it('keeps its own lease when the renew timer was late (the Mac slept mid-task)', async () => {
    const { taskId } = addPosting();
    const release = gate();
    let runs = 0;
    const w = worker(async () => {
      runs++;
      await release.promise;
      return { kind: 'done', commit: () => {} };
    });
    w.start();
    await new Promise((r) => setTimeout(r, 40));
    expect(runs).toBe(1);
    // The clock jumps past the lease while the handler is still running; a free slot polls.
    clock.advance(10 * 60_000);
    await new Promise((r) => setTimeout(r, 80));
    expect(runs).toBe(1);
    expect(taskRow(taskId)).toMatchObject({ status: 'running', leaseOwner: w.owner, attempts: 0 });
    release.open();
    await w.idle();
    expect(taskRow(taskId)).toMatchObject({ status: 'done', attempts: 0 });
    expect(kinds(taskId)).not.toContain('task.requeued');
  });

  it('records a marker during the handler, only while the lease is held', async () => {
    const { postingId, taskId } = addPosting();
    const seen: boolean[] = [];
    const mark = (note: string) => (tx: Tx) => {
      tx.db.update(postings).set({ verifyNote: note }).where(eq(postings.id, postingId)).run();
    };
    const w = worker(async (_task, ctx: HandlerContext) => {
      seen.push(ctx.record(mark('marked')));
      // Written at once, before the outcome's commit.
      expect(postingRow(postingId)?.verifyNote).toBe('marked');
      t.db.update(tasks).set({ leaseOwner: 'someone-else' }).where(eq(tasks.id, taskId)).run();
      seen.push(ctx.record(mark('too late')));
      return { kind: 'done', commit: () => {} };
    });
    w.start();
    await new Promise((r) => setTimeout(r, 60));
    expect(seen).toEqual([true, false]);
    expect(postingRow(postingId)?.verifyNote).toBe('marked');
  });

  it('releases in-flight tasks on shutdown without spending an attempt', async () => {
    const { taskId } = addPosting();
    const started = gate();
    const w = worker(async (_task, ctx) => {
      started.open();
      await new Promise((_, reject) =>
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)),
      );
      return { kind: 'done', commit: () => {} };
    });
    w.start();
    await started.promise;
    await w.stop();
    expect(taskRow(taskId)).toMatchObject({ status: 'queued', attempts: 0, leaseOwner: null });
  });

  it('wakes up as soon as a task is enqueued', async () => {
    const w = worker(markVerified('ok'), { pollMs: 60_000 });
    w.start();
    await new Promise((r) => setTimeout(r, 20));
    const { postingId } = addPosting();
    await new Promise((r) => setTimeout(r, 200));
    expect(postingRow(postingId)?.stage).toBe('verified');
  });
});
