// The watch list: company boards and career pages the search planner's web searches found,
// and the ATS boards behind jobs that searches matched or verification led to (a company
// hiring for the candidate's titles, seen on a job board, in a Telegram post, in a job search
// across every company, or behind a LinkedIn posting's apply link). Each becomes a search
// source (origin agent, with why it's watched as its note) and is polled directly like any
// other: an ATS board through its list API, a career page through the generic reader and, when
// it needs one, a listing recipe. Web search stays rare this way: it finds boards, and the
// boards are then read on every run.
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { type SearchSourceRow, searchSources } from '../../db/schema.ts';
import type { Tx } from '../../queue/types.ts';
import {
  ATS_KINDS,
  type AtsBoard,
  atsJobKey,
  boardFromUrl,
  boardUrl,
} from './readers/ats-embed.ts';
import { isBoardId } from './readers/boards.ts';
import type { Listing } from './readers/types.ts';
import { addSource, parseSourceInput, SearchError, sourceKey } from './sources.ts';

/** Boards one planner run may add (the rest are likely noise). */
export const MAX_BOARDS_PER_PLAN = 30;
/** Boards one search run may add from the jobs it matched (more join on later runs). */
export const MAX_SEEN_BOARDS_PER_RUN = 10;
/**
 * Company boards the agent may watch (switched on) before matched jobs stop adding more: every
 * strategy reads every board on every run, so the list mustn't grow without end. Boards
 * switched off don't count.
 */
export const MAX_WATCHED_BOARDS = 200;

/**
 * Hosts that are never watched as a company's board: search engines, social networks and big
 * aggregators (LinkedIn and Xing come as their own sources in phase 14), and the job boards
 * Applyant already reads through their APIs.
 */
const NOT_A_BOARD = [
  'google.',
  'bing.com',
  'duckduckgo.com',
  'linkedin.com',
  'xing.com',
  'indeed.',
  'glassdoor.',
  'facebook.com',
  'x.com',
  'twitter.com',
  'reddit.com',
  'youtube.com',
  'ziprecruiter.com',
  'monster.',
  'news.ycombinator.com',
  'remoteok.com',
  'weworkremotely.com',
  'remotive.com',
  'himalayas.app',
  'arbeitnow.com',
  'jobicy.com',
];

export interface FoundBoard {
  url: string;
  company: string | null;
  why: string;
  foundWith: string | null;
}

export interface WatchResult {
  added: SearchSourceRow[];
  /** Already sources (the candidate's, built-in or found before). */
  known: SearchSourceRow[];
  rejected: Array<{ url: string; reason: string }>;
}

function refused(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const hit = NOT_A_BOARD.find((d) =>
    d.endsWith('.')
      ? host.startsWith(d) || host.includes(`.${d}`)
      : host === d || host.endsWith(`.${d}`),
  );
  return hit ? `${host} isn't a company's own board` : null;
}

/** Adds the boards a planner run (or a search) found; `note` says why each is watched. */
export function watchBoards(tx: Tx, boards: FoundBoard[], o: { max?: number } = {}): WatchResult {
  const max = o.max ?? MAX_BOARDS_PER_PLAN;
  const out: WatchResult = { added: [], known: [], rejected: [] };
  const seen = new Set<string>();
  for (const b of boards) {
    const raw = b.url.trim();
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      out.rejected.push({ url: raw, reason: 'not a URL' });
      continue;
    }
    const why = refused(url);
    if (why) {
      out.rejected.push({ url: raw, reason: why });
      continue;
    }
    let input: ReturnType<typeof parseSourceInput>;
    try {
      input = parseSourceInput([raw], b.company?.trim() || null);
    } catch (err) {
      out.rejected.push({ url: raw, reason: (err as Error).message });
      continue;
    }
    if (input.kind === 'board' && !isBoardId(input.locator)) {
      out.rejected.push({ url: raw, reason: 'unknown job board' });
      continue;
    }
    const key = sourceKey(input.kind, input.locator);
    if (seen.has(key)) continue;
    seen.add(key);
    if (out.added.length >= max) {
      out.rejected.push({ url: raw, reason: `more than ${max} boards at once` });
      continue;
    }
    try {
      const { source, created } = addSource(tx.db, { ...input, origin: 'agent' }, tx.now);
      if (!created) {
        out.known.push(source);
        continue;
      }
      const note = [b.why.trim(), b.foundWith ? `found with: ${b.foundWith.trim()}` : null]
        .filter(Boolean)
        .join(' · ');
      const row = tx.db
        .update(searchSources)
        .set({ note: note || null })
        .where(eq(searchSources.id, source.id))
        .returning()
        .get();
      out.added.push(row ?? source);
    } catch (err) {
      if (!(err instanceof SearchError)) throw err;
      out.rejected.push({ url: raw, reason: err.message });
    }
  }
  return out;
}

/**
 * The ATS board a listing is on: the one its reader names, or the one its job page (or apply
 * link) is on. Only a job page counts: a link to an ATS host's blog isn't a board.
 */
export function boardOf(l: Pick<Listing, 'url' | 'applyUrl' | 'board'>): AtsBoard | null {
  if (l.board) return l.board;
  for (const url of [l.url, l.applyUrl]) {
    const board = url && atsJobKey(url) ? boardFromUrl(url) : null;
    if (board) return board;
  }
  return null;
}

const BOARD_TOKEN = /^[a-z0-9][a-z0-9._-]*$/i;

export interface SeenJob {
  listing: Pick<Listing, 'url' | 'applyUrl' | 'board' | 'title' | 'company'>;
  /** How it was seen: `"AI Engineer" matched it on RemoteOK` · `posting 12 applies there`. */
  where: string;
  /** The board the job was read from, if it was one: that board isn't "seen" again. */
  from?: { kind: string; locator: string } | null;
}

/** Whether the board is a source already: as itself, or as a career page that reads it. */
function watched(tx: Tx, board: AtsBoard): boolean {
  const token = board.token.toLowerCase();
  // Whatever the case of its name in this URL (jobs.lever.co/Acme · /acme).
  const own = tx.db
    .select({ id: searchSources.id })
    .from(searchSources)
    .where(and(eq(searchSources.kind, board.ats), sql`lower(${searchSources.locator}) = ${token}`))
    .get();
  if (own) return true;
  return !!tx.db
    .select({ id: searchSources.id })
    .from(searchSources)
    .where(
      and(
        eq(searchSources.kind, 'page'),
        sql`json_extract(${searchSources.resolved}, '$.via') = 'ats'`,
        sql`json_extract(${searchSources.resolved}, '$.ats') = ${board.ats}`,
        sql`lower(json_extract(${searchSources.resolved}, '$.token')) = ${token}`,
      ),
    )
    .get();
}

/** Company boards the agent watches now (switched on). */
function agentBoards(tx: Tx): number {
  return (
    tx.db
      .select({ n: count() })
      .from(searchSources)
      .where(
        and(
          eq(searchSources.origin, 'agent'),
          eq(searchSources.enabled, true),
          inArray(searchSources.kind, [...ATS_KINDS]),
        ),
      )
      .get()?.n ?? 0
  );
}

/**
 * Watches the boards behind jobs a search matched (or verification opened), at most `max` new
 * ones, and none once the agent watches MAX_WATCHED_BOARDS. A board already on the list, on or
 * off, stays as it is.
 */
export function watchSeen(tx: Tx, jobs: SeenJob[], max = MAX_SEEN_BOARDS_PER_RUN): WatchResult {
  const room = Math.min(max, MAX_WATCHED_BOARDS - agentBoards(tx));
  if (room <= 0) return { added: [], known: [], rejected: [] };
  const found: FoundBoard[] = [];
  const seen = new Set<string>();
  for (const { listing, where, from } of jobs) {
    const board = boardOf(listing);
    // A name the board's own URL can't carry (a reader's odd identifier) isn't a board.
    if (!board || !BOARD_TOKEN.test(board.token)) continue;
    const key = `${board.ats}:${board.token.toLowerCase()}`;
    if (from && `${from.kind}:${from.locator.toLowerCase()}` === key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    if (watched(tx, board)) continue;
    found.push({
      url: boardUrl(board),
      company: listing.company,
      why: `has "${listing.title}" (${where})`,
      foundWith: null,
    });
  }
  return watchBoards(tx, found, { max: room });
}
