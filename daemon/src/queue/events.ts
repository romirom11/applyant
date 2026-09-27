// In-process event bus. Events are stored in the `events` table inside the transaction that
// caused them and published here after commit; WatchEvents streams from this bus.
import type { EventRow } from '../db/schema.ts';

export type EventKind =
  | 'task.queued'
  | 'task.started'
  | 'task.progress'
  | 'task.done'
  | 'task.retry'
  | 'task.failed'
  | 'task.provider_paused'
  | 'task.needs_candidate'
  | 'task.lease_lost'
  | 'task.requeued'
  | 'posting.stage'
  // A posting's application form was read (stage unchanged; message says what was found).
  | 'posting.form'
  | 'source.synced';

export interface EventInput {
  kind: EventKind;
  message?: string;
  runId?: number | null;
  taskId?: number | null;
  taskKind?: string | null;
  attempts?: number | null;
  postingId?: number | null;
  stage?: string | null;
  entityId?: number | null;
}

export type EventListener = (event: EventRow) => void;

export class EventBus {
  private readonly listeners = new Set<EventListener>();
  private readonly enqueueListeners = new Set<() => void>();

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(events: readonly EventRow[]): void {
    for (const event of events) {
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // A broken watcher must not affect the committer or other watchers.
        }
      }
    }
  }

  /** The worker listens here to wake up as soon as new tasks are committed. */
  onTasksEnqueued(listener: () => void): () => void {
    this.enqueueListeners.add(listener);
    return () => this.enqueueListeners.delete(listener);
  }

  tasksEnqueued(): void {
    for (const listener of this.enqueueListeners) listener();
  }
}
