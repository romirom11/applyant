// Ordinary tables only. Virtual tables (FTS5, vec0) and their triggers live in custom
// migrations and never appear here, so `drizzle-kit generate` never tries to drop them.
import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { FormRead } from '../browser/form-types.ts';
import type { Component, StoredExtraction, StoredMatch } from '../domain/scoring/types.ts';

const now = sql`(cast(unixepoch('subsec') * 1000 as integer))`;

export const POSTING_STAGES = [
  'found',
  'verified',
  'failed_verification',
  'scored',
  'skipped',
] as const;
export type PostingStage = (typeof POSTING_STAGES)[number];

export const POSTING_DECISIONS = ['interested', 'skipped'] as const;

/** verified: the form was read · no_form: none found · email: applies by email · failed: gave up. */
export const FORM_STATUSES = ['verified', 'no_form', 'email', 'failed'] as const;
export type FormStatus = (typeof FORM_STATUSES)[number];
export type PostingDecision = (typeof POSTING_DECISIONS)[number];

export const postings = sqliteTable('postings', {
  id: integer('id').primaryKey(),
  stage: text('stage', { enum: POSTING_STAGES }).notNull(),
  canonicalUrl: text('canonical_url').notNull().unique(),
  title: text('title'),
  company: text('company'),
  firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull().default(now),
  verifiedAt: integer('verified_at', { mode: 'timestamp_ms' }),
  verifyNote: text('verify_note'),
  /** Readable posting text, captured when the page was verified. The extractor reads this. */
  text: text('text'),
  /** The page's schema.org JobPosting JSON-LD, when it has one (structured fields win). */
  jsonLd: text('json_ld', { mode: 'json' }).$type<Record<string, unknown>>(),
  /** Extractor output, cached for `extractionKey` (posting text hash + prompt version). */
  extraction: text('extraction', { mode: 'json' }).$type<StoredExtraction>(),
  extractionKey: text('extraction_key'),
  /** Requirement matches, each with the cache key it was made for. */
  matches: text('matches', { mode: 'json' }).$type<StoredMatch[]>(),
  /** 0–100, from the pure score() over the cached extraction and matches. */
  score: integer('score'),
  /** must-haves × role fit (0–1) behind the score; logistics count less below 0.7. */
  coreFit: real('core_fit'),
  breakdown: text('breakdown', { mode: 'json' }).$type<Component[]>(),
  dealbreakers: text('dealbreakers', { mode: 'json' }).$type<string[]>(),
  scoredAt: integer('scored_at', { mode: 'timestamp_ms' }),
  /** Why the last scoring attempt failed; null once it succeeds. */
  scoreNote: text('score_note'),
  /** The candidate's call on this posting. */
  decision: text('decision', { enum: POSTING_DECISIONS }),
  decisionReason: text('decision_reason'),
  decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
  /** Where verification found the way to apply (form page, apply link target, mailto:). */
  applyUrl: text('apply_url'),
  /** The application form as Read found it (steps, fields, options, conditional fields). */
  form: text('form', { mode: 'json' }).$type<FormRead>(),
  formStatus: text('form_status', { enum: FORM_STATUSES }),
  /** What the last read found or why it failed ("2 steps · 17 fields"). */
  formNote: text('form_note'),
  formReadAt: integer('form_read_at', { mode: 'timestamp_ms' }),
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
    // task.provider_paused · task.needs_candidate · task.lease_lost · task.requeued · posting.stage ·
    // source.synced (entity_id = source id)
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

// Paused model providers (subscription limits). Tasks routed to a paused provider are not
// leased until `until`; tasks for other providers keep running.
export const providerPauses = sqliteTable('provider_pauses', {
  provider: text('provider').primaryKey(),
  until: integer('until', { mode: 'timestamp_ms' }).notNull(),
  reason: text('reason').notNull().default(''),
});

// ---- Candidate knowledge ---------------------------------------------------------------

export const projects = sqliteTable('projects', {
  id: integer('id').primaryKey(),
  /** Short handle used by the CLI (`candidate project show solovei`). */
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  summary: text('summary'),
  role: text('role'),
  period: text('period'),
  /** JSON array of technologies. */
  stack: text('stack', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

export const SOURCE_KINDS = ['file', 'url', 'github', 'drive', 'manual'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const sources = sqliteTable(
  'sources',
  {
    id: integer('id').primaryKey(),
    /** NULL for profile-level sources (a CV covering many projects). */
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: SOURCE_KINDS }).notNull(),
    /** Absolute path · URL · GitHub `owner/repo` URL · Drive file id. */
    locator: text('locator').notNull(),
    lastSyncedAt: integer('last_synced_at', { mode: 'timestamp_ms' }),
    /** Hash of the material the last extraction read; unchanged material is not re-extracted. */
    contentHash: text('content_hash'),
    /** What the last sync did, or why it failed. */
    syncNote: text('sync_note'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (t) => [index('sources_project').on(t.projectId)],
);

export const FACT_KINDS = [
  'personal_contribution',
  'team_context',
  'role',
  'skill',
  'impact',
  'education',
  'other',
] as const;
export type FactKind = (typeof FACT_KINDS)[number];
export const FACT_STATUSES = ['unconfirmed', 'confirmed', 'rejected'] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];
export const FACT_ORIGINS = ['extracted', 'interview', 'review_edit'] as const;
export type FactOrigin = (typeof FACT_ORIGINS)[number];

export const facts = sqliteTable(
  'facts',
  {
    id: integer('id').primaryKey(),
    /** NULL for profile-level facts. */
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    kind: text('kind', { enum: FACT_KINDS }).notNull(),
    status: text('status', { enum: FACT_STATUSES }).notNull(),
    origin: text('origin', { enum: FACT_ORIGINS }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
    /** Set when the candidate rewrote the text (the new text is theirs, so it is confirmed). */
    editedAt: integer('edited_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('facts_project').on(t.projectId), index('facts_status').on(t.status)],
);

export const evidence = sqliteTable(
  'evidence',
  {
    id: integer('id').primaryKey(),
    factId: integer('fact_id')
      .notNull()
      .references(() => facts.id, { onDelete: 'cascade' }),
    sourceId: integer('source_id').references(() => sources.id, { onDelete: 'set null' }),
    /** file path · commit:<sha> · pr:#12 · page 2 · URL fragment. */
    locator: text('locator'),
    /** A short verbatim excerpt of the source, when there is one. */
    excerpt: text('excerpt'),
  },
  (t) => [index('evidence_fact').on(t.factId), index('evidence_source').on(t.sourceId)],
);

export const agentRuns = sqliteTable(
  'agent_runs',
  {
    id: integer('id').primaryKey(),
    taskId: integer('task_id'),
    role: text('role').notNull(),
    provider: text('provider').notNull(),
    model: text('model'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    durationMs: integer('duration_ms').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: real('cost_usd'),
    /** ok · limit · invalid_output · error · aborted */
    outcome: text('outcome').notNull(),
    error: text('error'),
    logPath: text('log_path'),
  },
  (t) => [index('agent_runs_task').on(t.taskId)],
);

/** Candidate profile, key → JSON value (github_logins, commit_emails; standard fields in phase 4). */
export const profile = sqliteTable('profile', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

/** Search and scoring preferences, key → JSON value (see domain/scoring/prefs.ts). */
export const preferences = sqliteTable('preferences', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

/**
 * The candidate's skip / interested calls, kept so they can nudge component weights within
 * bounds (domain/scoring/feedback.ts). `component` is the score component the call points at.
 */
export const postingFeedback = sqliteTable(
  'posting_feedback',
  {
    id: integer('id').primaryKey(),
    postingId: integer('posting_id')
      .notNull()
      .references(() => postings.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: POSTING_DECISIONS }).notNull(),
    reason: text('reason'),
    component: text('component'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (t) => [index('posting_feedback_posting').on(t.postingId)],
);

/** Daily reference rates (units per 1 EUR), for comparing salaries in other currencies. */
export const fxRates = sqliteTable('fx_rates', {
  currency: text('currency').primaryKey(),
  perEur: real('per_eur').notNull(),
  /** The rates' own date (ECB publication date). */
  asOf: text('as_of').notNull(),
  fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull(),
});

/** Small daemon-internal state, key → JSON (e.g. which embedder made the fact vectors). */
export const appState = sqliteTable('app_state', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
});

export type PostingRow = typeof postings.$inferSelect;
export type PostingSourceRow = typeof postingSources.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type SourceRow = typeof sources.$inferSelect;
export type FactRow = typeof facts.$inferSelect;
export type EvidenceRow = typeof evidence.$inferSelect;
export type AgentRunRow = typeof agentRuns.$inferSelect;
export type NewAgentRunRow = typeof agentRuns.$inferInsert;
export type NewEventRow = typeof events.$inferInsert;
export type PostingFeedbackRow = typeof postingFeedback.$inferSelect;
