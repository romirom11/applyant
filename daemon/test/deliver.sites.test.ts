// Deliver on local synthetic fixture forms, end to end: a real Read (so field refs are
// authentic), Prepare, approve, then Deliver through the real form engine in a real (headless)
// browser. The form_agent role is scripted (no real model call): it escalates for a control the
// deterministic pass can't operate, and for a step whose first submit is rejected.
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
  seedPosting,
  setProfile,
} from './helpers/applications.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { FIXTURE_MEANINGS } from './helpers/fake-jev.ts';
import { runRead } from './helpers/form-read.ts';
import { mcpClient } from './helpers/mcp-client.ts';
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
  site.writes.length = 0;
});

afterAll(async () => {
  await browser?.close();
  await site?.close();
});

const now = new Date('2026-09-27T10:00:00Z');

/** Reads the fixture for real (so refs are authentic), then seeds a posting and its profile. */
async function seedFromFixture(path: string, t: TempDb): Promise<number> {
  const run = await runRead(browser, site.url(path), {
    jev: { meanings: [...FIXTURE_MEANINGS, [/notice period/i, 'notice_period']] },
  });
  closers.push(run.close);
  setProfile(t.db, { ...SYNTHETIC_PROFILE, base_cv_file: cvFile(t.dir) }, now);
  return seedPosting(t.db, run.read, { now, stage: 'verified' });
}

/** Creates the application, waits for Prepare, approves it (which enqueues delivery), and
 * waits for Deliver. Returns the application id once the worker is idle. */
async function applyAndDeliver(t: TempDb, h: PrepareHarness, postingId: number): Promise<number> {
  const id = runInTx(t.db, h.bus, { now }, (tx) => ensureApplication(tx, postingId, 'test').app.id);
  await h.worker.idle();
  const before = applicationView(t.db, id);
  expect(before.blockers, before.blockers.join('\n')).toEqual([]);
  runInTx(t.db, h.bus, { now }, (tx) => approveApplication(tx, id));
  await h.worker.idle();
  return id;
}

describe('Deliver on local fixture forms', () => {
  let t: TempDb;
  let h: PrepareHarness;

  afterEach(async () => {
    await h.stop();
    t.cleanup();
  });

  it('an unfillable control escalates to the field agent, then submits with a receipt', async () => {
    t = tempDb();
    h = await prepareHarness(t, {
      formAgent: async (req) => {
        expect(req.prompt).toMatch(/Notice period/);
        const client = await mcpClient(req.tools ?? { servers: {}, allowed: [] });
        try {
          expect(await client.tools()).toEqual(
            expect.arrayContaining(['snapshot', 'fill', 'select', 'upload', 'click']),
          );
          await client.call('snapshot', {});
        } finally {
          await client.close();
        }
        return {
          kind: 'ok',
          output: { done: true, note: 'moved the slider' },
          model: req.model,
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        };
      },
    });
    const postingId = await seedFromFixture('/form-deliver-simple.html', t);
    const id = await applyAndDeliver(t, h, postingId);

    const view = applicationView(t.db, id);
    expect(view.app.stage).toBe('applied');
    expect(view.app.appliedAt).toBeTruthy();
    expect(view.receipt).toBeTruthy();
    expect(view.receipt?.cvPath).toBeTruthy();
    expect(view.receipt?.cvHash).toMatch(/^[0-9a-f]{64}$/);
    expect(view.receipt?.salaryValue).toBe(SYNTHETIC_PROFILE.salary_expectation);
    const names = view.receipt?.fieldValues.map((f) => f.label) ?? [];
    expect(names).toEqual(
      expect.arrayContaining(['Full Name', 'Email', 'Notice period, in weeks']),
    );
    expect(site.writes.map((w) => w.path)).toContain('/submitted');
    // The field agent ran exactly once, for the one control the deterministic pass couldn't use.
    expect(h.claude.requests.filter((r) => r.role === 'form_agent')).toHaveLength(1);
  });

  it('a step rejected on the first submit is fixed by the step agent, then goes through', async () => {
    t = tempDb();
    h = await prepareHarness(t, {
      formAgent: async (req) => {
        expect(req.prompt).toMatch(/click submit again/i);
        const client = await mcpClient(req.tools ?? { servers: {}, allowed: [] });
        try {
          await client.call('click', {
            frame: [],
            role: 'button',
            name: 'Submit application',
            nth: 0,
          });
        } finally {
          await client.close();
        }
        return {
          kind: 'ok',
          output: { done: true, note: 'clicked submit again' },
          model: req.model,
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        };
      },
    });
    const postingId = await seedFromFixture('/form-deliver-confirm.html', t);
    const id = await applyAndDeliver(t, h, postingId);

    const view = applicationView(t.db, id);
    expect(view.app.stage).toBe('applied');
    expect(view.receipt?.confirmationText).toMatch(/thanks/i);
    expect(site.writes.map((w) => w.path)).toContain('/submitted');
    expect(h.claude.requests.filter((r) => r.role === 'form_agent')).toHaveLength(1);
  });

  it('a plain multi-step wizard is filled and submitted with no agent needed', async () => {
    t = tempDb();
    h = await prepareHarness(t, {});
    const postingId = await seedFromFixture('/form-deliver-wizard.html', t);
    const id = await applyAndDeliver(t, h, postingId);

    const view = applicationView(t.db, id);
    expect(view.app.stage).toBe('applied');
    expect(view.receipt?.confirmationText).toMatch(/thanks/i);
    expect(site.writes.map((w) => w.path)).toContain('/submitted');
    expect(h.claude.requests.filter((r) => r.role === 'form_agent')).toHaveLength(0);
  });
});
