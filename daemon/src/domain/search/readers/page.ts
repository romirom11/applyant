// The generic reader for a career page (or a feed URL): a feed first (the URL itself, JobPosting
// JSON-LD on the page, or a feed the page advertises), then a known ATS embed read through that
// ATS's list API. Pages that only show their embed once scripts run are rendered in the headless
// reader. What worked is cached on the source, so later runs go straight to it.
//
// Pages with neither (plain HTML lists) are read by their listing recipe (phase 11), which
// reader_builder writes once; a page with no recipe yet, or whose recipe fails its checks, says
// so (NeedsRecipeError) and the search run asks for a build.
import type { ResolvedSource } from '../../../db/schema.ts';
import { openListing } from '../recipes/page.ts';
import { checkInvariants, runRecipe, toReaderRun } from '../recipes/run.ts';
import type { RecipeForRun } from '../recipes/store.ts';
import type { RecipeListing } from '../recipes/types.ts';
import { type AtsRun, readAtsBoard } from './ats-api.ts';
import { detectAtsBoard } from './ats-embed.ts';
import { feedLinks, parseFeed, readFeed } from './feed.ts';
import { get } from './http.ts';
import type { ReaderContext, ReaderRun } from './types.ts';

export interface PageRun extends ReaderRun {
  /** How the page was read, for the next run; null when nothing was found. */
  resolved: ResolvedSource;
  company: string | null;
  /** Read by its listing recipe: what it read (the sample check picks from these). */
  recipe?: { id: number; listings: RecipeListing[] };
}

/** The page can't be read without a (new) listing recipe. */
export class NeedsRecipeError extends Error {
  readonly reason: 'none' | 'broken';
  constructor(reason: 'none' | 'broken', message: string) {
    super(message);
    this.name = 'NeedsRecipeError';
    this.reason = reason;
  }
}

const NO_WAY =
  'no feed, JobPosting data or known ATS board (Greenhouse, Ashby, Lever, Workable) on this page';

/** Reads the page with its recipe; the invariants decide whether the result can be trusted. */
async function viaRecipe(url: string, ctx: ReaderContext, recipe: RecipeForRun): Promise<PageRun> {
  if (!recipe.recipe) throw new NeedsRecipeError('none', `${NO_WAY}: it needs a listing recipe`);
  const r = recipe.recipe;
  if (!ctx.reader) throw new Error('the headless reader is not available for its listing recipe');
  const result = await ctx.reader.withPage(
    async (p) => {
      await openListing(p, url);
      return runRecipe(p, r, { paginate: true, signal: ctx.signal });
    },
    { signal: ctx.signal },
  );
  const problems = checkInvariants({
    listings: result.listings,
    pageUrl: url,
    lastCount: recipe.lastCount,
  });
  if (problems.length) {
    throw new NeedsRecipeError(
      'broken',
      `its listing recipe failed its checks: ${problems.join('; ')}`,
    );
  }
  const how =
    result.pages > 1
      ? ` over ${result.pages} pages`
      : result.scrolls > 0
        ? ` over ${result.scrolls} scrolls`
        : '';
  return {
    ...toReaderRun(result.listings, `listing recipe: ${result.listings.length} jobs${how}`),
    resolved: { via: 'recipe' },
    company: null,
    recipe: { id: recipe.id, listings: result.listings },
  };
}

function fromAts(run: AtsRun, resolved: ResolvedSource, how: string): PageRun {
  return { ...run, resolved, company: run.company, note: `${how}: ${run.note ?? ''}`.trim() };
}

async function viaAts(
  board: { ats: 'greenhouse' | 'ashby' | 'lever' | 'workable'; token: string },
  ctx: ReaderContext,
  how: string,
): Promise<PageRun> {
  const run = await readAtsBoard(board.ats, board.token, ctx);
  return fromAts(run, { via: 'ats', ats: board.ats, token: board.token }, how);
}

/** The way that worked last time; null when it no longer does (the page changed). */
async function viaCache(cached: ResolvedSource, ctx: ReaderContext): Promise<PageRun | null> {
  try {
    if (cached.via === 'ats')
      return await viaAts(cached, ctx, `${cached.ats} board ${cached.token}`);
    if (cached.via === 'feed') {
      const feed = await readFeed(cached.url, ctx);
      if (feed.listings.length === 0 && feed.format === 'json-ld') return null;
      return { ...feed, resolved: cached, company: feed.title };
    }
  } catch {
    ctx.signal.throwIfAborted();
  }
  return null;
}

export async function readPage(
  url: string,
  ctx: ReaderContext,
  cached: ResolvedSource | null = null,
  recipe: RecipeForRun | null = null,
): Promise<PageRun> {
  // A page read by its recipe goes straight to it; while the recipe is being (re)built the page
  // isn't read.
  if (recipe?.status === 'building') {
    throw new NeedsRecipeError('none', 'its listing recipe is being built');
  }
  if (cached?.via === 'recipe' && recipe?.status === 'ok') return viaRecipe(url, ctx, recipe);
  if (cached && cached.via !== 'recipe') {
    const hit = await viaCache(cached, ctx);
    if (hit) return hit;
  }
  const page = await get(ctx.fetch, url, ctx.signal, {
    accept: 'text/html,application/xhtml+xml,application/json,application/rss+xml,*/*;q=0.8',
  });

  // 1. A feed: the URL is one, or the page carries its jobs as JobPosting JSON-LD.
  const feed = parseFeed(page.text, page.contentType, page.url, ctx.now);
  if (feed && (feed.listings.length > 0 || feed.format !== 'json-ld')) {
    return {
      listings: feed.listings,
      complete: feed.complete,
      resolved: { via: 'feed', url: page.url, format: feed.format },
      company: feed.title,
      note: `${feed.format}: ${feed.listings.length} jobs${feed.complete ? '' : ' (one page of several)'}`,
    };
  }
  //    …or advertises a feed.
  for (const link of feedLinks(page.text, page.url).slice(0, 3)) {
    try {
      const linked = await readFeed(link, ctx);
      if (linked.listings.length === 0) continue;
      return {
        ...linked,
        resolved: { via: 'feed', url: link, format: linked.format },
        company: linked.title,
      };
    } catch {
      ctx.signal.throwIfAborted();
    }
  }

  // 2. A known ATS board, embedded or linked.
  const board = detectAtsBoard(page.text, [page.url]);
  if (board) return viaAts(board, ctx, `embedded ${board.ats} board ${board.token}`);

  // 3. The same, once the page's scripts have run (embeds injected by JavaScript).
  if (ctx.reader) {
    const rendered = await ctx.reader.withPage(
      async (p) => {
        // Many career pages fetch their jobs from the ATS in the browser: those requests name
        // the board as surely as an embed does.
        const requests: string[] = [];
        p.on('request', (r) => {
          if (requests.length < 500) requests.push(r.url());
        });
        await p.goto(url, { waitUntil: 'domcontentloaded' });
        await p.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
        const frames = p.frames().map((f) => f.url());
        return { html: await p.content(), urls: [...frames, ...requests], at: p.url() };
      },
      { signal: ctx.signal },
    );
    const jsonLd = parseFeed(rendered.html, 'text/html', rendered.at, ctx.now);
    if (jsonLd && jsonLd.listings.length > 0) {
      return {
        listings: jsonLd.listings,
        complete: jsonLd.complete,
        // Rendered JSON-LD can't be fetched without the browser: don't cache it as a feed.
        resolved: { via: 'feed', url: rendered.at, format: 'json-ld' },
        company: null,
        note: `rendered page, json-ld: ${jsonLd.listings.length} jobs`,
      };
    }
    const renderedBoard = detectAtsBoard(rendered.html, rendered.urls);
    if (renderedBoard) {
      return viaAts(
        renderedBoard,
        ctx,
        `embedded ${renderedBoard.ats} board ${renderedBoard.token} (rendered)`,
      );
    }
  }

  if (recipe?.status === 'ok') return viaRecipe(url, ctx, recipe);
  throw new NeedsRecipeError(
    'none',
    recipe?.status === 'failed'
      ? `${NO_WAY}, and no listing recipe could be built: ${recipe.note ?? 'no reason given'}`
      : `${NO_WAY}: it needs a listing recipe`,
  );
}
