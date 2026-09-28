import type { Db, DrizzleTx } from '../db/client.ts';
import { type EventRow, events, tasks } from '../db/schema.ts';
import { loadRouting, providerForTask } from '../models/roles.ts';
import type { EventBus, EventInput } from './events.ts';
import type { EnqueueOptions, TaskKind, Tx } from './types.ts';
import { TASK_ENTITY } from './types.ts';

export interface RunInTxOptions {
  now: Date;
  /** Default run for tasks and events created in this transaction. */
  runId?: number | null;
}

/**
 * Runs `fn` in one synchronous write transaction with the Tx facade. Stored events are
 * published, and the worker is woken for enqueued tasks, only after the commit succeeds.
 */
export function runInTx<T>(db: Db, bus: EventBus, opts: RunInTxOptions, fn: (tx: Tx) => T): T {
  const emitted: EventRow[] = [];
  let enqueued = 0;
  const result = db.transaction((dtx) => {
    const tx = createTx(dtx, opts, emitted, () => {
      enqueued++;
    });
    const value = fn(tx);
    if (value instanceof Promise) {
      value.catch(() => {});
      throw new Error('a transaction callback must be synchronous');
    }
    return value;
  });
  bus.publish(emitted);
  if (enqueued > 0) bus.tasksEnqueued();
  return result;
}

function createTx(
  db: DrizzleTx,
  opts: RunInTxOptions,
  emitted: EventRow[],
  onEnqueue: () => void,
): Tx {
  const now = opts.now;
  const defaultRun = opts.runId ?? null;
  const emit = (event: EventInput): void => {
    const row = db
      .insert(events)
      .values({
        at: now,
        kind: event.kind,
        message: event.message ?? '',
        runId: event.runId === undefined ? defaultRun : event.runId,
        taskId: event.taskId ?? null,
        taskKind: event.taskKind ?? null,
        attempts: event.attempts ?? null,
        postingId: event.postingId ?? null,
        stage: event.stage ?? null,
        entityId: event.entityId ?? null,
      })
      .returning()
      .get();
    emitted.push(row);
  };
  const enqueue = (kind: TaskKind, entityId: number, o: EnqueueOptions = {}): number => {
    const runId = o.runId === undefined ? defaultRun : o.runId;
    const row = db
      .insert(tasks)
      .values({
        kind,
        entityId,
        runId,
        // Tagged with the provider its role routes to (the candidate's routing, not only the
        // defaults), so a limit pause skips it at lease time.
        provider: o.provider === undefined ? providerForTask(kind, loadRouting(db)) : o.provider,
        status: 'queued',
        attempts: 0,
        runAfter: o.runAfter ?? now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: tasks.id })
      .get();
    emit({
      kind: 'task.queued',
      runId,
      taskId: row.id,
      taskKind: kind,
      entityId,
      attempts: 0,
      postingId: TASK_ENTITY[kind] === 'posting' ? entityId : null,
    });
    onEnqueue();
    return row.id;
  };
  return { db, now, emit, enqueue };
}
