// The queue contract. Handlers run with no transaction open and return an Outcome; only the
// worker applies it, inside tx2, after re-checking the lease.

import type { DrizzleTx, ReadDb } from '../db/client.ts';
import type { Deps } from '../deps.ts';
import type { Provider as RoleProvider } from '../models/roles.ts';
import type { EventInput } from './events.ts';

/** Every task kind, and the kind of entity its `entity_id` points at. */
export const TASK_ENTITY = {
  verify_posting: 'posting',
  score_posting: 'posting',
  // The posting's application form: every step, field and option (phase 4).
  read_form: 'posting',
  sync_source: 'source',
  // The fact vector index as a whole: entity_id is always 0.
  embed_facts: 'index',
} as const;
export type TaskKind = keyof typeof TASK_ENTITY;
export const TASK_KINDS = Object.keys(TASK_ENTITY) as TaskKind[];

export function isTaskKind(kind: string): kind is TaskKind {
  return Object.hasOwn(TASK_ENTITY, kind);
}

/** Model providers whose subscription limits can pause their tasks. */
export type Provider = RoleProvider;

export interface Task<K extends TaskKind = TaskKind> {
  id: number;
  kind: K;
  entityId: number;
  runId: number | null;
  provider: string | null;
  /** Failed attempts so far; 0 on the first run. */
  attempts: number;
}

/** Why a task needs the candidate (used from phase 5; richer shape arrives with hand-off). */
export interface HandOff {
  reason: string;
  detail: string | null;
}

export interface EnqueueOptions {
  runId?: number | null;
  provider?: string | null;
  runAfter?: Date;
}

/** The write handle a commit receives. Reads inside a commit also go through here. */
export interface Tx {
  readonly db: DrizzleTx;
  /** The commit time. */
  readonly now: Date;
  /** Inserts a queued task; `runId` defaults to the committing task's run. Returns its id. */
  enqueue(kind: TaskKind, entityId: number, opts?: EnqueueOptions): number;
  /** Stores an event; it is published to watchers only after the transaction commits. */
  emit(event: EventInput): void;
}

/** Applied synchronously inside tx2. A commit that returns a promise is rejected. */
export type Commit = (tx: Tx) => void;

export type Outcome =
  | { kind: 'done'; commit: Commit }
  | { kind: 'retry'; after: Date; reason: string }
  | { kind: 'pause_provider'; provider: Provider; until: Date }
  | { kind: 'needs_candidate'; commit: Commit; handOff: HandOff };

export interface ProgressEvent {
  message: string;
}

export interface HandlerContext {
  deps: Deps;
  /** Read-only connection: writes fail at the driver. */
  read: ReadDb;
  /** Aborted when the lease is lost or the daemon shuts down. */
  signal: AbortSignal;
  progress(e: ProgressEvent): void;
  now(): Date;
}

export type Handler<K extends TaskKind> = (task: Task<K>, ctx: HandlerContext) => Promise<Outcome>;

export type Handlers = { [K in TaskKind]: Handler<K> };
