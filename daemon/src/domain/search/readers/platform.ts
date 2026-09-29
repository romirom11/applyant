// The guarded platforms as search sources (phase 14): LinkedIn's and Xing's own job search, read
// under the candidate's session in Applyant's browser profile. A read is one guarded action
// (`Guardrails.run(platform, 'search', …)`): it waits its turn in the platform's lane, counts
// against the daily search cap, paces between pages, and a checkpoint or captcha pauses the
// platform (the page is left open for the candidate) instead of being answered by anything.
//
// Each search page is read by a listing recipe (phase 11's `runRecipe`): the platform's built-in
// one, or a stored recipe for the source when one was built. Only the first page of each query
// is read (no pagination: a person looks at the first page), so the list is never complete and
// absence never closes a posting.
import type { Page } from 'playwright';
import {
  type GuardedSession,
  type Guardrails,
  PlatformChallenge,
  type PlatformKey,
  platformName,
} from '../../../browser/guardrails.ts';
import { openListing } from '../recipes/page.ts';
import { checkInvariants, runRecipe } from '../recipes/run.ts';
import type { ListingRecipe, RecipeListing } from '../recipes/types.ts';
import type { Listing, ReaderContext, ReaderRun } from './types.ts';

/** How one platform's job search is read. */
export interface PlatformSearch {
  platform: PlatformKey;
  /** The search page for one query (and the strategy's locations). */
  searchUrl(query: string, locations: string[]): string;
  /** The built-in recipe for its result list. */
  recipe: ListingRecipe;
  /** CSS, inside one result: the company's name (the recipe has no company field). */
  company: string;
  /** The job's stable page (tracking parameters dropped) and the platform's id for it. */
  jobPage(url: string): { url: string; id: string } | null;
}

/** What a platform read needs besides the ordinary reader context. */
export interface PlatformAccess {
  guardrails: Guardrails;
  /** Runs `fn` on a page of Applyant's signed-in profile; `keepOpen` leaves it for the candidate. */
  browse<T>(fn: (page: Page) => Promise<{ result: T; keepOpen: boolean }>): Promise<T>;
  /** Tests only: a task's pacing, cap and lane come from `guardrails`; this is the task's id. */
  taskId?: number;
}

/** Queries read per run: each is a search page on the platform, paced like a person. */
export const MAX_QUERIES_PER_RUN = 3;

const REMOTE = /^(remote|anywhere|worldwide|remote[ -]?only)$/i;

/** The first place a strategy names that the platform's location box can take. */
export function placeOf(locations: string[]): string | null {
  return locations.map((l) => l.trim()).find((l) => l && !REMOTE.test(l)) ?? null;
}

export function wantsRemote(locations: string[]): boolean {
  return locations.some((l) => REMOTE.test(l.trim()));
}

/** Company names per job page, read off the result list the recipe read. */
async function companies(page: Page, s: PlatformSearch): Promise<Map<string, string>> {
  const recipe = s.recipe;
  if (recipe.kind !== 'locators' || !('css' in recipe.item)) return new Map();
  const pairs = await page
    .locator(recipe.item.css)
    .evaluateAll(
      (items, sel) =>
        items.map((item) => {
          const link = item.querySelector<HTMLAnchorElement>('a[href]');
          const company = item.querySelector<HTMLElement>(sel);
          return [link?.href ?? '', company?.innerText.trim() ?? ''] as [string, string];
        }),
      s.company,
    )
    .catch(() => [] as [string, string][]);
  const out = new Map<string, string>();
  for (const [href, company] of pairs) {
    const job = href ? s.jobPage(href) : null;
    if (job && company) out.set(job.url, company);
  }
  return out;
}

function toListing(l: RecipeListing, s: PlatformSearch, company: string | null): Listing | null {
  const job = s.jobPage(l.url);
  if (!job) return null;
  return {
    url: job.url,
    sourceUrl: job.url,
    externalId: `${s.platform}:${job.id}`,
    title: l.title,
    company,
    location: l.location,
    remote: l.location ? /\b(remote|anywhere|worldwide)\b/i.test(l.location) || null : null,
    team: null,
    description: null,
    applyUrl: null,
    postedAt: null,
  };
}

/** One search page: open, check for a challenge, read the list with the recipe. */
async function readSearchPage(
  page: Page,
  url: string,
  s: PlatformSearch,
  recipe: ListingRecipe,
  session: GuardedSession,
  signal: AbortSignal,
): Promise<Listing[]> {
  await openListing(page, url);
  await session.checkChallenge(page);
  await session.pace();
  const read = await runRecipe(page, recipe, { paginate: false, signal });
  const problems = checkInvariants({
    listings: read.listings,
    pageUrl: page.url(),
    lastCount: null,
  });
  if (problems.length) {
    // A result page the recipe can't make sense of may be a challenge in disguise.
    await session.checkChallenge(page);
    throw new Error(`the ${platformName(s.platform)} search page: ${problems.join('; ')}`);
  }
  const names = await companies(page, s);
  const out: Listing[] = [];
  for (const l of read.listings) {
    const job = s.jobPage(l.url);
    const listing = toListing(l, s, job ? (names.get(job.url) ?? null) : null);
    if (listing) out.push(listing);
  }
  return out;
}

/**
 * Reads the platform's search for the strategy's queries (at most MAX_QUERIES_PER_RUN), as one
 * guarded search. `recipe` is a stored recipe for the source, used instead of the built-in one.
 */
export async function readPlatform(
  s: PlatformSearch,
  ctx: ReaderContext,
  recipe: ListingRecipe | null = null,
): Promise<ReaderRun> {
  const access = ctx.platform;
  const name = platformName(s.platform);
  if (!access) throw new Error(`${name} is read in Applyant's browser, which isn't available`);
  const queries = [...new Set(ctx.queries.map((q) => q.trim()).filter(Boolean))];
  if (queries.length === 0) {
    return { listings: [], complete: false, note: `${name}: the strategy has no queries` };
  }
  // More queries than a run reads: each run starts further along, so all of them get their turn.
  const start = Math.floor(ctx.now.getTime() / 3_600_000) % queries.length;
  const reading = [...queries.slice(start), ...queries.slice(0, start)].slice(
    0,
    MAX_QUERIES_PER_RUN,
  );
  const use = recipe ?? s.recipe;
  const listings = await access.guardrails.run(
    s.platform,
    'search',
    (session) =>
      access
        .browse<Listing[] | PlatformChallenge>(async (page) => {
          const seen = new Set<string>();
          const out: Listing[] = [];
          try {
            for (const q of reading) {
              ctx.signal.throwIfAborted();
              if (out.length) await session.pace();
              const found = await readSearchPage(
                page,
                s.searchUrl(q, ctx.locations ?? []),
                s,
                use,
                session,
                ctx.signal,
              );
              for (const l of found) {
                if (seen.has(l.url)) continue;
                seen.add(l.url);
                out.push(l);
              }
            }
          } catch (err) {
            // A challenge stays on screen for the candidate to answer; guardrails pause the platform.
            if (err instanceof PlatformChallenge) return { result: err, keepOpen: true };
            throw err;
          }
          return { result: out, keepOpen: false };
        })
        .then((r) => {
          if (r instanceof PlatformChallenge) throw r;
          return r;
        }),
    { signal: ctx.signal, ...(access.taskId !== undefined ? { taskId: access.taskId } : {}) },
  );
  const skipped = queries.length - reading.length;
  return {
    listings,
    complete: false,
    note: `${name} search: ${listings.length} jobs for ${reading.length} quer${reading.length === 1 ? 'y' : 'ies'}${skipped ? ` (${skipped} more in later runs)` : ''}`,
  };
}
