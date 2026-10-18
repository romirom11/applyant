// The ATS index (docs/design/07): company boards found in Common Crawl and in Applyant's own
// data, read by the crawler on their own schedules into a store of open jobs, and searched by
// strategies through board:ats-index without a request. A job gone from its board's complete
// read closes the posting the index found for it; kind and company switches take boards out.
import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  atsCompanies,
  atsDiscoveries,
  atsJobs,
  postingSources,
  postings,
  tasks,
} from '../src/db/schema.ts';
import { dueBoards, indexCrawl, scheduleCrawl } from '../src/domain/search/ats-index/crawl.ts';
import {
  CDX_COLLECTIONS,
  type CdxOptions,
  commonCrawlBoards,
  crawledBoard,
  DISCOVER_EVERY_MS,
  indexDiscover,
  scheduleDiscovery,
  startDiscovery,
} from '../src/domain/search/ats-index/discover.ts';
import {
  knowBoards,
  matchingCurrent,
  READ_AGAIN_MS,
} from '../src/domain/search/ats-index/store.ts';
import { setCompanyEnabled } from '../src/domain/search/ats-index/views.ts';
import type { Ats } from '../src/domain/search/readers/ats-embed.ts';
import type { Fetch } from '../src/domain/search/readers/types.ts';
import { addSource, setSourceEnabled } from '../src/domain/search/sources.ts';
import {
  DiscoverIndexCompaniesRequestSchema,
  type DiscoverIndexCompaniesResponse,
  GetAtsIndexRequestSchema,
  type GetAtsIndexResponse,
  ListIndexCompaniesRequestSchema,
  type ListIndexCompaniesResponse,
  SetIndexCompanyEnabledRequestSchema,
  type SetIndexCompanyEnabledResponse,
} from '../src/gen/applyant/v1/applyant_pb.js';
import { setPaused } from '../src/queue/pause.ts';
import { Scheduler } from '../src/queue/scheduler.ts';
import { runInTx } from '../src/queue/tx.ts';
import { searchRpcs } from '../src/rpc/search.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { quietLog } from './helpers/deps.ts';
import { recordedFetch, type SearchHarness, searchHarness } from './helpers/search.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const GH = (token: string) => `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`;
const ASHBY = (slug: string) =>
  `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
const WORKABLE = (account: string) =>
  `https://apply.workable.com/api/v1/widget/accounts/${account}?details=true`;

const ghJob = (id: number, title: string, o: { location?: string; posted?: string } = {}) => ({
  id,
  title,
  company_name: 'Acme',
  absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
  location: { name: o.location ?? 'Remote, EU' },
  first_published: o.posted ?? '2026-10-10T10:00:00Z',
});
const ghBoard = (...jobs: ReturnType<typeof ghJob>[]) => ({ jobs, meta: { total: jobs.length } });
const ashbyJob = (n: number, title: string, o: { location?: string; posted?: string } = {}) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  title,
  jobUrl: `https://jobs.ashbyhq.com/beta/00000000-0000-4000-8000-00000000000${n}`,
  location: o.location ?? 'Remote',
  isRemote: (o.location ?? 'Remote') === 'Remote',
  publishedAt: o.posted ?? '2026-10-12T10:00:00Z',
  descriptionPlain: `${title} at Beta.`,
});

describe('the ATS index', () => {
  let t: TempDb;
  let h: SearchHarness;
  let clock: Date;

  beforeEach(() => {
    t = tempDb();
    clock = new Date('2026-10-18T10:00:00Z');
    h = searchHarness(t, {
      fetch: recordedFetch(),
      now: () => clock,
      handlers: { index_crawl: indexCrawl, index_discover: indexDiscover },
    });
  });
  afterEach(async () => {
    await h.stop();
    t.cleanup();
  });

  const reply = (url: string, body: unknown, status = 200) =>
    h.fetch.replies.set(url, {
      status,
      body: JSON.stringify(body),
      contentType: 'application/json',
    });
  const later = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  const know = (...boards: Array<[Ats, string]>) =>
    runInTx(t.db, h.bus, { now: clock }, (tx) =>
      knowBoards(
        tx,
        boards.map(([ats, token]) => ({ board: { ats, token }, via: 'common-crawl' as const })),
      ),
    );
  const crawl = async () => {
    runInTx(t.db, h.bus, { now: clock }, (tx) => tx.enqueue('index_crawl', 0, { runId: null }));
    await h.worker.idle();
  };
  const company = (token: string) => {
    const c = t.db.select().from(atsCompanies).where(eq(atsCompanies.token, token)).get();
    if (!c) throw new Error(`no company ${token}`);
    return c;
  };
  const jobsOf = (token: string) =>
    t.db
      .select()
      .from(atsJobs)
      .where(eq(atsJobs.companyId, company(token).id))
      .orderBy(atsJobs.id)
      .all();
  const fromNow = (ms: number) => new Date(clock.getTime() + ms);
  /** A strategy reading only the index (it runs once right away, on an empty index). */
  const strategy = (queries: string[], locations: string[] = []) =>
    h.run({ name: queries.join(' · '), queries, locations, sources: ['board:ats-index'] });

  it('the crawler reads due boards through the light lists, and schedules each by what it holds', async () => {
    await strategy(['ai engineer']);
    know(['greenhouse', 'acme'], ['greenhouse', 'quiet'], ['ashby', 'beta'], ['lever', 'gamma']);
    know(['lever', 'delta']);
    reply(GH('acme'), ghBoard(ghJob(1, 'Senior AI Engineer'), ghJob(2, 'Office Manager')));
    reply(GH('quiet'), ghBoard());
    reply(ASHBY('beta'), {
      jobs: [ashbyJob(1, 'AI Engineer'), ashbyJob(2, 'Data Analyst', { location: 'Berlin' })],
    });
    reply('https://api.lever.co/v0/postings/delta?mode=json', [
      {
        id: '0cc069a3-f9c2-4d8b-a0d6-db117b3f02e7',
        text: 'Office Manager',
        hostedUrl: 'https://jobs.lever.co/delta/0cc069a3-f9c2-4d8b-a0d6-db117b3f02e7',
        categories: { location: 'Athens' },
        createdAt: Date.parse('2026-10-01T00:00:00Z'),
      },
    ]);
    await crawl();

    // Greenhouse's light list: no descriptions asked for.
    expect(h.fetch.calls).toContain(GH('acme'));
    expect(h.fetch.calls.some((u) => u.includes('content=true'))).toBe(false);
    const view = (token: string) => {
      const c = company(token);
      return [c.status, c.jobs, c.matching, c.nextReadAt, c.name];
    };
    expect(view('acme')).toEqual(['hiring', 2, 1, fromNow(READ_AGAIN_MS.matching), 'Acme']);
    expect(view('beta')).toEqual(['hiring', 2, 1, fromNow(READ_AGAIN_MS.matching), null]);
    expect(view('delta')).toEqual(['hiring', 1, 0, fromNow(READ_AGAIN_MS.hiring), null]);
    expect(view('quiet')).toEqual(['empty', 0, 0, fromNow(READ_AGAIN_MS.empty), null]);
    // Lever has no such board on either host: gone, looked at again in a month.
    expect(view('gamma')).toEqual(['gone', 0, 0, fromNow(READ_AGAIN_MS.gone), null]);
    expect(company('gamma').lastNote).toMatch(/^gone: HTTP 404 /);
    // Only what a strategy matches keeps its text.
    expect(jobsOf('beta').map((j) => [j.title, j.matching, j.description])).toEqual([
      ['AI Engineer', true, 'AI Engineer at Beta.'],
      ['Data Analyst', false, null],
    ]);

    // Nothing is due for a while: no crawl is started.
    later(10 * 60_000);
    expect(runInTx(t.db, h.bus, { now: clock }, (tx) => scheduleCrawl(tx))).toBeNull();
    later(READ_AGAIN_MS.matching);
    expect(runInTx(t.db, h.bus, { now: clock }, (tx) => scheduleCrawl(tx))).not.toBeNull();
    // One at a time.
    expect(runInTx(t.db, h.bus, { now: clock }, (tx) => scheduleCrawl(tx))).toBeNull();
  });

  it('per ATS at most its budget per crawl, oldest due first; a kind switched off is not read', () => {
    know(...Array.from({ length: 65 }, (_, i): [Ats, string] => ['greenhouse', `gh${i}`]));
    know(...Array.from({ length: 12 }, (_, i): [Ats, string] => ['workable', `wk${i}`]));
    const count = (ats: Ats) => dueBoards(t.db, clock).filter((c) => c.ats === ats).length;
    expect([count('greenhouse'), count('workable')]).toEqual([60, 10]);
    expect(dueBoards(t.db, clock)[0]?.token).toBe('gh0');
    setSourceEnabled(t.db, 'greenhouse', false);
    expect([count('greenhouse'), count('workable')]).toEqual([0, 10]);
  });

  it('a failing board waits a day, then two; an ATS that answers 429 is left alone for the rest of the crawl', async () => {
    await strategy(['ai engineer']);
    know(['ashby', 'flaky'], ['workable', 'w1'], ['workable', 'w2'], ['workable', 'w3']);
    reply(ASHBY('flaky'), { error: 'down' }, 500);
    reply(WORKABLE('w1'), { error: 'slow down' }, 429);
    reply(WORKABLE('w2'), { name: 'W2', jobs: [] });
    await crawl();
    expect(company('flaky')).toMatchObject({
      status: 'failing',
      fails: 1,
      nextReadAt: fromNow(DAY),
    });
    // Workable said 429 to the first: the others wait for a later crawl.
    expect(company('w1')).toMatchObject({ status: 'new', fails: 0, nextReadAt: fromNow(HOUR) });
    expect(company('w1').lastNote).toMatch(/^asked to slow down/);
    expect([company('w2').lastReadAt, company('w3').lastReadAt]).toEqual([null, null]);
    expect(h.fetch.calls.filter((u) => u.includes('workable'))).toEqual([WORKABLE('w1')]);

    later(DAY);
    await crawl();
    expect(company('flaky')).toMatchObject({ fails: 2, nextReadAt: fromNow(2 * DAY) });
    reply(ASHBY('flaky'), { jobs: [ashbyJob(1, 'Office Manager')] });
    later(2 * DAY);
    await crawl();
    expect(company('flaky')).toMatchObject({ status: 'hiring', fails: 0, jobs: 1 });
  });

  it('a job gone from its board closes the posting the index found for it, and opens it again when it is back', async () => {
    const run = await strategy(['ai engineer']);
    expect(h.runRow(run)?.results[0]).toMatchObject({
      sourceKey: 'board:ats-index',
      listed: 0,
      complete: false,
    });
    know(['greenhouse', 'acme']);
    reply(GH('acme'), ghBoard(ghJob(1, 'Senior AI Engineer'), ghJob(2, 'Office Manager')));
    await crawl();
    const found = await h.again(1);
    expect(h.runRow(found)?.results[0]).toMatchObject({ listed: 1, matched: 1, added: 1 });
    const posting = t.db.select().from(postings).get();
    expect(posting).toMatchObject({
      canonicalUrl: 'https://job-boards.greenhouse.io/acme/jobs/1',
      company: 'Acme',
      stage: 'found',
    });
    const link = () =>
      t.db
        .select()
        .from(postingSources)
        .where(eq(postingSources.postingId, posting?.id ?? 0))
        .get();
    expect(link()).toMatchObject({ kind: 'ats-index', closedAt: null });
    // The index's own jobs are on boards it knows: nothing new joins it.
    expect(t.db.select().from(atsCompanies).all()).toHaveLength(1);

    reply(GH('acme'), ghBoard(ghJob(2, 'Office Manager')));
    later(READ_AGAIN_MS.matching);
    await crawl();
    expect(h.posting(posting?.id ?? 0)).toMatchObject({
      stage: 'closed',
      verifyNote:
        'closed: no longer listed on board:ats-index (greenhouse acme) (its complete list)',
    });
    expect(link()?.closedAt).toEqual(clock);
    expect(jobsOf('acme').map((j) => [j.title, j.closedAt])).toEqual([
      ['Senior AI Engineer', clock],
      ['Office Manager', null],
    ]);
    expect(company('acme')).toMatchObject({ jobs: 1, matching: 0, nextReadAt: fromNow(DAY) });
    // A run doesn't list it any more, and says nothing about it either.
    const quiet = await h.again(1);
    expect(h.runRow(quiet)?.results[0]).toMatchObject({ listed: 0, closed: 0, reverify: 0 });

    reply(GH('acme'), ghBoard(ghJob(1, 'Senior AI Engineer'), ghJob(2, 'Office Manager')));
    later(DAY);
    await crawl();
    expect(h.posting(posting?.id ?? 0)?.stage).toBe('found');
    expect(link()?.closedAt).toBeNull();
    expect(jobsOf('acme').map((j) => j.closedAt)).toEqual([null, null]);
  });

  it('an empty list from a board that had jobs closes them only when the next read says so too', async () => {
    await strategy(['ai engineer']);
    know(['greenhouse', 'acme']);
    reply(GH('acme'), ghBoard(ghJob(1, 'Senior AI Engineer'), ghJob(2, 'Office Manager')));
    await crawl();
    reply(GH('acme'), ghBoard());
    later(READ_AGAIN_MS.matching);
    await crawl();
    expect(company('acme')).toMatchObject({
      status: 'empty',
      jobs: 2,
      nextReadAt: fromNow(READ_AGAIN_MS.matching),
    });
    expect(company('acme').lastNote).toContain('an empty list: its 2 jobs stay');
    later(READ_AGAIN_MS.matching);
    await crawl();
    expect(company('acme')).toMatchObject({
      status: 'empty',
      jobs: 0,
      nextReadAt: fromNow(READ_AGAIN_MS.empty),
    });
    expect(jobsOf('acme').every((j) => j.closedAt !== null)).toBe(true);
  });

  it("a strategy searches the index's open jobs, newest first; kind and company switches take boards out", async () => {
    await strategy(['ai engineer'], ['remote']);
    know(['greenhouse', 'acme'], ['ashby', 'beta']);
    reply(
      GH('acme'),
      ghBoard(
        ghJob(1, 'AI Engineer', { posted: '2026-10-10T10:00:00Z' }),
        ghJob(2, 'Senior AI Engineer', { location: 'Berlin', posted: '2026-10-15T10:00:00Z' }),
      ),
    );
    reply(ASHBY('beta'), {
      jobs: [ashbyJob(1, 'AI Engineer', { posted: '2026-10-12T10:00:00Z' })],
    });
    await crawl();
    const run = await h.again(1);
    expect(h.runRow(run)?.results[0]).toMatchObject({
      sourceKey: 'board:ats-index',
      listed: 2,
      matched: 2,
      added: 2,
      note: 'the ATS index: 2 jobs at 2 companies',
    });
    // Newest first, each with its board's company (Ashby's list doesn't name it: its token).
    expect(
      t.db
        .select()
        .from(postings)
        .orderBy(postings.id)
        .all()
        .map((p) => [p.company, p.canonicalUrl]),
    ).toEqual([
      ['beta', 'https://jobs.ashbyhq.com/beta/00000000-0000-4000-8000-000000000001'],
      ['Acme', 'https://job-boards.greenhouse.io/acme/jobs/1'],
    ]);

    setSourceEnabled(t.db, 'ashby', false);
    const noAshby = await h.again(1);
    expect(h.runRow(noAshby)?.results[0]).toMatchObject({ listed: 1 });
    setCompanyEnabled(t.db, company('acme').id, false);
    const none = await h.again(1);
    expect(h.runRow(none)?.results[0]).toMatchObject({ listed: 0 });
    // Neither is read either.
    later(30 * DAY);
    expect(dueBoards(t.db, clock)).toEqual([]);
  });

  it('a watched board read by a search run counts as its read in the index, and the index leaves its jobs to it', async () => {
    addSource(t.db, { kind: 'greenhouse', locator: 'acme' }, clock);
    reply(`${GH('acme')}?content=true`, {
      jobs: [
        { ...ghJob(1, 'Senior AI Engineer'), content: '&lt;p&gt;Agents.&lt;/p&gt;' },
        { ...ghJob(2, 'Office Manager'), content: '&lt;p&gt;Office.&lt;/p&gt;' },
      ],
      meta: { total: 2 },
    });
    // "greenhouse": the watched board and the index's Greenhouse boards.
    const run = await h.run({ name: 'AI', queries: ['ai engineer'], sources: ['greenhouse'] });
    expect(h.runRow(run)?.results.map((r) => [r.sourceKey, r.listed, r.added])).toEqual([
      ['greenhouse:acme', 2, 1],
      ['board:ats-index', 0, 0],
    ]);
    expect(company('acme')).toMatchObject({
      foundVia: 'candidate',
      status: 'hiring',
      jobs: 2,
      matching: 1,
      lastReadAt: clock,
      nextReadAt: fromNow(READ_AGAIN_MS.matching),
    });
    expect(jobsOf('acme').map((j) => j.description)).toEqual(['Agents.', null]);
    // The next run reads the board itself again; the index doesn't list its jobs twice.
    const again = await h.again(1);
    expect(h.runRow(again)?.results.map((r) => [r.sourceKey, r.listed])).toEqual([
      ['greenhouse:acme', 2],
      ['board:ats-index', 0],
    ]);
    // The crawler doesn't read it before its time.
    await crawl();
    expect(h.fetch.calls.filter((u) => u === GH('acme'))).toEqual([]);
  });

  it('a new or changed strategy finds its jobs at once; the next crawl flags them as matching', async () => {
    await strategy(['ai engineer']);
    know(['greenhouse', 'acme']);
    reply(GH('acme'), ghBoard(ghJob(1, 'Senior AI Engineer'), ghJob(2, 'Office Manager')));
    await crawl();
    expect(matchingCurrent(t.db)).toBe(true);
    expect(jobsOf('acme').map((j) => j.matching)).toEqual([true, false]);

    const ops = await strategy(['office manager']);
    expect(h.runRow(ops)?.results[0]).toMatchObject({ listed: 1, added: 1 });
    expect(matchingCurrent(t.db)).toBe(false);
    // Nothing is due, but the flags are stale: a crawl comes.
    later(10 * 60_000);
    expect(runInTx(t.db, h.bus, { now: clock }, (tx) => scheduleCrawl(tx))).not.toBeNull();
    await h.worker.idle();
    expect(matchingCurrent(t.db)).toBe(true);
    expect(jobsOf('acme').map((j) => j.matching)).toEqual([true, true]);
    expect(company('acme').matching).toBe(2);
    expect(h.fetch.calls.filter((u) => u === GH('acme'))).toHaveLength(1);
  });

  it('nothing is crawled or discovered by itself while no active strategy reads the index, or while paused', async () => {
    know(['greenhouse', 'acme']);
    const tick = () =>
      new Scheduler({
        db: t.db,
        bus: h.bus,
        log: quietLog,
        intervalMs: 60_000,
        now: () => clock,
      }).tick('schedule');
    const indexTasks = () =>
      t.db
        .select()
        .from(tasks)
        .all()
        .filter((x) => x.kind.startsWith('index_')).length;
    tick();
    expect(indexTasks()).toBe(0);
    // A strategy reading only one board doesn't read the index.
    addSource(t.db, { kind: 'greenhouse', locator: 'acme' }, clock);
    await h.run({ name: 'Mine', queries: [], sources: ['greenhouse:acme'] });
    tick();
    expect(indexTasks()).toBe(0);
    await strategy(['ai engineer']);
    runInTx(t.db, h.bus, { now: clock }, (tx) => setPaused(tx, true));
    tick();
    expect(indexTasks()).toBe(0);
    runInTx(t.db, h.bus, { now: clock }, (tx) => setPaused(tx, false));
    tick();
    expect(
      t.db
        .select()
        .from(tasks)
        .all()
        .filter((x) => x.kind.startsWith('index_'))
        .map((x) => x.kind)
        .sort(),
    ).toEqual(['index_crawl', 'index_discover']);
  });
});

// ---- Discovery -------------------------------------------------------------------------------

const API = (id: string) => `https://index.commoncrawl.org/${id}-index`;
const cdx = (id: string, pattern: string, page?: number) =>
  `${API(id)}?url=${pattern}&output=json&fl=url${page === undefined ? '&showNumPages=true' : `&page=${page}`}`;
const lines = (...urls: string[]) => `${urls.map((url) => JSON.stringify({ url })).join('\n')}\n`;

/** Replies by URL; a list of statuses before the reply makes it flaky. */
function cdxFetch(routes: Record<string, { body: string; fail?: number[] }>): Fetch & {
  calls: string[];
} {
  const tries = new Map<string, number>();
  const calls: string[] = [];
  const fetch = (async (url: string) => {
    calls.push(url);
    const route = routes[url];
    if (!route) return new Response('No Captures found', { status: 404 });
    const n = tries.get(url) ?? 0;
    tries.set(url, n + 1);
    const fail = route.fail?.[n];
    if (fail) return new Response('busy', { status: fail });
    return new Response(route.body, { status: 200 });
  }) as Fetch & { calls: string[] };
  fetch.calls = calls;
  return fetch;
}

const FAST: CdxOptions = { paceMs: 0, backoffMs: [0, 0], crawls: 3, maxPages: 5 };

const COLLECTIONS = JSON.stringify(
  ['CC-MAIN-2026-30', 'CC-MAIN-2026-39', 'CC-MAIN-2026-26', 'CC-MAIN-2026-35'].map((id) => ({
    id,
    name: id,
    'cdx-api': API(id),
  })),
);

describe('discovery', () => {
  it("a crawled URL's board: the ATS's own pages and files aren't companies", () => {
    expect(
      crawledBoard('https://job-boards.greenhouse.io/acme/jobs/123?gh_src=x', 'greenhouse'),
    ).toEqual({
      ats: 'greenhouse',
      token: 'acme',
    });
    expect(
      crawledBoard('https://boards.greenhouse.io/embed/job_board?for=Beta&b=1', 'greenhouse'),
    ).toEqual({ ats: 'greenhouse', token: 'Beta' });
    for (const [url, ats] of [
      ['https://jobs.smartrecruiters.com/sr-jobs/search?keyword=x', 'smartrecruiters'],
      ['https://apply.workable.com/j/996BE00528', 'workable'],
      ['https://jobs.lever.co/robots.txt', 'lever'],
      ['https://jobs.ashbyhq.com/sitemap.xml', 'ashby'],
      ['https://job-boards.greenhouse.io/12345', 'greenhouse'],
      ['https://jobs.lever.co/login', 'lever'],
      // Another ATS than the pattern's.
      ['https://jobs.ashbyhq.com/acme', 'lever'],
    ] as const) {
      expect(crawledBoard(url, ats)).toBeNull();
    }
  });

  it('reads the latest three crawls, page by page, retrying the flaky requests and noting what still fails', async () => {
    const gh = 'job-boards.greenhouse.io/*';
    const ashby = 'jobs.ashbyhq.com/*';
    const fetch = cdxFetch({
      [CDX_COLLECTIONS]: { body: COLLECTIONS },
      [cdx('CC-MAIN-2026-39', gh)]: { body: JSON.stringify({ pages: 2, pageSize: 5, blocks: 9 }) },
      [cdx('CC-MAIN-2026-39', gh, 0)]: {
        body: lines(
          'https://job-boards.greenhouse.io/acme/jobs/1',
          'https://job-boards.greenhouse.io/acme/jobs/2',
          'https://job-boards.greenhouse.io/Beta',
          'not json at all',
        ),
      },
      // 502 then 504, then the page: retried.
      [cdx('CC-MAIN-2026-39', gh, 1)]: {
        body: lines('https://job-boards.greenhouse.io/gamma/jobs/3'),
        fail: [502, 504],
      },
      // Down for good: noted, the rest goes on.
      [cdx('CC-MAIN-2026-39', ashby)]: { body: '{"pages":1}', fail: [502, 502, 502] },
      [cdx('CC-MAIN-2026-35', gh)]: { body: '{"pages":1}' },
      [cdx('CC-MAIN-2026-35', gh, 0)]: {
        body: lines(
          'https://job-boards.greenhouse.io/beta/jobs/9',
          'https://job-boards.greenhouse.io/delta/jobs/4',
        ),
      },
      [cdx('CC-MAIN-2026-35', ashby)]: { body: '{"pages":1}' },
      [cdx('CC-MAIN-2026-35', ashby, 0)]: { body: lines('https://jobs.ashbyhq.com/epsilon/x') },
    });
    const res = await commonCrawlBoards(fetch, new AbortController().signal, FAST);
    expect(res.crawls).toEqual(['CC-MAIN-2026-39', 'CC-MAIN-2026-35', 'CC-MAIN-2026-30']);
    expect(res.boards.map((b) => `${b.ats}:${b.token}`)).toEqual([
      'greenhouse:acme',
      'greenhouse:Beta',
      'greenhouse:gamma',
      'greenhouse:delta',
      'ashby:epsilon',
    ]);
    expect(res.failed).toEqual(['CC-MAIN-2026-39 jobs.ashbyhq.com/*: HTTP 502 (3 tries)']);
    expect(fetch.calls.some((u) => u.includes('CC-MAIN-2026-26'))).toBe(false);
  });

  it('the list of crawls failing leaves an empty result that says why', async () => {
    const fetch = cdxFetch({ [CDX_COLLECTIONS]: { body: '[]', fail: [503, 503, 503] } });
    const res = await commonCrawlBoards(fetch, new AbortController().signal, FAST);
    expect(res).toMatchObject({ boards: [], crawls: [] });
    expect(res.failed).toEqual(['the list of crawls: HTTP 503 (3 tries)']);
  });

  describe('runs', () => {
    let t: TempDb;
    let h: SearchHarness;
    let clock: Date;
    beforeEach(() => {
      t = tempDb();
      clock = new Date('2026-10-18T10:00:00Z');
    });
    afterEach(async () => {
      await h.stop();
      t.cleanup();
    });

    it("adds the boards of Applyant's own data and Common Crawl's, each once, with how it was found", async () => {
      const fetch = recordedFetch();
      const gh = 'job-boards.greenhouse.io/*';
      fetch.replies.set(CDX_COLLECTIONS, { body: COLLECTIONS });
      fetch.replies.set(cdx('CC-MAIN-2026-39', gh), { body: '{"pages":1}' });
      fetch.replies.set(cdx('CC-MAIN-2026-39', gh, 0), {
        body: lines(
          'https://job-boards.greenhouse.io/acme/jobs/1',
          'https://job-boards.greenhouse.io/fresh/jobs/2',
        ),
        contentType: 'text/plain',
      });
      h = searchHarness(t, {
        fetch,
        now: () => clock,
        handlers: { index_crawl: indexCrawl, index_discover: indexDiscover },
      });
      addSource(t.db, { kind: 'lever', locator: 'mine' }, clock);
      t.db
        .insert(postings)
        .values({
          stage: 'found',
          canonicalUrl: 'https://job-boards.greenhouse.io/acme/jobs/7',
          company: 'Acme',
        })
        .run();
      const id = runInTx(t.db, h.bus, { now: clock }, (tx) => startDiscovery(tx, 'manual'));
      expect(runInTx(t.db, h.bus, { now: clock }, (tx) => startDiscovery(tx, 'manual'))).toBeNull();
      await h.worker.idle();
      const row = t.db
        .select()
        .from(atsDiscoveries)
        .where(eq(atsDiscoveries.id, id ?? 0))
        .get();
      expect(row).toMatchObject({ status: 'done', found: 3, added: 3, finishedAt: clock });
      expect(row?.note).toMatch(
        /^3 new boards of 3 boards found · Applyant's own data: 2 boards · /,
      );
      expect(
        t.db
          .select()
          .from(atsCompanies)
          .orderBy(atsCompanies.id)
          .all()
          .map((c) => [c.ats, c.token, c.foundVia, c.name, c.status]),
      ).toEqual([
        ['lever', 'mine', 'candidate', 'mine', 'new'],
        ['greenhouse', 'acme', 'posting', 'Acme', 'new'],
        ['greenhouse', 'fresh', 'common-crawl', null, 'new'],
      ]);
      // Again: nothing new.
      const second = runInTx(t.db, h.bus, { now: clock }, (tx) => startDiscovery(tx, 'manual'));
      await h.worker.idle();
      expect(
        t.db
          .select()
          .from(atsDiscoveries)
          .where(eq(atsDiscoveries.id, second ?? 0))
          .get(),
      ).toMatchObject({ status: 'done', found: 3, added: 0 });
    });

    it('runs once by itself when the index is in use, then weekly', async () => {
      // Its task finishes without looking anywhere: the run stays waiting.
      h = searchHarness(t, {
        fetch: recordedFetch(),
        now: () => clock,
        handlers: { index_discover: async () => ({ kind: 'done', commit: () => {} }) },
      });
      const tick = () => runInTx(t.db, h.bus, { now: clock }, (tx) => scheduleDiscovery(tx));
      expect(tick()).toBeNull();
      await h.run({ name: 'AI', queries: ['ai engineer'], sources: ['board:ats-index'] });
      const first = tick();
      expect(first).not.toBeNull();
      expect(t.db.select().from(atsDiscoveries).get()?.trigger).toBe('setup');
      await h.worker.idle();
      // Still waiting: no second one.
      expect(tick()).toBeNull();
      t.db
        .update(atsDiscoveries)
        .set({ status: 'done' })
        .where(eq(atsDiscoveries.id, first ?? 0))
        .run();
      clock = new Date(clock.getTime() + DISCOVER_EVERY_MS - 1);
      expect(tick()).toBeNull();
      clock = new Date(clock.getTime() + 2);
      expect(tick()).not.toBeNull();
      expect(
        t.db
          .select()
          .from(atsDiscoveries)
          .where(and(eq(atsDiscoveries.trigger, 'schedule')))
          .all(),
      ).toHaveLength(1);
    });
  });
});

// ---- RPCs ------------------------------------------------------------------------------------

describe('the ATS index RPCs', () => {
  let t: TempDb;
  let h: SearchHarness;
  const now = new Date('2026-10-18T10:00:00Z');
  beforeEach(() => {
    t = tempDb();
    h = searchHarness(t, { fetch: recordedFetch(), now: () => now });
  });
  afterEach(async () => {
    await h.stop();
    t.cleanup();
  });

  it('the index per ATS, its companies paged (matching first, then hiring, then by name), a switch per company, discovery on demand', async () => {
    const rpc = searchRpcs({ db: t.db, bus: h.bus, now: () => now });
    const [zeta, alpha, mid, gone] = runInTx(t.db, h.bus, { now }, (tx) =>
      knowBoards(tx, [
        { board: { ats: 'greenhouse', token: 'zeta' }, via: 'common-crawl', name: 'Zeta' },
        { board: { ats: 'greenhouse', token: 'alpha' }, via: 'posting', name: 'Alpha' },
        { board: { ats: 'ashby', token: 'mid' }, via: 'planner' },
        { board: { ats: 'lever', token: 'gone' }, via: 'common-crawl' },
      ]),
    );
    const set = (id: number | undefined, v: Partial<typeof atsCompanies.$inferInsert>) =>
      t.db
        .update(atsCompanies)
        .set(v)
        .where(eq(atsCompanies.id, id ?? 0))
        .run();
    set(zeta?.id, {
      status: 'hiring',
      jobs: 5,
      matching: 2,
      lastReadAt: now,
      nextReadAt: new Date(now.getTime() + HOUR),
    });
    set(mid?.id, { status: 'hiring', jobs: 3, nextReadAt: new Date(now.getTime() + HOUR) });
    set(gone?.id, { status: 'gone', nextReadAt: new Date(now.getTime() + 30 * DAY) });

    const index = (await rpc.getAtsIndex(
      create(GetAtsIndexRequestSchema, {}),
      {} as never,
    )) as GetAtsIndexResponse;
    expect(index).toMatchObject({
      enabled: true,
      companies: 3,
      jobs: 8,
      matching: 2,
      discoveries: [],
    });
    expect(index.ats.map((a) => a.ats)).toEqual([
      'greenhouse',
      'ashby',
      'lever',
      'workable',
      'smartrecruiters',
    ]);
    expect(index.ats[0]).toMatchObject({
      label: 'Greenhouse',
      enabled: true,
      companies: 2,
      hiring: 1,
      jobs: 5,
      matching: 2,
      due: 1,
      failing: 0,
    });
    expect(index.ats[0]?.lastReadAt).toBeDefined();
    expect(index.ats[2]).toMatchObject({ companies: 0, due: 0 });

    const list = async (req: MessageInitShape<typeof ListIndexCompaniesRequestSchema>) =>
      (await rpc.listIndexCompanies(
        create(ListIndexCompaniesRequestSchema, req),
        {} as never,
      )) as ListIndexCompaniesResponse;
    const all = await list({});
    expect(all.total).toBe(4);
    expect(all.companies.map((c) => c.token)).toEqual(['zeta', 'mid', 'alpha', 'gone']);
    expect(all.companies[0]).toMatchObject({
      ats: 'greenhouse',
      name: 'Zeta',
      enabled: true,
      status: 'hiring',
      jobs: 5,
      matching: 2,
      foundVia: 'common-crawl',
      boardUrl: 'https://job-boards.greenhouse.io/zeta',
    });
    expect((await list({ matchingOnly: true })).companies.map((c) => c.token)).toEqual(['zeta']);
    expect((await list({ ats: 'greenhouse', query: 'AL' })).companies.map((c) => c.token)).toEqual([
      'alpha',
    ]);
    const page = await list({ limit: 2, offset: 2 });
    expect([page.total, page.companies.map((c) => c.token)]).toEqual([4, ['alpha', 'gone']]);
    await expect(list({ ats: 'bamboo' })).rejects.toMatchObject({ code: Code.InvalidArgument });

    const setEnabled = async (id: bigint, enabled: boolean) =>
      (await rpc.setIndexCompanyEnabled(
        create(SetIndexCompanyEnabledRequestSchema, { id, enabled }),
        {} as never,
      )) as SetIndexCompanyEnabledResponse;
    const off = await setEnabled(BigInt(alpha?.id ?? 0), false);
    expect(off.company).toMatchObject({ token: 'alpha', enabled: false });
    await expect(setEnabled(999n, true)).rejects.toSatisfy(
      (e) => e instanceof ConnectError && e.code === Code.NotFound,
    );

    const discover = async () =>
      (await rpc.discoverIndexCompanies(
        create(DiscoverIndexCompaniesRequestSchema, {}),
        {} as never,
      )) as DiscoverIndexCompaniesResponse;
    expect((await discover()).discoveryId).toBeDefined();
    expect((await discover()).discoveryId).toBeUndefined();
    const again = (await rpc.getAtsIndex(
      create(GetAtsIndexRequestSchema, {}),
      {} as never,
    )) as GetAtsIndexResponse;
    expect(again.discoveries.map((d) => [d.trigger, d.status])).toEqual([['manual', 'queued']]);
  });
});
