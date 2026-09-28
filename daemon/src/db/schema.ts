// Ordinary tables only. Virtual tables (FTS5, vec0) and their triggers live in custom
// migrations and never appear here, so `drizzle-kit generate` never tries to drop them.
import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { FieldSpec, FormRead } from '../browser/form-types.ts';
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

// ---- Applications ----------------------------------------------------------------------

/**
 * preparing → ready_for_review ⇄ needs_candidate → approved (→ delivering → applied, phase 6).
 * needs_candidate: something only the candidate can give (a value the profile lacks, a fact
 * the knowledge base lacks) or preparation failed; the note says what.
 */
export const APPLICATION_STAGES = [
  'preparing',
  'ready_for_review',
  'needs_candidate',
  'approved',
  /** Delivered through its channel; see `receipts`. A delivery stuck mid-way stays `approved`
   * (the human gate already passed) with a note; `handoff show` explains it. */
  'applied',
] as const;
export type ApplicationStage = (typeof APPLICATION_STAGES)[number];

export const applications = sqliteTable('applications', {
  id: integer('id').primaryKey(),
  postingId: integer('posting_id')
    .notNull()
    .unique()
    .references(() => postings.id, { onDelete: 'cascade' }),
  stage: text('stage', { enum: APPLICATION_STAGES }).notNull(),
  /** web_form · email (the form's status decides; email is delivered from phase 13). */
  channel: text('channel').notNull().default('web_form'),
  /** What the candidate needs to do, or why preparation stopped. */
  note: text('note'),
  /** The form read (postings.form_read_at) the fields were prepared from. */
  fieldsFormAt: integer('fields_form_at', { mode: 'timestamp_ms' }),
  /** Set by a re-prepare request: redo the standard fields (profile may have changed). */
  refreshFields: integer('refresh_fields', { mode: 'boolean' }).notNull().default(true),
  /** Set by `prepare --rewrite`: redraft every answer, not only missing ones. */
  rewriteAnswers: integer('rewrite_answers', { mode: 'boolean' }).notNull().default(false),
  preparedAt: integer('prepared_at', { mode: 'timestamp_ms' }),
  approvedAt: integer('approved_at', { mode: 'timestamp_ms' }),
  appliedAt: integer('applied_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

/**
 * Where a field's value comes from.
 *   profile   the candidate's profile (a default for every application)
 *   override  set by the candidate for this one application; survives re-preparation
 *   answer    written by application_writer (or the candidate's edit of it)
 *   file      a file: the application's tailored CV, or the profile's base CV
 *   rule      not a candidate value: consent given by approving, "decline to answer" on a
 *             required demographic question
 *   none      no value
 */
export const FIELD_SOURCES = ['profile', 'override', 'answer', 'file', 'rule', 'none'] as const;
export type FieldSource = (typeof FIELD_SOURCES)[number];

/** One row per field of the form (every step and branch); which ones apply is derived. */
export const fieldValues = sqliteTable(
  'field_values',
  {
    id: integer('id').primaryKey(),
    applicationId: integer('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** `<step>:<refKey>`: stable across re-reads of the same form. */
    fieldRef: text('field_ref').notNull(),
    /** Position in the form (steps flattened), for display and CLI handles. */
    position: integer('position').notNull(),
    /** The field as Read found it (label, kind, options, meaning, revealedBy). */
    spec: text('spec', { mode: 'json' }).$type<FieldSpec>().notNull(),
    /** What the value is; the text sent (or the option, "checked", a file path, JSON entries). */
    value: text('value'),
    /** Effective source: `override` while the candidate's override is set. */
    source: text('source', { enum: FIELD_SOURCES }).notNull(),
    /** What preparation computed (kept under an override, so clearing it restores this). */
    defaultValue: text('default_value'),
    defaultSource: text('default_source', { enum: FIELD_SOURCES }).notNull(),
    /** Why there is no value, or how it was chosen ("from your profile: 'EU citizen'"). */
    note: text('note'),
  },
  (t) => [uniqueIndex('field_values_app_ref').on(t.applicationId, t.fieldRef)],
);

export const answers = sqliteTable(
  'answers',
  {
    id: integer('id').primaryKey(),
    applicationId: integer('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** The field_ref of the question it answers. */
    questionRef: text('question_ref').notNull(),
    question: text('question').notNull(),
    /** text: the sentences are sent · choice: `choice` is sent, the sentences are its claim. */
    kind: text('kind', { enum: ['text', 'choice'] }).notNull(),
    /** needs_candidate: the facts can't answer it honestly; `missing` says what's lacking. */
    status: text('status', { enum: ['answered', 'needs_candidate'] }).notNull(),
    choice: text('choice'),
    missing: text('missing'),
    /** "answer:<id>" of a prior answer whose facts this one reuses. */
    adaptedFrom: text('adapted_from'),
    /** The candidate rewrote it (their words; not re-drafted on re-preparation). */
    edited: integer('edited', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (t) => [uniqueIndex('answers_app_question').on(t.applicationId, t.questionRef)],
);

/**
 * none · unchecked (checks not run yet) · absent_number · contradiction ·
 * verifier:<quantity|role|scope|timeframe|unsupported>. "Relies on an unconfirmed fact" is
 * derived from the cited facts' status when shown, so confirming a fact clears it.
 */
export const answerSentences = sqliteTable(
  'answer_sentences',
  {
    id: integer('id').primaryKey(),
    answerId: integer('answer_id')
      .notNull()
      .references(() => answers.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    text: text('text').notNull(),
    factIds: text('fact_ids_json', { mode: 'json' }).$type<number[]>().notNull(),
    flag: text('flag').notNull().default('unchecked'),
    /** What the check found ("the fact says a team of 4; the sentence says 10"). */
    note: text('note'),
  },
  (t) => [uniqueIndex('answer_sentences_answer_idx').on(t.answerId, t.idx)],
);

/** One field as it was actually sent, kept in the receipt even if field_values changes later. */
export interface ReceiptFieldValue {
  ref: string;
  label: string;
  value: string | null;
  source: FieldSource;
}

/**
 * What was actually delivered: every field value sent (with its source), the CV file's hash
 * and path, the salary value if any, the final URL, the confirmation and when. One row per
 * application (a re-delivery replaces it).
 */
export const receipts = sqliteTable('receipts', {
  id: integer('id').primaryKey(),
  applicationId: integer('application_id')
    .notNull()
    .unique()
    .references(() => applications.id, { onDelete: 'cascade' }),
  finalUrl: text('final_url').notNull(),
  confirmationText: text('confirmation_text'),
  /** A saved page snapshot (ariaSnapshot text) of the confirmation, for `applications show`. */
  confirmationSnapshotPath: text('confirmation_snapshot_path'),
  cvPath: text('cv_path'),
  cvHash: text('cv_hash'),
  salaryValue: text('salary_value'),
  fieldValues: text('field_values', { mode: 'json' }).$type<ReceiptFieldValue[]>().notNull(),
  submittedAt: integer('submitted_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

/** One line of a tailored CV: its text and the confirmed facts it rests on. */
export interface CvLine {
  text: string;
  factIds: number[];
}

/** A line the CV left out, and why (an unconfirmed fact, a check that failed). */
export interface CvDroppedLine extends CvLine {
  /** `summary`, `education`, `skills`, or the slug of the project the line was written for. */
  section: string;
  reason: string;
}

/**
 * What the tailored CV says, in order. Project order, which facts become bullets and how the
 * summary reads are the tailoring; every line cites confirmed facts only.
 */
export interface CvPlan {
  summary: CvLine[];
  projects: Array<{ slug: string; name: string; period: string | null; bullets: CvLine[] }>;
  education: CvLine[];
  skills: string[];
  dropped: CvDroppedLine[];
}

/**
 * tailored: preparation writes a CV for this posting (the default) · base: the profile's
 * base_cv_file is sent instead (`applications cv use-base`).
 */
export const CV_MODES = ['tailored', 'base'] as const;
export type CvMode = (typeof CV_MODES)[number];

/**
 * pending: a plan is still to be written · planned: written and checked, the PDF is still to
 * be rendered · ready: `pdf_path` is the file delivery uploads · skipped: no tailored CV is
 * possible (the note says why) and the base CV stands in.
 */
export const CV_STATUSES = ['pending', 'planned', 'ready', 'skipped'] as const;
export type CvStatus = (typeof CV_STATUSES)[number];

/** The application's CV: one row per application whose form takes a CV. */
export const cvs = sqliteTable('cvs', {
  id: integer('id').primaryKey(),
  applicationId: integer('application_id')
    .notNull()
    .unique()
    .references(() => applications.id, { onDelete: 'cascade' }),
  mode: text('mode', { enum: CV_MODES }).notNull().default('tailored'),
  status: text('status', { enum: CV_STATUSES }).notNull().default('pending'),
  plan: text('plan', { mode: 'json' }).$type<CvPlan>(),
  /** The rendered PDF under files/cv/ (named by its hash, so a new render is a new file). */
  pdfPath: text('pdf_path'),
  pdfHash: text('pdf_hash'),
  note: text('note'),
  renderedAt: integer('rendered_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
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
export type ApplicationRow = typeof applications.$inferSelect;
export type FieldValueRow = typeof fieldValues.$inferSelect;
export type AnswerRow = typeof answers.$inferSelect;
export type AnswerSentenceRow = typeof answerSentences.$inferSelect;
export type ReceiptRow = typeof receipts.$inferSelect;
export type CvRow = typeof cvs.$inferSelect;
export type NewReceiptRow = typeof receipts.$inferInsert;
