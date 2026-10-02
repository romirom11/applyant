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
  // Standard fields, answers (application_writer) and their checks (claim_verifier), phase 5.
  prepare_application: 'application',
  // Fills and submits the real form through its channel, phase 6.
  deliver_application: 'application',
  sync_source: 'source',
  // The agent interview (phase 9): the first question about a project…
  interview_open: 'project',
  // …and the candidate's answer to one question → facts and the next question.
  interview_turn: 'interview_question',
  // The fact vector index as a whole: entity_id is always 0.
  embed_facts: 'index',
  // One sweep after knowledge changed: postings whose match keys changed get score_posting
  // again (entity_id is always 0; a burst of changes shares one sweep).
  rematch_postings: 'index',
  // One run of a search strategy (phase 10): its sources' lists → found postings. The task's
  // run_id is the search run, and every task it spawns carries it.
  search: 'strategy',
  // A listing recipe for a page source (phase 11): reader_builder writes it, it's checked on the
  // same page and stored with that page as its fixture.
  build_recipe: 'search_source',
  // One search_planner run (phase 11): strategies from the profile, boards from web search.
  plan_search: 'search_plan',
  // Company research (phase 12): researcher's sourced profile of one company, with red flags.
  research_company: 'company',
  // One mailbox sync (phase 13): new replies → email_classify → matched to an application
  // (status moves) or asked about ("Which application is this?").
  sync_mail: 'mailbox',
  // An interview invite (an email linked to an application) → a Google Calendar event.
  interview_event: 'email',
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

/** Why a task needs the candidate (phase 5: what preparation lacks; phase 6 adds the browser). */
export interface HandOff {
  reason: string;
  detail: string | null;
  /** Delivery only: where it got stuck, and what the candidate finds in the window left open. */
  browser?: {
    scope: 'field' | 'step' | 'captcha';
    step: number;
    fieldLabel: string | null;
    url: string;
    /** A saved `ariaSnapshot` of the page at hand-off time. */
    snapshotPath: string | null;
  };
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
  /**
   * A small write made during the slow phase, applied at once while the lease is still held
   * (false when it's lost: nothing was written). Only for a marker that has to survive a crash
   * before the outcome's commit, such as "submit is about to be pressed".
   */
  record(write: Commit): boolean;
  now(): Date;
}

export type Handler<K extends TaskKind> = (task: Task<K>, ctx: HandlerContext) => Promise<Outcome>;

export type Handlers = { [K in TaskKind]: Handler<K> };
