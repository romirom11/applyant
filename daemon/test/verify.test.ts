import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReaderPool } from '../src/browser/reader-pool.ts';
import { agentRuns, postings, tasks } from '../src/db/schema.ts';
import { canonicalUrl } from '../src/domain/search/canonical-url.ts';
import { addPosting } from '../src/domain/search/postings.ts';
import {
  checkPosting,
  closedMarker,
  findJobPosting,
  redirectedUp,
  verifyPosting,
} from '../src/domain/search/verify.ts';
import { FakeProvider } from '../src/models/providers/fake.ts';
import type { JevRequest, JevResponse } from '../src/models/providers/jev.ts';
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
      applyUrl: site.url('/live.html'),
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
      applyUrl: `${site.origin}/form.html`,
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
      applyUrl: expect.stringMatching(/^mailto:jobs@acme\.test/),
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
        read_form: async () => ({ kind: 'done', commit: () => {} }),
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
      // A verified posting moves on to scoring and to reading its form; a failed one doesn't.
      const scoring = t.db.select().from(tasks).where(eq(tasks.kind, 'score_posting')).all();
      expect(scoring.map((task) => task.entityId)).toEqual([live]);
      const reading = t.db.select().from(tasks).where(eq(tasks.kind, 'read_form')).all();
      expect(reading.map((task) => task.entityId)).toEqual([live]);
      expect(row(live)?.applyUrl).toBe(site.url('/live.html'));
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

  it('re-verifying a live posting (a search source stopped listing it) keeps it, or closes it', async () => {
    const t = tempDb();
    const bus = new EventBus();
    const now = new Date();
    const worker = new Worker({
      db: t.db,
      read: t.read,
      bus,
      handlers: handlers({ verify_posting: verifyPosting }),
      deps: testDeps({ dir: t.dir, reader }),
      log,
      concurrency: 2,
      leaseMs: 60_000,
      pollMs: 20,
      maxAttempts: 5,
    });
    try {
      const scored = (path: string) => {
        const id = addPosting(t.db, bus, { url: site.url(path), sourceKind: 'manual', now }).posting
          .id;
        t.db
          .update(postings)
          .set({ stage: 'scored', score: 88, verifiedAt: new Date(0) })
          .where(eq(postings.id, id))
          .run();
        return id;
      };
      const live = scored('/live.html');
      const gone = scored('/gone.html');
      worker.start();
      await worker.idle();
      const row = (id: number) => t.db.select().from(postings).where(eq(postings.id, id)).get();
      expect(row(live)).toMatchObject({
        stage: 'scored',
        score: 88,
        verifyNote: 'apply form on page',
      });
      expect(row(live)?.verifiedAt?.getTime()).toBeGreaterThan(0);
      expect(row(gone)).toMatchObject({ stage: 'closed', verifyNote: 'HTTP 404' });
      // Nothing downstream runs again for a posting that is still what it was.
      expect(t.db.select().from(tasks).where(eq(tasks.kind, 'score_posting')).all()).toEqual([]);
      expect(t.db.select().from(tasks).where(eq(tasks.kind, 'read_form')).all()).toEqual([]);
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

describe('posting_liveness', () => {
  const jevSaying = (choice: string, confidence: number) => ({
    requests: [] as JevRequest[],
    async available() {
      return true;
    },
    async ask(req: JevRequest): Promise<JevResponse> {
      this.requests.push(req);
      return {
        model: 'jev-1.13.0',
        answers: { liveness: { type: 'choice', choice, confidence, probabilities: {} } },
        usage: { input_tokens: 900, output_tokens: 10 },
      };
    },
  });

  async function verifyWith(
    path: string,
    jev: ReturnType<typeof jevSaying> | null,
    claude = new FakeProvider('claude'),
  ) {
    const t = tempDb();
    const bus = new EventBus();
    const worker = new Worker({
      db: t.db,
      read: t.read,
      bus,
      handlers: handlers({
        verify_posting: verifyPosting,
        score_posting: async () => ({ kind: 'done', commit: () => {} }),
        read_form: async () => ({ kind: 'done', commit: () => {} }),
      }),
      deps: testDeps({
        dir: t.dir,
        db: t.db,
        reader,
        providers: [claude],
        ...(jev ? { jev } : {}),
      }),
      log,
      concurrency: 1,
      leaseMs: 60_000,
      pollMs: 20,
      maxAttempts: 5,
    });
    try {
      const id = addPosting(t.db, bus, {
        url: site.url(path),
        sourceKind: 'manual',
        now: new Date(),
      }).posting.id;
      worker.start();
      await worker.idle();
      const posting = t.db.select().from(postings).where(eq(postings.id, id)).get();
      const kinds = t.db
        .select()
        .from(tasks)
        .all()
        .map((task) => task.kind);
      const runs = t.db.select().from(agentRuns).all();
      return { posting, kinds, runs };
    } finally {
      await worker.stop();
      t.cleanup();
    }
  }

  it('a sure "closed" from Jev fails a page the deterministic checks passed', async () => {
    const jev = jevSaying('closed', 0.93);
    const { posting, kinds, runs } = await verifyWith('/live.html', jev);
    expect(posting).toMatchObject({
      stage: 'failed_verification',
      verifyNote: 'jev: the page reads as closed (0.93)',
    });
    expect(kinds).not.toContain('read_form');
    // The question saw the page text, and the Jev run is recorded with its cost.
    const q = jev.requests[0];
    expect(JSON.stringify(q?.state)).toContain('production LLM systems');
    expect(Object.keys(q?.questions.liveness?.criteria ?? {})).toEqual([
      'open',
      'closed',
      'not_a_posting',
    ]);
    expect(runs).toEqual([
      expect.objectContaining({
        role: 'posting_liveness',
        provider: 'jev',
        inputTokens: 900,
        outcome: 'ok',
      }),
    ]);
    expect(runs[0]?.costUsd).toBeCloseTo(900 * 42e-9, 12);
  });

  it('an unsure Jev answer is re-asked of the fallback, and "open" keeps the posting', async () => {
    const claude = new FakeProvider('claude', [
      { output: { answers: [{ question: 'liveness', choice: 'open' }] } },
    ]);
    const { posting, kinds } = await verifyWith('/live.html', jevSaying('closed', 0.4), claude);
    expect(posting).toMatchObject({ stage: 'verified', verifyNote: 'apply form on page' });
    expect(kinds).toContain('read_form');
    expect(claude.requests[0]?.model).toBe('haiku');
    expect(claude.requests[0]?.prompt).toContain('[liveness]');
  });

  it('with no model to ask, the deterministic verdict stands', async () => {
    const { posting } = await verifyWith('/live.html', null);
    expect(posting).toMatchObject({ stage: 'verified', verifyNote: 'apply form on page' });
  });

  it('an email application is noted, and no form is read', async () => {
    const { posting, kinds } = await verifyWith('/mailto.html', jevSaying('open', 0.97));
    expect(posting).toMatchObject({
      stage: 'verified',
      formStatus: 'email',
      formNote: 'applies by email to jobs@acme.test',
    });
    expect(kinds).not.toContain('read_form');
  });
});
