// The watch list: the company boards the search planner's web searches found that one of its
// strategies names, its career pages and Telegram channels. Each becomes a search source
// (origin agent, with why it's watched as its note) and is polled directly like any other: an
// ATS board through its list API, a career page through the generic reader and, when it needs
// one, a listing recipe.
//
// The ATS boards behind jobs that searches matched or verification led to (a company hiring
// for the candidate's titles, seen on a job board, in a Telegram post, in a job search across
// every company, or behind a LinkedIn posting's apply link) join the ATS index instead
// (ats-index/): read on its own schedule, every 6 hours while it has jobs a strategy matches,
// and searched by every strategy without a request.
import { eq } from 'drizzle-orm';
import {
  type AtsCompanyRow,
  type AtsFoundVia,
  type SearchSourceRow,
  searchSources,
} from '../../db/schema.ts';
import type { Tx } from '../../queue/types.ts';
import { boardKey, findCompany, knowBoards, type NewBoard } from './ats-index/store.ts';
import { type AtsBoard, atsJobKey, boardFromUrl } from './readers/ats-embed.ts';
import { isBoardId } from './readers/boards.ts';
import type { Listing } from './readers/types.ts';
import { addSource, parseSourceInput, SearchError, sourceKey } from './sources.ts';

/** Boards one planner run may add (the rest are likely noise). */
export const MAX_BOARDS_PER_PLAN = 30;
/** Boards one search run may add to the index from the jobs it matched (more join later). */
export const MAX_SEEN_BOARDS_PER_RUN = 50;

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

export interface SeenJob {
  listing: Pick<Listing, 'url' | 'applyUrl' | 'board' | 'title' | 'company'>;
  /** How it was seen: `"AI Engineer" matched it on RemoteOK` · `posting 12 applies there`. */
  where: string;
  /** The board the job was read from, if it was one: that board isn't "seen" again. */
  from?: { kind: string; locator: string } | null;
  /** How the index records it: by a job search's name (workable-search, …), else a posting's. */
  via?: AtsFoundVia;
}

/**
 * The boards behind jobs a search matched (or verification opened) join the ATS index, at most
 * `max` new ones, each `new` and read at the next crawl. A board the index knows already, on or
 * off, stays as it is. Returns the boards added.
 */
export function watchSeen(tx: Tx, jobs: SeenJob[], max = MAX_SEEN_BOARDS_PER_RUN): AtsCompanyRow[] {
  const found: NewBoard[] = [];
  const seen = new Set<string>();
  for (const { listing, where, from, via } of jobs) {
    const board = boardOf(listing);
    if (!board) continue;
    const key = boardKey(board.ats, board.token);
    if (from && boardKey(from.kind, from.locator) === key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    if (findCompany(tx.db, board)) continue;
    found.push({
      board,
      via: via ?? 'posting',
      name: listing.company,
      note: `has "${listing.title}" (${where})`,
    });
  }
  return knowBoards(tx, found, { max });
}
