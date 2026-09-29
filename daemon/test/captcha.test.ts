// Captchas (phase 14): each captcha type's fixture page is read for its type and site key, a
// fake solver answers, and the token lands where the site reads it with the widget's callback
// called. The CapMonster client runs against a local fake of its createTask / getTaskResult API
// (never the real one), and one whole delivery goes through it: filled → solved → submitted.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { captchaStep, findCaptcha } from '../src/browser/captcha.ts';
import { approveApplication } from '../src/domain/applications/review.ts';
import { applicationView, ensureApplication } from '../src/domain/applications/store.ts';
import {
  CapMonster,
  type CaptchaChallenge,
  CaptchaSolveError,
  type CaptchaSolver,
  capmonsterTask,
} from '../src/integrations/capmonster.ts';
import { runInTx } from '../src/queue/tx.ts';
import { FileSecrets } from '../src/secrets/file-backend.ts';
import {
  cvFile,
  type PrepareHarness,
  prepareHarness,
  SYNTHETIC_PROFILE,
  seedPosting,
  setProfile,
} from './helpers/applications.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { runRead } from './helpers/form-read.ts';
import { type SiteServer, startSiteServer } from './helpers/site-server.ts';

vi.setConfig({ testTimeout: 120_000 });

/** A local stand-in for api.capmonster.cloud: records every request, solves on the 2nd poll. */
interface FakeCapMonster {
  url: string;
  requests: Array<{ path: string; body: Record<string, unknown> }>;
  /** What createTask answers (an error reply to test failures). */
  createReply: Record<string, unknown>;
  close(): Promise<void>;
}

async function fakeCapMonster(solution: Record<string, unknown>): Promise<FakeCapMonster> {
  const polls = new Map<number, number>();
  const fake: FakeCapMonster = {
    url: '',
    requests: [],
    createReply: { errorId: 0, taskId: 7001 },
    close: async () => {},
  };
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      const path = new URL(req.url ?? '/', 'http://x').pathname.slice(1);
      fake.requests.push({ path, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (body.clientKey !== 'test-capmonster-key') {
        res.end(JSON.stringify({ errorId: 1, errorCode: 'ERROR_KEY_DOES_NOT_EXIST' }));
        return;
      }
      if (path === 'createTask') {
        res.end(JSON.stringify(fake.createReply));
        return;
      }
      const id = Number(body.taskId);
      const n = (polls.get(id) ?? 0) + 1;
      polls.set(id, n);
      res.end(
        JSON.stringify(
          n < 2 ? { errorId: 0, status: 'processing' } : { errorId: 0, status: 'ready', solution },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise((resolve) => server.close(() => resolve()));
  return fake;
}

/** A solver that answers a fixed token and remembers what it was asked. */
function fakeSolver(token = 'solved-token-123'): CaptchaSolver & { asked: CaptchaChallenge[] } {
  const asked: CaptchaChallenge[] = [];
  return {
    asked,
    async solve(c) {
      asked.push(c);
      return token;
    },
  };
}

describe('CapMonster tasks', () => {
  const base = { sitekey: 'KEY', pageUrl: 'https://jobs.example.test/apply' };
  it('builds the proxyless task for each captcha type', () => {
    expect(capmonsterTask({ ...base, type: 'recaptcha_v2', invisible: true })).toEqual({
      type: 'RecaptchaV2Task',
      websiteURL: base.pageUrl,
      websiteKey: 'KEY',
      isInvisible: true,
    });
    expect(capmonsterTask({ ...base, type: 'recaptcha_v3', action: 'submit' })).toMatchObject({
      type: 'RecaptchaV3TaskProxyless',
      minScore: 0.7,
      pageAction: 'submit',
    });
    expect(capmonsterTask({ ...base, type: 'recaptcha_v2_enterprise', data: 's' })).toMatchObject({
      type: 'RecaptchaV2EnterpriseTask',
      enterprisePayload: { s: 's' },
    });
    expect(capmonsterTask({ ...base, type: 'recaptcha_v3_enterprise' }).type).toBe(
      'RecaptchaV3EnterpriseTask',
    );
    expect(capmonsterTask({ ...base, type: 'hcaptcha' }).type).toBe('HCaptchaTask');
    expect(
      capmonsterTask({ ...base, type: 'turnstile', action: 'apply', data: 'cdata' }),
    ).toMatchObject({ type: 'TurnstileTask', pageAction: 'apply', data: 'cdata' });
  });
});

describe('the CapMonster client (local fake API)', () => {
  let fake: FakeCapMonster;
  let t: TempDb;
  afterEach(async () => {
    await fake?.close();
    t?.cleanup();
  });

  it('creates a task, polls until ready and returns the token', async () => {
    t = tempDb();
    fake = await fakeCapMonster({ token: 'turnstile-token' });
    const secrets = new FileSecrets(join(t.dir, 's.json'));
    const cm = new CapMonster({ secrets, url: fake.url, firstPollMs: 5, pollMs: 5 });
    expect(await cm.configured()).toBe(false);
    // No key: nothing is sent at all.
    await expect(
      cm.solve({ type: 'turnstile', sitekey: 'k', pageUrl: 'https://a.test/' }),
    ).rejects.toMatchObject({ code: 'NO_KEY' });
    expect(fake.requests).toEqual([]);

    await secrets.set('capmonster', 'test-capmonster-key');
    expect(await cm.configured()).toBe(true);
    const token = await cm.solve({ type: 'turnstile', sitekey: 'k', pageUrl: 'https://a.test/' });
    expect(token).toBe('turnstile-token');
    expect(fake.requests.map((r) => r.path)).toEqual([
      'createTask',
      'getTaskResult',
      'getTaskResult',
    ]);
    expect(fake.requests[0]?.body.task).toEqual({
      type: 'TurnstileTask',
      websiteURL: 'https://a.test/',
      websiteKey: 'k',
    });
    expect(fake.requests[1]?.body.taskId).toBe(7001);
  });

  it('reports CapMonster errors (wrong key, unsolvable) as CaptchaSolveError', async () => {
    t = tempDb();
    fake = await fakeCapMonster({ gRecaptchaResponse: 'x' });
    const secrets = new FileSecrets(join(t.dir, 's.json'));
    await secrets.set('capmonster', 'wrong-key');
    const cm = new CapMonster({ secrets, url: fake.url, firstPollMs: 5, pollMs: 5 });
    const c: CaptchaChallenge = { type: 'recaptcha_v2', sitekey: 'k', pageUrl: 'https://a.test/' };
    await expect(cm.solve(c)).rejects.toThrow(/ERROR_KEY_DOES_NOT_EXIST/);
    await secrets.set('capmonster', 'test-capmonster-key');
    fake.createReply = { errorId: 1, errorCode: 'ERROR_ZERO_BALANCE' };
    const err = await cm.solve(c).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptchaSolveError);
    expect((err as CaptchaSolveError).code).toBe('ERROR_ZERO_BALANCE');
  });
});

describe('captcha fixture pages → fake solver → token injected', () => {
  let site: SiteServer;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    site = await startSiteServer();
    browser = await chromium.launch({ headless: true });
  });
  afterEach(async () => {
    await context?.close();
  });
  afterAll(async () => {
    await browser?.close();
    await site?.close();
  });

  async function open(path: string): Promise<Page> {
    context = await browser.newContext();
    // Vendor URLs are answered locally: the suite is offline.
    await context.route('https://www.google.com/recaptcha/**', (route) => {
      const url = route.request().url();
      if (/api\.js/.test(url)) {
        return route.fulfill({
          contentType: 'text/javascript',
          body: 'window.grecaptcha = { ready: function (f) { f(); }, execute: function () { return Promise.resolve("page-token"); } };',
        });
      }
      if (/enterprise\.js/.test(url)) {
        return route.fulfill({ contentType: 'text/javascript', body: '/* enterprise */' });
      }
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><p>anchor</p>' });
    });
    page = await context.newPage();
    await page.goto(site.url(path));
    return page;
  }

  const responseOf = (p: Page, name: string) =>
    p.evaluate(
      (n) => (document.querySelector(`[name="${n}"]`) as HTMLInputElement | null)?.value,
      name,
    );
  const callbackOf = (p: Page) =>
    p.evaluate(() => (window as unknown as { __callback?: string }).__callback ?? null);

  it('reCAPTCHA v2: g-recaptcha-response filled, data-callback called', async () => {
    const p = await open('/captcha-recaptcha-v2.html');
    const solver = fakeSolver();
    const step = await captchaStep(p, solver);
    expect(step).toEqual({ kind: 'solved', type: 'recaptcha_v2' });
    expect(solver.asked[0]).toMatchObject({
      type: 'recaptcha_v2',
      sitekey: '6LfTestV2SiteKey000000000000000000000000',
      pageUrl: site.url('/captcha-recaptcha-v2.html'),
      invisible: false,
    });
    expect(await responseOf(p, 'g-recaptcha-response')).toBe('solved-token-123');
    expect(await callbackOf(p)).toBe('solved-token-123');
    await expect(p.locator('#go').isEnabled()).resolves.toBe(true);
  });

  it('hCaptcha: h-captcha-response created and filled, dotted callback called', async () => {
    const p = await open('/captcha-hcaptcha.html');
    const solver = fakeSolver('hc-token');
    expect(await captchaStep(p, solver)).toEqual({ kind: 'solved', type: 'hcaptcha' });
    expect(solver.asked[0]).toMatchObject({
      type: 'hcaptcha',
      sitekey: '10000000-ffff-ffff-ffff-000000000001',
      invisible: true,
    });
    expect(await responseOf(p, 'h-captcha-response')).toBe('hc-token');
    expect(await responseOf(p, 'g-recaptcha-response')).toBe('hc-token');
    expect(await callbackOf(p)).toBe('hc-token');
  });

  it('Turnstile: cf-turnstile-response filled, action and cData passed to the solver', async () => {
    const p = await open('/captcha-turnstile.html');
    const solver = fakeSolver('ts-token');
    expect(await captchaStep(p, solver)).toEqual({ kind: 'solved', type: 'turnstile' });
    expect(solver.asked[0]).toMatchObject({
      type: 'turnstile',
      sitekey: '0x4AAAAAAATestTurnstileKey',
      action: 'apply',
      data: 'job-42',
    });
    expect(await responseOf(p, 'cf-turnstile-response')).toBe('ts-token');
    expect(await callbackOf(p)).toBe('ts-token');
  });

  it('reCAPTCHA v3: found by its script, and grecaptcha.execute answers the solved token', async () => {
    const p = await open('/captcha-recaptcha-v3.html');
    const found = await findCaptcha(p);
    expect(found).toMatchObject({
      type: 'recaptcha_v3',
      sitekey: '6LfTestV3SiteKey000000000000000000000000',
    });
    // Without a solver, v3 has nothing to hand over: delivery submits as before.
    expect(await captchaStep(p, null)).toEqual({ kind: 'none' });
    expect(await captchaStep(p, fakeSolver('v3-token'))).toEqual({
      kind: 'solved',
      type: 'recaptcha_v3',
    });
    await p.locator('#go').click();
    await expect.poll(() => p.locator('#token').inputValue()).toBe('v3-token');
  });

  it('reCAPTCHA Enterprise: key from the anchor iframe, callback from ___grecaptcha_cfg', async () => {
    const p = await open('/captcha-recaptcha-enterprise.html');
    const solver = fakeSolver('ent-token');
    expect(await captchaStep(p, solver)).toEqual({
      kind: 'solved',
      type: 'recaptcha_v2_enterprise',
    });
    expect(solver.asked[0]).toMatchObject({
      sitekey: '6LfTestEntSiteKey00000000000000000000000',
      invisible: true,
    });
    expect(await responseOf(p, 'g-recaptcha-response')).toBe('ent-token');
    expect(await callbackOf(p)).toBe('ent-token');
  });

  it('a failed solve, or no solver, hands the filled step to the candidate', async () => {
    const p = await open('/captcha-turnstile.html');
    const failing: CaptchaSolver = {
      async solve() {
        throw new CaptchaSolveError(
          'ERROR_CAPTCHA_UNSOLVABLE',
          'CapMonster: ERROR_CAPTCHA_UNSOLVABLE',
        );
      },
    };
    const step = await captchaStep(p, failing);
    expect(step.kind).toBe('handoff');
    expect(step.kind === 'handoff' && step.reason).toMatch(
      /captcha \(turnstile\) couldn't be solved: CapMonster: ERROR_CAPTCHA_UNSOLVABLE; everything else is filled/,
    );
    expect(await responseOf(p, 'cf-turnstile-response')).toBeUndefined();
    const none = await captchaStep(p, null);
    expect(none).toEqual({
      kind: 'handoff',
      reason: 'a captcha (turnstile) is on this step; everything else is filled',
    });
  });
});

describe('delivery with a CapMonster key: solved, then submitted', () => {
  let site: SiteServer;
  let browser: Browser;
  let fake: FakeCapMonster;
  let t: TempDb;
  let h: PrepareHarness;
  const closers: Array<() => Promise<void>> = [];
  const now = new Date('2026-09-29T10:00:00Z');

  beforeAll(async () => {
    site = await startSiteServer();
    browser = await chromium.launch({ headless: true });
  });
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    await h?.stop();
    await fake?.close();
    t?.cleanup();
  });
  afterAll(async () => {
    await browser?.close();
    await site?.close();
  });

  it('fills the form, solves the Turnstile through CapMonster and submits', async () => {
    t = tempDb();
    fake = await fakeCapMonster({ token: 'cm-turnstile-token' });
    const secrets = new FileSecrets(join(t.dir, 'secrets.json'));
    await secrets.set('capmonster', 'test-capmonster-key');
    const captcha = new CapMonster({ secrets, url: fake.url, firstPollMs: 5, pollMs: 5 });
    h = await prepareHarness(t, {}, { deps: { captcha, secrets } });

    const run = await runRead(browser, site.url('/form-deliver-turnstile.html'));
    closers.push(run.close);
    setProfile(t.db, { ...SYNTHETIC_PROFILE, base_cv_file: cvFile(t.dir) }, now);
    const postingId = seedPosting(t.db, run.read, { now, stage: 'verified' });
    const id = runInTx(t.db, h.bus, { now }, (tx) => ensureApplication(tx, postingId, 't').app.id);
    await h.worker.idle();
    expect(applicationView(t.db, id).blockers).toEqual([]);
    runInTx(t.db, h.bus, { now }, (tx) => approveApplication(tx, id));
    await h.worker.idle();

    const view = applicationView(t.db, id);
    expect(view.handOff).toBeNull();
    expect(view.app.stage).toBe('applied');
    expect(view.receipt?.confirmationText).toMatch(/application was received/);
    const create = fake.requests.find((r) => r.path === 'createTask');
    expect(create?.body.task).toEqual({
      type: 'TurnstileTask',
      websiteURL: site.url('/form-deliver-turnstile.html'),
      websiteKey: '0x4AAAAAAATestTurnstileKey',
    });
  });
});
