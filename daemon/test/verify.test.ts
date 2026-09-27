import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReaderPool } from '../src/browser/reader-pool.ts';
import { postings, tasks } from '../src/db/schema.ts';
import { canonicalUrl } from '../src/domain/search/canonical-url.ts';
import { addPosting } from '../src/domain/search/postings.ts';
import {
  checkPosting,
  closedMarker,
  findJobPosting,
  redirectedUp,
  verifyPosting,
} from '../src/domain/search/verify.ts';
import { EventBus } from '../src/queue/events.ts';
import { Worker } from '../src/queue/worker.ts';
import { createLogger } from '../src/util/log.ts';
import { tempDb } from './helpers/db.ts';
import { handlers, testDeps } from './helpers/deps.ts';
import { type SiteServer, startSiteServer } from './helpers/site-server.ts';

const quiet = createLogger({ test: 'verify' });
const log = { ...quiet, info() {}, child: () => log };

let site: SiteServer;
let reader: ReaderPool;

beforeAll(async () => {
  site = await startSiteServer();
  reader = new ReaderPool({ maxContexts: 3, navigationTimeoutMs: 15_000, log });
});

afterAll(async () => {
  await reader?.close();
  await site?.close();
});

describe('checkPosting on fixture pages', () => {
  const check = (path: string) => checkPosting(reader, site.url(path));

  it('live posting with an application form on the page', async () => {
    const verdict = await check('/live.html');
    expect(verdict).toEqual({
      kind: 'live',
      note: 'apply form on page',
      title: 'Senior AI Engineer',
      company: 'Acme AI',
      text: expect.any(String),
      jsonLd: expect.objectContaining({ '@type': 'JobPosting', title: 'Senior AI Engineer' }),
    });
    // The readable text is kept for the extractor, JSON-LD structured fields first.
    const text = verdict.kind === 'live' ? (verdict.text ?? '') : '';
    expect(text).toMatch(
      /^# Senior AI Engineer\nPage header \(labels shown around the title\): Senior AI Engineer \| .*\nStructured data \(JobPosting\):\n/,
    );
    expect(text).toContain('\njobLocationType: TELECOMMUTE\n');
    expect(text).toContain('You will build production LLM systems with Python and TypeScript.');
  });

  it('404', async () => {
    expect(await check('/gone.html')).toMatchObject({ kind: 'dead', note: 'HTTP 404' });
  });

  it('503 is transient, not dead', async () => {
    expect(await check('/flaky')).toEqual({ kind: 'transient', note: 'HTTP 503' });
  });

  it('closed JSON-LD: validThrough in the past', async () => {
    expect(await check('/closed-jsonld.html')).toMatchObject({
      kind: 'dead',
      note: 'JobPosting validThrough 2020-01-31 has passed',
      title: 'Staff Engineer',
      company: 'Acme AI',
    });
  });

  it('apply link that leads to the company homepage', async () => {
    const verdict = await check('/homepage-apply.html');
    expect(verdict.kind).toBe('dead');
    expect(verdict.note).toBe(`apply link leads to the homepage ${site.origin}/`);
  });

  it('apply link that redirects to the homepage', async () => {
    const verdict = await check('/apply-redirect-home.html');
    expect(verdict).toMatchObject({ kind: 'dead' });
    expect(verdict.note).toBe(`apply link redirects to the homepage ${site.origin}/`);
  });

  it('posting page that redirects to the homepage', async () => {
    const verdict = await check('/redirect-home');
    expect(verdict).toMatchObject({ kind: 'dead' });
    expect(verdict.note).toBe(`redirected to the homepage ${site.origin}/`);
  });

  it('posting page that redirects up to its board (Greenhouse-style ?error=true)', async () => {
    const verdict = await check('/jobs/42');
    expect(verdict).toMatchObject({ kind: 'dead' });
    expect(verdict.note).toBe(`redirected to ${site.origin}/jobs?error=true`);
  });

  it('apply link to a separate application form', async () => {
    expect(await check('/apply-link.html')).toMatchObject({
      kind: 'live',
      note: `apply form at ${site.origin}/form.html`,
    });
  });

  it('closed text on the page wins over an apply link', async () => {
    expect(await check('/closed-text.html')).toMatchObject({
      kind: 'dead',
      note: 'page says "no longer accepting applications"',
    });
  });

  it('no apply path at all', async () => {
    expect(await check('/no-apply.html')).toMatchObject({
      kind: 'dead',
      note: 'no apply link or form found',
    });
  });

  it('apply by email', async () => {
    expect(await check('/mailto.html')).toMatchObject({
      kind: 'live',
      note: 'apply by email to jobs@acme.test',
    });
  });

  it('application form in a cross-origin iframe', async () => {
    expect(await check('/iframe.html')).toMatchObject({
      kind: 'live',
      note: `apply form in frame ${site.altOrigin}/form.html`,
    });
  });

  it('client-rendered form', async () => {
    expect(await check('/spa.html')).toMatchObject({ kind: 'live', note: 'apply form on page' });
  });

  it('a job list is not a posting', async () => {
    expect(await check('/job-list.html')).toMatchObject({
      kind: 'dead',
      note: 'looks like a list of jobs (4 apply links), not one posting',
    });
  });
});

describe('verify_posting through the queue', () => {
  it('moves postings to verified / failed_verification and retries transient failures', async () => {
    const t = tempDb();
    const bus = new EventBus();
    const now = new Date();
    const worker = new Worker({
      db: t.db,
      read: t.read,
      bus,
      handlers: handlers({
        verify_posting: verifyPosting,
        score_posting: async () => ({ kind: 'done', commit: () => {} }),
      }),
      deps: testDeps({ dir: t.dir, reader }),
      log,
      concurrency: 3,
      leaseMs: 60_000,
      pollMs: 20,
      maxAttempts: 5,
    });
    try {
      const add = (path: string) =>
        addPosting(t.db, bus, { url: site.url(path), sourceKind: 'manual', now }).posting.id;
      const live = add('/live.html');
      const gone = add('/gone.html');
      const flaky = add('/flaky');
      worker.start();
      await worker.idle();

      const row = (id: number) => t.db.select().from(postings).where(eq(postings.id, id)).get();
      expect(row(live)).toMatchObject({
        stage: 'verified',
        verifyNote: 'apply form on page',
        title: 'Senior AI Engineer',
        company: 'Acme AI',
      });
      expect(row(live)?.verifiedAt).toBeInstanceOf(Date);
      expect(row(live)?.text).toContain('production LLM systems');
      // A verified posting moves on to scoring; a failed one doesn't.
      const scoring = t.db.select().from(tasks).where(eq(tasks.kind, 'score_posting')).all();
      expect(scoring.map((task) => task.entityId)).toEqual([live]);
      expect(row(gone)).toMatchObject({ stage: 'failed_verification', verifyNote: 'HTTP 404' });
      expect(row(flaky)?.stage).toBe('found');
      const flakyTask = t.db.select().from(tasks).where(eq(tasks.entityId, flaky)).get();
      expect(flakyTask).toMatchObject({ status: 'queued', attempts: 1, note: 'HTTP 503' });
      expect(flakyTask?.runAfter.getTime()).toBeGreaterThan(Date.now() + 30_000);
    } finally {
      await worker.stop();
      t.cleanup();
    }
  });
});

describe('verification helpers', () => {
  it('finds JobPosting inside @graph and arrays', () => {
    const graph = JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebPage', name: 'x' },
        {
          '@type': ['JobPosting'],
          title: 'AI Engineer',
          hiringOrganization: 'Orbit',
          validThrough: '2027-01-01',
        },
      ],
    });
    expect(findJobPosting(['not json', graph])).toEqual({
      title: 'AI Engineer',
      company: 'Orbit',
      validThrough: '2027-01-01',
    });
    expect(findJobPosting(['[{"@type":"Organization"}]'])).toBeNull();
  });

  it('recognises redirects up the path', () => {
    expect(redirectedUp('https://a.io/acme/jobs/1', 'https://b.io/acme?error=true')).toBe(true);
    expect(redirectedUp('https://a.io/acme/jobs/1', 'https://a.io/')).toBe(true);
    expect(redirectedUp('https://a.io/acme/jobs/1', 'https://a.io/acme/jobs/1/apply')).toBe(false);
    expect(redirectedUp('https://a.io/acme/jobs/1', 'https://b.io/acme/jobs/1')).toBe(false);
    expect(redirectedUp('https://a.io/', 'https://a.io/')).toBe(false);
  });

  it('matches closed-posting phrases regardless of case and spacing', () => {
    expect(closedMarker('Sorry!\nThis   Position Has Been\nFilled.')).toBe(
      'position has been filled',
    );
    expect(closedMarker('We are accepting applications')).toBeNull();
  });

  it('canonicalises URLs for dedupe', () => {
    expect(
      canonicalUrl('https://Jobs.Example.com/acme/123/?utm_source=li&gh_jid=9&ref=x#apply'),
    ).toBe('https://jobs.example.com/acme/123?gh_jid=9');
    expect(canonicalUrl('https://example.com')).toBe('https://example.com/');
    expect(() => canonicalUrl('ftp://example.com/x')).toThrow(/http/);
    expect(() => canonicalUrl('not a url')).toThrow(/not a URL/);
  });
});
