// The lease-based worker.
//
//   tx1 (ms):   requeue expired leases · lease the oldest runnable task whose provider
//               isn't paused by a subscription limit
//   handler:    runs with NO transaction open, lease renewed in the background
//   tx2 (ms):   stillLeased? → apply the Outcome (commit, stage moves, next tasks)
//               lease lost ⇒ the handler's results are discarded
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { and, asc, eq, gt, isNull, lt, lte, notInArray, or } from 'drizzle-orm';
import type { Db, ReadDb } from '../db/client.ts';
import { providerPauses, type TaskRow, tasks } from '../db/schema.ts';
import type { Deps } from '../deps.ts';
import type { Logger } from '../util/log.ts';
import type { EventBus, EventInput } from './events.ts';
import { runInTx } from './tx.ts';
import {
  type Handler,
  type Handlers,
  isTaskKind,
  type Outcome,
  TASK_ENTITY,
  type Task,
  type TaskKind,
  type Tx,
} from './types.ts';

export interface WorkerOptions {
  db: Db;
  read: ReadDb;
  bus: EventBus;
  handlers: Handlers;
  deps: Deps;
  log: Logger;
  concurrency: number;
  leaseMs: number;
  pollMs: number;
  /** A task that has failed this many times is marked failed. */
  maxAttempts: number;
  /** Delay before retrying a task that threw, given its new attempt count. */
  backoffMs?: (attempts: number) => number;
  owner?: string;
  now?: () => Date;
}

export const defaultBackoffMs = (attempts: number): number =>
  Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);

class ShutdownError extends Error {
  constructor() {
    super('worker is shutting down');
    this.name = 'ShutdownError';
  }
}

class LeaseLostError extends Error {
  constructor() {
    super('lease lost');
    this.name = 'LeaseLostError';
  }
}

export class Worker {
  readonly owner: string;
  private readonly o: WorkerOptions;
  private readonly now: () => Date;
  private readonly backoffMs: (attempts: number) => number;
  private readonly inFlight = new Map<number, { promise: Promise<void>; ac: AbortController }>();
  private running = false;
  private loopDone: Promise<void> | null = null;
  private wakeUp: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly idleWaiters: Array<() => void> = [];

  constructor(options: WorkerOptions) {
    this.o = options;
    this.now = options.now ?? (() => new Date());
    this.backoffMs = options.backoffMs ?? defaultBackoffMs;
    this.owner = options.owner ?? `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.unsubscribe = this.o.bus.onTasksEnqueued(() => this.wake());
    this.loopDone = this.loop();
  }

  /** Stops leasing, aborts in-flight handlers and releases their leases without spending attempts. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.unsubscribe?.();
    this.wake();
    for (const { ac } of this.inFlight.values()) ac.abort(new ShutdownError());
    await Promise.allSettled([...this.inFlight.values()].map((f) => f.promise));
    await this.loopDone;
  }

  /** Resolves once nothing is runnable now and nothing is in flight (for tests). */
  idle(): Promise<void> {
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
      this.wake();
    });
  }

  private wake(): void {
    const w = this.wakeUp;
    this.wakeUp = null;
    w?.();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let leased = false;
      while (this.running && this.inFlight.size < this.o.concurrency) {
        let row: TaskRow | null;
        try {
          row = this.lease();
        } catch (err) {
          this.o.log.error('lease failed', { err });
          break;
        }
        if (!row) break;
        leased = true;
        this.spawn(row);
      }
      if (!leased && this.inFlight.size === 0) {
        for (const resolve of this.idleWaiters.splice(0)) resolve();
      }
      if (!this.running) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.o.pollMs);
        this.wakeUp = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  private emitTask(
    tx: Tx,
    row: Pick<TaskRow, 'id' | 'kind' | 'entityId' | 'runId'>,
    e: EventInput,
  ) {
    tx.emit({
      runId: row.runId,
      taskId: row.id,
      taskKind: row.kind,
      entityId: row.entityId,
      postingId: isTaskKind(row.kind) && TASK_ENTITY[row.kind] === 'posting' ? row.entityId : null,
      ...e,
    });
  }

  /** tx1: requeue expired leases, then lease the oldest runnable task of an unpaused provider. */
  private lease(): TaskRow | null {
    const now = this.now();
    return runInTx(this.o.db, this.o.bus, { now }, (tx) => {
      const expired = tx.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.status, 'running'), lt(tasks.leaseExpiresAt, now)))
        .all();
      for (const row of expired) {
        // Our own handler is still running it: the renew timer just didn't get to fire in time
        // (the Mac slept, the event loop was busy). Keep the lease instead of running the task
        // a second time next to itself.
        if (row.leaseOwner === this.owner && this.inFlight.has(row.id)) {
          tx.db
            .update(tasks)
            .set({ leaseExpiresAt: new Date(now.getTime() + this.o.leaseMs), updatedAt: now })
            .where(eq(tasks.id, row.id))
            .run();
          continue;
        }
        // The previous owner crashed or hung; the lost run counts as an attempt.
        const attempts = row.attempts + 1;
        const failed = attempts >= this.o.maxAttempts;
        tx.db
          .update(tasks)
          .set({
            status: failed ? 'failed' : 'queued',
            attempts,
            leaseOwner: null,
            leaseExpiresAt: null,
            note: `lease of ${row.leaseOwner} expired`,
            updatedAt: now,
          })
          .where(eq(tasks.id, row.id))
          .run();
        this.emitTask(tx, row, {
          kind: failed ? 'task.failed' : 'task.requeued',
          attempts,
          message: `lease of ${row.leaseOwner} expired`,
        });
      }

      // Providers paused by a subscription limit: their tasks wait, everything else runs.
      const paused = tx.db
        .select({ provider: providerPauses.provider })
        .from(providerPauses)
        .where(gt(providerPauses.until, now))
        .all()
        .map((p) => p.provider);
      const runnable = and(
        eq(tasks.status, 'queued'),
        lte(tasks.runAfter, now),
        paused.length ? or(isNull(tasks.provider), notInArray(tasks.provider, paused)) : undefined,
      );

      for (;;) {
        const next = tx.db
          .select()
          .from(tasks)
          .where(runnable)
          .orderBy(asc(tasks.runAfter), asc(tasks.id))
          .limit(1)
          .get();
        if (!next) return null;
        if (!isTaskKind(next.kind)) {
          tx.db
            .update(tasks)
            .set({ status: 'failed', note: `no handler for "${next.kind}"`, updatedAt: now })
            .where(eq(tasks.id, next.id))
            .run();
          this.emitTask(tx, next, {
            kind: 'task.failed',
            message: `no handler for "${next.kind}"`,
          });
          continue;
        }
        const leased = tx.db
          .update(tasks)
          .set({
            status: 'running',
            leaseOwner: this.owner,
            leaseExpiresAt: new Date(now.getTime() + this.o.leaseMs),
            updatedAt: now,
          })
          .where(and(eq(tasks.id, next.id), eq(tasks.status, 'queued')))
          .returning()
          .get();
        if (!leased) return null;
        this.emitTask(tx, leased, {
          kind: 'task.started',
          attempts: leased.attempts,
          message: leased.attempts > 0 ? `attempt ${leased.attempts + 1}` : '',
        });
        return leased;
      }
    });
  }

  private spawn(row: TaskRow): void {
    const ac = new AbortController();
    const promise = this.execute(row, ac)
      .catch((err) => this.o.log.error('task bookkeeping failed', { taskId: row.id, err }))
      .finally(() => {
        this.inFlight.delete(row.id);
        this.wake();
      });
    this.inFlight.set(row.id, { promise, ac });
  }

  private renewLease(id: number): boolean {
    const now = this.now();
    const res = this.o.db
      .update(tasks)
      .set({ leaseExpiresAt: new Date(now.getTime() + this.o.leaseMs), updatedAt: now })
      .where(and(eq(tasks.id, id), eq(tasks.leaseOwner, this.owner), eq(tasks.status, 'running')))
      .run();
    return res.changes === 1;
  }

  private async execute(row: TaskRow, ac: AbortController): Promise<void> {
    const kind = row.kind as TaskKind;
    const task: Task = {
      id: row.id,
      kind,
      entityId: row.entityId,
      runId: row.runId,
      provider: row.provider,
      attempts: row.attempts,
    };
    const log = this.o.log.child({ taskId: row.id, kind });

    const renew = setInterval(
      () => {
        try {
          if (!this.renewLease(row.id)) ac.abort(new LeaseLostError());
        } catch (err) {
          log.warn('lease renewal failed', { err });
        }
      },
      Math.max(20, Math.floor(this.o.leaseMs / 3)),
    );

    let outcome: Outcome;
    try {
      const handler = this.o.handlers[kind] as Handler<TaskKind>;
      outcome = await handler(task, {
        deps: this.o.deps,
        read: this.o.read,
        signal: ac.signal,
        now: this.now,
        progress: (e) => this.progress(row, e.message),
        record: (write) => this.record(row, write),
      });
    } catch (err) {
      if (ac.signal.reason instanceof ShutdownError) {
        clearInterval(renew);
        this.release(row);
        return;
      }
      const attempts = task.attempts + 1;
      outcome = {
        kind: 'retry',
        after: new Date(this.now().getTime() + this.backoffMs(attempts)),
        reason: errorMessage(err),
      };
      log.warn('handler failed', { err });
    } finally {
      clearInterval(renew);
    }

    if (ac.signal.reason instanceof ShutdownError && outcome.kind === 'retry') {
      this.release(row);
      return;
    }

    try {
      this.finish(row, outcome);
    } catch (err) {
      // The commit threw, so tx2 rolled back. Count it as a failed attempt.
      log.error('commit failed', { err });
      const attempts = task.attempts + 1;
      this.finish(row, {
        kind: 'retry',
        after: new Date(this.now().getTime() + this.backoffMs(attempts)),
        reason: `commit failed: ${errorMessage(err)}`,
      });
    }
  }

  /** tx2: apply the outcome only while the lease is still ours. */
  private finish(row: TaskRow, outcome: Outcome): void {
    const now = this.now();
    runInTx(this.o.db, this.o.bus, { now, runId: row.runId }, (tx) => {
      const current = tx.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(eq(tasks.id, row.id), eq(tasks.leaseOwner, this.owner), eq(tasks.status, 'running')),
        )
        .get();
      if (!current) {
        this.emitTask(tx, row, {
          kind: 'task.lease_lost',
          message: 'lease lost; results discarded',
        });
        return;
      }
      const settle = (
        status: TaskRow['status'],
        fields: Partial<Pick<TaskRow, 'attempts' | 'runAfter' | 'note'>> = {},
      ) => {
        tx.db
          .update(tasks)
          .set({ status, leaseOwner: null, leaseExpiresAt: null, updatedAt: now, ...fields })
          .where(eq(tasks.id, row.id))
          .run();
      };
      switch (outcome.kind) {
        case 'done': {
          applyCommit(outcome.commit, tx);
          settle('done', { note: null });
          this.emitTask(tx, row, { kind: 'task.done', attempts: row.attempts });
          break;
        }
        case 'needs_candidate': {
          applyCommit(outcome.commit, tx);
          settle('needs_candidate', { note: JSON.stringify(outcome.handOff) });
          this.emitTask(tx, row, {
            kind: 'task.needs_candidate',
            attempts: row.attempts,
            message: outcome.handOff.reason,
          });
          break;
        }
        case 'retry': {
          const attempts = row.attempts + 1;
          if (attempts >= this.o.maxAttempts) {
            settle('failed', { attempts, note: outcome.reason });
            this.emitTask(tx, row, {
              kind: 'task.failed',
              attempts,
              message: `gave up after ${attempts} attempts: ${outcome.reason}`,
            });
          } else {
            settle('queued', { attempts, runAfter: outcome.after, note: outcome.reason });
            this.emitTask(tx, row, {
              kind: 'task.retry',
              attempts,
              message: `retry at ${outcome.after.toISOString()}: ${outcome.reason}`,
            });
          }
          break;
        }
        case 'pause_provider': {
          // A subscription limit is not a failure: attempts stay as they were. The whole
          // provider pauses, so its other queued tasks aren't leased just to hit the limit.
          tx.db
            .insert(providerPauses)
            .values({ provider: outcome.provider, until: outcome.until, reason: 'limit' })
            .onConflictDoUpdate({
              target: providerPauses.provider,
              set: { until: outcome.until, reason: 'limit' },
            })
            .run();
          settle('queued', { runAfter: outcome.until, note: `${outcome.provider} limit` });
          this.emitTask(tx, row, {
            kind: 'task.provider_paused',
            attempts: row.attempts,
            message: `waiting for ${outcome.provider} limit, resumes at ${outcome.until.toISOString()}`,
          });
          break;
        }
        default: {
          const never: never = outcome;
          throw new Error(`unknown outcome ${JSON.stringify(never)}`);
        }
      }
    });
  }

  /** Gives a task back without spending an attempt (shutdown). */
  private release(row: TaskRow): void {
    const now = this.now();
    this.o.db
      .update(tasks)
      .set({ status: 'queued', leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(
        and(eq(tasks.id, row.id), eq(tasks.leaseOwner, this.owner), eq(tasks.status, 'running')),
      )
      .run();
  }

  /** A handler's durable marker: applied now, only while the lease is still ours. */
  private record(row: TaskRow, write: (tx: Tx) => void): boolean {
    return runInTx(this.o.db, this.o.bus, { now: this.now(), runId: row.runId }, (tx) => {
      const current = tx.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(eq(tasks.id, row.id), eq(tasks.leaseOwner, this.owner), eq(tasks.status, 'running')),
        )
        .get();
      if (!current) return false;
      applyCommit(write, tx);
      return true;
    });
  }

  private progress(row: TaskRow, message: string): void {
    try {
      runInTx(this.o.db, this.o.bus, { now: this.now(), runId: row.runId }, (tx) =>
        this.emitTask(tx, row, { kind: 'task.progress', message }),
      );
    } catch (err) {
      this.o.log.warn('progress event failed', { taskId: row.id, err });
    }
  }
}

function applyCommit(commit: (tx: Tx) => void, tx: Tx): void {
  const result = commit(tx) as unknown;
  if (result instanceof Promise) {
    result.catch(() => {});
    throw new Error('commit must be synchronous (it returned a promise)');
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
