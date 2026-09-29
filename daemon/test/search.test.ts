// Strategies and their schedule: runs start when due (a missed schedule runs once after the Mac
// wakes), a source or kind that's off is never queried, queries and locations pick listings,
// and each strategy and source counts what it found.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { postings, searchRuns, searchStrategies, tasks } from '../src/db/schema.ts';
import type { Listing } from '../src/domain/search/readers/types.ts';
import {
  addSource,
  listSources,
  parseSourceInput,
  SearchError,
  setSourceEnabled,
  sourcesFor,
} from '../src/domain/search/sources.ts';
import {
  listRuns,
  listStrategies,
  matchesStrategy,
  parseEvery,
  requireStrategy,
  scheduleDue,
  updateStrategy,
} from '../src/domain/search/strategies.ts';
import { EventBus } from '../src/queue/events.ts';
import { Scheduler } from '../src/queue/scheduler.ts';
import { runInTx } from '../src/queue/tx.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { quietLog } from './helpers/deps.ts';
import { recordedFetch, type SearchHarness, searchHarness } from './helpers/search.ts';

const at = (iso: string) => new Date(iso);

function listing(title: string, p: Partial<Listing> = {}): Listing {
  return {
    url: 'https://x.example/1',
    sourceUrl: 'https://x.example/1',
    externalId: null,
    title,
    company: null,
    location: null,
    remote: null,
    team: null,
    description: null,
    applyUrl: null,
    postedAt: null,
    ...p,
  };
}

describe('what a strategy matches', () => {
  const s = (queries: string[], locations: string[] = []) => ({ queries, locations });

  it('every word of one query in the title; "-word" excludes', () => {
    expect(matchesStrategy(listing('Senior AI Engineer'), s(['ai engineer']))).toBe(true);
    expect(matchesStrategy(listing('AI/ML Engineering Lead'), s(['ai engineer']))).toBe(true);
    expect(
      matchesStrategy(listing('Backend Developer (Go)'), s(['ai engineer', 'backend dev'])),
    ).toBe(true);
    expect(matchesStrategy(listing('Senior AI Engineer'), s(['llm engineer']))).toBe(false);
    expect(matchesStrategy(listing('AI Engineer Intern'), s(['ai engineer -intern']))).toBe(false);
    expect(matchesStrategy(listing('Anything'), s([]))).toBe(true);
    // HN comments match on their first line.
    expect(
      matchesStrategy(
        listing('Multiple roles', { matchText: 'Acme | Staff Backend Engineer, ML | Remote' }),
        s(['backend']),
      ),
    ).toBe(true);
  });

  it('a location word, or remote; a listing that says nothing passes', () => {
    const where = s([], ['remote', 'greece']);
    expect(matchesStrategy(listing('x', { location: 'Athens, Greece' }), where)).toBe(true);
    expect(matchesStrategy(listing('x', { location: 'Anywhere in the World' }), where)).toBe(true);
    expect(matchesStrategy(listing('x', { remote: true, location: 'EU' }), where)).toBe(true);
    expect(matchesStrategy(listing('x', { location: 'Berlin', remote: false }), where)).toBe(false);
    expect(matchesStrategy(listing('x'), where)).toBe(true);
  });

  it('schedules and sources are checked', () => {
    expect(parseEvery('6h')).toBe(360);
    expect(parseEvery('1d')).toBe(1440);
    expect(parseEvery('90m')).toBe(90);
    expect(() => parseEvery('10m')).toThrow(/at most every 60 minutes/);
    expect(() => parseEvery('soon')).toThrow(SearchError);
    expect(parseSourceInput(['https://jobs.lever.co/acme'])).toMatchObject({
      kind: 'lever',
      locator: 'acme',
    });
    expect(parseSourceInput(['https://job-boards.greenhouse.io/gitlab'])).toMatchObject({
      kind: 'greenhouse',
      locator: 'gitlab',
    });
    expect(parseSourceInput(['https://acme.example/careers#open'])).toMatchObject({
      kind: 'page',
      locator: 'https://acme.example/careers',
    });
    expect(parseSourceInput(['ashby', 'lumen'])).toMatchObject({ kind: 'ashby', locator: 'lumen' });
    expect(() => parseSourceInput(['board', 'indeed'])).toThrow(/unknown board/);
    expect(() => parseSourceInput(['monster', 'x'])).toThrow(/unknown source kind/);
  });
});

describe('the scheduler', () => {
  let t: TempDb;
  let bus: EventBus;
  beforeEach(() => {
    t = tempDb();
    bus = new EventBus();
  });
  afterEach(() => t.cleanup());

  // Inserted directly: addStrategy starts a run at once (the harness tests cover that).
  const add = (name: string, now: Date, o: { every?: number; paused?: boolean } = {}) =>
    t.db
      .insert(searchStrategies)
      .values({
        name,
        sources: ['board'],
        everyMinutes: o.every ?? 360,
        state: o.paused ? 'paused' : 'active',
        nextRunAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  const due = (now: Date, trigger: 'schedule' | 'wake' = 'schedule') =>
    runInTx(t.db, bus, { now }, (tx) => scheduleDue(tx, trigger));
  const searchTasks = () => t.db.select().from(tasks).where(eq(tasks.kind, 'search')).all();
  const finish = () =>
    t.db.update(tasks).set({ status: 'done' }).where(eq(tasks.kind, 'search')).run();

  it('starts due strategies once, skips paused ones, and never stacks runs', () => {
    const t0 = at('2026-09-28T08:00:00Z');
    const a = add('A', t0);
    add('Paused', t0, { paused: true });
    const runs = due(t0);
    expect(runs).toHaveLength(1);
    expect(searchTasks().map((x) => [x.entityId, x.runId])).toEqual([[a.id, runs[0]]]);
    expect(requireStrategy(t.db, a.id).nextRunAt).toEqual(at('2026-09-28T14:00:00Z'));
    // Not due again yet; and a still-running run blocks the next.
    expect(due(at('2026-09-28T13:59:00Z'))).toEqual([]);
    expect(due(at('2026-09-28T14:00:00Z'))).toEqual([]);
    finish();
    expect(due(at('2026-09-28T14:01:00Z'))).toHaveLength(1);
  });

  it('after the Mac slept through several slots, a strategy runs once, then counts from now', () => {
    const t0 = at('2026-09-28T08:00:00Z');
    const a = add('A', t0, { every: 60 });
    due(t0);
    finish();
    // Asleep from 08:30 to 15:10: seven hourly slots passed.
    const wake = at('2026-09-28T15:10:00Z');
    const runs = due(wake, 'wake');
    expect(runs).toHaveLength(1);
    expect(
      t.db
        .select()
        .from(searchRuns)
        .where(eq(searchRuns.id, runs[0] ?? 0))
        .get()?.trigger,
    ).toBe('wake');
    expect(requireStrategy(t.db, a.id).nextRunAt).toEqual(at('2026-09-28T16:10:00Z'));
    finish();
    expect(due(at('2026-09-28T15:11:00Z'))).toEqual([]);
  });

  it('the Scheduler ticks through the same rule (and on wake)', () => {
    let now = at('2026-09-28T08:00:00Z');
    add('A', now);
    const scheduler = new Scheduler({
      db: t.db,
      bus,
      log: quietLog,
      intervalMs: 60_000,
      now: () => now,
    });
    expect(scheduler.tick('schedule')).toHaveLength(1);
    finish();
    now = at('2026-09-29T09:00:00Z');
    expect(scheduler.tick('wake')).toHaveLength(1);
    expect(listRuns(t.db).map((r) => r.trigger)).toEqual(['wake', 'schedule']);
  });

  it('pausing and resuming; a resumed strategy whose slot passed is due now', () => {
    const t0 = at('2026-09-28T08:00:00Z');
    const a = add('A', t0);
    due(t0);
    finish();
    runInTx(t.db, bus, { now: t0 }, (tx) => updateStrategy(tx, a.id, { state: 'paused' }));
    expect(due(at('2026-09-29T08:00:00Z'))).toEqual([]);
    const later = at('2026-09-29T09:00:00Z');
    runInTx(t.db, bus, { now: later }, (tx) => updateStrategy(tx, a.id, { state: 'active' }));
    expect(requireStrategy(t.db, a.id).nextRunAt).toEqual(later);
    expect(due(later)).toHaveLength(1);
  });
});

describe('sources that are off', () => {
  let t: TempDb;
  let h: SearchHarness | null = null;
  const now = at('2026-09-28T10:00:00Z');
  beforeEach(() => {
    t = tempDb();
  });
  afterEach(async () => {
    await h?.stop();
    h = null;
    t.cleanup();
  });

  it('are never queried, one by one or by kind; counts come back per source and strategy', async () => {
    h = searchHarness(t, { fetch: recordedFetch(), now: () => now });
    addSource(t.db, { kind: 'workable', locator: 'huggingface' }, now);
    setSourceEnabled(t.db, 'board:hn', false);
    expect(sourcesFor(t.db, ['board']).map((s) => s.key)).not.toContain('board:hn');
    const run = await h.run({
      name: 'Engineers',
      queries: ['engineer'],
      sources: ['board:hn', 'board:remotive', 'workable'],
    });
    expect(h.fetch.calls.some((u) => u.includes('hn.algolia.com'))).toBe(false);
    expect(h.fetch.calls).toContain(
      'https://remotive.com/api/remote-jobs?limit=100&search=engineer',
    );
    const r = h.runRow(run);
    // Company boards are read before job boards.
    expect(r?.results.map((x) => x.sourceKey)).toEqual(['workable:huggingface', 'board:remotive']);
    // Remotive: "Frontend Web Application Developer" doesn't say engineer; Workable's four do.
    expect(r?.added).toBeGreaterThan(0);

    // The whole Workable kind off: its source isn't read either.
    setSourceEnabled(t.db, 'workable', false);
    h.fetch.calls.length = 0;
    const second = await h.again(1);
    expect(h.fetch.calls.some((u) => u.includes('workable.com'))).toBe(false);
    expect(h.runRow(second)?.results.map((x) => x.sourceKey)).toEqual(['board:remotive']);
    // Everything off: the run says so.
    setSourceEnabled(t.db, 'board:remotive', false);
    const third = await h.again(1);
    expect(h.runRow(third)?.note).toBe('no sources to read: every selected source is off');

    // Counts: found / verified / interested, per strategy and per source.
    const found = t.db.select().from(postings).all();
    const wk = found.filter((p) => p.canonicalUrl.includes('workable.com'));
    t.db.update(postings).set({ stage: 'scored', verifiedAt: now }).run();
    t.db
      .update(postings)
      .set({ decision: 'interested' })
      .where(eq(postings.id, wk[0]?.id ?? 0))
      .run();
    const [strategy] = listStrategies(t.db);
    expect(strategy?.stats).toEqual({
      found: found.length,
      verified: found.length,
      interested: 1,
      skipped: 0,
    });
    const { sources, kinds } = listSources(t.db);
    const workable = sources.find((s) => s.key === 'workable:huggingface');
    expect(workable).toMatchObject({
      enabled: true,
      kindEnabled: false,
      completeList: true,
      label: 'Hugging Face',
    });
    expect(workable?.stats).toMatchObject({ found: wk.length, interested: 1 });
    expect(sources.find((s) => s.key === 'board:hn')).toMatchObject({
      enabled: false,
      completeList: false,
    });
    // Himalayas starts off, and says why.
    expect(sources.find((s) => s.key === 'board:himalayas')).toMatchObject({
      enabled: false,
      lastNote: expect.stringContaining('HTTP 403'),
    });
    // So does Jobicy: its Apply is behind a sign-in.
    expect(sources.find((s) => s.key === 'board:jobicy')).toMatchObject({
      enabled: false,
      lastNote: expect.stringContaining('sign in'),
    });
    expect(kinds.find((k) => k.kind === 'workable')).toMatchObject({ enabled: false, sources: 1 });
  });

  it("a board the planner found that its ATS says doesn't exist is switched off; the candidate's own stays on", async () => {
    h = searchHarness(t, { fetch: recordedFetch(), now: () => now });
    addSource(t.db, { kind: 'ashby', locator: 'gone-by-agent', origin: 'agent' }, now);
    addSource(t.db, { kind: 'ashby', locator: 'gone-by-me' }, now);
    const run = await h.run({ name: 'Engineers', queries: ['engineer'], sources: ['ashby'] });
    expect(h.runRow(run)?.results.map((x) => x.error)).toEqual([
      expect.stringMatching(/^HTTP 404 from /),
      expect.stringMatching(/^HTTP 404 from /),
    ]);
    const { sources } = listSources(t.db);
    expect(sources.find((s) => s.key === 'ashby:gone-by-agent')).toMatchObject({
      enabled: false,
      lastNote: expect.stringMatching(/^switched off: the board isn't there \(HTTP 404 from /),
    });
    expect(sources.find((s) => s.key === 'ashby:gone-by-me')).toMatchObject({
      enabled: true,
      lastNote: expect.stringMatching(/^failed: HTTP 404 from /),
    });
    // The next run doesn't read it.
    h.fetch.calls.length = 0;
    await h.again(1);
    expect(h.fetch.calls.some((u) => u.includes('gone-by-agent'))).toBe(false);
  });
});
