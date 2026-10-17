// Signing in, and delivery that meets a sign-in:
//   - the automated Chrome uses the real Keychain, so it reads the sign-in window's cookies;
//   - account controls ("Login with GitHub", "Увійти") are never pressed, sign-in pages and
//     password fields are recognised;
//   - Djinni's signed-out page stops delivery before anything is filled or sent, and the
//     application goes back to the candidate with a note that says to sign in;
//   - Djinni's message is the cover letter;
//   - after a sign-in, unsent applications on the site are read (in the signed-in profile) and
//     prepared again.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type DeliverFormOptions, deliverForm } from '../src/browser/form-deliver.ts';
import { pickAdvance } from '../src/browser/form-engine.ts';
import { guardReadOnly, readForm } from '../src/browser/form-read.ts';
import type { FormRead } from '../src/browser/form-types.ts';
import { signInTarget } from '../src/browser/login-window.ts';
import {
  deliverySignInNote,
  isAccountControl,
  isSignInPage,
  readSignInNote,
  signInSiteOf,
  signInWall,
} from '../src/browser/sign-in.ts';
import type { SnapButton, SnapField } from '../src/browser/snapshot.ts';
import { launchOptions, MOCK_KEYCHAIN_ARGS } from '../src/browser/submit-profile.ts';
import type { Channel } from '../src/channels/channel.ts';
import { applications, events, postings, tasks } from '../src/db/schema.ts';
import { deliverApplication, refreshAfterSignIn } from '../src/domain/applications/deliver.ts';
import { FormJudge, ruleMeaning } from '../src/domain/applications/form-judge.ts';
import { prepareApplication } from '../src/domain/applications/prepare.ts';
import { readFormHandler } from '../src/domain/applications/read-form.ts';
import { ApprovalBlocked, approveApplication } from '../src/domain/applications/review.ts';
import { applicationView } from '../src/domain/applications/store.ts';
import { AgentRunner } from '../src/models/agent-runner.ts';
import { EventBus } from '../src/queue/events.ts';
import { runInTx } from '../src/queue/tx.ts';
import type { HandlerContext, Outcome } from '../src/queue/types.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { quietLog, testDeps } from './helpers/deps.ts';
import { FIXTURE_MEANINGS, fakeJev } from './helpers/fake-jev.ts';
import { FIXTURE_PROFILE } from './helpers/form-read.ts';
import { type SiteServer, startSiteServer } from './helpers/site-server.ts';

vi.setConfig({ testTimeout: 120_000 });

const SITES = fileURLToPath(new URL('./fixtures/sites', import.meta.url));
const JOB = 'https://djinni.co/jobs/843207-ai-product-engineer/';
const now = new Date('2026-10-17T12:00:00Z');

describe("the profile's Chrome shares the sign-in window's cookies", () => {
  it('branded Chrome drops the mock Keychain; the bundled Chromium and tests keep it', () => {
    expect(launchOptions('chrome', { headless: false, keychain: true })).toEqual({
      channel: 'chrome',
      headless: false,
      viewport: null,
      ignoreDefaultArgs: ['--use-mock-keychain', '--password-store=basic'],
    });
    expect(MOCK_KEYCHAIN_ARGS).toEqual(['--use-mock-keychain', '--password-store=basic']);
    // Headless test runs leave the Keychain alone.
    expect(launchOptions('chrome', { headless: true, keychain: false })).not.toHaveProperty(
      'ignoreDefaultArgs',
    );
    // Another binary would make the Keychain ask: it keeps the defaults.
    expect(launchOptions('bundled', { headless: false, keychain: true })).toEqual({
      headless: false,
      viewport: null,
    });
  });
});

const button = (text: string, o: Partial<SnapButton> = {}): SnapButton => ({
  ref: { frame: [], role: 'button', name: text, nth: 0, css: null },
  text,
  submit: false,
  inRoot: true,
  ...o,
});

describe('account controls and sign-in pages', () => {
  it('never advances through a sign-in, sign-up or identity-provider control', () => {
    // Djinni's login page: "Login with GitHub" is a submit button in the form.
    expect(pickAdvance([button('Login with GitHub', { submit: true })])).toEqual({
      ref: null,
      text: null,
      isFinal: true,
    });
    expect(pickAdvance([button('Continue with Google'), button('Next')])).toMatchObject({
      text: 'Next',
      isFinal: false,
    });
    expect(
      pickAdvance([button('Увійти', { submit: true }), button('Надіслати', { submit: true })]),
    ).toMatchObject({ text: 'Надіслати', isFinal: true });
    for (const text of [
      'Log In',
      'Sign in',
      'Sign Up',
      'Register',
      'Create an account',
      'Continue with Apple',
      'Sign in with LinkedIn',
      'Увійти',
      'Зареєструватися',
      'Войти',
      'Регистрация',
      'Anmelden',
    ]) {
      expect(isAccountControl(text), text).toBe(true);
    }
    for (const text of [
      'Send application',
      'Submit',
      'Next',
      'Continue',
      'Apply for the job',
      // Real apply buttons that only sound like an account.
      'Continue with your application',
      'Continue with application',
      'Register your interest',
      'Register interest',
    ]) {
      expect(isAccountControl(text), text).toBe(false);
    }
    for (const text of ['Continue with email', 'Apply with Indeed', 'Apply with XING']) {
      expect(isAccountControl(text), text).toBe(true);
    }
  });

  it("knows identity providers' and sites' own sign-in pages", () => {
    for (const url of [
      'https://github.com/login?return_to=%2Flogin%2Foauth%2Fauthorize',
      'https://accounts.google.com/v3/signin/identifier',
      'https://appleid.apple.com/auth/authorize',
      'https://www.linkedin.com/uas/login',
      'https://djinni.co/login?lang=en',
      'https://acme.taleo.net/careersection/2/login.ftl',
      'https://jobs.example.com/users/sign_in',
    ]) {
      expect(isSignInPage(url), url).toBe(true);
    }
    for (const url of [
      JOB,
      'https://github.com/acme/repo',
      // A checkpoint is a challenge (guardrails), not a sign-in.
      'https://www.linkedin.com/checkpoint/challenge',
      'https://jobs.lever.co/acme/1/apply',
      'https://example.com/login-free-apply',
    ]) {
      expect(isSignInPage(url), url).toBe(false);
    }
  });

  it('djinni is a sign-in target, not a guarded platform', () => {
    expect(signInTarget('djinni')).toEqual({ url: 'https://djinni.co/login', platform: null });
    expect(signInSiteOf('https://djinni.co/jobs/1/')?.name).toBe('Djinni');
    expect(signInSiteOf('https://example.com/')).toBeNull();
    // The app offers "Sign in to <host>" on notes that say "sign in".
    expect(deliverySignInNote(JOB)).toBe(
      'Djinni asks you to sign in before applying: nothing was sent. Sign in to djinni.co, then approve again.',
    );
    expect(deliverySignInNote('https://www.acme.example/apply')).toMatch(
      /^The application page asks you to sign in .*Sign in to acme\.example,/,
    );
  });
});

const textarea = (label: string, name = ''): SnapField => ({
  ref: { frame: [], role: 'textbox', name: label, nth: 0, css: null },
  label,
  kind: 'textarea',
  required: false,
  options: null,
  meaning: null,
  revealedBy: null,
  hint: {
    type: 'textarea',
    autocomplete: '',
    name,
    placeholder: '',
    description: '',
    multiple: false,
    toggle: false,
  },
  value: null,
});

describe("Djinni's message is the cover letter", () => {
  it('on djinni.co, and wherever the label calls it a letter or a message to the employer', () => {
    expect(ruleMeaning(textarea('Message', 'message'), JOB)).toBe('cover_letter');
    expect(ruleMeaning(textarea('Повідомлення'), JOB)).toBe('cover_letter');
    expect(ruleMeaning(textarea('Супровідний лист'), JOB)).toBe('cover_letter');
    expect(ruleMeaning(textarea('Cover letter (optional)'), 'https://x.test/')).toBe(
      'cover_letter',
    );
    expect(ruleMeaning(textarea('Message to the hiring manager'), null)).toBe('cover_letter');
    // A bare "Message" elsewhere is field_classify's call.
    expect(ruleMeaning(textarea('Message'), 'https://jobs.example.com/apply')).toBeNull();
    expect(ruleMeaning(textarea('Why do you want to join us?'), JOB)).toBeNull();
  });
});

// ---- in a real browser ----------------------------------------------------------------------

let browser: Browser;
let site: SiteServer;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  site = await startSiteServer();
});
afterAll(async () => {
  await browser?.close();
  await site?.close();
});

/** A context where djinni.co is the given fixture; non-GET requests to it are recorded. */
async function djinni(
  fixture: string,
): Promise<{ context: BrowserContext; page: Page; posts: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const posts: string[] = [];
  await context.route('https://djinni.co/**', async (route) => {
    const req = route.request();
    if (req.method() !== 'GET') {
      posts.push(`${req.method()} ${new URL(req.url()).pathname}`);
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    if (req.resourceType() !== 'document') return route.fulfill({ status: 404, body: '' });
    return route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: readFileSync(join(SITES, fixture), 'utf8'),
    });
  });
  return { context, page: await context.newPage(), posts };
}

function deliverOptions(
  url: string,
  values: Record<string, string>,
  pressed: { submit: number },
): DeliverFormOptions {
  return {
    url,
    judge: { classify: async () => {} },
    valueFor: (_ref, field) => {
      const text = values[field.label];
      return text === undefined ? undefined : { kind: 'text', text };
    },
    isKnown: () => true,
    resolveNewField: () => null,
    agentField: async () => false,
    agentStep: async () => false,
    beforeSubmit: () => {
      pressed.submit++;
    },
  };
}

function judge(url: string, dir: string): FormJudge {
  const models = new AgentRunner({
    providers: [],
    runsDir: join(dir, 'runs'),
    workDir: join(dir, 'work'),
    record: () => {},
    log: quietLog,
    jev: fakeJev({ meanings: FIXTURE_MEANINGS }),
  });
  return new FormJudge({
    decide: (role, req) => models.decide(role, req),
    profile: FIXTURE_PROFILE,
    job: { title: 'AI Product Engineer', company: 'Acme' },
    url,
    taskId: null,
    signal: new AbortController().signal,
  });
}

describe('Djinni in a real browser', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    site.writes.length = 0;
  });

  it('signed out: delivery stops before anything is opened, filled or sent', async () => {
    const { context, page, posts } = await djinni('djinni-signed-out.html');
    closers.push(() => context.close());
    const pressed = { submit: 0 };
    const result = await deliverForm(
      page,
      deliverOptions(JOB, { Message: 'Hello', Email: 'a@example.com', 'Your name': 'A' }, pressed),
    );
    expect(result).toEqual({
      kind: 'sign_in',
      step: 1,
      url: JOB,
      reason: 'Djinni shows its signed-out page',
    });
    // "Apply for the job" was never pressed, nothing was typed, nothing left the page.
    expect(await page.evaluate(() => (window as { __opened?: number }).__opened ?? 0)).toBe(0);
    expect(await page.locator('#email').inputValue()).toBe('');
    expect(pressed.submit).toBe(0);
    expect(posts).toEqual([]);
  });

  it('signed in: the message is filled and sent', async () => {
    const { context, page, posts } = await djinni('djinni-signed-in.html');
    closers.push(() => context.close());
    const pressed = { submit: 0 };
    const result = await deliverForm(
      page,
      deliverOptions(JOB, { Message: 'Dear team, I build LLM products.' }, pressed),
    );
    expect(result).toMatchObject({ kind: 'submitted' });
    expect(pressed.submit).toBe(1);
    expect(posts).toEqual(['POST /jobs/843207-ai-product-engineer/']);
  });

  it('Read in the signed-in profile: signed out is reported, signed in reads the letter', async () => {
    const t = tempDb();
    closers.push(async () => t.cleanup());
    const out = await djinni('djinni-signed-out.html');
    closers.push(() => out.context.close());
    await guardReadOnly(out.context);
    const signedOut = await readForm(out.page, {
      url: JOB,
      judge: judge(JOB, t.dir),
      signedIn: true,
    });
    expect(signedOut).toEqual({ kind: 'no_form', note: readSignInNote(JOB), url: JOB });
    expect(readSignInNote(JOB)).toMatch(/^Djinni asks you to sign in .*sign in to djinni\.co/);

    const inside = await djinni('djinni-signed-in.html');
    closers.push(() => inside.context.close());
    await guardReadOnly(inside.context);
    const signedIn = await readForm(inside.page, {
      url: JOB,
      judge: judge(JOB, t.dir),
      signedIn: true,
    });
    if (signedIn.kind !== 'form') throw new Error(`no form: ${signedIn.note}`);
    expect(signedIn.read.signedIn).toBe(true);
    expect(signedIn.read.requirements.steps[0]?.fields).toMatchObject([
      { label: 'Message', kind: 'textarea', meaning: 'cover_letter' },
    ]);
    expect(inside.posts).toEqual([]);
  });

  it('never presses "Login with GitHub" or "Continue with Google", even as the only submit', async () => {
    const context = await browser.newContext();
    closers.push(() => context.close());
    const page = await context.newPage();
    const pressed = { submit: 0 };
    const result = await deliverForm(
      page,
      deliverOptions(site.url('/form-deliver-oauth.html'), { 'Full Name': 'Alex' }, pressed),
    );
    expect(result).toMatchObject({ kind: 'handoff', reason: 'no submit control found' });
    expect(await page.evaluate(() => (window as { __pressed?: number }).__pressed ?? 0)).toBe(0);
    expect(site.writes).toEqual([]);
  });

  it('a password is a sign-in only among a few fields, as Read has it', async () => {
    const context = await browser.newContext();
    closers.push(() => context.close());
    const page = await context.newPage();
    await page.setContent(
      `<form><label>Email<input type="email"></label><label>Password<input type="password"></label><button>Log in</button></form>`,
    );
    expect(await signInWall(page)).toBe('the form asks for a password');
    // An application form that also creates an account: filled, its password left alone.
    await page.setContent(`<form>
      <label>First name<input name="first"></label><label>Last name<input name="last"></label>
      <label>Email<input type="email" name="email"></label><label>Phone<input type="tel" name="phone"></label>
      <label>Cover letter<textarea name="letter"></textarea></label>
      <label>Choose a password (optional)<input type="password" name="pw"></label>
      <button type="submit">Submit application</button></form>`);
    expect(await signInWall(page)).toBeNull();
  });

  it('Djinni with anon_apply="false" is not its signed-out page', async () => {
    const context = await browser.newContext();
    closers.push(() => context.close());
    const signedIn = readFileSync(join(SITES, 'djinni-signed-in.html'), 'utf8').replace(
      '<form method="post" id="apply_form"',
      '<input type="hidden" name="anon_apply" value="false"><form method="post" id="apply_form"',
    );
    await context.route('https://djinni.co/**', (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: signedIn }),
    );
    const page = await context.newPage();
    await page.goto(JOB);
    expect(await signInWall(page)).toBeNull();
  });

  it('a sign-in page reached before anything was pressed stops delivery as a sign-in', async () => {
    const context = await browser.newContext();
    closers.push(() => context.close());
    const page = await context.newPage();
    const pressed = { submit: 0 };
    const result = await deliverForm(
      page,
      deliverOptions(site.url('/form-signin.html'), { 'Email Address': 'a@example.com' }, pressed),
    );
    expect(result).toMatchObject({ kind: 'sign_in', reason: 'the form asks for a password' });
    expect(await page.locator('#email').inputValue()).toBe('');
    expect(site.writes).toEqual([]);
  });
});

// ---- the application ------------------------------------------------------------------------

const ANON_FORM: FormRead = {
  url: JOB,
  requirements: {
    steps: [
      {
        fields: [
          {
            ref: { frame: [], role: 'textbox', name: 'Message', nth: 0, css: null },
            label: 'Message',
            kind: 'textarea',
            required: false,
            options: null,
            meaning: 'question',
            revealedBy: null,
          },
        ],
        advance: { frame: [], role: 'button', name: 'Send application', nth: 0, css: null },
        isFinal: true,
      },
    ],
  },
  notes: [],
};

function addApp(
  t: TempDb,
  stage: (typeof applications.$inferInsert)['stage'],
  url = `${JOB}?v=${Math.random().toString(36).slice(2)}`,
) {
  const posting = t.db
    .insert(postings)
    .values({
      stage: 'scored',
      canonicalUrl: url,
      applyUrl: url,
      title: 'AI Product Engineer',
      company: 'Acme',
      form: { ...ANON_FORM, url },
      formStatus: 'verified',
      formNote: '1 step',
      formReadAt: now,
    })
    .returning()
    .get();
  return t.db
    .insert(applications)
    .values({ postingId: posting.id, stage, createdAt: now, updatedAt: now })
    .returning()
    .get();
}

function handlerContext(t: TempDb, deps: HandlerContext['deps']): HandlerContext {
  return {
    deps,
    read: t.db,
    signal: new AbortController().signal,
    progress: () => {},
    record: () => true,
    now: () => now,
  };
}

const commit = (t: TempDb, bus: EventBus, outcome: Outcome) => {
  if (!('commit' in outcome)) throw new Error(`no commit: ${outcome.kind}`);
  runInTx(t.db, bus, { now }, (tx) => outcome.commit(tx));
};

describe('delivery that meets a sign-in', () => {
  let t: TempDb;
  afterEach(() => t.cleanup());

  it('goes back to the candidate unsent, with a note and a blocker that say to sign in', async () => {
    t = tempDb();
    const bus = new EventBus();
    const app = addApp(t, 'approved', JOB);
    // A retry after an earlier hand-off: that one closes too.
    t.db
      .insert(tasks)
      .values({ kind: 'deliver_application', entityId: app.id, status: 'needs_candidate' })
      .run();
    let delivered = 0;
    const channel: Channel = {
      read: () => Promise.reject(new Error('no reads here')),
      deliver: async () => {
        delivered++;
        return { kind: 'sign_in', url: JOB, reason: 'Djinni shows its signed-out page' };
      },
    };
    const outcome = await deliverApplication(
      {
        id: 7,
        kind: 'deliver_application',
        entityId: app.id,
        runId: null,
        provider: null,
        attempts: 0,
      },
      handlerContext(t, { channels: { web_form: channel } } as unknown as HandlerContext['deps']),
    );
    // Not a hand-off: no window waits for the candidate, the task is done.
    expect(outcome.kind).toBe('done');
    commit(t, bus, outcome);
    expect(delivered).toBe(1);

    const view = applicationView(t.db, app.id);
    const note =
      'Djinni asks you to sign in before applying: nothing was sent. Sign in to djinni.co, then approve again.';
    expect(view.app).toMatchObject({
      stage: 'needs_candidate',
      note,
      approvedAt: null,
      submitAttemptedAt: null,
    });
    expect(view.blockers).toContain(note);
    expect(view.handOff).toBeNull();
    const kinds = t.db.select().from(events).all();
    expect(kinds.find((e) => e.kind === 'application.stage')).toMatchObject({
      stage: 'needs_candidate',
      entityId: app.id,
    });
    expect(kinds.some((e) => e.kind === 'handoff')).toBe(false);
    expect(() => runInTx(t.db, bus, { now }, (tx) => approveApplication(tx, app.id))).toThrow(
      ApprovalBlocked,
    );
  });
});

describe('after signing in', () => {
  let t: TempDb;
  afterEach(() => t.cleanup());

  it('reads and prepares again the unsent applications on that site, and nothing else', () => {
    t = tempDb();
    const bus = new EventBus();
    const ready = addApp(t, 'ready_for_review');
    const stopped = addApp(t, 'needs_candidate');
    const approved = addApp(t, 'approved');
    const applied = addApp(t, 'applied');
    const elsewhere = addApp(t, 'ready_for_review', 'https://jobs.example.com/acme/1');
    // Read signed in already: nothing new to see, unless a sign-in stopped it since.
    const current = addApp(t, 'ready_for_review');
    const expired = addApp(t, 'needs_candidate');
    for (const a of [current, expired]) {
      t.db
        .update(postings)
        .set({ form: { ...ANON_FORM, signedIn: true } })
        .where(eq(postings.id, a.postingId))
        .run();
    }
    t.db
      .update(applications)
      .set({ note: deliverySignInNote(JOB) })
      .where(eq(applications.id, expired.id))
      .run();
    // Hand-offs are the candidate's to finish: one waiting in the browser, one after a press
    // (prepared again, it would be one approval away from a second send).
    const handedOff = addApp(t, 'needs_candidate');
    t.db
      .insert(tasks)
      .values({ kind: 'deliver_application', entityId: handedOff.id, status: 'needs_candidate' })
      .run();
    const pressedOnce = addApp(t, 'needs_candidate');
    t.db
      .update(applications)
      .set({ submitAttemptedAt: now })
      .where(eq(applications.id, pressedOnce.id))
      .run();

    // A site the anonymous reader reads would look the same: nothing to do.
    expect(
      runInTx(t.db, bus, { now }, (tx) => refreshAfterSignIn(tx, 'https://jobs.example.com/login')),
    ).toEqual([]);
    const ids = runInTx(t.db, bus, { now }, (tx) =>
      refreshAfterSignIn(tx, 'https://djinni.co/login'),
    );
    expect(ids.sort((a, b) => a - b)).toEqual([ready.id, stopped.id, expired.id]);

    const stage = (id: number) =>
      t.db.select().from(applications).where(eq(applications.id, id)).get();
    expect(stage(ready.id)).toMatchObject({
      stage: 'preparing',
      note: 'you signed in to djinni.co: reading its form again',
    });
    expect(stage(stopped.id)?.stage).toBe('preparing');
    expect(stage(approved.id)?.stage).toBe('approved');
    expect(stage(applied.id)?.stage).toBe('applied');
    expect(stage(elsewhere.id)?.stage).toBe('ready_for_review');
    expect(stage(current.id)?.stage).toBe('ready_for_review');
    expect(stage(expired.id)?.stage).toBe('preparing');
    expect(stage(handedOff.id)?.stage).toBe('needs_candidate');
    expect(stage(pressedOnce.id)?.stage).toBe('needs_candidate');
    // Its old (anonymous) read is gone: Prepare waits for the new one.
    const posting = t.db.select().from(postings).where(eq(postings.id, ready.postingId)).get();
    expect(posting).toMatchObject({ form: null, formStatus: null });
    const prepares = t.db
      .select()
      .from(tasks)
      .where(eq(tasks.kind, 'prepare_application'))
      .all()
      .map((r) => r.entityId);
    expect(prepares.sort((a, b) => a - b)).toEqual([ready.id, stopped.id, expired.id]);
  });

  it("LinkedIn: only forms that couldn't be read are read again (the rest were read signed in)", () => {
    t = tempDb();
    const bus = new EventBus();
    const read = addApp(t, 'ready_for_review', 'https://www.linkedin.com/jobs/view/1/');
    const failed = addApp(t, 'needs_candidate', 'https://www.linkedin.com/jobs/view/2/');
    t.db
      .update(postings)
      .set({ form: null, formStatus: 'failed', formNote: 'LinkedIn asked to verify the session' })
      .where(eq(postings.id, failed.postingId))
      .run();
    const ids = runInTx(t.db, bus, { now }, (tx) =>
      refreshAfterSignIn(tx, 'https://www.linkedin.com/login'),
    );
    expect(ids).toEqual([failed.id]);
    expect(t.db.select().from(applications).where(eq(applications.id, read.id)).get()?.stage).toBe(
      'ready_for_review',
    );
  });

  it("Prepare doesn't use an anonymous read of a Djinni form: it asks for one more", async () => {
    t = tempDb();
    const bus = new EventBus();
    const app = addApp(t, 'preparing');
    const outcome = await prepareApplication(
      {
        id: 1,
        kind: 'prepare_application',
        entityId: app.id,
        runId: null,
        provider: null,
        attempts: 0,
      },
      handlerContext(t, testDeps({ dir: t.dir, db: t.db })),
    );
    commit(t, bus, outcome);
    expect(
      t.db
        .select()
        .from(tasks)
        .where(eq(tasks.kind, 'read_form'))
        .all()
        .map((r) => r.entityId),
    ).toEqual([app.postingId]);
    expect(t.db.select().from(applications).where(eq(applications.id, app.id)).get()).toMatchObject(
      { stage: 'preparing', note: 'waiting for the application form to be read' },
    );
  });

  it('read_form reads a Djinni posting with an application in the signed-in profile', async () => {
    t = tempDb();
    const bus = new EventBus();
    const app = addApp(t, 'preparing', JOB);
    const { context, posts } = await djinni('djinni-signed-in.html');
    let profileReads = 0;
    let anonymousReads = 0;
    const submit = {
      async deliver<T>(fn: (page: Page) => Promise<{ result: T; keepOpen: boolean }>) {
        profileReads++;
        const page = await context.newPage();
        try {
          return (await fn(page)).result;
        } finally {
          await page.close();
        }
      },
    };
    const reader = {
      withPage: () => {
        anonymousReads++;
        return Promise.reject(new Error('the anonymous reader was used'));
      },
    };
    const deps = {
      ...testDeps({ dir: t.dir, db: t.db, jev: fakeJev({ meanings: FIXTURE_MEANINGS }) }),
      submit,
      reader,
    } as unknown as HandlerContext['deps'];
    try {
      const outcome = await readFormHandler(
        {
          id: 2,
          kind: 'read_form',
          entityId: app.postingId,
          runId: null,
          provider: null,
          attempts: 0,
        },
        handlerContext(t, deps),
      );
      commit(t, bus, outcome);
    } finally {
      await context.close();
    }
    expect({ profileReads, anonymousReads }).toEqual({ profileReads: 1, anonymousReads: 0 });
    const posting = t.db.select().from(postings).where(eq(postings.id, app.postingId)).get();
    expect(posting?.formStatus).toBe('verified');
    expect(posting?.form?.signedIn).toBe(true);
    expect(posting?.form?.requirements.steps[0]?.fields).toMatchObject([
      { label: 'Message', meaning: 'cover_letter' },
    ]);
    // Read never sends: the guard sat on the lent page.
    expect(posts).toEqual([]);
  });
});
