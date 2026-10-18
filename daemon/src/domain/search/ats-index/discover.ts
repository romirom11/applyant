// Discovery (index_discover): where the ATS index finds company boards.
//
//   Applyant's own data  the watch list's ATS boards and the career pages that read one, the
//                        job pages and apply links of postings, and the URLs their sources
//                        listed them under
//   Common Crawl         its URL index (the CDX API at index.commoncrawl.org: free, of pages a
//                        robots-respecting crawler fetched) over the ATS hosts in CDX_PATTERNS,
//                        in the latest three crawls: each pattern's page count, then its pages,
//                        streamed, one request every 2 s. The service is often overloaded
//                        (502/504): a request is retried with a backoff, and whatever still
//                        fails is noted and skipped; what the rest found is added all the same
//
// Weekly by itself (and once when none has run yet), or when the candidate asks. New boards are
// `new` and due at once: the crawler's first read tells real boards from stale URLs (404: gone).
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Conn } from '../../../db/client.ts';
import {
  type AtsDiscoveryRow,
  atsDiscoveries,
  postingSources,
  postings,
  searchSources,
  tasks,
} from '../../../db/schema.ts';
import type { Handler, Tx } from '../../../queue/types.ts';
import { type Ats, type AtsBoard, atsJobKey, boardFromUrl } from '../readers/ats-embed.ts';
import { USER_AGENT } from '../readers/http.ts';
import { sleep } from '../readers/shared.ts';
import type { Fetch } from '../readers/types.ts';
import { isAts } from '../sources.ts';
import { boardKey, indexWanted, knowBoards, type NewBoard } from './store.ts';

/** Once a discovery has run, the next starts this long after it. */
export const DISCOVER_EVERY_MS = 7 * 24 * 3_600_000;

/**
 * The URL patterns that hold each ATS's boards in Common Crawl's index. A new ATS joins
 * discovery with its entry here (boardFromUrl must know its URLs).
 */
export const CDX_PATTERNS: Partial<Record<Ats, string[]>> = {
  greenhouse: [
    'job-boards.greenhouse.io/*',
    'boards.greenhouse.io/*',
    'job-boards.eu.greenhouse.io/*',
  ],
  ashby: ['jobs.ashbyhq.com/*'],
  lever: ['jobs.lever.co/*', 'jobs.eu.lever.co/*'],
  workable: ['apply.workable.com/*'],
  smartrecruiters: ['careers.smartrecruiters.com/*', 'jobs.smartrecruiters.com/*'],
};

export const CDX_COLLECTIONS = 'https://index.commoncrawl.org/collinfo.json';

/** First path parts on the ATS hosts that are pages of the ATS, not a company's board. */
const NOT_A_COMPANY = new Set([
  'sr-jobs',
  'search',
  'login',
  'signin',
  'sign-in',
  'signup',
  'logout',
  'oauth',
  'auth',
  'account',
  'accounts',
  'user',
  'users',
  'privacy',
  'terms',
  'legal',
  'cookies',
  'sitemap',
  'job_app',
  'job_board',
  'board',
  'boards',
  'apply',
  'application',
  'job',
  'candidate',
  'candidates',
  'widget',
  'cdn-cgi',
  'images',
  'img',
  'css',
  'fonts',
  'wp-content',
  'null',
  'undefined',
]);

/** A board from a crawled URL, or null for the ATS's own pages and files. */
export function crawledBoard(url: string, ats: Ats): AtsBoard | null {
  const board = boardFromUrl(url);
  if (board?.ats !== ats) return null;
  const t = board.token.toLowerCase();
  if (NOT_A_COMPANY.has(t) || t.length < 2 || /^\d+$/.test(t)) return null;
  if (/\.(xml|txt|js|css|json|png|jpe?g|gif|svg|ico|html?|php)$/.test(t)) return null;
  return board;
}

// ---- Common Crawl ------------------------------------------------------------------------

export interface CdxOptions {
  /** Between two requests' starts. */
  paceMs: number;
  /** Waits before each retry of a request that failed for the service's sake (5xx, 429). */
  backoffMs: number[];
  /** The latest crawls looked at. */
  crawls: number;
  /** Pages read per pattern and crawl at most. */
  maxPages: number;
}

export const LIVE_CDX: CdxOptions = {
  paceMs: 2_000,
  backoffMs: [5_000, 20_000, 60_000],
  crawls: 3,
  maxPages: 40,
};

const CDX_TIMEOUT_MS = 90_000;
const RETRY = new Set([429, 500, 502, 503, 504]);

class CdxError extends Error {}

export interface CdxResult {
  boards: AtsBoard[];
  crawls: string[];
  requests: number;
  /** What couldn't be read, after its retries. */
  failed: string[];
  /** Patterns with more pages than were read. */
  truncated: string[];
}

/** Paced, retried GETs on the CDX server. */
class Cdx {
  private nextAt = 0;
  private readonly fetch: Fetch;
  private readonly signal: AbortSignal;
  private readonly o: CdxOptions;
  requests = 0;

  constructor(fetch: Fetch, signal: AbortSignal, o: CdxOptions) {
    this.fetch = fetch;
    this.signal = signal;
    this.o = o;
  }

  /** The response of a GET that succeeded (or answered 404: nothing there), or throws. */
  async get(url: string): Promise<Response | null> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.nextAt - Date.now();
      if (wait > 0) await sleep(wait, this.signal);
      this.nextAt = Date.now() + this.o.paceMs;
      this.requests++;
      let reason: string;
      try {
        const res = await this.fetch(url, {
          headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
          signal: AbortSignal.any([this.signal, AbortSignal.timeout(CDX_TIMEOUT_MS)]),
        });
        if (res.ok) return res;
        await res.body?.cancel().catch(() => {});
        if (res.status === 404) return null;
        if (!RETRY.has(res.status)) throw new CdxError(`HTTP ${res.status}`);
        reason = `HTTP ${res.status}`;
      } catch (err) {
        this.signal.throwIfAborted();
        if (err instanceof CdxError) throw err;
        reason = err instanceof Error ? err.message : String(err);
      }
      const backoff = this.o.backoffMs[attempt];
      if (backoff === undefined) throw new CdxError(`${reason} (${attempt + 1} tries)`);
      await sleep(backoff, this.signal);
    }
  }

  async json<T>(url: string): Promise<T | null> {
    const res = await this.get(url);
    if (!res) return null;
    try {
      return (await res.json()) as T;
    } catch {
      throw new CdxError('not JSON');
    }
  }

  /** Each line of a response, as it streams in (a page is thousands of URLs). */
  async lines(url: string, fn: (line: string) => void): Promise<void> {
    const res = await this.get(url);
    if (!res?.body) return;
    const decoder = new TextDecoder();
    let rest = '';
    for await (const chunk of res.body) {
      rest += decoder.decode(chunk as Uint8Array, { stream: true });
      let i = rest.indexOf('\n');
      while (i >= 0) {
        fn(rest.slice(0, i));
        rest = rest.slice(i + 1);
        i = rest.indexOf('\n');
      }
    }
    rest += decoder.decode();
    if (rest) fn(rest);
  }
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The boards Common Crawl's latest crawls saw on the ATS hosts. */
export async function commonCrawlBoards(
  fetch: Fetch,
  signal: AbortSignal,
  o: CdxOptions,
  progress: (message: string) => void = () => {},
): Promise<CdxResult> {
  const cdx = new Cdx(fetch, signal, o);
  const out: CdxResult = { boards: [], crawls: [], requests: 0, failed: [], truncated: [] };
  const seen = new Set<string>();
  let collections: Array<{ id?: unknown; 'cdx-api'?: unknown }> | null;
  try {
    collections = await cdx.json(CDX_COLLECTIONS);
  } catch (err) {
    signal.throwIfAborted();
    out.failed.push(`the list of crawls: ${reason(err)}`);
    out.requests = cdx.requests;
    return out;
  }
  const crawls = (Array.isArray(collections) ? collections : [])
    .flatMap((c) =>
      typeof c.id === 'string' && typeof c['cdx-api'] === 'string'
        ? [{ id: c.id, api: c['cdx-api'] }]
        : [],
    )
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .slice(0, o.crawls);
  out.crawls = crawls.map((c) => c.id);
  for (const crawl of crawls) {
    for (const [ats, patterns] of Object.entries(CDX_PATTERNS) as [Ats, string[]][]) {
      for (const pattern of patterns) {
        const base = `${crawl.api}?url=${pattern}&output=json&fl=url`;
        const where = `${crawl.id} ${pattern}`;
        let pages = 0;
        try {
          const info = await cdx.json<{ pages?: unknown } | number>(`${base}&showNumPages=true`);
          pages = Number(typeof info === 'number' ? info : (info?.pages ?? 0)) || 0;
        } catch (err) {
          signal.throwIfAborted();
          out.failed.push(`${where}: ${reason(err)}`);
          continue;
        }
        if (pages > o.maxPages) out.truncated.push(`${where} (${o.maxPages} of ${pages} pages)`);
        const before = out.boards.length;
        for (let page = 0; page < Math.min(pages, o.maxPages); page++) {
          try {
            await cdx.lines(`${base}&page=${page}`, (line) => {
              let url: unknown;
              try {
                url = (JSON.parse(line) as { url?: unknown }).url;
              } catch {
                return;
              }
              const board = typeof url === 'string' ? crawledBoard(url, ats) : null;
              if (!board) return;
              const key = boardKey(board.ats, board.token);
              if (seen.has(key)) return;
              seen.add(key);
              out.boards.push(board);
            });
          } catch (err) {
            signal.throwIfAborted();
            out.failed.push(`${where} page ${page + 1}: ${reason(err)}`);
          }
        }
        progress(`Common Crawl ${where}: ${out.boards.length - before} new boards`);
      }
    }
  }
  out.requests = cdx.requests;
  return out;
}

// ---- Applyant's own data -----------------------------------------------------------------

/** A job page's (or apply link's) board: only a job page counts, not an ATS's blog. */
function jobBoard(url: string | null): AtsBoard | null {
  return url && atsJobKey(url) ? boardFromUrl(url) : null;
}

/** Boards Applyant has come across: the watch list's, and those behind postings. */
export function ownBoards(conn: Conn): NewBoard[] {
  const out: NewBoard[] = [];
  for (const s of conn.select().from(searchSources).all()) {
    const via = s.origin === 'candidate' ? 'candidate' : 'watch-list';
    if (isAts(s.kind)) {
      out.push({ board: { ats: s.kind, token: s.locator }, via, name: s.label, note: s.key });
    } else if (s.kind === 'page' && s.resolved?.via === 'ats') {
      out.push({
        board: { ats: s.resolved.ats, token: s.resolved.token },
        via,
        name: s.label,
        note: `read by ${s.key}`,
      });
    }
  }
  const rows = conn
    .select({
      id: postings.id,
      url: postings.canonicalUrl,
      applyUrl: postings.applyUrl,
      company: postings.company,
    })
    .from(postings)
    .all();
  for (const p of rows) {
    for (const url of [p.url, p.applyUrl]) {
      const board = jobBoard(url);
      if (board) out.push({ board, via: 'posting', name: p.company, note: `posting ${p.id}` });
    }
  }
  for (const l of conn
    .select({ postingId: postingSources.postingId, url: postingSources.url })
    .from(postingSources)
    .all()) {
    const board = jobBoard(l.url);
    if (board) out.push({ board, via: 'posting', note: `posting ${l.postingId}` });
  }
  return out;
}

// ---- Runs --------------------------------------------------------------------------------

function discoveryBusy(conn: Conn): boolean {
  return !!conn
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.kind, 'index_discover'), inArray(tasks.status, ['queued', 'running'])))
    .get();
}

/** Starts a discovery run; null when one is already waiting or running. */
export function startDiscovery(tx: Tx, trigger: AtsDiscoveryRow['trigger']): number | null {
  if (discoveryBusy(tx.db)) return null;
  const row = tx.db
    .insert(atsDiscoveries)
    .values({ trigger, status: 'queued', startedAt: tx.now })
    .returning({ id: atsDiscoveries.id })
    .get();
  tx.enqueue('index_discover', row.id, { runId: null });
  tx.emit({
    kind: 'search.index',
    entityId: row.id,
    runId: null,
    stage: 'queued',
    message:
      trigger === 'manual'
        ? 'looking for more company boards'
        : trigger === 'setup'
          ? 'looking for company boards (the index is new)'
          : 'looking for more company boards (weekly)',
  });
  return row.id;
}

export function latestDiscoveries(conn: Conn, limit = 5): AtsDiscoveryRow[] {
  return conn.select().from(atsDiscoveries).orderBy(desc(atsDiscoveries.id)).limit(limit).all();
}

/** The scheduler's part: the first discovery once the index is in use, then weekly. */
export function scheduleDiscovery(tx: Tx): number | null {
  if (!indexWanted(tx.db)) return null;
  const last = latestDiscoveries(tx.db, 1)[0];
  if (!last) return startDiscovery(tx, 'setup');
  if (last.status === 'queued') return null;
  if (tx.now.getTime() - last.startedAt.getTime() < DISCOVER_EVERY_MS) return null;
  return startDiscovery(tx, 'schedule');
}

interface Found {
  own: NewBoard[];
  cc: CdxResult;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

export function finishDiscovery(tx: Tx, id: number, found: Found): AtsDiscoveryRow | null {
  const boards: NewBoard[] = [
    ...found.own,
    ...found.cc.boards.map((board) => ({ board, via: 'common-crawl' as const })),
  ];
  const added = knowBoards(tx, boards);
  const distinct = new Set(boards.map((b) => boardKey(b.board.ats, b.board.token))).size;
  const ownDistinct = new Set(found.own.map((b) => boardKey(b.board.ats, b.board.token))).size;
  const { cc } = found;
  const note = [
    `${plural(added.length, 'new board')} of ${plural(distinct, 'board')} found`,
    `Applyant's own data: ${plural(ownDistinct, 'board')}`,
    cc.crawls.length
      ? `Common Crawl (${cc.crawls.join(', ')}): ${plural(cc.boards.length, 'board')} in ${plural(cc.requests, 'request')}`
      : 'Common Crawl: no crawls to look at',
    ...(cc.truncated.length ? [`not every page read: ${cc.truncated.join('; ')}`] : []),
    ...(cc.failed.length
      ? [
          `${plural(cc.failed.length, 'part')} failed: ${cc.failed.slice(0, 5).join('; ')}${cc.failed.length > 5 ? '; …' : ''}`,
        ]
      : []),
  ].join(' · ');
  const row = tx.db
    .update(atsDiscoveries)
    .set({ status: 'done', finishedAt: tx.now, found: distinct, added: added.length, note })
    .where(eq(atsDiscoveries.id, id))
    .returning()
    .get();
  tx.emit({ kind: 'search.index', entityId: id, runId: null, stage: 'done', message: note });
  return row ?? null;
}

function failDiscovery(tx: Tx, id: number, why: string): void {
  tx.db
    .update(atsDiscoveries)
    .set({ status: 'failed', finishedAt: tx.now, note: why })
    .where(eq(atsDiscoveries.id, id))
    .run();
  tx.emit({ kind: 'search.index', entityId: id, runId: null, stage: 'failed', message: why });
}

export const indexDiscover: Handler<'index_discover'> = async (task, ctx) => {
  const row = ctx.read
    .select()
    .from(atsDiscoveries)
    .where(eq(atsDiscoveries.id, task.entityId))
    .get();
  if (row?.status !== 'queued') return { kind: 'done', commit: () => {} };
  ctx.progress({ message: "the ATS index: looking in Applyant's own data" });
  const own = ownBoards(ctx.read);
  // The real service gets its pace and backoff; an injected fetch (tests) none.
  const live = !ctx.deps.fetch;
  let cc: CdxResult;
  try {
    cc = await commonCrawlBoards(
      ctx.deps.fetch ?? globalThis.fetch,
      ctx.signal,
      live ? LIVE_CDX : { ...LIVE_CDX, paceMs: 0, backoffMs: LIVE_CDX.backoffMs.map(() => 0) },
      (message) => ctx.progress({ message }),
    );
  } catch (err) {
    ctx.signal.throwIfAborted();
    const why = `discovery failed: ${reason(err)}`;
    return { kind: 'done', commit: (tx) => failDiscovery(tx, row.id, why) };
  }
  return { kind: 'done', commit: (tx) => void finishDiscovery(tx, row.id, { own, cc }) };
};
