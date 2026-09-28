// The watch list: company boards and career pages the search planner's web searches found.
// Each becomes a search source (origin agent, with the planner's reason as its note) and is
// polled directly like any other: an ATS board through its list API, a career page through the
// generic reader and, when it needs one, a listing recipe. Web search stays rare this way:
// it finds boards, and the boards are then read on every run.
import { eq } from 'drizzle-orm';
import { type SearchSourceRow, searchSources } from '../../db/schema.ts';
import type { Tx } from '../../queue/types.ts';
import { isBoardId } from './readers/boards.ts';
import { addSource, parseSourceInput, SearchError, sourceKey } from './sources.ts';

/** Boards one planner run may add (the rest are likely noise). */
export const MAX_BOARDS_PER_PLAN = 30;

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

/** Adds the boards a planner run found; `note` says why each is watched. */
export function watchBoards(tx: Tx, boards: FoundBoard[]): WatchResult {
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
    if (out.added.length >= MAX_BOARDS_PER_PLAN) {
      out.rejected.push({
        url: raw,
        reason: `more than ${MAX_BOARDS_PER_PLAN} boards in one plan`,
      });
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
