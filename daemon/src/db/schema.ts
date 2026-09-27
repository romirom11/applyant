// Ordinary tables only. Virtual tables (FTS5, vec0) and their triggers live in custom
// migrations and never appear here, so `drizzle-kit generate` never tries to drop them.
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const now = sql`(cast(unixepoch('subsec') * 1000 as integer))`;

export const POSTING_STAGES = ['found', 'verified', 'failed_verification'] as const;
export type PostingStage = (typeof POSTING_STAGES)[number];

export const postings = sqliteTable('postings', {
  id: integer('id').primaryKey(),
  stage: text('stage', { enum: POSTING_STAGES }).notNull(),
  canonicalUrl: text('canonical_url').notNull().unique(),
  title: text('title'),
  company: text('company'),
  firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull().default(now),
  verifiedAt: integer('verified_at', { mode: 'timestamp_ms' }),
  verifyNote: text('verify_note'),
});

export const postingSources = sqliteTable(
  'posting_sources',
  {
    id: integer('id').primaryKey(),
    postingId: integer('posting_id')
      .notNull()
      .references(() => postings.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // manual | share | board | ats | ...
    url: text('url').notNull(),
    firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (t) => [uniqueIndex('posting_sources_posting_kind_url').on(t.postingId, t.kind, t.url)],
);

export const TASK_STATUSES = ['queued', 'running', 'done', 'failed', 'needs_candidate'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const tasks = sqliteTable(
  'tasks',
  {
    id: integer('id').primaryKey(),
    kind: text('kind').notNull(),
    entityId: integer('entity_id').notNull(),
    runId: integer('run_id'),
    provider: text('provider'),
    status: text('status', { enum: TASK_STATUSES }).notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    runAfter: integer('run_after', { mode: 'timestamp_ms' }).notNull().default(now),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: integer('lease_expires_at', { mode: 'timestamp_ms' }),
    // Last failure reason, or the hand-off JSON for needs_candidate.
    note: text('note'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (t) => [
    index('tasks_runnable').on(t.status, t.runAfter),
    index('tasks_entity').on(t.kind, t.entityId),
    index('tasks_run').on(t.runId),
  ],
);

export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey(),
    at: integer('at', { mode: 'timestamp_ms' }).notNull().default(now),
    // task.queued · task.started · task.progress · task.done · task.retry · task.failed ·
    // task.provider_paused · task.needs_candidate · task.lease_lost · task.requeued · posting.stage
    kind: text('kind').notNull(),
    runId: integer('run_id'),
    taskId: integer('task_id'),
    taskKind: text('task_kind'),
    attempts: integer('attempts'),
    postingId: integer('posting_id'),
    stage: text('stage'),
    entityId: integer('entity_id'),
    message: text('message').notNull().default(''),
  },
  (t) => [
    index('events_run').on(t.runId),
    index('events_posting').on(t.postingId),
    index('events_task').on(t.taskId),
  ],
);

export type PostingRow = typeof postings.$inferSelect;
export type PostingSourceRow = typeof postingSources.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
