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
  // An application moved (entity_id = application id, posting_id set, stage = its stage;
  // task_kind = `sync_mail` when a reply the mailbox read moved it).
  | 'application.stage'
  // Delivery got stuck and left a browser window open for the candidate to finish (entity_id =
  // application id, posting_id set; message = the hand-off reason).
  | 'handoff'
  | 'source.synced'
  // The candidate removed a knowledge source (entity_id = source id; message = what went with it).
  | 'source.removed'
  // The agent interview (entity_id = question id, stage = its status, or `done` when the
  // interviewer has nothing more to ask; message = the question or what the answer gave).
  | 'interview'
  // The Mac woke from sleep (applyant-native); the scheduler runs each missed search once.
  | 'system.wake'
  // A search run was queued, finished or failed (entity_id = strategy id, run_id = the run,
  // stage = queued | done | failed; message = what it found).
  | 'search.run'
  // A page's listing recipe is being built, was built, or couldn't be (entity_id = source id,
  // stage = building | built | failed).
  | 'search.recipe'
  // A search_planner run was queued, finished or failed (entity_id = plan id, stage = queued |
  // done | failed; message = what it added).
  | 'search.plan'
  // Company research was queued, finished or failed (entity_id = company id, stage = queued |
  // done | failed; message = what it found).
  | 'company'
  // The mailbox (phase 13): a sync stored replies (entity_id = mailbox id, stage = synced), an
  // email waits in the ask queue (entity_id = email id, stage = ask), or the candidate linked
  // one (stage = assigned). Connecting and disconnecting (entity_id = mailbox id, stage =
  // connected | failed | disconnected).
  | 'mail'
  // A guarded platform (phase 14; entity: none, message starts with the platform key): paused
  // after a challenge, resumed, its caps changed, or Applyant's browser signed in there (stage =
  // paused | resumed | caps | signed_in | signing_in).
  | 'platform';

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
