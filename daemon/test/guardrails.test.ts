// LinkedIn/Xing guardrails (phase 14): one lane per platform (a second task waits for the
// first), daily caps, pacing, waiting while the candidate uses the profile, and challenges: a
// checkpoint or a captcha on the platform pauses it and goes to the candidate, never to the
// solver. Also the company's own form preferred over the platform's, and the unautomated
// sign-in window (a fake Chrome binary: no real browser, no real site, no real login).
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { type Browser, type BrowserContext, chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  Guardrails,
  PlatformCapReached,
  PlatformChallenge,
  PlatformPaused,
  platformOf,
} from '../src/browser/guardrails.ts';
import {
  findChrome,
  LoginWindow,
  LoginWindowError,
  profileActivity,
  signInArgs,
} from '../src/browser/login-window.ts';
import { SubmitProfile } from '../src/browser/submit-profile.ts';
import { events, postingSources, postings } from '../src/db/schema.ts';
import { applyTarget } from '../src/domain/applications/deliver.ts';
import { approveApplication } from '../src/domain/applications/review.ts';
import { applicationView, ensureApplication } from '../src/domain/applications/store.ts';
import type { CaptchaChallenge } from '../src/integrations/capmonster.ts';
import { EventBus } from '../src/queue/events.ts';
import { runInTx } from '../src/queue/tx.ts';
import {
  type PrepareHarness,
  prepareHarness,
  SYNTHETIC_PROFILE,
  seedPosting,
  setProfile,
} from './helpers/applications.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { quietLog } from './helpers/deps.ts';
import { runRead } from './helpers/form-read.ts';
import { type SiteServer, startSiteServer } from './helpers/site-server.ts';

vi.setConfig({ testTimeout: 120_000 });

const SITES = fileURLToPath(new URL('./fixtures/sites', import.meta.url));
const NO_PACING = {
  taskGapMs: [0, 0] as [number, number],
  actionMs: [0, 0] as [number, number],
  keyMs: [0, 0] as [number, number],
};

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('guardrails: lanes, caps, pacing, the candidate in the profile', () => {
  let t: TempDb;
  afterEach(() => t?.cleanup());

  it('knows the guarded platforms by host', () => {
    expect(platformOf('https://www.linkedin.com/jobs/view/1')).toBe('linkedin');
    expect(platformOf('https://de.linkedin.com/jobs')).toBe('linkedin');
    expect(platformOf('https://www.xing.com/jobs/berlin-1')).toBe('xing');
    expect(platformOf('https://boards.greenhouse.io/acme/jobs/1')).toBeNull();
    expect(platformOf('https://notlinkedin.com/')).toBeNull();
  });

  it('a second task for the same platform waits for the first; another platform does not', async () => {
    t = tempDb();
    const slept: number[] = [];
    const g = new Guardrails({
      db: t.db,
      bus: new EventBus(),
      random: () => 0.5,
      sleep: async (ms) => {
        slept.push(ms);
      },
      pacing: { taskGapMs: [40_000, 60_000] },
    });
    const order: string[] = [];
    const first = deferred();
    const a = g.run('linkedin', 'search', async () => {
      order.push('a:start');
      await first.promise;
      order.push('a:end');
    });
    await tick();
    const progress: string[] = [];
    const b = g.run(
      'linkedin',
      'apply',
      async () => {
        order.push('b:start');
      },
      { progress: (m) => progress.push(m) },
    );
    const x = g.run('xing', 'search', async () => {
      order.push('xing');
    });
    await x;
    await tick();
    expect(order).toEqual(['a:start', 'xing']);
    expect(g.busy('linkedin')).toBe(true);
    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'xing', 'a:end', 'b:start']);
    expect(progress[0]).toMatch(/waiting for the LinkedIn task/);
    // Paced: a randomised gap (here the midpoint, 50 s) after the first task.
    expect(slept.some((ms) => ms > 45_000 && ms <= 50_000)).toBe(true);
    expect(g.status('linkedin')).toMatchObject({ searchesToday: 1, applicationsToday: 1 });
  });

  it('stops at the daily cap until the oldest action is a day old', async () => {
    t = tempDb();
    let clock = new Date('2026-09-29T08:00:00Z');
    const g = new Guardrails({
      db: t.db,
      bus: new EventBus(),
      now: () => clock,
      pacing: NO_PACING,
    });
    g.setCaps('linkedin', { applications: 2 });
    await g.run('linkedin', 'apply', async () => {});
    clock = new Date('2026-09-29T09:00:00Z');
    await g.run('linkedin', 'apply', async () => {});
    const err = await g.run('linkedin', 'apply', async () => {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformCapReached);
    expect((err as PlatformCapReached).until.toISOString()).toBe('2026-09-30T08:00:00.000Z');
    // Searches have their own cap.
    await g.run('linkedin', 'search', async () => {});
    clock = new Date('2026-09-30T08:00:01Z');
    await g.run('linkedin', 'apply', async () => {});
  });

  it('waits while the candidate is using the platform in Applyant’s profile', async () => {
    t = tempDb();
    let busyChecks = 2;
    const slept: number[] = [];
    const g = new Guardrails({
      db: t.db,
      bus: new EventBus(),
      pacing: { ...NO_PACING, activePollMs: 30_000 },
      sleep: async (ms) => {
        slept.push(ms);
      },
      activity: { activeOn: async () => busyChecks-- > 0 },
    });
    const progress: string[] = [];
    let ran = false;
    await g.run(
      'linkedin',
      'search',
      async () => {
        ran = true;
      },
      { progress: (m) => progress.push(m) },
    );
    expect(ran).toBe(true);
    expect(slept).toEqual([30_000, 30_000]);
    expect(progress.filter((m) => /you are using LinkedIn/.test(m))).toHaveLength(2);
  });
});

describe('challenges pause the platform and are never solved', () => {
  let site: SiteServer;
  let browser: Browser;
  let t: TempDb;
  let h: PrepareHarness | undefined;
  const closers: Array<() => Promise<void>> = [];
  const now = new Date('2026-09-29T10:00:00Z');

  beforeAll(async () => {
    site = await startSiteServer();
    browser = await chromium.launch({ headless: true });
  });
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    await h?.stop();
    h = undefined;
    t?.cleanup();
  });
  afterAll(async () => {
    await browser?.close();
    await site?.close();
  });

  /** linkedin.com answered locally with a fixture page. */
  async function routeLinkedIn(context: BrowserContext, fixture: string) {
    await context.route('https://www.linkedin.com/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: readFileSync(join(SITES, fixture), 'utf8'),
      }),
    );
  }

  it('a checkpoint in a guarded task pauses the platform until resumed', async () => {
    t = tempDb();
    const g = new Guardrails({ db: t.db, bus: new EventBus(), pacing: NO_PACING });
    const context = await browser.newContext();
    closers.push(() => context.close());
    await routeLinkedIn(context, 'linkedin-checkpoint.html');
    const page = await context.newPage();

    const err = await g
      .run('linkedin', 'search', async (s) => {
        await page.goto('https://www.linkedin.com/checkpoint/challenge/abc');
        await s.checkChallenge(page);
        return 'unreachable';
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformChallenge);
    const status = g.status('linkedin');
    expect(status.pausedAt).not.toBeNull();
    expect(status.pauseReason).toMatch(/LinkedIn asked to verify the session \(\/checkpoint/);
    const ev = t.db.select().from(events).where(eq(events.kind, 'platform')).all();
    expect(ev.map((e) => e.stage)).toContain('paused');

    // Paused: nothing runs on LinkedIn; Xing is unaffected.
    await expect(g.run('linkedin', 'search', async () => 1)).rejects.toBeInstanceOf(PlatformPaused);
    await expect(g.run('xing', 'search', async () => 2)).resolves.toBe(2);
    g.resume('linkedin');
    await expect(g.run('linkedin', 'search', async () => 3)).resolves.toBe(3);
  });

  it('a captcha on a LinkedIn form hands off and pauses LinkedIn; the solver is never asked', async () => {
    t = tempDb();
    const asked: CaptchaChallenge[] = [];
    const solver = {
      async configured() {
        return true;
      },
      async solve(c: CaptchaChallenge) {
        asked.push(c);
        return 'must-not-be-used';
      },
    };
    const bus = new EventBus();
    const guardrails = new Guardrails({ db: t.db, bus, pacing: NO_PACING });
    h = await prepareHarness(t, {}, { deps: { captcha: solver, guardrails } });
    const { context } = await (
      h.submit as unknown as { ensure(): Promise<{ context: BrowserContext }> }
    ).ensure();
    await routeLinkedIn(context, 'linkedin-apply.html');

    // The form as Read saw it (the same page, served locally), then the posting's apply URL is
    // LinkedIn's.
    const run = await runRead(browser, site.url('/linkedin-apply.html'));
    closers.push(run.close);
    setProfile(t.db, SYNTHETIC_PROFILE, now);
    const apply = 'https://www.linkedin.com/jobs/view/4001/apply';
    const make = () => {
      const id = seedPosting(t.db, run.read, { now, stage: 'verified' });
      t.db.update(postings).set({ applyUrl: apply }).where(eq(postings.id, id)).run();
      return id;
    };
    const first = runInTx(t.db, h.bus, { now }, (tx) => ensureApplication(tx, make(), 't').app.id);
    await h.worker.idle();
    expect(applicationView(t.db, first).blockers).toEqual([]);
    runInTx(t.db, h.bus, { now }, (tx) => approveApplication(tx, first));
    await h.worker.idle();

    const view = applicationView(t.db, first);
    expect(view.app.stage).toBe('approved');
    expect(view.handOff?.browser?.scope).toBe('captcha');
    expect(view.handOff?.reason).toMatch(
      /captcha \(recaptcha_v2\) on LinkedIn: never sent to a captcha solver/,
    );
    expect(view.handOff?.reason).toMatch(/applyant platforms resume linkedin/);
    expect(asked).toEqual([]);
    expect(guardrails.status('linkedin').pausedAt).not.toBeNull();
    // The window is left filled for the candidate.
    const pages = await h.submit.openPages();
    const page = pages.find((p) => p.url() === apply);
    if (!page) throw new Error('no hand-off page left open');
    await expect(page.locator('#name').inputValue()).resolves.toBe(SYNTHETIC_PROFILE.full_name);

    // A second LinkedIn delivery doesn't open anything while LinkedIn is paused.
    const second = runInTx(t.db, h.bus, { now }, (tx) => ensureApplication(tx, make(), 't').app.id);
    await h.worker.idle();
    runInTx(t.db, h.bus, { now }, (tx) => approveApplication(tx, second));
    await h.worker.idle();
    const v2 = applicationView(t.db, second);
    expect(v2.handOff?.reason).toMatch(/LinkedIn is paused after a challenge/);
    expect(v2.handOff?.browser ?? null).toBeNull();
    expect(asked).toEqual([]);
    expect(guardrails.status('linkedin').applicationsToday).toBe(1);
  });

  it('Easy Apply: the modal form is filled and sent through the form engine, as one guarded application', async () => {
    t = tempDb();
    const asked: CaptchaChallenge[] = [];
    const solver = {
      async configured() {
        return true;
      },
      async solve(c: CaptchaChallenge) {
        asked.push(c);
        return 'must-not-be-used';
      },
    };
    const bus = new EventBus();
    const guardrails = new Guardrails({ db: t.db, bus, pacing: NO_PACING });
    h = await prepareHarness(t, {}, { deps: { captcha: solver, guardrails } });
    const { context } = await (
      h.submit as unknown as { ensure(): Promise<{ context: BrowserContext }> }
    ).ensure();
    await routeLinkedIn(context, 'linkedin-easy-apply.html');

    // Read pressed "Easy Apply" and read both steps of the modal.
    const run = await runRead(browser, site.url('/linkedin-easy-apply.html'));
    closers.push(run.close);
    expect(run.read.requirements.steps).toHaveLength(2);
    setProfile(t.db, SYNTHETIC_PROFILE, now);
    const job = 'https://www.linkedin.com/jobs/view/4002002/';
    const id = seedPosting(t.db, run.read, { now, stage: 'verified' });
    t.db
      .update(postings)
      .set({ canonicalUrl: job, applyUrl: job })
      .where(eq(postings.id, id))
      .run();
    const app = runInTx(t.db, h.bus, { now }, (tx) => ensureApplication(tx, id, 't').app.id);
    await h.worker.idle();
    runInTx(t.db, h.bus, { now }, (tx) => approveApplication(tx, app));
    await h.worker.idle();

    const view = applicationView(t.db, app);
    expect(view.handOff ?? null).toBeNull();
    expect(view.app.stage).toBe('applied');
    expect(asked).toEqual([]);
    const status = guardrails.status('linkedin');
    expect(status.applicationsToday).toBe(1);
    expect(status.pausedAt).toBeNull();
  });

  it("prefers the company's own form when the LinkedIn posting also has one", () => {
    t = tempDb();
    const id = t.db
      .insert(postings)
      .values({
        stage: 'verified',
        canonicalUrl: 'https://www.linkedin.com/jobs/view/4001',
        applyUrl: 'https://www.linkedin.com/jobs/view/4001/apply',
      })
      .returning({ id: postings.id })
      .get().id;
    const row = t.db.select().from(postings).where(eq(postings.id, id)).get();
    if (!row) throw new Error('no posting');
    expect(applyTarget(t.read, row)).toBe('https://www.linkedin.com/jobs/view/4001/apply');
    t.db
      .insert(postingSources)
      .values([
        { postingId: id, kind: 'board', url: 'https://news.ycombinator.com/item?id=1' },
        {
          postingId: id,
          kind: 'greenhouse',
          url: 'https://boards.greenhouse.io/acme/jobs/4001234',
        },
      ])
      .run();
    expect(applyTarget(t.read, row)).toBe('https://boards.greenhouse.io/acme/jobs/4001234');
    // A posting that isn't on a guarded platform keeps its own apply URL.
    expect(applyTarget(t.read, { ...row, applyUrl: 'https://jobs.example.test/apply/1' })).toBe(
      'https://jobs.example.test/apply/1',
    );
  });
});

describe('the sign-in window (a fake Chrome binary)', () => {
  let t: TempDb;
  let submit: SubmitProfile;
  afterEach(async () => {
    await submit?.close();
    t?.cleanup();
  });

  function fakeChrome(dir: string): { path: string; argsFile: string } {
    const path = join(dir, 'fake-chrome.sh');
    const argsFile = join(dir, 'chrome-args.txt');
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nexec sleep 30\n`);
    chmodSync(path, 0o755);
    return { path, argsFile };
  }

  it('opens the profile without automation, holds deliveries until it closes, marks signed in', async () => {
    t = tempDb();
    const bus = new EventBus();
    const guardrails = new Guardrails({ db: t.db, bus, pacing: NO_PACING });
    submit = new SubmitProfile({
      userDataDir: join(t.dir, 'browser'),
      log: quietLog,
      headless: true,
    });
    const chrome = fakeChrome(t.dir);
    const login = new LoginWindow({
      userDataDir: join(t.dir, 'browser'),
      profile: submit,
      log: quietLog,
      chrome: chrome.path,
      onClosed: ({ platform }) => {
        if (platform) guardrails.markSignedIn(platform);
      },
    });
    const activity = profileActivity(login, submit);
    expect(await activity.activeOn('linkedin')).toBe(false);

    const opened = await login.open('linkedin');
    expect(opened).toEqual({ url: 'https://www.linkedin.com/login', platform: 'linkedin' });
    expect(login.isOpen()).toBe(true);
    expect(await activity.activeOn('linkedin')).toBe(true);
    await expect
      .poll(() => {
        try {
          return readFileSync(chrome.argsFile, 'utf8');
        } catch {
          return '';
        }
      })
      .toContain('--user-data-dir=');
    const args = readFileSync(chrome.argsFile, 'utf8').trim().split('\n');
    expect(args).toEqual(signInArgs(join(t.dir, 'browser'), 'https://www.linkedin.com/login'));
    expect(args.join(' ')).not.toMatch(/remote-debugging|enable-automation|headless/);
    await expect(login.open('xing')).rejects.toBeInstanceOf(LoginWindowError);

    // A delivery queued now waits for the window.
    let delivered = false;
    const delivery = submit.deliver(async () => {
      delivered = true;
      return { result: 'ok', keepOpen: false };
    });
    await tick();
    expect(delivered).toBe(false);
    expect(guardrails.status('linkedin').signedInAt).toBeNull();

    login.close();
    await expect(delivery).resolves.toBe('ok');
    expect(delivered).toBe(true);
    await expect.poll(() => guardrails.status('linkedin').signedInAt).not.toBeNull();
    expect(login.isOpen()).toBe(false);
  });

  it('refuses while a hand-off window is open, unless forced; bad targets are refused', async () => {
    t = tempDb();
    const chrome = fakeChrome(t.dir);
    let holds = 0;
    const login = new LoginWindow({
      userDataDir: join(t.dir, 'browser'),
      profile: {
        async hold() {
          holds++;
        },
        async openPages() {
          return [{ url: () => 'https://jobs.example.test/apply/1' }];
        },
      },
      log: quietLog,
      chrome: chrome.path,
    });
    await expect(login.open('https://example.test/workday')).rejects.toThrow(
      /1 window left open for you \(https:\/\/jobs\.example\.test\/apply\/1\)/,
    );
    expect(holds).toBe(0);
    await expect(login.open('ftp://example.test')).rejects.toThrow(/not a web address/);
    await expect(login.open('myspace')).rejects.toThrow(/neither linkedin, xing nor a URL/);
    const t2 = await login.open('https://acme.wd3.myworkdayjobs.com/', { force: true });
    expect(t2.platform).toBeNull();
    expect(holds).toBe(1);
    login.close();
    const noChrome = new LoginWindow({
      userDataDir: t.dir,
      profile: { hold: async () => {}, openPages: async () => [] },
      log: quietLog,
      chrome: null,
    });
    await expect(noChrome.open('linkedin')).rejects.toThrow(/Google Chrome was not found/);
    // APPLYANT_CHROME is the only place looked at when set: never the installed Chrome instead.
    expect(findChrome({ APPLYANT_CHROME: '/nonexistent/chrome' })).toBeNull();
    expect(findChrome({ APPLYANT_CHROME: chrome.path })).toBe(chrome.path);
  });
});
