// The search source registry: every place postings can be listed, each with an on/off switch
// (and a switch per kind). A disabled source, or a source of a disabled kind, is never queried.
import { count, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Conn } from '../../db/client.ts';
import {
  postingSources,
  postings,
  type ResolvedSource,
  SEARCH_SOURCE_KINDS,
  type SearchSourceKind,
  type SearchSourceRow,
  searchSourceKinds,
  searchSources,
} from '../../db/schema.ts';
import { ATS_KINDS, type Ats, boardFromUrl } from './readers/ats-embed.ts';
import { BOARDS, BOARDS_OFF, type BoardId, isBoardId } from './readers/boards.ts';

export class SearchError extends Error {}

export const KIND_LABELS: Record<SearchSourceKind, string> = {
  greenhouse: 'Greenhouse',
  ashby: 'Ashby',
  lever: 'Lever',
  workable: 'Workable',
  page: 'Career pages and feeds',
  board: 'Job boards',
};

export function isSourceKind(kind: string): kind is SearchSourceKind {
  return (SEARCH_SOURCE_KINDS as readonly string[]).includes(kind);
}

export function isAts(kind: string): kind is Ats {
  return (ATS_KINDS as readonly string[]).includes(kind);
}

/**
 * Whether a source of this kind gives its whole list (so absence closes postings). ATS list
 * APIs and feeds do; boards show their latest jobs or a search. A page is complete when it
 * resolved to a feed or an ATS board; each run still reports what it actually got.
 */
export function completeList(kind: SearchSourceKind, resolved: ResolvedSource | null): boolean {
  if (kind === 'board') return false;
  if (kind === 'page') return resolved !== null;
  return true;
}

export function sourceKey(kind: SearchSourceKind, locator: string): string {
  return `${kind}:${locator}`;
}

/** The built-in boards: always present, on until switched off. */
export function ensureBuiltinSources(conn: Conn, now: Date): void {
  for (const [id, label] of Object.entries(BOARDS)) {
    const off = BOARDS_OFF[id as BoardId];
    conn
      .insert(searchSources)
      .values({
        key: sourceKey('board', id),
        kind: 'board',
        locator: id,
        label,
        origin: 'builtin',
        enabled: !off,
        lastNote: off ?? null,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
  }
}

export interface SourceInput {
  kind: SearchSourceKind;
  locator: string;
  label?: string | null;
  origin?: 'candidate' | 'agent';
}

/** Turns "greenhouse gitlab", a board URL or a career page URL into a source. */
export function parseSourceInput(args: string[], label: string | null = null): SourceInput {
  const [first, second] = args.map((a) => a.trim()).filter(Boolean);
  if (!first)
    throw new SearchError('which source? a kind and its board (greenhouse gitlab) or a URL');
  if (second === undefined) {
    let url: URL;
    try {
      url = new URL(first);
    } catch {
      throw new SearchError(
        `"${first}" is neither a URL nor a kind; use e.g. \`greenhouse gitlab\` or a career page URL`,
      );
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new SearchError(`only http(s) pages can be sources: "${first}"`);
    }
    // A board's own URL (jobs.lever.co/acme, job-boards.greenhouse.io/acme) is that board.
    const board = boardFromUrl(url.toString());
    if (board && !/\/embed\b/.test(url.pathname)) {
      return { kind: board.ats, locator: board.token, label };
    }
    url.hash = '';
    return { kind: 'page', locator: url.toString(), label };
  }
  if (!isSourceKind(first)) {
    throw new SearchError(`unknown source kind "${first}" (${SEARCH_SOURCE_KINDS.join(' | ')})`);
  }
  if (first === 'board' && !isBoardId(second)) {
    throw new SearchError(`unknown board "${second}" (${Object.keys(BOARDS).join(' | ')})`);
  }
  if (first === 'page') return parseSourceInput([second], label);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(second)) {
    throw new SearchError(`"${second}" doesn't look like a ${KIND_LABELS[first]} board name`);
  }
  return { kind: first, locator: second, label };
}

/** Adds a source (or returns the existing one with the same key). */
export function addSource(
  conn: Conn,
  input: SourceInput,
  now: Date,
): { source: SearchSourceRow; created: boolean } {
  const key = sourceKey(input.kind, input.locator);
  const existing = conn.select().from(searchSources).where(eq(searchSources.key, key)).get();
  if (existing) return { source: existing, created: false };
  const label =
    input.label?.trim() ||
    (input.kind === 'board' && isBoardId(input.locator)
      ? BOARDS[input.locator as BoardId]
      : input.kind === 'page'
        ? new URL(input.locator).hostname.replace(/^www\./, '')
        : input.locator);
  const source = conn
    .insert(searchSources)
    .values({
      key,
      kind: input.kind,
      locator: input.locator,
      label,
      origin: input.origin ?? 'candidate',
      createdAt: now,
    })
    .returning()
    .get();
  return { source, created: true };
}

export function kindsOff(conn: Conn): Set<SearchSourceKind> {
  return new Set(
    conn
      .select({ kind: searchSourceKinds.kind })
      .from(searchSourceKinds)
      .where(eq(searchSourceKinds.enabled, false))
      .all()
      .map((r) => r.kind),
  );
}

/**
 * Switches a source (by key or id) or a whole kind on or off. Returns what changed: the kind,
 * or the sources.
 */
export function setSourceEnabled(
  conn: Conn,
  target: string,
  enabled: boolean,
): { kind: SearchSourceKind | null; sources: SearchSourceRow[] } {
  const t = target.trim();
  if (isSourceKind(t)) {
    conn
      .insert(searchSourceKinds)
      .values({ kind: t, enabled })
      .onConflictDoUpdate({ target: searchSourceKinds.kind, set: { enabled } })
      .run();
    return { kind: t, sources: [] };
  }
  const row = findSource(conn, t);
  if (!row)
    throw new SearchError(`no search source "${target}" (see \`applyant search sources list\`)`);
  const updated = conn
    .update(searchSources)
    .set({ enabled })
    .where(eq(searchSources.id, row.id))
    .returning()
    .get();
  return { kind: null, sources: updated ? [updated] : [] };
}

/** A source by key ("board:hn"), id, or a unique locator ("gitlab", "hn"). */
export function findSource(conn: Conn, ref: string): SearchSourceRow | null {
  const byKey = conn.select().from(searchSources).where(eq(searchSources.key, ref)).get();
  if (byKey) return byKey;
  if (/^\d+$/.test(ref)) {
    const byId = conn
      .select()
      .from(searchSources)
      .where(eq(searchSources.id, Number(ref)))
      .get();
    if (byId) return byId;
  }
  const byLocator = conn.select().from(searchSources).where(eq(searchSources.locator, ref)).all();
  return byLocator.length === 1 ? (byLocator[0] ?? null) : null;
}

/** Whether a selector ("greenhouse", "board:hn", "all") picks this source. */
export function selects(selector: string, source: Pick<SearchSourceRow, 'key' | 'kind'>): boolean {
  return selector === 'all' || selector === source.kind || selector === source.key;
}

/** Checks a strategy's selectors: each must be "all", a kind, or a known source key. */
export function validateSelectors(conn: Conn, selectors: string[]): string[] {
  const clean = [...new Set(selectors.map((s) => s.trim()).filter(Boolean))];
  if (clean.length === 0) throw new SearchError('a strategy needs at least one source (or "all")');
  for (const s of clean) {
    if (s === 'all' || isSourceKind(s)) continue;
    const row = findSource(conn, s);
    if (!row) {
      throw new SearchError(
        `unknown source "${s}": use all, a kind (${SEARCH_SOURCE_KINDS.join(', ')}) or a source key from \`search sources list\``,
      );
    }
  }
  return clean.map((s) => (s === 'all' || isSourceKind(s) ? s : (findSource(conn, s)?.key ?? s)));
}

/**
 * The sources a strategy queries now: selected, switched on, and of a kind that's on. Company
 * boards and career pages come before job boards: their listings are the posting's own page,
 * and they get the run's new-posting slots first.
 */
export function sourcesFor(conn: Conn, selectors: string[]): SearchSourceRow[] {
  const off = kindsOff(conn);
  const order = (k: SearchSourceKind) => SEARCH_SOURCE_KINDS.indexOf(k);
  return conn
    .select()
    .from(searchSources)
    .where(eq(searchSources.enabled, true))
    .all()
    .filter((s) => !off.has(s.kind) && selectors.some((sel) => selects(sel, s)))
    .sort((a, b) => order(a.kind) - order(b.kind) || a.id - b.id);
}

export interface SearchStats {
  found: number;
  verified: number;
  interested: number;
  skipped: number;
}

export const NO_STATS: SearchStats = { found: 0, verified: 0, interested: 0, skipped: 0 };

/** Aggregates over joined postings: what a source or strategy found, and how it went. */
export const statsColumns = {
  found: sql<number>`count(distinct ${postings.id})`,
  verified: sql<number>`count(distinct case when ${postings.verifiedAt} is not null and ${postings.stage} != 'failed_verification' then ${postings.id} end)`,
  interested: sql<number>`count(distinct case when ${postings.decision} = 'interested' then ${postings.id} end)`,
  skipped: sql<number>`count(distinct case when ${postings.decision} = 'skipped' then ${postings.id} end)`,
};

/** found / verified / interested / skipped per search source. */
export function sourceStats(conn: Conn): Map<number, SearchStats> {
  const rows = conn
    .select({ sourceId: postingSources.searchSourceId, ...statsColumns })
    .from(postingSources)
    .innerJoin(postings, eq(postings.id, postingSources.postingId))
    .where(isNotNull(postingSources.searchSourceId))
    .groupBy(postingSources.searchSourceId)
    .all();
  return new Map(
    rows
      .filter((r) => r.sourceId !== null)
      .map((r) => [
        r.sourceId as number,
        { found: r.found, verified: r.verified, interested: r.interested, skipped: r.skipped },
      ]),
  );
}

export interface SourceView extends SearchSourceRow {
  kindEnabled: boolean;
  completeList: boolean;
  stats: SearchStats;
}

export interface KindView {
  kind: SearchSourceKind;
  label: string;
  enabled: boolean;
  sources: number;
}

export function listSources(conn: Conn): { sources: SourceView[]; kinds: KindView[] } {
  const off = kindsOff(conn);
  const stats = sourceStats(conn);
  const rows = conn.select().from(searchSources).all();
  const counts = new Map(
    conn
      .select({ kind: searchSources.kind, n: count() })
      .from(searchSources)
      .groupBy(searchSources.kind)
      .all()
      .map((r) => [r.kind, r.n]),
  );
  const order = (k: SearchSourceKind) => SEARCH_SOURCE_KINDS.indexOf(k);
  return {
    sources: rows
      .map((s) => ({
        ...s,
        kindEnabled: !off.has(s.kind),
        completeList: completeList(s.kind, s.resolved ?? null),
        stats: stats.get(s.id) ?? NO_STATS,
      }))
      .sort((a, b) => order(a.kind) - order(b.kind) || a.id - b.id),
    kinds: SEARCH_SOURCE_KINDS.map((kind) => ({
      kind,
      label: KIND_LABELS[kind],
      enabled: !off.has(kind),
      sources: counts.get(kind) ?? 0,
    })),
  };
}

/** Source rows by id, for mapping posting_sources back to them. */
export function sourcesById(conn: Conn, ids: number[]): Map<number, SearchSourceRow> {
  if (ids.length === 0) return new Map();
  return new Map(
    conn
      .select()
      .from(searchSources)
      .where(inArray(searchSources.id, ids))
      .all()
      .map((s) => [s.id, s]),
  );
}
