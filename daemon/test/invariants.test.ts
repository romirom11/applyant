// A recipe's output is trusted only when cheap invariants hold: absolute links on the site (or a
// known ATS), real and varied titles, and a count within [0.3×, 3×] of the last good read, once
// that read had at least 5. Running recipes on local career pages: locator recipes read every
// visible item, "next" pagination stops when there's no next page, and scroll pagination stops
// after 3 scrolls in a row that add nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReaderPool } from '../src/browser/reader-pool.ts';
import { openListing } from '../src/domain/search/recipes/page.ts';
import {
  checkInvariants,
  EMPTY_SCROLLS_TO_STOP,
  runRecipe,
  siteOf,
  toReaderRun,
} from '../src/domain/search/recipes/run.ts';
import type { ListingRecipe, RecipeListing } from '../src/domain/search/recipes/types.ts';
import { quietLog } from './helpers/deps.ts';
import { type SiteServer, startSiteServer } from './helpers/site-server.ts';

const job = (n: number, url = `https://acme.com/jobs/${n}`): RecipeListing => ({
  title: `Engineer ${n}`,
  url,
  location: null,
  team: null,
});
const jobs = (n: number) => Array.from({ length: n }, (_, i) => job(i + 1));
const PAGE = 'https://acme.com/careers';

describe('checkInvariants', () => {
  it('passes a plain list', () => {
    expect(checkInvariants({ listings: jobs(4), pageUrl: PAGE, lastCount: null })).toEqual([]);
  });

  it('applies the count window only once the last good read had at least 5', () => {
    // A small or previously empty board legitimately jumps.
    expect(checkInvariants({ listings: jobs(20), pageUrl: PAGE, lastCount: 4 })).toEqual([]);
    expect(checkInvariants({ listings: [], pageUrl: PAGE, lastCount: 4 })).toEqual([]);
    expect(checkInvariants({ listings: jobs(1), pageUrl: PAGE, lastCount: 0 })).toEqual([]);
    // From 5 on: [0.3 × last, 3 × last].
    expect(checkInvariants({ listings: jobs(3), pageUrl: PAGE, lastCount: 10 })).toEqual([]);
    expect(checkInvariants({ listings: jobs(30), pageUrl: PAGE, lastCount: 10 })).toEqual([]);
    expect(checkInvariants({ listings: jobs(2), pageUrl: PAGE, lastCount: 10 })).toEqual([
      '2 listings where the last good read had 10',
    ]);
    expect(checkInvariants({ listings: jobs(31), pageUrl: PAGE, lastCount: 10 })).toEqual([
      '31 listings where the last good read had 10',
    ]);
    expect(checkInvariants({ listings: [], pageUrl: PAGE, lastCount: 5 })).toEqual([
      '0 listings where the last good read had 5',
    ]);
  });

  it('wants links on the same site or a known ATS', () => {
    const ok = [
      job(1, 'https://careers.acme.com/jobs/1'),
      job(2, 'https://job-boards.greenhouse.io/acme/jobs/2'),
      job(3, 'https://acme.wd3.myworkdayjobs.com/External/job/3'),
      job(4, 'http://acme.com/jobs/4'),
    ];
    expect(checkInvariants({ listings: ok, pageUrl: PAGE, lastCount: null })).toEqual([]);
    const off = [job(1), job(2, 'https://ads.example.net/click?id=2')];
    expect(checkInvariants({ listings: off, pageUrl: PAGE, lastCount: null })).toEqual([
      '1 link(s) lead off the site to an unknown host (https://ads.example.net/click?id=2)',
    ]);
    const bad = [job(1), job(2, 'javascript:void(0)')];
    expect(checkInvariants({ listings: bad, pageUrl: PAGE, lastCount: null })).toEqual([
      "1 link(s) aren't absolute web addresses (javascript:void(0))",
    ]);
  });

  it('wants real, varied titles and links', () => {
    const same = jobs(3).map((l) => ({ ...l, title: 'Apply now' }));
    expect(checkInvariants({ listings: same, pageUrl: PAGE, lastCount: null })).toEqual([
      'every listing has the same title ("Apply now")',
    ]);
    const oneLink = jobs(3).map((l) => ({ ...l, url: 'https://acme.com/apply' }));
    expect(checkInvariants({ listings: oneLink, pageUrl: PAGE, lastCount: null })).toEqual([
      'every listing links to the same page (https://acme.com/apply)',
    ]);
    const empty = [job(1), { ...job(2), title: ' ' }];
    expect(checkInvariants({ listings: empty, pageUrl: PAGE, lastCount: null })).toEqual([
      '1 listing(s) have no title',
    ]);
  });

  it('knows a site by its registrable part', () => {
    expect(siteOf('careers.acme.com')).toBe('acme.com');
    expect(siteOf('jobs.acme.co.uk')).toBe('acme.co.uk');
    expect(siteOf('acme.io')).toBe('acme.io');
  });

  it('never gives a complete list', () => {
    const run = toReaderRun(jobs(2), 'listing recipe: 2 jobs');
    expect(run.complete).toBe(false);
    expect(run.listings[0]).toMatchObject({
      url: 'https://acme.com/jobs/1',
      externalId: 'https://acme.com/jobs/1',
      title: 'Engineer 1',
    });
  });
});

describe('running recipes on career pages', () => {
  let site: SiteServer;
  let reader: ReaderPool;
  beforeAll(async () => {
    site = await startSiteServer();
    reader = new ReaderPool({ maxContexts: 2, navigationTimeoutMs: 15_000, log: quietLog });
  });
  afterAll(async () => {
    await reader.close();
    await site.close();
  });

  const run = (path: string, recipe: ListingRecipe, paginate = true) =>
    reader.withPage(async (page) => {
      await openListing(page, site.url(path));
      return runRecipe(page, recipe, { paginate, scrollWaitMs: 200 });
    });

  it('reads every visible item of the named list, ARIA first, CSS for the rest', async () => {
    const res = await run('/careers-cards.html', {
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
    expect(res.listings.map((l) => l.title)).toEqual([
      'Senior AI Engineer',
      'Backend Engineer (Python)',
      'Platform Engineer',
      'Product Designer',
      'Founding Product Manager',
      'Data Analyst',
    ]);
    expect(res.listings[0]).toEqual({
      title: 'Senior AI Engineer',
      url: site.url('/careers/jobs/101-senior-ai-engineer'),
      location: 'Remote, Europe',
      team: 'Engineering',
    });
    // The title's own link, even when it leads to the ATS.
    expect(res.listings[4]?.url).toBe('https://lumen.recruitee.com/o/founding-product-manager');
    expect(
      checkInvariants({
        listings: res.listings,
        pageUrl: site.url('/careers-cards.html'),
        lastCount: null,
      }),
    ).toEqual([]);
  });

  it('follows "next" until there is none', async () => {
    const recipe: ListingRecipe = {
      kind: 'locators',
      list: { css: 'table.jobs' },
      item: { role: 'row', name: null },
      fields: {
        title: { role: 'link', name: null },
        url: null,
        location: { css: '.where' },
        team: null,
      },
      pagination: { next: { role: 'link', name: 'Next page' } },
    };
    const res = await run('/careers-paged.html', recipe);
    expect(res.pages).toBe(2);
    expect(res.stop).toBe('no next page');
    expect(res.firstPage.map((l) => l.title)).toEqual([
      'Founding Engineer',
      'Staff Backend Engineer',
      'Engineering Manager',
    ]);
    expect(res.listings.map((l) => l.title).slice(3)).toEqual([
      'Machine Learning Engineer',
      'Developer Advocate',
    ]);
    // Without pagination (a fixture replay): the first page only.
    expect((await run('/careers-paged.html', recipe, false)).listings).toHaveLength(3);
  });

  it('waits for a list that turns its page in place, and stops at a disabled "next"', async () => {
    const res = await run('/careers-spa-paged.html', {
      kind: 'locators',
      list: { role: 'list', name: 'Open roles' },
      item: { role: 'listitem', name: null },
      fields: { title: { role: 'link', name: null }, url: null, location: null, team: null },
      pagination: { next: { role: 'button', name: 'next page' } },
    });
    expect(res.listings.map((l) => l.title)).toEqual([
      'Data Engineer',
      'Platform Engineer',
      'QA Engineer',
      'Backend Engineer',
      'Frontend Engineer',
      'SRE',
      'ML Engineer',
      'Product Manager',
      'Designer',
    ]);
    expect(res.pages).toBe(3);
    expect(res.stop).toBe('next page disabled');
  });

  it(`stops scrolling after ${EMPTY_SCROLLS_TO_STOP} scrolls in a row that add nothing`, async () => {
    const res = await run('/careers-scroll.html', {
      kind: 'locators',
      list: { role: 'feed', name: 'Jobs' },
      item: { role: 'article', name: null },
      fields: {
        title: { role: 'link', name: null },
        url: null,
        location: { css: '.loc' },
        team: null,
      },
      pagination: { scroll: true },
    });
    expect(res.firstPage).toHaveLength(5);
    expect(res.listings).toHaveLength(15);
    // Two scrolls that loaded more, then three that didn't.
    expect(res.scrolls).toBe(2 + EMPTY_SCROLLS_TO_STOP);
    expect(res.stop).toBe(`${EMPTY_SCROLLS_TO_STOP} scrolls in a row added nothing`);
  });

  it('runs a text pattern over the linked text', async () => {
    const res = await run('/careers-text.html', {
      kind: 'textPattern',
      pattern: '^(.+?) — (.+?) — details <(\\S+)>$',
      flags: 'm',
      groups: { title: 1, url: 3, location: 2 },
    });
    expect(res.listings).toEqual([
      { title: 'Backend Engineer', url: site.url('/jobs/k1'), location: 'Berlin', team: null },
      { title: 'Frontend Engineer', url: site.url('/jobs/k2'), location: 'Remote', team: null },
      { title: 'ML Engineer', url: site.url('/jobs/k3'), location: 'Athens', team: null },
    ]);
  });
});
