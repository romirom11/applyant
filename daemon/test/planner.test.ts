// The search planner (a scripted codex): its strategies are added marked agent-generated and
// start running; the boards its web searches found join the watch list with its reasons; what
// isn't a company's board, or duplicates what's there, is skipped. It runs again weekly once the
// candidate has run it. Weak strategies run less often, and say so.
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  postings,
  searchPlans,
  searchStrategies,
  strategyPostings,
  tasks,
} from '../src/db/schema.ts';
import { setPreference } from '../src/domain/scoring/prefs.ts';
import {
  PLAN_EVERY_MS,
  planSearch,
  schedulePlanner,
  startPlan,
} from '../src/domain/search/planner.ts';
import { addSource, ensureBuiltinSources, listSources } from '../src/domain/search/sources.ts';
import {
  addStrategy,
  CADENCE_MIN_DECIDED,
  cadenceFor,
  listStrategies,
  requireStrategy,
  startSearchRun,
} from '../src/domain/search/strategies.ts';
import { FakeProvider } from '../src/models/providers/fake.ts';
import type { PlannerOutput } from '../src/models/schemas/search.ts';
import { EventBus } from '../src/queue/events.ts';
import { runInTx } from '../src/queue/tx.ts';
import type { Handler } from '../src/queue/types.ts';
import { Worker } from '../src/queue/worker.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { handlers, quietLog, testDeps } from './helpers/deps.ts';

const PLAN: PlannerOutput = {
  strategies: [
    {
      name: 'LLM Engineer · Remote EU',
      queries: ['llm engineer', 'ai engineer -intern'],
      locations: ['remote', 'europe'],
      sources: ['ashby', 'https://jobs.ashbyhq.com/lumen', 'board:hn', 'nonsense:key'],
      everyHours: 12,
      why: 'The AI roles on Ashby boards the current strategies do not read.',
    },
    {
      name: 'Founding engineer',
      queries: ['founding engineer'],
      locations: [],
      sources: ['nonsense'],
      everyHours: null,
      why: 'Early-stage roles.',
    },
    {
      // The same as the candidate's own strategy.
      name: 'AI again',
      queries: ['AI Engineer'],
      locations: ['Remote'],
      sources: ['all'],
      everyHours: 0.5,
      why: 'duplicate',
    },
  ],
  boards: [
    {
      url: 'https://jobs.ashbyhq.com/lumen',
      company: 'Lumen Health',
      why: 'Builds LLM tooling for clinics; remote in Europe.',
      foundWith: 'site:jobs.ashbyhq.com "AI Engineer" Europe',
    },
    {
      url: 'https://job-boards.greenhouse.io/tallyhall/jobs/4012',
      company: 'Tallyhall',
      why: 'Hires founding engineers.',
      foundWith: null,
    },
    {
      url: 'https://kestrel.example/careers',
      company: 'Kestrel',
      why: 'Python shop in Athens.',
      foundWith: null,
    },
    { url: 'https://www.linkedin.com/jobs/view/123', company: 'Acme', why: 'x', foundWith: null },
    { url: 'not a url', company: null, why: 'x', foundWith: null },
    {
      url: 'https://jobs.lever.co/gitlab',
      company: 'GitLab',
      why: 'already there',
      foundWith: null,
    },
  ],
  searches: [
    'site:jobs.ashbyhq.com "AI Engineer" Europe',
    'site:job-boards.greenhouse.io founding engineer',
  ],
  note: null,
};

describe('search planner', () => {
  let t: TempDb;
  let bus: EventBus;
  let codex: FakeProvider;
  let worker: Worker;
  let clock: number;
  const now = () => new Date(clock);

  beforeEach(() => {
    t = tempDb();
    bus = new EventBus();
    clock = new Date('2026-09-28T10:00:00Z').getTime();
    codex = new FakeProvider('codex');
    ensureBuiltinSources(t.db, now());
    const noSearch: Handler<'search'> = async () => ({ kind: 'done', commit: () => {} });
    worker = new Worker({
      db: t.db,
      read: t.read,
      bus,
      handlers: handlers({ plan_search: planSearch, search: noSearch }),
      deps: testDeps({ dir: t.dir, db: t.db, providers: [codex], now }),
      log: quietLog,
      concurrency: 1,
      leaseMs: 60_000,
      pollMs: 10,
      maxAttempts: 3,
      now,
    });
    worker.start();
  });

  afterEach(async () => {
    await worker.stop();
    t.cleanup();
  });

  const plan = () => runInTx(t.db, bus, { now: now() }, (tx) => startPlan(tx, 'manual'));
  const planRow = (id: number) =>
    t.db.select().from(searchPlans).where(eq(searchPlans.id, id)).get();

  it('adds its strategies (agent-generated, running) and watches the boards it found', async () => {
    addSource(t.db, { kind: 'lever', locator: 'gitlab' }, now());
    runInTx(t.db, bus, { now: now() }, (tx) =>
      addStrategy(tx, {
        name: 'Mine',
        queries: ['ai engineer'],
        locations: ['remote'],
        sources: ['all'],
      }),
    );
    setPreference(t.db, 'roles', ['AI Engineer', 'Backend Engineer'], now());
    codex.push({ output: PLAN });
    const id = plan();
    expect(id).not.toBeNull();
    // One at a time.
    expect(plan()).toBeNull();
    await worker.idle();

    // It searched the web, from a prompt that knows the candidate and what's searched already.
    const req = codex.requests[0];
    expect(req?.role).toBe('search_planner');
    expect(req?.webSearch).toBe(true);
    expect(req?.prompt).toContain('"roles":["AI Engineer","Backend Engineer"]');
    expect(req?.prompt).toContain('- "Mine" (candidate, active) queries ["ai engineer"]');
    expect(req?.prompt).toContain('- lever:gitlab · gitlab · candidate');
    expect(req?.prompt).toContain('board:hn (Hacker News · Who is hiring)');

    const watched = listSources(t.db).sources.filter((s) => s.origin === 'agent');
    // Listed by kind: company boards, then career pages.
    expect(watched.map((s) => [s.key, s.label, s.note])).toEqual([
      ['greenhouse:tallyhall', 'Tallyhall', 'Hires founding engineers.'],
      [
        'ashby:lumen',
        'Lumen Health',
        'Builds LLM tooling for clinics; remote in Europe. · found with: site:jobs.ashbyhq.com "AI Engineer" Europe',
      ],
      ['page:https://kestrel.example/careers', 'Kestrel', 'Python shop in Athens.'],
    ]);

    const strategies = listStrategies(t.db).filter((s) => s.origin === 'agent');
    expect(strategies.map((s) => [s.name, s.sources, s.everyMinutes, s.state, s.note])).toEqual([
      [
        'LLM Engineer · Remote EU',
        ['ashby', 'ashby:lumen', 'board:hn'],
        720,
        'active',
        'The AI roles on Ashby boards the current strategies do not read.',
      ],
      // Its only source was unknown: it reads everything.
      ['Founding engineer', ['all'], 360, 'active', 'Early-stage roles.'],
    ]);
    // Each started its first run.
    expect(strategies.map((s) => s.lastRun?.trigger)).toEqual(['manual', 'manual']);

    const row = planRow(id ?? 0);
    expect(row).toMatchObject({
      status: 'done',
      trigger: 'manual',
      strategies: strategies.map((s) => s.id),
      boards: ['ashby:lumen', 'greenhouse:tallyhall', 'page:https://kestrel.example/careers'],
      searches: PLAN.searches,
    });
    expect(row?.note).toMatch(
      /^2 new strategies · 3 new boards watched · 1 already watched · 2 web searches · skipped: /,
    );
    expect(row?.note).toContain(
      "board https://www.linkedin.com/jobs/view/123: linkedin.com isn't a company's own board",
    );
    expect(row?.note).toContain('board not a url: not a URL');
    expect(row?.note).toContain('strategy "AI again": the same as "Mine"');
  });

  it('a failed planner run is retried once, then the plan says why', async () => {
    codex.push({ error: 'codex: stream disconnected' }, { error: 'codex: stream disconnected' });
    const id = plan() ?? 0;
    await worker.idle();
    expect(planRow(id)?.status).toBe('queued');
    clock += 5 * 60_000;
    await worker.idle();
    expect(planRow(id)).toMatchObject({
      status: 'failed',
      note: 'the planner failed: codex: stream disconnected',
    });
  });

  it('runs again weekly, but only once the candidate has run it', async () => {
    const tick = () => runInTx(t.db, bus, { now: now() }, (tx) => schedulePlanner(tx));
    expect(tick()).toBeNull();
    codex.push({ output: { ...PLAN, strategies: [], boards: [] } });
    plan();
    await worker.idle();
    expect(tick()).toBeNull();
    clock += PLAN_EVERY_MS + 1;
    codex.push({ output: { ...PLAN, strategies: [], boards: [] } });
    const weekly = tick();
    expect(weekly).not.toBeNull();
    expect(tick()).toBeNull();
    await worker.idle();
    expect(planRow(weekly ?? 0)).toMatchObject({ trigger: 'schedule', status: 'done' });
    expect(
      t.db
        .select({ kind: tasks.kind })
        .from(tasks)
        .where(eq(tasks.kind, 'plan_search'))
        .orderBy(asc(tasks.id))
        .all(),
    ).toHaveLength(2);
  });
});

describe('weak strategies run less often', () => {
  it('slows down by the share of decided postings marked interested', () => {
    const s = (interested: number, skipped: number) => ({
      found: 40,
      verified: 30,
      interested,
      skipped,
    });
    // Too few decisions to judge.
    expect(cadenceFor(360, s(0, CADENCE_MIN_DECIDED - 1))).toEqual({
      factor: 1,
      everyMinutes: 360,
      note: null,
    });
    expect(cadenceFor(360, s(2, 6)).factor).toBe(1);
    expect(cadenceFor(360, s(1, 7))).toEqual({
      factor: 2,
      everyMinutes: 720,
      note: 'runs less often (every 12h instead of 6h): 1 of 8 postings you decided on were interesting (13%)',
    });
    expect(cadenceFor(360, s(0, 12))).toMatchObject({ factor: 4, everyMinutes: 1440 });
    // Never slower than weekly.
    expect(cadenceFor(4320, s(0, 12))).toMatchObject({ everyMinutes: 7 * 1440 });
  });

  it('a slowed strategy is scheduled further out, and says why', () => {
    const t = tempDb();
    try {
      const bus = new EventBus();
      const now = new Date('2026-09-28T10:00:00Z');
      const { strategy } = runInTx(t.db, bus, { now }, (tx) =>
        addStrategy(tx, { name: 'Weak', sources: ['all'], state: 'paused' }),
      );
      for (let i = 0; i < 10; i++) {
        const p = t.db
          .insert(postings)
          .values({
            stage: 'scored',
            canonicalUrl: `https://acme.example/jobs/${i}`,
            verifiedAt: now,
            decision: i === 0 ? 'interested' : 'skipped',
          })
          .returning()
          .get();
        t.db.insert(strategyPostings).values({ strategyId: strategy.id, postingId: p.id }).run();
      }
      runInTx(t.db, bus, { now }, (tx) =>
        startSearchRun(tx, requireStrategy(tx.db, strategy.id), 'manual'),
      );
      const row = t.db
        .select()
        .from(searchStrategies)
        .where(eq(searchStrategies.id, strategy.id))
        .get();
      // 1 of 10 interested (10%): half as often.
      expect(row?.nextRunAt).toEqual(new Date(now.getTime() + 720 * 60_000));
      const view = listStrategies(t.db)[0];
      expect(view?.cadence).toMatchObject({ factor: 2, everyMinutes: 720 });
      expect(view?.cadence.note).toMatch(/^runs less often/);
    } finally {
      t.cleanup();
    }
  });
});
