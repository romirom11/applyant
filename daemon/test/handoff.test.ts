// Delivery hand-off: a required value missing at delivery time (the profile or a field value
// changed after approval — a real race, not a review-time gap) ends in needs_candidate, with
// the browser window left filled and restored (verified over CDP), not closed. Captcha
// detection is checked as a pure function: a live captcha iframe needs network this suite
// doesn't have.
//
// The window only means something in a real, headed browser: this file needs a real DISPLAY
// on Linux (run it under `xvfb-run -a pnpm -C daemon test`, which sets one; plain `pnpm test`
// skips it cleanly there). A Mac always has one.
import { eq } from 'drizzle-orm';
import { type Browser, type BrowserContext, chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { detectCaptcha } from '../src/browser/form-deliver.ts';
import { getWindowBounds } from '../src/browser/window.ts';
import { fieldValues } from '../src/db/schema.ts';
import { markSubmittedByHand } from '../src/domain/applications/deliver.ts';
import { approveApplication } from '../src/domain/applications/review.ts';
import { applicationView, ensureApplication } from '../src/domain/applications/store.ts';
import { runInTx } from '../src/queue/tx.ts';
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

describe('detectCaptcha', () => {
  const frame = (url: string) =>
    ({ url: () => url }) as unknown as Parameters<typeof detectCaptcha>[0];
  const page = (urls: string[]) =>
    ({ frames: () => urls.map(frame) }) as unknown as Parameters<typeof detectCaptcha>[0];

  it('recognises known captcha hosts and the recaptcha path on google.com', () => {
    expect(detectCaptcha(page(['https://example.test/']))).toBeNull();
    expect(detectCaptcha(page(['https://www.google.com/recaptcha/api2/anchor']))).toBe('recaptcha');
    expect(detectCaptcha(page(['https://newassets.hcaptcha.com/captcha/v1/frame']))).toBe(
      'newassets.hcaptcha.com',
    );
    expect(
      detectCaptcha(page(['https://example.test/', 'https://challenges.cloudflare.com/turnstile'])),
    ).toBe('challenges.cloudflare.com');
  });
});

// macOS always has a window server; Linux needs DISPLAY (xvfb-run).
const hasDisplay = process.platform === 'darwin' || Boolean(process.env.DISPLAY);

describe.skipIf(!hasDisplay)('a browser hand-off (needs a real display)', () => {
  let site: SiteServer;
  let browser: Browser;
  const closers: Array<() => Promise<void>> = [];
  let t: TempDb;
  let h: PrepareHarness;
  const now = new Date('2026-09-27T10:00:00Z');

  beforeAll(async () => {
    site = await startSiteServer();
    browser = await chromium.launch({ headless: true });
  });

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    await h.stop();
    t.cleanup();
  });

  afterAll(async () => {
    await browser?.close();
    await site?.close();
  });

  it('leaves the window open and restored when a value goes missing after approval', async () => {
    t = tempDb();
    h = await prepareHarness(
      t,
      {
        formAgent: async (req) => {
          // The slider field still needs the agent; this run has nothing to do with the hand-off.
          expect(req.prompt).toMatch(/Notice period/);
          return {
            kind: 'ok',
            output: { done: true, note: 'moved the slider' },
            model: req.model,
            usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
          };
        },
      },
      { headless: false },
    );

    const run = await runRead(browser, site.url('/form-deliver-simple.html'), {
      jev: { meanings: [...FIXTURE_MEANINGS, [/notice period/i, 'notice_period']] },
    });
    closers.push(run.close);
    setProfile(t.db, { ...SYNTHETIC_PROFILE, base_cv_file: cvFile(t.dir) }, now);
    const postingId = seedPosting(t.db, run.read, { now, stage: 'verified' });

    const id = runInTx(t.db, h.bus, { now }, (tx) => ensureApplication(tx, postingId, 't').app.id);
    await h.worker.idle();
    expect(applicationView(t.db, id).blockers).toEqual([]);
    runInTx(t.db, h.bus, { now }, (tx) => approveApplication(tx, id));

    // A race after approval: the base CV becomes unreadable (deleted, permissions, …) before
    // delivery runs. This is a real scenario, not a contrived one; it is why the value is
    // checked again at delivery time instead of trusted from review.
    const resumeRef = applicationView(t.db, id).fields.find((f) => f.label === 'Resume')?.ref;
    if (!resumeRef) throw new Error('no Resume field');
    t.db
      .update(fieldValues)
      .set({ value: null, source: 'none' })
      .where(eq(fieldValues.fieldRef, resumeRef))
      .run();

    await h.worker.idle();

    const view = applicationView(t.db, id);
    expect(view.app.stage).toBe('approved'); // the human gate stands; delivery just got stuck
    expect(view.handOff?.reason).toMatch(/Resume/);
    expect(view.handOff?.browser?.scope).toBe('field');
    expect(view.handOff?.browser?.fieldLabel).toBe('Resume');
    expect(view.handOff?.browser?.url).toContain('/form-deliver-simple.html');

    const pages = await h.submit.openPages();
    const page = pages.find((p) => p.url().includes('/form-deliver-simple.html'));
    if (!page) throw new Error(`no hand-off page left open (${pages.map((p) => p.url())})`);
    // Left filled: earlier fields (before the one that got stuck) are still there.
    await expect(page.locator('#name').inputValue()).resolves.toBe(SYNTHETIC_PROFILE.full_name);
    const bounds = await getWindowBounds(page);
    expect(bounds.windowState).not.toBe('minimized');
  });

  it('fills the step first, then hands a captcha over with the window left filled', async () => {
    t = tempDb();
    h = await prepareHarness(t, {}, { headless: false });
    // The captcha frame's google.com URL is answered locally: detection goes by the frame's URL.
    const { context } = await (
      h.submit as unknown as { ensure(): Promise<{ context: BrowserContext }> }
    ).ensure();
    await context.route('https://www.google.com/recaptcha/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><p>I am not a robot</p>' }),
    );

    const run = await runRead(browser, site.url('/form-deliver-captcha.html'));
    closers.push(run.close);
    setProfile(t.db, { ...SYNTHETIC_PROFILE, base_cv_file: cvFile(t.dir) }, now);
    const postingId = seedPosting(t.db, run.read, { now, stage: 'verified' });
    const id = runInTx(t.db, h.bus, { now }, (tx) => ensureApplication(tx, postingId, 't').app.id);
    await h.worker.idle();
    expect(applicationView(t.db, id).blockers).toEqual([]);
    runInTx(t.db, h.bus, { now }, (tx) => approveApplication(tx, id));
    await h.worker.idle();

    const view = applicationView(t.db, id);
    expect(view.app.stage).toBe('approved');
    expect(view.handOff?.browser?.scope).toBe('captcha');
    expect(view.handOff?.reason).toMatch(/captcha \(recaptcha\).*everything else is filled/);
    const pages = await h.submit.openPages();
    const page = pages.find((p) => p.url().includes('/form-deliver-captcha.html'));
    if (!page) throw new Error('no hand-off page left open');
    await expect(page.locator('#name').inputValue()).resolves.toBe(SYNTHETIC_PROFILE.full_name);
    await expect(page.locator('#email').inputValue()).resolves.toBe(SYNTHETIC_PROFILE.email);
    await expect(
      page.locator('#resume').evaluate((el) => (el as HTMLInputElement).files?.length),
    ).resolves.toBe(1);

    // The person solves the captcha and presses submit; then tells Applyant so.
    await page.locator('#submit').click();
    runInTx(t.db, h.bus, { now }, (tx) => markSubmittedByHand(tx, id));
    const done = applicationView(t.db, id);
    expect(done.app.stage).toBe('applied');
    expect(done.handOff).toBeNull();
    expect(done.receipt?.confirmationText).toMatch(/submitted by you in the browser/);
    expect(done.receipt?.fieldValues.map((f) => f.label)).toEqual(['Full Name', 'Email', 'Resume']);
    expect(done.receipt?.cvHash).toMatch(/^[0-9a-f]{64}$/);
    // Only a delivery that is waiting on the candidate can be marked.
    expect(() => runInTx(t.db, h.bus, { now }, (tx) => markSubmittedByHand(tx, id))).toThrow(
      /no delivery waiting on you/,
    );
  });
});
