// The ATS index's crawler (index_crawl): reads the boards that are due, oldest due first.
//
//   scheduler  a crawl every CRAWL_EVERY_MS while the index is in use (an active strategy reads
//              board:ats-index), something is due and background work isn't paused
//   slow       per ATS whose kind is on, at most its budget of due boards, read through the
//              light list APIs (Greenhouse without descriptions), a few at a time per ATS and
//              Workable's one at a time in its paced lane; an ATS that answers 429 isn't asked
//              again this run · after a strategy changed, every open job's `matching` again
//   commit     each read into the store (store.ts: jobs, closing, status, next read)
//
// The budgets keep a crawl polite: about 190 requests every five minutes across five hosts,
// enough to read 20k boards on their schedules.
import { and, eq, inArray, lte, max } from 'drizzle-orm';
import type { Conn } from '../../../db/client.ts';
import { type AtsCompanyRow, atsCompanies, tasks } from '../../../db/schema.ts';
import type { Handler, Tx } from '../../../queue/types.ts';
import { readAtsBoard, readAtsBoardShared } from '../readers/ats-api.ts';
import type { Ats } from '../readers/ats-embed.ts';
import { HttpError } from '../readers/http.ts';
import { DAEMON_READS, SharedReads } from '../readers/shared.ts';
import type { ReaderContext } from '../readers/types.ts';
import {
  activeMatcher,
  applyRematch,
  atsOn,
  type BoardRead,
  indexWanted,
  type Matcher,
  matchingCurrent,
  matchingKey,
  type Rematch,
  recordBoardRead,
  rematchJobs,
} from './store.ts';

/** A crawl starts at most this often. */
export const CRAWL_EVERY_MS = 5 * 60_000;

/** Boards per ATS one crawl reads; an ATS not listed gets DEFAULT_BUDGET. */
export const CRAWL_BUDGET: Partial<Record<Ats, number>> = {
  greenhouse: 60,
  ashby: 60,
  lever: 40,
  smartrecruiters: 20,
  // Workable answers bursts with 429: few, a second apart (its lane in DAEMON_READS).
  workable: 10,
};
const DEFAULT_BUDGET = 20;

/** Reads at a time per ATS. */
const PARALLEL: Partial<Record<Ats, number>> = { greenhouse: 3, ashby: 3, workable: 1 };
const DEFAULT_PARALLEL = 2;

function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split('\n')[0] ?? text;
}

/** The boards due now, per ATS that's on, oldest due first, each ATS within its budget. */
export function dueBoards(conn: Conn, now: Date): AtsCompanyRow[] {
  return atsOn(conn).flatMap((ats) =>
    conn
      .select()
      .from(atsCompanies)
      .where(
        and(
          eq(atsCompanies.ats, ats),
          eq(atsCompanies.enabled, true),
          lte(atsCompanies.nextReadAt, now),
        ),
      )
      .orderBy(atsCompanies.nextReadAt, atsCompanies.id)
      .limit(CRAWL_BUDGET[ats] ?? DEFAULT_BUDGET)
      .all(),
  );
}

function crawlBusy(conn: Conn): boolean {
  return !!conn
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.kind, 'index_crawl'), inArray(tasks.status, ['queued', 'running'])))
    .get();
}

/** The scheduler's part: a crawl when one is due. Returns its task id. */
export function scheduleCrawl(tx: Tx): number | null {
  if (crawlBusy(tx.db) || !indexWanted(tx.db)) return null;
  const last = tx.db
    .select({ at: max(tasks.createdAt) })
    .from(tasks)
    .where(eq(tasks.kind, 'index_crawl'))
    .get()?.at;
  if (last && tx.now.getTime() - last.getTime() < CRAWL_EVERY_MS) return null;
  const due = atsOn(tx.db).some(
    (ats) =>
      !!tx.db
        .select({ id: atsCompanies.id })
        .from(atsCompanies)
        .where(
          and(
            eq(atsCompanies.ats, ats),
            eq(atsCompanies.enabled, true),
            lte(atsCompanies.nextReadAt, tx.now),
          ),
        )
        .get(),
  );
  if (!due && matchingCurrent(tx.db)) return null;
  return tx.enqueue('index_crawl', 0, { runId: null });
}

interface CrawlRead {
  companyId: number;
  read: BoardRead;
}

async function readCompany(c: AtsCompanyRow, ctx: ReaderContext): Promise<BoardRead> {
  try {
    // Greenhouse's light list is another request than the full one search runs make: it isn't
    // shared with them. The other ATSs' lists are the same, and shared for a while.
    const run =
      c.ats === 'greenhouse'
        ? await readAtsBoard('greenhouse', c.token, ctx, { light: true })
        : await readAtsBoardShared(c.ats, c.token, ctx, { apiHost: c.resolved?.apiHost });
    return { run, error: null, status: null };
  } catch (err) {
    ctx.signal.throwIfAborted();
    return { run: null, error: message(err), status: err instanceof HttpError ? err.status : null };
  }
}

/** One ATS's due boards, a few at a time; once it answers 429 the rest wait for a later crawl. */
async function readLane(ats: Ats, boards: AtsCompanyRow[], ctx: ReaderContext) {
  const out: CrawlRead[] = [];
  let limited = false;
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < boards.length && !limited; i = next++) {
      const c = boards[i] as AtsCompanyRow;
      const read = await readCompany(c, ctx);
      if (read.status === 429) limited = true;
      out.push({ companyId: c.id, read });
    }
  };
  const n = Math.min(PARALLEL[ats] ?? DEFAULT_PARALLEL, boards.length);
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

export const indexCrawl: Handler<'index_crawl'> = async (_task, ctx) => {
  const now = ctx.now();
  const matcher = activeMatcher(ctx.read);
  // The strategies changed since the flags were set: every open job is matched again.
  const rematch = matchingKey(ctx.read) === matcher.key ? null : rematchJobs(ctx.read, matcher);
  const due = dueBoards(ctx.read, now);
  if (due.length) ctx.progress({ message: `the ATS index: reading ${due.length} due board(s)` });
  const live = !ctx.deps.fetch;
  const rctx: ReaderContext = {
    fetch: ctx.deps.fetch ?? globalThis.fetch,
    signal: ctx.signal,
    queries: [],
    now,
    shared: live ? DAEMON_READS : new SharedReads(),
  };
  const lanes = new Map<Ats, AtsCompanyRow[]>();
  for (const c of due) lanes.set(c.ats, [...(lanes.get(c.ats) ?? []), c]);
  const reads = (
    await Promise.all([...lanes].map(([ats, boards]) => readLane(ats, boards, rctx)))
  ).flat();
  return { kind: 'done', commit: (tx) => commitCrawl(tx, { reads, rematch, matcher }) };
};

export interface CrawlResult {
  read: number;
  failed: number;
  added: number;
  closed: number;
  postingsClosed: number;
  rematched: boolean;
}

export function commitCrawl(
  tx: Tx,
  input: { reads: CrawlRead[]; rematch: Rematch | null; matcher: Matcher },
): CrawlResult {
  const rematched = input.rematch ? applyRematch(tx, input.rematch, input.matcher) : false;
  // Jobs are matched against the strategies as they are now.
  const matcher = activeMatcher(tx.db);
  const out: CrawlResult = {
    read: 0,
    failed: 0,
    added: 0,
    closed: 0,
    postingsClosed: 0,
    rematched,
  };
  for (const r of input.reads) {
    const company = tx.db.select().from(atsCompanies).where(eq(atsCompanies.id, r.companyId)).get();
    // Switched off (or gone) while it was being read.
    if (!company?.enabled) continue;
    const res = recordBoardRead(tx, company, r.read, matcher);
    out.read++;
    if (!r.read.run) out.failed++;
    out.added += res.added;
    out.closed += res.closed;
    out.postingsClosed += res.postings.closed;
  }
  if (out.read) {
    const parts = [
      `${out.read} board${out.read === 1 ? '' : 's'} read`,
      ...(out.failed ? [`${out.failed} failed`] : []),
      `${out.added} new job${out.added === 1 ? '' : 's'}`,
      ...(out.closed ? [`${out.closed} closed`] : []),
      ...(out.postingsClosed
        ? [`${out.postingsClosed} posting${out.postingsClosed === 1 ? '' : 's'} closed`]
        : []),
    ];
    tx.emit({ kind: 'search.index', stage: 'crawled', runId: null, message: parts.join(' · ') });
  }
  return out;
}
