// The generic reader for a career page (or a feed URL): a feed first (the URL itself, JobPosting
// JSON-LD on the page, or a feed the page advertises), then a known ATS embed read through that
// ATS's list API. Pages that only show their embed once scripts run are rendered in the headless
// reader. What worked is cached on the source, so later runs go straight to it.
//
// Pages with neither (plain HTML lists) need a listing recipe, which comes with phase 11.
import type { ResolvedSource } from '../../../db/schema.ts';
import { type AtsRun, readAtsBoard } from './ats-api.ts';
import { detectAtsBoard } from './ats-embed.ts';
import { feedLinks, parseFeed, readFeed } from './feed.ts';
import { get } from './http.ts';
import type { ReaderContext, ReaderRun } from './types.ts';

export interface PageRun extends ReaderRun {
  /** How the page was read, for the next run; null when nothing was found. */
  resolved: ResolvedSource;
  company: string | null;
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
): Promise<PageRun> {
  if (cached) {
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

  throw new Error(
    'no feed, JobPosting data or known ATS board (Greenhouse, Ashby, Lever, Workable) on this page; other pages need a listing recipe (phase 11)',
  );
}
