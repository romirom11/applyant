// Listing recipes in SQLite: asking for a build (throttled, so a page that can't be read doesn't
// cost a model run on every search), saving what a build made, and what the Search screen and
// `search sources show` read.
import { and, eq, inArray } from 'drizzle-orm';
import type { Conn } from '../../../db/client.ts';
import {
  type ListingRecipeRow,
  listingRecipes,
  type SearchSourceRow,
  searchSources,
  searchStrategies,
  tasks,
} from '../../../db/schema.ts';
import type { Tx } from '../../../queue/types.ts';
import { selects } from '../sources.ts';
import type { ListingRecipe, RecipeListing } from './types.ts';

/** A page no recipe could be built for is tried again after this long. */
export const RECIPE_RETRY_MS = 3 * 24 * 3_600_000;
/** A recipe that breaks within this long of being built isn't rebuilt at once (no build loops). */
export const REBUILD_GRACE_MS = 24 * 3_600_000;
/** How often a sample of a recipe's listings is checked ("is this a job title and link?"). */
export const SAMPLE_EVERY_MS = 3 * 24 * 3_600_000;

/** A recipe as a search read needs it (no fixture). */
export interface RecipeForRun {
  id: number;
  sourceId: number;
  recipe: ListingRecipe | null;
  status: ListingRecipeRow['status'];
  lastCount: number | null;
  lastSampledAt: Date | null;
  note: string | null;
}

const runColumns = {
  id: listingRecipes.id,
  sourceId: listingRecipes.sourceId,
  recipe: listingRecipes.recipe,
  status: listingRecipes.status,
  lastCount: listingRecipes.lastCount,
  lastSampledAt: listingRecipes.lastSampledAt,
  note: listingRecipes.note,
};

export function recipesFor(conn: Conn, sourceIds: number[]): Map<number, RecipeForRun> {
  if (sourceIds.length === 0) return new Map();
  return new Map(
    conn
      .select(runColumns)
      .from(listingRecipes)
      .where(inArray(listingRecipes.sourceId, sourceIds))
      .all()
      .map((r) => [r.sourceId, r]),
  );
}

export function recipeRow(conn: Conn, sourceId: number): ListingRecipeRow | null {
  return (
    conn.select().from(listingRecipes).where(eq(listingRecipes.sourceId, sourceId)).get() ?? null
  );
}

function buildBusy(conn: Conn, sourceId: number): boolean {
  return !!conn
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.kind, 'build_recipe'),
        eq(tasks.entityId, sourceId),
        inArray(tasks.status, ['queued', 'running']),
      ),
    )
    .get();
}

export type RecipeRequest =
  /** The page has no feed, JobPosting data or known ATS board. */
  | { kind: 'none'; detail: string }
  /** Its recipe failed the invariants (or the sample check). */
  | { kind: 'broken'; detail: string };

/**
 * Asks for a build_recipe task for a page, unless one is waiting, the last build failed not
 * long ago, or the recipe broke right after being built. Returns whether a build was queued.
 * `force` (the candidate's "rebuild") skips the waiting periods.
 */
export function requestRecipe(
  tx: Tx,
  source: Pick<SearchSourceRow, 'id' | 'key' | 'kind'>,
  req: RecipeRequest,
  o: { force?: boolean } = {},
): boolean {
  if (source.kind !== 'page') return false;
  if (buildBusy(tx.db, source.id)) return false;
  const row = recipeRow(tx.db, source.id);
  const now = tx.now.getTime();
  if (!o.force && row) {
    if (
      row.status === 'failed' &&
      row.lastBuildAt &&
      now - row.lastBuildAt.getTime() < RECIPE_RETRY_MS
    ) {
      return false;
    }
    if (req.kind === 'broken' && row.builtAt && now - row.builtAt.getTime() < REBUILD_GRACE_MS) {
      tx.db
        .update(listingRecipes)
        .set({
          status: 'failed',
          lastBuildAt: tx.now,
          note: `broke within a day of being built (${req.detail}); tried again in a few days`,
        })
        .where(eq(listingRecipes.id, row.id))
        .run();
      emitRecipe(
        tx,
        source,
        'failed',
        `${source.key}: its new recipe broke at once (${req.detail})`,
      );
      return false;
    }
  }
  const note =
    req.kind === 'broken' ? `rebuilding: ${req.detail}` : `building a recipe: ${req.detail}`;
  if (row) {
    tx.db
      .update(listingRecipes)
      .set({ status: 'building', note })
      .where(eq(listingRecipes.id, row.id))
      .run();
  } else {
    tx.db
      .insert(listingRecipes)
      .values({ sourceId: source.id, status: 'building', note, createdAt: tx.now })
      .run();
  }
  tx.enqueue('build_recipe', source.id);
  emitRecipe(tx, source, 'building', `${source.key}: ${note}`);
  return true;
}

export function emitRecipe(
  tx: Tx,
  source: Pick<SearchSourceRow, 'id'>,
  stage: 'building' | 'built' | 'failed',
  message: string,
): void {
  tx.emit({ kind: 'search.recipe', entityId: source.id, stage, message });
}

export interface BuiltRecipe {
  recipe: ListingRecipe;
  fixtureUrl: string;
  fixtureHtml: string | null;
  expected: RecipeListing[];
  /** Listings of the whole list (all pages) when it was built. */
  count: number;
  note: string;
}

/**
 * Saves a verified recipe: the page is read by it from now on, and every active strategy that
 * reads this page runs at its next tick (its listings were missing from the run that asked).
 */
export function saveRecipe(tx: Tx, source: SearchSourceRow, built: BuiltRecipe): void {
  const values = {
    recipe: built.recipe,
    status: 'ok' as const,
    fixtureUrl: built.fixtureUrl,
    fixtureHtml: built.fixtureHtml,
    expected: built.expected,
    lastCount: built.count,
    builtAt: tx.now,
    // The model just looked at the page: no sample check is due yet.
    lastSampledAt: tx.now,
    lastBuildAt: tx.now,
    note: built.note,
  };
  const row = recipeRow(tx.db, source.id);
  if (row) {
    tx.db
      .update(listingRecipes)
      .set({ ...values, builds: row.builds + 1 })
      .where(eq(listingRecipes.id, row.id))
      .run();
  } else {
    tx.db
      .insert(listingRecipes)
      .values({ sourceId: source.id, ...values, builds: 1, createdAt: tx.now })
      .run();
  }
  tx.db
    .update(searchSources)
    .set({ resolved: { via: 'recipe' }, lastNote: `listing recipe built: ${built.note}` })
    .where(eq(searchSources.id, source.id))
    .run();
  makeDue(tx, source);
  emitRecipe(tx, source, 'built', `${source.key}: ${built.note}`);
}

/** No recipe this time: the reason is kept, and the page is tried again after RECIPE_RETRY_MS. */
export function saveRecipeFailure(tx: Tx, source: SearchSourceRow, reason: string): void {
  const row = recipeRow(tx.db, source.id);
  const values = { status: 'failed' as const, lastBuildAt: tx.now, note: reason };
  if (row) {
    tx.db
      .update(listingRecipes)
      .set({ ...values, builds: row.builds + 1 })
      .where(eq(listingRecipes.id, row.id))
      .run();
  } else {
    tx.db
      .insert(listingRecipes)
      .values({ sourceId: source.id, ...values, builds: 1, createdAt: tx.now })
      .run();
  }
  tx.db
    .update(searchSources)
    .set({ lastNote: `no listing recipe: ${reason}` })
    .where(eq(searchSources.id, source.id))
    .run();
  emitRecipe(tx, source, 'failed', `${source.key}: ${reason}`);
}

/** Active strategies that read this source run at the scheduler's next tick. */
function makeDue(tx: Tx, source: SearchSourceRow): void {
  const due = tx.db
    .select()
    .from(searchStrategies)
    .where(eq(searchStrategies.state, 'active'))
    .all()
    .filter((s) => s.sources.some((sel) => selects(sel, source)));
  for (const s of due) {
    if (s.nextRunAt.getTime() <= tx.now.getTime()) continue;
    tx.db
      .update(searchStrategies)
      .set({ nextRunAt: tx.now })
      .where(eq(searchStrategies.id, s.id))
      .run();
  }
}

/** After a good read: the count the next read is compared with, and a sample check's time. */
export function recordRecipeRead(
  tx: Tx,
  recipeId: number,
  o: { count: number; sampled: boolean },
): void {
  tx.db
    .update(listingRecipes)
    .set({ lastCount: o.count, ...(o.sampled ? { lastSampledAt: tx.now } : {}) })
    .where(eq(listingRecipes.id, recipeId))
    .run();
}

/** Every recipe without its fixture (the Search screen), by source id. */
export function recipeSummaries(
  conn: Conn,
): Map<number, Omit<ListingRecipeRow, 'fixtureHtml' | 'expected' | 'fixtureUrl'>> {
  return new Map(
    conn
      .select({
        id: listingRecipes.id,
        sourceId: listingRecipes.sourceId,
        recipe: listingRecipes.recipe,
        status: listingRecipes.status,
        lastCount: listingRecipes.lastCount,
        builtAt: listingRecipes.builtAt,
        lastSampledAt: listingRecipes.lastSampledAt,
        lastBuildAt: listingRecipes.lastBuildAt,
        builds: listingRecipes.builds,
        note: listingRecipes.note,
        createdAt: listingRecipes.createdAt,
      })
      .from(listingRecipes)
      .all()
      .map((r) => [r.sourceId, r]),
  );
}
