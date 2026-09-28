// build_recipe and the search runs around it, on local career pages with a scripted
// reader_builder: a page with no feed and no ATS asks for a recipe; the recipe is checked on the
// page it was written for (a wrong one gets one more run, told what went wrong) and stored with
// that page as its fixture; the page is then read by it, never as a complete list; a recipe that
// fails its invariants, or whose sample stops looking like jobs, is rebuilt (but not in a loop).
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ReaderPool } from '../src/browser/reader-pool.ts';
import {
  listingRecipes,
  postingSources,
  postings,
  searchRuns,
  searchSources,
  searchStrategies,
  tasks,
} from '../src/db/schema.ts';
import { searchHandler } from '../src/domain/search/handlers.ts';
import { noNetwork } from '../src/domain/search/readers/http.ts';
import { buildRecipe } from '../src/domain/search/recipes/build.ts';
import { openFixture } from '../src/domain/search/recipes/page.ts';
import { runRecipe } from '../src/domain/search/recipes/run.ts';
import { RECIPE_RETRY_MS, recipeRow, requestRecipe } from '../src/domain/search/recipes/store.ts';
import { addSource, listSources } from '../src/domain/search/sources.ts';
import { addStrategy, requireStrategy, startSearchRun } from '../src/domain/search/strategies.ts';
import type { ProviderRequest, ProviderResult } from '../src/models/agent-runner.ts';
import { FakeProvider } from '../src/models/providers/fake.ts';
import type { RecipeOutput } from '../src/models/schemas/search.ts';
import { EventBus } from '../src/queue/events.ts';
import { runInTx } from '../src/queue/tx.ts';
import type { Handler } from '../src/queue/types.ts';
import { Worker } from '../src/queue/worker.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { handlers, quietLog, testDeps } from './helpers/deps.ts';
import { type SiteServer, startSiteServer } from './helpers/site-server.ts';

const role = (r: string, name: string | null = null) => ({ role: r, name, css: null });
const css = (c: string) => ({ role: null, name: null, css: c });

/** The recipe a careful builder writes for careers-cards.html. */
const CARDS: RecipeOutput = {
  kind: 'locators',
  list: role('region', 'Open positions'),
  item: role('listitem'),
  title: role('heading'),
  url: null,
  location: css('.location'),
  team: css('.team'),
  pagination: 'none',
  next: null,
  pattern: null,
  flags: null,
  titleGroup: null,
  urlGroup: null,
  locationGroup: null,
  examples: ['Senior AI Engineer', 'Product Designer', 'Data Analyst'],
  jobCount: 6,
  note: null,
};

/** A careless one: the main navigation. */
const NAV: RecipeOutput = {
  ...CARDS,
  list: role('navigation', 'Main'),
  title: role('link'),
  location: null,
  team: null,
};

const CARDS_TITLES = [
  'Senior AI Engineer',
  'Backend Engineer (Python)',
  'Platform Engineer',
  'Product Designer',
  'Founding Product Manager',
  'Data Analyst',
];

describe('listing recipes', () => {
  let site: SiteServer;
  let reader: ReaderPool;
  beforeAll(async () => {
    site = await startSiteServer();
    reader = new ReaderPool({ maxContexts: 3, navigationTimeoutMs: 15_000, log: quietLog });
  });
  afterAll(async () => {
    await reader.close();
    await site.close();
  });

  let t: TempDb;
  let bus: EventBus;
  let worker: Worker;
  let clock: number;
  const builder: Array<RecipeOutput | ((req: ProviderRequest) => ProviderResult)> = [];
  const checks: Array<'job' | 'other'> = [];
  let fake: FakeProvider;
  const now = () => new Date(clock);
  const verified: number[] = [];

  beforeEach(() => {
    t = tempDb();
    bus = new EventBus();
    clock = new Date('2026-09-28T10:00:00Z').getTime();
    builder.length = 0;
    checks.length = 0;
    verified.length = 0;
    // reader_builder answers from `builder`; listing_check (Jev off → claude:haiku) from `checks`.
    fake = new FakeProvider('claude', [], (req) => {
      if (req.role === 'reader_builder') {
        const next = builder.shift();
        if (!next) return { kind: 'error', message: 'no scripted recipe', usage: null };
        if (typeof next === 'function') return next(req);
        return { kind: 'ok', output: next, model: 'sonnet', usage: null };
      }
      if (req.role === 'listing_check') {
        const ids = [...req.prompt.matchAll(/\[(l\d+)\]/g)].map((m) => m[1] as string);
        return {
          kind: 'ok',
          output: { answers: ids.map((q) => ({ question: q, choice: checks.shift() ?? 'job' })) },
          model: 'haiku',
          usage: null,
        };
      }
      return { kind: 'error', message: `unexpected role ${req.role}`, usage: null };
    });
    const noVerify: Handler<'verify_posting'> = async (task) => {
      verified.push(task.entityId);
      return { kind: 'done', commit: () => {} };
    };
    worker = new Worker({
      db: t.db,
      read: t.read,
      bus,
      handlers: handlers({
        search: searchHandler,
        build_recipe: buildRecipe,
        verify_posting: noVerify,
      }),
      deps: testDeps({
        dir: t.dir,
        db: t.db,
        providers: [fake],
        reader,
        // The local site only: nothing reaches the network.
        fetch: (url, init) =>
          String(url).startsWith(site.origin)
            ? globalThis.fetch(url, init)
            : noNetwork(String(url)),
        now,
      }),
      log: quietLog,
      concurrency: 2,
      leaseMs: 120_000,
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

  const addPage = (path: string) =>
    addSource(t.db, { kind: 'page', locator: site.url(path) }, now()).source;
  const recipe = (sourceId: number) => recipeRow(t.db, sourceId);
  const source = (id: number) =>
    t.db.select().from(searchSources).where(eq(searchSources.id, id)).get();
  const builds = (sourceId: number) =>
    t.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.kind, 'build_recipe'), eq(tasks.entityId, sourceId)))
      .orderBy(asc(tasks.id))
      .all();
  const ask = (sourceId: number, force = false) =>
    runInTx(t.db, bus, { now: now() }, (tx) =>
      requestRecipe(
        tx,
        { id: sourceId, key: `page:${sourceId}`, kind: 'page' },
        { kind: 'none', detail: 'test' },
        { force },
      ),
    );

  it('builds a recipe, checks it on the page and stores it with the page as its fixture', async () => {
    const src = addPage('/careers-cards.html');
    builder.push(CARDS);
    expect(ask(src.id)).toBe(true);
    expect(recipe(src.id)?.status).toBe('building');
    await worker.idle();

    const row = recipe(src.id);
    expect(row).toMatchObject({ status: 'ok', lastCount: 6, builds: 1, note: '6 jobs' });
    expect(row?.recipe).toEqual({
      kind: 'locators',
      list: { role: 'region', name: 'Open positions' },
      item: { role: 'listitem', name: null },
      fields: {
        title: { role: 'heading', name: null },
        url: null,
        location: { css: '.location' },
        team: { css: '.team' },
      },
      pagination: null,
    });
    expect(row?.expected?.map((l) => l.title)).toEqual(CARDS_TITLES);
    // The fixture: the page as it was, without scripts, hidden elements marked.
    expect(row?.fixtureUrl).toBe(site.url('/careers-cards.html'));
    expect(row?.fixtureHtml).toContain('Founding Product Manager');
    expect(row?.fixtureHtml).not.toContain('<script');
    expect(row?.fixtureHtml).toMatch(/<li class="position card-template" hidden/);
    expect(source(src.id)).toMatchObject({ resolved: { via: 'recipe' } });
    expect(source(src.id)?.lastNote).toMatch(/^listing recipe built: 6 jobs/);

    // The builder saw the page three ways.
    const prompt = fake.requests[0]?.prompt ?? '';
    expect(prompt).toContain(`Page: ${site.url('/careers-cards.html')}`);
    expect(prompt).toMatch(/heading "Senior AI Engineer"/);
    expect(prompt).toMatch(/li\.position.*\n.*a\.position-link/);
    expect(prompt).toMatch(/Senior AI Engineer <http:\/\/127\.0\.0\.1:\d+\/careers\/jobs\/101/);

    // The stored page replays offline to the same listings.
    if (!row?.recipe || !row.fixtureHtml || !row.fixtureUrl) throw new Error('nothing stored');
    const stored = { recipe: row.recipe, html: row.fixtureHtml, url: row.fixtureUrl };
    const replayed = await reader.withPage(async (page) => {
      await openFixture(page, stored.url, stored.html);
      return runRecipe(page, stored.recipe, { paginate: false });
    });
    expect(replayed.listings).toEqual(row.expected);
  });

  it('a recipe that fails its check gets one more run, told what went wrong', async () => {
    const src = addPage('/careers-cards.html');
    builder.push(NAV, CARDS);
    ask(src.id);
    await worker.idle();
    expect(fake.requests.map((r) => r.role)).toEqual(['reader_builder', 'reader_builder']);
    const second = fake.requests[1]?.prompt ?? '';
    expect(second).toContain('Your previous recipe for this page did not pass the check');
    expect(second).toContain("it didn't find the example titles");
    expect(second).toMatch(/Home → http:\/\/127\.0\.0\.1:\d+\//);
    expect(recipe(src.id)).toMatchObject({ status: 'ok', note: '6 jobs (second try)' });
  });

  it('no job list: the build fails with the reason, and the page is tried again days later', async () => {
    const src = addPage('/careers-cards.html');
    builder.push({ ...CARDS, kind: 'none', note: 'a blog, not a careers page' });
    ask(src.id);
    await worker.idle();
    expect(recipe(src.id)).toMatchObject({
      status: 'failed',
      recipe: null,
      note: 'reader_builder found no job list on the page: a blog, not a careers page',
    });
    expect(source(src.id)?.lastNote).toMatch(
      /^no listing recipe: reader_builder found no job list/,
    );
    // Not again right away…
    expect(ask(src.id)).toBe(false);
    // …unless asked for by the candidate, or after RECIPE_RETRY_MS.
    clock += RECIPE_RETRY_MS + 1;
    expect(ask(src.id)).toBe(true);
    builder.push(CARDS);
    await worker.idle();
    expect(recipe(src.id)).toMatchObject({ status: 'ok', builds: 2 });
  });

  it('two recipes that fail their check: no recipe, with both problems given', async () => {
    const src = addPage('/careers-cards.html');
    builder.push(NAV, { ...NAV, title: role('heading') });
    ask(src.id);
    await worker.idle();
    const row = recipe(src.id);
    expect(row?.status).toBe('failed');
    expect(row?.note).toMatch(/^no recipe passed the check after 2 tries: it read no jobs/);
  });

  it('a search run asks for a recipe; once built, the page is read by it, never as a complete list', async () => {
    const src = addPage('/careers-cards.html');
    builder.push(CARDS);
    const { strategy, runId } = runInTx(t.db, bus, { now: now() }, (tx) =>
      addStrategy(tx, { name: 'Everything', sources: [src.key] }),
    );
    await worker.idle();

    // Run 1: nothing to read the page with; a build was asked for, under the run's id.
    const first = t.db
      .select()
      .from(searchRuns)
      .where(eq(searchRuns.id, runId ?? 0))
      .get();
    expect(first?.results[0]).toMatchObject({
      sourceKey: src.key,
      listed: 0,
      error: expect.stringMatching(/it needs a listing recipe$/),
    });
    const [build] = builds(src.id);
    expect(build).toMatchObject({ status: 'done', runId });
    expect(recipe(src.id)?.status).toBe('ok');
    // The strategy is due again at once: its listings were missing from run 1.
    const s = requireStrategy(t.db, strategy.id);
    expect(s.nextRunAt.getTime()).toBeLessThanOrEqual(now().getTime());

    // Run 2 reads the page with its recipe.
    const second = runInTx(t.db, bus, { now: now() }, (tx) =>
      startSearchRun(tx, requireStrategy(tx.db, strategy.id), 'schedule'),
    );
    await worker.idle();
    const run2 = t.db
      .select()
      .from(searchRuns)
      .where(eq(searchRuns.id, second ?? 0))
      .get();
    expect(run2?.results[0]).toMatchObject({
      listed: 6,
      added: 6,
      complete: false,
      note: 'listing recipe: 6 jobs',
      error: null,
    });
    const titles = t.db
      .select({ title: postings.title })
      .from(postings)
      .all()
      .map((p) => p.title);
    expect(titles.sort()).toEqual([...CARDS_TITLES].sort());
    const link = t.db
      .select()
      .from(postingSources)
      .where(eq(postingSources.url, site.url('/careers/jobs/101-senior-ai-engineer')))
      .get();
    expect(link).toMatchObject({
      searchSourceId: src.id,
      externalId: site.url('/careers/jobs/101-senior-ai-engineer'),
    });
    expect(verified).toHaveLength(6);
    expect(source(src.id)?.lastComplete).toBe(false);
    // …and the source says its list isn't complete (absence never closes its postings).
    expect(listSources(t.db).sources.find((s) => s.id === src.id)?.completeList).toBe(false);
  });

  const withRecipe = async (o: {
    builtAgoMs: number;
    lastCount?: number;
    sampledAgoMs?: number;
  }) => {
    const src = addPage('/careers-cards.html');
    builder.push(CARDS);
    ask(src.id);
    await worker.idle();
    t.db
      .update(listingRecipes)
      .set({
        builtAt: new Date(clock - o.builtAgoMs),
        lastSampledAt: new Date(clock - (o.sampledAgoMs ?? 0)),
        ...(o.lastCount !== undefined ? { lastCount: o.lastCount } : {}),
      })
      .where(eq(listingRecipes.sourceId, src.id))
      .run();
    const { strategy } = runInTx(t.db, bus, { now: now() }, (tx) =>
      addStrategy(tx, { name: 'Everything', sources: [src.key] }),
    );
    await worker.idle();
    const [run] = t.db
      .select()
      .from(searchRuns)
      .where(eq(searchRuns.strategyId, strategy.id))
      .all();
    return { src, run };
  };

  it('a recipe that fails its invariants is rebuilt', async () => {
    builder.push(CARDS);
    const { src, run } = await withRecipe({ builtAgoMs: 2 * 86_400_000, lastCount: 40 });
    expect(run?.results[0]?.error).toMatch(
      /its listing recipe failed its checks: 6 listings where the last good read had 40/,
    );
    expect(builds(src.id)).toHaveLength(2);
    expect(recipe(src.id)).toMatchObject({ status: 'ok', builds: 2, lastCount: 6 });
  });

  it('…but not one that breaks within a day of being built (no build loops)', async () => {
    const { src, run } = await withRecipe({ builtAgoMs: 3_600_000, lastCount: 40 });
    expect(run?.results[0]?.error).toMatch(/failed its checks/);
    expect(builds(src.id)).toHaveLength(1);
    expect(recipe(src.id)).toMatchObject({ status: 'failed' });
    expect(recipe(src.id)?.note).toMatch(/^broke within a day of being built/);
  });

  it('every few days a sample of its listings is checked: jobs, so it stays', async () => {
    checks.push('job', 'job', 'job');
    const { src, run } = await withRecipe({
      builtAgoMs: 5 * 86_400_000,
      sampledAgoMs: 4 * 86_400_000,
    });
    expect(run?.results[0]).toMatchObject({ listed: 6, error: null });
    expect(fake.requests.filter((r) => r.role === 'listing_check')).toHaveLength(1);
    const prompt = fake.requests.find((r) => r.role === 'listing_check')?.prompt ?? '';
    expect(prompt).toContain('Senior AI Engineer');
    expect(prompt).toContain('Data Analyst');
    expect(recipe(src.id)?.lastSampledAt?.getTime()).toBe(clock);
  });

  it('…not jobs any more, so it is rebuilt', async () => {
    checks.push('other', 'other', 'job');
    builder.push(CARDS);
    const { src, run } = await withRecipe({
      builtAgoMs: 5 * 86_400_000,
      sampledAgoMs: 4 * 86_400_000,
    });
    expect(run?.results[0]?.error).toMatch(/reads something other than jobs now \(2 of 3/);
    expect(builds(src.id)).toHaveLength(2);
  });

  it('a sample is not checked again before a few days pass', async () => {
    await withRecipe({ builtAgoMs: 5 * 86_400_000, sampledAgoMs: 86_400_000 });
    expect(fake.requests.filter((r) => r.role === 'listing_check')).toHaveLength(0);
    const strategies = t.db.select().from(searchStrategies).all();
    expect(strategies).toHaveLength(1);
  });
});
