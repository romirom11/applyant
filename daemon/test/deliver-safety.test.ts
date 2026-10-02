// Delivery never submits twice and never records "applied" on a guess:
//   - text that was on the page before the press is not a confirmation;
//   - a press that shows neither a confirmation nor an error hands off, once, and is not
//     pressed again by the step agent or by a restart;
//   - a "final" control that leads to another form is not a confirmation;
//   - a delivery interrupted after the press (the marker is set) hands off instead of re-sending;
//   - only the candidate's explicit retry submits again.
import { eq } from 'drizzle-orm';
import { type Browser, chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AFTER_SUBMIT } from '../src/browser/form-deliver.ts';
import { newConfirmation } from '../src/browser/form-engine.ts';
import { signatureHasControls, signatureOf } from '../src/browser/snapshot.ts';
import { applications, postings, tasks } from '../src/db/schema.ts';
import { catchUpDeliveries, deliverApplication } from '../src/domain/applications/deliver.ts';
import { approveApplication, submitApplication } from '../src/domain/applications/review.ts';
import {
  ApplicationError,
  applicationView,
  ensureApplication,
  formReadFor,
  requestPrepare,
} from '../src/domain/applications/store.ts';
import { EventBus } from '../src/queue/events.ts';
import { runInTx } from '../src/queue/tx.ts';
import type { HandlerContext } from '../src/queue/types.ts';
import {
  cvFile,
  type PrepareHarness,
  prepareHarness,
  SYNTHETIC_PROFILE,
  seedPosting,
  setProfile,
} from './helpers/applications.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { FIXTURE_MEANINGS } from './helpers/fake-jev.ts';
import { runRead } from './helpers/form-read.ts';
import { type SiteServer, startSiteServer } from './helpers/site-server.ts';

vi.setConfig({ testTimeout: 120_000 });

const now = new Date('2026-09-30T10:00:00Z');

describe('what counts as a confirmation', () => {
  it('only wording that appeared after the press', () => {
    const intro = 'Apply to Quiet Co. Thank you for your interest in Quiet Co.';
    expect(newConfirmation(intro, intro)).toBe(false);
    expect(newConfirmation(intro, `${intro} Please fix the errors below.`)).toBe(false);
    expect(newConfirmation(intro, 'Your application has been received.')).toBe(true);
    expect(newConfirmation('Bewerbung', 'Vielen Dank für Ihre Bewerbung!')).toBe(true);
    expect(newConfirmation(null, null)).toBe(false);
  });

  it('a frame URL with a fragment does not read as "no controls"', () => {
    expect(signatureHasControls(signatureOf('https://x.test/apply#step-2', 'input:name'))).toBe(
      true,
    );
    expect(signatureHasControls(signatureOf('https://x.test/apply#step-2', ''))).toBe(false);
    expect(signatureHasControls('')).toBe(false);
  });
});

describe('delivery that may already have sent', () => {
  let site: SiteServer;
  let browser: Browser;
  const closers: Array<() => Promise<void>> = [];
  let t: TempDb;
  let h: PrepareHarness;
  let agentRuns = 0;

  beforeAll(async () => {
    site = await startSiteServer();
    browser = await chromium.launch({ headless: true });
  });
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    site.writes.length = 0;
    await h.stop();
    t.cleanup();
  });
  afterAll(async () => {
    await browser?.close();
    await site?.close();
  });

  async function deliver(path: string): Promise<number> {
    t = tempDb();
    agentRuns = 0;
    h = await prepareHarness(t, {
      formAgent: async (req) => {
        agentRuns++;
        return {
          kind: 'ok',
          output: { done: false, note: 'left alone' },
          model: req.model,
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        };
      },
    });
    const run = await runRead(browser, site.url(path), { jev: { meanings: FIXTURE_MEANINGS } });
    closers.push(run.close);
    setProfile(t.db, { ...SYNTHETIC_PROFILE, base_cv_file: cvFile(t.dir) }, now);
    const postingId = seedPosting(t.db, run.read, { now, stage: 'verified' });
    const id = runInTx(
      t.db,
      h.bus,
      { now },
      (tx) => ensureApplication(tx, postingId, 'test').app.id,
    );
    await h.worker.idle();
    expect(applicationView(t.db, id).blockers).toEqual([]);
    runInTx(t.db, h.bus, { now }, (tx) => approveApplication(tx, id));
    await h.worker.idle();
    return id;
  }

  const presses = () => site.writes.filter((w) => w.path === '/attempt').length;

  it('a silent page is a hand-off, pressed once, and a restart leaves it alone', async () => {
    const id = await deliver('/form-deliver-silent.html');
    const view = applicationView(t.db, id);
    // "Thank you for your interest" was there before the press: not a confirmation.
    expect(view.app.stage).toBe('approved');
    expect(view.receipt).toBeNull();
    expect(view.app.submitAttemptedAt).toBeTruthy();
    expect(view.handOff?.reason).toContain(AFTER_SUBMIT.trim());
    expect(view.handOff?.reason).toMatch(/neither a confirmation nor an error/);
    // Nobody pressed a second time: not the engine, not the step agent.
    expect(presses()).toBe(1);
    expect(agentRuns).toBe(0);

    // A daemon restart: the hand-off stays with the candidate.
    expect(runInTx(t.db, h.bus, { now }, (tx) => catchUpDeliveries(tx))).toBe(0);
    await h.worker.idle();
    expect(presses()).toBe(1);

    // Only the candidate's own retry submits again.
    runInTx(t.db, h.bus, { now }, (tx) => submitApplication(tx, id));
    await h.worker.idle();
    expect(presses()).toBe(2);
  });

  it('a "final" control that leads to another form is not a confirmation', async () => {
    const id = await deliver('/form-deliver-signin.html');
    const view = applicationView(t.db, id);
    expect(view.app.stage).toBe('approved');
    expect(view.receipt).toBeNull();
    expect(view.handOff?.reason).toContain(AFTER_SUBMIT.trim());
    expect(presses()).toBe(1);
  });
});

describe('a delivery interrupted after submit was pressed', () => {
  let t: TempDb;
  let bus: EventBus;

  afterEach(() => t.cleanup());

  function addApp(values: Partial<typeof applications.$inferInsert>) {
    const posting = t.db
      .insert(postings)
      .values({ stage: 'scored', canonicalUrl: `https://jobs.example.com/${Math.random()}` })
      .returning()
      .get();
    return t.db
      .insert(applications)
      .values({ postingId: posting.id, stage: 'approved', ...values })
      .returning()
      .get();
  }

  it('hands off without touching a channel', async () => {
    t = tempDb();
    bus = new EventBus();
    const app = addApp({ submitAttemptedAt: new Date('2026-09-30T09:58:00Z') });
    const outcome = await deliverApplication(
      {
        id: 1,
        kind: 'deliver_application',
        entityId: app.id,
        runId: null,
        provider: null,
        attempts: 0,
      },
      {
        // No channels at all: reaching for one would throw.
        deps: {} as HandlerContext['deps'],
        read: t.db,
        signal: new AbortController().signal,
        progress: () => {},
        record: () => true,
        now: () => now,
      },
    );
    expect(outcome.kind).toBe('needs_candidate');
    if (outcome.kind !== 'needs_candidate') return;
    expect(outcome.handOff.reason).toMatch(/pressed submit at 2026-09-30 09:58 UTC/);
    expect(outcome.handOff.reason).toMatch(/may already be sent/);
  });

  it('a restart re-delivers only what has no hand-off, and a new approval clears the marker', () => {
    t = tempDb();
    bus = new EventBus();
    const waiting = addApp({});
    const handedOff = addApp({});
    t.db
      .insert(tasks)
      .values({ kind: 'deliver_application', entityId: handedOff.id, status: 'needs_candidate' })
      .run();
    expect(runInTx(t.db, bus, { now }, (tx) => catchUpDeliveries(tx))).toBe(1);
    const queued = t.db
      .select()
      .from(tasks)
      .where(eq(tasks.status, 'queued'))
      .all()
      .map((r) => r.entityId);
    expect(queued).toEqual([waiting.id]);
    // Deliveries don't wait on a model provider's limit.
    expect(t.db.select().from(tasks).where(eq(tasks.status, 'queued')).get()?.provider).toBeNull();

    const retried = addApp({ submitAttemptedAt: now });
    runInTx(t.db, bus, { now }, (tx) => submitApplication(tx, retried.id));
    expect(
      t.db.select().from(applications).where(eq(applications.id, retried.id)).get()
        ?.submitAttemptedAt,
    ).toBeNull();
  });

  it('a sent application is never prepared again', () => {
    t = tempDb();
    bus = new EventBus();
    for (const stage of ['applied', 'interview', 'offer', 'rejected', 'withdrawn'] as const) {
      const app = addApp({ stage });
      runInTx(t.db, bus, { now }, (tx) => formReadFor(tx, app.postingId));
      expect(t.db.select().from(applications).where(eq(applications.id, app.id)).get()?.stage).toBe(
        stage,
      );
      expect(() =>
        runInTx(t.db, bus, { now }, (tx) => requestPrepare(tx, app, { rewrite: false, why: 'x' })),
      ).toThrow(ApplicationError);
    }
    expect(t.db.select().from(tasks).all()).toEqual([]);
  });
});
