// LinkedIn and Xing as search sources (phase 14b): their search pages read by a recipe under the
// signed-in session, inside the platform guardrails. Every page is a local fixture served for
// www.linkedin.com / www.xing.com inside a headless Chromium context that refuses every other
// request: no real site is ever contacted, and no real Chrome is launched (the "signed-in
// browser" here is that headless context).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Guardrails, PlatformChallenge } from '../src/browser/guardrails.ts';
import type { SubmitProfile } from '../src/browser/submit-profile.ts';
import { postingSources, postings, searchSources } from '../src/db/schema.ts';
import { LINKEDIN, linkedinJobPage } from '../src/domain/search/readers/linkedin.ts';
import { type PlatformAccess, readPlatform } from '../src/domain/search/readers/platform.ts';
import { XING, xingJobPage } from '../src/domain/search/readers/xing.ts';
import {
  ensureBuiltinSources,
  listSources,
  parseSourceInput,
  sourcesFor,
} from '../src/domain/search/sources.ts';
import { EventBus } from '../src/queue/events.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { searchHarness } from './helpers/search.ts';

vi.setConfig({ testTimeout: 60_000 });

const SITES = fileURLToPath(new URL('./fixtures/sites', import.meta.url));
const NO_PACING = {
  taskGapMs: [0, 0] as [number, number],
  actionMs: [0, 0] as [number, number],
  keyMs: [0, 0] as [number, number],
};

/** Serves fixtures for the platforms' hosts; everything else is refused. */
async function platformContext(
  browser: Browser,
  pages: { linkedin?: string; xing?: string },
): Promise<{ context: BrowserContext; requested: string[] }> {
  const context = await browser.newContext();
  const requested: string[] = [];
  await context.route('**/*', (route) => {
    const url = route.request().url();
    requested.push(url);
    const host = new URL(url).hostname;
    const file =
      host === 'www.linkedin.com' ? pages.linkedin : host === 'www.xing.com' ? pages.xing : null;
    if (!file || route.request().resourceType() !== 'document') return route.abort();
    return route.fulfill({
      contentType: 'text/html',
      body: readFileSync(join(SITES, file), 'utf8'),
    });
  });
  return { context, requested };
}

/** The signed-in browser as the readers see it: pages of that context; kept pages recorded. */
function access(guardrails: Guardrails, context: BrowserContext, kept: Page[]): PlatformAccess {
  return {
    guardrails,
    async browse(fn) {
      const page = await context.newPage();
      const { result, keepOpen } = await fn(page);
      if (keepOpen) kept.push(page);
      else await page.close();
      return result;
    },
  };
}

const ctxFor = (platform: PlatformAccess, queries: string[], locations: string[] = []) => ({
  fetch: async () => {
    throw new Error('no network');
  },
  signal: new AbortController().signal,
  queries,
  locations,
  reader: null,
  now: new Date('2026-09-29T10:00:00Z'),
  platform,
});

describe('LinkedIn and Xing search pages', () => {
  let browser: Browser;
  let t: TempDb | undefined;
  const closers: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    t?.cleanup();
    t = undefined;
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('builds search URLs and job pages without tracking parameters', () => {
    const li = new URL(LINKEDIN.searchUrl('ai engineer', ['remote', 'Germany']));
    expect(li.origin + li.pathname).toBe('https://www.linkedin.com/jobs/search/');
    expect(li.searchParams.get('keywords')).toBe('ai engineer');
    expect(li.searchParams.get('location')).toBe('Germany');
    expect(li.searchParams.get('f_WT')).toBe('2');
    expect(linkedinJobPage('https://www.linkedin.com/jobs/view/4001001/?refId=x')).toEqual({
      url: 'https://www.linkedin.com/jobs/view/4001001/',
      id: '4001001',
    });
    expect(
      linkedinJobPage('https://de.linkedin.com/jobs/view/senior-ai-engineer-at-x-4001009'),
    ).toEqual({
      url: 'https://www.linkedin.com/jobs/view/4001009/',
      id: '4001009',
    });
    expect(linkedinJobPage('https://www.linkedin.com/jobs/search/?currentJobId=4001003')?.id).toBe(
      '4001003',
    );
    expect(linkedinJobPage('https://www.linkedin.com/company/acme/')).toBeNull();
    expect(new URL(XING.searchUrl('backend', ['Hamburg'])).searchParams.get('location')).toBe(
      'Hamburg',
    );
    expect(
      xingJobPage('https://www.xing.com/jobs/hamburg-senior-backend-engineer-130001111?ijt=1'),
    ).toEqual({
      url: 'https://www.xing.com/jobs/hamburg-senior-backend-engineer-130001111',
      id: '130001111',
    });
    expect(xingJobPage('https://www.xing.com/jobs/search?keywords=x')).toBeNull();
  });

  it('reads a LinkedIn search page as one guarded search, never a complete list', async () => {
    t = tempDb();
    const g = new Guardrails({ db: t.db, bus: new EventBus(), pacing: NO_PACING });
    const { context, requested } = await platformContext(browser, {
      linkedin: 'linkedin-search.html',
    });
    closers.push(() => context.close());
    const run = await readPlatform(
      LINKEDIN,
      ctxFor(access(g, context, []), ['ai engineer', 'backend'], ['remote']),
    );
    expect(run.complete).toBe(false);
    expect(run.note).toMatch(/LinkedIn search: 3 jobs for 2 queries/);
    expect(run.listings.map((l) => [l.title, l.company, l.url, l.externalId])).toEqual([
      [
        'Senior AI Engineer',
        'Guarded Co',
        'https://www.linkedin.com/jobs/view/4001001/',
        'linkedin:4001001',
      ],
      [
        'Backend Engineer (Python)',
        'Lanes GmbH',
        'https://www.linkedin.com/jobs/view/4001002/',
        'linkedin:4001002',
      ],
      [
        'Machine Learning Engineer',
        'Pacing Labs',
        'https://www.linkedin.com/jobs/view/4001003/',
        'linkedin:4001003',
      ],
    ]);
    expect(run.listings[0]?.location).toBe('Berlin, Germany (Remote)');
    expect(run.listings[0]?.remote).toBe(true);
    // Two search pages, one counted search; nothing but linkedin.com was asked for.
    expect(g.status('linkedin').searchesToday).toBe(1);
    const docs = requested.filter((u) => u.includes('/jobs/search/'));
    expect(docs).toHaveLength(2);
    expect(requested.every((u) => new URL(u).hostname === 'www.linkedin.com')).toBe(true);
  });

  it('reads a Xing search page', async () => {
    t = tempDb();
    const g = new Guardrails({ db: t.db, bus: new EventBus(), pacing: NO_PACING });
    const { context } = await platformContext(browser, { xing: 'xing-search.html' });
    closers.push(() => context.close());
    const run = await readPlatform(XING, ctxFor(access(g, context, []), ['engineer']));
    expect(run.complete).toBe(false);
    expect(run.listings.map((l) => [l.title, l.company, l.location, l.externalId])).toEqual([
      ['Senior Backend Engineer', 'Hanse Software AG', 'Hamburg', 'xing:130001111'],
      ['AI Engineer (m/w/d)', 'Spree Analytics GmbH', 'Berlin', 'xing:130002222'],
    ]);
    expect(g.status('xing').searchesToday).toBe(1);
    expect(g.status('linkedin').searchesToday).toBe(0);
  });

  it('a checkpoint instead of results pauses LinkedIn and leaves the page for the candidate', async () => {
    t = tempDb();
    const g = new Guardrails({ db: t.db, bus: new EventBus(), pacing: NO_PACING });
    const { context } = await platformContext(browser, { linkedin: 'linkedin-checkpoint.html' });
    closers.push(() => context.close());
    const kept: Page[] = [];
    const err = await readPlatform(LINKEDIN, ctxFor(access(g, context, kept), ['ai'])).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PlatformChallenge);
    expect(g.status('linkedin').pausedAt).not.toBeNull();
    expect(g.status('linkedin').pauseReason).toMatch(/security check|captcha/);
    expect(kept).toHaveLength(1);
    // Paused: the next read doesn't open a page.
    const again = await readPlatform(LINKEDIN, ctxFor(access(g, context, kept), ['ai'])).catch(
      (e: unknown) => e,
    );
    expect((again as Error).message).toMatch(/LinkedIn is paused/);
    expect(kept).toHaveLength(1);
  });

  it('are built-in sources, off until signed in, and not addable as pages', () => {
    const db = tempDb();
    t = db;
    const g = new Guardrails({ db: db.db, bus: new EventBus() });
    ensureBuiltinSources(db.db, new Date());
    const keys = (sel: string[]) => sourcesFor(db.read, sel).map((s) => s.key);
    expect(keys(['all'])).not.toContain('linkedin:jobs');
    expect(keys(['linkedin', 'xing'])).toEqual([]);
    const view = listSources(t.read).sources.find((s) => s.key === 'linkedin:jobs');
    expect(view?.needsSignIn).toBe(true);
    expect(view?.completeList).toBe(false);
    expect(view?.lastNote).toMatch(/off until Applyant's browser is signed in to LinkedIn/);
    g.markSignedIn('linkedin');
    expect(keys(['all'])).toContain('linkedin:jobs');
    expect(keys(['all'])).not.toContain('xing:jobs');
    expect(() => parseSourceInput(['https://www.linkedin.com/jobs/search/?keywords=ai'])).toThrow(
      /built-in source \(linkedin:jobs\)/,
    );
    expect(() => parseSourceInput(['xing', 'mine'])).toThrow(/built-in source \(xing:jobs\)/);
  });

  it('a search run through the queue reads LinkedIn once signed in, as found postings', async () => {
    t = tempDb();
    const bus = new EventBus();
    const guardrails = new Guardrails({ db: t.db, bus, pacing: NO_PACING });
    const { context } = await platformContext(browser, { linkedin: 'linkedin-search.html' });
    closers.push(() => context.close());
    const kept: Page[] = [];
    const submit = {
      deliver: (fn: Parameters<PlatformAccess['browse']>[0]) =>
        access(guardrails, context, kept).browse(fn),
    } as unknown as SubmitProfile;
    const h = searchHarness(t, { deps: { guardrails, submit } });
    closers.push(() => h.stop());

    // Not signed in: the run doesn't read LinkedIn at all.
    const first = await h.run({ name: 'AI', queries: ['engineer'], sources: ['linkedin'] });
    expect(h.runRow(first)?.results).toEqual([]);
    expect(guardrails.status('linkedin').searchesToday).toBe(0);

    guardrails.markSignedIn('linkedin');
    const strategy = h.runRow(first)?.strategyId as number;
    const run = await h.again(strategy);
    const result = h.runRow(run)?.results[0];
    expect(result?.error ?? null).toBeNull();
    expect(result?.complete).toBe(false);
    const found = t.db.select().from(postings).all();
    expect(found.map((p) => [p.title, p.company, p.stage]).sort()).toEqual([
      ['Backend Engineer (Python)', 'Lanes GmbH', 'found'],
      ['Machine Learning Engineer', 'Pacing Labs', 'found'],
      ['Senior AI Engineer', 'Guarded Co', 'found'],
    ]);
    const links = t.db.select().from(postingSources).all();
    const source = t.db
      .select()
      .from(searchSources)
      .where(eq(searchSources.key, 'linkedin:jobs'))
      .get();
    expect(links.every((l) => l.searchSourceId === source?.id)).toBe(true);
    expect(guardrails.status('linkedin').searchesToday).toBe(1);
  });
});
