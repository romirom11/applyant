// The receipt: every field value actually sent (with its source), the CV's hash and path, the
// salary value, the final URL and the confirmation text — recorded once delivery submits, and
// shown by `GetApplication` (the CLI's `applications preview` / `--json`).
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { type Browser, chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { approveApplication } from '../src/domain/applications/review.ts';
import { applicationView, ensureApplication } from '../src/domain/applications/store.ts';
import { runInTx } from '../src/queue/tx.ts';
import {
  cvFile,
  type PrepareHarness,
  prepareHarness,
  SYNTHETIC_PROFILE,
  seedFacts,
  seedPosting,
  setProfile,
} from './helpers/applications.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { FIXTURE_MEANINGS } from './helpers/fake-jev.ts';
import { runRead } from './helpers/form-read.ts';
import { type SiteServer, startSiteServer } from './helpers/site-server.ts';

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
});

afterAll(async () => {
  await browser?.close();
  await site?.close();
});

const now = new Date('2026-09-27T10:00:00Z');

describe('the delivery receipt', () => {
  let t: TempDb;
  let h: PrepareHarness;

  afterEach(async () => {
    await h.stop();
    t.cleanup();
  });

  it('records every field value sent, the CV hash, and the salary', async () => {
    t = tempDb();
    h = await prepareHarness(t, {
      formAgent: async (req) => ({
        kind: 'ok',
        output: { done: true, note: 'moved the slider' },
        model: req.model,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      }),
    });
    const run = await runRead(browser, site.url('/form-deliver-simple.html'), {
      jev: { meanings: [...FIXTURE_MEANINGS, [/notice period/i, 'notice_period']] },
    });
    closers.push(run.close);
    const cv = cvFile(t.dir);
    setProfile(t.db, { ...SYNTHETIC_PROFILE, base_cv_file: cv }, now);
    const postingId = seedPosting(t.db, run.read, { now, stage: 'verified' });

    const id = runInTx(t.db, h.bus, { now }, (tx) => ensureApplication(tx, postingId, 't').app.id);
    await h.worker.idle();
    runInTx(t.db, h.bus, { now }, (tx) => approveApplication(tx, id));
    await h.worker.idle();

    const view = applicationView(t.db, id);
    expect(view.app.stage).toBe('applied');
    const receipt = view.receipt;
    if (!receipt) throw new Error('no receipt');

    expect(receipt.finalUrl).toContain('/form-deliver-simple.html');
    expect(receipt.confirmationText).toMatch(/thanks/i);
    expect(receipt.submittedAt).toBeInstanceOf(Date);

    // The CV: exact file, exact hash.
    expect(receipt.cvPath).toBe(cv);
    expect(receipt.cvHash).toBe(createHash('sha256').update(readFileSync(cv)).digest('hex'));

    // The salary, verbatim from the profile.
    expect(receipt.salaryValue).toBe(SYNTHETIC_PROFILE.salary_expectation);

    // Every field value sent, with its source.
    const byLabel = new Map(receipt.fieldValues.map((f) => [f.label, f]));
    expect(byLabel.get('Full Name')).toMatchObject({
      value: SYNTHETIC_PROFILE.full_name,
      source: 'profile',
    });
    expect(byLabel.get('Email')).toMatchObject({
      value: SYNTHETIC_PROFILE.email,
      source: 'profile',
    });
    expect(byLabel.get('Desired salary')).toMatchObject({
      value: SYNTHETIC_PROFILE.salary_expectation,
      source: 'profile',
    });
    expect(byLabel.get('Resume')).toMatchObject({ value: cv, source: 'file' });
    expect(byLabel.get('I agree to the privacy policy')).toMatchObject({
      value: 'checked',
      source: 'rule',
    });
    expect(byLabel.get('Phone')).toMatchObject({
      value: SYNTHETIC_PROFILE.phone,
      source: 'profile',
    });
    expect(byLabel.get('Notice period, in weeks')).toMatchObject({
      value: SYNTHETIC_PROFILE.notice_period,
      source: 'profile',
    });
  });

  const tailoredRun = async () => {
    h = await prepareHarness(t, {
      formAgent: async (req) => ({
        kind: 'ok',
        output: { done: true, note: 'moved the slider' },
        model: req.model,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      }),
    });
    const run = await runRead(browser, site.url('/form-deliver-simple.html'), {
      jev: { meanings: [...FIXTURE_MEANINGS, [/notice period/i, 'notice_period']] },
    });
    closers.push(run.close);
    setProfile(t.db, { ...SYNTHETIC_PROFILE, base_cv_file: cvFile(t.dir) }, now);
    seedFacts(t.db, now);
    const postingId = seedPosting(t.db, run.read, { now, stage: 'verified' });
    const id = runInTx(t.db, h.bus, { now }, (tx) => ensureApplication(tx, postingId, 't').app.id);
    await h.worker.idle();
    const cv = applicationView(t.db, id).cv;
    if (!cv?.pdfPath || !cv.pdfHash) throw new Error('no tailored CV');
    return { id, cv: { path: cv.pdfPath, hash: cv.pdfHash } };
  };

  it('uploads the exact tailored PDF that was reviewed, and the receipt keeps its hash', async () => {
    t = tempDb();
    const { id, cv } = await tailoredRun();
    runInTx(t.db, h.bus, { now }, (tx) => approveApplication(tx, id));
    await h.worker.idle();

    const view = applicationView(t.db, id);
    expect(view.app.stage).toBe('applied');
    expect(view.receipt?.cvPath).toBe(cv.path);
    expect(view.receipt?.cvHash).toBe(cv.hash);
    expect(view.receipt?.fieldValues.find((f) => f.label === 'Resume')).toMatchObject({
      value: cv.path,
      source: 'file',
    });
  });

  it('sends nothing when the tailored PDF changed after review', async () => {
    t = tempDb();
    const { id, cv } = await tailoredRun();
    appendFileSync(cv.path, '\n% changed');
    runInTx(t.db, h.bus, { now }, (tx) => approveApplication(tx, id));
    await h.worker.idle();

    const view = applicationView(t.db, id);
    expect(view.app.stage).toBe('approved');
    expect(view.receipt).toBeNull();
    expect(view.handOff?.reason).toMatch(/changed after you approved it, so nothing was sent/);
  });
});
