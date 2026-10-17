// Role-first search over recorded responses (test/fixtures/search/role): Workable's and
// SmartRecruiters' job searches across every company, web search for Greenhouse, Ashby and
// Lever job pages, and the pace and budget that web search keeps. Nothing touches the network.
import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  accountGuesses,
  hitCompany,
  readAtsWebSearch,
  readSmartRecruitersSearch,
  readWorkableSearch,
  searchPhrases,
  sliceFor,
  workableWhere,
} from '../src/domain/search/readers/ats-search.ts';
import { SharedReads, sleep } from '../src/domain/search/readers/shared.ts';
import type { ReaderContext } from '../src/domain/search/readers/types.ts';
import {
  braveHits,
  challenge,
  duckduckgoHits,
  NoSearchNow,
  WebSearchGate,
} from '../src/domain/search/readers/web-search.ts';
import { matchesStrategy } from '../src/domain/search/strategies.ts';
import { type RecordedFetch, recordedFetch, roleFixture, roleReplies } from './helpers/search.ts';

const now = new Date('2026-10-17T12:00:00Z');

function ctx(
  fetch: RecordedFetch,
  queries: string[],
  locations: string[] = [],
  o: Partial<ReaderContext> = {},
): ReaderContext {
  return {
    fetch,
    signal: new AbortController().signal,
    queries,
    locations,
    reader: null,
    now,
    wants: (l) => matchesStrategy(l, { queries, locations }),
    shared: new SharedReads(),
    web: new WebSearchGate({ paceMs: 0 }),
    turn: 0,
    ...o,
  };
}

const brave = (q: string) =>
  `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web`;
const duck = (q: string) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`;
const html = (file: string) => ({ body: roleFixture(file), contentType: 'text/html' });

describe('search terms', () => {
  it('the words of each query, without the exclusions; each run takes the next slice', () => {
    expect(
      searchPhrases(['AI engineer -intern -junior', 'ai  engineer', 'laravel', '-only']),
    ).toEqual(['ai engineer', 'laravel']);
    const items = ['a', 'b', 'c', 'd', 'e'];
    expect(sliceFor(items, 0, 2)).toEqual(['a', 'b']);
    expect(sliceFor(items, 1, 2)).toEqual(['c', 'd']);
    expect(sliceFor(items, 2, 2)).toEqual(['e', 'a']);
    expect(sliceFor(items, 7, 9)).toEqual(items);
  });

  it("Workable is asked for remote jobs and each named place; regions aren't places to it", () => {
    expect(workableWhere(['remote', 'greece', 'europe', 'EMEA'])).toEqual([
      { workplace: 'remote' },
      { location: 'greece' },
    ]);
    expect(workableWhere(['europe'])).toEqual([{}]);
    expect(workableWhere([])).toEqual([{}]);
  });

  it("a company's likely Workable account names", () => {
    expect(accountGuesses('Tiger Analytics Inc.', null)).toEqual([
      'tiger-analytics',
      'tigeranalytics',
      'tiger-analytics-1',
    ]);
    expect(accountGuesses('Arabic.AI', 'https://arabic.ai/')).toContain('arabicai');
    expect(accountGuesses('webook.com', 'https://webook.com')).toContain('webook');
    expect(accountGuesses('Coursedog', null)).toEqual(['coursedog', 'coursedog-1']);
    // No latin letters to guess from: only the job form's GDPR link can tell.
    expect(accountGuesses('Ελληνική Εταιρεία', null)).toEqual([]);
  });

  it("the company a search result's title names", () => {
    expect(hitCompany('ashby', 'AI Engineer @ Farsight AI - jobs.ashbyhq.com')).toBe('Farsight AI');
    expect(hitCompany('lever', 'Crypto.com - Backend Engineer (Python/Node.js)')).toBe(
      'Crypto.com',
    );
    expect(hitCompany('greenhouse', 'Job Application for Tech Lead at Userflow')).toBe('Userflow');
    expect(hitCompany('lever', null)).toBeNull();
  });
});

describe('Workable job search (recorded)', () => {
  it("reads the boards of the companies with jobs that fit; a job whose account isn't found stays its jobs.workable.com page", async () => {
    const fetch = recordedFetch(roleReplies());
    const run = await readWorkableSearch(
      ctx(fetch, ['laravel'], ['remote', 'greece'], {
        // The fixtures' search was for "laravel"; this strategy wants PHP and software engineers.
        wants: (l) => /php|laravel|software engineer/i.test(l.title),
      }),
    );
    expect(fetch.calls.slice(0, 2)).toEqual([
      'https://jobs.workable.com/api/v1/jobs?query=laravel&workplace=remote',
      'https://jobs.workable.com/api/v1/jobs?query=laravel&location=greece',
    ]);
    expect(run.complete).toBe(false);
    expect(run.note).toBe(
      'Workable job search: 8 of 9 jobs fit, at 3 companies · 2 of their boards read (12 jobs)',
    );
    // Intetics's job form names its account in its GDPR link: intetics-2, not its name.
    expect(fetch.calls).toContain(
      'https://jobs.workable.com/api/v1/jobs/fc81b9b1-52ae-460e-8b4c-30d8a596345b/form?includeAccountMetadata=true',
    );
    expect(fetch.calls).not.toContain(
      'https://apply.workable.com/api/v1/widget/accounts/intetics?details=true',
    );
    const intetics = run.listings.filter((l) => l.board?.token === 'intetics-2');
    expect(intetics).toHaveLength(8);
    expect(intetics[0]).toMatchObject({
      url: 'https://apply.workable.com/j/996BE00528',
      title: 'Senior PHP Fullstack Engineer',
      company: 'Intetics',
      remote: true,
      board: { ats: 'workable', token: 'intetics-2' },
    });
    // VICTUS NETWORKS is victus-networks: its own board, every job on it.
    expect(
      run.listings.filter((l) => l.board?.token === 'victus-networks').map((l) => l.title),
    ).toEqual([
      'Software Engineer - MIS & Tools',
      'GIS Engineer - Network Systems & Automation',
      'Network Engineer',
    ]);
    // Dotsoft's job came from a partner board: no Workable account to read.
    const dotsoft = run.listings.find((l) => l.company === 'Dotsoft');
    expect(dotsoft).toMatchObject({
      url: 'https://jobs.workable.com/view/wqgRfqgECwdfAbsan5daMx/laravel-developer-in-thessaloniki-at-dotsoft',
      title: 'Laravel Developer',
      location: 'Thessaloniki, Greece',
      remote: false,
    });
    expect(dotsoft?.board).toBeUndefined();
    // Sabo's job doesn't fit: its company isn't looked up.
    expect(fetch.calls.some((u) => /sabo/i.test(u))).toBe(false);
  });

  it('a company looked up once is known to the next run (shared reads)', async () => {
    const fetch = recordedFetch(roleReplies());
    const shared = new SharedReads();
    const c = ctx(fetch, ['laravel'], ['remote', 'greece'], {
      shared,
      wants: (l) => /php|laravel|software engineer/i.test(l.title),
    });
    await readWorkableSearch(c);
    fetch.calls.length = 0;
    await readWorkableSearch(c);
    // Only the searches again: the accounts and their boards are kept.
    expect(fetch.calls.filter((u) => !u.includes('/api/v1/jobs?'))).toEqual(
      // Dotsoft wasn't found; it's kept as "no account" too.
      [],
    );
  });

  it("when Workable asks to slow down, the rest wait for a later run (and aren't remembered as having no account)", async () => {
    const victus = 'https://apply.workable.com/api/v1/widget/accounts/victus-networks?details=true';
    const replies = roleReplies();
    const fetch = recordedFetch({
      ...replies,
      [victus]: { status: 429, body: 'slow down', contentType: 'text/plain' },
    });
    const shared = new SharedReads();
    const c = ctx(fetch, ['laravel'], ['greece'], {
      shared,
      wants: (l) => /software engineer/i.test(l.title),
    });
    const first = await readWorkableSearch(c);
    expect(first.listings).toEqual([]);
    expect(first.note).toContain('1 company left for a later run (Workable asked to slow down)');
    fetch.replies.set(victus, replies[victus] as NonNullable<(typeof replies)[string]>);
    const second = await readWorkableSearch(c);
    expect(second.listings.map((l) => l.board?.token)).toEqual([
      'victus-networks',
      'victus-networks',
      'victus-networks',
    ]);
  });

  it('a search that fails entirely fails the read; one of several failing is a note', async () => {
    await expect(readWorkableSearch(ctx(recordedFetch(), ['laravel'], ['greece']))).rejects.toThrow(
      /HTTP 404/,
    );
    const fetch = recordedFetch(roleReplies());
    const run = await readWorkableSearch(ctx(fetch, ['laravel', 'symfony'], ['greece']));
    expect(run.note).toMatch(/1 of 2 searches failed: HTTP 404/);
  });
});

describe('SmartRecruiters job search (recorded)', () => {
  it("lists each query's postings at every company, each with its company's board", async () => {
    const fetch = recordedFetch(roleReplies());
    const run = await readSmartRecruitersSearch(
      ctx(fetch, ['laravel -junior', 'senior php -intern'], ['remote', 'greece']),
    );
    expect(fetch.calls).toEqual([
      'https://jobs.smartrecruiters.com/sr-jobs/search?keyword=laravel&limit=100&offset=0',
      // Several words are searched as a phrase (unquoted, any of them matches).
      'https://jobs.smartrecruiters.com/sr-jobs/search?keyword=%22senior+php%22&limit=100&offset=0',
    ]);
    expect(run.complete).toBe(false);
    expect(run.listings).toHaveLength(5);
    expect(run.listings[2]).toMatchObject({
      url: 'https://jobs.smartrecruiters.com/JobsForHumanity/744000074527197',
      externalId: '744000074527197',
      title: 'Senior Backend Developer (PHP/Laravel)',
      company: 'Jobs for Humanity',
      location: 'Remote (Beirut, lb)',
      remote: true,
      board: { ats: 'smartrecruiters', token: 'JobsForHumanity' },
    });
    expect(run.note).toBe(
      'SmartRecruiters job search: 5 jobs at 4 companies for 2 queries · 1 of 2 searches failed: HTTP 404 from https://jobs.smartrecruiters.com/sr-jobs/search?keyword=%22senior+php%22&limit=100&offset=0',
    );
  });

  it('a strategy that wants only remote jobs asks for remote ones', async () => {
    const url =
      'https://jobs.smartrecruiters.com/sr-jobs/search?keyword=laravel&limit=100&offset=0&locationType=REMOTE';
    const fetch = recordedFetch({ [url]: { totalFound: 0, content: [] } });
    const run = await readSmartRecruitersSearch(ctx(fetch, ['laravel'], ['remote']));
    expect(fetch.calls).toEqual([url]);
    expect(run.listings).toEqual([]);
  });
});

describe('web search for Greenhouse, Ashby and Lever job pages (recorded)', () => {
  it('reads the results pages', () => {
    const hits = braveHits(roleFixture('brave-greenhouse-tech-lead.html'));
    expect(hits).toHaveLength(5);
    expect(hits[2]).toEqual({
      url: 'https://job-boards.greenhouse.io/yipitdata/jobs/7737220',
      title: 'Job Application for Tech Lead - Senior Software Engineer at YipitData',
    });
    const ddg = duckduckgoHits(roleFixture('duckduckgo-ashby-ai-engineer.html'));
    expect(ddg).toHaveLength(8);
    expect(ddg[0]).toEqual({
      url: 'https://jobs.ashbyhq.com/NormalComputing/e81b27d7-9505-40fb-859c-0dcc2f404a3f',
      title: 'AI Engineer @ Normal Computing Corporation',
    });
    // A block asks for a captcha; an ordinary page (even one without results) doesn't.
    expect(challenge('brave', roleFixture('brave-captcha.html'))).toBe(true);
    expect(challenge('brave', roleFixture('brave-greenhouse-tech-lead.html'))).toBe(false);
    expect(challenge('duckduckgo', roleFixture('duckduckgo-anomaly.html'))).toBe(true);
    expect(challenge('duckduckgo', roleFixture('duckduckgo-ashby-ai-engineer.html'))).toBe(false);
  });

  it('reads the boards behind the hits that fit; an engine that turns a query away rests and the other one is asked', async () => {
    const gh = 'site:greenhouse.io "tech lead"';
    const ashby = 'site:jobs.ashbyhq.com "tech lead"';
    const lever = 'site:jobs.lever.co "tech lead"';
    const fetch = recordedFetch({
      ...roleReplies(),
      [brave(ashby)]: html('brave-captcha.html'),
      [duck(ashby)]: html('duckduckgo-ashby-ai-engineer.html'),
      [duck(lever)]: { ...html('duckduckgo-anomaly.html'), status: 202 },
    });
    const web = new WebSearchGate({ paceMs: 0, clock: () => now.getTime() });
    const run = await readAtsWebSearch(ctx(fetch, ['tech lead -intern'], [], { web }));
    expect(fetch.calls.filter((u) => /brave|duckduckgo/.test(u))).toEqual([
      brave(gh),
      brave(ashby),
      duck(ashby),
      // Brave rests after its captcha: the Lever query goes to DuckDuckGo, which blocks too.
      duck(lever),
    ]);
    expect(web.resting('brave')).toEqual(new Date(now.getTime() + 2 * 3_600_000));
    expect(web.resting('duckduckgo')).not.toBeNull();
    // Five Greenhouse job pages, each a board that fits; only YipitData's board is still up.
    expect(run.listings).toHaveLength(4);
    expect(run.listings[0]).toMatchObject({
      url: 'https://job-boards.greenhouse.io/yipitdata/jobs/7737220',
      title: 'Tech Lead - Senior Software Engineer',
      company: 'YipitData',
      board: { ats: 'greenhouse', token: 'yipitdata' },
    });
    // The Ashby AI engineers DuckDuckGo found aren't tech leads: none of their boards is read.
    expect(fetch.calls.some((u) => u.includes('api.ashbyhq.com'))).toBe(false);
    expect(run.note).toMatch(
      /^Web search: 2 of 3 queries, 13 job pages, 5 boards that fit · 1 read \(4 jobs\) · /,
    );
  });

  it('with every engine resting, a read is empty, not failed; a network error fails it', async () => {
    const web = new WebSearchGate({ paceMs: 0, perDay: 0 });
    const run = await readAtsWebSearch(ctx(recordedFetch(), ['tech lead'], [], { web }));
    expect(run).toMatchObject({ listings: [], complete: false });
    expect(run.note).toContain("today's 0 web searches are used");
    await expect(readAtsWebSearch(ctx(recordedFetch(), ['tech lead']))).rejects.toThrow(/HTTP 404/);
  });
});

describe('the web search gate', () => {
  const page = html('brave-greenhouse-tech-lead.html');

  it('queries one engine at a time, PACE_MS apart, and at most perDay a day', async () => {
    let clock = now.getTime();
    const waits: number[] = [];
    const web = new WebSearchGate({
      paceMs: 30_000,
      perDay: 2,
      clock: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    const fetch = recordedFetch({ [brave('a')]: page, [brave('b')]: page, [brave('c')]: page });
    const c = { fetch, signal: new AbortController().signal };
    // Two at once: the second waits its turn behind the first.
    const [a, b] = await Promise.all([web.search('a', c), web.search('b', c)]);
    expect([a.engine, b.engine]).toEqual(['brave', 'brave']);
    expect(a.hits).toHaveLength(5);
    expect(waits).toEqual([30_000]);
    expect(web.left()).toBe(0);
    await expect(web.search('c', c)).rejects.toThrow(NoSearchNow);
    // The next day has its own budget.
    clock += 24 * 3_600_000;
    expect(web.left()).toBe(2);
    expect((await web.search('c', c)).hits).toHaveLength(5);
  });

  it('an engine that answers 429 rests, then is asked again', async () => {
    let clock = now.getTime();
    const web = new WebSearchGate({ paceMs: 0, restMs: 3_600_000, clock: () => clock });
    const fetch = recordedFetch({
      [brave('a')]: { body: 'slow down', status: 429, contentType: 'text/html' },
      [duck('a')]: html('duckduckgo-ashby-ai-engineer.html'),
      [duck('b')]: html('duckduckgo-ashby-ai-engineer.html'),
      [brave('c')]: page,
    });
    const c = { fetch, signal: new AbortController().signal };
    expect((await web.search('a', c)).engine).toBe('duckduckgo');
    expect((await web.search('b', c)).engine).toBe('duckduckgo');
    expect(fetch.calls).toEqual([brave('a'), duck('a'), duck('b')]);
    clock += 3_600_000;
    expect((await web.search('c', c)).engine).toBe('brave');
  });

  it("a run cancelled while its query waits in line spends none of the day's budget", async () => {
    const web = new WebSearchGate({ paceMs: 0, perDay: 2 });
    const ac = new AbortController();
    ac.abort(new Error('cancelled'));
    const fetch = recordedFetch({ [brave('a')]: page });
    await expect(web.search('a', { fetch, signal: ac.signal })).rejects.toThrow('cancelled');
    expect(fetch.calls).toEqual([]);
    expect(web.left()).toBe(2);
  });
});

describe('shared reads', () => {
  it('are kept for their time, shared while running, and not kept when they fail', async () => {
    const shared = new SharedReads({ max: 2 });
    let reads = 0;
    const read = async () => ++reads;
    const at = (min: number) => new Date(now.getTime() + min * 60_000);
    const [x, y] = await Promise.all([
      shared.memo('k', 30 * 60_000, at(0), read),
      shared.memo('k', 30 * 60_000, at(0), read),
    ]);
    expect([x, y, reads]).toEqual([1, 1, 1]);
    expect(await shared.memo('k', 30 * 60_000, at(29), read)).toBe(1);
    expect(await shared.memo('k', 30 * 60_000, at(30), read)).toBe(2);
    await expect(
      shared.memo('bad', 60_000, at(0), async () => {
        throw new Error('down');
      }),
    ).rejects.toThrow('down');
    expect(await shared.memo('bad', 60_000, at(0), async () => 'up')).toBe('up');
    // Past its size, the oldest go.
    await shared.memo('third', 60_000, at(0), read);
    expect(await shared.memo('k', 30 * 60_000, at(31), read)).toBe(4);
  });

  it("reads past their time aren't held on to", async () => {
    const shared = new SharedReads();
    const at = (min: number) => new Date(now.getTime() + min * 60_000);
    await shared.memo('board-a', 30 * 60_000, at(0), async () => 'a');
    await shared.memo('account', 7 * 24 * 60 * 60_000, at(0), async () => 'acme');
    await shared.memo('board-b', 30 * 60_000, at(10), async () => 'b');
    expect(shared.size).toBe(3);
    await shared.memo('board-c', 30 * 60_000, at(35), async () => 'c');
    // board-a is gone; board-b (25 minutes old) and the account stay.
    expect(shared.size).toBe(3);
    expect(await shared.memo('board-b', 30 * 60_000, at(35), async () => 'b2')).toBe('b');
    expect(await shared.memo('board-a', 30 * 60_000, at(35), async () => 'a2')).toBe('a2');
  });

  it("a lane's reads start its gap apart", async () => {
    const shared = new SharedReads({ gapMs: { workable: 40 } });
    const signal = new AbortController().signal;
    const started: number[] = [];
    const t0 = Date.now();
    await Promise.all(
      [1, 2, 3].map(async () => {
        await shared.turn('workable', signal);
        started.push(Date.now() - t0);
      }),
    );
    expect(started[0]).toBeLessThan(30);
    expect(started[2]).toBeGreaterThanOrEqual(75);
    // A lane without a gap doesn't wait.
    await shared.turn('greenhouse', signal);
  });

  it("a lane's waits leave nothing on the run's signal, and a cancelled run doesn't wait", async () => {
    const shared = new SharedReads({ gapMs: { workable: 5 } });
    const ac = new AbortController();
    for (let i = 0; i < 15; i++) await shared.turn('workable', ac.signal);
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
    ac.abort(new Error('cancelled'));
    await expect(sleep(60_000, ac.signal)).rejects.toThrow('cancelled');
  });
});
