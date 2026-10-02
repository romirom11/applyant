// Ordinary tables only. Virtual tables (FTS5, vec0) and their triggers live in custom
// migrations and never appear here, so `drizzle-kit generate` never tries to drop them.
import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { FieldSpec, FormRead } from '../browser/form-types.ts';
import type { Component, RoleFit, StoredExtraction, StoredMatch } from '../domain/scoring/types.ts';
import {
  type ListingRecipe,
  RECIPE_STATUSES,
  type RecipeListing,
} from '../domain/search/recipes/types.ts';
import type { CompanyProfile } from '../models/schemas/company.ts';

const now = sql`(cast(unixepoch('subsec') * 1000 as integer))`;

export const POSTING_STAGES = [
  'found',
  'verified',
  'failed_verification',
  'scored',
  'skipped',
  /** Was live, and isn't any more: gone from a source's complete list, or re-verified dead. */
  'closed',
] as const;
export type PostingStage = (typeof POSTING_STAGES)[number];

export const POSTING_DECISIONS = ['interested', 'skipped'] as const;

/**
 * verified: the form was read · no_form: none found · email: applies by email · telegram: by a
 * Telegram message to a contact (phase 15) · failed: gave up.
 */
export const FORM_STATUSES = ['verified', 'no_form', 'email', 'telegram', 'failed'] as const;
export type FormStatus = (typeof FORM_STATUSES)[number];
export type PostingDecision = (typeof POSTING_DECISIONS)[number];

export const postings = sqliteTable(
  'postings',
  {
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
    /** Whether it's one of the roles the candidate is after (role-fit.ts); null = not judged. */
    roleFit: text('role_fit', { mode: 'json' }).$type<RoleFit>(),
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
    /** The job's id on its ATS ("greenhouse:4001234"), from any of its URLs: a dedupe key. */
    atsKey: text('ats_key'),
    /** MinHash signature of the description shingles (dedupe: reposts under another URL). */
    minhash: text('minhash', { mode: 'json' }).$type<number[]>(),
    /** The description a search source listed it with (before verification reads the page). */
    listingText: text('listing_text'),
    /**
     * Where its listings say it is, one entry per location a source gave: a company board's
     * per-country copies of one role are one posting with all their locations.
     */
    locations: text('locations', { mode: 'json' }).$type<string[]>(),
  },
  (t) => [index('postings_ats_key').on(t.atsKey)],
);

export const postingSources = sqliteTable(
  'posting_sources',
  {
    id: integer('id').primaryKey(),
    postingId: integer('posting_id')
      .notNull()
      .references(() => postings.id, { onDelete: 'cascade' }),
    // manual | share | greenhouse | ashby | lever | workable | page | board
    kind: text('kind').notNull(),
    url: text('url').notNull(),
    firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull().default(now),
    /** The search source that lists it (phase 10); null for manual and shared postings. */
    searchSourceId: integer('search_source_id').references(() => searchSources.id, {
      onDelete: 'set null',
    }),
    /** The source's own id for the job (ATS job id, board id): how absence is judged. */
    externalId: text('external_id'),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
    /** Set when a complete list from the source no longer had it; cleared if it comes back. */
    closedAt: integer('closed_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    uniqueIndex('posting_sources_posting_kind_url').on(t.postingId, t.kind, t.url),
    index('posting_sources_search_source').on(t.searchSourceId),
  ],
);

// ---- Search (phase 10) ------------------------------------------------------------------

/**
 * greenhouse · ashby · lever · workable: a company's board, read through that ATS's public
 * list API (complete lists). page: a career page or feed URL, read by the generic reader (a
 * feed or JSON-LD first, then a known ATS embed). board: a job board (HN, RemoteOK, …).
 * linkedin · xing: the platform's job search, read under the candidate's session in Applyant's
 * browser with the platform guardrails (phase 14); never a complete list.
 * telegram: a job channel (phase 15), its public t.me/s preview or, for a private channel, the
 * candidate's own account over MTProto; never a complete list.
 */
export const SEARCH_SOURCE_KINDS = [
  'greenhouse',
  'ashby',
  'lever',
  'workable',
  'page',
  'board',
  'linkedin',
  'xing',
  'telegram',
] as const;
export type SearchSourceKind = (typeof SEARCH_SOURCE_KINDS)[number];

/** How a page source was last read: cached so later runs go straight to it. */
export type ResolvedSource =
  | { via: 'feed'; url: string; format: string }
  | { via: 'ats'; ats: 'greenhouse' | 'ashby' | 'lever' | 'workable'; token: string }
  | { via: 'lever'; apiHost: string }
  // Its listing recipe (phase 11): a partial list, never complete.
  | { via: 'recipe' }
  // A Telegram channel (phase 15): what the extractor made of its recent posts, by post id, so
  // each post is judged once (a job's posting fields, or null for a post that isn't a job).
  | { via: 'telegram'; posts: Record<string, TelegramPostVerdict | null> };

/** A Telegram post the extractor judged to be a job posting. */
export interface TelegramPostVerdict {
  role: string;
  company: string | null;
  salary: string | null;
  location: string | null;
  remote: boolean | null;
  /** `https://t.me/<user>`, `mailto:<address>` or the job's own page: where to apply. */
  applyUrl: string | null;
  /** The contact as the post wrote it (@user, an address). */
  contact: string | null;
}

/** One place postings can be listed. A disabled source (or kind) is never queried. */
export const searchSources = sqliteTable('search_sources', {
  id: integer('id').primaryKey(),
  /** `<kind>:<locator>`: greenhouse:gitlab · board:hn · page:https://acme.com/careers */
  key: text('key').notNull().unique(),
  kind: text('kind', { enum: SEARCH_SOURCE_KINDS }).notNull(),
  /** Board token / slug / site / account, a board id, or the page URL. */
  locator: text('locator').notNull(),
  label: text('label').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** builtin (the boards) · candidate · agent (phase 11). */
  origin: text('origin', { enum: ['builtin', 'candidate', 'agent'] })
    .notNull()
    .default('candidate'),
  /** Why it's watched: the search planner's reason and the web search that found it. */
  note: text('note'),
  resolved: text('resolved', { mode: 'json' }).$type<ResolvedSource>(),
  lastRunAt: integer('last_run_at', { mode: 'timestamp_ms' }),
  /** Listings the last read returned (before any strategy's queries). */
  lastCount: integer('last_count'),
  lastComplete: integer('last_complete', { mode: 'boolean' }),
  /** What the last read did, or why it failed. */
  lastNote: text('last_note'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

/** A whole kind switched off ("Greenhouse"): its sources are never queried. On by default. */
export const searchSourceKinds = sqliteTable('search_source_kinds', {
  kind: text('kind', { enum: SEARCH_SOURCE_KINDS }).primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
});

export const STRATEGY_STATES = ['active', 'paused'] as const;
export type StrategyState = (typeof STRATEGY_STATES)[number];

/**
 * A search strategy: which sources, which queries, how often. The scheduler starts a run when
 * `next_run_at` has passed; after the Mac sleeps, a missed schedule runs once.
 */
export const searchStrategies = sqliteTable('search_strategies', {
  id: integer('id').primaryKey(),
  name: text('name').notNull().unique(),
  /** Title phrases; a listing matches when every word of one query is in its title. Empty = all. */
  queries: text('queries', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  /** Location words; a listing matches when its location has one ("remote" matches remote jobs). */
  locations: text('locations', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  /** Source selectors: a kind (greenhouse, board, …), a source key (board:hn) or "all". */
  sources: text('sources', { mode: 'json' }).$type<string[]>().notNull(),
  everyMinutes: integer('every_minutes').notNull().default(360),
  state: text('state', { enum: STRATEGY_STATES }).notNull().default('active'),
  /** candidate · agent (phase 11's search_planner). */
  origin: text('origin', { enum: ['candidate', 'agent'] })
    .notNull()
    .default('candidate'),
  lastRunAt: integer('last_run_at', { mode: 'timestamp_ms' }),
  nextRunAt: integer('next_run_at', { mode: 'timestamp_ms' }).notNull().default(now),
  note: text('note'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

/** One source's part of a search run. */
export interface SearchRunSourceResult {
  sourceKey: string;
  label: string;
  /** Listings the source returned. */
  listed: number;
  /** …of which the strategy's queries and locations matched. */
  matched: number;
  /** New postings created from them. */
  added: number;
  /** Matched listings that joined a posting already known (another source, a repost). */
  attached: number;
  /** The source gave its whole list and the read finished: absence closes postings. */
  complete: boolean;
  /** Postings closed / reopened by this list, and re-verifications it asked for. */
  closed: number;
  reopened: number;
  reverify: number;
  error: string | null;
  note: string | null;
}

export const SEARCH_RUN_TRIGGERS = ['schedule', 'wake', 'manual'] as const;
export type SearchRunTrigger = (typeof SEARCH_RUN_TRIGGERS)[number];

/** A search run: `id` is the run_id every task it spawns (verify, score, …) carries. */
export const searchRuns = sqliteTable(
  'search_runs',
  {
    id: integer('id').primaryKey(),
    strategyId: integer('strategy_id')
      .notNull()
      .references(() => searchStrategies.id, { onDelete: 'cascade' }),
    trigger: text('trigger', { enum: SEARCH_RUN_TRIGGERS }).notNull(),
    /** queued (waiting or running) · done · failed */
    status: text('status', { enum: ['queued', 'done', 'failed'] })
      .notNull()
      .default('queued'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull().default(now),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    listed: integer('listed').notNull().default(0),
    added: integer('added').notNull().default(0),
    results: text('results', { mode: 'json' })
      .$type<SearchRunSourceResult[]>()
      .notNull()
      .default(sql`'[]'`),
    note: text('note'),
    /** The source ids this run reads; null = every source the strategy selects. */
    sourceIds: text('source_ids', { mode: 'json' }).$type<number[]>(),
  },
  (t) => [index('search_runs_strategy').on(t.strategyId)],
);

/** Which strategies found which postings (per-strategy found / verified / interested). */
export const strategyPostings = sqliteTable(
  'strategy_postings',
  {
    id: integer('id').primaryKey(),
    strategyId: integer('strategy_id')
      .notNull()
      .references(() => searchStrategies.id, { onDelete: 'cascade' }),
    postingId: integer('posting_id')
      .notNull()
      .references(() => postings.id, { onDelete: 'cascade' }),
    runId: integer('run_id'),
    firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (t) => [
    uniqueIndex('strategy_postings_strategy_posting').on(t.strategyId, t.postingId),
    index('strategy_postings_posting').on(t.postingId),
  ],
);

/**
 * A page's listing recipe (phase 11): written once by reader_builder, checked against the page
 * it was built from, stored with that page (the fixture) and what it read there, then run as
 * plain Playwright on every read. One per source.
 */
export const listingRecipes = sqliteTable('listing_recipes', {
  id: integer('id').primaryKey(),
  sourceId: integer('source_id')
    .notNull()
    .unique()
    .references(() => searchSources.id, { onDelete: 'cascade' }),
  /** The recipe in use; null while none could be built. */
  recipe: text('recipe', { mode: 'json' }).$type<ListingRecipe>(),
  status: text('status', { enum: RECIPE_STATUSES }).notNull(),
  /** The page the recipe was built from: its URL and HTML (scripts removed, hidden marked). */
  fixtureUrl: text('fixture_url'),
  fixtureHtml: text('fixture_html'),
  /** What the recipe read from that page when it was built (the first page only). */
  expected: text('expected', { mode: 'json' }).$type<RecipeListing[]>(),
  /** Listings of the last good read (all pages): the count window's reference. */
  lastCount: integer('last_count'),
  builtAt: integer('built_at', { mode: 'timestamp_ms' }),
  /** When a sample of its listings was last checked by Jev ("is this a job title and link?"). */
  lastSampledAt: integer('last_sampled_at', { mode: 'timestamp_ms' }),
  /** The last build attempt, good or not (failed builds are retried after a few days). */
  lastBuildAt: integer('last_build_at', { mode: 'timestamp_ms' }),
  builds: integer('builds').notNull().default(0),
  /** Why it's broken or failed, or what the last build did. */
  note: text('note'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

export const SEARCH_PLAN_TRIGGERS = ['manual', 'schedule', 'setup'] as const;

/**
 * One search_planner run (phase 11): the strategies it proposed and the boards its web
 * searches found, which join the watch list as sources.
 */
export const searchPlans = sqliteTable('search_plans', {
  id: integer('id').primaryKey(),
  trigger: text('trigger', { enum: SEARCH_PLAN_TRIGGERS }).notNull(),
  /** queued (waiting or running) · done · failed */
  status: text('status', { enum: ['queued', 'done', 'failed'] })
    .notNull()
    .default('queued'),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull().default(now),
  finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  /** Ids of the strategies it added. */
  strategies: text('strategies', { mode: 'json' }).$type<number[]>().notNull().default(sql`'[]'`),
  /** Keys of the sources it added to the watch list. */
  boards: text('boards', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  /** The web searches it says it ran. */
  searches: text('searches', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  note: text('note'),
});

/**
 * Role routing overrides (phase 11): a row replaces the default route of its role (roles.ts);
 * `applyant config roles reset` deletes it.
 */
export const roleRoutes = sqliteTable('role_routes', {
  role: text('role').primaryKey(),
  provider: text('provider').notNull(),
  model: text('model'),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

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
  /** position (a job, a freelance engagement) · project (something built); null: guessed. */
  kind: text('kind', { enum: ['position', 'project'] }),
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

/** The first-launch setup (phase 16): one row per step the candidate has settled. */
export const SETUP_STEPS = ['connections', 'import', 'preferences', 'interview'] as const;
export type SetupStepKey = (typeof SETUP_STEPS)[number];
export const SETUP_STATES = ['pending', 'done', 'skipped', 'later'] as const;
export type SetupState = (typeof SETUP_STATES)[number];
export const setupSteps = sqliteTable('setup_steps', {
  step: text('step', { enum: SETUP_STEPS }).primaryKey(),
  state: text('state', { enum: SETUP_STATES }).notNull(),
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
  /** Replies read from the mailbox move an applied application on (phase 13). */
  'interview',
  'rejected',
  'offer',
  /** The candidate withdrew; only ever set by hand (SetApplicationStage). */
  'withdrawn',
] as const;
export type ApplicationStage = (typeof APPLICATION_STAGES)[number];

/** The two forms a posting found on LinkedIn/Xing can have. */
export const APPLY_FORMS = ['company', 'platform'] as const;
export type ApplyForm = (typeof APPLY_FORMS)[number];

export const applications = sqliteTable('applications', {
  id: integer('id').primaryKey(),
  postingId: integer('posting_id')
    .notNull()
    .unique()
    .references(() => postings.id, { onDelete: 'cascade' }),
  stage: text('stage', { enum: APPLICATION_STAGES }).notNull(),
  /** web_form · email · telegram (the form's status decides; email from phase 13, telegram 15). */
  channel: text('channel').notNull().default('web_form'),
  /** What the candidate needs to do, or why preparation stopped. */
  note: text('note'),
  /** The form read (postings.form_read_at) the fields were prepared from. */
  fieldsFormAt: integer('fields_form_at', { mode: 'timestamp_ms' }),
  /** Set by a re-prepare request: redo the standard fields (profile may have changed). */
  refreshFields: integer('refresh_fields', { mode: 'boolean' }).notNull().default(true),
  /** Set by `prepare --rewrite`: redraft every answer, not only missing ones. */
  rewriteAnswers: integer('rewrite_answers', { mode: 'boolean' }).notNull().default(false),
  /**
   * Which form it goes through when the posting has both: the platform's (LinkedIn Easy Apply,
   * Xing apply) or the company's own. Null = the company's form (the default).
   */
  applyForm: text('apply_form', { enum: APPLY_FORMS }),
  preparedAt: integer('prepared_at', { mode: 'timestamp_ms' }),
  approvedAt: integer('approved_at', { mode: 'timestamp_ms' }),
  appliedAt: integer('applied_at', { mode: 'timestamp_ms' }),
  /**
   * Set, durably, just before delivery presses submit (or sends the email / Telegram message)
   * and cleared by a new approval or an explicit retry. A delivery that finds it set didn't see
   * how its last submission ended: it hands off instead of submitting a second time.
   */
  submitAttemptedAt: integer('submit_attempted_at', { mode: 'timestamp_ms' }),
  /** When the candidate first opened it for review (metric 3: review time runs to approval). */
  reviewStartedAt: integer('review_started_at', { mode: 'timestamp_ms' }),
  /** When it first reached interview / offer (kept when a later reply rejects it). */
  interviewAt: integer('interview_at', { mode: 'timestamp_ms' }),
  offerAt: integer('offer_at', { mode: 'timestamp_ms' }),
  /** The candidate's own notes (free text). */
  notes: text('notes'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

/** Company contacts on an application: a recruiter, a hiring manager (the candidate adds them). */
export const applicationContacts = sqliteTable(
  'application_contacts',
  {
    id: integer('id').primaryKey(),
    applicationId: integer('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    name: text('name'),
    role: text('role'),
    email: text('email'),
    linkedin: text('linkedin'),
    note: text('note'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (t) => [index('application_contacts_app').on(t.applicationId)],
);

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

/** Review quick actions: "Shorter", "Use another project…" (the project's id and name). */
export interface Redraft {
  shorter?: boolean;
  project?: { id: number; name: string };
}

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
    /**
     * A review quick action waiting for the next preparation: draft this answer again, shorter
     * and/or from one project's facts. Cleared when the new draft is saved.
     */
    redraft: text('redraft', { mode: 'json' }).$type<Redraft>(),
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
  /** Email applications (phase 13): the sent message's Message-ID, so replies thread to it. */
  messageId: text('message_id'),
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
  projects: Array<{
    slug: string;
    name: string;
    period: string | null;
    /** Positions are Experience, projects their own section; absent in older plans: guessed. */
    kind?: 'position' | 'project';
    /** A position's title, shown with the employer when the name doesn't hold it. */
    role?: string | null;
    bullets: CvLine[];
  }>;
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

// ---- The interview ---------------------------------------------------------------------

/**
 * open: waiting for the candidate · processing: answered, the interviewer is turning the
 * answer into facts (and the next question) · answered: done · dismissed: "later" / not asked.
 */
export const INTERVIEW_STATUSES = ['open', 'processing', 'answered', 'dismissed'] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];
/** project: opens a project's interview · follow_up: asked after an answer · application: a fact
 * an application's preparation found missing. */
export const INTERVIEW_ORIGINS = ['project', 'follow_up', 'application'] as const;
export type InterviewOrigin = (typeof INTERVIEW_ORIGINS)[number];

/**
 * One question to the candidate. A project interview asks about one project's gaps (role,
 * personal contribution, team, impact); an application question asks for a fact preparation
 * found missing (`application_id` and the form question's `field_ref` set), and preparation
 * resumes once it's answered.
 */
export const interviewQuestions = sqliteTable(
  'interview_questions',
  {
    id: integer('id').primaryKey(),
    /** The project the question is about; null for an application question. */
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    applicationId: integer('application_id').references(() => applications.id, {
      onDelete: 'cascade',
    }),
    /** The form question (field_values.field_ref) an application question came from. */
    fieldRef: text('field_ref'),
    text: text('text').notNull(),
    /** Why it's asked: the gap for a project question, the form question for an application's. */
    context: text('context'),
    status: text('status', { enum: INTERVIEW_STATUSES }).notNull().default('open'),
    origin: text('origin', { enum: INTERVIEW_ORIGINS }).notNull(),
    /** What the last turn did with the answer, or why reading it failed. */
    note: text('note'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
    answeredAt: integer('answered_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('interview_questions_status').on(t.status),
    index('interview_questions_project').on(t.projectId),
    index('interview_questions_application').on(t.applicationId),
  ],
);

/**
 * The transcript, Applyant's own (never the CLI's session files): the agent's questions and the
 * candidate's answers, in order. The next turn is a fresh agent run seeded with it.
 */
export const interviewTurns = sqliteTable(
  'interview_turns',
  {
    id: integer('id').primaryKey(),
    questionId: integer('question_id')
      .notNull()
      .references(() => interviewQuestions.id, { onDelete: 'cascade' }),
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    applicationId: integer('application_id').references(() => applications.id, {
      onDelete: 'cascade',
    }),
    role: text('role', { enum: ['agent', 'candidate'] }).notNull(),
    text: text('text').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (t) => [
    index('interview_turns_question').on(t.questionId),
    index('interview_turns_project').on(t.projectId),
  ],
);

// ---- Company research (phase 12) --------------------------------------------------------

/**
 * One row per company, shared by all of its postings (matched by `key`, the normalised name).
 * `profile` is the researcher's last good result; a refresh that fails keeps it.
 */
export const companies = sqliteTable('companies', {
  id: integer('id').primaryKey(),
  /** companyKey(name): lower case, legal suffixes and punctuation dropped. */
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  /** queued (waiting or running) · done · failed (the last attempt; `profile` may still hold an older one) */
  status: text('status', { enum: ['queued', 'done', 'failed'] })
    .notNull()
    .default('queued'),
  /** Who asked last: preparation, or the candidate (Company research). */
  trigger: text('trigger', { enum: ['prepare', 'manual'] })
    .notNull()
    .default('prepare'),
  profile: text('profile', { mode: 'json' }).$type<CompanyProfile>(),
  /** When `profile` was researched; older than 30 days is stale. */
  researchedAt: integer('researched_at', { mode: 'timestamp_ms' }),
  /** The last attempt, successful or not. */
  attemptedAt: integer('attempted_at', { mode: 'timestamp_ms' }),
  note: text('note'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

// ---- The mailbox (phase 13) --------------------------------------------------------------

export const MAILBOX_KINDS = ['gmail', 'imap'] as const;
export type MailboxKind = (typeof MAILBOX_KINDS)[number];

/** Where an IMAP/SMTP mailbox lives; its password (or app password) is in `Secrets`. */
export interface MailboxSettings {
  imap?: { host: string; port: number; secure: boolean };
  smtp?: { host: string; port: number; secure: boolean };
  /** The login name, when it isn't the address. */
  user?: string;
  /** Gmail: the owner's "Desktop app" OAuth client id (not secret); tokens are in `Secrets`. */
  clientId?: string;
}

/**
 * The candidate's one connected mailbox. `cursor` is where the last sync stopped: a Gmail
 * historyId, or `<uidvalidity>:<uid>` on IMAP; null until the first sync.
 */
export const mailboxes = sqliteTable('mailboxes', {
  id: integer('id').primaryKey(),
  kind: text('kind', { enum: MAILBOX_KINDS }).notNull(),
  address: text('address').notNull(),
  settings: text('settings', { mode: 'json' }).$type<MailboxSettings>().notNull(),
  /** connecting (Google consent still open) · connected · failed (see note) */
  status: text('status', { enum: ['connecting', 'connected', 'failed'] })
    .notNull()
    .default('connected'),
  cursor: text('cursor'),
  syncedAt: integer('synced_at', { mode: 'timestamp_ms' }),
  note: text('note'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

/** What email_classify says a reply is. `unknown`: it couldn't tell (or wasn't asked). */
export const EMAIL_LABELS = [
  'rejection',
  'interview',
  'offer',
  'acknowledgement',
  'security_code',
  'other',
  'unknown',
] as const;
export type EmailLabel = (typeof EMAIL_LABELS)[number];

/**
 * matched    linked to an application on its own (its status may have moved)
 * ask        in the "Which application is this?" queue
 * assigned   the candidate linked it (or said it belongs to none: application_id null)
 */
/** A time as Google Calendar takes it: a timed start (local time + IANA zone, or UTC) or a day. */
export interface EventTime {
  dateTime?: string;
  timeZone?: string;
  date?: string;
}

export interface EmailInvite {
  start: EventTime;
  end: EventTime;
  summary: string | null;
  location: string | null;
  /** The invite's own UID (the organiser's calendar). */
  uid: string | null;
}

/**
 * created    the event exists on the candidate's calendar
 * cancelled  the candidate deleted it there; it's never made again
 * skipped    no Google account, or no time in the invite (note says which)
 */
export interface EmailCalendar {
  status: 'created' | 'cancelled' | 'skipped';
  eventId: string | null;
  link: string | null;
  note: string | null;
}

export const EMAIL_STATUSES = ['matched', 'ask', 'assigned'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/**
 * Replies that look like they're about an application (a company or ATS sender, a reply to
 * an application email). Other mail is never stored.
 */
export const emails = sqliteTable(
  'emails',
  {
    id: integer('id').primaryKey(),
    mailboxId: integer('mailbox_id')
      .notNull()
      .references(() => mailboxes.id, { onDelete: 'cascade' }),
    /** The provider's id (Gmail message id, IMAP `<uidvalidity>:<uid>`): one row per message. */
    messageKey: text('message_key').notNull(),
    messageId: text('message_id'),
    inReplyTo: text('in_reply_to'),
    fromAddress: text('from_address').notNull(),
    fromName: text('from_name'),
    subject: text('subject').notNull(),
    /** Plain text, trimmed. */
    text: text('text').notNull(),
    receivedAt: integer('received_at', { mode: 'timestamp_ms' }).notNull(),
    label: text('label', { enum: EMAIL_LABELS }).notNull(),
    confidence: real('confidence'),
    /** The route that classified it ("apple", "claude:haiku"), or null when nothing could. */
    classifiedBy: text('classified_by'),
    language: text('language'),
    applicationId: integer('application_id').references(() => applications.id, {
      onDelete: 'set null',
    }),
    status: text('status', { enum: EMAIL_STATUSES }).notNull(),
    /** Applications it might belong to, best first (the ask queue offers these). */
    candidates: text('candidates', { mode: 'json' }).$type<number[]>().notNull(),
    /** Why it was matched, or why it's asked about. */
    note: text('note'),
    /** An interview invite's time, from the email's calendar attachment (.ics), if it had one. */
    invite: text('invite', { mode: 'json' }).$type<EmailInvite | null>(),
    /** The Google Calendar event made for an interview invite (integrations/gcal.ts). */
    calendar: text('calendar', { mode: 'json' }).$type<EmailCalendar | null>(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (t) => [
    uniqueIndex('emails_mailbox_message_unique').on(t.mailboxId, t.messageKey),
    index('emails_status_idx').on(t.status),
    index('emails_application_idx').on(t.applicationId),
  ],
);

// ---- Guarded platforms (phase 14) ----------------------------------------------------------

export const PLATFORM_KEYS = ['linkedin', 'xing'] as const;
export type PlatformKey = (typeof PLATFORM_KEYS)[number];
export const PLATFORM_ACTIONS = ['search', 'apply'] as const;
export type PlatformAction = (typeof PLATFORM_ACTIONS)[number];

/**
 * LinkedIn and Xing, run under the candidate's own session with guardrails
 * (browser/guardrails.ts): daily caps (null = the default), a pause after any challenge, and
 * when Applyant's profile was last signed in there.
 */
export const platforms = sqliteTable('platforms', {
  platform: text('platform', { enum: PLATFORM_KEYS }).primaryKey(),
  searchesPerDay: integer('searches_per_day'),
  applicationsPerDay: integer('applications_per_day'),
  /** Set when a checkpoint / verification / unusual captcha stopped a task; cleared by resume. */
  pausedAt: integer('paused_at', { mode: 'timestamp_ms' }),
  pauseReason: text('pause_reason'),
  signedInAt: integer('signed_in_at', { mode: 'timestamp_ms' }),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

/** One guarded search or application started on a platform: what the daily caps count. */
export const platformActions = sqliteTable(
  'platform_actions',
  {
    id: integer('id').primaryKey(),
    platform: text('platform', { enum: PLATFORM_KEYS }).notNull(),
    action: text('action', { enum: PLATFORM_ACTIONS }).notNull(),
    taskId: integer('task_id'),
    at: integer('at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('platform_actions_at').on(t.platform, t.action, t.at)],
);

/** Small daemon-internal state, key → JSON (e.g. which embedder made the fact vectors). */
export const appState = sqliteTable('app_state', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
});

export type PostingRow = typeof postings.$inferSelect;
export type PlatformRow = typeof platforms.$inferSelect;
export type PostingSourceRow = typeof postingSources.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type SourceRow = typeof sources.$inferSelect;
export type FactRow = typeof facts.$inferSelect;
export type EvidenceRow = typeof evidence.$inferSelect;
export type AgentRunRow = typeof agentRuns.$inferSelect;
export type ApplicationContactRow = typeof applicationContacts.$inferSelect;
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
export type InterviewQuestionRow = typeof interviewQuestions.$inferSelect;
export type InterviewTurnRow = typeof interviewTurns.$inferSelect;
export type SearchSourceRow = typeof searchSources.$inferSelect;
export type SearchStrategyRow = typeof searchStrategies.$inferSelect;
export type SearchRunRow = typeof searchRuns.$inferSelect;
export type ListingRecipeRow = typeof listingRecipes.$inferSelect;
export type SearchPlanRow = typeof searchPlans.$inferSelect;
export type RoleRouteRow = typeof roleRoutes.$inferSelect;
export type CompanyRow = typeof companies.$inferSelect;
export type MailboxRow = typeof mailboxes.$inferSelect;
export type EmailRow = typeof emails.$inferSelect;
