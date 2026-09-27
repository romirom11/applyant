// Read on synthetic local forms (test/fixtures/sites/form-*.html), modelled on how the ATSs
// behave: conditional reveals (Greenhouse custom questions), a 4-step wizard with a required
// upload (Workday), a wizard that saves each step on the server, a cross-origin embedded form
// with react-select-style comboboxes (Greenhouse embed), and an Ashby-style page that autosaves
// every value. Every test also checks nothing was submitted or written to the server.
import { eq } from 'drizzle-orm';
import { type Browser, chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ReaderPool } from '../src/browser/reader-pool.ts';
import { events as eventsTable, postings } from '../src/db/schema.ts';
import { readFormHandler } from '../src/domain/applications/read-form.ts';
import { setProfileValue } from '../src/domain/knowledge/profile.ts';
import { EventBus } from '../src/queue/events.ts';
import { runInTx } from '../src/queue/tx.ts';
import { Worker } from '../src/queue/worker.ts';
import { tempDb } from './helpers/db.ts';
import { handlers, quietLog, testDeps } from './helpers/deps.ts';
import { FIXTURE_MEANINGS, fakeJev } from './helpers/fake-jev.ts';
import { allFields, field, runRead } from './helpers/form-read.ts';
import { type SiteServer, startSiteServer } from './helpers/site-server.ts';

// Real browser work: slower machines (CI) need more than the default minute.
vi.setConfig({ testTimeout: 120_000 });

let site: SiteServer;
let browser: Browser;
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  site = await startSiteServer();
  browser = await chromium.launch({ headless: true });
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  // Read never sends anything: no submission, no autosave, no upload, no draft.
  expect(site.writes).toEqual([]);
});

afterAll(async () => {
  await browser?.close();
  await site?.close();
});

async function read(path: string, profile: Parameters<typeof runRead>[2] = {}) {
  const run = await runRead(browser, site.url(path), profile);
  closers.push(run.close);
  return run;
}

const submitted = (run: Awaited<ReturnType<typeof read>>) =>
  run.page.evaluate(() => (window as unknown as { __submitted?: number }).__submitted ?? 0);

describe('Read on local fixture forms', () => {
  it('conditional reveal: each follow-up is recorded with the answer that shows it', async () => {
    const run = await read('/form-conditional.html');
    const { steps } = run.read.requirements;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      isFinal: true,
      advance: { frame: [], role: 'button', name: 'Submit application', nth: 0, css: null },
    });

    const workAuth = field(run.read, 'Are you legally authorized to work in the European Union?');
    expect(workAuth).toMatchObject({
      kind: 'select',
      required: true,
      options: ['Yes', 'No'],
      meaning: 'work_authorization',
      revealedBy: null,
      ref: { frame: [], role: 'combobox', nth: 0, css: null },
    });
    expect(field(run.read, 'Which country will you work from?')).toMatchObject({
      kind: 'select',
      required: true,
      options: ['Greece', 'Cyprus', 'Germany'],
      revealedBy: { ref: workAuth.ref, value: 'Yes' },
    });
    expect(field(run.read, 'Will you require visa sponsorship?')).toMatchObject({
      kind: 'radio',
      required: true,
      options: ['Yes', 'No'],
      meaning: 'visa_sponsorship',
      ref: { role: 'group', name: 'Will you require visa sponsorship?' },
      revealedBy: { ref: workAuth.ref, value: 'No' },
    });
    expect(field(run.read, 'Tell us about your visa situation').revealedBy?.value).toBe('No');
    const portfolio = field(run.read, "I have a portfolio I'd like to share");
    expect(field(run.read, 'Portfolio URL').revealedBy).toEqual({
      ref: portfolio.ref,
      value: 'checked',
    });
    expect(field(run.read, 'Please specify').revealedBy?.value).toBe('Other');

    // The hidden upload is found through its group label and addressed by css.
    expect(field(run.read, 'Resume/CV')).toMatchObject({
      kind: 'file',
      required: true,
      meaning: 'resume',
      ref: { css: '#resume' },
    });
    expect(field(run.read, 'Phone')).toMatchObject({ required: false, meaning: 'phone' });
    expect(field(run.read, 'Gender')).toMatchObject({ meaning: 'eeo', required: false });
    // The newsletter signup and the cookie banner are not the application.
    expect(allFields(run.read).map((f) => f.label)).not.toContain('Get job alerts');
    expect(await submitted(run)).toBe(0);
  });

  it('3-step wizard: every step is reached with "Save and Continue"; Read stops at Submit', async () => {
    const run = await read('/form-wizard.html', { profile: { work_authorization: 'Yes' } });
    const steps = run.read.requirements.steps;
    expect(steps.map((s) => [s.advance?.name, s.isFinal])).toEqual([
      ['Save and Continue', false],
      ['Save and Continue', false],
      ['Save and Continue', false],
      ['Submit', true],
    ]);
    expect(steps.map((s) => s.fields.map((f) => f.label))).toEqual([
      [
        'Given Name(s)',
        'Family Name',
        'Email Address',
        'Phone Number',
        'Country',
        'Have you previously worked for Acme Corp?',
        'Employee ID',
        'Are you legally authorized to work in the country of this job?',
      ],
      ['Resume/CV', 'LinkedIn', 'Website'],
      ['Why do you want to work at Acme Corp?', 'What are your salary expectations?'],
      ['I certify that the information provided is accurate'],
    ]);
    expect(field(run.read, 'Employee ID').revealedBy?.value).toBe('Yes');
    // The required upload on step 2 got a placeholder so step 3 could be reached.
    expect(field(run.read, 'Resume/CV')).toMatchObject({ kind: 'file', required: true });
    expect(run.read.notes).toEqual([]);
    expect(await submitted(run)).toBe(0);
    expect(run.page.url()).toMatch(/#step-4$/);
  });

  it('a wizard that saves each step on the server stops at step 1, and says why', async () => {
    const run = await read('/form-wizard-saving.html');
    expect(run.read.requirements.steps).toHaveLength(1);
    expect(run.read.requirements.steps[0]?.fields.map((f) => f.label)).toEqual([
      'Full Name',
      'Email Address',
    ]);
    expect(run.read.notes).toEqual([
      'step 1: "Save and Continue" didn\'t lead to another step (Something went wrong while saving. Please try again.)',
    ]);
    expect(run.blocked).toEqual([`POST ${site.origin}/save-step`]);
  });

  it('cross-origin iframe: the embedded form is read, refs carry the frame path', async () => {
    const run = await read('/form-embed.html');
    const fields = allFields(run.read);
    expect(fields.every((f) => f.ref.frame.join() === 'iframe#grnhse_iframe')).toBe(true);
    expect(fields.map((f) => f.label)).toEqual([
      'First Name',
      'Last Name',
      'Email',
      'Resume/CV',
      'Are you open to relocating to Athens?',
      'How many years of Python experience do you have?',
      'Location (City)',
      'Tell us about an LLM system you shipped to production',
    ]);
    // Options that exist only while the menu is open are read by opening it…
    expect(field(run.read, 'How many years of Python experience do you have?')).toMatchObject({
      kind: 'combobox',
      required: false,
      options: ['0-2 years', '3-5 years', '6-9 years', '10+ years'],
    });
    // …and a search whose options depend on what's typed has none.
    expect(field(run.read, 'Location (City)')).toMatchObject({
      kind: 'combobox',
      required: true,
      options: null,
      meaning: 'location',
    });
    const loc = await run.page
      .frameLocator('iframe#grnhse_iframe')
      .getByRole('combobox', { name: 'Location (City)*' })
      .inputValue();
    expect(loc).toBe('Athens, Attica, Greece');
    expect(run.read.requirements.steps[0]?.advance?.frame).toEqual(['iframe#grnhse_iframe']);
  });

  it('a sign-in wall is reported, not read as a form', async () => {
    await expect(runRead(browser, site.url('/form-signin.html'))).rejects.toThrow(
      /the apply page asks you to sign in first/,
    );
  });

  it('upload fields, yes/no toggles and autosave: nothing leaves the browser', async () => {
    const run = await read('/form-ashby.html', { profile: { work_authorization: 'No' } });
    const labels = allFields(run.read).map((f) => f.label);
    // The "Autofill from resume" upload parses files on the server: not a question.
    expect(labels).not.toContain('Autofill from resume');
    expect(field(run.read, 'Resume')).toMatchObject({
      kind: 'file',
      required: false,
      ref: { css: '#_systemfield_resume' },
    });
    const sponsor = field(run.read, /require sponsorship/);
    expect(sponsor).toMatchObject({
      kind: 'radio',
      required: true,
      options: ['Yes', 'No'],
      ref: { css: 'div:has(> [name="f_sponsor"]) > [aria-pressed]' },
    });
    expect(field(run.read, 'Which visa do you hold today?').revealedBy).toEqual({
      ref: sponsor.ref,
      value: 'Yes',
    });
    expect(field(run.read, 'What is your current age?')).toMatchObject({
      kind: 'radio',
      options: ['Under 30', '30-39', '40 or older', 'I prefer not to answer'],
    });
    expect(field(run.read, /ethnicity/)).toMatchObject({ kind: 'checkbox', meaning: 'eeo' });
    // Every autosave was a GraphQL mutation, and all were blocked.
    expect(run.blocked.length).toBeGreaterThan(3);
    expect(new Set(run.blocked)).toEqual(new Set([`POST ${site.origin}/api/non-user-graphql`]));
    expect(await submitted(run)).toBe(0);
  });
});

describe('read_form through the queue', () => {
  it('stores the form on the posting and says so', async () => {
    const t = tempDb();
    const bus = new EventBus();
    const reader = new ReaderPool({ maxContexts: 1, navigationTimeoutMs: 15_000, log: quietLog });
    const worker = new Worker({
      db: t.db,
      read: t.read,
      bus,
      handlers: handlers({ read_form: readFormHandler }),
      deps: testDeps({
        dir: t.dir,
        db: t.db,
        reader,
        jev: fakeJev({ meanings: FIXTURE_MEANINGS }),
      }),
      log: quietLog,
      concurrency: 1,
      leaseMs: 60_000,
      pollMs: 20,
      maxAttempts: 3,
    });
    try {
      const now = new Date();
      const id = runInTx(t.db, bus, { now }, (tx) => {
        setProfileValue(tx.db, 'work_authorization', 'No', now);
        const row = tx.db
          .insert(postings)
          .values({
            stage: 'verified',
            canonicalUrl: site.url('/form-conditional.html?job=1'),
            applyUrl: site.url('/form-conditional.html'),
            title: 'Senior AI Engineer',
            company: 'Acme AI',
          })
          .returning()
          .get();
        tx.enqueue('read_form', row.id);
        return row.id;
      });
      worker.start();
      await worker.idle();
      const row = t.db.select().from(postings).where(eq(postings.id, id)).get();
      expect(row).toMatchObject({
        formStatus: 'verified',
        formNote: '1 step · 17 fields (9 required)',
      });
      expect(row?.formReadAt).toBeInstanceOf(Date);
      expect(row?.form?.url).toBe(site.url('/form-conditional.html'));
      expect(row?.form?.requirements.steps[0]?.fields).toHaveLength(17);
      const events = t.db.select().from(eventsTable).all();
      expect(events.find((e) => e.kind === 'posting.form')).toMatchObject({
        postingId: id,
        stage: 'verified',
        message: 'apply form verified: 1 step · 17 fields (9 required)',
      });
    } finally {
      await worker.stop();
      await reader.close();
      t.cleanup();
    }
  });
});
