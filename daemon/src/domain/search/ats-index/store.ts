// The ATS index's store (docs/design/07-ats-index.md): every company board Applyant knows on
// the ATSs (`ats_companies`) and their open jobs (`ats_jobs`). Boards come in from discovery
// (discover.ts), from what searches match and what the planner finds (watchlist.ts,
// planner.ts), and from the watch list's own reads; the crawler (crawl.ts) reads them when
// they're due, and so does every search run that reads a watched board: one schedule counts
// both, so a board isn't read twice within its interval.
//
//   a board's read  its jobs upserted · a complete read closes the ones it no longer lists (an
//                   empty list for a board that had jobs only when a second read says so too),
//                   and with them, by the absence rules, the postings found through the index
//                   · counts, status and the next read by what the board holds
//   matching        a job any active strategy's queries and locations match keeps a capped
//                   description; a strategy run scans only those while the flags are current
//                   for the strategies (`matchingCurrent`), and a crawl flags them again after
//                   a strategy changed
//   search          board:ats-index: the open jobs of enabled boards of kinds that are on,
//                   newest first, without the boards the run reads itself
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Conn } from '../../../db/client.ts';
import {
  type AtsCompanyRow,
  type AtsFoundVia,
  appState,
  atsCompanies,
  atsJobs,
  postingSources,
  searchSources,
  searchStrategies,
} from '../../../db/schema.ts';
import type { Tx } from '../../../queue/types.ts';
import { type AbsenceResult, listedAgain, unlisted } from '../absence.ts';
import type { AtsRun } from '../readers/ats-api.ts';
import { ATS_KINDS, type Ats, type AtsBoard } from '../readers/ats-embed.ts';
import { INDEX_SOURCE_KEY } from '../readers/boards.ts';
import type { Listing } from '../readers/types.ts';
import { isAts, kindsOff, selects } from '../sources.ts';
import { matchesStrategy } from '../strategies.ts';

/** posting_sources.kind of a listing the index gave: its board's complete reads close it. */
export const INDEX_LINK_KIND = 'ats-index';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** When a board is read again, by what its last read found (the design's table). */
export const READ_AGAIN_MS = {
  /** Jobs an active strategy matches. */
  matching: 6 * HOUR,
  hiring: DAY,
  empty: 3 * DAY,
  /** 404/410: kept, in case the company comes back. */
  gone: 30 * DAY,
  /** The ATS asked to slow down (429): not the board's fault. */
  limited: HOUR,
} as const;
/** A failing board waits a day, doubling with every failure in a row, at most this long. */
export const MAX_FAILING_MS = 14 * DAY;
/** Closed jobs are kept this long (a job back on its board is the same job), then dropped. */
export const KEEP_CLOSED_MS = 30 * DAY;
/**
 * The text a matching job keeps: enough for dedupe's MinHash and a posting's first look, at a
 * size that holds for tens of thousands of matching jobs.
 */
const MAX_JOB_TEXT = 3000;

export function failingMs(fails: number): number {
  return Math.min(DAY * 2 ** Math.max(0, fails - 1), MAX_FAILING_MS);
}

/** "greenhouse:acme": a board whatever the case of its token. */
export function boardKey(ats: string, token: string): string {
  return `${ats}:${token.toLowerCase()}`;
}

const BOARD_TOKEN = /^[a-z0-9][a-z0-9._-]*$/i;

function chunks<T>(items: T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---- Boards ------------------------------------------------------------------------------

export interface NewBoard {
  board: AtsBoard;
  via: AtsFoundVia;
  name?: string | null;
  /** Why it's known: the job it was seen with, the planner's reason. */
  note?: string | null;
}

/**
 * Adds the boards the index doesn't know yet: `new`, due at once (the first read tells a real
 * board from a stale URL). A known one stays as it is, but gets its company's name if it had
 * none. At most `max` new ones; returns them.
 */
export function knowBoards(tx: Tx, boards: NewBoard[], o: { max?: number } = {}): AtsCompanyRow[] {
  const added: AtsCompanyRow[] = [];
  const seen = new Set<string>();
  for (const b of boards) {
    const { ats, token } = b.board;
    // A name the board's own URL can't carry (a reader's odd identifier) isn't a board.
    if (!isAts(ats) || !BOARD_TOKEN.test(token)) continue;
    const key = boardKey(ats, token);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = b.name?.trim() || null;
    const known = findCompany(tx.db, b.board);
    if (known) {
      if (name && !known.name) {
        tx.db.update(atsCompanies).set({ name }).where(eq(atsCompanies.id, known.id)).run();
      }
      continue;
    }
    if (o.max !== undefined && added.length >= o.max) continue;
    const row = tx.db
      .insert(atsCompanies)
      .values({
        ats,
        token,
        name,
        foundVia: b.via,
        foundNote: b.note?.trim() || null,
        nextReadAt: tx.now,
        createdAt: tx.now,
      })
      .onConflictDoNothing()
      .returning()
      .get();
    if (row) added.push(row);
  }
  return added;
}

export function findCompany(conn: Conn, board: AtsBoard): AtsCompanyRow | null {
  return (
    conn
      .select()
      .from(atsCompanies)
      .where(
        and(
          eq(atsCompanies.ats, board.ats),
          sql`lower(${atsCompanies.token}) = ${board.token.toLowerCase()}`,
        ),
      )
      .get() ?? null
  );
}

/**
 * The index is in use: its source is on (and the job boards' kind), and an active strategy
 * reads it. Otherwise nothing is crawled or discovered by itself.
 */
export function indexWanted(conn: Conn): boolean {
  const source = conn
    .select()
    .from(searchSources)
    .where(eq(searchSources.key, INDEX_SOURCE_KEY))
    .get();
  if (!source?.enabled || kindsOff(conn).has(source.kind)) return false;
  return conn
    .select({ sources: searchStrategies.sources })
    .from(searchStrategies)
    .where(eq(searchStrategies.state, 'active'))
    .all()
    .some((s) => s.sources.some((sel) => selects(sel, source)));
}

/** The ATSs whose kind is on. */
export function atsOn(conn: Conn): Ats[] {
  const off = kindsOff(conn);
  return ATS_KINDS.filter((k) => !off.has(k));
}

// ---- Matching ----------------------------------------------------------------------------

export interface Matcher {
  /** The active strategies' queries and locations: the flags are current for this key. */
  key: string;
  matches(l: Listing): boolean;
}

const MATCHING_KEY = 'ats_index_matching';

/** Whether any active strategy wants a job. */
export function activeMatcher(conn: Conn): Matcher {
  const strategies = conn
    .select({ queries: searchStrategies.queries, locations: searchStrategies.locations })
    .from(searchStrategies)
    .where(eq(searchStrategies.state, 'active'))
    .all();
  const key = JSON.stringify(
    strategies.map((s) => JSON.stringify([[...s.queries].sort(), [...s.locations].sort()])).sort(),
  );
  return { key, matches: (l) => strategies.some((s) => matchesStrategy(l, s)) };
}

/** The strategies the jobs' `matching` flags were last set for. */
export function matchingKey(conn: Conn): string | null {
  const row = conn.select().from(appState).where(eq(appState.key, MATCHING_KEY)).get();
  return typeof row?.value === 'string' ? row.value : null;
}

export function matchingCurrent(conn: Conn, matcher = activeMatcher(conn)): boolean {
  return matchingKey(conn) === matcher.key;
}

/** A stored job as a listing: what the strategies' queries look at, and its board. */
function asListing(
  job: typeof atsJobs.$inferSelect,
  company: Pick<AtsCompanyRow, 'ats' | 'token' | 'name'>,
): Listing {
  return {
    url: job.url,
    sourceUrl: job.url,
    externalId: job.externalId,
    title: job.title,
    company: company.name ?? company.token,
    location: job.location,
    remote: job.remote,
    team: job.team,
    description: job.description,
    applyUrl: null,
    postedAt: job.postedAt?.toISOString() ?? null,
    board: { ats: company.ats, token: company.token },
  };
}

export interface Rematch {
  on: number[];
  off: number[];
}

/** The open jobs whose flag a new set of strategies changes (a title scan, no network). */
export function rematchJobs(conn: Conn, matcher: Matcher): Rematch {
  const out: Rematch = { on: [], off: [] };
  const rows = conn
    .select({
      id: atsJobs.id,
      title: atsJobs.title,
      team: atsJobs.team,
      location: atsJobs.location,
      remote: atsJobs.remote,
      matching: atsJobs.matching,
    })
    .from(atsJobs)
    .where(isNull(atsJobs.closedAt))
    .all();
  for (const r of rows) {
    const m = matcher.matches({
      url: '',
      sourceUrl: '',
      externalId: null,
      company: null,
      description: null,
      applyUrl: null,
      postedAt: null,
      ...r,
    });
    if (m !== r.matching) (m ? out.on : out.off).push(r.id);
  }
  return out;
}

/**
 * Stores what `rematchJobs` found, if the strategies are still the ones it ran for. A job that
 * stops matching drops its description; boards that now hold matching jobs are read within
 * the matching interval.
 */
export function applyRematch(tx: Tx, rematch: Rematch, matcher: Matcher): boolean {
  if (activeMatcher(tx.db).key !== matcher.key) return false;
  for (const ids of chunks(rematch.on)) {
    tx.db.update(atsJobs).set({ matching: true }).where(inArray(atsJobs.id, ids)).run();
  }
  for (const ids of chunks(rematch.off)) {
    tx.db
      .update(atsJobs)
      .set({ matching: false, description: null })
      .where(inArray(atsJobs.id, ids))
      .run();
  }
  if (rematch.on.length || rematch.off.length) {
    tx.db
      .update(atsCompanies)
      .set({
        matching: sql`(select count(*) from ${atsJobs} where ${atsJobs.companyId} = ${atsCompanies.id} and ${atsJobs.closedAt} is null and ${atsJobs.matching} = 1)`,
      })
      .run();
    const soon = tx.now.getTime() + READ_AGAIN_MS.matching;
    tx.db
      .update(atsCompanies)
      .set({ nextReadAt: sql`min(${atsCompanies.nextReadAt}, ${soon})` })
      .where(and(sql`${atsCompanies.matching} > 0`, sql`${atsCompanies.status} != 'gone'`))
      .run();
  }
  tx.db
    .insert(appState)
    .values({ key: MATCHING_KEY, value: matcher.key })
    .onConflictDoUpdate({ target: appState.key, set: { value: matcher.key } })
    .run();
  return true;
}

// ---- A board's read ----------------------------------------------------------------------

export interface BoardRead {
  /** Null when the read failed. */
  run: AtsRun | null;
  error: string | null;
  /** The HTTP status it failed with, when it was one. */
  status: number | null;
}

export interface RecordedRead {
  /** Open jobs held after it, and how many an active strategy matches. */
  jobs: number;
  matching: number;
  added: number;
  closed: number;
  /** What it did to the postings found through the index. */
  postings: AbsenceResult;
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at) : null;
}

/** The sooner a board holds what the strategies want, the sooner it's read again. */
export function nextRead(now: Date, c: Pick<AtsCompanyRow, 'status' | 'matching' | 'fails'>): Date {
  const ms =
    c.status === 'gone'
      ? READ_AGAIN_MS.gone
      : c.status === 'failing'
        ? failingMs(c.fails)
        : c.matching > 0
          ? READ_AGAIN_MS.matching
          : c.status === 'hiring'
            ? READ_AGAIN_MS.hiring
            : READ_AGAIN_MS.empty;
  return new Date(now.getTime() + ms);
}

function indexLinks(tx: Tx, urls: string[]) {
  return chunks(urls).flatMap((part) =>
    tx.db
      .select()
      .from(postingSources)
      .where(and(eq(postingSources.kind, INDEX_LINK_KIND), inArray(postingSources.url, part)))
      .all(),
  );
}

/** Closes jobs gone from their board, and the postings the index found for them. */
function closeJobs(
  tx: Tx,
  jobs: Array<{ id: number; url: string }>,
  sourceKey: string,
  res: RecordedRead,
): void {
  if (jobs.length === 0) return;
  for (const part of chunks(jobs.map((j) => j.id))) {
    tx.db.update(atsJobs).set({ closedAt: tx.now }).where(inArray(atsJobs.id, part)).run();
  }
  res.closed += jobs.length;
  // A job page another board in the index still lists open (one company's jobs on two
  // boards) isn't gone: its link stays.
  const urls = [...new Set(jobs.map((j) => j.url))];
  const stillOpen = new Set(
    chunks(urls).flatMap((part) =>
      tx.db
        .select({ url: atsJobs.url })
        .from(atsJobs)
        .where(and(inArray(atsJobs.url, part), isNull(atsJobs.closedAt)))
        .all()
        .map((r) => r.url),
    ),
  );
  for (const link of indexLinks(
    tx,
    urls.filter((u) => !stillOpen.has(u)),
  )) {
    unlisted(tx, link, sourceKey, res.postings);
  }
}

function counts(tx: Tx, companyId: number): { jobs: number; matching: number } {
  const row = tx.db
    .select({
      jobs: sql<number>`count(*)`,
      matching: sql<number>`coalesce(sum(${atsJobs.matching}), 0)`,
    })
    .from(atsJobs)
    .where(and(eq(atsJobs.companyId, companyId), isNull(atsJobs.closedAt)))
    .get();
  return { jobs: row?.jobs ?? 0, matching: row?.matching ?? 0 };
}

/**
 * Records one read of a board (the crawler's, or a search run's of a watched board): its jobs,
 * what closed, the board's status and when it's read next.
 */
export function recordBoardRead(
  tx: Tx,
  company: AtsCompanyRow,
  read: BoardRead,
  matcher: Matcher,
): RecordedRead {
  const res: RecordedRead = {
    jobs: company.jobs,
    matching: company.matching,
    added: 0,
    closed: 0,
    postings: { closed: 0, reopened: 0, reverify: 0 },
  };
  const sourceKey = `${INDEX_SOURCE_KEY} (${company.ats} ${company.token})`;
  const open = () =>
    tx.db
      .select({ id: atsJobs.id, url: atsJobs.url })
      .from(atsJobs)
      .where(and(eq(atsJobs.companyId, company.id), isNull(atsJobs.closedAt)))
      .all();

  if (!read.run) {
    const gone = read.status === 404 || read.status === 410;
    const limited = read.status === 429;
    // The ATS says there's no such board: its jobs are gone with it.
    if (gone) closeJobs(tx, open(), sourceKey, res);
    const fails = gone ? 0 : limited ? company.fails : company.fails + 1;
    const status = gone ? 'gone' : limited ? company.status : 'failing';
    const after = counts(tx, company.id);
    res.jobs = after.jobs;
    res.matching = after.matching;
    tx.db
      .update(atsCompanies)
      .set({
        status,
        fails,
        ...after,
        lastReadAt: tx.now,
        nextReadAt: limited
          ? new Date(tx.now.getTime() + READ_AGAIN_MS.limited)
          : nextRead(tx.now, { status, matching: after.matching, fails }),
        lastNote: gone
          ? `gone: ${read.error}`
          : limited
            ? `asked to slow down (${read.error}); read again in an hour`
            : `failed: ${read.error}`,
      })
      .where(eq(atsCompanies.id, company.id))
      .run();
    return res;
  }

  const run = read.run;
  const known = new Map(
    tx.db
      .select({ id: atsJobs.id, key: atsJobs.key, url: atsJobs.url, closedAt: atsJobs.closedAt })
      .from(atsJobs)
      .where(eq(atsJobs.companyId, company.id))
      .all()
      .map((j) => [j.key, j]),
  );
  const seen = new Set<string>();
  const seenUrls: string[] = [];
  for (const l of run.listings) {
    const key = l.externalId ?? l.url;
    if (seen.has(key)) continue;
    seen.add(key);
    seenUrls.push(l.url);
    const matching = matcher.matches(l);
    const values = {
      url: l.url,
      title: l.title,
      location: l.location,
      remote: l.remote,
      team: l.team,
      postedAt: parseDate(l.postedAt),
      matching,
      lastSeenAt: tx.now,
      closedAt: null,
      // Only what a strategy matches keeps its text; a light list (no text) keeps what a full
      // read gave before.
      ...(!matching
        ? { description: null }
        : l.description
          ? { description: l.description.slice(0, MAX_JOB_TEXT) }
          : {}),
    };
    const prior = known.get(key);
    if (prior) {
      tx.db.update(atsJobs).set(values).where(eq(atsJobs.id, prior.id)).run();
    } else {
      tx.db
        .insert(atsJobs)
        .values({
          ...values,
          companyId: company.id,
          key,
          externalId: l.externalId,
          firstSeenAt: tx.now,
        })
        .run();
      res.added++;
    }
  }
  for (const link of indexLinks(tx, seenUrls)) listedAgain(tx, link, sourceKey, res.postings);

  let note = run.note;
  let trusted = true;
  if (run.complete) {
    const missing = [...known.values()].filter((j) => !j.closedAt && !seen.has(j.key));
    // An empty "complete" list from a board that had jobs is more likely a broken board than
    // every job closing at once: a second empty read in a row is believed.
    if (run.listings.length === 0 && missing.length > 0 && company.status !== 'empty') {
      trusted = false;
      note =
        `${note ?? ''} (an empty list: its ${missing.length} jobs stay until the next read says so too)`.trim();
    } else {
      closeJobs(tx, missing, sourceKey, res);
    }
  }
  if (res.closed) note = `${note ?? ''} · ${res.closed} closed`.trim();

  const after = counts(tx, company.id);
  res.jobs = after.jobs;
  res.matching = after.matching;
  const status = after.jobs > 0 && trusted ? 'hiring' : 'empty';
  const name = run.company ?? run.listings.find((l) => l.company)?.company ?? company.name ?? null;
  tx.db
    .update(atsCompanies)
    .set({
      status,
      fails: 0,
      ...after,
      name,
      lastReadAt: tx.now,
      // Untrusted: read again soon, to see whether it's really empty.
      nextReadAt: trusted
        ? nextRead(tx.now, { status, matching: after.matching, fails: 0 })
        : new Date(tx.now.getTime() + READ_AGAIN_MS.matching),
      lastNote: note,
      ...(run.apiHost ? { resolved: { ...company.resolved, apiHost: run.apiHost } } : {}),
    })
    .where(eq(atsCompanies.id, company.id))
    .run();
  tx.db
    .delete(atsJobs)
    .where(
      and(
        eq(atsJobs.companyId, company.id),
        lt(atsJobs.closedAt, new Date(tx.now.getTime() - KEEP_CLOSED_MS)),
      ),
    )
    .run();
  return res;
}

/**
 * A search run read a watched board (or a career page that reads one) in full: that's a read
 * of the index's board too. The board joins the index if it isn't in it yet.
 */
export function recordWatchedRead(
  tx: Tx,
  input: { board: AtsBoard; via: AtsFoundVia; name: string | null; run: AtsRun },
  matcher: Matcher,
): void {
  knowBoards(tx, [{ board: input.board, via: input.via, name: input.name }]);
  const company = findCompany(tx.db, input.board);
  if (!company?.enabled) return;
  recordBoardRead(tx, company, { run: input.run, error: null, status: null }, matcher);
}

// ---- Search ------------------------------------------------------------------------------

export interface IndexSearch {
  wants: (l: Listing) => boolean;
  /** Only these ATSs (a strategy that selects kinds); null: every one that's on. */
  ats: readonly Ats[] | null;
  /** Boards the run reads itself (watched ones): their jobs come from there. */
  skip: ReadonlySet<string>;
  /** Scan only jobs flagged as matching: the flags are current and the strategy is active. */
  matchingOnly: boolean;
}

/** The index's open jobs a strategy wants, newest first. */
export function indexListings(conn: Conn, o: IndexSearch): { listings: Listing[]; note: string } {
  const kinds = atsOn(conn).filter((k) => !o.ats || o.ats.includes(k));
  if (kinds.length === 0) {
    return { listings: [], note: 'the ATS index: the ATSs it would search are switched off' };
  }
  const rows = conn
    .select({
      job: atsJobs,
      ats: atsCompanies.ats,
      token: atsCompanies.token,
      name: atsCompanies.name,
    })
    .from(atsJobs)
    .innerJoin(atsCompanies, eq(atsCompanies.id, atsJobs.companyId))
    .where(
      and(
        isNull(atsJobs.closedAt),
        ...(o.matchingOnly ? [eq(atsJobs.matching, true)] : []),
        eq(atsCompanies.enabled, true),
        inArray(atsCompanies.ats, kinds),
      ),
    )
    .orderBy(desc(sql`coalesce(${atsJobs.postedAt}, ${atsJobs.firstSeenAt})`), desc(atsJobs.id))
    .all();
  const listings: Listing[] = [];
  const boards = new Set<string>();
  for (const r of rows) {
    const key = boardKey(r.ats, r.token);
    if (o.skip.has(key)) continue;
    const l = asListing(r.job, r);
    if (!o.wants(l)) continue;
    listings.push(l);
    boards.add(key);
  }
  return {
    listings,
    note: `the ATS index: ${listings.length} job${listings.length === 1 ? '' : 's'} at ${boards.size} compan${boards.size === 1 ? 'y' : 'ies'}`,
  };
}

/**
 * The ATSs a strategy's selectors ask of the index: null for all of them ("all", the job
 * boards' kind, the index itself), else the ATS kinds it names.
 */
export function indexAtsFor(selectors: string[]): Ats[] | null {
  if (selectors.some((s) => s === 'all' || s === 'board' || s === INDEX_SOURCE_KEY)) return null;
  return selectors.filter(isAts);
}
