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
//   slices   a run is up to ~1.8k requests, an hour and more: it's read a slice at a time
//            (stepRequests, at most stepMs), each slice its own task that holds a worker only
//            that long. A slice adds what it found to the index and leaves where it got to on
//            the run's row (`progress`, and how far in its note); the next slice goes on from
//            there, after a restart too. A request that still fails after its backoff is tried
//            again by a later slice an hour or two on, a few times (retryAfterMs), the rest of
//            the run going on meanwhile; only then is it noted as failed
//   lost     a run whose task is gone (failed for good) isn't waiting any more: it is marked
//            failed, and the next one can start (a day later by itself)
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
import { type Ats, type AtsBoard, boardFromUrl, jobPageBoard } from '../readers/ats-embed.ts';
import { USER_AGENT } from '../readers/http.ts';
import { sleep } from '../readers/shared.ts';
import type { Fetch } from '../readers/types.ts';
import { isAts } from '../sources.ts';
import { boardKey, indexWanted, knowBoards, type NewBoard } from './store.ts';

/** Once a discovery has run, the next starts this long after it. */
export const DISCOVER_EVERY_MS = 7 * 24 * 3_600_000;
/** After one that failed, the next starts this long after. */
export const DISCOVER_RETRY_MS = 24 * 3_600_000;

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
  // A company's own subdomain on these: "*.host" asks CDX for every subdomain.
  personio: ['*.jobs.personio.de', '*.jobs.personio.com'],
  recruitee: ['*.recruitee.com'],
  teamtailor: ['*.teamtailor.com'],
  join: ['join.com/companies/*'],
  breezy: ['*.breezy.hr'],
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
  /** A slice's requests (retries count), and how long it starts new ones. */
  stepRequests: number;
  stepMs: number;
  /**
   * A part (a pattern's page count, or one of its pages) that still fails after its backoff is
   * tried again by a later slice, after each of these waits; then it's noted as failed. The
   * service's bad spells pass within hours, not within a minute.
   */
  retryAfterMs: number[];
}

export const LIVE_CDX: CdxOptions = {
  paceMs: 2_000,
  backoffMs: [5_000, 20_000, 60_000],
  crawls: 3,
  maxPages: 40,
  stepRequests: 20,
  stepMs: 90_000,
  retryAfterMs: [3_600_000, 2 * 3_600_000, 2 * 3_600_000],
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

/** When the next request may start: one pace across a run's slices (they follow each other). */
export interface CdxPace {
  nextAt: number;
}

/** The daemon's own pace over the real service. */
const LIVE_PACE: CdxPace = { nextAt: 0 };

/** Paced, retried GETs on the CDX server. */
class Cdx {
  private readonly fetch: Fetch;
  private readonly signal: AbortSignal;
  private readonly o: CdxOptions;
  private readonly pace: CdxPace;
  requests = 0;

  constructor(fetch: Fetch, signal: AbortSignal, o: CdxOptions, pace: CdxPace) {
    this.fetch = fetch;
    this.signal = signal;
    this.o = o;
    this.pace = pace;
  }

  /** The response of a GET that succeeded (or answered 404: nothing there), or throws. */
  async get(url: string): Promise<Response | null> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.pace.nextAt - Date.now();
      if (wait > 0) await sleep(wait, this.signal);
      this.pace.nextAt = Date.now() + this.o.paceMs;
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

/** Each ATS's patterns in a row: a crawl's parts, in CDX_PATTERNS' order. */
const PATTERNS = (Object.entries(CDX_PATTERNS) as [Ats, string[]][]).flatMap(([ats, patterns]) =>
  patterns.map((pattern) => ({ ats, pattern })),
);

/** A request that failed and is tried again later: a part's page count (page null) or a page. */
export interface CdxRetry {
  part: number;
  page: number | null;
  /** Times it failed (each after its backoff). */
  tries: number;
  /** When it's tried again (epoch ms). */
  at: number;
  why: string;
}

/** Where a discovery got to (`ats_discoveries.progress`). */
export interface DiscoveryProgress {
  /** The crawls looked at, newest first, with their CDX endpoints; null until they're listed. */
  crawls: Array<{ id: string; api: string }> | null;
  /** The next part (crawl × pattern), its next page, and its page count once that was read. */
  part: number;
  page: number;
  pages: number | null;
  /** What failed and is tried again later (CdxOptions.retryAfterMs). */
  retry: CdxRetry[];
  requests: number;
  /** What failed for good. */
  failed: string[];
  truncated: string[];
  /** The boards Common Crawl gave so far ("ats:token"), each once. */
  boards: string[];
  /** The boards of Applyant's own data (the first slice reads them). */
  own: string[];
  /** Boards new to the index so far. */
  added: number;
}

export function newProgress(): DiscoveryProgress {
  return {
    crawls: null,
    part: 0,
    page: 0,
    pages: null,
    retry: [],
    requests: 0,
    failed: [],
    truncated: [],
    boards: [],
    own: [],
    added: 0,
  };
}

/** The parts a run reads (once its crawls are listed). */
function partsOf(p: DiscoveryProgress): number {
  return (p.crawls?.length ?? 0) * PATTERNS.length;
}

/** "12 of 45 parts read · 1,204 boards so far · 3 to retry": a run on its way. */
export function progressNote(p: DiscoveryProgress): string {
  const parts = partsOf(p);
  const waiting = new Set(p.retry.map((r) => r.part)).size;
  return [
    p.crawls === null
      ? 'listing the crawls'
      : `${Math.max(0, p.part - waiting)} of ${plural(parts, 'part')} read`,
    `${plural(p.boards.length, 'board')} so far`,
    ...(p.retry.length ? [`${p.retry.length} to retry`] : []),
    ...(p.failed.length ? [`${p.failed.length} failed`] : []),
  ].join(' · ');
}

export interface CdxStep {
  /** Boards this slice found that the run hadn't. */
  boards: AtsBoard[];
  /** Every part is read (or failed for good). */
  done: boolean;
  /** Not done: when the next slice has something to do (now, or the first retry's time). */
  nextAt: Date | null;
}

/**
 * One slice of a run's Common Crawl part: from where `p` says, until every part is read or the
 * slice has spent its requests (or its time). Then the requests that failed, once they're due
 * again. Moves `p` on; `now` is when the slice started (retries are timed from it).
 */
export async function commonCrawlStep(
  fetch: Fetch,
  signal: AbortSignal,
  o: CdxOptions,
  p: DiscoveryProgress,
  now: Date,
  progress: (message: string) => void = () => {},
  pace: CdxPace = { nextAt: 0 },
): Promise<CdxStep> {
  const cdx = new Cdx(fetch, signal, o, pace);
  const began = Date.now();
  const spent = () =>
    cdx.requests > 0 && (cdx.requests >= o.stepRequests || Date.now() - began >= o.stepMs);
  const seen = new Set(p.boards);
  const boards: AtsBoard[] = [];
  if (p.crawls === null) {
    try {
      const collections =
        await cdx.json<Array<{ id?: unknown; 'cdx-api'?: unknown }>>(CDX_COLLECTIONS);
      p.crawls = (Array.isArray(collections) ? collections : [])
        .flatMap((c) =>
          typeof c.id === 'string' && typeof c['cdx-api'] === 'string'
            ? [{ id: c.id, api: c['cdx-api'] }]
            : [],
        )
        .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
        .slice(0, o.crawls);
    } catch (err) {
      signal.throwIfAborted();
      p.failed.push(`the list of crawls: ${reason(err)}`);
      p.crawls = [];
    }
  }
  const crawls = p.crawls;
  const parts = partsOf(p);
  const target = (part: number) => {
    const crawl = crawls[Math.floor(part / PATTERNS.length)];
    const pat = PATTERNS[part % PATTERNS.length];
    if (!crawl || !pat) throw new Error(`no part ${part}`);
    return {
      ats: pat.ats,
      base: `${crawl.api}?url=${pat.pattern}&output=json&fl=url`,
      where: `${crawl.id} ${pat.pattern}`,
    };
  };
  const label = (part: number, page: number | null) =>
    `${target(part).where}${page === null ? '' : ` page ${page + 1}`}`;
  /** A part's page count; throws when the service doesn't give it. */
  const count = async (part: number): Promise<number> => {
    const t = target(part);
    const info = await cdx.json<{ pages?: unknown } | number>(`${t.base}&showNumPages=true`);
    const pages = Number(typeof info === 'number' ? info : (info?.pages ?? 0)) || 0;
    if (pages > o.maxPages) p.truncated.push(`${t.where} (${o.maxPages} of ${pages} pages)`);
    return Math.min(pages, o.maxPages);
  };
  /** One page's boards, those new to the run; throws when the page couldn't be read. */
  const page = async (part: number, n: number): Promise<number> => {
    const t = target(part);
    const before = boards.length;
    await cdx.lines(`${t.base}&page=${n}`, (line) => {
      let url: unknown;
      try {
        url = (JSON.parse(line) as { url?: unknown }).url;
      } catch {
        return;
      }
      const board = typeof url === 'string' ? crawledBoard(url, t.ats) : null;
      if (!board) return;
      const key = boardKey(board.ats, board.token);
      if (seen.has(key)) return;
      seen.add(key);
      p.boards.push(key);
      boards.push(board);
    });
    return boards.length - before;
  };
  /** A request failed after its backoff: tried again later, or failed for good. */
  const failed = (part: number, n: number | null, err: unknown, prior?: CdxRetry) => {
    signal.throwIfAborted();
    const why = reason(err);
    const tries = (prior?.tries ?? 0) + 1;
    const wait = o.retryAfterMs[tries - 1];
    if (prior) p.retry.splice(p.retry.indexOf(prior), 1);
    if (wait === undefined) {
      p.failed.push(
        `${label(part, n)}: ${why}${tries > 1 ? `, tried ${tries} times over hours` : ''}`,
      );
      progress(`Common Crawl ${label(part, n)}: failed (${why})`);
      return;
    }
    p.retry.push({ part, page: n, tries, at: now.getTime() + wait, why });
    progress(
      `Common Crawl ${label(part, n)}: failed (${why}); tried again in ${Math.round(wait / 60_000)} min`,
    );
  };
  const read = (part: number, n: number, found: number, of?: number) =>
    progress(
      `Common Crawl ${label(part, n)}${of ? ` of ${of}` : ''}: ${plural(found, 'new board')} · ${plural(p.boards.length, 'board')} so far`,
    );

  // The parts in order.
  while (p.part < parts && !spent()) {
    if (p.pages === null) {
      try {
        p.pages = await count(p.part);
      } catch (err) {
        // Its pages come once the count does (a retry).
        failed(p.part, null, err);
        p.pages = 0;
      }
    } else {
      try {
        read(p.part, p.page, await page(p.part, p.page), p.pages);
      } catch (err) {
        failed(p.part, p.page, err);
      }
      p.page++;
    }
    // The part is read: the next one.
    if (p.page >= p.pages) {
      p.part++;
      p.page = 0;
      p.pages = null;
    }
  }
  // Then what failed, once it's due again.
  for (;;) {
    if (p.part < parts || spent()) break;
    const due = p.retry
      .filter((r) => r.at <= now.getTime())
      .sort((a, b) => a.at - b.at || a.part - b.part)[0];
    if (!due) break;
    try {
      if (due.page === null) {
        const pages = await count(due.part);
        p.retry.splice(p.retry.indexOf(due), 1);
        // Its pages, due now.
        for (let n = 0; n < pages; n++) {
          p.retry.push({ part: due.part, page: n, tries: 0, at: 0, why: 'not read yet' });
        }
      } else {
        const found = await page(due.part, due.page);
        p.retry.splice(p.retry.indexOf(due), 1);
        read(due.part, due.page, found);
      }
    } catch (err) {
      failed(due.part, due.page, err, due);
    }
  }
  p.requests += cdx.requests;
  const done = p.part >= parts && p.retry.length === 0;
  const waiting = p.part >= parts && !p.retry.some((r) => r.at <= now.getTime());
  const first = Math.min(...p.retry.map((r) => r.at));
  return { boards, done, nextAt: done ? null : waiting ? new Date(first) : now };
}

/**
 * The boards Common Crawl's latest crawls saw on the ATS hosts: every slice, one after another,
 * in one go (what fails is noted, not tried again hours later).
 */
export async function commonCrawlBoards(
  fetch: Fetch,
  signal: AbortSignal,
  o: CdxOptions,
  progress: (message: string) => void = () => {},
): Promise<CdxResult> {
  const p = newProgress();
  const pace: CdxPace = { nextAt: 0 };
  const boards: AtsBoard[] = [];
  const once = { ...o, retryAfterMs: [] };
  for (;;) {
    const step = await commonCrawlStep(fetch, signal, once, p, new Date(), progress, pace);
    boards.push(...step.boards);
    if (step.done) break;
  }
  return {
    boards,
    crawls: (p.crawls ?? []).map((c) => c.id),
    requests: p.requests,
    failed: p.failed,
    truncated: p.truncated,
  };
}

// ---- Applyant's own data -----------------------------------------------------------------

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
      const board = jobPageBoard(url);
      if (board) out.push({ board, via: 'posting', name: p.company, note: `posting ${p.id}` });
    }
  }
  for (const l of conn
    .select({ postingId: postingSources.postingId, url: postingSources.url })
    .from(postingSources)
    .all()) {
    const board = jobPageBoard(l.url);
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

/** What a run whose task is gone says. */
export const LOST_NOTE = 'stopped: its task failed or was lost (the next discovery starts again)';

/** The queued runs among `rows` that no task carries on (failed for good, or never ran). */
function lost(conn: Conn, rows: AtsDiscoveryRow[]): Set<number> {
  const queued = rows.filter((r) => r.status === 'queued').map((r) => r.id);
  if (queued.length === 0) return new Set();
  const live = new Set(
    conn
      .select({ id: tasks.entityId })
      .from(tasks)
      .where(
        and(
          eq(tasks.kind, 'index_discover'),
          inArray(tasks.entityId, queued),
          inArray(tasks.status, ['queued', 'running']),
        ),
      )
      .all()
      .map((t) => t.id),
  );
  return new Set(queued.filter((id) => !live.has(id)));
}

/** Runs no task carries on any more are marked failed: they aren't waiting, the next can start. */
export function settleDiscoveries(tx: Tx): void {
  const queued = tx.db
    .select()
    .from(atsDiscoveries)
    .where(eq(atsDiscoveries.status, 'queued'))
    .all();
  for (const id of lost(tx.db, queued)) failDiscovery(tx, id, LOST_NOTE);
}

/** Starts a discovery run; null when one is already waiting or running. */
export function startDiscovery(tx: Tx, trigger: AtsDiscoveryRow['trigger']): number | null {
  settleDiscoveries(tx);
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

/**
 * The latest runs, newest first. One whose task is gone reads as failed even before the
 * scheduler marks it so.
 */
export function latestDiscoveries(conn: Conn, limit = 5): AtsDiscoveryRow[] {
  const rows = conn
    .select()
    .from(atsDiscoveries)
    .orderBy(desc(atsDiscoveries.id))
    .limit(limit)
    .all();
  const gone = lost(conn, rows);
  return rows.map((r) => (gone.has(r.id) ? { ...r, status: 'failed', note: LOST_NOTE } : r));
}

/**
 * The scheduler's part: the first discovery once the index is in use, then weekly (a day after
 * one that failed).
 */
export function scheduleDiscovery(tx: Tx): number | null {
  if (!indexWanted(tx.db)) return null;
  settleDiscoveries(tx);
  const last = latestDiscoveries(tx.db, 1)[0];
  if (!last) return startDiscovery(tx, 'setup');
  if (last.status === 'queued') return null;
  const since = tx.now.getTime() - (last.finishedAt ?? last.startedAt).getTime();
  if (last.status === 'failed' ? since < DISCOVER_RETRY_MS : since < DISCOVER_EVERY_MS) {
    return null;
  }
  return startDiscovery(tx, 'schedule');
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** The run's last slice is in: what it found, in a line. */
function finishDiscovery(tx: Tx, id: number, p: DiscoveryProgress): void {
  const found = new Set([...p.own, ...p.boards]).size;
  const crawls = (p.crawls ?? []).map((c) => c.id);
  const note = [
    `${plural(p.added, 'new board')} of ${plural(found, 'board')} found`,
    `Applyant's own data: ${plural(p.own.length, 'board')}`,
    crawls.length
      ? `Common Crawl (${crawls.join(', ')}): ${plural(p.boards.length, 'board')} in ${plural(p.requests, 'request')}`
      : 'Common Crawl: no crawls to look at',
    ...(p.truncated.length ? [`not every page read: ${p.truncated.join('; ')}`] : []),
    ...(p.failed.length
      ? [
          `${plural(p.failed.length, 'part')} failed: ${p.failed.slice(0, 5).join('; ')}${p.failed.length > 5 ? '; …' : ''}`,
        ]
      : []),
  ].join(' · ');
  tx.db
    .update(atsDiscoveries)
    .set({
      status: 'done',
      finishedAt: tx.now,
      found,
      added: p.added,
      note,
      progress: null,
    })
    .where(eq(atsDiscoveries.id, id))
    .run();
  tx.emit({ kind: 'search.index', entityId: id, runId: null, stage: 'done', message: note });
}

function failDiscovery(tx: Tx, id: number, why: string): void {
  tx.db
    .update(atsDiscoveries)
    .set({ status: 'failed', finishedAt: tx.now, note: why, progress: null })
    .where(eq(atsDiscoveries.id, id))
    .run();
  tx.emit({ kind: 'search.index', entityId: id, runId: null, stage: 'failed', message: why });
}

/**
 * A slice is in: its boards join the index, and the run goes on with the next slice (its own
 * task, at the back of the queue) or is done.
 */
function commitSlice(
  tx: Tx,
  id: number,
  input: { own: NewBoard[]; p: DiscoveryProgress; step: CdxStep },
): void {
  const row = tx.db.select().from(atsDiscoveries).where(eq(atsDiscoveries.id, id)).get();
  // Marked failed (lost) in the meantime: it stays so.
  if (row?.status !== 'queued') return;
  const { p, step } = input;
  p.added += knowBoards(tx, [
    ...input.own,
    ...step.boards.map((board) => ({ board, via: 'common-crawl' as const })),
  ]).length;
  if (step.done) {
    finishDiscovery(tx, id, p);
    return;
  }
  // On its way: the row says how far, and what it has found so far is in the index already.
  tx.db
    .update(atsDiscoveries)
    .set({
      progress: p,
      found: new Set([...p.own, ...p.boards]).size,
      added: p.added,
      note: progressNote(p),
    })
    .where(eq(atsDiscoveries.id, id))
    .run();
  tx.enqueue('index_discover', id, {
    runId: null,
    ...(step.nextAt && step.nextAt > tx.now ? { runAfter: step.nextAt } : {}),
  });
}

export const indexDiscover: Handler<'index_discover'> = async (task, ctx) => {
  const row = ctx.read
    .select()
    .from(atsDiscoveries)
    .where(eq(atsDiscoveries.id, task.entityId))
    .get();
  if (row?.status !== 'queued') return { kind: 'done', commit: () => {} };
  const p = row.progress ?? newProgress();
  // The first slice also looks in Applyant's own data (no request).
  let own: NewBoard[] = [];
  if (!row.progress) {
    ctx.progress({ message: "the ATS index: looking in Applyant's own data" });
    own = ownBoards(ctx.read);
    p.own = [...new Set(own.map((b) => boardKey(b.board.ats, b.board.token)))];
  }
  // The real service gets its pace and backoff; an injected fetch (tests) none.
  const live = !ctx.deps.fetch;
  let step: CdxStep;
  try {
    step = await commonCrawlStep(
      ctx.deps.fetch ?? globalThis.fetch,
      ctx.signal,
      live ? LIVE_CDX : { ...LIVE_CDX, paceMs: 0, backoffMs: LIVE_CDX.backoffMs.map(() => 0) },
      p,
      ctx.now(),
      (message) => ctx.progress({ message }),
      live ? LIVE_PACE : { nextAt: 0 },
    );
  } catch (err) {
    ctx.signal.throwIfAborted();
    const why = `discovery failed: ${reason(err)}`;
    return { kind: 'done', commit: (tx) => failDiscovery(tx, row.id, why) };
  }
  return { kind: 'done', commit: (tx) => commitSlice(tx, row.id, { own, p, step }) };
};
