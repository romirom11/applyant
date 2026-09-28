// Search strategies: which sources, which queries, how often, and how well each one does.
// A strategy is a row the candidate (and, from phase 11, the search_planner) can see and edit.
// The scheduler starts a run when its time comes; a run is one `search` task whose run_id
// every task it spawns carries.
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Conn } from '../../db/client.ts';
import {
  postings,
  type SearchRunRow,
  type SearchRunTrigger,
  type SearchStrategyRow,
  type StrategyState,
  searchRuns,
  searchStrategies,
  strategyPostings,
  tasks,
} from '../../db/schema.ts';
import type { Tx } from '../../queue/types.ts';
import type { Listing } from './readers/types.ts';
import {
  NO_STATS,
  SearchError,
  type SearchStats,
  sourcesFor,
  statsColumns,
  validateSelectors,
} from './sources.ts';

export const DEFAULT_EVERY_MINUTES = 360;
/** Boards ask for polite polling (Jobicy: at most hourly). */
export const MIN_EVERY_MINUTES = 60;

/** "6h" · "90m" · "1d" · "360" (minutes) → minutes. */
export function parseEvery(text: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hours?|d|days?)?\s*$/i.exec(text);
  if (!m) throw new SearchError(`"${text}" is not a schedule (e.g. 6h, 90m, 1d)`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'm').toLowerCase()[0];
  const minutes = Math.round(unit === 'd' ? n * 1440 : unit === 'h' ? n * 60 : n);
  if (minutes < MIN_EVERY_MINUTES) {
    throw new SearchError(`strategies run at most every ${MIN_EVERY_MINUTES} minutes`);
  }
  return minutes;
}

export function formatEvery(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

// ---- Matching listings to a strategy ------------------------------------------------------

function fold(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function tokens(text: string): string[] {
  return fold(text)
    .replace(/[^\p{L}\p{N}+#-]+/gu, ' ')
    .split(' ')
    .filter(Boolean);
}

function hasWord(hay: string[], token: string): boolean {
  // Longer words match as prefixes: "engineer" finds "engineering", "dev" finds "developer".
  return hay.some((w) => w === token || (token.length >= 3 && w.startsWith(token)));
}

/**
 * Does a listing belong to the strategy? Every word of one query must be in its title (words
 * with a leading "-" must not be), and its location must name one of the strategy's places
 * ("remote" matches remote jobs). A listing that says nothing about where passes.
 */
export function matchesStrategy(
  l: Listing,
  s: Pick<SearchStrategyRow, 'queries' | 'locations'>,
): boolean {
  if (s.queries.length) {
    const hay = tokens(l.matchText ?? `${l.title} ${l.team ?? ''}`).map((w) =>
      w.replace(/^-+|-+$/g, ''),
    );
    const hit = s.queries.some((q) => {
      const words = tokens(q);
      const plus = words.filter((w) => !w.startsWith('-'));
      const minus = words
        .filter((w) => w.startsWith('-'))
        .map((w) => w.slice(1))
        .filter(Boolean);
      return (
        plus.every((w) => hasWord(hay, w.replace(/-+$/, ''))) && !minus.some((w) => hasWord(hay, w))
      );
    });
    if (!hit) return false;
  }
  if (s.locations.length) {
    if (!l.location && l.remote === null) return true;
    const where = fold(l.location ?? '');
    const remote = l.remote === true || /\b(remote|anywhere|worldwide)\b/.test(where);
    return s.locations.some((t) => {
      const term = fold(t.trim());
      return term === 'remote' ? remote : term.length > 0 && where.includes(term);
    });
  }
  return true;
}

// ---- Strategies ---------------------------------------------------------------------------

export function requireStrategy(conn: Conn, ref: string | number): SearchStrategyRow {
  const r = String(ref).trim();
  const row = /^\d+$/.test(r)
    ? conn
        .select()
        .from(searchStrategies)
        .where(eq(searchStrategies.id, Number(r)))
        .get()
    : conn.select().from(searchStrategies).where(eq(searchStrategies.name, r)).get();
  if (!row) throw new SearchError(`no search strategy "${r}"`);
  return row;
}

function cleanList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((v) => v.trim()).filter(Boolean))];
}

export interface StrategyInput {
  name: string;
  queries?: string[];
  locations?: string[];
  sources: string[];
  everyMinutes?: number;
  state?: StrategyState;
  origin?: 'candidate' | 'agent';
}

/** Adds a strategy; an active one runs right away (then on its schedule). */
export function addStrategy(
  tx: Tx,
  input: StrategyInput,
): { strategy: SearchStrategyRow; runId: number | null } {
  const name = input.name.trim();
  if (!name) throw new SearchError('a strategy needs a name');
  if (tx.db.select().from(searchStrategies).where(eq(searchStrategies.name, name)).get()) {
    throw new SearchError(`a strategy named "${name}" already exists`);
  }
  const every = input.everyMinutes ?? DEFAULT_EVERY_MINUTES;
  if (every < MIN_EVERY_MINUTES)
    throw new SearchError(`strategies run at most every ${MIN_EVERY_MINUTES} minutes`);
  const strategy = tx.db
    .insert(searchStrategies)
    .values({
      name,
      queries: cleanList(input.queries),
      locations: cleanList(input.locations),
      sources: validateSelectors(tx.db, input.sources),
      everyMinutes: every,
      state: input.state ?? 'active',
      origin: input.origin ?? 'candidate',
      nextRunAt: tx.now,
      createdAt: tx.now,
      updatedAt: tx.now,
    })
    .returning()
    .get();
  const runId = strategy.state === 'active' ? startSearchRun(tx, strategy, 'manual') : null;
  return { strategy: requireStrategy(tx.db, strategy.id), runId };
}

export interface StrategyPatch {
  name?: string;
  queries?: string[];
  locations?: string[];
  sources?: string[];
  everyMinutes?: number;
  state?: StrategyState;
}

export function updateStrategy(
  tx: Tx,
  ref: string | number,
  patch: StrategyPatch,
): SearchStrategyRow {
  const row = requireStrategy(tx.db, ref);
  const set: Partial<SearchStrategyRow> = { updatedAt: tx.now };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new SearchError('a strategy needs a name');
    const other = tx.db
      .select()
      .from(searchStrategies)
      .where(eq(searchStrategies.name, name))
      .get();
    if (other && other.id !== row.id)
      throw new SearchError(`a strategy named "${name}" already exists`);
    set.name = name;
  }
  if (patch.queries !== undefined) set.queries = cleanList(patch.queries);
  if (patch.locations !== undefined) set.locations = cleanList(patch.locations);
  if (patch.sources !== undefined) set.sources = validateSelectors(tx.db, patch.sources);
  if (patch.everyMinutes !== undefined) {
    if (patch.everyMinutes < MIN_EVERY_MINUTES) {
      throw new SearchError(`strategies run at most every ${MIN_EVERY_MINUTES} minutes`);
    }
    set.everyMinutes = patch.everyMinutes;
    // The new schedule counts from the last run.
    set.nextRunAt = new Date((row.lastRunAt ?? tx.now).getTime() + patch.everyMinutes * 60_000);
  }
  if (patch.state !== undefined && patch.state !== row.state) {
    set.state = patch.state;
    // Resumed: due now if its slot passed while it was paused.
    if (patch.state === 'active' && row.nextRunAt.getTime() < tx.now.getTime())
      set.nextRunAt = tx.now;
  }
  tx.db.update(searchStrategies).set(set).where(eq(searchStrategies.id, row.id)).run();
  tx.emit({
    kind: 'search.run',
    entityId: row.id,
    runId: null,
    stage: 'updated',
    message: `${set.name ?? row.name}: ${set.state ?? row.state}`,
  });
  return requireStrategy(tx.db, row.id);
}

export function deleteStrategy(tx: Tx, ref: string | number): SearchStrategyRow {
  const row = requireStrategy(tx.db, ref);
  tx.db.delete(searchStrategies).where(eq(searchStrategies.id, row.id)).run();
  tx.emit({
    kind: 'search.run',
    entityId: row.id,
    runId: null,
    stage: 'deleted',
    message: row.name,
  });
  return row;
}

function runBusy(conn: Conn, strategyId: number): boolean {
  return !!conn
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.kind, 'search'),
        eq(tasks.entityId, strategyId),
        inArray(tasks.status, ['queued', 'running']),
      ),
    )
    .get();
}

/**
 * Starts a run: a search_runs row and its `search` task. Null when the strategy already has
 * one waiting or running. The next scheduled run counts from now.
 */
export function startSearchRun(
  tx: Tx,
  strategy: SearchStrategyRow,
  trigger: SearchRunTrigger,
): number | null {
  if (runBusy(tx.db, strategy.id)) return null;
  const run = tx.db
    .insert(searchRuns)
    .values({ strategyId: strategy.id, trigger, status: 'queued', startedAt: tx.now })
    .returning({ id: searchRuns.id })
    .get();
  tx.db
    .update(searchStrategies)
    .set({ nextRunAt: new Date(tx.now.getTime() + strategy.everyMinutes * 60_000) })
    .where(eq(searchStrategies.id, strategy.id))
    .run();
  tx.enqueue('search', strategy.id, { runId: run.id });
  tx.emit({
    kind: 'search.run',
    runId: run.id,
    entityId: strategy.id,
    stage: 'queued',
    message: `${strategy.name}: ${trigger === 'wake' ? 'missed while asleep, running now' : trigger === 'manual' ? 'running now' : 'scheduled run'}`,
  });
  return run.id;
}

/**
 * Starts every active strategy whose time has come. A strategy whose slots passed while the
 * Mac slept runs once, not once per slot: the next run counts from now.
 */
export function scheduleDue(tx: Tx, trigger: 'schedule' | 'wake'): number[] {
  const due = tx.db
    .select()
    .from(searchStrategies)
    .where(and(eq(searchStrategies.state, 'active'), lte(searchStrategies.nextRunAt, tx.now)))
    .all();
  const started: number[] = [];
  for (const s of due) {
    const run = startSearchRun(tx, s, trigger);
    if (run !== null) started.push(run);
  }
  return started;
}

// ---- Views --------------------------------------------------------------------------------

export function strategyStats(conn: Conn): Map<number, SearchStats> {
  const rows = conn
    .select({ strategyId: strategyPostings.strategyId, ...statsColumns })
    .from(strategyPostings)
    .innerJoin(postings, eq(postings.id, strategyPostings.postingId))
    .groupBy(strategyPostings.strategyId)
    .all();
  return new Map(
    rows.map((r) => [
      r.strategyId,
      { found: r.found, verified: r.verified, interested: r.interested, skipped: r.skipped },
    ]),
  );
}

export interface StrategyView extends SearchStrategyRow {
  stats: SearchStats;
  lastRun: SearchRunRow | null;
  /** The source keys a run would query now (selected, switched on). */
  sourceKeys: string[];
  /** A run is waiting or running. */
  running: boolean;
}

function latestRuns(conn: Conn): Map<number, SearchRunRow> {
  const rows = conn
    .select()
    .from(searchRuns)
    .where(
      sql`${searchRuns.id} in (select max(id) from ${searchRuns} group by ${searchRuns.strategyId})`,
    )
    .all();
  return new Map(rows.map((r) => [r.strategyId, r]));
}

export function strategyView(conn: Conn, row: SearchStrategyRow): StrategyView {
  return {
    ...row,
    stats: strategyStats(conn).get(row.id) ?? NO_STATS,
    lastRun: latestRuns(conn).get(row.id) ?? null,
    sourceKeys: sourcesFor(conn, row.sources).map((s) => s.key),
    running: runBusy(conn, row.id),
  };
}

export function listStrategies(conn: Conn): StrategyView[] {
  const stats = strategyStats(conn);
  const last = latestRuns(conn);
  return conn
    .select()
    .from(searchStrategies)
    .orderBy(searchStrategies.id)
    .all()
    .map((row) => ({
      ...row,
      stats: stats.get(row.id) ?? NO_STATS,
      lastRun: last.get(row.id) ?? null,
      sourceKeys: sourcesFor(conn, row.sources).map((s) => s.key),
      running: runBusy(conn, row.id),
    }));
}

export interface RunView extends SearchRunRow {
  strategyName: string;
}

export function listRuns(conn: Conn, o: { strategyId?: number; limit?: number } = {}): RunView[] {
  const q = conn
    .select({ run: searchRuns, name: searchStrategies.name })
    .from(searchRuns)
    .innerJoin(searchStrategies, eq(searchStrategies.id, searchRuns.strategyId));
  return (o.strategyId === undefined ? q : q.where(eq(searchRuns.strategyId, o.strategyId)))
    .orderBy(desc(searchRuns.id))
    .limit(Math.min(Math.max(o.limit ?? 20, 1), 200))
    .all()
    .map((r) => ({ ...r.run, strategyName: r.name }));
}
